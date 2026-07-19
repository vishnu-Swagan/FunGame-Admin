"""Player routes: onboarding, games, chips, announcements, notifications, settings, system config."""
import uuid
import logging
from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException, Depends, Query
from db import db, serialize_doc
from models import OnboardingProfileRequest, ChipRequestCreate, SettingsUpdate
from auth_utils import get_current_user, require_active_player, check_maintenance_for_players

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
        'disclaimer': 'PLAY CHIPS — NO CASH VALUE',
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
    return {'balance': fresh.get('chip_balance', 0), 'disclaimer': 'PLAY CHIPS — NO CASH VALUE'}


@router.post('/chips/request')
async def create_chip_request(body: ChipRequestCreate, user: dict = Depends(require_active_player)):
    if user.get('role') == 'ADMIN':
        raise HTTPException(status_code=400, detail='Admins do not request chips')
    pending = await db.chip_requests.count_documents({'user_id': user['id'], 'status': 'PENDING'})
    if pending >= 3:
        raise HTTPException(status_code=429, detail='You already have 3 pending requests. Please wait for review.')
    req = {
        'id': str(uuid.uuid4()), 'user_id': user['id'],
        'user_email': user['email'], 'user_display_name': user.get('display_name'),
        'amount': body.amount, 'note': body.note, 'status': 'PENDING',
        'admin_note': None, 'created_at': _now(), 'resolved_at': None,
    }
    await db.chip_requests.insert_one(req)
    return {'message': 'Chip request submitted for review.', 'request': serialize_doc(req)}


@router.get('/chips/requests')
async def my_chip_requests(user: dict = Depends(require_active_player)):
    reqs = await db.chip_requests.find({'user_id': user['id']}, {'_id': 0}).sort('created_at', -1).to_list(100)
    return {'requests': serialize_doc(reqs)}


@router.get('/chips/transactions')
async def my_transactions(user: dict = Depends(require_active_player)):
    txs = await db.chip_transactions.find({'user_id': user['id']}, {'_id': 0}).sort('created_at', -1).to_list(200)
    return {'transactions': serialize_doc(txs)}


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
