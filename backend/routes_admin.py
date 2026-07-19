"""Admin routes: user approvals, chip requests, games, announcements, system config."""
import uuid
import logging
from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException, Depends, Query
from db import db, serialize_doc
from models import (AdminUserAction, AdminChipRequestAction, AnnouncementCreate,
                    AnnouncementUpdate, GameUpdate, SystemConfigUpdate,
                    AdminSignupApprove, AdminPointsAdjust)
from auth_utils import require_admin, hash_password

logger = logging.getLogger('admin')
router = APIRouter(prefix='/admin', tags=['admin'])

WELCOME_BONUS = 1000


def _now():
    return datetime.now(timezone.utc).isoformat()


async def _notify(user_id: str, title: str, body: str, ntype: str = 'INFO'):
    await db.notifications.insert_one({
        'id': str(uuid.uuid4()), 'user_id': user_id, 'title': title, 'body': body,
        'type': ntype, 'read': False, 'created_at': _now(),
    })


async def _credit_chips(user_id: str, amount: int, note: str, ref: str = None):
    """Server-authoritative chip credit with ledger entry."""
    result = await db.users.find_one_and_update(
        {'id': user_id}, {'$inc': {'chip_balance': amount}}, return_document=True,
    )
    balance_after = result.get('chip_balance', 0) if result else 0
    await db.chip_transactions.insert_one({
        'id': str(uuid.uuid4()), 'user_id': user_id, 'type': 'CREDIT', 'amount': amount,
        'balance_after': balance_after, 'note': note, 'ref': ref, 'created_at': _now(),
    })
    return balance_after


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
@router.get('/users')
async def list_users(status: str = Query(default=None), admin: dict = Depends(require_admin)):
    query = {'role': 'PLAYER'}
    if status:
        query['status'] = status
    users = await db.users.find(query, {'_id': 0, 'password_hash': 0, 'verification_code_hash': 0, 'reset_code_hash': 0}).sort('created_at', -1).to_list(500)
    return {'users': serialize_doc(users)}


@router.post('/users/{user_id}/approve')
async def approve_user(user_id: str, body: AdminUserAction = None, admin: dict = Depends(require_admin)):
    user = await db.users.find_one({'id': user_id, 'role': 'PLAYER'})
    if not user:
        raise HTTPException(status_code=404, detail='User not found')
    if user.get('status') == 'ACTIVE':
        raise HTTPException(status_code=400, detail='User already active')
    if user.get('status') not in ('PENDING', 'REJECTED', 'SUSPENDED'):
        raise HTTPException(status_code=400, detail='User has not submitted onboarding yet')
    was_approved_before = user.get('approved_at') is not None
    await db.users.update_one({'id': user_id}, {'$set': {'status': 'ACTIVE', 'approved_at': _now()}, '$unset': {'rejection_reason': ''}})
    if not was_approved_before:
        await _credit_chips(user_id, WELCOME_BONUS, 'Welcome play chips — approval bonus')
        await _notify(user_id, 'Account approved!', f'Welcome to FunGame! Your account is approved and {WELCOME_BONUS} welcome play chips were added. PLAY CHIPS — NO CASH VALUE.', 'APPROVAL')
    else:
        await _notify(user_id, 'Account reactivated', 'Your FunGame account has been reactivated.', 'APPROVAL')
    updated = await db.users.find_one({'id': user_id}, {'_id': 0, 'password_hash': 0})
    return {'message': 'User approved', 'user': serialize_doc(updated)}


@router.post('/users/{user_id}/reject')
async def reject_user(user_id: str, body: AdminUserAction, admin: dict = Depends(require_admin)):
    user = await db.users.find_one({'id': user_id, 'role': 'PLAYER'})
    if not user:
        raise HTTPException(status_code=404, detail='User not found')
    if user.get('status') != 'PENDING':
        raise HTTPException(status_code=400, detail='Only pending users can be rejected')
    reason = (body.note if body else None) or 'Onboarding requirements not met'
    await db.users.update_one({'id': user_id}, {'$set': {'status': 'REJECTED', 'rejection_reason': reason}})
    await _notify(user_id, 'Onboarding update', f'Your onboarding was not approved. Reason: {reason}', 'REJECTION')
    return {'message': 'User rejected'}


@router.post('/users/{user_id}/suspend')
async def suspend_user(user_id: str, body: AdminUserAction = None, admin: dict = Depends(require_admin)):
    user = await db.users.find_one({'id': user_id, 'role': 'PLAYER'})
    if not user:
        raise HTTPException(status_code=404, detail='User not found')
    if user.get('status') != 'ACTIVE':
        raise HTTPException(status_code=400, detail='Only active users can be suspended')
    await db.users.update_one({'id': user_id}, {'$set': {'status': 'SUSPENDED'}})
    await _notify(user_id, 'Account suspended', 'Your FunGame account has been suspended. Contact support for details.', 'SUSPENSION')
    return {'message': 'User suspended'}


# ---------- Signup requests (admin-provisioned accounts) ----------
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
    if await db.users.find_one({'email': req['email']}):
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
        'email': req['email'],
        'username': username,
        'password_hash': hash_password(body.password),
        'role': 'PLAYER', 'status': 'ACTIVE', 'email_verified': True,
        'display_name': req['full_name'], 'full_name': req['full_name'],
        'country': None, 'date_of_birth': req.get('date_of_birth'), 'phone': req.get('phone'),
        'avatar': 'star',
        'chip_balance': 0, 'points_balance': 0,
        'favorites': [], 'recent_games': [],
        'settings': {'sound_enabled': True, 'music_enabled': True, 'haptics_enabled': True, 'reduced_motion': False, 'high_contrast': False},
        'accepted_terms': True,
        'approved_at': _now(), 'created_at': _now(),
        'provisioned_by': admin['id'], 'signup_request_id': request_id,
    }
    await db.users.insert_one(user)
    if body.starting_chips > 0:
        await _credit_chips(user['id'], body.starting_chips, 'Welcome play chips — account provisioned by admin')
    await _notify(user['id'], 'Welcome to FunGame!',
                  f'Your account is ready. Log in with your assigned Login ID "{username}". PLAY CHIPS — NO CASH VALUE.', 'APPROVAL')
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


@router.post('/chip-requests/{request_id}/approve')
async def approve_chip_request(request_id: str, body: AdminChipRequestAction = None, admin: dict = Depends(require_admin)):
    req = await db.chip_requests.find_one({'id': request_id})
    if not req:
        raise HTTPException(status_code=404, detail='Request not found')
    if req.get('status') != 'PENDING':
        raise HTTPException(status_code=400, detail='Request already resolved')  # idempotent settlement guard
    note = (body.note if body else None)
    # Mark resolved FIRST (atomically) to guarantee idempotency, then credit
    result = await db.chip_requests.update_one(
        {'id': request_id, 'status': 'PENDING'},
        {'$set': {'status': 'APPROVED', 'admin_note': note, 'resolved_at': _now(), 'resolved_by': admin['id']}},
    )
    if result.modified_count == 0:
        raise HTTPException(status_code=400, detail='Request already resolved')
    balance = await _credit_chips(req['user_id'], req['amount'], f"Chip request approved ({req['amount']} chips)", ref=request_id)
    await _notify(req['user_id'], 'Chips added!', f"Your request for {req['amount']} play chips was approved. New balance: {balance}. PLAY CHIPS — NO CASH VALUE.", 'CHIPS')
    return {'message': 'Request approved and chips credited', 'balance_after': balance}


@router.post('/chip-requests/{request_id}/deny')
async def deny_chip_request(request_id: str, body: AdminChipRequestAction = None, admin: dict = Depends(require_admin)):
    req = await db.chip_requests.find_one({'id': request_id})
    if not req:
        raise HTTPException(status_code=404, detail='Request not found')
    if req.get('status') != 'PENDING':
        raise HTTPException(status_code=400, detail='Request already resolved')
    note = (body.note if body else None) or 'Not approved by operator'
    result = await db.chip_requests.update_one(
        {'id': request_id, 'status': 'PENDING'},
        {'$set': {'status': 'DENIED', 'admin_note': note, 'resolved_at': _now(), 'resolved_by': admin['id']}},
    )
    if result.modified_count == 0:
        raise HTTPException(status_code=400, detail='Request already resolved')
    await _notify(req['user_id'], 'Chip request update', f"Your request for {req['amount']} play chips was denied. Note: {note}", 'CHIPS')
    return {'message': 'Request denied'}


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
