"""Channel-neutral, server-side OTP challenges.

Codes are generated with ``secrets`` and stored only as a purpose-bound HMAC.
Challenges are one-use, expire through both application checks and a Mongo TTL
index, and use compare-and-set updates for attempt lockout and verification.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import logging
import os
import re
import secrets
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Protocol

from email_validator import EmailNotValidError, validate_email
from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError

from db import db
from email_service import EmailService
import telesign_service


logger = logging.getLogger('otp')

VERIFY_CONTACT = 'VERIFY_CONTACT'
RESET_PASSWORD = 'RESET_PASSWORD'
ADMIN_STEP_UP = 'ADMIN_STEP_UP'
LOGIN_VERIFICATION = 'LOGIN_VERIFICATION'
OTP_PURPOSES = frozenset({
    VERIFY_CONTACT,
    RESET_PASSWORD,
    ADMIN_STEP_UP,
    LOGIN_VERIFICATION,
})

OTP_TTL_SECONDS = 15 * 60
OTP_RESEND_COOLDOWN_SECONDS = 60
OTP_MAX_ATTEMPTS = 5
OTP_ISSUE_LIMIT = 5
OTP_ISSUE_WINDOW_SECONDS = 60 * 60
OTP_VERIFY_LIMIT = 12
OTP_VERIFY_WINDOW_SECONDS = 15 * 60

_EMAIL_IDENTITY_INDEX = 'users_email_normalized_unique'
_PHONE_IDENTITY_INDEX = 'users_phone_normalized_unique'
_PENDING_EMAIL_INDEX = 'users_pending_email_review_unique'
_PENDING_PHONE_INDEX = 'users_pending_phone_review_unique'
_EMAIL_IDENTITY_PARTIAL = {'email_normalized': {'$type': 'string'}}
_PHONE_IDENTITY_PARTIAL = {'phone_normalized': {'$type': 'string'}}
_PENDING_EMAIL_PARTIAL = {
    'status': 'PENDING', 'pending_email': {'$type': 'string'},
}
_PENDING_PHONE_PARTIAL = {
    'status': 'PENDING', 'pending_phone': {'$type': 'string'},
}
_INDEX_OPTION_UNSPECIFIED = object()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _as_utc(value: datetime | str | None) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, str):
        value = datetime.fromisoformat(value)
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _is_production() -> bool:
    return (os.environ.get('APP_ENV') or 'development').strip().lower() in {
        'prod', 'production',
    }


class OtpError(Exception):
    def __init__(self, code: str, message: str, *, status_code: int = 400,
                 retry_after: int | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code
        self.retry_after = retry_after


class OtpConfigurationError(OtpError):
    def __init__(self, diagnostic: str = 'Verification delivery is not configured'):
        logger.error('OTP unavailable: %s', diagnostic)
        super().__init__(
            'OTP_UNAVAILABLE', 'Verification is temporarily unavailable.',
            status_code=503,
        )


@dataclass(frozen=True)
class Identity:
    channel: str
    value: str

    @property
    def normalized_field(self) -> str:
        return 'email_normalized' if self.channel == 'EMAIL' else 'phone_normalized'

    @property
    def legacy_field(self) -> str:
        return 'email' if self.channel == 'EMAIL' else 'phone'

    @property
    def verified_field(self) -> str:
        return 'email_verified' if self.channel == 'EMAIL' else 'phone_verified'


def normalize_identity(value: str) -> Identity:
    raw = str(value or '').strip()
    if '@' in raw:
        try:
            normalized = validate_email(raw, check_deliverability=False).normalized.casefold()
        except EmailNotValidError as exc:
            raise ValueError('Enter a valid email address or E.164 phone number') from exc
        return Identity('EMAIL', normalized)

    phone = re.sub(r'[\s().-]+', '', raw)
    if not re.fullmatch(r'\+[1-9]\d{7,14}', phone):
        raise ValueError('Phone must use E.164 format, for example +14155552671')
    return Identity('SMS', phone)


def identity_query(identity: Identity) -> dict:
    """Match normalized records and pre-migration legacy records."""
    return {'$or': [
        {identity.normalized_field: identity.value},
        {identity.legacy_field: identity.value},
    ]}


def identity_from_user(user: dict) -> Identity | None:
    primary = user.get('primary_identity')
    candidates = [primary, user.get('email_normalized'), user.get('email'),
                  user.get('phone_normalized'), user.get('phone')]
    for candidate in candidates:
        if not candidate:
            continue
        try:
            return normalize_identity(candidate)
        except ValueError:
            continue
    return None


def masked_destination(identity: Identity) -> str:
    if identity.channel == 'EMAIL':
        local, domain = identity.value.split('@', 1)
        shown = local[:1] + ('***' if len(local) > 1 else '*')
        return f'{shown}@{domain}'
    return f'{identity.value[:3]}******{identity.value[-2:]}'


def _pepper() -> bytes:
    configured = (os.environ.get('OTP_PEPPER') or '').strip()
    if configured:
        if _is_production() and len(configured) < 32:
            raise OtpConfigurationError('OTP_PEPPER must contain at least 32 characters')
        return configured.encode('utf-8')
    if _is_production():
        raise OtpConfigurationError('OTP_PEPPER is required in production')
    # Development-only fallback.  Production takes the fail-closed branch above.
    return (os.environ.get('JWT_SECRET') or 'chakri-development-otp-pepper').encode('utf-8')


def require_configured_pepper() -> None:
    """Require an explicit strong OTP secret before advertising registration.

    ``_pepper`` retains its development fallback for isolated legacy helpers,
    but a public registration capability must never be opened by that fallback.
    """
    configured = (os.environ.get('OTP_PEPPER') or '').strip()
    if len(configured) < 32:
        raise OtpConfigurationError(
            'OTP_PEPPER must be explicitly configured with at least 32 characters',
        )


def _hmac_hex(value: str) -> str:
    return hmac.new(_pepper(), value.encode('utf-8'), hashlib.sha256).hexdigest()


def _identity_hash(identity: Identity) -> str:
    return _hmac_hex(f'identity:v1:{identity.channel}:{identity.value}')


def _code_hash(challenge_id: str, purpose: str, code: str) -> str:
    return _hmac_hex(f'otp:v1:{challenge_id}:{purpose}:{code}')


def _new_code() -> str:
    return f'{secrets.randbelow(1_000_000):06d}'


async def ensure_indexes(*, database=None) -> None:
    if database is None:
        database = db
    await database.otp_challenges.create_index('id', unique=True)
    await database.otp_challenges.create_index('expires_at', expireAfterSeconds=0)
    await database.otp_challenges.create_index(
        [('identity_hash', 1), ('purpose', 1)],
        unique=True,
        partialFilterExpression={'active': True},
        name='one_active_otp_per_identity_purpose',
    )
    await database.otp_challenges.create_index(
        [('user_id', 1), ('purpose', 1), ('created_at', -1)]
    )
    await database.auth_rate_limits.create_index('expires_at', expireAfterSeconds=0)


async def ensure_identity_indexes(*, database=None) -> None:
    """Backfill normalized contacts, then install partial unique guards.

    Invalid legacy phone values are left untouched rather than making startup
    rewrite customer data it cannot safely interpret.  A normalized collision
    fails the unique-index build and is surfaced for operator reconciliation.
    """
    if database is None:
        database = db
    users = database.users.find(
        {},
        {
            '_id': 0, 'id': 1, 'email': 1, 'phone': 1,
            'email_normalized': 1, 'phone_normalized': 1,
            'role': 1, 'status': 1, 'registration_source': 1,
            'activation_mode': 1, 'manual_contact_reviewed': 1,
            'pending_email': 1, 'pending_phone': 1,
        },
    )
    async for user in users:
        legacy_manual_application = bool(
            user.get('role') == 'PLAYER'
            and user.get('status') in ('PENDING', 'REJECTED')
            and user.get('registration_source') == 'SELF_SERVICE'
            and user.get('activation_mode') == 'ADMIN_REVIEW'
            and user.get('manual_contact_reviewed') is not True
            and not (user.get('pending_email') and user.get('pending_phone'))
        )
        if legacy_manual_application and user.get('id'):
            try:
                email_identity = normalize_identity(
                    user.get('email_normalized') or user.get('email'),
                )
                phone_identity = normalize_identity(
                    user.get('phone_normalized') or user.get('phone'),
                )
                if email_identity.channel != 'EMAIL' or phone_identity.channel != 'SMS':
                    raise ValueError('Manual-review contacts use the wrong channels')
            except ValueError:
                # Invalid legacy data stays untouched and therefore cannot be
                # silently approved by the new manual-contact path.
                continue
            await database.users.update_one(
                {
                    'id': user['id'],
                    'status': user.get('status'),
                    'activation_mode': 'ADMIN_REVIEW',
                    'manual_contact_reviewed': {'$ne': True},
                },
                {
                    '$set': {
                        'email': f"application-{user['id']}@account.manual.invalid",
                        'pending_email': email_identity.value,
                        'pending_phone': phone_identity.value,
                    },
                    '$unset': {
                        'email_normalized': '', 'phone': '',
                        'phone_normalized': '', 'primary_identity': '',
                        'primary_identity_channel': '',
                    },
                },
            )
            continue

        updates = {}
        email = user.get('email')
        if email and not str(email).endswith('.phone.invalid') and not user.get('email_normalized'):
            try:
                updates['email_normalized'] = normalize_identity(email).value
            except ValueError:
                pass
        phone = user.get('phone')
        if phone and not user.get('phone_normalized'):
            try:
                normalized_phone = normalize_identity(phone)
                if normalized_phone.channel == 'SMS':
                    updates['phone_normalized'] = normalized_phone.value
            except ValueError:
                pass
        if updates and user.get('id'):
            await database.users.update_one({'id': user['id']}, {'$set': updates})

    await database.users.create_index(
        'email_normalized', unique=True,
        partialFilterExpression=_EMAIL_IDENTITY_PARTIAL,
        name=_EMAIL_IDENTITY_INDEX,
    )
    await database.users.create_index(
        'phone_normalized', unique=True,
        partialFilterExpression=_PHONE_IDENTITY_PARTIAL,
        name=_PHONE_IDENTITY_INDEX,
    )
    # Provisional contacts do not become login identities until approval, but
    # the review queue still needs database-enforced deduplication. Restricting
    # these guards to PENDING rows releases the contact after rejection and
    # avoids racing two simultaneous public submissions past a pre-read.
    await database.users.create_index(
        'pending_email', unique=True,
        partialFilterExpression=_PENDING_EMAIL_PARTIAL,
        name=_PENDING_EMAIL_INDEX,
    )
    await database.users.create_index(
        'pending_phone', unique=True,
        partialFilterExpression=_PENDING_PHONE_PARTIAL,
        name=_PENDING_PHONE_INDEX,
    )


def _index_matches(spec: dict | None, keys: list[tuple[str, int]], *,
                   unique=_INDEX_OPTION_UNSPECIFIED,
                   partial=_INDEX_OPTION_UNSPECIFIED,
                   ttl=_INDEX_OPTION_UNSPECIFIED,
                   sparse=_INDEX_OPTION_UNSPECIFIED) -> bool:
    if not spec or list(spec.get('key') or []) != keys:
        return False
    if (unique is not _INDEX_OPTION_UNSPECIFIED
            and bool(spec.get('unique', False)) is not unique):
        return False
    if (partial is not _INDEX_OPTION_UNSPECIFIED
            and spec.get('partialFilterExpression') != partial):
        return False
    if (ttl is not _INDEX_OPTION_UNSPECIFIED
            and spec.get('expireAfterSeconds') != ttl):
        return False
    if (sparse is not _INDEX_OPTION_UNSPECIFIED
            and bool(spec.get('sparse', False)) is not sparse):
        return False
    return True


def _has_matching_index(indexes: dict, keys: list[tuple[str, int]], **options) -> bool:
    return any(_index_matches(spec, keys, **options) for spec in indexes.values())


def _identity_indexes_valid(indexes: dict) -> bool:
    requirements = (
        (_EMAIL_IDENTITY_INDEX, [('email_normalized', 1)], _EMAIL_IDENTITY_PARTIAL),
        (_PHONE_IDENTITY_INDEX, [('phone_normalized', 1)], _PHONE_IDENTITY_PARTIAL),
        (_PENDING_EMAIL_INDEX, [('pending_email', 1)], _PENDING_EMAIL_PARTIAL),
        (_PENDING_PHONE_INDEX, [('pending_phone', 1)], _PENDING_PHONE_PARTIAL),
    )
    return all(
        _index_matches(indexes.get(name), keys, unique=True, partial=partial)
        for name, keys, partial in requirements
    )


def _otp_indexes_valid(challenges: dict, rate_limits: dict) -> bool:
    required_challenge_indexes = (
        (
            [('id', 1)],
            {'unique': True, 'partial': None, 'ttl': None, 'sparse': False},
        ),
        (
            [('expires_at', 1)],
            {'unique': False, 'partial': None, 'ttl': 0, 'sparse': False},
        ),
        (
            [('identity_hash', 1), ('purpose', 1)],
            {
                'unique': True, 'partial': {'active': True},
                'ttl': None, 'sparse': False,
            },
        ),
        (
            [('user_id', 1), ('purpose', 1), ('created_at', -1)],
            {'unique': False, 'partial': None, 'ttl': None, 'sparse': False},
        ),
    )
    return (
        all(
            _has_matching_index(challenges, keys, **options)
            for keys, options in required_challenge_indexes
        )
        and _has_matching_index(
            rate_limits, [('expires_at', 1)], unique=False, partial=None,
            ttl=0, sparse=False,
        )
    )


async def require_identity_indexes(*, database=None) -> None:
    """Fail registration closed unless normalized and review guards exist."""
    if database is None:
        database = db
    try:
        indexes = await database.users.index_information()
    except Exception as exc:
        raise OtpConfigurationError('Registration identity checks are unavailable') from exc
    if not _identity_indexes_valid(indexes):
        raise OtpConfigurationError('Registration identity checks are unavailable')


async def require_otp_indexes(*, database=None) -> None:
    """Validate every index relied on for one-use, expiry and rate limiting."""
    if database is None:
        database = db
    try:
        challenges = await database.otp_challenges.index_information()
        rate_limits = await database.auth_rate_limits.index_information()
    except Exception as exc:
        raise OtpConfigurationError('Verification storage checks are unavailable') from exc

    if not _otp_indexes_valid(challenges, rate_limits):
        raise OtpConfigurationError('Verification storage checks are unavailable')


def _allow_nontransactional_auth_tests() -> bool:
    return (
        (os.environ.get('APP_ENV') or '').strip().lower() == 'test'
        and (os.environ.get('AUTH_ALLOW_NON_TRANSACTIONAL_TESTS') or '').strip().lower() == 'true'
    )


async def require_registration_transactions(*, database=None) -> None:
    """Verify that Mongo can execute the OTP/account atomicity contract.

    Merely opening a session is insufficient: standalone Mongo deployments
    allow sessions but reject the first transactional statement.  The read is
    deliberately side-effect free and catches that deployment error before the
    public API advertises registration as available.
    """
    if database is None:
        database = db
    try:
        session_cm = await database.client.start_session()
        async with session_cm as session:
            async def probe(active_session):
                await database.users.find_one(
                    {'_id': '__registration_transaction_probe__'},
                    {'_id': 1},
                    session=active_session,
                )

            await session.with_transaction(probe)
    except Exception as exc:
        if _allow_nontransactional_auth_tests() and isinstance(
                exc, (AttributeError, NotImplementedError)):
            return
        raise OtpConfigurationError(
            'Registration transactions are unavailable',
        ) from exc


async def require_registration_readiness(*, database=None) -> None:
    """Fail closed unless secrets, indexes and transaction support are exact."""
    require_configured_pepper()
    await require_identity_indexes(database=database)
    await require_otp_indexes(database=database)
    await require_registration_transactions(database=database)


async def registration_storage_ready(*, database=None) -> bool:
    """Silent public-readiness predicate; detailed failures stay server-side."""
    try:
        await require_registration_readiness(database=database)
    except Exception:
        return False
    return True


async def consume_persistent_limit(action: str, subject: str, *, limit: int,
                                   window_seconds: int, database=None,
                                   now: datetime | None = None) -> None:
    """Consume one fixed-window allowance using Mongo's unique ``_id`` CAS."""
    if database is None:
        database = db
    now = now or _now()
    bucket = int(now.timestamp()) // window_seconds
    subject_hash = _hmac_hex(f'rate:v1:{action}:{subject}')
    key = f'{action}:{subject_hash}:{bucket}'
    try:
        await database.auth_rate_limits.find_one_and_update(
            {'_id': key, 'count': {'$lt': limit}},
            {
                '$inc': {'count': 1},
                '$setOnInsert': {
                    'action': action,
                    'subject_hash': subject_hash,
                    'window_started_at': datetime.fromtimestamp(
                        bucket * window_seconds, timezone.utc
                    ),
                    'expires_at': now + timedelta(seconds=window_seconds * 2),
                },
            },
            upsert=True,
            return_document=ReturnDocument.AFTER,
        )
    except DuplicateKeyError as exc:
        retry_after = window_seconds - (int(now.timestamp()) % window_seconds)
        raise OtpError(
            'RATE_LIMITED', 'Too many attempts. Please try again later.',
            status_code=429, retry_after=max(1, retry_after),
        ) from exc


class OtpDeliveryAdapter(Protocol):
    async def send(self, identity: Identity, code: str, purpose: str) -> dict: ...


class EmailOtpAdapter:
    async def send(self, identity: Identity, code: str, purpose: str) -> dict:
        if purpose == RESET_PASSWORD:
            return await EmailService.send_password_reset_code(identity.value, code)
        return await EmailService.send_verification_code(identity.value, code)


class TwilioSmsAdapter:
    async def send(self, identity: Identity, code: str, purpose: str) -> dict:
        sid = (os.environ.get('TWILIO_ACCOUNT_SID') or '').strip()
        token = (os.environ.get('TWILIO_AUTH_TOKEN') or '').strip()
        sender = (os.environ.get('TWILIO_FROM_NUMBER') or '').strip()
        if not sid or not token or not sender:
            return {'sent': False, 'provider': 'twilio', 'error': 'not_configured'}
        label = {
            RESET_PASSWORD: 'password reset',
            LOGIN_VERIFICATION: 'login verification',
        }.get(purpose, 'verification')
        payload = urllib.parse.urlencode({
            'To': identity.value,
            'From': sender,
            'Body': f'Your Chakri.Casino {label} code is {code}. It expires in 15 minutes.',
        }).encode('utf-8')
        auth = base64.b64encode(f'{sid}:{token}'.encode('utf-8')).decode('ascii')
        request = urllib.request.Request(
            f'https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json',
            data=payload,
            headers={'Authorization': f'Basic {auth}'},
            method='POST',
        )
        try:
            response = await asyncio.to_thread(urllib.request.urlopen, request, timeout=10)
            return {'sent': 200 <= response.status < 300, 'provider': 'twilio'}
        except Exception as exc:  # provider diagnostics only; never code/recipient
            logger.error('Twilio OTP delivery failed: %s', type(exc).__name__)
            return {'sent': False, 'provider': 'twilio', 'error': type(exc).__name__}


class TelesignSmsAdapter:
    """Deliver an application-generated OTP through Telesign SMS Verify."""

    VERIFY_SMS_URL = telesign_service.VERIFY_SMS_URL

    async def send(self, identity: Identity, code: str, purpose: str) -> dict:
        try:
            result = await telesign_service.send_verify_sms(
                identity.value, code, purpose,
            )
            return {
                'sent': True,
                'provider': 'telesign',
                'reference_id': result['reference_id'],
                'status_code': result['status_code'],
            }
        except telesign_service.TelesignServiceError as exc:
            # Metadata only: the code, key and recipient never enter logs.
            logger.error(
                'Telesign OTP delivery failed: reason=%s metadata=%s',
                exc.reason, exc.metadata,
            )
            return {'sent': False, 'provider': 'telesign', 'error': exc.reason}


class TelesignVerifyAdapter:
    """Deliver app-owned OTPs through Telesign's multi-channel Verify API."""

    async def send(self, identity: Identity, code: str, purpose: str) -> dict:
        method = 'email' if identity.channel == 'EMAIL' else 'sms'
        template = (os.environ.get('TELESIGN_VERIFY_TEMPLATE') or '').strip()
        try:
            result = await telesign_service.create_verification(
                identity.value, code, method=method,
                template_name=template or None,
            )
            return {
                'sent': True,
                'provider': 'telesign_verify',
                'reference_id': result['reference_id'],
                'status_code': result['status_code'],
            }
        except telesign_service.TelesignServiceError as exc:
            # Metadata only: the code, key and recipient never enter logs.
            logger.error(
                'Telesign Verify delivery failed: reason=%s metadata=%s',
                exc.reason, exc.metadata,
            )
            if telesign_service.verify_api_unavailable(exc):
                return await self._fallback_from_unprovisioned_verify(
                    identity, code, purpose, exc,
                )
            return {
                'sent': False,
                'provider': 'telesign_verify',
                'error': exc.reason,
            }

    async def _fallback_from_unprovisioned_verify(
        self, identity: Identity, code: str, purpose: str,
        original: telesign_service.TelesignServiceError,
    ) -> dict:
        """SMS Verify / email_service when Unified Verify is not on the account.

        401/3906 is 'Unified Verification Product not enabled for Customer ID'.
        Self-service Telesign accounts still have SMS Verify. Email uses a
        different provider when EMAIL_PROVIDER is configured.
        """
        if identity.channel == 'SMS':
            logger.warning(
                'Telesign Verify API is not enabled; retrying SMS Verify API',
            )
            try:
                result = await telesign_service.send_verify_sms(
                    identity.value, code, purpose,
                )
            except telesign_service.TelesignServiceError as exc:
                logger.error(
                    'Telesign SMS Verify fallback failed: reason=%s metadata=%s',
                    exc.reason, exc.metadata,
                )
                return {
                    'sent': False,
                    'provider': 'telesign',
                    'error': exc.reason,
                }
            return {
                'sent': True,
                'provider': 'telesign',
                'reference_id': result['reference_id'],
                'status_code': result['status_code'],
            }
        if identity.channel == 'EMAIL' and email_service_configured():
            logger.warning(
                'Telesign Verify API is not enabled; retrying email_service',
            )
            return await EmailOtpAdapter().send(identity, code, purpose)
        return {
            'sent': False,
            'provider': 'telesign_verify',
            'error': original.reason,
        }


class MockOtpAdapter:
    async def send(self, identity: Identity, code: str, purpose: str) -> dict:
        if _is_production():
            raise OtpConfigurationError('Mock OTP delivery is forbidden in production')
        return {'sent': True, 'provider': 'mock'}


class DisabledOtpAdapter:
    async def send(self, identity: Identity, code: str, purpose: str) -> dict:
        return {'sent': False, 'provider': 'disabled', 'error': 'not_configured'}


def delivery_adapter(channel: str) -> OtpDeliveryAdapter:
    setting = 'OTP_EMAIL_ADAPTER' if channel == 'EMAIL' else 'OTP_SMS_ADAPTER'
    default = 'email_service' if channel == 'EMAIL' else 'disabled'
    adapter = (os.environ.get(setting) or default).strip().lower()
    if adapter == 'mock':
        if _is_production():
            raise OtpConfigurationError('Mock OTP delivery is forbidden in production')
        return MockOtpAdapter()
    if channel == 'EMAIL' and adapter in {'email', 'email_service'}:
        return EmailOtpAdapter()
    if adapter in {'telesign_verify', 'telesign-verify'}:
        return TelesignVerifyAdapter()
    if channel == 'SMS' and adapter == 'twilio':
        return TwilioSmsAdapter()
    if channel == 'SMS' and adapter == 'telesign':
        return TelesignSmsAdapter()
    if adapter == 'disabled':
        return DisabledOtpAdapter()
    raise OtpConfigurationError(f'Unsupported {channel.lower()} OTP adapter')


def delivery_adapter_ready(channel: str) -> bool:
    """Return whether a contact channel has a usable global configuration.

    This is deliberately a channel-level capability rather than an
    identity-specific delivery probe, so it is safe to expose to registration
    clients without creating an account-enumeration oracle.
    """
    channel = str(channel or '').strip().upper()
    setting = 'OTP_EMAIL_ADAPTER' if channel == 'EMAIL' else 'OTP_SMS_ADAPTER'
    default = 'email_service' if channel == 'EMAIL' else 'disabled'
    adapter = (os.environ.get(setting) or default).strip().lower()

    if adapter == 'mock':
        return not _is_production()
    if adapter == 'disabled':
        return False
    if channel == 'EMAIL' and adapter in {'email', 'email_service'}:
        provider = (os.environ.get('EMAIL_PROVIDER') or 'disabled').strip().lower()
        if provider == 'resend':
            return bool((os.environ.get('RESEND_API_KEY') or '').strip()
                        and (os.environ.get('SENDER_EMAIL') or '').strip())
        if provider == 'sendgrid':
            return bool((os.environ.get('SENDGRID_API_KEY') or '').strip()
                        and (os.environ.get('SENDER_EMAIL') or '').strip())
        if provider == 'smtp':
            return all((os.environ.get(name) or '').strip() for name in (
                'SMTP_HOST', 'SMTP_USERNAME', 'SMTP_PASSWORD',
            ))
        return False
    if adapter in {'telesign_verify', 'telesign-verify'}:
        return all((os.environ.get(name) or '').strip() for name in (
            'TELESIGN_CUSTOMER_ID', 'TELESIGN_API_KEY',
        ))
    if channel == 'SMS' and adapter == 'twilio':
        return all((os.environ.get(name) or '').strip() for name in (
            'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER',
        ))
    if channel == 'SMS' and adapter == 'telesign':
        return all((os.environ.get(name) or '').strip() for name in (
            'TELESIGN_CUSTOMER_ID', 'TELESIGN_API_KEY',
        ))
    return False


def email_service_configured() -> bool:
    """True when a non-Telesign email provider can actually send mail."""
    provider = (os.environ.get('EMAIL_PROVIDER') or 'disabled').strip().lower()
    if provider == 'resend':
        return bool((os.environ.get('RESEND_API_KEY') or '').strip()
                    and (os.environ.get('SENDER_EMAIL') or '').strip())
    if provider == 'sendgrid':
        return bool((os.environ.get('SENDGRID_API_KEY') or '').strip()
                    and (os.environ.get('SENDER_EMAIL') or '').strip())
    if provider == 'smtp':
        return all((os.environ.get(name) or '').strip() for name in (
            'SMTP_HOST', 'SMTP_USERNAME', 'SMTP_PASSWORD',
        ))
    return False


async def report_delivery_completion(challenge: dict, code: str, *, database=None) -> None:
    """Best-effort provider completion reporting after the Mongo commit wins."""
    if database is None:
        database = db
    provider = str(challenge.get('delivery_provider') or '')
    reference = str(challenge.get('delivery_reference_id') or '')
    if not reference or provider not in {'telesign', 'telesign_verify'}:
        return
    try:
        if provider == 'telesign_verify':
            result = await telesign_service.finalize_verification(reference, code)
        else:
            result = await telesign_service.report_sms_completion(reference)
    except telesign_service.TelesignServiceError as exc:
        logger.warning('Telesign completion reporting failed: %s', exc.reason)
        await database.otp_challenges.update_one(
            {'id': challenge['id'], 'status': 'VERIFIED'},
            {'$set': {
                'provider_completion_status': 'FAILED',
                'provider_completion_updated_at': _now(),
            }},
        )
        return
    await database.otp_challenges.update_one(
        {'id': challenge['id'], 'status': 'VERIFIED'},
        {'$set': {
            'provider_completion_status': 'REPORTED',
            'provider_completion_code': result.get('status_code'),
            'provider_completion_updated_at': _now(),
        }},
    )


async def _restore_previous_challenge(database, previous: dict | None,
                                      now: datetime) -> None:
    """Best-effort restore when a replacement OTP could not be delivered."""
    if not previous or previous.get('status') != 'PENDING':
        return
    expires_at = _as_utc(previous.get('expires_at'))
    if not expires_at or expires_at <= now:
        return
    try:
        await database.otp_challenges.update_one(
            {'id': previous['id'], 'active': False, 'status': 'SUPERSEDED'},
            {'$set': {'active': True, 'status': 'PENDING', 'updated_at': _now()}},
        )
    except DuplicateKeyError:
        # Another request has already established a newer active challenge.
        logger.info('Previous OTP was not restored because a newer challenge is active')


async def issue_challenge(user: dict, identity: Identity, purpose: str, *,
                          database=None, now: datetime | None = None,
                          consume_limit: bool = True,
                          fallback_identity: Identity | None = None) -> dict:
    if database is None:
        database = db
    if purpose not in OTP_PURPOSES:
        raise ValueError('Unsupported OTP purpose')
    if not user or not user.get('id'):
        raise ValueError('A user is required for an OTP challenge')
    now = now or _now()
    identity_hash = _identity_hash(identity)
    if consume_limit:
        await consume_persistent_limit(
            f'otp_issue:{purpose}', f'{identity.channel}:{identity.value}',
            limit=OTP_ISSUE_LIMIT, window_seconds=OTP_ISSUE_WINDOW_SECONDS,
            database=database, now=now,
        )

    active = await database.otp_challenges.find_one({
        'identity_hash': identity_hash, 'purpose': purpose, 'active': True,
    })
    if active:
        cooldown = _as_utc(active.get('resend_not_before'))
        if cooldown and cooldown > now:
            retry_after = max(1, int((cooldown - now).total_seconds()) + 1)
            raise OtpError(
                'OTP_RESEND_COOLDOWN', 'Please wait before requesting another code.',
                status_code=429, retry_after=retry_after,
            )
        await database.otp_challenges.update_one(
            {'id': active['id'], 'active': True},
            {'$set': {'active': False, 'status': 'SUPERSEDED', 'updated_at': now}},
        )

    challenge_id = str(uuid.uuid4())
    code = _new_code()
    doc = {
        'id': challenge_id,
        'user_id': user['id'],
        'identity_hash': identity_hash,
        'channel': identity.channel,
        'purpose': purpose,
        'code_hash': _code_hash(challenge_id, purpose, code),
        'attempts': 0,
        'max_attempts': OTP_MAX_ATTEMPTS,
        'status': 'PENDING',
        'active': True,
        'created_at': now,
        'updated_at': now,
        'expires_at': now + timedelta(seconds=OTP_TTL_SECONDS),
        'resend_not_before': now + timedelta(seconds=OTP_RESEND_COOLDOWN_SECONDS),
    }
    try:
        await database.otp_challenges.insert_one(doc)
    except DuplicateKeyError as exc:
        raise OtpError(
            'OTP_RESEND_COOLDOWN', 'Please wait before requesting another code.',
            status_code=429, retry_after=OTP_RESEND_COOLDOWN_SECONDS,
        ) from exc

    try:
        delivery = await delivery_adapter(identity.channel).send(identity, code, purpose)
        if (
            not delivery.get('sent')
            and fallback_identity is not None
            and fallback_identity.value != identity.value
        ):
            try:
                fallback_delivery = await delivery_adapter(
                    fallback_identity.channel,
                ).send(fallback_identity, code, purpose)
            except OtpError:
                fallback_delivery = {'sent': False}
            except Exception as exc:
                logger.error('OTP fallback adapter failed: %s', type(exc).__name__)
                fallback_delivery = {'sent': False, 'error': type(exc).__name__}
            if fallback_delivery.get('sent'):
                delivery = fallback_delivery
    except OtpError:
        await database.otp_challenges.update_one(
            {'id': challenge_id, 'active': True},
            {'$set': {'active': False, 'status': 'DELIVERY_FAILED', 'updated_at': _now()}},
        )
        await _restore_previous_challenge(database, active, now)
        raise
    except Exception as exc:
        logger.error('OTP delivery adapter failed: %s', type(exc).__name__)
        delivery = {'sent': False, 'provider': 'unknown', 'error': type(exc).__name__}
    if not delivery.get('sent'):
        await database.otp_challenges.update_one(
            {'id': challenge_id, 'active': True},
            {'$set': {
                'active': False,
                'status': 'DELIVERY_FAILED',
                'delivery_provider': delivery.get('provider', 'unknown'),
                'updated_at': _now(),
            }},
        )
        await _restore_previous_challenge(database, active, now)
        raise OtpConfigurationError('Verification delivery is temporarily unavailable')

    delivery_recorded_at = _now()
    delivery_provider = delivery.get('provider', 'unknown')
    delivery_fields = {
        'delivery_provider': delivery_provider,
        'accepted_at': delivery_recorded_at,
        'updated_at': delivery_recorded_at,
    }
    initial_status_code = delivery.get('status_code')
    if type(initial_status_code) is int:
        delivery_fields['provider_initial_status_code'] = initial_status_code
    if delivery.get('reference_id'):
        delivery_fields['delivery_reference_id'] = delivery['reference_id']
    if delivery_provider != 'telesign' or initial_status_code == 200:
        delivery_fields['delivered_at'] = delivery_recorded_at
    await database.otp_challenges.update_one(
        {'id': challenge_id, 'active': True},
        {'$set': delivery_fields},
    )
    public_channel = 'PHONE' if identity.channel == 'SMS' else 'EMAIL'
    destination = masked_destination(identity)
    response = {
        'challenge_id': challenge_id,
        'verification_id': challenge_id,
        'channel': public_channel,
        'destination': destination,
        'destination_masked': destination,
        'expires_in': OTP_TTL_SECONDS,
        'expires_in_seconds': OTP_TTL_SECONDS,
        'resend_in': OTP_RESEND_COOLDOWN_SECONDS,
        'resend_after_seconds': OTP_RESEND_COOLDOWN_SECONDS,
    }
    if (delivery.get('provider') == 'mock'
            and not _is_production()
            and (os.environ.get('OTP_EXPOSE_DEV_CODE') or '').lower() == 'true'):
        response['dev_code'] = code
    return response


async def prepare_challenge_verification(
    identity: Identity, code: str, purpose: str, *,
    challenge_id: str | None = None, database=None,
    now: datetime | None = None,
) -> dict:
    """Validate one code without consuming a correct challenge yet.

    Invalid-attempt accounting intentionally happens before any account
    transaction so a rejected transaction cannot roll back the brute-force
    counter. A caller can then consume the returned challenge in the same Mongo
    transaction as its account mutation.
    """
    if database is None:
        database = db
    now = now or _now()
    identity_hash = _identity_hash(identity)
    await consume_persistent_limit(
        f'otp_verify:{purpose}', f'{identity.channel}:{identity.value}',
        limit=OTP_VERIFY_LIMIT, window_seconds=OTP_VERIFY_WINDOW_SECONDS,
        database=database, now=now,
    )
    query = {
        'identity_hash': identity_hash,
        'purpose': purpose,
        'active': True,
        'status': 'PENDING',
    }
    if challenge_id:
        query['id'] = challenge_id
    challenge = await database.otp_challenges.find_one(query, sort=[('created_at', -1)])
    if not challenge:
        raise OtpError('OTP_INVALID', 'The verification code is invalid or expired.')

    expires_at = _as_utc(challenge.get('expires_at'))
    if not expires_at or expires_at <= _as_utc(now):
        await database.otp_challenges.update_one(
            {'id': challenge['id'], 'active': True},
            {'$set': {'active': False, 'status': 'EXPIRED', 'updated_at': now}},
        )
        raise OtpError('OTP_INVALID', 'The verification code is invalid or expired.')

    supplied_hash = _code_hash(challenge['id'], purpose, str(code).strip())
    if not hmac.compare_digest(challenge.get('code_hash', ''), supplied_hash):
        result = await database.otp_challenges.update_one(
            {
                'id': challenge['id'], 'active': True, 'status': 'PENDING',
                'attempts': {'$lt': challenge.get('max_attempts', OTP_MAX_ATTEMPTS)},
            },
            {'$inc': {'attempts': 1}, '$set': {'updated_at': now}},
        )
        current = await database.otp_challenges.find_one({'id': challenge['id']})
        if result.modified_count == 0 or not current:
            raise OtpError('OTP_LOCKED', 'Too many invalid verification attempts.', status_code=423)
        if current.get('attempts', 0) >= current.get('max_attempts', OTP_MAX_ATTEMPTS):
            await database.otp_challenges.update_one(
                {'id': challenge['id'], 'active': True, 'status': 'PENDING'},
                {'$set': {'active': False, 'status': 'LOCKED', 'locked_at': now, 'updated_at': now}},
            )
            raise OtpError('OTP_LOCKED', 'Too many invalid verification attempts.', status_code=423)
        raise OtpError('OTP_INVALID', 'The verification code is invalid or expired.')

    return challenge


async def consume_prepared_challenge(
    challenge: dict, identity: Identity, code: str, purpose: str, *,
    database=None, now: datetime | None = None, session=None,
) -> dict:
    """CAS-consume a prepared challenge, optionally inside a caller transaction."""
    if database is None:
        database = db
    now = now or _now()
    identity_hash = _identity_hash(identity)
    supplied_hash = _code_hash(challenge['id'], purpose, str(code).strip())
    session_kwargs = {'session': session} if session is not None else {}
    result = await database.otp_challenges.update_one(
        {
            'id': challenge['id'],
            'identity_hash': identity_hash,
            'purpose': purpose,
            'code_hash': supplied_hash,
            'status': 'PENDING',
            'active': True,
            'attempts': {'$lt': challenge.get('max_attempts', OTP_MAX_ATTEMPTS)},
            'expires_at': {'$gt': now},
        },
        {'$set': {
            'status': 'VERIFIED', 'active': False,
            'verified_at': now, 'updated_at': now,
        }}, **session_kwargs,
    )
    if result.modified_count != 1:
        raise OtpError('OTP_INVALID', 'The verification code is invalid or expired.')
    return {
        **challenge,
        'status': 'VERIFIED',
        'active': False,
        'verified_at': now,
    }


async def verify_challenge(identity: Identity, code: str, purpose: str, *,
                           challenge_id: str | None = None, database=None,
                           now: datetime | None = None) -> dict:
    """Validate and one-use consume a challenge without an account mutation."""
    prepared = await prepare_challenge_verification(
        identity, code, purpose, challenge_id=challenge_id,
        database=database, now=now,
    )
    return await consume_prepared_challenge(
        prepared, identity, code, purpose, database=database, now=now,
    )
