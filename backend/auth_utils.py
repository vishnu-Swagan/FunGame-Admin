"""Auth helpers: bcrypt hashing, JWT tokens, FastAPI dependencies."""
import logging
import os
import bcrypt
import jwt
from datetime import datetime, timezone, timedelta
from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pymongo import ReturnDocument
from avatar_service import legacy_avatar_upgrade_fields
from db import db
import compliance

JWT_ALG = 'HS256'
ACCESS_TOKEN_DAYS = 7

security = HTTPBearer(auto_error=False)
logger = logging.getLogger('auth')


def _real_money_enabled() -> bool:
    return (os.environ.get('REAL_MONEY_ENABLED') or 'false').strip().lower() == 'true'


def _legacy_chip_requests_enabled() -> bool:
    """Return the explicit rollout state for the retired request workflow.

    Missing, malformed and empty values all remain disabled.  This is kept
    separate from ``REAL_MONEY_ENABLED`` so a dormant financial rollout can
    never accidentally re-expose the historical manual-credit endpoints.
    """
    return (
        os.environ.get('LEGACY_CHIP_REQUESTS_ENABLED') or 'false'
    ).strip().lower() == 'true'


def require_legacy_chip_mutation_allowed() -> None:
    """Keep legacy play-chip workflows away from a source-separated wallet.

    BUY/SELL/RETURN and points conversion mutate only the historical aggregate
    ledger. They must remain unavailable once real-money mode is enabled until
    they are transactionally integrated as explicit non-withdrawable bonus
    movements.
    """
    if _real_money_enabled():
        raise HTTPException(status_code=409, detail={
            'code': 'LEGACY_CHIP_FLOW_DISABLED',
            'message': 'This legacy chip operation is unavailable in real-money mode.',
        })


def require_legacy_chip_requests_enabled() -> None:
    """Fail closed for legacy request creation and operator resolution.

    Historical request reads remain available for audit, but every action that
    can create, approve or deny one requires the source-controlled rollout flag
    as well as the existing real-money separation guard.
    """
    if not _legacy_chip_requests_enabled():
        raise HTTPException(status_code=409, detail={
            'code': 'LEGACY_CHIP_REQUESTS_DISABLED',
            'message': 'Legacy promotional balance requests are unavailable.',
        })
    require_legacy_chip_mutation_allowed()


def _financial_gameplay_gate(user: dict) -> None:
    """Apply launch-only age, KYC and jurisdiction gates to every game route.

    Existing play-chip operation is intentionally unchanged. Once real-money
    mode is explicitly enabled, this central dependency fails closed using the
    same eligibility contract as the financial routes.
    """
    if not _real_money_enabled():
        return
    if str(user.get('financial_status') or '').upper() in {
            'BLOCKED', 'FROZEN', 'REVIEW_REQUIRED'}:
        raise HTTPException(status_code=403, detail={
            'code': 'FINANCIAL_ACCOUNT_RESTRICTED',
            'message': 'Gameplay is restricted while this account is under financial review.',
        })
    # A one-tap 18+ self-attestation (accepted_terms) or an explicit operator
    # age flag satisfies age. compliance.assert_playable already runs before this
    # gate and refuses an actual under-minimum date of birth, so self-attest here
    # cannot let a real minor into real-money play.
    if not (user.get('age_verified') or user.get('accepted_terms')):
        raise HTTPException(status_code=403, detail={
            'code': 'AGE_NOT_VERIFIED',
            'message': 'Please confirm you are at least 18 to continue.',
        })
    if str(user.get('kyc_status') or '').upper() != 'VERIFIED':
        raise HTTPException(status_code=403, detail={
            'code': 'KYC_REQUIRED',
            'message': 'Identity verification is required.',
        })
    country = compliance.normalise_country(user.get('country'))
    allowed = {
        item.strip().upper()
        for item in (os.environ.get('FINANCIAL_ALLOWED_COUNTRIES') or '').split(',')
        if item.strip()
    }
    if not country or country not in allowed:
        raise HTTPException(status_code=403, detail={
            'code': 'FINANCIAL_MARKET_BLOCKED',
            'message': 'Gameplay is unavailable in your registered country.',
        })


def _jwt_secret() -> str:
    configured = (os.environ.get('JWT_SECRET') or '').strip()
    production = (os.environ.get('APP_ENV') or '').strip().lower() in ('prod', 'production')
    if production and (
            configured == 'chakri-dev-secret-change-me'
            or len(configured.encode('utf-8')) < 32):
        raise RuntimeError('JWT_SECRET must contain at least 32 bytes in production')
    return configured or 'chakri-dev-secret-change-me'


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')


def verify_password(password: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode('utf-8'), hashed.encode('utf-8'))
    except Exception:
        return False


def public_user(user: dict) -> dict:
    """Return the signed-in user's safe client projection.

    Keep this shared by login, ``/auth/me`` and onboarding polling so adding a
    new internal identity or provisioning field cannot accidentally make one
    of those responses broader than the others.
    """
    # Import lazily: several isolated engine/financial suites intentionally
    # replace the ``db`` module with a minimal test double that only supplies
    # the database handle and never exercises response serialization.
    from db import serialize_doc
    public = serialize_doc(user)
    for key in (
        'active_session_id', 'email_normalized', 'phone_normalized',
        'username_key', 'previous_email', 'password_failed_attempts',
        'locked_until', 'telesign_onboarding', 'telesign_last_sign_in',
        'password_provisioned_at', 'password_provisioned_by',
        'created_by', 'provisioned_by', 'approved_by', 'reviewed_by',
        'updated_by', 'admin_note', 'disabled_by_distributor_status',
        'age_verification_requested_by', 'age_verification_request_note',
        'mobile_verification_requested_by', 'mobile_verification_request_note',
        'mobile_reviewed_by', 'mobile_review_note', 'mobile_review_phone_snapshot',
        'admin_step_up_password_verified_at', 'admin_step_up_session_id',
        'mfa_verified_at', 'reauthenticated_at', 'admin_step_up_completed_at',
        'login_otp_bypass_once', 'password_reset_by_admin_id',
    ):
        public.pop(key, None)
    # Phone registrations and provisional manual applications carry unique
    # compatibility addresses for the legacy non-sparse email index. They are
    # never presented as user data.
    if str(public.get('email') or '').endswith(('.phone.invalid', '.manual.invalid')):
        public['email'] = None
    return public


def create_access_token(user_id: str, role: str, session_id: str = None) -> str:
    payload = {
        'sub': user_id,
        'role': role,
        'iat': datetime.now(timezone.utc),
        'exp': datetime.now(timezone.utc) + timedelta(days=ACCESS_TOKEN_DAYS),
    }
    if session_id:
        payload['sid'] = session_id
    return jwt.encode(payload, _jwt_secret(), algorithm=JWT_ALG)


async def get_current_user(credentials: HTTPAuthorizationCredentials = Depends(security)):
    if credentials is None:
        raise HTTPException(status_code=401, detail='Not authenticated')
    token = credentials.credentials
    try:
        payload = jwt.decode(token, _jwt_secret(), algorithms=[JWT_ALG])
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail='Session expired. Please log in again.')
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail='Invalid session token')
    user = await db.users.find_one({'id': payload.get('sub')})
    if not user:
        raise HTTPException(status_code=401, detail='User not found')
    # Single active session per user: a newer login replaces the previous session.
    active_sid = user.get('active_session_id')
    if active_sid and payload.get('sid') != active_sid:
        raise HTTPException(status_code=401, detail={
            'code': 'SESSION_REPLACED',
            'message': 'You were signed out because this Login ID was used on another device.',
        })
    return await maybe_upgrade_legacy_avatar(user)


async def maybe_upgrade_legacy_avatar(user: dict) -> dict:
    """Best-effort, race-safe migration of retired symbolic player avatars."""
    avatar_upgrade = legacy_avatar_upgrade_fields(user)
    if avatar_upgrade:
        # Compare-and-set guards ensure a concurrent personal upload or preset
        # selection always wins over this one-time compatibility migration.
        try:
            upgraded = await db.users.find_one_and_update(
                {
                    'id': user['id'],
                    'role': 'PLAYER',
                    'avatar': user.get('avatar'),
                    'avatar_source': {'$ne': 'UPLOAD'},
                    'avatar_upload_id': {'$in': [None, '']},
                    'avatar_url': {'$in': [None, '']},
                },
                {'$set': avatar_upgrade},
                return_document=ReturnDocument.AFTER,
            )
            if upgraded:
                return upgraded
            # A profile mutation won the compare-and-set; reflect its current
            # choice instead of returning the stale legacy snapshot.
            latest = await db.users.find_one({'id': user['id']})
            if latest:
                return latest
        except Exception as exc:  # migration must never turn a valid token into an outage
            logger.warning(
                'Deferred legacy avatar upgrade for %s: %s',
                user['id'], type(exc).__name__,
            )
    return user


async def require_admin(user: dict = Depends(get_current_user)):
    if user.get('role') != 'ADMIN':
        raise HTTPException(status_code=403, detail='Admin access required')
    if user.get('status') != 'ACTIVE':
        raise HTTPException(status_code=403, detail='Administrator access is disabled')
    return user


def _parse_security_time(value):
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    except (TypeError, ValueError):
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def require_recent_admin_step_up(admin: dict) -> None:
    """Require server-recorded 2FA and password re-auth for trust decisions."""
    if admin.get('mfa_enabled') is not True:
        raise HTTPException(status_code=403, detail={
            'code': 'ADMIN_MFA_REQUIRED',
            'message': 'Administrator 2FA enrollment and verification are required.',
        })
    try:
        seconds = max(
            60,
            min(int(os.environ.get('ADMIN_FINANCIAL_STEP_UP_SECONDS', '300')), 900),
        )
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=503, detail={
            'code': 'ADMIN_AUTH_NOT_READY',
            'message': 'Administrator step-up verification is unavailable.',
        }) from exc
    current = datetime.now(timezone.utc)
    if (
        not admin.get('active_session_id')
        or admin.get('admin_step_up_session_id') != admin.get('active_session_id')
    ):
        raise HTTPException(status_code=403, detail={
            'code': 'ADMIN_STEP_UP_REQUIRED',
            'message': 'Complete administrator verification in this signed-in session.',
        })
    mfa_at = _parse_security_time(admin.get('mfa_verified_at'))
    reauth_at = _parse_security_time(admin.get('reauthenticated_at'))
    mfa_age = (current - mfa_at).total_seconds() if mfa_at else None
    reauth_age = (current - reauth_at).total_seconds() if reauth_at else None
    if (
        mfa_age is None
        or reauth_age is None
        or not 0 <= mfa_age <= seconds
        or not 0 <= reauth_age <= seconds
    ):
        raise HTTPException(status_code=403, detail={
            'code': 'ADMIN_STEP_UP_REQUIRED',
            'message': 'Recent password re-authentication and 2FA verification are required.',
        })


async def require_distributor(user: dict = Depends(get_current_user)):
    """A partner-portal session, and the distributor it speaks for.

    Resolved from `distributors.user_id` rather than from anything on the token,
    so suspending a distributor closes their portal on the next request instead
    of when their week-old JWT happens to expire.

    Returns both halves because every route in the portal needs the distributor
    id to scope its query, and a route that had to look it up again would be one
    route away from forgetting to.
    """
    if user.get('role') != 'DISTRIBUTOR':
        raise HTTPException(status_code=403, detail='Partner portal access required')
    dist = await db.distributors.find_one({'user_id': user['id']}, {'_id': 0})
    if not dist:
        raise HTTPException(status_code=403, detail='This login is not linked to a distributor account')
    if user.get('status') != 'ACTIVE':
        raise HTTPException(status_code=403, detail={
            'code': 'DISTRIBUTOR_LOGIN_DISABLED',
            'message': 'This partner login is disabled. Please contact the operator.',
        })
    if dist.get('status') != 'ACTIVE':
        state = str(dist.get('status') or 'DISABLED').upper()
        raise HTTPException(status_code=403, detail={
            'code': f'DISTRIBUTOR_{state}',
            'message': f'Your partner account is {state.lower()}. Please contact the operator.',
        })
    if user.get('password_change_required'):
        raise HTTPException(status_code=403, detail={
            'code': 'PASSWORD_CHANGE_REQUIRED',
            'message': 'Change the temporary password before opening the partner portal.',
            'change_password_url': '/auth/change-password',
        })
    return {'user': user, 'distributor': dist}


async def require_password_ready_user(user: dict = Depends(get_current_user)):
    """Block temporary credentials from every non-auth route until reset.

    `/auth/me`, `/auth/change-password` and `/auth/logout` intentionally keep
    using `get_current_user` directly; every shared signed-in application route
    uses this dependency so a temporary credential cannot read or mutate data.
    """
    if user.get('role') in {'PLAYER', 'DISTRIBUTOR'} and user.get('password_change_required'):
        raise HTTPException(status_code=403, detail={
            'code': 'PASSWORD_CHANGE_REQUIRED',
            'message': 'Change the temporary password before continuing.',
            'change_password_url': '/auth/change-password',
        })
    return user


async def check_maintenance_for_players(user: dict):
    """Raise 503 when maintenance is on for non-admin users."""
    if user.get('role') == 'ADMIN':
        return
    cfg = await db.system_config.find_one({'key': 'main'})
    if cfg and cfg.get('maintenance_mode'):
        raise HTTPException(status_code=503, detail={'code': 'MAINTENANCE', 'message': cfg.get('maintenance_message') or 'Chakri.Casino is under maintenance.'})


async def require_active_player(user: dict = Depends(get_current_user)):
    """App-area dependency: user must be ACTIVE (approved) and not in maintenance."""
    await check_maintenance_for_players(user)
    if user.get('role') == 'ADMIN':
        return user
    # A distributor login is ACTIVE by construction, so without this it would
    # pass every check below and reach the games, the wallet and the chip
    # requests. Commission money and player money must not meet in one account.
    if user.get('role') == 'DISTRIBUTOR':
        raise HTTPException(status_code=403, detail={
            'code': 'NOT_A_PLAYER',
            'message': 'Partner logins cannot play. Sign in to the partner portal instead.',
        })
    await require_password_ready_user(user)
    if user.get('status') == 'SUSPENDED':
        raise HTTPException(status_code=403, detail={'code': 'SUSPENDED', 'message': 'Your account is suspended. Contact support.'})
    if user.get('status') == 'REJECTED':
        raise HTTPException(status_code=403, detail={'code': 'REJECTED', 'message': 'Your onboarding was rejected.'})
    if user.get('status') != 'ACTIVE':
        raise HTTPException(status_code=403, detail={'code': 'NOT_APPROVED', 'message': 'Your account is pending approval.'})
    # Self-exclusion, market and age. Last, so a player who is excluded is told
    # that rather than something less specific about their account status.
    await compliance.assert_playable(user)
    _financial_gameplay_gate(user)
    return user
