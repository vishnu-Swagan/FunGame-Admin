"""Authentication routes with email/mobile identities and one-use OTPs."""
import asyncio
import logging
import os
import re
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError

from db import db, serialize_doc
import crm
import compliance
import telesign_service
from avatar_service import deterministic_avatar_key
from models import (
    ChangePasswordRequest,
    ForgotPasswordRequest,
    LoginRequest,
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
    verify_password,
)
from otp_service import (
    OtpConfigurationError,
    OtpError,
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
    'If an account exists for this contact, a reset code has been sent.'
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


def _registration_mode() -> str:
    """Return the explicit registration gate currently selected by operations.

    ADMIN_REVIEW is the temporary default requested by the operator.  Switching
    back to the retained SMS flow is a configuration-only change after the OTP
    provider is ready.  Unknown values fail closed instead of silently choosing
    the less restrictive path.
    """
    configured = (os.environ.get('REGISTRATION_MODE') or ADMIN_REVIEW_ACTIVATION_MODE)
    configured = configured.strip().upper()
    if configured in (ADMIN_REVIEW_ACTIVATION_MODE, PHONE_OTP_ACTIVATION_MODE):
        return configured
    return 'DISABLED'


def _telesign_mode(name: str) -> str:
    value = (os.environ.get(name) or 'disabled').strip().lower()
    return value if value in {'disabled', 'observe', 'enforce'} else 'disabled'


def _telesign_flag(name: str) -> bool:
    return (os.environ.get(name) or '').strip().lower() in {'1', 'true', 'yes', 'on'}


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


def _user_public(user: dict) -> dict:
    public = serialize_doc(user)
    for key in (
        'active_session_id', 'email_normalized', 'phone_normalized',
        'previous_email', 'password_failed_attempts', 'locked_until',
        'telesign_onboarding', 'telesign_last_sign_in',
    ):
        public.pop(key, None)
    # Phone registrations and provisional manual applications carry unique
    # compatibility addresses for the legacy non-sparse email index. They are
    # never presented as user data.
    if str(public.get('email') or '').endswith(('.phone.invalid', '.manual.invalid')):
        public['email'] = None
    return public


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
        'channel': 'PHONE',
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


async def _issue_or_raise(user: dict, identity: Identity, purpose: str) -> dict:
    try:
        return await issue_challenge(user, identity, purpose)
    except OtpError as exc:
        _raise_otp(exc)


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
            manual_storage_ready = True
        except (OtpConfigurationError, crm.CrmConfigurationError):
            manual_storage_ready = False

    otp_storage_ready = await registration_storage_ready()
    email_otp_ready = otp_storage_ready and delivery_adapter_ready('EMAIL')
    phone_otp_ready = otp_storage_ready and delivery_adapter_ready('SMS')
    otp_registration_ready = (
        otp_storage_ready and await crm.registration_attribution_ready()
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
        'email_contact_verification': email_otp_ready,
        'phone_contact_verification': phone_otp_ready,
        # Legacy verified-email accounts may still use their existing recovery
        # channel. New self-service accounts are activated only by phone OTP.
        'email_password_reset': email_otp_ready,
        'phone_password_reset': phone_otp_ready,
        'verification_required': True,
        'registration_mode': PHONE_OTP_ACTIVATION_MODE,
    }


async def _register_phone_otp(body: RegisterRequest):
    """Create a phone-OTP-pending self-service player.

    Email is optional profile data. It is never used as the activation proof.
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

    try:
        await require_registration_readiness()
        await crm.require_registration_attribution_readiness()
    except OtpConfigurationError as exc:
        _raise_otp(exc)
    except crm.CrmConfigurationError as exc:
        _raise_otp(OtpConfigurationError(str(exc)))
    # Availability is global per channel and is checked before any existence
    # lookup, so a disabled provider produces the same response for every
    # contact. Runtime provider failures remain opaque below.
    if not delivery_adapter_ready(identity.channel):
        _raise_otp(OtpConfigurationError('Requested OTP channel is not configured'))
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
            'message': 'Accept the account and play terms to continue.',
        })
    ok, code, message = await compliance.check_eligibility(
        country, body.date_of_birth, require_dob=True,
    )
    if not ok:
        raise HTTPException(status_code=403, detail={'code': code, 'message': message})

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
            challenge = await _issue_or_raise(phone_existing, identity, VERIFY_CONTACT)
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
        'accepted_terms': True,
        'accepted_terms_at': created_at,
        'created_at': created_at,
    }
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

    async def create_account(session):
        kwargs = {'session': session} if session is not None else {}
        await db.users.insert_one(user, **kwargs)
        await crm.attribute_user(
            user['id'], None, actor='self-registration-phone-otp', session=session,
        )
        return await db.users.find_one({'id': user['id']}, **kwargs)

    try:
        user = await _run_auth_transaction(create_account)
    except DuplicateKeyError:
        # A concurrent insert won either normalized-identity guard. Keep the
        # same non-enumerating response as a pre-existing collision.
        return _opaque_registration_response(identity)

    try:
        challenge = await issue_challenge(user, identity, VERIFY_CONTACT)
    except OtpError as exc:
        # A registration is not successful unless the SMS provider accepted
        # the challenge. Remove the unusable pending row and its attribution so
        # the player can retry cleanly when delivery recovers.
        async def rollback_failed_registration(session):
            kwargs = {'session': session} if session is not None else {}
            await db.otp_challenges.delete_many({'user_id': user['id']}, **kwargs)
            await db.player_attribution.delete_many({'user_id': user['id']}, **kwargs)
            await db.users.delete_one({
                'id': user['id'], 'status': 'PENDING', 'phone_verified': False,
            }, **kwargs)

        try:
            await _run_auth_transaction(rollback_failed_registration)
        except HTTPException:
            logger.error('Failed to roll back undeliverable registration')
        _raise_otp(exc)
    return {
        'message': GENERIC_REGISTER_MESSAGE,
        'verification_required': True,
        **challenge,
    }


async def _register_for_admin_review(body: RegisterRequest):
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
            'message': 'Accept the account and play terms to continue.',
        })
    ok, code, message = await compliance.check_eligibility(
        country, body.date_of_birth, require_dob=True,
    )
    if not ok:
        raise HTTPException(status_code=403, detail={'code': code, 'message': message})

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
        'accepted_terms': True,
        'accepted_terms_at': created_at,
        # The complete profile is the application. There is no hidden second
        # onboarding submission required before it appears in the admin queue.
        'submitted_at': created_at,
        'created_at': created_at,
    }
    if telesign_onboarding:
        user['telesign_onboarding'] = {
            **telesign_onboarding,
            'screened_at': created_at,
            'verify_plus_expected': False,
        }

    async def create_account(session):
        kwargs = {'session': session} if session is not None else {}
        await db.users.insert_one(user, **kwargs)
        await crm.attribute_user(
            user_id, None, actor='self-registration-admin-review', session=session,
        )
        return await db.users.find_one({'id': user_id}, **kwargs)

    try:
        await _run_auth_transaction(create_account)
    except DuplicateKeyError:
        # A simultaneous duplicate provisional contact or a vanishingly
        # unlikely generated placeholder collision stays intentionally opaque.
        return response
    return response


@router.post('/register', status_code=status.HTTP_202_ACCEPTED)
async def register(body: RegisterRequest):
    mode = _registration_mode()
    if mode == ADMIN_REVIEW_ACTIVATION_MODE:
        return await _register_for_admin_review(body)
    if mode == PHONE_OTP_ACTIVATION_MODE:
        return await _register_phone_otp(body)
    raise HTTPException(status_code=503, detail={
        'code': 'REGISTRATION_UNAVAILABLE',
        'message': 'Registration is temporarily unavailable.',
    })


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
        updates = {
            contact_field: True,
            'contact_verified': True,
            'contact_verification_status': 'VERIFIED',
            'contact_verified_at': verified_at,
            'primary_identity': identity.value,
            'primary_identity_channel': 'PHONE' if identity.channel == 'SMS' else 'EMAIL',
            'password_hash': verifier_password_hash,
            'password_set_at': verified_at,
            'password_failed_attempts': 0,
            'active_session_id': session_id,
        }
        phone_self_service = bool(
            user.get('registration_source') == 'SELF_SERVICE'
            and user.get('activation_mode') == PHONE_OTP_ACTIVATION_MODE
        )
        if phone_self_service:
            if identity.channel != 'SMS':
                raise OtpError('OTP_INVALID', 'The verification code is invalid or expired.')
            # The full eligible profile and terms were recorded before the SMS
            # was sent, so proof of phone ownership is the final activation
            # gate. approved_at prevents a later reactivation bonus.
            updates.update({
                'status': 'ACTIVE',
                'activated_at': verified_at,
                'approved_at': verified_at,
                'approved_by': 'SELF_SERVICE_PHONE_OTP',
                'activation_mode': PHONE_OTP_ACTIVATION_MODE,
                'email_verified': False,
            })
        elif _self_service_needs_profile(user):
            updates['status'] = 'VERIFIED'
        kwargs = {'session': session} if session is not None else {}
        verification_query = {'id': user['id'], contact_field: {'$ne': True}}
        if phone_self_service:
            verification_query.update({
                'role': 'PLAYER',
                'status': 'PENDING',
                'registration_source': 'SELF_SERVICE',
                'activation_mode': PHONE_OTP_ACTIVATION_MODE,
                'primary_identity_channel': 'PHONE',
                'phone_normalized': identity.value,
                'accepted_terms': True,
            })
        updated = await db.users.find_one_and_update(
            verification_query,
            {
                '$set': updates,
                '$unset': {
                    'verification_code_hash': '', 'verification_expires_at': '',
                    'locked_until': '',
                },
            },
            return_document=ReturnDocument.AFTER,
            **kwargs,
        )
        if not updated:
            raise OtpError('OTP_INVALID', 'The verification code is invalid or expired.')
        return updated

    try:
        user = await _run_auth_transaction(commit_verification)
    except OtpError as exc:
        _raise_public_code_error(exc, 'The verification code is invalid or expired.')
    token = create_access_token(user['id'], user['role'], session_id=session_id)
    return {
        'message': (
            'Mobile number verified. Your account is active.'
            if user.get('activation_mode') == PHONE_OTP_ACTIVATION_MODE
            else 'Contact verified. Complete your profile to continue.'
        ),
        'access_token': token,
        'user': _user_public(user),
    }


@router.post('/resend-verification', status_code=status.HTTP_202_ACCEPTED)
@router.post('/resend-otp', status_code=status.HTTP_202_ACCEPTED)
async def resend_verification(body: ResendVerificationRequest):
    identity = _request_identity(body)
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
            and user.get('activation_mode') == PHONE_OTP_ACTIVATION_MODE
            and identity.channel != 'SMS'):
        raise HTTPException(status_code=422, detail={
            'code': 'PHONE_REQUIRED',
            'message': 'This account must be verified by mobile OTP.',
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
        user = await db.users.find_one({
            'username': {'$regex': f'^{re.escape(ident)}$', '$options': 'i'},
        })
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
        # proof. Phone-OTP accounts authenticate exclusively with the exact
        # verified E.164 number.
        phone_self_service_identity_ok = bool(
            contact_identity
            and contact_identity.channel == 'SMS'
            and contact_identity.value == user.get('phone_normalized')
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
    if user.get('role') == 'ADMIN' and user.get('status') != 'ACTIVE':
        raise HTTPException(status_code=403, detail='Administrator access is disabled')
    player_contact_verified = False
    phone_self_service = False
    manual_review_account = False
    legacy_operator_repair = False
    if user.get('role') == 'PLAYER':
        phone_self_service = bool(
            user.get('registration_source') == 'SELF_SERVICE'
            and user.get('activation_mode') == PHONE_OTP_ACTIVATION_MODE
        )
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
            channel = (
                'PHONE' if primary and primary.channel == 'SMS' else 'EMAIL'
            )
            raise HTTPException(status_code=403, detail={
                'code': 'CONTACT_NOT_VERIFIED',
                'message': 'Verify your contact method before logging in.',
                'channel': channel,
            })

    telesign_sign_in = None
    if user.get('role') == 'PLAYER':
        telesign_sign_in = await _telesign_sign_in_screen(user)

    session_id = str(uuid.uuid4())
    login_updates = {
        'active_session_id': session_id,
        'last_login_at': _now().isoformat(),
        'password_failed_attempts': 0,
    }
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
    user = await db.users.find_one_and_update(
        login_query,
        {'$set': login_updates, '$unset': {'locked_until': ''}},
        return_document=ReturnDocument.AFTER,
    )
    if not user:
        if manual_review_account:
            raise HTTPException(status_code=403, detail={
                'code': 'ACCOUNT_PENDING_REVIEW',
                'message': 'Your account is not currently approved for login.',
            })
        if legacy_operator_repair or phone_self_service:
            raise HTTPException(status_code=403, detail={
                'code': 'CONTACT_NOT_VERIFIED',
                'message': 'Verify your contact method before logging in.',
                'channel': 'PHONE' if primary and primary.channel == 'SMS' else 'EMAIL',
            })
        raise HTTPException(status_code=401, detail=INVALID_LOGIN_MESSAGE)
    user = await maybe_upgrade_legacy_avatar(user)
    token = create_access_token(user['id'], user['role'], session_id=session_id)
    return {'access_token': token, 'user': _user_public(user)}


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
    user = await _find_identity_user(identity)
    if user and user.get('role') == 'PLAYER' and _identity_is_verified(user, identity):
        try:
            await issue_challenge(user, identity, RESET_PASSWORD)
        except OtpError as exc:
            # Enumeration safety wins here: delivery/cooldown state must not
            # reveal whether the contact belongs to an account.
            logger.warning('Password reset challenge not issued: %s', exc.code)
    else:
        try:
            await consume_persistent_limit(
                'otp_issue:RESET_PASSWORD', f'{identity.channel}:{identity.value}',
                limit=5, window_seconds=3600,
            )
        except OtpError:
            pass
    return {'message': GENERIC_RESET_MESSAGE}


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
                    'reset_code_hash': '', 'reset_expires_at': '', 'locked_until': '',
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
    return {'message': 'Password reset. Please log in with your new password.'}


@router.post('/change-password')
async def change_password(body: ChangePasswordRequest, user: dict = Depends(get_current_user)):
    if not await asyncio.to_thread(
        verify_password, body.current_password, user.get('password_hash', ''),
    ):
        raise HTTPException(status_code=400, detail='Current password is incorrect')
    new_password_hash = await asyncio.to_thread(hash_password, body.new_password)
    await db.users.update_one({'id': user['id']}, {'$set': {
        'password_hash': new_password_hash,
        'password_changed_at': _now().isoformat(),
        'active_session_id': f'revoked-{uuid.uuid4()}',
    }})
    return {'message': 'Password changed successfully. Please log in again.'}


@router.get('/me')
async def me(user: dict = Depends(get_current_user)):
    return {'user': _user_public(user)}
