"""Authentication routes with email/mobile identities and one-use OTPs."""
import asyncio
import hashlib
import json
import logging
import os
import re
import uuid
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError

from db import db, serialize_doc
import crm
import compliance
import telesign_service
from avatar_service import deterministic_avatar_key
from models import (
    AuthenticatedOtpVerify,
    ChangePasswordRequest,
    ForgotPasswordRequest,
    LoginRequest,
    PlayerMobileVerificationFallback,
    RegisterRequest,
    ResendVerificationRequest,
    ResetPasswordRequest,
    SignupRequestCreate,
    VerifyEmailRequest,
)
from auth_utils import (
    create_access_token,
    get_current_user,
    hash_password,
    maybe_upgrade_legacy_avatar,
    public_user,
    verify_password,
)
from otp_service import (
    OtpConfigurationError,
    OtpError,
    LOGIN_VERIFICATION,
    RESET_PASSWORD,
    VERIFY_CONTACT,
    Identity,
    consume_prepared_challenge,
    consume_persistent_limit,
    delivery_adapter_ready,
    identity_query,
    issue_challenge,
    masked_destination,
    normalize_identity,
    prepare_challenge_verification,
    report_delivery_completion,
    registration_storage_ready,
    require_configured_pepper,
    require_identity_indexes,
    require_registration_readiness,
    require_registration_transactions,
)


logger = logging.getLogger('auth')
router = APIRouter(prefix='/auth', tags=['auth'])

GENERIC_REGISTER_MESSAGE = (
    'If this contact can be registered, a verification code has been sent.'
)
GENERIC_RESEND_MESSAGE = (
    'If an unverified account matches, a new verification code has been sent.'
)
GENERIC_RESET_MESSAGE = (
    'If an account exists for this contact, a reset code has been sent. '
    'If you do not receive it, contact support for an administrator-assisted reset.'
)
RESET_UNAVAILABLE_MESSAGE = (
    'Password reset codes cannot be sent right now. '
    'Contact support for an administrator-assisted reset.'
)
INVALID_LOGIN_MESSAGE = 'Invalid login ID or password'
PASSWORD_FAILURE_LIMIT = 5
PASSWORD_LOCK_SECONDS = 15 * 60
# A fixed valid bcrypt hash makes unknown-account logins perform the same
# deliberately expensive password check as known accounts.
DUMMY_PASSWORD_HASH = '$2b$12$UUHmLbCVBIW2CJx57KwQfeD3CUQJ4g1p7oYWdID7ZzPYVc2AKfwru'
# Registration does not accept a password before phone ownership is proved,
# but an equivalent fixed-cost hash still keeps existing/new lookup timing from
# becoming a cheap account-enumeration signal. The result is never persisted.
DUMMY_REGISTRATION_SECRET = 'Chakri-Registration-Timing-Pad-Only'
PHONE_OTP_ACTIVATION_MODE = 'PHONE_OTP'
ADMIN_REVIEW_ACTIVATION_MODE = 'ADMIN_REVIEW'
ADMIN_REVIEW_PENDING = 'ADMIN_REVIEW_PENDING'
ADMIN_REVIEW_APPROVED = 'ADMIN_APPROVED'
POLICY_ACCEPTANCE_SCHEMA_VERSION = 1
POLICY_ACCEPTANCE_PURPOSE = 'ACCOUNT_REGISTRATION'
POLICY_VERSION_PATTERN = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$')
DEFAULT_TERMS_VERSION = 'legacy-account-terms-v1'
DEFAULT_PRIVACY_VERSION = 'legacy-privacy-notice-v1'


def _environment_flag(name: str) -> bool:
    return (os.environ.get(name) or '').strip().lower() in {
        '1', 'true', 'yes', 'on',
    }


def _player_login_otp_required() -> bool:
    """Return the operator-controlled player login verification policy."""
    return _environment_flag('PLAYER_LOGIN_OTP_REQUIRED')


def _operator_provisioned_player(user: dict) -> bool:
    """Identify players whose credentials were issued directly by an admin.

    These accounts have no player-owned phone or email to receive a login OTP.
    The explicit exemption is written on new records; ``provisioned_by`` keeps
    already-created operator accounts usable without a risky data migration.
    Self-service registrations can never inherit the exemption.
    """
    return bool(
        user.get('role') == 'PLAYER'
        and user.get('registration_source') != 'SELF_SERVICE'
        and (
            user.get('login_verification_exempt') is True
            or user.get('registration_source') == 'OPERATOR'
            or bool(user.get('provisioned_by'))
        )
    )


def _player_login_otp_identity(
    user: dict, *, delivery_required: bool = True,
    requested_channel: str | None = None,
) -> Identity:
    """Choose a deliverable player contact without exposing it to the client.

    Mobile is preferred because new accounts prove it during activation. Older
    active accounts may use a verified email when SMS is unavailable. A
    manually reviewed account can establish mobile ownership at login; the
    successful OTP is then recorded as mobile verification.
    """
    candidates = [
        ('SMS', user.get('phone_normalized') or user.get('phone')),
        ('EMAIL', user.get('email_normalized') or user.get('email')),
    ]
    for channel, value in candidates:
        if requested_channel and channel != requested_channel:
            continue
        if not value or (delivery_required and not delivery_adapter_ready(channel)):
            continue
        try:
            identity = normalize_identity(value)
        except ValueError:
            continue
        if identity.channel != channel:
            continue
        if channel == 'SMS' or user.get('email_verified') is True:
            return identity
    raise OtpConfigurationError('No verified player login OTP channel is available')


def _policy_config_error(message: str) -> HTTPException:
    logger.error('Legal policy configuration unavailable: %s', message)
    return HTTPException(status_code=503, detail={
        'code': 'POLICY_CONFIG_UNAVAILABLE',
        'message': 'Current account policies are temporarily unavailable.',
    })


def _normalise_policy_url(value: str | None) -> str | None:
    value = (value or '').strip()
    if not value:
        return None
    if len(value) > 2048:
        raise ValueError('policy URL is too long')
    if value.startswith('/') and not value.startswith('//'):
        return value
    parsed = urlparse(value)
    if parsed.scheme != 'https' or not parsed.netloc or parsed.username or parsed.password:
        raise ValueError('policy URL must be an internal path or an HTTPS URL')
    return value


def _normalise_policy_effective_at(value: str | None) -> str | None:
    value = (value or '').strip()
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError as exc:
        raise ValueError('policy effective timestamp is invalid') from exc
    if parsed.tzinfo is None:
        raise ValueError('policy effective timestamp must include a timezone')
    return parsed.astimezone(timezone.utc).isoformat()


def _normalise_policy_hash(value: str | None) -> str | None:
    value = (value or '').strip().lower()
    if not value:
        return None
    if not re.fullmatch(r'[0-9a-f]{64}', value):
        raise ValueError('policy content hash must be SHA-256 hexadecimal')
    return value


def _current_policy_documents() -> dict:
    """Return server-owned metadata for the exact documents being accepted.

    Legal text and operator/licence facts deliberately do not live in defaults.
    Operators can publish immutable documents and configure their URLs, dates
    and content hashes without changing historical acceptance evidence.
    """
    terms_version = (
        os.environ.get('CURRENT_TERMS_VERSION') or DEFAULT_TERMS_VERSION
    ).strip()
    privacy_version = (
        os.environ.get('CURRENT_PRIVACY_VERSION') or DEFAULT_PRIVACY_VERSION
    ).strip()
    if not POLICY_VERSION_PATTERN.fullmatch(terms_version):
        raise _policy_config_error('CURRENT_TERMS_VERSION is invalid')
    if not POLICY_VERSION_PATTERN.fullmatch(privacy_version):
        raise _policy_config_error('CURRENT_PRIVACY_VERSION is invalid')
    try:
        return {
            'terms': {
                'key': 'terms',
                'title': 'Terms and Conditions',
                'version': terms_version,
                'effective_at': _normalise_policy_effective_at(
                    os.environ.get('TERMS_EFFECTIVE_AT'),
                ),
                'url': _normalise_policy_url(os.environ.get('TERMS_PUBLIC_URL')),
                'content_sha256': _normalise_policy_hash(
                    os.environ.get('TERMS_CONTENT_SHA256'),
                ),
                'required': True,
            },
            'privacy': {
                'key': 'privacy',
                'title': 'Privacy Notice',
                'version': privacy_version,
                'effective_at': _normalise_policy_effective_at(
                    os.environ.get('PRIVACY_EFFECTIVE_AT'),
                ),
                'url': _normalise_policy_url(os.environ.get('PRIVACY_PUBLIC_URL')),
                'content_sha256': _normalise_policy_hash(
                    os.environ.get('PRIVACY_CONTENT_SHA256'),
                ),
                'required': True,
            },
        }
    except ValueError as exc:
        raise _policy_config_error(str(exc)) from exc


def _explicit_policy_versions_required() -> bool:
    return _environment_flag('POLICY_EXPLICIT_VERSION_ACK_REQUIRED')


def _require_complete_policy_publication(documents: dict) -> None:
    """Fail closed when strict acknowledgement lacks immutable publication data."""
    for key, document in documents.items():
        missing = [
            field for field in ('effective_at', 'url', 'content_sha256')
            if not document.get(field)
        ]
        if missing:
            raise _policy_config_error(
                f'{key} publication metadata is missing {", ".join(missing)}',
            )


def _public_policy_metadata() -> dict:
    documents = _current_policy_documents()
    explicit_required = _explicit_policy_versions_required()
    if explicit_required:
        _require_complete_policy_publication(documents)
    return {
        'schema_version': POLICY_ACCEPTANCE_SCHEMA_VERSION,
        'documents': documents,
        'required_for_registration': ['terms', 'privacy'],
        'acceptance': {
            'explicit_versions_required': explicit_required,
            # This is an intentional migration bridge, not an unversioned
            # record: the backend snapshots its current versions either way.
            'legacy_single_checkbox_supported': not explicit_required,
        },
    }


def _registration_policy_acceptance(
    body: RegisterRequest,
    registration_mode: str,
    request: Request | None = None,
) -> dict:
    """Validate and snapshot registration consent before any account write."""
    if body.accepted_terms is not True:
        raise HTTPException(status_code=422, detail={
            'code': 'TERMS_REQUIRED',
            'message': 'Accept the Terms and Conditions to continue.',
        })

    documents = _current_policy_documents()
    submitted_versions = {
        'terms': body.terms_version,
        'privacy': body.privacy_version,
    }
    supplied_count = sum(value is not None for value in submitted_versions.values())
    explicit_required = _explicit_policy_versions_required()
    if explicit_required:
        _require_complete_policy_publication(documents)
    if supplied_count not in (0, len(submitted_versions)):
        raise HTTPException(status_code=422, detail={
            'code': 'POLICY_VERSIONS_REQUIRED',
            'message': 'Confirm both current policy document versions.',
        })
    if body.accepted_privacy is False:
        raise HTTPException(status_code=422, detail={
            'code': 'PRIVACY_REQUIRED',
            'message': 'Acknowledge the Privacy Notice to continue.',
        })
    if explicit_required and (
        supplied_count == 0 or body.accepted_privacy is not True
    ):
        raise HTTPException(status_code=422, detail={
            'code': 'POLICY_VERSIONS_REQUIRED',
            'message': 'Confirm both current policy document versions.',
        })

    if supplied_count:
        current_versions = {
            key: document['version'] for key, document in documents.items()
        }
        if submitted_versions != current_versions:
            raise HTTPException(status_code=409, detail={
                'code': 'POLICY_VERSION_MISMATCH',
                'message': 'The policies changed. Review the current versions and try again.',
                'current_versions': current_versions,
            })
        if body.accepted_privacy is not True:
            raise HTTPException(status_code=422, detail={
                'code': 'PRIVACY_REQUIRED',
                'message': 'Acknowledge the Privacy Notice to continue.',
            })
        capture_method = 'EXPLICIT_VERSIONED'
    else:
        capture_method = 'LEGACY_SINGLE_CHECKBOX_CURRENT_VERSION'

    accepted_at = _now().isoformat()
    request_path = '/api/auth/register'
    request_method = 'POST'
    if request is not None:
        # Method and route are operational context, not browser fingerprinting.
        request_method = str(getattr(request, 'method', None) or 'POST').upper()[:16]
        request_url = getattr(request, 'url', None)
        request_path = str(getattr(request_url, 'path', None) or request_path)[:256]
    return {
        'schema_version': POLICY_ACCEPTANCE_SCHEMA_VERSION,
        'purpose': POLICY_ACCEPTANCE_PURPOSE,
        'accepted_at': accepted_at,
        'affirmations': {'terms': True, 'privacy': True},
        'policy_versions': {
            key: document['version'] for key, document in documents.items()
        },
        # Store a deep copy so subsequent environment changes cannot rewrite
        # what this player accepted.
        'policy_snapshot': json.loads(json.dumps(documents)),
        'capture': {
            'method': capture_method,
            'registration_mode': registration_mode,
            'request_method': request_method,
            'request_path': request_path,
            'request_id': str(uuid.uuid4()),
        },
    }


def _policy_acceptance_record(user: dict, acceptance: dict) -> dict:
    acceptance_id = f"registration:{user['id']}"
    record = {
        '_id': acceptance_id,
        'id': acceptance_id,
        'user_id': user['id'],
        'jurisdiction': user.get('country_code'),
        **json.loads(json.dumps(acceptance)),
    }
    hash_payload = {key: value for key, value in record.items() if key != '_id'}
    record['evidence_sha256'] = hashlib.sha256(json.dumps(
        hash_payload, sort_keys=True, separators=(',', ':'),
    ).encode('utf-8')).hexdigest()
    return record


def _apply_policy_acceptance_to_user(user: dict, record: dict) -> None:
    accepted_at = record['accepted_at']
    user.update({
        'accepted_terms': True,
        'accepted_terms_at': accepted_at,
        'accepted_privacy': True,
        'accepted_privacy_at': accepted_at,
        'accepted_policy_versions': dict(record['policy_versions']),
        'policy_acceptance_id': record['id'],
        'policy_acceptance_schema_version': record['schema_version'],
    })


def _registration_mode() -> str:
    """Return the registration gate currently selected by operations.

    An explicit ``REGISTRATION_MODE`` always wins: ``PHONE_OTP`` runs the retained
    SMS-verification flow (user creates a password after the OTP), ``ADMIN_REVIEW``
    holds sign-ups for manual approval, and any other non-empty value fails closed
    to ``DISABLED`` rather than silently choosing the less restrictive path.

    When the operator has NOT pinned a mode, prefer the self-serve phone-OTP flow
    as soon as the SMS OTP channel is actually configured (adapter + credentials),
    so mobile verification turns on the moment Telesign SMS is wired up. If the
    SMS channel is not ready we fall back to ADMIN_REVIEW so registration is never
    stranded behind an unconfigured provider.
    """
    configured = (os.environ.get('REGISTRATION_MODE') or '').strip().upper()
    if configured in (ADMIN_REVIEW_ACTIVATION_MODE, PHONE_OTP_ACTIVATION_MODE):
        return configured
    if configured:
        return 'DISABLED'
    if delivery_adapter_ready('SMS'):
        return PHONE_OTP_ACTIVATION_MODE
    return ADMIN_REVIEW_ACTIVATION_MODE


def _telesign_mode(name: str) -> str:
    # Telesign Intelligence / Phone ID is treated as observe-only for onboarding
    # and sign-in. Its risk score must never strand a legitimate player (Indian
    # mobiles routinely score "block"/"flag") and a provider outage must never
    # fail closed. We therefore cap the effective mode at 'observe': screening
    # still runs and is logged, but it can no longer return 403/503. Flipping the
    # env to 'enforce' is intentionally a no-op until a reviewed, market-aware
    # policy replaces the blanket block. OTP possession (SMS/email) remains the
    # real phone/contact proof and is unaffected by this cap.
    value = (os.environ.get(name) or 'disabled').strip().lower()
    if value == 'enforce':
        return 'observe'
    return value if value in {'disabled', 'observe'} else 'disabled'


def _telesign_flag(name: str) -> bool:
    return (os.environ.get(name) or '').strip().lower() in {'1', 'true', 'yes', 'on'}


def _registration_email_otp_required() -> bool:
    # Registration is phone OTP only. Email is collected for CRM/recovery and
    # is not a second activation gate. REGISTRATION_EMAIL_OTP_REQUIRED is
    # intentionally ignored so accounts go ACTIVE after a single SMS OTP and
    # appear in Admin CRM immediately.
    return False


LOGIN_ID_PATTERN = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{3,31}$')


def _login_id_from_e164(phone: str) -> str:
    """Build a Login ID from an E.164 mobile: ``p`` plus digits, max 32 chars."""
    digits = re.sub(r'\D', '', phone or '')
    login_id = ('p' + digits)[:32]
    if not LOGIN_ID_PATTERN.fullmatch(login_id):
        raise HTTPException(status_code=422, detail={
            'code': 'LOGIN_ID_REQUIRED',
            'message': 'Choose your Login ID to create an account.',
        })
    return login_id


async def _telesign_onboarding_screen(
    identity: Identity,
    email: str | None,
    *,
    verify_plus_will_screen: bool,
) -> dict | None:
    """Collect non-PII onboarding signals without duplicating Verify Plus.

    Intelligence includes standard Phone ID fields. A separate Phone ID call is
    therefore made only when its Contact add-on was explicitly enabled. Contact
    names, addresses and email addresses are discarded by the provider client.
    """
    result = {}
    intelligence_mode = _telesign_mode('TELESIGN_INTELLIGENCE_MODE')
    if intelligence_mode != 'disabled' and not verify_plus_will_screen:
        try:
            intelligence = await telesign_service.evaluate_phone(
                identity.value,
                'create',
                email_address=email,
            )
        except telesign_service.TelesignServiceError as exc:
            logger.error('Telesign onboarding Intelligence unavailable: %s', exc.reason)
            if intelligence_mode == 'enforce':
                raise HTTPException(status_code=503, detail={
                    'code': 'ONBOARDING_RISK_UNAVAILABLE',
                    'message': 'Account screening is temporarily unavailable.',
                }) from exc
        else:
            result['intelligence'] = intelligence
            if (intelligence_mode == 'enforce'
                    and intelligence['risk']['recommendation'] == 'block'):
                raise HTTPException(status_code=403, detail={
                    'code': 'ONBOARDING_REVIEW_REQUIRED',
                    'message': 'We could not complete registration. Contact support for help.',
                })

    phone_id_mode = _telesign_mode('TELESIGN_PHONE_ID_MODE')
    contact_enabled = _telesign_flag('TELESIGN_CONTACT_ADDON_ENABLED')
    # Intelligence already includes standard Phone ID data. Use the separate
    # endpoint only for Contact, or when Intelligence is not running here.
    phone_id_needed = phone_id_mode != 'disabled' and (
        contact_enabled or intelligence_mode == 'disabled' or verify_plus_will_screen
    )
    if phone_id_needed:
        try:
            result['phone_id'] = await telesign_service.phone_id_contact(
                identity.value,
                include_contact=contact_enabled,
            )
        except telesign_service.TelesignServiceError as exc:
            logger.error('Telesign onboarding Phone ID unavailable: %s', exc.reason)
            if phone_id_mode == 'enforce':
                raise HTTPException(status_code=503, detail={
                    'code': 'PHONE_SCREENING_UNAVAILABLE',
                    'message': 'Phone screening is temporarily unavailable.',
                }) from exc
    return result or None


async def _telesign_sign_in_screen(user: dict) -> dict | None:
    mode = _telesign_mode('TELESIGN_INTELLIGENCE_MODE')
    phone = user.get('phone_normalized') or user.get('phone')
    if mode == 'disabled' or not phone:
        return None
    try:
        result = await telesign_service.evaluate_phone(
            phone,
            'sign-in',
            account_id=user.get('id'),
            email_address=user.get('email_normalized') or user.get('email'),
        )
    except telesign_service.TelesignServiceError as exc:
        logger.error('Telesign sign-in Intelligence unavailable: %s', exc.reason)
        if mode == 'enforce':
            raise HTTPException(status_code=503, detail={
                'code': 'SIGN_IN_RISK_UNAVAILABLE',
                'message': 'Sign-in screening is temporarily unavailable.',
            }) from exc
        return None
    if mode == 'enforce' and result['risk']['recommendation'] == 'block':
        await db.users.update_one({'id': user['id']}, {'$set': {
            'telesign_last_sign_in': {**result, 'screened_at': _now().isoformat()},
        }})
        raise HTTPException(status_code=403, detail={
            'code': 'SIGN_IN_RISK_BLOCKED',
            'message': 'This sign-in needs additional review. Contact support.',
        })
    return result


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _as_utc(value) -> datetime | None:
    if value is None:
        return None
    try:
        parsed = datetime.fromisoformat(value) if isinstance(value, str) else value
    except (TypeError, ValueError):
        return None
    if not isinstance(parsed, datetime):
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _request_value(body) -> str:
    for field in ('identifier', 'identity', 'phone', 'email'):
        value = getattr(body, field, None)
        if value is not None:
            return str(value).strip()
    raise HTTPException(status_code=422, detail='An email address or phone number is required')


def _request_identity(body) -> Identity:
    try:
        identity = normalize_identity(_request_value(body))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    declared = str(getattr(body, 'channel', None) or '').strip().upper()
    if declared:
        declared = 'PHONE' if declared == 'SMS' else declared
        actual = 'PHONE' if identity.channel == 'SMS' else 'EMAIL'
        if declared != actual:
            raise HTTPException(status_code=422, detail='Channel does not match the supplied identity')
    return identity


def _challenge_id(body) -> str | None:
    return getattr(body, 'verification_id', None) or getattr(body, 'challenge_id', None)


def _raise_otp(exc: OtpError):
    headers = {'Retry-After': str(exc.retry_after)} if exc.retry_after else None
    raise HTTPException(
        status_code=exc.status_code,
        detail={'code': exc.code, 'message': exc.message},
        headers=headers,
    ) from exc


def _dummy_challenge(identity: Identity) -> dict:
    challenge_id = str(uuid.uuid4())
    destination = masked_destination(identity)
    channel = 'PHONE' if identity.channel == 'SMS' else 'EMAIL'
    return {
        'challenge_id': challenge_id,
        'verification_id': challenge_id,
        'channel': channel,
        'destination': destination,
        'destination_masked': destination,
        'expires_in': 900,
        'expires_in_seconds': 900,
        'resend_in': 60,
        'resend_after_seconds': 60,
    }


def _opaque_registration_response(identity: Identity) -> dict:
    return {
        'message': GENERIC_REGISTER_MESSAGE,
        'verification_required': True,
        **_dummy_challenge(identity),
    }


async def _find_identity_user(identity: Identity, *, session=None):
    kwargs = {'session': session} if session is not None else {}
    return await db.users.find_one(identity_query(identity), **kwargs)


async def _active_challenge_response(user: dict, identity: Identity) -> dict | None:
    """Return truthful metadata for a still-live challenge without resending."""
    challenge = await db.otp_challenges.find_one({
        'user_id': user.get('id'),
        'purpose': VERIFY_CONTACT,
        'active': True,
        'status': 'PENDING',
    }, sort=[('created_at', -1)])
    if not challenge:
        return None
    now = _now()
    expires_at = _as_utc(challenge.get('expires_at'))
    if not expires_at or expires_at <= now:
        return None
    resend_not_before = _as_utc(challenge.get('resend_not_before'))
    expires_in = max(1, int((expires_at - now).total_seconds()))
    resend_in = max(0, int((resend_not_before - now).total_seconds())) \
        if resend_not_before else 0
    destination = masked_destination(identity)
    return {
        'challenge_id': challenge['id'],
        'verification_id': challenge['id'],
        'channel': 'PHONE' if identity.channel == 'SMS' else 'EMAIL',
        'destination': destination,
        'destination_masked': destination,
        'expires_in': expires_in,
        'expires_in_seconds': expires_in,
        'resend_in': resend_in,
        'resend_after_seconds': resend_in,
    }


def _identity_is_verified(user: dict, identity: Identity) -> bool:
    # KYC/identity verification is a separate financial control.  Only the
    # channel-specific OTP flag proves ownership of this contact method.
    return bool(user.get(identity.verified_field))


def _stored_sms_identity(user: dict | None, primary: Identity | None = None) -> Identity | None:
    """Return the mobile number a login-recovery OTP can actually be sent to."""
    if not user:
        return None
    for candidate in (
        user.get('phone_normalized'),
        user.get('phone'),
        primary.value if primary and primary.channel == 'SMS' else None,
    ):
        if not candidate:
            continue
        try:
            identity = normalize_identity(candidate)
        except ValueError:
            continue
        if identity.channel == 'SMS':
            return identity
    return None


def _login_verification_contact(
    user: dict | None, primary: Identity | None,
) -> tuple[str, str | None]:
    """Public channel plus deliverable destination after a correct password.

    Existing players usually sign in with a Login ID. The 403 must name the
    stored mobile number so the client does not resend to the typed username.
    """
    sms = _stored_sms_identity(user, primary)
    if sms:
        return 'PHONE', sms.value
    if primary and primary.channel == 'EMAIL':
        return 'EMAIL', primary.value
    if user:
        for candidate in (user.get('email_normalized'), user.get('email')):
            if not candidate:
                continue
            try:
                identity = normalize_identity(candidate)
            except ValueError:
                continue
            if identity.channel == 'EMAIL':
                return 'EMAIL', identity.value
    return ('PHONE' if primary and primary.channel == 'SMS' else 'EMAIL', None)


def _contact_not_verified_detail(user: dict | None, primary: Identity | None) -> dict:
    channel, destination = _login_verification_contact(user, primary)
    detail = {
        'code': 'CONTACT_NOT_VERIFIED',
        'message': 'Verify your contact method before logging in.',
        'channel': channel,
    }
    if destination:
        detail['identifier'] = destination
    login_id = (user or {}).get('username') or (user or {}).get('requested_username') or ''
    if login_id:
        detail['login_id'] = login_id
    return detail


async def _find_player_by_login_id(ident: str):
    raw = (ident or '').strip()
    if not raw or '@' in raw or raw.startswith('+'):
        return None
    return await db.users.find_one({
        'role': 'PLAYER',
        '$or': [
            {'username_key': raw.casefold()},
            {'username': {'$regex': f'^{re.escape(raw)}$', '$options': 'i'}},
        ],
    })


async def _resend_identity(body) -> Identity:
    """Accept a Login ID by resolving it to the stored mobile number."""
    try:
        return _request_identity(body)
    except HTTPException as exc:
        if exc.status_code != 422:
            raise
        player = await _find_player_by_login_id(_request_value(body))
        sms = _stored_sms_identity(player)
        if sms is None:
            raise
        return sms


def _self_service_needs_profile(user: dict) -> bool:
    """Repair the pre-profile state without reopening submitted applications."""
    return bool(
        user.get('registration_source') == 'SELF_SERVICE'
        and user.get('status') == 'PENDING'
        and not user.get('submitted_at')
    )


def _legacy_operator_contact_repair_allowed(user: dict, primary: Identity | None) -> bool:
    """Permit only historical operator-created ACTIVE rows missing the schema.

    Explicit false flags are never repaired, and SELF_SERVICE registrations
    always retain the OTP ownership requirement.
    """
    return bool(
        primary
        and user.get('role') == 'PLAYER'
        and user.get('status') == 'ACTIVE'
        and user.get('registration_source') != 'SELF_SERVICE'
        and all(field not in user for field in (
            'contact_verified', 'email_verified', 'phone_verified',
        ))
    )



def _phone_otp_email_pending_repair_needed(user: dict) -> bool:
    """True for leftover dual-OTP PHONE_OTP players who already proved SMS."""
    return bool(
        user
        and user.get('role') == 'PLAYER'
        and user.get('registration_source') == 'SELF_SERVICE'
        and user.get('activation_mode') == PHONE_OTP_ACTIVATION_MODE
        and user.get('phone_verified') is True
        and (
            user.get('status') == 'PENDING'
            or user.get('contact_verification_status') == 'PHONE_VERIFIED_EMAIL_PENDING'
        )
    )


def _phone_otp_email_pending_repair_fields(user: dict) -> dict:
    repaired_at = _now().isoformat()
    return {
        'status': 'ACTIVE',
        'contact_verified': True,
        'contact_verification_status': 'VERIFIED',
        'contact_verified_at': user.get('contact_verified_at') or repaired_at,
        'activated_at': user.get('activated_at') or repaired_at,
        'approved_at': user.get('approved_at') or repaired_at,
        'approved_by': user.get('approved_by') or 'SELF_SERVICE_PHONE_OTP',
        'email_verification_required': False,
    }


async def _repair_phone_otp_email_pending(user: dict) -> dict:
    """Activate leftover dual-OTP players who already completed phone SMS."""
    if not _phone_otp_email_pending_repair_needed(user):
        return user
    updated = await db.users.find_one_and_update(
        {
            'id': user['id'],
            'role': 'PLAYER',
            'registration_source': 'SELF_SERVICE',
            'activation_mode': PHONE_OTP_ACTIVATION_MODE,
            'phone_verified': True,
            '$or': [
                {'status': 'PENDING'},
                {'contact_verification_status': 'PHONE_VERIFIED_EMAIL_PENDING'},
            ],
        },
        {'$set': _phone_otp_email_pending_repair_fields(user)},
        return_document=ReturnDocument.AFTER,
    )
    if updated:
        return updated
    current = await db.users.find_one({'id': user['id']})
    return current or user


def _allow_nontransactional_auth_tests() -> bool:
    return (
        (os.environ.get('APP_ENV') or '').strip().lower() == 'test'
        and (os.environ.get('AUTH_ALLOW_NON_TRANSACTIONAL_TESTS') or '').lower() == 'true'
    )


async def _run_auth_transaction(callback):
    """Commit OTP consumption and its account mutation as one Mongo unit."""
    try:
        session_cm = await db.client.start_session()
    except Exception as exc:
        if (_allow_nontransactional_auth_tests()
                and isinstance(exc, (AttributeError, NotImplementedError))):
            return await callback(None)
        logger.error('Authentication transactions unavailable: %s', type(exc).__name__)
        raise HTTPException(status_code=503, detail={
            'code': 'AUTH_TEMPORARILY_UNAVAILABLE',
            'message': 'Authentication is temporarily unavailable.',
        }) from exc
    try:
        async with session_cm as session:
            return await session.with_transaction(callback)
    except (DuplicateKeyError, OtpError, HTTPException):
        raise
    except Exception as exc:  # never consume an OTP outside the transaction
        logger.error('Authentication transaction failed: %s', type(exc).__name__)
        raise HTTPException(status_code=503, detail={
            'code': 'AUTH_TEMPORARILY_UNAVAILABLE',
            'message': 'Authentication is temporarily unavailable.',
        }) from exc


async def _issue_or_public_challenge(user: dict, identity: Identity, purpose: str) -> dict:
    """Issue an OTP or return a dummy challenge when delivery is down.

    Rate limits still surface. Delivery failures must not 500, and they must
    not delete a pending registration that already exists.
    """
    try:
        return await issue_challenge(user, identity, purpose)
    except OtpError as exc:
        if exc.code in {'OTP_RESEND_COOLDOWN', 'RATE_LIMITED', 'OTP_LOCKED'}:
            _raise_otp(exc)
        logger.warning('OTP challenge not delivered: %s', exc.code)
        return _dummy_challenge(identity)


def _raise_public_code_error(exc: OtpError, message: str) -> None:
    """Hide challenge/existence state while preserving a uniform hard limit."""
    if exc.code == 'RATE_LIMITED':
        _raise_otp(exc)
    _raise_otp(OtpError('OTP_INVALID', message))


@router.get('/capabilities')
async def authentication_capabilities():
    """Expose global channel readiness without leaking any account state."""
    mode = _registration_mode()
    manual_storage_ready = False
    if mode == ADMIN_REVIEW_ACTIVATION_MODE:
        try:
            # Manual applicants authenticate with a password after approval;
            # the persistent login limiter therefore still requires its
            # production pepper even though no contact OTP is issued.
            require_configured_pepper()
            await require_identity_indexes()
            await require_registration_transactions()
            await crm.require_registration_attribution_readiness()
            await crm.require_portal_identity_readiness()
            manual_storage_ready = True
        except (OtpConfigurationError, crm.CrmConfigurationError):
            manual_storage_ready = False

    otp_storage_ready = await registration_storage_ready()
    email_otp_ready = otp_storage_ready and delivery_adapter_ready('EMAIL')
    phone_otp_ready = otp_storage_ready and delivery_adapter_ready('SMS')
    login_otp_required = _player_login_otp_required()
    login_otp_ready = phone_otp_ready or email_otp_ready
    email_required = _registration_email_otp_required()
    otp_registration_ready = (
        otp_storage_ready
        and await crm.registration_attribution_ready()
        and await crm.portal_identity_ready()
        and (email_otp_ready or not email_required)
    )

    if mode == ADMIN_REVIEW_ACTIVATION_MODE:
        return {
            'registration_enabled': manual_storage_ready,
            'email_registration': manual_storage_ready,
            'phone_registration': manual_storage_ready,
            'phone_verification_required': False,
            'email_contact_verification': email_otp_ready,
            'phone_contact_verification': phone_otp_ready,
            'email_password_reset': email_otp_ready,
            'phone_password_reset': phone_otp_ready,
            'player_login_verification_required': login_otp_required,
            'player_login_verification_available': login_otp_ready,
            'verification_required': False,
            'manual_admin_review': True,
            'registration_mode': ADMIN_REVIEW_ACTIVATION_MODE,
        }

    return {
        'registration_enabled': mode == PHONE_OTP_ACTIVATION_MODE and otp_registration_ready and phone_otp_ready,
        # Email can be collected on the phone-registration form, but is not a
        # registration identity and never receives an activation challenge.
        'email_registration': False,
        'phone_registration': mode == PHONE_OTP_ACTIVATION_MODE and otp_registration_ready and phone_otp_ready,
        'phone_verification_required': True,
        'email_verification_required': email_required,
        'email_contact_verification': email_otp_ready,
        'phone_contact_verification': phone_otp_ready,
        # Legacy verified-email accounts may use email for recovery and as the
        # login-OTP fallback when mobile delivery is unavailable. It is never
        # the activation gate for phone-registration accounts.
        'email_password_reset': email_otp_ready,
        'phone_password_reset': phone_otp_ready,
        'player_login_verification_required': login_otp_required,
        'player_login_verification_available': login_otp_ready,
        'verification_required': True,
        'registration_mode': PHONE_OTP_ACTIVATION_MODE,
    }


@router.get('/policies/current')
async def current_policy_metadata():
    """Public, read-only metadata for registration policy documents.

    The endpoint intentionally serves identifiers and publication metadata,
    not editable legal text. Policy pages can therefore be published and
    retained independently while registration records the exact version shown.
    """
    return _public_policy_metadata()


async def _register_phone_otp(
    body: RegisterRequest,
    referral_risk_clusters: dict | None = None,
    policy_acceptance: dict | None = None,
):
    """Create a phone-OTP-pending self-service player.

    Email is collected for CRM and recovery; it is not a second activation
    gate. A missing Login ID is derived from the E.164 mobile number.
    """
    if body.password is not None or body.password_confirmation is not None:
        raise HTTPException(status_code=422, detail={
            'code': 'PASSWORD_AFTER_OTP',
            'message': 'Create the password only after mobile verification.',
        })
    identity = _request_identity(body)
    if identity.channel != 'SMS' or identity.value != body.phone:
        raise HTTPException(status_code=422, detail={
            'code': 'PHONE_REQUIRED',
            'message': 'Register with a mobile number that can receive an OTP.',
        })

    email_required = _registration_email_otp_required()
    if not body.email:
        raise HTTPException(status_code=422, detail={
            'code': 'EMAIL_REQUIRED',
            'message': 'A valid email address is required.',
        })
    try:
        await require_registration_readiness()
        await crm.require_registration_attribution_readiness()
        await crm.require_portal_identity_readiness()
    except OtpConfigurationError as exc:
        _raise_otp(exc)
    except crm.CrmConfigurationError as exc:
        _raise_otp(OtpConfigurationError(str(exc)))
    # Availability is global per channel and is checked before any existence
    # lookup, so a disabled provider produces the same response for every
    # contact. Runtime provider failures remain opaque below.
    if not delivery_adapter_ready(identity.channel):
        _raise_otp(OtpConfigurationError('Requested OTP channel is not configured'))
    if email_required and not delivery_adapter_ready('EMAIL'):
        _raise_otp(OtpConfigurationError('Email OTP delivery is not configured'))
    full_name = (body.full_name or '').strip()
    country = (body.country or '').strip()
    country_code = compliance.normalise_country(country)
    if not full_name:
        raise HTTPException(status_code=422, detail={
            'code': 'PROFILE_REQUIRED', 'message': 'A full name is required.',
        })
    if not country or not country_code or country_code == compliance.UNKNOWN:
        raise HTTPException(status_code=422, detail={
            'code': 'COUNTRY_REQUIRED', 'message': 'A recognized country is required.',
        })
    if not body.date_of_birth:
        raise HTTPException(status_code=422, detail={
            'code': 'AGE_UNKNOWN', 'message': 'A valid date of birth is required.',
        })
    if body.accepted_terms is not True:
        raise HTTPException(status_code=422, detail={
            'code': 'TERMS_REQUIRED',
            'message': 'Accept the Terms and Conditions to continue.',
        })
    ok, code, message = await compliance.check_eligibility(
        country, body.date_of_birth, require_dob=True,
    )
    if not ok:
        raise HTTPException(status_code=403, detail={'code': code, 'message': message})
    login_id = body.username or _login_id_from_e164(identity.value)
    try:
        await crm.assert_player_login_id_available(login_id)
    except ValueError as exc:
        # Login-ID availability is evaluated before contact existence for the
        # same anti-enumeration reason as the required-field check above.
        raise HTTPException(status_code=409, detail={
            'code': 'LOGIN_ID_UNAVAILABLE',
            'message': 'That Login ID is unavailable. Choose another Login ID.',
        }) from exc

    verify_plus_will_screen = bool(
        _telesign_flag('TELESIGN_VERIFY_PLUS_ENABLED')
        and (os.environ.get('OTP_SMS_ADAPTER') or '').strip().lower() == 'telesign'
    )
    telesign_onboarding = await _telesign_onboarding_screen(
        identity,
        str(body.email) if body.email else None,
        verify_plus_will_screen=verify_plus_will_screen,
    )

    await asyncio.to_thread(hash_password, DUMMY_REGISTRATION_SECRET)
    email_identity = normalize_identity(str(body.email)) if body.email else None
    phone_existing = await _find_identity_user(identity)
    email_existing = await _find_identity_user(email_identity) if email_identity else None
    if phone_existing:
        recoverable_pending = bool(
            phone_existing.get('role') == 'PLAYER'
            and phone_existing.get('status') == 'PENDING'
            and phone_existing.get('registration_source') == 'SELF_SERVICE'
            and phone_existing.get('activation_mode') == PHONE_OTP_ACTIVATION_MODE
            and phone_existing.get('phone_verified') is not True
        )
        if recoverable_pending:
            # A player who lost the verification screen can safely restart the
            # flow. Reuse truthful metadata when a code is already live rather
            # than claiming a second SMS was sent.
            active_challenge = await _active_challenge_response(phone_existing, identity)
            if active_challenge:
                return {
                    'message': GENERIC_REGISTER_MESSAGE,
                    'verification_required': True,
                    **active_challenge,
                }
            # With no live challenge, a replacement still goes only to the
            # already-recorded phone.
            challenge = await _issue_or_public_challenge(phone_existing, identity, VERIFY_CONTACT)
            return {
                'message': GENERIC_REGISTER_MESSAGE,
                'verification_required': True,
                **challenge,
            }
        recoverable_email = bool(
            email_required
            and email_identity
            and phone_existing.get('role') == 'PLAYER'
            and phone_existing.get('status') == 'PENDING'
            and phone_existing.get('registration_source') == 'SELF_SERVICE'
            and phone_existing.get('activation_mode') == PHONE_OTP_ACTIVATION_MODE
            and phone_existing.get('phone_verified') is True
            and phone_existing.get('email_verified') is not True
            and phone_existing.get('email_normalized') == email_identity.value
        )
        if recoverable_email:
            active_challenge = await _active_challenge_response(
                phone_existing, email_identity,
            )
            if active_challenge:
                return {
                    'message': GENERIC_REGISTER_MESSAGE,
                    'verification_required': True,
                    **active_challenge,
                }
            challenge = await _issue_or_public_challenge(
                phone_existing, email_identity, VERIFY_CONTACT,
            )
            return {
                'message': GENERIC_REGISTER_MESSAGE,
                'verification_required': True,
                **challenge,
            }
    if phone_existing or email_existing:
        # Verified phone and optional-email collisions use the exact opaque
        # public response shape. It deliberately does not claim unconditional
        # delivery and cannot reveal which identity matched.
        return _opaque_registration_response(identity)

    user_id = str(uuid.uuid4())
    created_at = _now().isoformat()
    policy_acceptance = policy_acceptance or _registration_policy_acceptance(
        body, PHONE_OTP_ACTIVATION_MODE,
    )
    user = {
        'id': user_id,
        'role': 'PLAYER',
        'status': 'PENDING',
        'registration_source': 'SELF_SERVICE',
        'activation_mode': PHONE_OTP_ACTIVATION_MODE,
        'primary_identity': identity.value,
        'primary_identity_channel': 'PHONE',
        'contact_verification_status': 'PENDING',
        # Reserved for the later KYC workflow; contact OTP never changes it.
        'identity_verified': False,
        'contact_verified': False,
        'email_verified': False,
        'phone_verified': False,
        'email_verification_required': email_required,
        'display_name': full_name,
        'full_name': full_name,
        'country': country,
        'country_code': country_code,
        'date_of_birth': body.date_of_birth,
        'avatar': deterministic_avatar_key(identity.value),
        'avatar_source': 'PRESET',
        'chip_balance': 0,
        'points_balance': 0,
        'favorites': [],
        'recent_games': [],
        'settings': {
            'sound_enabled': True, 'music_enabled': True,
            'haptics_enabled': True, 'reduced_motion': False,
            'high_contrast': False,
        },
        'created_at': created_at,
    }
    acceptance_record = _policy_acceptance_record(user, policy_acceptance)
    _apply_policy_acceptance_to_user(user, acceptance_record)
    if login_id:
        # Verification atomically claims the requested Login ID.
        user['requested_username'] = login_id
    if telesign_onboarding:
        user['telesign_onboarding'] = {
            **telesign_onboarding,
            'screened_at': created_at,
            'verify_plus_expected': verify_plus_will_screen,
        }
    user['phone'] = identity.value
    user['phone_normalized'] = identity.value
    if email_identity:
        user['email'] = email_identity.value
        user['email_normalized'] = email_identity.value
    else:
        user['email'] = f'phone-{user_id}@account.phone.invalid'
    if referral_risk_clusters:
        user['referral_risk_clusters'] = dict(referral_risk_clusters)

    async def create_account(session):
        kwargs = {'session': session} if session is not None else {}
        await db.users.insert_one(user, **kwargs)
        # Insert-only evidence shares the account transaction. The deterministic
        # _id prevents a second registration acceptance for the same account.
        await db.policy_acceptances.insert_one(acceptance_record, **kwargs)
        await crm.attribute_user(
            user['id'], None, actor='self-registration-phone-otp', session=session,
        )
        if body.invite_code:
            import promotions
            try:
                await promotions.attach_player_referral(
                    user['id'], body.invite_code, jurisdiction=country_code,
                    consented_at=created_at, session=session,
                )
            except promotions.PromotionError as exc:
                raise HTTPException(status_code=422, detail={
                    'code': exc.code, 'message': exc.message,
                }) from exc
        return await db.users.find_one({'id': user['id']}, **kwargs)

    try:
        user = await _run_auth_transaction(create_account)
    except DuplicateKeyError:
        # A concurrent insert won either normalized-identity guard. Keep the
        # response generic so it does not disclose which identity matched.
        return _opaque_registration_response(identity)

    challenge = await _issue_or_public_challenge(user, identity, VERIFY_CONTACT)
    return {
        'message': GENERIC_REGISTER_MESSAGE,
        'verification_required': True,
        **challenge,
    }


async def _register_for_admin_review(
    body: RegisterRequest,
    referral_risk_clusters: dict | None = None,
    policy_acceptance: dict | None = None,
):
    """Create one zero-chip player application for explicit admin approval.

    No delivery adapter is consulted and no response claims that a code was
    sent.  Contacts remain unverified; the password proves only knowledge of
    the chosen credential, while the operator's approval controls activation.
    """
    try:
        require_configured_pepper()
        await require_identity_indexes()
        await require_registration_transactions()
        await crm.require_registration_attribution_readiness()
        await crm.require_portal_identity_readiness()
    except OtpConfigurationError as exc:
        _raise_otp(exc)
    except crm.CrmConfigurationError as exc:
        _raise_otp(OtpConfigurationError(str(exc)))

    identity = _request_identity(body)
    if identity.channel != 'SMS' or identity.value != body.phone:
        raise HTTPException(status_code=422, detail={
            'code': 'PHONE_REQUIRED',
            'message': 'Enter a valid mobile number with country code.',
        })
    if not body.email:
        raise HTTPException(status_code=422, detail={
            'code': 'EMAIL_REQUIRED',
            'message': 'A valid email address is required.',
        })
    if body.password is None or body.password_confirmation is None:
        raise HTTPException(status_code=422, detail={
            'code': 'PASSWORD_REQUIRED',
            'message': 'Create and confirm a password of at least 8 characters.',
        })
    if body.password != body.password_confirmation:
        raise HTTPException(status_code=422, detail={
            'code': 'PASSWORD_MISMATCH',
            'message': 'Password confirmation does not match.',
        })

    full_name = (body.full_name or '').strip()
    country = (body.country or '').strip()
    country_code = compliance.normalise_country(country)
    if not full_name:
        raise HTTPException(status_code=422, detail={
            'code': 'PROFILE_REQUIRED', 'message': 'A full name is required.',
        })
    if not country or not country_code or country_code == compliance.UNKNOWN:
        raise HTTPException(status_code=422, detail={
            'code': 'COUNTRY_REQUIRED', 'message': 'A recognized country is required.',
        })
    if not body.date_of_birth:
        raise HTTPException(status_code=422, detail={
            'code': 'AGE_UNKNOWN', 'message': 'A valid date of birth is required.',
        })
    if body.accepted_terms is not True:
        raise HTTPException(status_code=422, detail={
            'code': 'TERMS_REQUIRED',
            'message': 'Accept the Terms and Conditions to continue.',
        })
    ok, code, message = await compliance.check_eligibility(
        country, body.date_of_birth, require_dob=True,
    )
    if not ok:
        raise HTTPException(status_code=403, detail={'code': code, 'message': message})
    if not body.username:
        # Match the OTP route's uniform pre-lookup requirement. Existing and
        # unknown contacts must expose the same response shape.
        raise HTTPException(status_code=422, detail={
            'code': 'LOGIN_ID_REQUIRED',
            'message': 'Choose your Login ID to create an account.',
        })
    try:
        await crm.assert_player_login_id_available(body.username)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail={
            'code': 'LOGIN_ID_UNAVAILABLE',
            'message': 'That Login ID is unavailable. Choose another Login ID.',
        }) from exc

    telesign_onboarding = await _telesign_onboarding_screen(
        identity,
        str(body.email),
        verify_plus_will_screen=False,
    )

    # Password work happens before persistence so every application pays the
    # same cost. Submitted contacts remain provisional and intentionally do not
    # reserve another player's login identity before an operator approves them.
    password_hash = await asyncio.to_thread(hash_password, body.password)
    email_identity = normalize_identity(str(body.email))
    public_request_id = str(uuid.uuid4())
    response = {
        'message': (
            'If the details are eligible, the account request has been '
            'submitted for administrator review.'
        ),
        'request_id': public_request_id,
        'registration_mode': ADMIN_REVIEW_ACTIVATION_MODE,
        'review_required': True,
        'verification_required': False,
    }
    existing = await db.users.find_one({'$or': [
        {'email_normalized': email_identity.value},
        {'email': email_identity.value},
        {'phone_normalized': identity.value},
        {'phone': identity.value},
        {'status': 'PENDING', 'pending_email': email_identity.value},
        {'status': 'PENDING', 'pending_phone': identity.value},
    ]})
    if existing:
        # Keep the public response opaque while preventing retries with either
        # submitted contact from filling the finite administrator review queue.
        return response

    user_id = str(uuid.uuid4())
    created_at = _now().isoformat()
    login_id = body.username
    policy_acceptance = policy_acceptance or _registration_policy_acceptance(
        body, ADMIN_REVIEW_ACTIVATION_MODE,
    )
    user = {
        'id': user_id,
        'role': 'PLAYER',
        'status': 'PENDING',
        'registration_source': 'SELF_SERVICE',
        'activation_mode': ADMIN_REVIEW_ACTIVATION_MODE,
        'contact_verification_status': ADMIN_REVIEW_PENDING,
        'manual_contact_reviewed': False,
        'identity_verified': False,
        'contact_verified': False,
        'email_verified': False,
        'phone_verified': False,
        # The compatibility address satisfies the legacy unique email index;
        # only approval atomically promotes pending contacts to login fields.
        'email': f'application-{user_id}@account.manual.invalid',
        'pending_email': email_identity.value,
        'pending_phone': identity.value,
        'password_hash': password_hash,
        'password_set_at': created_at,
        'password_failed_attempts': 0,
        'display_name': full_name,
        'full_name': full_name,
        'country': country,
        'country_code': country_code,
        'date_of_birth': body.date_of_birth,
        'avatar': deterministic_avatar_key(identity.value),
        'avatar_source': 'PRESET',
        'chip_balance': 0,
        'points_balance': 0,
        'favorites': [],
        'recent_games': [],
        'settings': {
            'sound_enabled': True, 'music_enabled': True,
            'haptics_enabled': True, 'reduced_motion': False,
            'high_contrast': False,
        },
        # The complete profile is the application. There is no hidden second
        # onboarding submission required before it appears in the admin queue.
        'submitted_at': created_at,
        'created_at': created_at,
    }
    acceptance_record = _policy_acceptance_record(user, policy_acceptance)
    _apply_policy_acceptance_to_user(user, acceptance_record)
    if login_id:
        # Administrator approval is the trusted claim point in this mode.
        user['requested_username'] = login_id
    if telesign_onboarding:
        user['telesign_onboarding'] = {
            **telesign_onboarding,
            'screened_at': created_at,
            'verify_plus_expected': False,
        }
    if referral_risk_clusters:
        user['referral_risk_clusters'] = dict(referral_risk_clusters)

    async def create_account(session):
        kwargs = {'session': session} if session is not None else {}
        await db.users.insert_one(user, **kwargs)
        await db.policy_acceptances.insert_one(acceptance_record, **kwargs)
        await crm.attribute_user(
            user_id, None, actor='self-registration-admin-review', session=session,
        )
        if body.invite_code:
            import promotions
            try:
                await promotions.attach_player_referral(
                    user_id, body.invite_code, jurisdiction=country_code,
                    consented_at=created_at, session=session,
                )
            except promotions.PromotionError as exc:
                raise HTTPException(status_code=422, detail={
                    'code': exc.code, 'message': exc.message,
                }) from exc
        return await db.users.find_one({'id': user_id}, **kwargs)

    try:
        await _run_auth_transaction(create_account)
    except DuplicateKeyError:
        # A simultaneous duplicate provisional contact or a vanishingly
        # unlikely placeholder/Login-ID collision stays generic.
        return response
    return response


@router.post('/register', status_code=status.HTTP_202_ACCEPTED)
async def register(body: RegisterRequest, request: Request = None):
    referral_risk_clusters = None
    if body.invite_code and request is not None:
        import promotions
        if promotions.feature_enabled(promotions.REFERRAL):
            from security import _client_ip
            referral_risk_clusters = promotions.registration_risk_clusters(
                client_ip=_client_ip(request),
                user_agent=request.headers.get('user-agent', ''),
            )
    mode = _registration_mode()
    if mode not in (ADMIN_REVIEW_ACTIVATION_MODE, PHONE_OTP_ACTIVATION_MODE):
        raise HTTPException(status_code=503, detail={
            'code': 'REGISTRATION_UNAVAILABLE',
            'message': 'Registration is temporarily unavailable.',
        })
    policy_acceptance = _registration_policy_acceptance(body, mode, request)
    if mode == ADMIN_REVIEW_ACTIVATION_MODE:
        return await _register_for_admin_review(
            body, referral_risk_clusters, policy_acceptance,
        )
    if mode == PHONE_OTP_ACTIVATION_MODE:
        return await _register_phone_otp(
            body, referral_risk_clusters, policy_acceptance,
        )


@router.post('/signup-request')
async def signup_request(body: SignupRequestCreate):
    """Retired no-OTP registration path, opt-in only during migration."""
    if (os.environ.get('LEGACY_SIGNUP_REQUESTS_ENABLED') or '').strip().lower() != 'true':
        raise HTTPException(status_code=410, detail={
            'code': 'LEGACY_REGISTRATION_DISABLED',
            'message': 'Use verified email or phone registration.',
        })
    email = body.email.lower().strip()
    phone = normalize_identity(body.phone)
    # Evaluate eligibility before checking whether either identity exists.
    # Existing and new contacts therefore receive the same decision contract.
    ok, code, message = await compliance.check_eligibility(body.country, body.date_of_birth)
    if not ok:
        raise HTTPException(status_code=403, detail={'code': code, 'message': message})
    if (await db.users.find_one({'$or': [
            {'email_normalized': email}, {'email': email},
            {'phone_normalized': phone.value}, {'phone': phone.value},
    ]}) or await db.signup_requests.find_one({
            '$or': [{'email': email}, {'phone': phone.value}], 'status': 'PENDING',
    })):
        # Do not disclose which collection/contact matched.
        return {
            'message': 'If eligible, the account request has been submitted for review.',
            'request_id': str(uuid.uuid4()),
        }
    doc = {
        'id': str(uuid.uuid4()),
        'full_name': body.full_name.strip(),
        'country': (body.country or '').strip() or None,
        'email': email,
        'email_normalized': email,
        'date_of_birth': body.date_of_birth,
        'phone': phone.value,
        'phone_normalized': phone.value,
        'status': 'PENDING',
        'referral_code_raw': (body.referral_code or '').strip() or None,
        'referral_code': crm.normalise_code(body.referral_code),
        'created_at': _now().isoformat(),
        'reviewed_at': None, 'reviewed_by': None, 'admin_note': None,
        'assigned_username': None,
    }
    await db.signup_requests.insert_one(doc)
    return {
        'message': 'If eligible, the account request has been submitted for review.',
        'request_id': doc['id'],
    }


@router.post('/verify-email')
@router.post('/verify-otp')
async def verify_contact(body: VerifyEmailRequest):
    identity = _request_identity(body)
    # Hash before challenge/account branching for uniform work. Only the
    # successful one-use OTP path is allowed to commit this verifier-owned
    # password, preventing pre-registration password planting.
    verifier_password_hash = await asyncio.to_thread(hash_password, body.password)
    try:
        prepared = await prepare_challenge_verification(
            identity, body.code.strip(), VERIFY_CONTACT,
            challenge_id=_challenge_id(body),
        )
    except OtpError as exc:
        _raise_public_code_error(exc, 'The verification code is invalid or expired.')
    session_id = str(uuid.uuid4())

    async def commit_verification(session):
        verified = await consume_prepared_challenge(
            prepared, identity, body.code.strip(), VERIFY_CONTACT,
            database=db, session=session,
        )
        user = await _find_identity_user(identity, session=session)
        if (not user or user.get('role') != 'PLAYER'
                or _identity_is_verified(user, identity)
                or verified.get('user_id') != user.get('id')):
            raise OtpError('OTP_INVALID', 'The verification code is invalid or expired.')

        contact_field = identity.verified_field
        verified_at = _now().isoformat()
        phone_self_service = bool(
            user.get('registration_source') == 'SELF_SERVICE'
            and user.get('activation_mode') == PHONE_OTP_ACTIVATION_MODE
        )
        # Dual email activation is retired. Leftover per-user
        # email_verification_required flags must not reopen an email OTP gate.
        dual_email_required = False
        phone_step = bool(phone_self_service and identity.channel == 'SMS')
        email_step = bool(
            dual_email_required
            and identity.channel == 'EMAIL'
            and user.get('phone_verified') is True
            and user.get('email_normalized') == identity.value
        )
        if phone_self_service and not (phone_step or email_step):
            raise OtpError('OTP_INVALID', 'The verification code is invalid or expired.')
        final_phone_activation = bool(
            phone_self_service and not (phone_step and dual_email_required)
        )
        login_id = body.username or user.get('requested_username')
        login_id_key = None
        if final_phone_activation and login_id:
            try:
                await crm.require_portal_identity_readiness()
                login_id, login_id_key = await crm.reserve_player_login_id(
                    login_id, user['id'], session=session,
                )
            except crm.CrmConfigurationError as exc:
                raise HTTPException(status_code=503, detail={
                    'code': 'LOGIN_ID_STORAGE_UNAVAILABLE',
                    'message': 'Login ID storage is temporarily unavailable. Try again.',
                }) from exc
            except (ValueError, DuplicateKeyError) as exc:
                raise HTTPException(status_code=409, detail={
                    'code': 'LOGIN_ID_UNAVAILABLE',
                    'message': 'That Login ID is unavailable. Choose another Login ID.',
                }) from exc
        updates = {
            contact_field: True,
            'password_hash': verifier_password_hash,
            'password_set_at': verified_at,
            'password_failed_attempts': 0,
        }
        if phone_self_service:
            updates.update({
                'primary_identity': user.get('phone_normalized') or user.get('phone'),
                'primary_identity_channel': 'PHONE',
                'activation_mode': PHONE_OTP_ACTIVATION_MODE,
            })
            if phone_step and dual_email_required:
                updates.update({
                    'status': 'PENDING',
                    'contact_verified': False,
                    'contact_verification_status': 'PHONE_VERIFIED_EMAIL_PENDING',
                    'phone_verified_at': verified_at,
                })
                if login_id:
                    # Keep an authenticated edit made on the first OTP step so
                    # interrupted email verification can recover that choice.
                    updates['requested_username'] = login_id
            else:
                # Existing phone-only registrations retain their original
                # activation contract. New dual-verification registrations
                # become active only after the email step succeeds.
                updates.update({
                    'status': 'ACTIVE',
                    'contact_verified': True,
                    'contact_verification_status': 'VERIFIED',
                    'contact_verified_at': verified_at,
                    'activated_at': verified_at,
                    'approved_at': verified_at,
                    'approved_by': (
                        'SELF_SERVICE_PHONE_EMAIL_OTP'
                        if email_step else 'SELF_SERVICE_PHONE_OTP'
                    ),
                    'active_session_id': session_id,
                })
                updates['email_verification_required'] = False
                if not dual_email_required:
                    updates['email_verified'] = False
                if login_id:
                    updates.update({
                        'username': login_id,
                        'username_key': login_id_key,
                    })
        elif _self_service_needs_profile(user):
            updates.update({
                'status': 'VERIFIED',
                'contact_verified': True,
                'contact_verification_status': 'VERIFIED',
                'contact_verified_at': verified_at,
                'primary_identity': identity.value,
                'primary_identity_channel': 'PHONE' if identity.channel == 'SMS' else 'EMAIL',
                'active_session_id': session_id,
            })
        else:
            updates.update({
                'contact_verified': True,
                'contact_verification_status': 'VERIFIED',
                'contact_verified_at': verified_at,
                'primary_identity': identity.value,
                'primary_identity_channel': 'PHONE' if identity.channel == 'SMS' else 'EMAIL',
                'active_session_id': session_id,
            })
        kwargs = {'session': session} if session is not None else {}
        verification_query = {'id': user['id'], contact_field: {'$ne': True}}
        if phone_self_service:
            verification_query.update({
                'role': 'PLAYER',
                'status': 'PENDING',
                'registration_source': 'SELF_SERVICE',
                'activation_mode': PHONE_OTP_ACTIVATION_MODE,
                'primary_identity_channel': 'PHONE',
                'accepted_terms': True,
            })
            if phone_step:
                verification_query['phone_normalized'] = identity.value
            else:
                verification_query.update({
                    'phone_verified': True,
                    'email_normalized': identity.value,
                    'email_verification_required': True,
                })
        verification_unsets = {
            'verification_code_hash': '', 'verification_expires_at': '',
            'locked_until': '',
        }
        if final_phone_activation and login_id:
            verification_unsets['requested_username'] = ''
        updated = await db.users.find_one_and_update(
            verification_query,
            {
                '$set': updates,
                '$unset': verification_unsets,
            },
            return_document=ReturnDocument.AFTER,
            **kwargs,
        )
        if not updated:
            raise OtpError('OTP_INVALID', 'The verification code is invalid or expired.')
        if updated.get('status') == 'ACTIVE':
            import promotions
            await promotions.record_referral_event(
                updated['id'], 'REGISTRATION_VERIFIED',
                source_event_id=f"contact-verified:{updated['id']}",
                occurred_at=verified_at,
                metadata={'verification_method': updated.get('approved_by')},
                session=session,
            )
        return updated

    try:
        user = await _run_auth_transaction(commit_verification)
    except OtpError as exc:
        _raise_public_code_error(exc, 'The verification code is invalid or expired.')
    await report_delivery_completion(prepared, body.code.strip(), database=db)
    # Phone SMS is the only activation proof. Never issue a follow-up email
    # challenge, including for leftover email_verification_required documents.
    token = create_access_token(user['id'], user['role'], session_id=session_id)
    return {
        'message': (
            'Mobile number verified. Your account is active.'
            if user.get('activation_mode') == PHONE_OTP_ACTIVATION_MODE
            else 'Contact verified. Complete your profile to continue.'
        ),
        'access_token': token,
        'user': public_user(user),
    }


@router.post('/resend-verification', status_code=status.HTTP_202_ACCEPTED)
@router.post('/resend-otp', status_code=status.HTTP_202_ACCEPTED)
async def resend_verification(body: ResendVerificationRequest):
    identity = await _resend_identity(body)
    try:
        await consume_persistent_limit(
            'otp_issue:VERIFY_CONTACT', f'{identity.channel}:{identity.value}',
            limit=5, window_seconds=3600,
        )
    except OtpError as exc:
        # This limit is consumed identically before account lookup for known,
        # verified, unverified and unknown identities.
        _raise_otp(exc)
    user = await _find_identity_user(identity)
    if not user or user.get('role') != 'PLAYER' or _identity_is_verified(user, identity):
        return {'message': GENERIC_RESEND_MESSAGE, **_dummy_challenge(identity)}
    if (user.get('registration_source') == 'SELF_SERVICE'
            and user.get('activation_mode') == PHONE_OTP_ACTIVATION_MODE):
        # Activation email OTP is retired; PHONE_OTP accounts only resend SMS.
        email_followup = False
        if identity.channel != 'SMS' and not email_followup:
            raise HTTPException(status_code=422, detail={
                'code': 'PHONE_REQUIRED',
                'message': 'This account must begin verification by mobile OTP.',
            })
    try:
        challenge = await issue_challenge(
            user, identity, VERIFY_CONTACT, consume_limit=False,
        )
    except OtpError as exc:
        # Never tell a known player that a new SMS was sent when the provider
        # rejected it. Unknown/verified contacts retain the opaque response
        # above, which makes no unconditional delivery claim.
        _raise_otp(exc)
    return {'message': GENERIC_RESEND_MESSAGE, **challenge}


@router.post('/login')
async def login(body: LoginRequest):
    ident = _request_value(body)
    normalized_subject = ident.casefold()
    contact_identity = None
    if '@' in ident or ident.startswith('+'):
        try:
            contact_identity = normalize_identity(ident)
            normalized_subject = contact_identity.value
        except ValueError:
            contact_identity = None
    try:
        await consume_persistent_limit(
            'password_login', normalized_subject,
            limit=10, window_seconds=900,
        )
    except OtpError as exc:
        _raise_otp(exc)

    if contact_identity:
        user = await _find_identity_user(contact_identity)
    else:
        user = await db.users.find_one({'$or': [
            {'username_key': ident.casefold()},
            {'username': {'$regex': f'^{re.escape(ident)}$', '$options': 'i'}},
        ]})
    now = _now()
    password_ok = await asyncio.to_thread(
        verify_password,
        body.password,
        user.get('password_hash', DUMMY_PASSWORD_HASH) if user else DUMMY_PASSWORD_HASH,
    )
    phone_self_service_identity_ok = True
    if (user
            and user.get('role') == 'PLAYER'
            and user.get('registration_source') == 'SELF_SERVICE'
            and user.get('activation_mode') == PHONE_OTP_ACTIVATION_MODE):
        # The optional email collected during sign-up is profile data only. It
        # must not silently become a login identifier without its own ownership
        # proof. Phone-OTP accounts may authenticate with the exact verified
        # mobile number or their explicitly chosen Login ID.
        phone_self_service_identity_ok = bool(
            (
                contact_identity
                and contact_identity.channel == 'SMS'
                and contact_identity.value == user.get('phone_normalized')
            )
            or (
                contact_identity is None
                and user.get('username_key')
                and user.get('username_key') == ident.casefold()
            )
        )
    locked_until = _as_utc(user.get('locked_until')) if user else None
    if user and locked_until and locked_until <= now:
        await db.users.update_one({'id': user['id']}, {
            '$set': {'password_failed_attempts': 0},
            '$unset': {'locked_until': ''},
        })
        user['password_failed_attempts'] = 0
        user.pop('locked_until', None)
        locked_until = None
    if user and locked_until and locked_until > now:
        raise HTTPException(status_code=401, detail=INVALID_LOGIN_MESSAGE)
    if not user or not password_ok or not phone_self_service_identity_ok:
        if user:
            updated = await db.users.find_one_and_update(
                {'id': user['id']},
                {
                    '$inc': {'password_failed_attempts': 1},
                    '$set': {'last_password_failure_at': now.isoformat()},
                },
                return_document=ReturnDocument.AFTER,
            )
            if int((updated or {}).get('password_failed_attempts') or 0) >= PASSWORD_FAILURE_LIMIT:
                await db.users.update_one({'id': user['id']}, {'$set': {
                    'locked_until': (now + timedelta(seconds=PASSWORD_LOCK_SECONDS)).isoformat(),
                }})
        raise HTTPException(status_code=401, detail=INVALID_LOGIN_MESSAGE)
    if body.login_surface and user.get('role') != body.login_surface:
        # This check is deliberately after password verification (no role
        # enumeration) and before any session write (no cross-surface logout).
        raise HTTPException(status_code=403, detail={
            'code': 'LOGIN_SURFACE_MISMATCH',
            'message': 'This account cannot sign in from this login page.',
        })
    if user.get('role') == 'ADMIN' and user.get('status') != 'ACTIVE':
        raise HTTPException(status_code=403, detail='Administrator access is disabled')
    if user.get('role') == 'DISTRIBUTOR':
        dist = await db.distributors.find_one(
            {'user_id': user['id']}, {'_id': 0, 'status': 1},
        )
        if user.get('status') != 'ACTIVE' or not dist or dist.get('status') != 'ACTIVE':
            raise HTTPException(status_code=403, detail={
                'code': 'DISTRIBUTOR_LOGIN_DISABLED',
                'message': 'This partner login is disabled. Please contact the operator.',
            })
    player_contact_verified = False
    phone_self_service = False
    manual_review_account = False
    legacy_operator_repair = False
    operator_provisioned = False
    if user.get('role') == 'PLAYER':
        operator_provisioned = _operator_provisioned_player(user)
        phone_self_service = bool(
            user.get('registration_source') == 'SELF_SERVICE'
            and user.get('activation_mode') == PHONE_OTP_ACTIVATION_MODE
        )
        if phone_self_service:
            user = await _repair_phone_otp_email_pending(user)
        manual_review_account = bool(
            user.get('registration_source') == 'SELF_SERVICE'
            and user.get('activation_mode') == ADMIN_REVIEW_ACTIVATION_MODE
        )
        if manual_review_account and user.get('status') != 'ACTIVE':
            if user.get('status') == 'REJECTED':
                raise HTTPException(status_code=403, detail={
                    'code': 'ACCOUNT_REVIEW_REJECTED',
                    'message': 'Your registration was not approved. Contact support for help.',
                })
            if user.get('status') == 'SUSPENDED':
                raise HTTPException(status_code=403, detail={
                    'code': 'ACCOUNT_SUSPENDED',
                    'message': 'Your account is suspended. Contact support.',
                })
            raise HTTPException(status_code=403, detail={
                'code': 'ACCOUNT_PENDING_REVIEW',
                'message': 'Your registration is pending administrator approval.',
            })
        primary = None
        if operator_provisioned:
            # The administrator issued the Login ID and password specifically
            # for direct access. A synthetic account email is not a deliverable
            # contact and must never strand this login in contact recovery.
            player_contact_verified = True
        else:
            primary = None if phone_self_service else contact_identity
            if primary is None:
                try:
                    primary = normalize_identity(
                        user.get('phone') if phone_self_service
                        else user.get('primary_identity') or user.get('email')
                    )
                except ValueError:
                    primary = None
            player_contact_verified = bool(primary and _identity_is_verified(user, primary))
        # In the temporary ADMIN_REVIEW mode an explicit operator decision,
        # not an OTP, is the activation gate. Contact flags deliberately stay
        # false so the UI and future verification migration remain truthful.
        if manual_review_account:
            player_contact_verified = bool(
                user.get('manual_contact_reviewed') is True
                and user.get('contact_verification_status') == ADMIN_REVIEW_APPROVED
            )
        if (not player_contact_verified
                and _legacy_operator_contact_repair_allowed(user, primary)):
            player_contact_verified = True
            legacy_operator_repair = True
        if not player_contact_verified:
            # A correct password has already been proved. Always return the
            # deliverable contact (mobile first) so Login ID / email logins
            # can request the SMS that actually belongs to this account.
            raise HTTPException(
                status_code=403,
                detail=_contact_not_verified_detail(user, primary),
            )

    telesign_sign_in = None
    if user.get('role') == 'PLAYER':
        telesign_sign_in = await _telesign_sign_in_screen(user)

    session_id = str(uuid.uuid4())
    login_otp_challenge = None
    login_otp_identity = None
    temporary_access_recovery = bool(
        user.get('role') == 'PLAYER'
        and user.get('password_change_required') is True
        and user.get('login_otp_bypass_once') is True
    )
    if (
        user.get('role') == 'PLAYER'
        and _player_login_otp_required()
        and not operator_provisioned
        and not temporary_access_recovery
    ):
        try:
            login_otp_identity = _player_login_otp_identity(user)
            login_otp_challenge = await issue_challenge(
                user, login_otp_identity, LOGIN_VERIFICATION,
            )
        except OtpError as exc:
            _raise_otp(exc)
        await db.otp_challenges.update_one(
            {
                'id': login_otp_challenge['challenge_id'],
                'user_id': user['id'],
                'purpose': LOGIN_VERIFICATION,
                'active': True,
            },
            {'$set': {'login_session_id': session_id}},
        )

    login_updates = {
        'active_session_id': session_id,
        'password_failed_attempts': 0,
    }
    if login_otp_challenge:
        login_updates['pending_login_at'] = _now().isoformat()
    else:
        login_updates['last_login_at'] = _now().isoformat()
    if telesign_sign_in:
        login_updates['telesign_last_sign_in'] = {
            **telesign_sign_in,
            'screened_at': _now().isoformat(),
        }
    if _self_service_needs_profile(user) and player_contact_verified:
        # Repair accounts verified before the profile state transition shipped.
        login_updates['status'] = 'VERIFIED'
        login_updates['contact_verified'] = True
    if legacy_operator_repair:
        repaired_at = _now().isoformat()
        login_updates.update({
            primary.verified_field: True,
            'contact_verified': True,
            'contact_verified_at': repaired_at,
            'primary_identity': primary.value,
            'primary_identity_channel': 'PHONE' if primary.channel == 'SMS' else 'EMAIL',
            'contact_verification_repaired_at': repaired_at,
            'contact_verification_repair': 'LEGACY_OPERATOR_ACTIVE',
        })
    login_query = {'id': user['id']}
    if user.get('role') == 'PLAYER' and phone_self_service:
        # A concurrent admin/edit must not let a stale password check mint a
        # session after the verified-phone state changed.
        login_query.update({
            'registration_source': 'SELF_SERVICE',
            'activation_mode': PHONE_OTP_ACTIVATION_MODE,
            'phone_verified': True,
            'contact_verified': True,
        })
        login_updates['email_verification_required'] = False
    elif user.get('role') == 'PLAYER' and manual_review_account:
        # Prevent a concurrent suspension/rejection from minting a session
        # after the password check but before the write.
        login_query.update({
            'role': 'PLAYER',
            'status': 'ACTIVE',
            'registration_source': 'SELF_SERVICE',
            'activation_mode': ADMIN_REVIEW_ACTIVATION_MODE,
            'manual_contact_reviewed': True,
            'contact_verification_status': ADMIN_REVIEW_APPROVED,
        })
    elif legacy_operator_repair:
        # The compatibility repair is itself a CAS: a concurrent explicit
        # verification decision or account-state change must win, never be
        # overwritten by a stale legacy login.
        login_query.update({
            'role': 'PLAYER',
            'status': 'ACTIVE',
            'registration_source': {'$ne': 'SELF_SERVICE'},
            'contact_verified': {'$exists': False},
            'email_verified': {'$exists': False},
            'phone_verified': {'$exists': False},
        })
    elif user.get('role') == 'DISTRIBUTOR':
        # Credential resets revoke the previous session and replace the hash.
        # Bind the eventual session write to the exact state whose password was
        # checked so an in-flight old-password request cannot win afterwards.
        login_query.update({
            'role': 'DISTRIBUTOR',
            'status': 'ACTIVE',
            'password_hash': user.get('password_hash'),
            'active_session_id': user.get('active_session_id'),
        })
    login_unsets = {'locked_until': ''}
    if temporary_access_recovery:
        # The bypass is attached to the one temporary-password session only.
        # Every later login returns to the normal player OTP policy.
        login_unsets['login_otp_bypass_once'] = ''
    if user.get('role') == 'ADMIN':
        # A completed step-up belongs to one exact signed-in session. A newer
        # login must never inherit the previous device's short trust window.
        login_unsets.update({
            'mfa_verified_at': '',
            'reauthenticated_at': '',
            'admin_step_up_completed_at': '',
            'admin_step_up_password_verified_at': '',
            'admin_step_up_session_id': '',
        })
    authenticated_user = user
    user = await db.users.find_one_and_update(
        login_query,
        {'$set': login_updates, '$unset': login_unsets},
        return_document=ReturnDocument.AFTER,
    )
    if not user:
        if manual_review_account:
            raise HTTPException(status_code=403, detail={
                'code': 'ACCOUNT_PENDING_REVIEW',
                'message': 'Your account is not currently approved for login.',
            })
        if legacy_operator_repair or phone_self_service:
            raise HTTPException(
                status_code=403,
                detail=_contact_not_verified_detail(authenticated_user, primary),
            )
        raise HTTPException(status_code=401, detail=INVALID_LOGIN_MESSAGE)
    if user.get('role') == 'DISTRIBUTOR':
        current_dist = await db.distributors.find_one({
            'user_id': user['id'], 'status': 'ACTIVE',
        }, {'_id': 0, 'id': 1})
        if not current_dist:
            # The distributor was disabled between the password check and the
            # session commit. Invalidate the just-created session before
            # returning so no token is minted against stale partner state.
            await db.users.update_one(
                {'id': user['id'], 'active_session_id': session_id},
                {'$set': {'active_session_id': f'revoked-{uuid.uuid4()}'}},
            )
            raise HTTPException(status_code=403, detail={
                'code': 'DISTRIBUTOR_LOGIN_DISABLED',
                'message': 'This partner login is disabled. Please contact the operator.',
            })
    if login_otp_challenge:
        response = {
            'requires_otp': True,
            'challenge_id': login_otp_challenge['challenge_id'],
            'verification_id': login_otp_challenge['challenge_id'],
            'destination_masked': login_otp_challenge.get(
                'destination_masked', masked_destination(login_otp_identity),
            ),
            'resend_after_seconds': login_otp_challenge.get(
                'resend_after_seconds', 60,
            ),
            'message': 'Enter the verification code sent to your account contact.',
        }
        if login_otp_challenge.get('dev_code'):
            response['dev_code'] = login_otp_challenge['dev_code']
        return response
    user = await maybe_upgrade_legacy_avatar(user)
    token = create_access_token(user['id'], user['role'], session_id=session_id)
    return {'access_token': token, 'user': public_user(user)}


@router.post('/login/verify-otp')
async def verify_login_otp(body: AuthenticatedOtpVerify):
    """Finish a password-verified player login with a one-use OTP."""
    challenge = await db.otp_challenges.find_one({
        'id': body.challenge_id,
        'purpose': LOGIN_VERIFICATION,
        'active': True,
        'status': 'PENDING',
    })
    session_id = str((challenge or {}).get('login_session_id') or '')
    user = await db.users.find_one({
        'id': (challenge or {}).get('user_id'),
        'role': 'PLAYER',
        'status': {'$nin': ['PENDING', 'REJECTED', 'SUSPENDED']},
        'active_session_id': session_id,
    }) if challenge and session_id else None
    if not user:
        _raise_otp(OtpError(
            'OTP_INVALID', 'The login verification code is invalid or expired.',
        ))
    try:
        identity = _player_login_otp_identity(
            user,
            delivery_required=False,
            requested_channel=challenge.get('channel'),
        )
        prepared = await prepare_challenge_verification(
            identity,
            body.code.strip(),
            LOGIN_VERIFICATION,
            challenge_id=body.challenge_id,
        )
    except OtpError as exc:
        _raise_public_code_error(
            exc, 'The login verification code is invalid or expired.',
        )

    async def commit_login_verification(session):
        verified = await consume_prepared_challenge(
            prepared,
            identity,
            body.code.strip(),
            LOGIN_VERIFICATION,
            database=db,
            session=session,
        )
        if verified.get('user_id') != user.get('id'):
            raise OtpError(
                'OTP_INVALID', 'The login verification code is invalid or expired.',
            )
        kwargs = {'session': session} if session is not None else {}
        set_fields = {
            'last_login_at': _now().isoformat(),
            'login_otp_verified_at': _now().isoformat(),
            'password_failed_attempts': 0,
        }
        if identity.channel == 'SMS':
            set_fields.update({
                'phone_verified': True,
                'contact_verified': True,
                'contact_verified_at': _now().isoformat(),
            })
        updated = await db.users.find_one_and_update(
            {
                'id': user['id'],
                'role': 'PLAYER',
                'status': user.get('status'),
                'active_session_id': session_id,
            },
            {
                '$set': set_fields,
                '$unset': {'pending_login_at': '', 'locked_until': ''},
            },
            return_document=ReturnDocument.AFTER,
            **kwargs,
        )
        if not updated:
            raise OtpError(
                'OTP_INVALID', 'The login verification code is invalid or expired.',
            )
        return updated

    try:
        user = await _run_auth_transaction(commit_login_verification)
    except OtpError as exc:
        _raise_public_code_error(
            exc, 'The login verification code is invalid or expired.',
        )
    await report_delivery_completion(prepared, body.code.strip(), database=db)
    user = await maybe_upgrade_legacy_avatar(user)
    token = create_access_token(user['id'], user['role'], session_id=session_id)
    return {'access_token': token, 'user': public_user(user)}


@router.post('/logout')
async def logout(user: dict = Depends(get_current_user)):
    await db.users.update_one(
        {'id': user['id']},
        {'$set': {'active_session_id': f'revoked-{uuid.uuid4()}'}},
    )
    return {'message': 'Logged out'}


@router.post('/forgot-password', status_code=status.HTTP_202_ACCEPTED)
async def forgot_password(body: ForgotPasswordRequest):
    identity = _request_identity(body)
    # Use whichever verified contact the player supplied. The public response
    # remains uniform, while the capability endpoint tells the UI which global
    # channels are currently configured.
    delivery_available = delivery_adapter_ready(identity.channel)
    user = await _find_identity_user(identity)
    if (
        delivery_available
        and user
        and user.get('role') == 'PLAYER'
        and _identity_is_verified(user, identity)
    ):
        try:
            await issue_challenge(user, identity, RESET_PASSWORD)
        except OtpError as exc:
            # Enumeration safety wins here: delivery/cooldown state must not
            # reveal whether the contact belongs to an account. Never 500.
            logger.warning('Password reset challenge not issued: %s', exc.code)
    else:
        try:
            await consume_persistent_limit(
                'otp_issue:RESET_PASSWORD', f'{identity.channel}:{identity.value}',
                limit=5, window_seconds=3600,
            )
        except OtpError:
            pass
    if not delivery_available:
        return {
            'message': RESET_UNAVAILABLE_MESSAGE,
            'delivery_available': False,
        }
    return {
        'message': GENERIC_RESET_MESSAGE,
        'delivery_available': True,
    }


@router.post('/reset-password')
async def reset_password(body: ResetPasswordRequest):
    identity = _request_identity(body)
    password_hash = await asyncio.to_thread(hash_password, body.new_password)
    try:
        prepared = await prepare_challenge_verification(
            identity, body.code.strip(), RESET_PASSWORD,
            challenge_id=_challenge_id(body),
        )
    except OtpError as exc:
        _raise_public_code_error(exc, 'The reset request is invalid or expired.')

    async def commit_reset(session):
        verified = await consume_prepared_challenge(
            prepared, identity, body.code.strip(), RESET_PASSWORD,
            database=db, session=session,
        )
        user = await _find_identity_user(identity, session=session)
        if (not user or user.get('role') != 'PLAYER'
                or not _identity_is_verified(user, identity)
                or verified.get('user_id') != user.get('id')):
            raise OtpError('OTP_INVALID', 'The reset request is invalid or expired.')
        kwargs = {'session': session} if session is not None else {}
        updated = await db.users.find_one_and_update(
            {'id': user['id']},
            {
                '$set': {
                    'password_hash': password_hash,
                    'password_changed_at': _now().isoformat(),
                    'active_session_id': f'revoked-{uuid.uuid4()}',
                    'password_failed_attempts': 0,
                },
                '$unset': {
                    'reset_code_hash': '',
                    'reset_expires_at': '',
                    'locked_until': '',
                    'login_otp_bypass_once': '',
                    'password_reset_by_admin_id': '',
                },
            },
            return_document=ReturnDocument.AFTER,
            **kwargs,
        )
        if not updated:
            raise OtpError('OTP_INVALID', 'The reset request is invalid or expired.')
        return updated

    try:
        await _run_auth_transaction(commit_reset)
    except OtpError as exc:
        _raise_public_code_error(exc, 'The reset request is invalid or expired.')
    await report_delivery_completion(prepared, body.code.strip(), database=db)
    return {'message': 'Password reset. Please log in with your new password.'}


@router.post('/change-password')
async def change_password(body: ChangePasswordRequest, user: dict = Depends(get_current_user)):
    original_hash = user.get('password_hash', '')
    if not await asyncio.to_thread(
        verify_password, body.current_password, original_hash,
    ):
        raise HTTPException(status_code=400, detail='Current password is incorrect')
    if await asyncio.to_thread(
        verify_password, body.new_password, original_hash,
    ):
        raise HTTPException(status_code=400, detail={
            'code': 'NEW_PASSWORD_MUST_DIFFER',
            'message': 'Choose a new password that is different from the temporary password.',
        })
    if user.get('role') == 'DISTRIBUTOR' and (
        len(body.new_password) < 12 or not body.new_password.strip()
    ):
        raise HTTPException(status_code=400, detail={
            'code': 'DISTRIBUTOR_PASSWORD_TOO_WEAK',
            'message': 'Partner passwords must contain at least 12 characters and cannot be blank.',
        })
    new_password_hash = await asyncio.to_thread(hash_password, body.new_password)
    query = {
        'id': user['id'],
        'role': user.get('role'),
        'password_hash': original_hash,
        'active_session_id': user.get('active_session_id'),
    }
    if user.get('status') is not None:
        query['status'] = user.get('status')
    result = await db.users.update_one(query, {'$set': {
        'password_hash': new_password_hash,
        'password_changed_at': _now().isoformat(),
        'password_change_required': False,
        'active_session_id': f'revoked-{uuid.uuid4()}',
    }, '$unset': {
        'login_otp_bypass_once': '',
        'password_reset_by_admin_id': '',
    }})
    if result.matched_count != 1:
        raise HTTPException(status_code=409, detail={
            'code': 'CREDENTIALS_CHANGED',
            'message': 'Credentials changed in another session. Sign in again and retry.',
        })
    return {'message': 'Password changed successfully. Please log in again.'}


@router.get('/me')
async def me(user: dict = Depends(get_current_user)):
    user = await _repair_phone_otp_email_pending(user)
    return {'user': public_user(user)}


def _verified_player_mobile(user: dict) -> Identity:
    if user.get('role') != 'PLAYER' or user.get('status') != 'ACTIVE':
        raise HTTPException(status_code=403, detail={
            'code': 'ACTIVE_PLAYER_REQUIRED',
            'message': 'An active player account is required.',
        })
    try:
        identity = normalize_identity(user.get('phone_normalized') or user.get('phone'))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail={
            'code': 'MOBILE_UNAVAILABLE',
            'message': 'No valid mobile number is recorded on this account.',
        }) from exc
    if identity.channel != 'SMS':
        raise HTTPException(status_code=422, detail={
            'code': 'MOBILE_UNAVAILABLE',
            'message': 'No valid mobile number is recorded on this account.',
        })
    return identity


def _player_otp_unavailable_response() -> dict:
    """Documented fallback when an authenticated player cannot receive SMS."""
    return {
        'message': (
            'A verification code could not be sent. Confirm your password to '
            'request administrator-assisted mobile review. Withdrawals and UPI '
            'payouts still require a verified mobile number.'
        ),
        'verified': False,
        'otp_unavailable': True,
        'password_fallback': True,
        'password_only': False,
    }


@router.post('/me/mobile-verification/request')
async def request_my_mobile_verification(user: dict = Depends(get_current_user)):
    identity = _verified_player_mobile(user)
    if user.get('phone_verified') is True:
        return {'message': 'Your mobile number is already verified.', 'verified': True}
    now = _now().isoformat()
    if not delivery_adapter_ready('SMS'):
        await db.users.update_one(
            {'id': user['id'], 'role': 'PLAYER', 'status': 'ACTIVE', 'phone_verified': {'$ne': True}},
            {'$set': {
                'mobile_verification_status': 'OTP_UNAVAILABLE',
                'mobile_verification_requested_at': now,
                'mobile_verification_request_source': 'PLAYER',
            }},
        )
        return _player_otp_unavailable_response()
    try:
        challenge = await issue_challenge(user, identity, VERIFY_CONTACT)
    except OtpError as exc:
        if exc.code in {'OTP_RESEND_COOLDOWN', 'RATE_LIMITED', 'OTP_LOCKED'}:
            _raise_otp(exc)
        logger.warning('Player mobile OTP not delivered: %s', exc.code)
        await db.users.update_one(
            {'id': user['id'], 'role': 'PLAYER', 'status': 'ACTIVE', 'phone_verified': {'$ne': True}},
            {'$set': {
                'mobile_verification_status': 'OTP_UNAVAILABLE',
                'mobile_verification_requested_at': now,
                'mobile_verification_request_source': 'PLAYER',
            }},
        )
        return _player_otp_unavailable_response()
    await db.users.update_one(
        {'id': user['id'], 'role': 'PLAYER', 'status': 'ACTIVE', 'phone_verified': {'$ne': True}},
        {'$set': {
            'mobile_verification_status': 'OTP_SENT',
            'mobile_verification_requested_at': now,
            'mobile_verification_request_source': 'PLAYER',
        }},
    )
    return {
        'message': 'A verification code was sent to your mobile number.',
        'verified': False,
        **challenge,
    }


@router.post('/me/mobile-verification/password-fallback')
async def player_mobile_verification_password_fallback(
    body: PlayerMobileVerificationFallback,
    user: dict = Depends(get_current_user),
):
    """Password re-auth when SMS OTP cannot be delivered.

    Mirrors admin step-up's password-only ceremony for an already-authenticated
    player. It records the outage and queues admin-assisted review. It does
    NOT mark the phone verified and does not unlock withdrawals/UPI.
    """
    _verified_player_mobile(user)
    if user.get('phone_verified') is True:
        return {
            'message': 'Your mobile number is already verified.',
            'verified': True,
            'user': public_user(user),
        }
    original_hash = user.get('password_hash') or ''
    if not original_hash or not await asyncio.to_thread(
        verify_password, body.current_password, original_hash,
    ):
        try:
            await consume_persistent_limit(
                'player_mobile_password_fallback', user['id'], limit=5,
                window_seconds=15 * 60,
            )
        except OtpError as exc:
            _raise_otp(exc)
        raise HTTPException(status_code=401, detail={
            'code': 'PLAYER_REAUTH_FAILED',
            'message': 'Account password is incorrect.',
        })
    now = _now()
    result = await db.users.update_one({
        'id': user['id'], 'role': 'PLAYER', 'status': 'ACTIVE',
        'password_hash': original_hash,
        'phone_verified': {'$ne': True},
        'active_session_id': user.get('active_session_id'),
    }, {'$set': {
        'mobile_verification_status': 'OTP_UNAVAILABLE',
        'mobile_verification_password_confirmed_at': now.isoformat(),
        'mobile_verification_request_source': 'PLAYER_PASSWORD_FALLBACK',
    }})
    if result.matched_count != 1:
        raise HTTPException(status_code=409, detail={
            'code': 'PLAYER_AUTH_CHANGED',
            'message': 'Account authentication changed. Sign in and retry.',
        })
    await db.financial_audit.insert_one({
        'id': str(uuid.uuid4()),
        'actor_id': user['id'],
        'action': 'MOBILE_OTP_UNAVAILABLE',
        'target_type': 'PLAYER',
        'target_id': user['id'],
        'reason': 'Authenticated password fallback; SMS OTP could not be delivered',
        'before': {'phone_verified': False},
        'after': {
            'phone_verified': False,
            'mobile_verification_status': 'OTP_UNAVAILABLE',
            'password_only': True,
        },
        'created_at': now,
    })
    updated = await db.users.find_one({'id': user['id']})
    return {
        'message': (
            'Password confirmed. Your mobile number is not yet verified. '
            'An administrator can complete review. Withdrawals still require '
            'a verified mobile number.'
        ),
        'verified': False,
        'otp_unavailable': True,
        'password_fallback': True,
        'password_only': True,
        'user': public_user(updated or user),
    }


@router.post('/me/mobile-verification/confirm')
async def confirm_my_mobile_verification(
    body: AuthenticatedOtpVerify,
    user: dict = Depends(get_current_user),
):
    identity = _verified_player_mobile(user)
    if user.get('phone_verified') is True:
        return {'message': 'Your mobile number is already verified.', 'user': public_user(user)}
    try:
        prepared = await prepare_challenge_verification(
            identity, body.code, VERIFY_CONTACT,
            challenge_id=body.challenge_id,
        )
    except OtpError as exc:
        _raise_otp(exc)

    async def commit(session):
        kwargs = {'session': session} if session is not None else {}
        verified = await consume_prepared_challenge(
            prepared, identity, body.code, VERIFY_CONTACT,
            database=db, session=session,
        )
        if verified.get('user_id') != user['id']:
            raise OtpError('OTP_INVALID', 'The verification code is invalid or expired.')
        verified_at = _now().isoformat()
        updated = await db.users.find_one_and_update(
            {
                'id': user['id'], 'role': 'PLAYER', 'status': 'ACTIVE',
                'phone_verified': {'$ne': True},
                '$or': [
                    {'phone_normalized': identity.value},
                    # Legacy accounts may store a formatted raw number and no
                    # normalized field. Match the exact authenticated snapshot
                    # and normalize it as part of this one-time update.
                    {'phone': user.get('phone')},
                ],
            },
            {'$set': {
                'phone_normalized': identity.value,
                'phone_verified': True,
                'phone_verified_at': verified_at,
                'contact_verified': True,
                'contact_verified_at': verified_at,
                'contact_verification_status': 'VERIFIED',
                'mobile_verification_status': 'VERIFIED',
                'mobile_verified_at': verified_at,
            }},
            return_document=ReturnDocument.AFTER,
            **kwargs,
        )
        if not updated:
            raise OtpError('OTP_INVALID', 'The verification code is invalid or expired.')
        await db.financial_audit.insert_one({
            'id': str(uuid.uuid4()),
            'actor_id': user['id'],
            'action': 'MOBILE_OTP_VERIFIED',
            'target_type': 'PLAYER',
            'target_id': user['id'],
            'reason': 'Player completed one-time mobile verification',
            'before': {'phone_verified': False},
            'after': {'phone_verified': True},
            'created_at': _now(),
        }, **kwargs)
        await db.notifications.insert_one({
            'id': str(uuid.uuid4()), 'user_id': user['id'],
            'title': 'Mobile number verified',
            'body': 'Your mobile number has been verified successfully.',
            'type': 'VERIFICATION', 'read': False, 'created_at': verified_at,
        }, **kwargs)
        return updated

    try:
        updated = await _run_auth_transaction(commit)
    except OtpError as exc:
        _raise_otp(exc)
    await report_delivery_completion(prepared, body.code, database=db)
    return {'message': 'Mobile number verified.', 'user': public_user(updated)}
