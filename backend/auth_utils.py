"""Auth helpers: bcrypt hashing, JWT tokens, FastAPI dependencies."""
import os
import bcrypt
import jwt
from datetime import datetime, timezone, timedelta
from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from db import db
import compliance

JWT_SECRET = os.environ.get('JWT_SECRET', 'chakri-dev-secret-change-me')
JWT_ALG = 'HS256'
ACCESS_TOKEN_DAYS = 7

security = HTTPBearer(auto_error=False)


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')


def verify_password(password: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode('utf-8'), hashed.encode('utf-8'))
    except Exception:
        return False


def create_access_token(user_id: str, role: str, session_id: str = None) -> str:
    payload = {
        'sub': user_id,
        'role': role,
        'iat': datetime.now(timezone.utc),
        'exp': datetime.now(timezone.utc) + timedelta(days=ACCESS_TOKEN_DAYS),
    }
    if session_id:
        payload['sid'] = session_id
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALG)


async def get_current_user(credentials: HTTPAuthorizationCredentials = Depends(security)):
    if credentials is None:
        raise HTTPException(status_code=401, detail='Not authenticated')
    token = credentials.credentials
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALG])
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail='Session expired. Please log in again.')
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail='Invalid session token')
    user = await db.users.find_one({'id': payload.get('sub')})
    if not user:
        raise HTTPException(status_code=401, detail='User not found')
    if user.get('role') == 'ADMIN' and user.get('status') != 'ACTIVE':
        raise HTTPException(status_code=403, detail='Administrator access is disabled')
    # Single active session per user: a newer login replaces the previous session.
    active_sid = user.get('active_session_id')
    if active_sid and payload.get('sid') != active_sid:
        raise HTTPException(status_code=401, detail={
            'code': 'SESSION_REPLACED',
            'message': 'You were signed out because this Login ID was used on another device.',
        })
    return user


async def require_admin(user: dict = Depends(get_current_user)):
    if user.get('role') != 'ADMIN':
        raise HTTPException(status_code=403, detail='Admin access required')
    return user


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
    if dist.get('status') != 'ACTIVE':
        raise HTTPException(status_code=403, detail={
            'code': 'DISTRIBUTOR_SUSPENDED',
            'message': 'Your partner account is suspended. Please contact the operator.',
        })
    return {'user': user, 'distributor': dist}


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
    if user.get('status') == 'SUSPENDED':
        raise HTTPException(status_code=403, detail={'code': 'SUSPENDED', 'message': 'Your account is suspended. Contact support.'})
    if user.get('status') == 'REJECTED':
        raise HTTPException(status_code=403, detail={'code': 'REJECTED', 'message': 'Your onboarding was rejected.'})
    if user.get('status') != 'ACTIVE':
        raise HTTPException(status_code=403, detail={'code': 'NOT_APPROVED', 'message': 'Your account is pending approval.'})
    # Self-exclusion, market and age. Last, so a player who is excluded is told
    # that rather than something less specific about their account status.
    await compliance.assert_playable(user)
    return user
