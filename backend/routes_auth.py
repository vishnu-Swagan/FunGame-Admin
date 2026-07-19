"""Auth routes: register, verify-email, login, forgot/reset password."""
import uuid
import random
import hashlib
import logging
from datetime import datetime, timezone, timedelta
from fastapi import APIRouter, HTTPException, Depends
from db import db, serialize_doc
from models import (RegisterRequest, VerifyEmailRequest, ResendVerificationRequest,
                    LoginRequest, ForgotPasswordRequest, ResetPasswordRequest, ChangePasswordRequest,
                    SignupRequestCreate)
from auth_utils import hash_password, verify_password, create_access_token, get_current_user
from email_service import EmailService, is_dev_mode

logger = logging.getLogger('auth')
router = APIRouter(prefix='/auth', tags=['auth'])

CODE_TTL_MINUTES = 15


def _gen_code() -> str:
    return f"{random.randint(0, 999999):06d}"


def _hash_code(code: str) -> str:
    return hashlib.sha256(code.encode()).hexdigest()


def _now():
    return datetime.now(timezone.utc)


def _user_public(user: dict) -> dict:
    u = serialize_doc(user)
    return u


@router.post('/register')
async def register(body: RegisterRequest):
    """Public self-registration is closed - accounts are provisioned by the admin."""
    raise HTTPException(
        status_code=410,
        detail='Public sign-up is closed. Please submit an account request — the admin will verify your details and assign your unique Login ID and password.',
    )


@router.post('/signup-request')
async def signup_request(body: SignupRequestCreate):
    """New players request an account with their details; the admin verifies and
    assigns a unique Login ID + password offline."""
    email = body.email.lower().strip()
    if await db.users.find_one({'email': email}):
        raise HTTPException(status_code=409, detail='An account with this email already exists. Please log in.')
    if await db.signup_requests.find_one({'email': email, 'status': 'PENDING'}):
        raise HTTPException(status_code=409, detail='A request for this email is already pending review.')
    doc = {
        'id': str(uuid.uuid4()),
        'full_name': body.full_name.strip(),
        'email': email,
        'date_of_birth': body.date_of_birth,
        'phone': body.phone,
        'status': 'PENDING',
        'created_at': _now().isoformat(),
        'reviewed_at': None, 'reviewed_by': None, 'admin_note': None, 'assigned_username': None,
    }
    await db.signup_requests.insert_one(doc)
    logger.info(f'Signup request created for {email}')
    return {
        'message': 'Request submitted! The admin will verify your details and share your unique Login ID and password with you.',
        'request_id': doc['id'],
    }


@router.post('/verify-email')
async def verify_email(body: VerifyEmailRequest):
    email = body.email.lower().strip()
    user = await db.users.find_one({'email': email})
    if not user:
        raise HTTPException(status_code=404, detail='Account not found')
    if user.get('email_verified'):
        return {'message': 'Email already verified. Please log in.'}
    expires = user.get('verification_expires_at')
    if not expires or datetime.fromisoformat(expires) < _now():
        raise HTTPException(status_code=400, detail='Verification code expired. Request a new one.')
    if user.get('verification_code_hash') != _hash_code(body.code.strip()):
        raise HTTPException(status_code=400, detail='Invalid verification code')
    await db.users.update_one({'email': email}, {
        '$set': {'email_verified': True, 'status': 'VERIFIED'},
        '$unset': {'verification_code_hash': '', 'verification_expires_at': ''},
    })
    user = await db.users.find_one({'email': email})
    session_id = str(uuid.uuid4())
    await db.users.update_one({'id': user['id']}, {'$set': {'active_session_id': session_id}})
    token = create_access_token(user['id'], user['role'], session_id=session_id)
    return {'message': 'Email verified! Continue with onboarding.', 'access_token': token, 'user': _user_public(user)}


@router.post('/resend-verification')
async def resend_verification(body: ResendVerificationRequest):
    email = body.email.lower().strip()
    user = await db.users.find_one({'email': email})
    if not user:
        raise HTTPException(status_code=404, detail='Account not found')
    if user.get('email_verified'):
        return {'message': 'Email already verified. Please log in.'}
    code = _gen_code()
    await db.users.update_one({'email': email}, {'$set': {
        'verification_code_hash': _hash_code(code),
        'verification_expires_at': (_now() + timedelta(minutes=CODE_TTL_MINUTES)).isoformat(),
    }})
    sent = await EmailService.send_verification_code(email, code)
    resp = {'message': 'Verification code re-sent.'}
    if not sent.get('sent'):
        resp['message'] = 'The verification email could not be delivered right now. Please try again in a moment.'
        resp['email_delivery'] = 'failed'
    if is_dev_mode():
        resp['dev_code'] = code
    return resp


@router.post('/login')
async def login(body: LoginRequest):
    ident = body.email.lower().strip()
    # Login ID (username) or email - legacy accounts keep email login
    query = {'email': ident} if '@' in ident else {'username': ident}
    user = await db.users.find_one(query)
    if not user or not verify_password(body.password, user.get('password_hash', '')):
        raise HTTPException(status_code=401, detail='Invalid login ID or password')
    if not user.get('email_verified'):
        raise HTTPException(status_code=403, detail={'code': 'EMAIL_NOT_VERIFIED', 'message': 'Please verify your email first.', 'email': user.get('email')})
    # Single active session per Login ID: a new login replaces any previous session.
    session_id = str(uuid.uuid4())
    await db.users.update_one({'id': user['id']}, {'$set': {
        'active_session_id': session_id,
        'last_login_at': _now().isoformat(),
    }})
    token = create_access_token(user['id'], user['role'], session_id=session_id)
    return {'access_token': token, 'user': _user_public(user)}


@router.post('/logout')
async def logout(user: dict = Depends(get_current_user)):
    """Release the active session so the Login ID can be used elsewhere.
    Sets a revoked marker so every outstanding token becomes invalid."""
    await db.users.update_one({'id': user['id']}, {'$set': {'active_session_id': f'revoked-{uuid.uuid4()}'}})
    return {'message': 'Logged out'}


@router.post('/forgot-password')
async def forgot_password(body: ForgotPasswordRequest):
    email = body.email.lower().strip()
    user = await db.users.find_one({'email': email})
    # Do not leak account existence
    resp = {'message': 'If an account exists for this email, a reset code has been sent.'}
    if user:
        code = _gen_code()
        await db.users.update_one({'email': email}, {'$set': {
            'reset_code_hash': _hash_code(code),
            'reset_expires_at': (_now() + timedelta(minutes=CODE_TTL_MINUTES)).isoformat(),
        }})
        await EmailService.send_password_reset_code(email, code)
        if is_dev_mode():
            resp['dev_code'] = code
    return resp


@router.post('/reset-password')
async def reset_password(body: ResetPasswordRequest):
    email = body.email.lower().strip()
    user = await db.users.find_one({'email': email})
    if not user:
        raise HTTPException(status_code=400, detail='Invalid reset request')
    expires = user.get('reset_expires_at')
    if not expires or datetime.fromisoformat(expires) < _now():
        raise HTTPException(status_code=400, detail='Reset code expired. Request a new one.')
    if user.get('reset_code_hash') != _hash_code(body.code.strip()):
        raise HTTPException(status_code=400, detail='Invalid reset code')
    await db.users.update_one({'email': email}, {
        '$set': {'password_hash': hash_password(body.new_password)},
        '$unset': {'reset_code_hash': '', 'reset_expires_at': ''},
    })
    return {'message': 'Password reset. Please log in with your new password.'}


@router.post('/change-password')
async def change_password(body: ChangePasswordRequest, user: dict = Depends(get_current_user)):
    if not verify_password(body.current_password, user.get('password_hash', '')):
        raise HTTPException(status_code=400, detail='Current password is incorrect')
    await db.users.update_one({'id': user['id']}, {'$set': {'password_hash': hash_password(body.new_password)}})
    return {'message': 'Password changed successfully'}


@router.get('/me')
async def me(user: dict = Depends(get_current_user)):
    return {'user': _user_public(user)}
