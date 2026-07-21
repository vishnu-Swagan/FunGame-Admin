"""Player routes: onboarding, games, chips, announcements, notifications, settings, system config."""
import uuid
import logging
from datetime import datetime, timezone, timedelta
from fastapi import APIRouter, HTTPException, Depends, Query
from db import db, serialize_doc
from models import (OnboardingProfileRequest, ChipRequestCreate, SellChipsRequestCreate, SettingsUpdate,
                    ConvertRequest, ReturnChipsRequestCreate, SupportMessageCreate)
from auth_utils import get_current_user, require_active_player, check_maintenance_for_players
from ledger import credit_chips, debit_chips, InsufficientChips

logger = logging.getLogger('player')
router = APIRouter(tags=['player'])


def _now():
    return datetime.now(timezone.utc).isoformat()


async def _notify(user_id: str, title: str, body: str, ntype: str = 'INFO'):
    await db.notifications.insert_one({
        'id': str(uuid.uuid4()), 'user_id': user_id, 'title': title, 'body': body,
        'type': ntype, 'read': False, 'created_at': _now(),
    })


# ---------- System config (public for logged-out screens too) ----------
@router.get('/system/config')
async def system_config():
    cfg = await db.system_config.find_one({'key': 'main'})
    if not cfg:
        return {'maintenance_mode': False, 'maintenance_message': '', 'min_client_version': '1.0.0'}
    return {
        'maintenance_mode': cfg.get('maintenance_mode', False),
        'maintenance_message': cfg.get('maintenance_message', ''),
        'min_client_version': cfg.get('min_client_version', '1.0.0'),
        'disclaimer': 'PLAY CHIPS ONLY',
    }


# ---------- Onboarding ----------
@router.post('/onboarding/profile')
async def onboarding_profile(body: OnboardingProfileRequest, user: dict = Depends(get_current_user)):
    if not user.get('email_verified'):
        raise HTTPException(status_code=403, detail='Verify your email first')
    if user.get('status') in ('ACTIVE', 'SUSPENDED'):
        raise HTTPException(status_code=400, detail='Onboarding already completed')
    await db.users.update_one({'id': user['id']}, {'$set': {
        'display_name': body.display_name.strip(),
        'country': body.country.strip(),
        'date_of_birth': body.date_of_birth,
        'avatar': body.avatar,
        'accepted_terms': True,
        'status': 'PROFILE_SUBMITTED',
    }})
    updated = await db.users.find_one({'id': user['id']})
    return {'message': 'Profile saved. Review and submit for approval.', 'user': serialize_doc(updated)}


@router.post('/onboarding/submit')
async def onboarding_submit(user: dict = Depends(get_current_user)):
    if not user.get('email_verified'):
        raise HTTPException(status_code=403, detail='Verify your email first')
    if user.get('status') == 'ACTIVE':
        raise HTTPException(status_code=400, detail='Already approved')
    if user.get('status') not in ('PROFILE_SUBMITTED', 'PENDING', 'REJECTED'):
        raise HTTPException(status_code=400, detail='Complete your profile first')
    await db.users.update_one({'id': user['id']}, {'$set': {'status': 'PENDING', 'submitted_at': _now()}})
    await _notify(user['id'], 'Onboarding submitted', 'Your profile is under review. You will be notified once an operator approves your account.', 'ONBOARDING')
    updated = await db.users.find_one({'id': user['id']})
    return {'message': 'Submitted for review. An operator will approve your account shortly.', 'user': serialize_doc(updated)}


@router.get('/onboarding/status')
async def onboarding_status(user: dict = Depends(get_current_user)):
    return {'status': user.get('status'), 'rejection_reason': user.get('rejection_reason'), 'user': serialize_doc(user)}


# ---------- Games ----------
@router.get('/games')
async def list_games(user: dict = Depends(require_active_player)):
    games = await db.games.find({}, {'_id': 0}).sort('order', 1).to_list(100)
    fresh = await db.users.find_one({'id': user['id']})
    favorites = fresh.get('favorites', []) if fresh else []
    recent = fresh.get('recent_games', []) if fresh else []
    return {'games': serialize_doc(games), 'favorites': favorites, 'recent': recent}


@router.get('/games/{slug}')
async def game_detail(slug: str, user: dict = Depends(require_active_player)):
    game = await db.games.find_one({'slug': slug}, {'_id': 0})
    if not game:
        raise HTTPException(status_code=404, detail='Game not found')
    # track recently viewed (max 10, most recent first)
    recent = [s for s in user.get('recent_games', []) if s != slug]
    recent.insert(0, slug)
    await db.users.update_one({'id': user['id']}, {'$set': {'recent_games': recent[:10]}})
    is_fav = slug in user.get('favorites', [])
    return {'game': serialize_doc(game), 'is_favorite': is_fav}


@router.post('/games/{slug}/favorite')
async def toggle_favorite(slug: str, user: dict = Depends(require_active_player)):
    game = await db.games.find_one({'slug': slug})
    if not game:
        raise HTTPException(status_code=404, detail='Game not found')
    favs = user.get('favorites', [])
    if slug in favs:
        favs = [f for f in favs if f != slug]
        action = 'removed'
    else:
        favs = favs + [slug]
        action = 'added'
    await db.users.update_one({'id': user['id']}, {'$set': {'favorites': favs}})
    return {'favorites': favs, 'action': action}


# NOTE: gameplay endpoints (play/cashout/draw/history) live in routes_games.py


# ---------- Chips ----------
@router.get('/chips/balance')
async def chip_balance(user: dict = Depends(require_active_player)):
    fresh = await db.users.find_one({'id': user['id']})
    return {
        'balance': fresh.get('chip_balance', 0),
        'points': fresh.get('points_balance', 0),
        'disclaimer': 'PLAY CHIPS ONLY',
    }


@router.post('/chips/convert')
async def convert_chips_points(body: ConvertRequest, user: dict = Depends(require_active_player)):
    """Points -> chips is instant (1:1, minimum 500).
    Chips -> points now requires an admin-approved SELL request."""
    if user.get('role') == 'ADMIN':
        raise HTTPException(status_code=400, detail='Admins do not convert chips')
    uid = user['id']
    if body.direction == 'CHIPS_TO_POINTS':
        raise HTTPException(
            status_code=400,
            detail='Selling chips for points now requires operator approval. Please submit a sell request instead.',
        )
    # POINTS_TO_CHIPS (instant)
    result = await db.users.find_one_and_update(
        {'id': uid, 'points_balance': {'$gte': body.amount}},
        {'$inc': {'points_balance': -body.amount}}, return_document=True,
    )
    if result is None:
        raise HTTPException(status_code=400, detail='Not enough points — you need at least the amount you are converting')
    points_balance = result.get('points_balance', 0)
    await db.points_transactions.insert_one({
        'id': str(uuid.uuid4()), 'user_id': uid, 'type': 'DEBIT', 'amount': body.amount,
        'balance_after': points_balance, 'note': f'Converted {body.amount} points to chips (1:1)',
        'ref': 'convert', 'created_at': _now(),
    })
    chip_balance = await credit_chips(uid, body.amount, f'Converted {body.amount} points to chips (1:1)', ref='convert')
    message = f'Converted {body.amount} points — {body.amount} chips credited.'
    return {'message': message, 'chip_balance': chip_balance, 'points_balance': points_balance}


@router.get('/points/transactions')
async def my_points_transactions(user: dict = Depends(require_active_player)):
    txs = await db.points_transactions.find({'user_id': user['id']}, {'_id': 0}).sort('created_at', -1).to_list(200)
    return {'transactions': serialize_doc(txs)}


@router.post('/chips/request')
async def create_chip_request(body: ChipRequestCreate, user: dict = Depends(require_active_player)):
    if user.get('role') == 'ADMIN':
        raise HTTPException(status_code=400, detail='Admins do not request chips')
    pending = await db.chip_requests.count_documents({'user_id': user['id'], 'status': 'PENDING', 'type': {'$ne': 'SELL'}})
    if pending >= 3:
        raise HTTPException(status_code=429, detail='You already have 3 pending requests. Please wait for review.')
    req = {
        'id': str(uuid.uuid4()), 'user_id': user['id'],
        'user_email': user['email'], 'user_display_name': user.get('display_name'),
        'type': 'BUY',
        'amount': body.amount, 'note': body.note, 'status': 'PENDING',
        'admin_note': None, 'created_at': _now(), 'resolved_at': None,
    }
    await db.chip_requests.insert_one(req)
    return {'message': 'Chip request submitted for review.', 'request': serialize_doc(req)}


@router.post('/chips/sell-request')
async def create_sell_request(body: SellChipsRequestCreate, user: dict = Depends(require_active_player)):
    """Player asks the operator to sell chips for points (1:1).
    Chips stay in the balance until the admin approves the request."""
    if user.get('role') == 'ADMIN':
        raise HTTPException(status_code=400, detail='Admins do not sell chips')
    pending = await db.chip_requests.count_documents({'user_id': user['id'], 'status': 'PENDING', 'type': 'SELL'})
    if pending >= 3:
        raise HTTPException(status_code=429, detail='You already have 3 pending sell requests. Please wait for review.')
    fresh = await db.users.find_one({'id': user['id']})
    balance = fresh.get('chip_balance', 0) if fresh else 0
    if balance < body.amount:
        raise HTTPException(status_code=400, detail='Not enough chips — you can only sell up to your current balance.')
    req = {
        'id': str(uuid.uuid4()), 'user_id': user['id'],
        'user_email': user['email'], 'user_display_name': user.get('display_name'),
        'type': 'SELL',
        'amount': body.amount, 'note': body.note, 'status': 'PENDING',
        'admin_note': None, 'created_at': _now(), 'resolved_at': None,
    }
    await db.chip_requests.insert_one(req)
    return {'message': 'Sell request submitted — an operator will review it. Chips are deducted only on approval.', 'request': serialize_doc(req)}


@router.post('/chips/return-request')
async def create_return_request(body: ReturnChipsRequestCreate, user: dict = Depends(require_active_player)):
    """Player asks the operator to return chips to the admin. Chips are deducted
    only when the admin approves the request (nothing is credited back)."""
    if user.get('role') == 'ADMIN':
        raise HTTPException(status_code=400, detail='Admins do not return chips')
    pending = await db.chip_requests.count_documents({'user_id': user['id'], 'status': 'PENDING', 'type': 'RETURN'})
    if pending >= 3:
        raise HTTPException(status_code=429, detail='You already have 3 pending return requests. Please wait for review.')
    fresh = await db.users.find_one({'id': user['id']})
    balance = fresh.get('chip_balance', 0) if fresh else 0
    if balance < body.amount:
        raise HTTPException(status_code=400, detail='Not enough chips — you can only return up to your current balance.')
    req = {
        'id': str(uuid.uuid4()), 'user_id': user['id'],
        'user_email': user['email'], 'user_display_name': user.get('display_name'),
        'type': 'RETURN',
        'amount': body.amount, 'note': body.note, 'status': 'PENDING',
        'admin_note': None, 'created_at': _now(), 'resolved_at': None,
    }
    await db.chip_requests.insert_one(req)
    return {'message': 'Return request submitted — an operator will review it. Chips are deducted only on approval.', 'request': serialize_doc(req)}


@router.get('/chips/requests')
async def my_chip_requests(user: dict = Depends(require_active_player)):
    reqs = await db.chip_requests.find({'user_id': user['id']}, {'_id': 0}).sort('created_at', -1).to_list(100)
    return {'requests': serialize_doc(reqs)}


@router.get('/chips/transactions')
async def my_transactions(user: dict = Depends(require_active_player)):
    txs = await db.chip_transactions.find({'user_id': user['id']}, {'_id': 0}).sort('created_at', -1).to_list(200)
    return {'transactions': serialize_doc(txs)}


# ---------- Support / messaging (available to every signed-in user) ----------
@router.get('/support/thread')
async def support_thread(user: dict = Depends(get_current_user)):
    """This user's full conversation with the admin. Marks admin replies read."""
    msgs = await db.support_messages.find({'user_id': user['id']}, {'_id': 0}).sort('created_at', 1).to_list(500)
    await db.support_messages.update_many(
        {'user_id': user['id'], 'sender': 'ADMIN', 'read_user': False}, {'$set': {'read_user': True}})
    return {'messages': serialize_doc(msgs)}


@router.get('/support/unread')
async def support_unread(user: dict = Depends(get_current_user)):
    n = await db.support_messages.count_documents({'user_id': user['id'], 'sender': 'ADMIN', 'read_user': False})
    return {'unread': n}


@router.post('/support/message')
async def support_send(body: SupportMessageCreate, user: dict = Depends(get_current_user)):
    recent = await db.support_messages.count_documents({
        'user_id': user['id'], 'sender': 'USER',
        'created_at': {'$gte': (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()},
    })
    if recent >= 8:
        raise HTTPException(status_code=429, detail='Please slow down — too many messages in a short time.')
    msg = {
        'id': str(uuid.uuid4()), 'user_id': user['id'],
        'user_email': user['email'], 'user_display_name': user.get('display_name') or user['email'].split('@')[0],
        'sender': 'USER', 'body': body.body.strip(),
        'read_admin': False, 'read_user': True, 'created_at': _now(),
    }
    await db.support_messages.insert_one(msg)
    return {'message': 'Sent', 'item': serialize_doc(msg)}


# ---------- Announcements ----------
@router.get('/announcements')
async def announcements(user: dict = Depends(get_current_user)):
    await check_maintenance_for_players(user)
    items = await db.announcements.find({'active': True}, {'_id': 0}).sort([('pinned', -1), ('created_at', -1)]).to_list(100)
    return {'announcements': serialize_doc(items)}


# ---------- Notifications ----------
@router.get('/notifications')
async def notifications(user: dict = Depends(get_current_user)):
    items = await db.notifications.find({'user_id': user['id']}, {'_id': 0}).sort('created_at', -1).to_list(100)
    unread = sum(1 for i in items if not i.get('read'))
    return {'notifications': serialize_doc(items), 'unread_count': unread}


@router.post('/notifications/{notification_id}/read')
async def mark_read(notification_id: str, user: dict = Depends(get_current_user)):
    result = await db.notifications.update_one({'id': notification_id, 'user_id': user['id']}, {'$set': {'read': True}})
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail='Notification not found')
    return {'message': 'Marked as read'}


@router.post('/notifications/read-all')
async def mark_all_read(user: dict = Depends(get_current_user)):
    await db.notifications.update_many({'user_id': user['id']}, {'$set': {'read': True}})
    return {'message': 'All notifications marked as read'}


# ---------- Settings / profile ----------
@router.patch('/settings')
async def update_settings(body: SettingsUpdate, user: dict = Depends(get_current_user)):
    updates = {f'settings.{k}': v for k, v in body.model_dump(exclude_none=True).items()}
    if updates:
        await db.users.update_one({'id': user['id']}, {'$set': updates})
    fresh = await db.users.find_one({'id': user['id']})
    return {'settings': fresh.get('settings', {})}
