"""Authentication routes with email/mobile identities and one-use OTPs."""
import logging
import re
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError

from db import db, serialize_doc
import crm
import compliance
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
    verify_password,
)
from otp_service import (
    OtpConfigurationError,
    OtpError,
    RESET_PASSWORD,
    VERIFY_CONTACT,
    Identity,
    consume_persistent_limit,
    delivery_adapter_ready,
    identity_query,
    issue_challenge,
    masked_destination,
    normalize_identity,
    require_identity_indexes,
    verify_challenge,
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


def _user_public(user: dict) -> dict:
    public = serialize_doc(user)
    for key in (
        'active_session_id', 'email_normalized', 'phone_normalized',
        'previous_email', 'password_failed_attempts', 'locked_until',
    ):
        public.pop(key, None)
    # Phone registrations carry a unique compatibility address because older
    # routes still expect an email key.  It is never presented as user data.
    if str(public.get('email') or '').endswith('.phone.invalid'):
        public['email'] = None
    return public


async def _find_identity_user(identity: Identity):
    return await db.users.find_one(identity_query(identity))


def _identity_is_verified(user: dict, identity: Identity) -> bool:
    # KYC/identity verification is a separate financial control.  Only the
    # channel-specific OTP flag proves ownership of this contact method.
    return bool(user.get(identity.verified_field))


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
    email_ready = delivery_adapter_ready('EMAIL')
    phone_ready = delivery_adapter_ready('SMS')
    return {
        'registration_enabled': email_ready or phone_ready,
        'email_registration': email_ready,
        'phone_registration': phone_ready,
        'email_password_reset': email_ready,
        'phone_password_reset': phone_ready,
    }


@router.post('/register', status_code=status.HTTP_202_ACCEPTED)
async def register(body: RegisterRequest):
    """Create a pending player account with an email or E.164 phone login."""
    identity = _request_identity(body)
    try:
        await require_identity_indexes()
    except OtpConfigurationError as exc:
        _raise_otp(exc)
    # Availability is global per channel and is checked before any existence
    # lookup, so a disabled provider produces the same response for every
    # contact. Runtime provider failures remain opaque below.
    if not delivery_adapter_ready(identity.channel):
        _raise_otp(OtpConfigurationError('Requested OTP channel is not configured'))
    if body.date_of_birth or body.country:
        ok, code, message = await compliance.check_eligibility(
            body.country, body.date_of_birth, require_dob=False,
        )
        if not ok:
            raise HTTPException(status_code=403, detail={'code': code, 'message': message})

    # Do the expensive password work before the existence check so response
    # timing does not become a practical account-enumeration side channel.
    # Match the bcrypt cost of a new registration, but do not persist a
    # caller-chosen password before contact ownership has been proved. The
    # verifier commits their password atomically with the OTP below.
    hash_password(body.password)
    existing = await _find_identity_user(identity)
    if existing:
        # Registration is never a resend endpoint. Returning the same opaque
        # success for verified and unverified accounts prevents the active OTP
        # cooldown (or delivery state) from revealing account state.
        return {'message': GENERIC_REGISTER_MESSAGE, **_dummy_challenge(identity)}

    user_id = str(uuid.uuid4())
    user = {
        'id': user_id,
        'role': 'PLAYER',
        'status': 'PENDING',
        'registration_source': 'SELF_SERVICE',
        'primary_identity': identity.value,
        'primary_identity_channel': 'PHONE' if identity.channel == 'SMS' else 'EMAIL',
        # Reserved for the later KYC workflow; contact OTP never changes it.
        'identity_verified': False,
        'email_verified': False,
        'phone_verified': False,
        'display_name': (body.full_name or '').strip() or None,
        'full_name': (body.full_name or '').strip() or None,
        'country': (body.country or '').strip() or None,
        'date_of_birth': body.date_of_birth,
        'avatar': 'star',
        'chip_balance': 0,
        'points_balance': 0,
        'favorites': [],
        'recent_games': [],
        'settings': {
            'sound_enabled': True, 'music_enabled': True,
            'haptics_enabled': True, 'reduced_motion': False,
            'high_contrast': False,
        },
        'accepted_terms': False,
        'created_at': _now().isoformat(),
    }
    if identity.channel == 'EMAIL':
        user['email'] = identity.value
        user['email_normalized'] = identity.value
        user['phone'] = None
    else:
        user['phone'] = identity.value
        user['phone_normalized'] = identity.value
        # Compatibility for legacy player/support serializers that still index
        # into ``email``.  It is unique, non-routable and hidden publicly.
        user['email'] = f'phone-{user_id}@account.phone.invalid'

    try:
        await db.users.insert_one(user)
    except DuplicateKeyError:
        # A concurrent registration won the unique normalized-identity race.
        # Do not branch on its verification/challenge state publicly.
        return {'message': GENERIC_REGISTER_MESSAGE, **_dummy_challenge(identity)}

    try:
        await crm.attribute_user(user['id'], None, actor='self-registration')
    except Exception as exc:  # attribution must not orphan an otherwise valid login
        logger.warning('Registration attribution deferred: %s', type(exc).__name__)

    try:
        challenge = await issue_challenge(user, identity, VERIFY_CONTACT)
    except OtpError as exc:
        # The pending account remains recoverable through resend when the
        # provider returns. Never reveal that insertion happened by returning
        # a different status from the existing-account branch.
        logger.warning('Initial contact challenge not issued: %s', exc.code)
        challenge = _dummy_challenge(identity)
    return {'message': GENERIC_REGISTER_MESSAGE, **challenge}


@router.post('/signup-request')
async def signup_request(body: SignupRequestCreate):
    """Legacy admin-review request retained for already deployed clients."""
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
    verifier_password_hash = hash_password(body.password)
    try:
        verified = await verify_challenge(
            identity, body.code.strip(), VERIFY_CONTACT,
            challenge_id=_challenge_id(body),
        )
    except OtpError as exc:
        _raise_public_code_error(exc, 'The verification code is invalid or expired.')
    user = await _find_identity_user(identity)
    if (not user or user.get('role') != 'PLAYER'
            or _identity_is_verified(user, identity)
            or verified.get('user_id') != user.get('id')):
        _raise_otp(OtpError('OTP_INVALID', 'The verification code is invalid or expired.'))

    contact_field = identity.verified_field
    verified_at = _now().isoformat()
    updates = {
        contact_field: True,
        'contact_verified': True,
        'contact_verified_at': verified_at,
        'primary_identity': identity.value,
        'primary_identity_channel': 'PHONE' if identity.channel == 'SMS' else 'EMAIL',
        'password_hash': verifier_password_hash,
        'password_set_at': verified_at,
        'password_failed_attempts': 0,
    }
    result = await db.users.update_one({
        'id': user['id'], contact_field: {'$ne': True},
    }, {
        '$set': updates,
        '$unset': {
            'verification_code_hash': '', 'verification_expires_at': '',
            'locked_until': '',
        },
    })
    if result.modified_count != 1:
        _raise_otp(OtpError('OTP_INVALID', 'The verification code is invalid or expired.'))
    session_id = str(uuid.uuid4())
    await db.users.update_one(
        {'id': user['id']}, {'$set': {'active_session_id': session_id}}
    )
    user = await db.users.find_one({'id': user['id']})
    token = create_access_token(user['id'], user['role'], session_id=session_id)
    return {
        'message': 'Contact verified. Your account is pending operator review.',
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
    try:
        challenge = await issue_challenge(
            user, identity, VERIFY_CONTACT, consume_limit=False,
        )
    except OtpError as exc:
        # Cooldown/provider state also identifies a real unverified account.
        # The original code remains valid; return the same opaque 202 shape.
        logger.warning('Contact resend challenge not issued: %s', exc.code)
        challenge = _dummy_challenge(identity)
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
    password_ok = verify_password(
        body.password,
        user.get('password_hash', DUMMY_PASSWORD_HASH) if user else DUMMY_PASSWORD_HASH,
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
    if not user or not password_ok:
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
    if user.get('role') == 'PLAYER':
        primary = contact_identity
        if primary is None:
            try:
                primary = normalize_identity(user.get('primary_identity') or user.get('email'))
            except ValueError:
                primary = None
        verified = bool(primary and _identity_is_verified(user, primary))
        if not verified:
            channel = (
                'PHONE' if primary and primary.channel == 'SMS' else 'EMAIL'
            )
            raise HTTPException(status_code=403, detail={
                'code': 'CONTACT_NOT_VERIFIED',
                'message': 'Verify your contact method before logging in.',
                'channel': channel,
            })

    session_id = str(uuid.uuid4())
    await db.users.update_one({'id': user['id']}, {'$set': {
        'active_session_id': session_id,
        'last_login_at': _now().isoformat(),
        'password_failed_attempts': 0,
    }, '$unset': {'locked_until': ''}})
    token = create_access_token(user['id'], user['role'], session_id=session_id)
    user['active_session_id'] = session_id
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
    try:
        verified = await verify_challenge(
            identity, body.code.strip(), RESET_PASSWORD,
            challenge_id=_challenge_id(body),
        )
    except OtpError as exc:
        _raise_public_code_error(exc, 'The reset request is invalid or expired.')
    user = await _find_identity_user(identity)
    if (not user or user.get('role') != 'PLAYER'
            or not _identity_is_verified(user, identity)
            or verified.get('user_id') != user.get('id')):
        _raise_otp(OtpError('OTP_INVALID', 'The reset request is invalid or expired.'))
    await db.users.update_one({'id': user['id']}, {
        '$set': {
            'password_hash': hash_password(body.new_password),
            'password_changed_at': _now().isoformat(),
            'active_session_id': f'revoked-{uuid.uuid4()}',
            'password_failed_attempts': 0,
        },
        '$unset': {
            'reset_code_hash': '', 'reset_expires_at': '', 'locked_until': '',
        },
    })
    return {'message': 'Password reset. Please log in with your new password.'}


@router.post('/change-password')
async def change_password(body: ChangePasswordRequest, user: dict = Depends(get_current_user)):
    if not verify_password(body.current_password, user.get('password_hash', '')):
        raise HTTPException(status_code=400, detail='Current password is incorrect')
    await db.users.update_one({'id': user['id']}, {'$set': {
        'password_hash': hash_password(body.new_password),
        'password_changed_at': _now().isoformat(),
        'active_session_id': f'revoked-{uuid.uuid4()}',
    }})
    return {'message': 'Password changed successfully. Please log in again.'}


@router.get('/me')
async def me(user: dict = Depends(get_current_user)):
    return {'user': _user_public(user)}
