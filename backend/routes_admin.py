"""Admin routes: user approvals, chip requests, games, announcements, system config."""
import uuid
import string
import secrets
import logging
from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException, Depends, Query, Request
from pymongo.errors import DuplicateKeyError
from db import db, serialize_doc
from models import (AdminUserAction, AdminChipRequestAction, AnnouncementCreate,
                    AnnouncementUpdate, GameUpdate, SystemConfigUpdate,
                    AdminSignupApprove, AdminCreateUser, AdminPointsAdjust, AdminSetPassword, SupportMessageCreate,
                    DistributorCreate,
                    DistributorRate,
                    DistributorStatus,
                    DistributorLogin,
                    PlayerReassign,
                    CommissionSettle,
                    PayoutAction,
                    PayoutPaid,
                    ClawbackCreate,
                    AdminSetEmail)
from auth_utils import require_admin, hash_password, require_legacy_chip_mutation_allowed
from ledger import debit_chips, InsufficientChips
import ledger
import crm
import compliance
import revenue
import commission
import payouts
from game_access import assert_admin_status_change_allowed
from otp_service import normalize_identity
from avatar_service import deterministic_avatar_key
import os
from pymongo import ReturnDocument

logger = logging.getLogger('admin')
router = APIRouter(prefix='/admin', tags=['admin'])

WELCOME_BONUS = 1000
ADMIN_REVIEW_ACTIVATION_MODE = 'ADMIN_REVIEW'
ADMIN_REVIEW_PENDING = 'ADMIN_REVIEW_PENDING'
ADMIN_REVIEW_APPROVED = 'ADMIN_APPROVED'

# Fixed issued-credential format: Login ID = "GK" + 7 digits, password = 7 CAPITAL letters.
_RNG = secrets.SystemRandom()


def _issue_username():
    return "GK" + "".join(_RNG.choice(string.digits) for _ in range(7))


def _issue_password():
    return "".join(_RNG.choice(string.ascii_uppercase) for _ in range(7))


def _now():
    return datetime.now(timezone.utc).isoformat()


def _allow_nontransactional_auth_tests() -> bool:
    return (
        (os.environ.get('APP_ENV') or '').strip().lower() == 'test'
        and (os.environ.get('AUTH_ALLOW_NON_TRANSACTIONAL_TESTS') or '').strip().lower() == 'true'
    )


async def _run_account_transaction(callback):
    """Commit approval state, welcome credit and notification atomically."""
    try:
        session_cm = await db.client.start_session()
    except Exception as exc:
        if (_allow_nontransactional_auth_tests()
                and isinstance(exc, (AttributeError, NotImplementedError))):
            return await callback(None)
        logger.error('Account transaction unavailable: %s', type(exc).__name__)
        raise HTTPException(status_code=503, detail={
            'code': 'ACCOUNT_TRANSACTIONS_UNAVAILABLE',
            'message': 'Account approval is temporarily unavailable.',
        }) from exc
    try:
        async with session_cm as session:
            return await session.with_transaction(callback)
    except HTTPException:
        raise
    except Exception as exc:
        logger.error('Account transaction failed: %s', type(exc).__name__)
        raise HTTPException(status_code=503, detail={
            'code': 'ACCOUNT_TRANSACTIONS_UNAVAILABLE',
            'message': 'Account approval is temporarily unavailable.',
        }) from exc


async def _notify(user_id: str, title: str, body: str, ntype: str = 'INFO', *, session=None):
    kwargs = {'session': session} if session is not None else {}
    await db.notifications.insert_one({
        'id': str(uuid.uuid4()), 'user_id': user_id, 'title': title, 'body': body,
        'type': ntype, 'read': False, 'created_at': _now(),
    }, **kwargs)


async def _credit_chips(user_id: str, amount: int, note: str, ref: str = None, *, session=None):
    """Server-authoritative chip credit with ledger entry."""
    kwargs = {'session': session} if session is not None else {}
    result = await db.users.find_one_and_update(
        {'id': user_id}, {'$inc': {'chip_balance': amount}},
        return_document=ReturnDocument.AFTER, **kwargs,
    )
    balance_after = result.get('chip_balance', 0) if result else 0
    await db.chip_transactions.insert_one({
        'id': str(uuid.uuid4()), 'user_id': user_id, 'type': 'CREDIT', 'amount': amount,
        'balance_after': balance_after, 'note': note, 'ref': ref, 'created_at': _now(),
    }, **kwargs)
    return balance_after


def _require_player_credential_target(user: dict) -> None:
    """Keep player-management routes from becoming admin takeover routes.

    Administrator credentials are changed only through the authenticated
    self-service flow, which verifies the account's current password.  These
    operator endpoints therefore fail closed for every non-player role,
    including the caller's own administrator account.
    """
    if user.get('role') != 'PLAYER':
        raise HTTPException(status_code=403, detail={
            'code': 'CREDENTIAL_TARGET_FORBIDDEN',
            'message': (
                'Player-management credential actions cannot modify '
                'administrator or partner accounts. Administrators must use '
                'the authenticated self-service flow for their own password; '
                'identity changes require a separately authorized recovery process.'
            ),
        })


def _directly_activated_self_service_account(user: dict) -> bool:
    """Recognise self-service accounts activated without an admin decision."""
    return bool(
        user.get('role') == 'PLAYER'
        and user.get('registration_source') == 'SELF_SERVICE'
        and user.get('activation_mode') in ('SELF_SERVICE_NO_OTP', 'PHONE_OTP')
        and (
            user.get('activation_mode') == 'SELF_SERVICE_NO_OTP'
            or (user.get('phone_verified') is True and user.get('contact_verified') is True)
        )
    )


# ---------- Dashboard ----------
@router.get('/stats')
async def stats(admin: dict = Depends(require_admin)):
    total_users = await db.users.count_documents({'role': 'PLAYER'})
    pending_users = await db.users.count_documents({'role': 'PLAYER', 'status': 'PENDING'})
    active_users = await db.users.count_documents({'role': 'PLAYER', 'status': 'ACTIVE'})
    suspended_users = await db.users.count_documents({'role': 'PLAYER', 'status': 'SUSPENDED'})
    pending_chip_requests = await db.chip_requests.count_documents({'status': 'PENDING'})
    pending_signups = await db.signup_requests.count_documents({'status': 'PENDING'})
    total_games = await db.games.count_documents({})
    enabled_games = await db.games.count_documents({'status': 'ENABLED'})
    announcements_count = await db.announcements.count_documents({'active': True})
    cfg = await db.system_config.find_one({'key': 'main'})
    return {
        'total_users': total_users, 'pending_users': pending_users,
        'active_users': active_users, 'suspended_users': suspended_users,
        'pending_chip_requests': pending_chip_requests,
        'pending_signups': pending_signups,
        'total_games': total_games, 'enabled_games': enabled_games,
        'active_announcements': announcements_count,
        'maintenance_mode': cfg.get('maintenance_mode', False) if cfg else False,
    }


# ---------- Users ----------
DEPOSIT_NOTE_RE = 'Chip request approved|Welcome play chips|provisioned by admin'
WIN_NOTE_RE = 'win \\(round|cashout'
BET_NOTE_RE = 'bet \\(round|Live bet'
REFUND_NOTE_RE = 'refund|cancelled'


async def _user_ledger_stats() -> dict:
    """Aggregate chip_transactions per user into deposits / winning chips / loss chips."""
    def _cond(tx_type: str, regex: str):
        return {'$sum': {'$cond': [
            {'$and': [
                {'$eq': ['$type', tx_type]},
                {'$regexMatch': {'input': {'$ifNull': ['$note', '']}, 'regex': regex, 'options': 'i'}},
            ]}, '$amount', 0]}}
    pipeline = [
        {'$group': {
            '_id': '$user_id',
            'total_deposits': _cond('CREDIT', DEPOSIT_NOTE_RE),
            'winning_chips': _cond('CREDIT', WIN_NOTE_RE),
            'bet_debits': _cond('DEBIT', BET_NOTE_RE),
            'refund_credits': _cond('CREDIT', REFUND_NOTE_RE),
        }},
    ]
    stats = {}
    async for row in db.chip_transactions.aggregate(pipeline):
        loss = max(0, row.get('bet_debits', 0) - row.get('refund_credits', 0))
        stats[row['_id']] = {
            'total_deposits': row.get('total_deposits', 0),
            'winning_chips': row.get('winning_chips', 0),
            'loss_chips': loss,
        }
    return stats


@router.get('/users')
async def list_users(status: str = Query(default=None), admin: dict = Depends(require_admin)):
    query = {'role': 'PLAYER'}
    if status:
        query['status'] = status
    users = await db.users.find(query, {'_id': 0, 'password_hash': 0, 'verification_code_hash': 0, 'reset_code_hash': 0, 'active_session_id': 0}).sort('created_at', -1).to_list(500)
    stats = await _user_ledger_stats()
    empty = {'total_deposits': 0, 'winning_chips': 0, 'loss_chips': 0}
    for u in users:
        u['stats'] = stats.get(u.get('id'), empty)
        if (u.get('registration_source') == 'SELF_SERVICE'
                and u.get('activation_mode') == ADMIN_REVIEW_ACTIVATION_MODE
                and u.get('manual_contact_reviewed') is not True):
            # Response-only aliases keep an already-open, older CRM bundle from
            # approving contacts it cannot see during the API/frontend rollout.
            # The database continues to keep these values provisional.
            u['email'] = u.get('pending_email') or u.get('email')
            u['phone'] = u.get('pending_phone') or u.get('phone')
    return {'users': serialize_doc(users)}


@router.post('/users/{user_id}/approve')
async def approve_user(user_id: str, body: AdminUserAction = None, admin: dict = Depends(require_admin)):
    async def commit_approval(session):
        kwargs = {'session': session} if session is not None else {}
        user = await db.users.find_one({'id': user_id, 'role': 'PLAYER'}, **kwargs)
        if not user:
            raise HTTPException(status_code=404, detail='User not found')
        if user.get('status') == 'ACTIVE':
            raise HTTPException(status_code=400, detail='User already active')
        if user.get('status') not in ('PENDING', 'REJECTED', 'SUSPENDED'):
            raise HTTPException(status_code=400, detail='User has not submitted onboarding yet')
        self_service = user.get('registration_source') == 'SELF_SERVICE'
        manual_review_registration = bool(
            self_service
            and user.get('activation_mode') == ADMIN_REVIEW_ACTIVATION_MODE
            and user.get('contact_verification_status') in (
                ADMIN_REVIEW_PENDING, ADMIN_REVIEW_APPROVED,
            )
        )
        manual_email = None
        manual_phone = None
        if manual_review_registration:
            try:
                email_identity = normalize_identity(
                    user.get('pending_email') or user.get('email'),
                )
                phone_identity = normalize_identity(
                    user.get('pending_phone') or user.get('phone'),
                )
                if email_identity.channel != 'EMAIL' or phone_identity.channel != 'SMS':
                    raise ValueError('Submitted contacts use the wrong channels')
                manual_email = email_identity.value
                manual_phone = phone_identity.value
            except ValueError as exc:
                raise HTTPException(status_code=403, detail={
                    'code': 'MANUAL_CONTACT_INVALID',
                    'message': 'Both submitted contacts must be valid before approval.',
                }) from exc
            clash = await db.users.find_one({
                'id': {'$ne': user_id},
                '$or': [
                    {'email': manual_email}, {'email_normalized': manual_email},
                    {'phone': manual_phone}, {'phone_normalized': manual_phone},
                    {'status': 'PENDING', 'pending_email': manual_email},
                    {'status': 'PENDING', 'pending_phone': manual_phone},
                ],
            }, **kwargs)
            if clash:
                raise HTTPException(status_code=409, detail={
                    'code': 'MANUAL_CONTACT_CONFLICT',
                    'message': 'An approved account already uses this email or mobile number.',
                })
        if self_service:
            verified_contact = bool(
                user.get('contact_verified')
                and (user.get('email_verified') or user.get('phone_verified'))
            )
            if not verified_contact and not manual_review_registration:
                raise HTTPException(status_code=403, detail={
                    'code': 'CONTACT_NOT_VERIFIED',
                    'message': 'The player must verify their registration contact before approval.',
                })
            if user.get('accepted_terms') is not True:
                raise HTTPException(status_code=403, detail={
                    'code': 'TERMS_NOT_ACCEPTED',
                    'message': 'The player must accept the account terms before approval.',
                })
            if (not user.get('submitted_at') and not user.get('approved_at')
                    and not _directly_activated_self_service_account(user)):
                raise HTTPException(status_code=403, detail={
                    'code': 'ONBOARDING_NOT_SUBMITTED',
                    'message': 'The player must complete and submit their profile before approval.',
                })
            country_code = compliance.normalise_country(user.get('country'))
            if not country_code or country_code == compliance.UNKNOWN:
                raise HTTPException(status_code=403, detail={
                    'code': 'COUNTRY_UNKNOWN',
                    'message': 'A recognized country or jurisdiction is required before approval.',
                })
        ok, code, message = await compliance.check_eligibility(
            user.get('country'), user.get('date_of_birth'), require_dob=self_service,
        )
        if not ok:
            raise HTTPException(status_code=403, detail=(
                f'{message} This account cannot be approved under the current '
                f'compliance settings ({code}).'))

        was_approved_before = bool(
            user.get('approved_at')
            or _directly_activated_self_service_account(user)
        )
        approved_at = _now()
        approval_updates = {
            'status': 'ACTIVE',
            'approved_at': approved_at,
            'approved_by': admin['id'],
        }
        if manual_review_registration:
            approval_updates.update({
                'email': manual_email,
                'email_normalized': manual_email,
                'phone': manual_phone,
                'phone_normalized': manual_phone,
                'primary_identity': manual_phone,
                'primary_identity_channel': 'PHONE',
                'manual_contact_reviewed': True,
                'manual_contact_reviewed_at': approved_at,
                'manual_contact_reviewed_by': admin['id'],
                # This does not mean the contacts were OTP-verified. Both
                # channel flags remain false and can be migrated later.
                'contact_verification_status': ADMIN_REVIEW_APPROVED,
            })
        approval_query = {
            'id': user_id, 'role': 'PLAYER', 'status': user.get('status'),
        }
        if manual_review_registration:
            approval_query.update({
                'registration_source': 'SELF_SERVICE',
                'activation_mode': ADMIN_REVIEW_ACTIVATION_MODE,
                'contact_verification_status': user.get('contact_verification_status'),
                'accepted_terms': True,
                'submitted_at': user.get('submitted_at'),
            })
        unset_fields = {'rejection_reason': ''}
        if manual_review_registration:
            unset_fields.update({'pending_email': '', 'pending_phone': ''})
        try:
            updated = await db.users.find_one_and_update(
                approval_query,
                {'$set': approval_updates, '$unset': unset_fields},
                return_document=ReturnDocument.AFTER,
                **kwargs,
            )
        except DuplicateKeyError as exc:
            raise HTTPException(status_code=409, detail={
                'code': 'MANUAL_CONTACT_CONFLICT',
                'message': 'An approved account already uses this email or mobile number.',
            }) from exc
        if not updated:
            raise HTTPException(status_code=409, detail='Account state changed; retry approval')
        if not was_approved_before:
            await _credit_chips(
                user_id, WELCOME_BONUS, 'Welcome play chips — approval bonus',
                ref=f'account-approval:{user_id}', session=session,
            )
            await _notify(
                user_id, 'Account approved!',
                f'Welcome to Chakri.Casino! Your account is approved and {WELCOME_BONUS} welcome play chips were added.',
                'APPROVAL', session=session,
            )
        else:
            await _notify(
                user_id, 'Account reactivated',
                'Your Chakri.Casino account has been reactivated.',
                'APPROVAL', session=session,
            )
        return await db.users.find_one(
            {'id': user_id}, {'_id': 0, 'password_hash': 0}, **kwargs,
        )

    updated = await _run_account_transaction(commit_approval)
    return {'message': 'User approved', 'user': serialize_doc(updated)}


@router.post('/users/{user_id}/reject')
async def reject_user(user_id: str, body: AdminUserAction, admin: dict = Depends(require_admin)):
    reason = (body.note if body else None) or 'Onboarding requirements not met'

    async def commit_rejection(session):
        kwargs = {'session': session} if session is not None else {}
        updated = await db.users.find_one_and_update(
            {'id': user_id, 'role': 'PLAYER', 'status': 'PENDING'},
            {'$set': {'status': 'REJECTED', 'rejection_reason': reason}},
            return_document=ReturnDocument.AFTER,
            **kwargs,
        )
        if not updated:
            current = await db.users.find_one(
                {'id': user_id, 'role': 'PLAYER'}, **kwargs,
            )
            if not current:
                raise HTTPException(status_code=404, detail='User not found')
            raise HTTPException(status_code=409, detail={
                'code': 'ACCOUNT_STATE_CHANGED',
                'message': 'The player is no longer pending review.',
            })
        await _notify(
            user_id, 'Onboarding update',
            f'Your onboarding was not approved. Reason: {reason}',
            'REJECTION', session=session,
        )
        return updated

    await _run_account_transaction(commit_rejection)
    return {'message': 'User rejected'}


@router.post('/users/{user_id}/suspend')
async def suspend_user(user_id: str, body: AdminUserAction = None, admin: dict = Depends(require_admin)):
    user = await db.users.find_one({'id': user_id, 'role': 'PLAYER'})
    if not user:
        raise HTTPException(status_code=404, detail='User not found')
    if user.get('status') != 'ACTIVE':
        raise HTTPException(status_code=400, detail='Only active users can be suspended')
    await db.users.update_one({'id': user_id}, {'$set': {'status': 'SUSPENDED'}})
    await _notify(user_id, 'Account suspended', 'Your Chakri.Casino account has been suspended. Contact support for details.', 'SUSPENSION')
    return {'message': 'User suspended'}


@router.post('/users/{user_id}/reset-password')
async def admin_reset_password(user_id: str, body: AdminSetPassword, admin: dict = Depends(require_admin)):
    """Reset a player's password and force re-login on all devices.

    Administrator accounts are deliberately excluded. An administrator changes
    their own password through ``/auth/change-password``, which requires the
    current password, and cannot use this route against another administrator.
    """
    user = await db.users.find_one({'id': user_id})
    if not user:
        raise HTTPException(status_code=404, detail='User not found')
    _require_player_credential_target(user)
    result = await db.users.update_one({'id': user_id, 'role': 'PLAYER'}, {
        '$set': {
            'password_hash': hash_password(body.password),
            # revoke every outstanding session/token
            'active_session_id': f'revoked-{uuid.uuid4()}',
        },
        '$unset': {'reset_code_hash': '', 'reset_expires_at': ''},
    })
    if result.matched_count != 1:
        raise HTTPException(status_code=409, detail={
            'code': 'ACCOUNT_STATE_CHANGED',
            'message': 'The player account changed while the password reset was being applied.',
        })
    await _notify(user_id, 'Password changed', 'An administrator reset your Chakri.Casino password. Please log in with your new password.', 'INFO')
    logger.info(f'admin {admin.get("email")} reset password for user {user_id}')
    return {'message': 'Password reset. The user must log in again with the new password.'}


# ---------- Direct account provisioning (admin creates the login) ----------
@router.post('/users')
async def admin_create_user(body: AdminCreateUser, admin: dict = Depends(require_admin)):
    """Create a player account directly. The server issues the Login ID
    (GK + 7 digits) and password (7 CAPITAL letters). The account is ACTIVE and
    pre-verified; the player logs in with the credentials the admin hands them."""
    # Allocate a unique GK Login ID.
    username = None
    for _ in range(40):
        cand = _issue_username()
        if not await db.users.find_one({'username': cand}):
            username = cand
            break
    if not username:
        raise HTTPException(status_code=503, detail='Could not allocate a Login ID — please try again')
    password = _issue_password()
    # Email is optional; the account logs in by Login ID. Synthesize a unique
    # placeholder when none is given so the unique email index is satisfied.
    email = body.email or f'{username.lower()}@chakri.casino'
    email_normalized = normalize_identity(email).value
    if await db.users.find_one({'$or': [
            {'email': email_normalized}, {'email_normalized': email_normalized},
    ]}):
        raise HTTPException(status_code=409, detail='A user with this email already exists')
    user = {
        'id': str(uuid.uuid4()),
        'email': email_normalized, 'email_normalized': email_normalized,
        'username': username,
        'password_hash': hash_password(password),
        'role': 'PLAYER', 'status': 'ACTIVE', 'email_verified': True,
        'display_name': body.full_name, 'full_name': body.full_name,
        'country': None, 'date_of_birth': None, 'phone': None,
        'avatar': deterministic_avatar_key(email_normalized),
        'avatar_source': 'PRESET',
        'chip_balance': 0, 'points_balance': 0,
        'favorites': [], 'recent_games': [],
        'settings': {'sound_enabled': True, 'music_enabled': True, 'haptics_enabled': True, 'reduced_motion': False, 'high_contrast': False},
        'accepted_terms': True,
        'approved_at': _now(), 'created_at': _now(),
        'provisioned_by': admin['id'], 'admin_note': body.note,
    }
    await db.users.insert_one(user)
    # Attribution is bound at creation and never again — see crm.py. An account
    # keyed in by an admin has no referral code, so it lands on the house.
    await crm.attribute_user(user['id'], getattr(body, 'referral_code', None), actor=admin['id'])
    if body.starting_chips > 0:
        await _credit_chips(user['id'], body.starting_chips, 'Welcome play chips — account provisioned by admin')
    logger.info(f'admin {admin.get("email")} created account -> {username}')
    return {'message': f'Account created. Login ID: {username}', 'username': username, 'password': password, 'user': serialize_doc(user)}


# ---------- Signup requests (legacy; kept for any pending requests) ----------
@router.get('/signup-requests')
async def list_signup_requests(status: str = Query(default=None), admin: dict = Depends(require_admin)):
    query = {}
    if status:
        query['status'] = status
    reqs = await db.signup_requests.find(query, {'_id': 0}).sort('created_at', -1).to_list(500)
    return {'requests': serialize_doc(reqs)}


@router.post('/signup-requests/{request_id}/approve')
async def approve_signup_request(request_id: str, body: AdminSignupApprove, admin: dict = Depends(require_admin)):
    """Verify a signup request and provision the account with an admin-assigned
    unique Login ID + password. The account is created ACTIVE and pre-verified."""
    req = await db.signup_requests.find_one({'id': request_id})
    if not req:
        raise HTTPException(status_code=404, detail='Signup request not found')
    if req.get('status') != 'PENDING':
        raise HTTPException(status_code=400, detail='Request already resolved')
    username = body.username  # validated + lowercased by the model
    if await db.users.find_one({'username': username}):
        raise HTTPException(status_code=409, detail=f'Login ID "{username}" is already taken')
    email_normalized = normalize_identity(req['email']).value
    phone_normalized = None
    if req.get('phone'):
        try:
            phone_normalized = normalize_identity(req['phone']).value
        except ValueError:
            phone_normalized = None
    identity_clauses = [
        {'email': email_normalized}, {'email_normalized': email_normalized},
    ]
    if phone_normalized:
        identity_clauses.extend([
            {'phone': phone_normalized}, {'phone_normalized': phone_normalized},
        ])
    if await db.users.find_one({'$or': identity_clauses}):
        raise HTTPException(status_code=409, detail='A user with this email already exists')
    # resolve the request atomically first (idempotency guard), then create the user
    result = await db.signup_requests.update_one(
        {'id': request_id, 'status': 'PENDING'},
        {'$set': {'status': 'APPROVED', 'reviewed_at': _now(), 'reviewed_by': admin['id'],
                  'assigned_username': username, 'admin_note': body.note}},
    )
    if result.modified_count == 0:
        raise HTTPException(status_code=400, detail='Request already resolved')
    user = {
        'id': str(uuid.uuid4()),
        'email': email_normalized, 'email_normalized': email_normalized,
        'username': username,
        'password_hash': hash_password(body.password),
        'role': 'PLAYER', 'status': 'ACTIVE', 'email_verified': True,
        'display_name': req['full_name'], 'full_name': req['full_name'],
        'country': None, 'date_of_birth': req.get('date_of_birth'),
        'phone': phone_normalized, 'phone_normalized': phone_normalized,
        'avatar': deterministic_avatar_key(phone_normalized or email_normalized),
        'avatar_source': 'PRESET',
        'chip_balance': 0, 'points_balance': 0,
        'favorites': [], 'recent_games': [],
        'settings': {'sound_enabled': True, 'music_enabled': True, 'haptics_enabled': True, 'reduced_motion': False, 'high_contrast': False},
        'accepted_terms': True,
        'approved_at': _now(), 'created_at': _now(),
        'provisioned_by': admin['id'], 'signup_request_id': request_id,
    }
    await db.users.insert_one(user)
    # Attribution is bound at creation and never again — see crm.py. The code the
    # player typed travels on the request; an unknown one falls to the house.
    await crm.attribute_user(user['id'], req.get('referral_code'), actor=admin['id'])
    if body.starting_chips > 0:
        await _credit_chips(user['id'], body.starting_chips, 'Welcome play chips — account provisioned by admin')
    await _notify(user['id'], 'Welcome to Chakri.Casino!',
                  f'Your account is ready. Log in with your assigned Login ID "{username}".', 'APPROVAL')
    logger.info(f'Signup request {request_id} approved -> user {username}')
    return {'message': f'Account created. Login ID: {username}', 'username': username, 'user': serialize_doc(user)}


@router.post('/signup-requests/{request_id}/reject')
async def reject_signup_request(request_id: str, body: AdminUserAction = None, admin: dict = Depends(require_admin)):
    req = await db.signup_requests.find_one({'id': request_id})
    if not req:
        raise HTTPException(status_code=404, detail='Signup request not found')
    if req.get('status') != 'PENDING':
        raise HTTPException(status_code=400, detail='Request already resolved')
    note = (body.note if body else None) or 'Details could not be verified'
    result = await db.signup_requests.update_one(
        {'id': request_id, 'status': 'PENDING'},
        {'$set': {'status': 'REJECTED', 'reviewed_at': _now(), 'reviewed_by': admin['id'], 'admin_note': note}},
    )
    if result.modified_count == 0:
        raise HTTPException(status_code=400, detail='Request already resolved')
    return {'message': 'Signup request rejected'}


# ---------- Points (admin adjustments) ----------
@router.post('/users/{user_id}/points')
async def adjust_points(user_id: str, body: AdminPointsAdjust, admin: dict = Depends(require_admin)):
    user = await db.users.find_one({'id': user_id, 'role': 'PLAYER'})
    if not user:
        raise HTTPException(status_code=404, detail='User not found')
    if body.delta < 0:
        result = await db.users.find_one_and_update(
            {'id': user_id, 'points_balance': {'$gte': -body.delta}},
            {'$inc': {'points_balance': body.delta}}, return_document=True,
        )
        if result is None:
            raise HTTPException(status_code=400, detail='User does not have enough points')
    else:
        result = await db.users.find_one_and_update(
            {'id': user_id}, {'$inc': {'points_balance': body.delta}}, return_document=True,
        )
    balance_after = result.get('points_balance', 0) if result else 0
    await db.points_transactions.insert_one({
        'id': str(uuid.uuid4()), 'user_id': user_id,
        'type': 'CREDIT' if body.delta > 0 else 'DEBIT', 'amount': abs(body.delta),
        'balance_after': balance_after, 'note': body.note or 'Admin points adjustment',
        'ref': f'admin:{admin["id"]}', 'created_at': _now(),
    })
    await _notify(user_id, 'Points update',
                  f'An operator {"added" if body.delta > 0 else "deducted"} {abs(body.delta)} points. New points balance: {balance_after}.', 'POINTS')
    return {'message': 'Points adjusted', 'points_balance': balance_after}


# ---------- Chip requests ----------
@router.get('/chip-requests')
async def list_chip_requests(status: str = Query(default=None), admin: dict = Depends(require_admin)):
    query = {}
    if status:
        query['status'] = status
    reqs = await db.chip_requests.find(query, {'_id': 0}).sort('created_at', -1).to_list(500)
    return {'requests': serialize_doc(reqs)}


async def _release_pending_chip_request_slot(req: dict, *, session=None) -> None:
    """Release an atomic pending-request reservation on terminal settlement.

    Older request rows predate the reservation counter and intentionally have
    no key, so they remain resolvable without inventing or decrementing state.
    The guarded decrement prevents retries or legacy/manual data repair from
    driving the counter below zero.
    """
    counter_key = req.get('pending_counter_key')
    if not counter_key:
        return
    kwargs = {'session': session} if session is not None else {}
    result = await db.chip_request_pending_counters.update_one(
        {'_id': counter_key, 'count': {'$gt': 0}},
        {'$inc': {'count': -1}, '$set': {'updated_at': _now()}},
        **kwargs,
    )
    if result.modified_count != 1:
        raise HTTPException(status_code=503, detail={
            'code': 'CHIP_REQUEST_COUNTER_INVALID',
            'message': 'Chip-request capacity is inconsistent. Refresh and try again.',
        })


async def _settle_chip_request(request_id: str, note: str | None,
                               admin: dict, *, session=None) -> dict:
    """Settle one pending request as a single Mongo transaction.

    Balance/points movements, their ledger row, the player notification, the
    request-state CAS and pending-cap release either all commit or all roll
    back. This avoids an APPROVED row with no chips after a process or database
    failure midway through settlement.
    """
    kwargs = {'session': session} if session is not None else {}
    req = await db.chip_requests.find_one({'id': request_id}, **kwargs)
    if not req:
        raise HTTPException(status_code=404, detail='Request not found')
    if req.get('status') != 'PENDING':
        raise HTTPException(status_code=400, detail='Request already resolved')

    req_type = req.get('type') or 'BUY'
    if req_type not in {'BUY', 'SELL', 'RETURN'}:
        raise HTTPException(status_code=409, detail={
            'code': 'INVALID_CHIP_REQUEST_TYPE',
            'message': 'This chip request has an invalid type and cannot be settled.',
        })
    player = await db.users.find_one(
        {'id': req['user_id'], 'role': 'PLAYER'}, {'_id': 1}, **kwargs,
    )
    if not player:
        raise HTTPException(status_code=409, detail={
            'code': 'PLAYER_STATE_CHANGED',
            'message': 'The player account is unavailable. Refresh and try again.',
        })
    if req_type == 'SELL':
        try:
            chip_balance = await debit_chips(
                req['user_id'], req['amount'],
                f"Sold {req['amount']} chips for points (1:1) — approved by operator",
                ref=request_id, kind=ledger.WITHDRAWAL, session=session,
            )
        except InsufficientChips as exc:
            raise HTTPException(
                status_code=400,
                detail=(
                    'Player no longer has enough chips to cover this sale. '
                    'Ask them to top up or deny the request.'
                ),
            ) from exc
        updated = await db.users.find_one_and_update(
            {'id': req['user_id'], 'role': 'PLAYER'},
            {'$inc': {'points_balance': req['amount']}},
            return_document=ReturnDocument.AFTER,
            **kwargs,
        )
        if not updated:
            raise HTTPException(status_code=409, detail={
                'code': 'PLAYER_STATE_CHANGED',
                'message': 'The player account changed. Refresh and try again.',
            })
        points_balance = updated.get('points_balance', 0)
        await db.points_transactions.insert_one({
            'id': str(uuid.uuid4()), 'user_id': req['user_id'],
            'type': 'CREDIT', 'amount': req['amount'],
            'balance_after': points_balance,
            'note': f"Sold {req['amount']} chips for points (1:1) — approved by operator",
            'ref': request_id, 'created_at': _now(),
        }, **kwargs)
        await _notify(
            req['user_id'], 'Sell request approved!',
            f"Your request to sell {req['amount']} chips was approved. "
            f"{req['amount']} points credited (new points balance: {points_balance}).",
            'POINTS', session=session,
        )
        response = {
            'message': 'Sell request approved — chips deducted and points credited',
            'chip_balance': chip_balance,
            'points_balance': points_balance,
        }
    elif req_type == 'RETURN':
        try:
            chip_balance = await debit_chips(
                req['user_id'], req['amount'],
                f"Returned {req['amount']} chips to operator — approved",
                ref=request_id, session=session,
            )
        except InsufficientChips as exc:
            raise HTTPException(
                status_code=400,
                detail=(
                    'Player no longer has enough chips to cover this return. '
                    'Ask them to adjust or deny the request.'
                ),
            ) from exc
        await _notify(
            req['user_id'], 'Return approved',
            f"Your request to return {req['amount']} chips was approved. "
            f"{req['amount']} chips were returned to the operator. New balance: {chip_balance}.",
            'CHIPS', session=session,
        )
        response = {
            'message': 'Return approved — chips deducted from the player',
            'chip_balance': chip_balance,
        }
    else:
        try:
            await compliance.check_deposit(req['user_id'], req['amount'])
        except compliance.ComplianceBlock as exc:
            raise HTTPException(status_code=400, detail=(
                f"This player's deposit limit refuses it: "
                f"{exc.detail.get('message')}"
            )) from exc
        balance = await ledger.credit_chips(
            req['user_id'], req['amount'],
            f"Chip request approved ({req['amount']} chips)",
            ref=request_id, kind=ledger.DEPOSIT, session=session,
        )
        await _notify(
            req['user_id'], 'Chips added!',
            f"Your request for {req['amount']} play chips was approved. "
            f"New balance: {balance}.",
            'CHIPS', session=session,
        )
        response = {
            'message': 'Request approved and chips credited',
            'balance_after': balance,
        }

    result = await db.chip_requests.update_one(
        {'id': request_id, 'status': 'PENDING'},
        {'$set': {
            'status': 'APPROVED', 'admin_note': note,
            'resolved_at': _now(), 'resolved_by': admin['id'],
        }},
        **kwargs,
    )
    if result.modified_count != 1:
        raise HTTPException(status_code=409, detail={
            'code': 'REQUEST_STATE_CHANGED',
            'message': 'The chip request was resolved concurrently. Refresh and try again.',
        })
    await _release_pending_chip_request_slot(req, session=session)
    return response


@router.post('/chip-requests/{request_id}/approve')
async def approve_chip_request(request_id: str, body: AdminChipRequestAction = None, admin: dict = Depends(require_admin)):
    require_legacy_chip_mutation_allowed()
    note = (body.note if body else None)
    async def commit_approval(session):
        return await _settle_chip_request(
            request_id, note, admin, session=session,
        )

    return await _run_account_transaction(commit_approval)


@router.post('/chip-requests/{request_id}/deny')
async def deny_chip_request(request_id: str, body: AdminChipRequestAction = None, admin: dict = Depends(require_admin)):
    note = (body.note if body else None) or 'Not approved by operator'

    async def commit_denial(session):
        kwargs = {'session': session} if session is not None else {}
        req = await db.chip_requests.find_one({'id': request_id}, **kwargs)
        if not req:
            raise HTTPException(status_code=404, detail='Request not found')
        if req.get('status') != 'PENDING':
            raise HTTPException(status_code=400, detail='Request already resolved')
        if req.get('type') == 'SELL':
            title = 'Sell request update'
            message = (
                f"Your request to sell {req['amount']} chips was denied. "
                f"Your chips were not deducted. Note: {note}"
            )
            notification_type = 'POINTS'
        elif req.get('type') == 'RETURN':
            title = 'Return request update'
            message = (
                f"Your request to return {req['amount']} chips was denied. "
                f"Your chips were not deducted. Note: {note}"
            )
            notification_type = 'CHIPS'
        else:
            title = 'Chip request update'
            message = (
                f"Your request for {req['amount']} play chips was denied. "
                f"Note: {note}"
            )
            notification_type = 'CHIPS'
        await _notify(
            req['user_id'], title, message, notification_type, session=session,
        )
        result = await db.chip_requests.update_one(
            {'id': request_id, 'status': 'PENDING'},
            {'$set': {
                'status': 'DENIED', 'admin_note': note,
                'resolved_at': _now(), 'resolved_by': admin['id'],
            }},
            **kwargs,
        )
        if result.modified_count != 1:
            raise HTTPException(status_code=409, detail={
                'code': 'REQUEST_STATE_CHANGED',
                'message': 'The chip request was resolved concurrently. Refresh and try again.',
            })
        await _release_pending_chip_request_slot(req, session=session)
        return {'message': 'Request denied'}

    return await _run_account_transaction(commit_denial)


# ---------- Support / messaging ----------
@router.get('/support/threads')
async def support_threads(admin: dict = Depends(require_admin)):
    """One thread per user who has ever messaged — newest activity first, with
    the last message preview and the count of unread (user->admin) messages."""
    pipeline = [
        {'$sort': {'created_at': 1}},
        {'$group': {
            '_id': '$user_id',
            'user_email': {'$last': '$user_email'},
            'user_display_name': {'$last': '$user_display_name'},
            'last_body': {'$last': '$body'},
            'last_sender': {'$last': '$sender'},
            'last_at': {'$last': '$created_at'},
            'unread': {'$sum': {'$cond': [{'$and': [{'$eq': ['$sender', 'USER']}, {'$eq': ['$read_admin', False]}]}, 1, 0]}},
        }},
        {'$sort': {'last_at': -1}},
        {'$limit': 300},
    ]
    rows = await db.support_messages.aggregate(pipeline).to_list(300)
    threads = [{
        'user_id': r['_id'], 'user_email': r.get('user_email'), 'user_display_name': r.get('user_display_name'),
        'last_body': r.get('last_body'), 'last_sender': r.get('last_sender'), 'last_at': r.get('last_at'),
        'unread': r.get('unread', 0),
    } for r in rows]
    return {'threads': threads, 'total_unread': sum(t['unread'] for t in threads)}


@router.get('/support/threads/{user_id}')
async def support_thread_detail(user_id: str, admin: dict = Depends(require_admin)):
    msgs = await db.support_messages.find({'user_id': user_id}, {'_id': 0}).sort('created_at', 1).to_list(500)
    await db.support_messages.update_many(
        {'user_id': user_id, 'sender': 'USER', 'read_admin': False}, {'$set': {'read_admin': True}})
    u = await db.users.find_one({'id': user_id}, {'_id': 0, 'email': 1, 'display_name': 1, 'status': 1})
    return {'messages': serialize_doc(msgs), 'user': serialize_doc(u)}


@router.post('/support/threads/{user_id}/reply')
async def support_reply(user_id: str, body: SupportMessageCreate, admin: dict = Depends(require_admin)):
    u = await db.users.find_one({'id': user_id})
    if not u:
        raise HTTPException(status_code=404, detail='User not found')
    msg = {
        'id': str(uuid.uuid4()), 'user_id': user_id,
        'user_email': u['email'], 'user_display_name': u.get('display_name') or u['email'].split('@')[0],
        'sender': 'ADMIN', 'body': body.body.strip(),
        'read_admin': True, 'read_user': False, 'created_at': _now(),
    }
    await db.support_messages.insert_one(msg)
    await _notify(user_id, 'New reply from support', body.body.strip()[:140], 'INFO')
    return {'message': 'Reply sent', 'item': serialize_doc(msg)}


# ---------- Games ----------
@router.get('/games')
async def admin_games(admin: dict = Depends(require_admin)):
    games = await db.games.find({}, {'_id': 0}).sort('order', 1).to_list(100)
    return {'games': serialize_doc(games)}


@router.patch('/games/{slug}')
async def update_game(slug: str, body: GameUpdate, admin: dict = Depends(require_admin)):
    game = await db.games.find_one({'slug': slug})
    if not game:
        raise HTTPException(status_code=404, detail='Game not found')
    updates = body.model_dump(exclude_none=True)
    assert_admin_status_change_allowed(slug, updates.get('status'))
    if updates:
        await db.games.update_one({'slug': slug}, {'$set': updates})
    updated = await db.games.find_one({'slug': slug}, {'_id': 0})
    return {'message': 'Game updated', 'game': serialize_doc(updated)}


# ---------- Announcements ----------
@router.get('/announcements')
async def admin_announcements(admin: dict = Depends(require_admin)):
    items = await db.announcements.find({}, {'_id': 0}).sort([('pinned', -1), ('created_at', -1)]).to_list(200)
    return {'announcements': serialize_doc(items)}


@router.post('/announcements')
async def create_announcement(body: AnnouncementCreate, admin: dict = Depends(require_admin)):
    doc = {
        'id': str(uuid.uuid4()), 'title': body.title, 'body': body.body,
        'pinned': body.pinned, 'active': body.active, 'created_by': admin['id'], 'created_at': _now(),
    }
    await db.announcements.insert_one(doc)
    return {'message': 'Announcement created', 'announcement': serialize_doc(doc)}


@router.patch('/announcements/{announcement_id}')
async def update_announcement(announcement_id: str, body: AnnouncementUpdate, admin: dict = Depends(require_admin)):
    item = await db.announcements.find_one({'id': announcement_id})
    if not item:
        raise HTTPException(status_code=404, detail='Announcement not found')
    updates = body.model_dump(exclude_none=True)
    if updates:
        await db.announcements.update_one({'id': announcement_id}, {'$set': updates})
    updated = await db.announcements.find_one({'id': announcement_id}, {'_id': 0})
    return {'message': 'Announcement updated', 'announcement': serialize_doc(updated)}


@router.delete('/announcements/{announcement_id}')
async def delete_announcement(announcement_id: str, admin: dict = Depends(require_admin)):
    result = await db.announcements.delete_one({'id': announcement_id})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail='Announcement not found')
    return {'message': 'Announcement deleted'}


# ---------- System config ----------
@router.get('/system')
async def get_system(admin: dict = Depends(require_admin)):
    cfg = await db.system_config.find_one({'key': 'main'}, {'_id': 0})
    return {'config': serialize_doc(cfg)}


@router.patch('/system')
async def update_system(body: SystemConfigUpdate, admin: dict = Depends(require_admin)):
    updates = body.model_dump(exclude_none=True)
    if updates:
        updates['updated_at'] = _now()
        await db.system_config.update_one({'key': 'main'}, {'$set': updates})
    cfg = await db.system_config.find_one({'key': 'main'}, {'_id': 0})
    return {'message': 'System config updated', 'config': serialize_doc(cfg)}


# ---------- Distributors (CRM) ----------
# The deck's section 1 and 5: referral code to distributor mapping, and the
# figures a distributor's dashboard is built from.

@router.get('/distributors')
async def list_distributors(admin: dict = Depends(require_admin)):
    await crm.ensure_house_account()
    rows = await db.distributors.find({}, {'_id': 0}).sort('created_at', 1).to_list(500)
    out = []
    for d in rows:
        d['rate_bps'] = await crm.rate_on(d['id'], crm.now_iso())
        d['players'] = await db.users.count_documents({'distributor_id': d['id'], 'role': 'PLAYER'})
        out.append(d)
    return {'distributors': out}


@router.post('/distributors')
async def create_distributor(body: DistributorCreate, admin: dict = Depends(require_admin)):
    try:
        doc = await crm.create_distributor(
            name=body.name, code=body.code, rate_bps=body.rate_bps,
            created_by=admin['id'], email=body.email, phone=body.phone, note=body.note)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    doc.pop('_id', None)
    return {'message': f"Distributor {doc['code']} created", 'distributor': doc}


@router.patch('/distributors/{distributor_id}/rate')
async def change_rate(distributor_id: str, body: DistributorRate, admin: dict = Depends(require_admin)):
    dist = await db.distributors.find_one({'id': distributor_id})
    if not dist:
        raise HTTPException(status_code=404, detail='Distributor not found')
    if dist.get('is_house'):
        raise HTTPException(status_code=400, detail='The house account does not earn commission')
    try:
        row = await crm.set_rate(distributor_id, body.rate_bps, admin['id'], note=body.note)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    row.pop('_id', None)
    # The old rate is closed, not overwritten: statements already issued must
    # keep reproducing the number they printed.
    return {'message': 'Rate updated from now on; past periods are unchanged', 'rate': row}


@router.patch('/distributors/{distributor_id}/status')
async def set_distributor_status(distributor_id: str, body: DistributorStatus,
                                 admin: dict = Depends(require_admin)):
    dist = await db.distributors.find_one({'id': distributor_id})
    if not dist:
        raise HTTPException(status_code=404, detail='Distributor not found')
    if dist.get('is_house'):
        raise HTTPException(status_code=400, detail='The house account cannot be suspended')
    await db.distributors.update_one({'id': distributor_id}, {'$set': {
        'status': body.status, 'status_changed_at': crm.now_iso(), 'status_changed_by': admin['id']}})
    # Players stay where they are. Suspending a distributor stops new signups on
    # the code and stops payouts; it does not orphan the players they brought.
    return {'message': f'Distributor set to {body.status}'}


@router.post('/distributors/{distributor_id}/login')
async def issue_distributor_login(distributor_id: str, body: DistributorLogin,
                                  admin: dict = Depends(require_admin)):
    """Create or reset a partner's portal credentials.

    The password is returned ONCE, in this response, and is never readable
    again — it is stored hashed like every other. The operator hands it over
    out of band, the same way player credentials are already issued.
    """
    password = (body.password or '').strip() or _issue_password() + _issue_password()
    try:
        user = await crm.attach_login(distributor_id, body.email, hash_password(password), admin['id'])
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {
        'message': 'Portal login issued',
        'login_id': user['username'],
        'email': user['email'],
        'password': password,
        'note': 'Give these to the partner now — the password cannot be shown again.',
        'portal_url': '/partner',
    }


@router.get('/distributors/{distributor_id}/players')
async def distributor_players(distributor_id: str, admin: dict = Depends(require_admin)):
    rows = await db.users.find(
        {'distributor_id': distributor_id, 'role': 'PLAYER'},
        {'_id': 0, 'id': 1, 'username': 1, 'full_name': 1, 'status': 1,
         'chip_balance': 1, 'created_at': 1, 'distributor_code': 1},
    ).sort('created_at', -1).to_list(1000)
    return {'players': rows, 'count': len(rows)}


@router.post('/players/{user_id}/distributor')
async def move_player(user_id: str, body: PlayerReassign, admin: dict = Depends(require_admin)):
    if not await db.users.find_one({'id': user_id}):
        raise HTTPException(status_code=404, detail='Player not found')
    try:
        doc = await crm.reassign_user(user_id, body.distributor_id, admin['id'], note=body.note)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    doc.pop('_id', None)
    return {'message': 'Player reassigned from now on; settled periods are unchanged',
            'attribution': doc}


# ---------- Revenue (CRM) ----------
# Section 3 of the deck: the daily figures the commission run is calculated
# from. Exposed read-only plus a rebuild, because a day that was aggregated
# before a fix has to be reproducible on demand — the figures are derived from
# the ledger, never accumulated, so rebuilding is always safe.

@router.get('/revenue/{day}')
async def revenue_for_day(day: str, admin: dict = Depends(require_admin)):
    dists = await db.distributor_days.find({'day': day}, {'_id': 0}).to_list(500)
    totals = {
        'turnover': sum(d['turnover'] for d in dists),
        'payout': sum(d['payout'] for d in dists),
        'ggr': sum(d['ggr'] for d in dists),
        'ngr': sum(d['ngr'] for d in dists),
        'bets': sum(d['bets'] for d in dists),
        'players': sum(d['players'] for d in dists),
    }
    return {'day': day, 'distributors': dists, 'totals': totals}


@router.post('/revenue/{day}/rebuild')
async def rebuild_revenue(day: str, admin: dict = Depends(require_admin)):
    try:
        datetime.strptime(day, '%Y-%m-%d')
    except ValueError:
        raise HTTPException(status_code=400, detail='Day must be YYYY-MM-DD')
    result = await revenue.rebuild_day(day)
    return {'message': f'Rebuilt {day} from the ledger', **result}


# ---------- Commission runs (CRM) ----------
# Section 4 of the deck. The run is idempotent and refuses to settle a closed
# period, so these endpoints are safe to call from an external scheduler and
# safe to retry when one times out.

@router.post('/commission/settle')
async def settle_commission(body: CommissionSettle, admin: dict = Depends(require_admin)):
    start = body.period_start
    end = body.period_end or body.period_start
    try:
        datetime.strptime(start, '%Y-%m-%d'); datetime.strptime(end, '%Y-%m-%d')
    except ValueError:
        raise HTTPException(status_code=400, detail='Dates must be YYYY-MM-DD')
    if end < start:
        raise HTTPException(status_code=400, detail='period_end is before period_start')
    try:
        result = await commission.run_commission(start, end, actor=admin['id'], version=body.version)
    except commission.PeriodClosed as e:
        raise HTTPException(status_code=409, detail=str(e))
    except commission.PeriodBusy as e:
        raise HTTPException(status_code=423, detail=str(e))
    return {'message': f'Settled {start}..{end}', **result}


@router.get('/commission/runs')
async def commission_runs(admin: dict = Depends(require_admin)):
    runs = await db.commission_runs.find({}, {'_id': 0}).sort('period_end', -1).to_list(120)
    return {'runs': runs}


@router.get('/commission/ledger')
async def commission_ledger(distributor_id: str = None, admin: dict = Depends(require_admin)):
    q = {'distributor_id': distributor_id} if distributor_id else {}
    rows = await db.commission_ledger.find(q, {'_id': 0}).sort('period_end', -1).to_list(500)
    return {'entries': rows, 'accrued': sum(r['commission'] for r in rows)}


# ---------- Payout queue (CRM) ----------

@router.post('/payouts/build')
async def build_payouts(admin: dict = Depends(require_admin)):
    made = await payouts.build_all(actor=admin['id'])
    for m in made:
        m.pop('_id', None)
    return {'message': f'{len(made)} payout(s) raised', 'payouts': made,
            'note': 'Commission inside the holdback, or under the threshold, stays accrued'}


@router.get('/payouts')
async def list_payouts(status: str = None, admin: dict = Depends(require_admin)):
    q = {'status': status.upper()} if status else {}
    rows = await db.payouts.find(q, {'_id': 0}).sort('created_at', -1).to_list(300)
    return {'payouts': rows, 'pending_total': sum(
        r['amount'] for r in rows if r['status'] == payouts.PENDING)}


@router.post('/payouts/{payout_id}/approve')
async def approve_payout(payout_id: str, body: PayoutAction, admin: dict = Depends(require_admin)):
    try:
        doc = await payouts.approve(payout_id, admin['id'], note=body.note)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    return {'message': 'Payout approved', 'payout': doc}


@router.post('/payouts/{payout_id}/reject')
async def reject_payout(payout_id: str, body: PayoutAction, admin: dict = Depends(require_admin)):
    try:
        doc = await payouts.reject(payout_id, admin['id'], body.note)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    return {'message': 'Payout rejected; the commission returns to the pool', 'payout': doc}


@router.post('/payouts/{payout_id}/paid')
async def mark_payout_paid(payout_id: str, body: PayoutPaid, admin: dict = Depends(require_admin)):
    try:
        doc = await payouts.mark_paid(payout_id, admin['id'], body.payment_ref)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    return {'message': 'Payout marked paid', 'payout': doc}


@router.post('/distributors/{distributor_id}/clawback')
async def raise_clawback(distributor_id: str, body: ClawbackCreate,
                         admin: dict = Depends(require_admin)):
    if not await db.distributors.find_one({'id': distributor_id}):
        raise HTTPException(status_code=404, detail='Distributor not found')
    try:
        row = await payouts.clawback(distributor_id, body.amount, body.reason, admin['id'])
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {'message': 'Clawback raised; it nets off the next payout', 'entry': row}


@router.get('/distributors/{distributor_id}/balance')
async def distributor_balance(distributor_id: str, admin: dict = Depends(require_admin)):
    return await payouts.balance_for(distributor_id)


@router.post('/cron/night')
async def night_run(request: Request):
    """The 02:00 job: aggregate yesterday, settle it, then raise payouts.

    Authenticated by a shared secret rather than an admin session, because a
    scheduler has no session. Every step is idempotent, so a retry after a
    timeout repeats nothing — the aggregation is derived, the settlement claims
    its period, and the payout build claims its entries.
    """
    secret = os.environ.get('CRON_SECRET')
    if not secret:
        raise HTTPException(status_code=503, detail='CRON_SECRET is not configured')
    if request.headers.get('x-cron-key') != secret:
        raise HTTPException(status_code=401, detail='Bad cron key')

    day = commission.previous_day(ledger.gaming_day())
    steps = {'day': day}
    steps['revenue'] = await revenue.rebuild_day(day)
    try:
        steps['commission'] = await commission.run_commission(day, day, actor='cron')
    except commission.PeriodClosed:
        steps['commission'] = 'already settled'
    except commission.PeriodBusy as e:
        steps['commission'] = f'skipped: {e}'
    built = await payouts.build_all(actor='cron')
    steps['payouts_raised'] = len(built)
    return steps


@router.post('/users/{user_id}/email')
async def admin_change_email(user_id: str, body: AdminSetEmail, admin: dict = Depends(require_admin)):
    """Change the address a player signs in with.

    The address IS the login here, so this is a change of identity rather than of
    a profile field: every outstanding session is revoked, the same as a password
    reset, or a device holding a token would keep the access the change was meant
    to move. Administrator and partner identities cannot be changed through this
    player-management route.
    """
    email = normalize_identity(body.email).value
    user = await db.users.find_one({'id': user_id})
    if not user:
        raise HTTPException(status_code=404, detail='User not found')
    _require_player_credential_target(user)
    clash = await db.users.find_one({
        'id': {'$ne': user_id},
        '$or': [{'email': email}, {'email_normalized': email}],
    })
    if clash:
        raise HTTPException(status_code=409, detail='Another account already uses that email')
    result = await db.users.update_one({'id': user_id, 'role': 'PLAYER'}, {'$set': {
        'email': email,
        'email_normalized': email,
        'email_verified': True,
        'previous_email': user.get('email'),
        'email_changed_at': _now(),
        'email_changed_by': admin['id'],
        'active_session_id': f'revoked-{uuid.uuid4()}',
    }})
    if result.matched_count != 1:
        raise HTTPException(status_code=409, detail={
            'code': 'ACCOUNT_STATE_CHANGED',
            'message': 'The player account changed while the email update was being applied.',
        })
    logger.info(f'admin {admin.get("email")} changed email for {user_id}: {user.get("email")} -> {email}')
    return {'message': f'Login email changed to {email}. All sessions for that account were signed out.',
            'previous_email': user.get('email'), 'email': email}
