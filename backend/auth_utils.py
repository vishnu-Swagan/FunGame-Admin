"""Auth helpers: bcrypt hashing, JWT tokens, FastAPI dependencies."""
import os
import bcrypt
import jwt
from datetime import datetime, timezone, timedelta
from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from db import db

JWT_SECRET = os.environ.get('JWT_SECRET', 'fungame-dev-secret-change-me')
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


def create_access_token(user_id: str, role: str) -> str:
    payload = {
        'sub': user_id,
        'role': role,
        'iat': datetime.now(timezone.utc),
        'exp': datetime.now(timezone.utc) + timedelta(days=ACCESS_TOKEN_DAYS),
    }
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
    return user


async def require_admin(user: dict = Depends(get_current_user)):
    if user.get('role') != 'ADMIN':
        raise HTTPException(status_code=403, detail='Admin access required')
    return user


async def check_maintenance_for_players(user: dict):
    """Raise 503 when maintenance is on for non-admin users."""
    if user.get('role') == 'ADMIN':
        return
    cfg = await db.system_config.find_one({'key': 'main'})
    if cfg and cfg.get('maintenance_mode'):
        raise HTTPException(status_code=503, detail={'code': 'MAINTENANCE', 'message': cfg.get('maintenance_message') or 'FunGame is under maintenance.'})


async def require_active_player(user: dict = Depends(get_current_user)):
    """App-area dependency: user must be ACTIVE (approved) and not in maintenance."""
    await check_maintenance_for_players(user)
    if user.get('role') == 'ADMIN':
        return user
    if user.get('status') == 'SUSPENDED':
        raise HTTPException(status_code=403, detail={'code': 'SUSPENDED', 'message': 'Your account is suspended. Contact support.'})
    if user.get('status') == 'REJECTED':
        raise HTTPException(status_code=403, detail={'code': 'REJECTED', 'message': 'Your onboarding was rejected.'})
    if user.get('status') != 'ACTIVE':
        raise HTTPException(status_code=403, detail={'code': 'NOT_APPROVED', 'message': 'Your account is pending approval.'})
    return user
