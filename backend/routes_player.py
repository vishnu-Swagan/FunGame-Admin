"""Player routes: onboarding, games, chips, announcements, notifications, settings, system config."""
import asyncio
import os
import re
import uuid
import logging
from datetime import datetime, timezone, timedelta
from fastapi import APIRouter, HTTPException, Depends, File, Query, Response, UploadFile
from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError
from db import db, serialize_doc
from models import (OnboardingProfileRequest, PlayerAvatarSelection, PlayerProfileUpdate, ChipRequestCreate, SellChipsRequestCreate, SettingsUpdate,
                    ConvertRequest, ReturnChipsRequestCreate, SupportMessageCreate)
from avatar_service import (
    ALLOWED_UPLOAD_CONTENT_TYPES,
    CARTOON_AVATAR_KEYS,
    LEGACY_AVATAR_KEYS,
    MAX_UPLOAD_BYTES,
    PLAYER_AVATAR_KEYS,
    AvatarImageError,
    deterministic_avatar_key,
    normalize_uploaded_avatar,
    preset_asset_path,
    upload_id_for_user,
    uploaded_avatar_path,
)
from auth_utils import (
    check_maintenance_for_players,
    public_user,
    require_active_player,
    require_legacy_chip_mutation_allowed,
    require_legacy_chip_requests_enabled,
    require_password_ready_user,
)
from game_access import (
    normalise_game_slug,
    project_catalogue_game,
    require_playable_game,
)
from ledger import credit_chips, debit_chips, InsufficientChips
import compliance
import ledger

logger = logging.getLogger('player')
router = APIRouter(tags=['player'])

_avatar_storage_ready = False
_avatar_storage_lock = asyncio.Lock()

PUBLIC_GAME_STATUSES = ('ENABLED', 'COMING_SOON', 'MAINTENANCE', 'UPDATE_REQUIRED')
GAME_ART_BASE_URL = os.environ.get(
    'GAME_ART_BASE_URL', 'https://fungame-web.onrender.com/game-art'
).rstrip('/')


def _now():
    return datetime.now(timezone.utc).isoformat()


def _allow_nontransactional_auth_tests() -> bool:
    return (
        (os.environ.get('APP_ENV') or '').strip().lower() == 'test'
        and (os.environ.get('AUTH_ALLOW_NON_TRANSACTIONAL_TESTS') or '').strip().lower() == 'true'
    )


async def _run_onboarding_transaction(callback):
    """Commit onboarding state and its user notification as one unit."""
    try:
        session_cm = await db.client.start_session()
    except Exception as exc:
        if (_allow_nontransactional_auth_tests()
                and isinstance(exc, (AttributeError, NotImplementedError))):
            return await callback(None)
        logger.error('Onboarding transaction unavailable: %s', type(exc).__name__)
        raise HTTPException(status_code=503, detail={
            'code': 'ACCOUNT_TRANSACTIONS_UNAVAILABLE',
            'message': 'Onboarding is temporarily unavailable.',
        }) from exc
    try:
        async with session_cm as session:
            return await session.with_transaction(callback)
    except HTTPException:
        raise
    except Exception as exc:
        logger.error('Onboarding transaction failed: %s', type(exc).__name__)
        raise HTTPException(status_code=503, detail={
            'code': 'ACCOUNT_TRANSACTIONS_UNAVAILABLE',
            'message': 'Onboarding is temporarily unavailable.',
        }) from exc


async def _notify(user_id: str, title: str, body: str, ntype: str = 'INFO', *, session=None):
    kwargs = {'session': session} if session is not None else {}
    await db.notifications.insert_one({
        'id': str(uuid.uuid4()), 'user_id': user_id, 'title': title, 'body': body,
        'type': ntype, 'read': False, 'created_at': _now(),
    }, **kwargs)


def _requester_contact(user: dict) -> dict:
    """Snapshot a real display contact for CRM request queues.

    Phone registrations carry a non-routable compatibility email internally;
    never expose that synthetic address to an operator as user contact data.
    """
    email = user.get('email')
    if str(email or '').endswith('.phone.invalid'):
        email = None
    return {
        'user_email': email,
        'user_phone': user.get('phone'),
    }


async def _run_chip_request_transaction(callback):
    """Reserve pending-request capacity and create the request atomically."""
    try:
        session_cm = await db.client.start_session()
    except Exception as exc:
        if (_allow_nontransactional_auth_tests()
                and isinstance(exc, (AttributeError, NotImplementedError))):
            return await callback(None)
        logger.error('Chip request transaction unavailable: %s', type(exc).__name__)
        raise HTTPException(status_code=503, detail={
            'code': 'CHIP_REQUESTS_UNAVAILABLE',
            'message': 'Legacy promotional balance requests are unavailable.',
        }) from exc
    try:
        async with session_cm as session:
            return await session.with_transaction(callback)
    except HTTPException:
        raise
    except Exception as exc:
        logger.error('Chip request transaction failed: %s', type(exc).__name__)
        raise HTTPException(status_code=503, detail={
            'code': 'CHIP_REQUESTS_UNAVAILABLE',
            'message': 'Legacy promotional balance requests are unavailable.',
        }) from exc


async def _create_chip_request_with_cap(req: dict, request_type: str) -> dict:
    """Atomically enforce the three-pending-request cap per player and type.

    The deterministic counter document serializes concurrent submissions. Its
    first value includes legacy pending rows written before counters existed.
    Admin approval/denial releases the reservation using the key stored on the
    request.
    """
    counter_key = f"chip-request:{req['user_id']}:{request_type}"
    req['pending_counter_key'] = counter_key

    async def reserve_and_insert(session):
        kwargs = {'session': session} if session is not None else {}
        counter = await db.chip_request_pending_counters.find_one(
            {'_id': counter_key}, **kwargs,
        )
        if not counter:
            legacy_query = {
                'user_id': req['user_id'],
                'status': 'PENDING',
            }
            if request_type == 'BUY':
                legacy_query['$or'] = [
                    {'type': 'BUY'}, {'type': None}, {'type': {'$exists': False}},
                ]
            else:
                legacy_query['type'] = request_type
            legacy_count = min(
                3,
                await db.chip_requests.count_documents(legacy_query, **kwargs),
            )
            counter = {
                '_id': counter_key,
                'user_id': req['user_id'],
                'request_type': request_type,
                'count': legacy_count,
                'created_at': _now(),
                'updated_at': _now(),
            }
            try:
                await db.chip_request_pending_counters.insert_one(counter, **kwargs)
            except DuplicateKeyError:
                # Non-transactional test doubles can interleave here. A real
                # transaction aborts/retries the callback on this write race.
                if session is not None:
                    raise

        reserved = await db.chip_request_pending_counters.find_one_and_update(
            {'_id': counter_key, 'count': {'$lt': 3}},
            {'$inc': {'count': 1}, '$set': {'updated_at': _now()}},
            return_document=ReturnDocument.AFTER,
            **kwargs,
        )
        if not reserved:
            raise HTTPException(
                status_code=429,
                detail='You already have 3 pending requests of this type. Please wait for review.',
            )
        await db.chip_requests.insert_one(req, **kwargs)
        return req

    return await _run_chip_request_transaction(reserve_and_insert)


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
        'disclaimer': '18+ | PLAY RESPONSIBLY | TERMS APPLY',
    }


# ---------- Onboarding ----------
def _onboarding_state_conflict(current: dict | None):
    if not current or current.get('role') != 'PLAYER':
        raise HTTPException(status_code=403, detail='Player onboarding is required')
    if current.get('status') in ('ACTIVE', 'SUSPENDED'):
        raise HTTPException(status_code=409, detail={
            'code': 'ACCOUNT_STATE_CHANGED',
            'message': 'Account review has already changed this profile.',
        })
    raise HTTPException(status_code=409, detail={
        'code': 'ACCOUNT_STATE_CHANGED',
        'message': 'Account state changed. Refresh and try again.',
    })


@router.post('/onboarding/profile')
async def onboarding_profile(body: OnboardingProfileRequest, user: dict = Depends(require_password_ready_user)):
    if user.get('role') != 'PLAYER':
        raise HTTPException(status_code=403, detail='Player onboarding is required')
    if not (user.get('contact_verified') or user.get('email_verified')
            or user.get('phone_verified')):
        raise HTTPException(status_code=403, detail='Verify your contact method first')
    allowed_statuses = ('VERIFIED', 'PROFILE_SUBMITTED', 'PENDING', 'REJECTED')
    if user.get('status') not in allowed_statuses:
        raise HTTPException(status_code=400, detail='Onboarding already completed')
    # Country and date of birth are entered here, so this is where market and
    # age are decided — the earliest point the answer can be known, and the
    # point the player can still correct a typo. A date of birth the operator
    # has not recorded yet is not a refusal; it is a row in the compliance
    # review.
    ok, code, message = await compliance.check_eligibility(
        body.country, body.date_of_birth or user.get('date_of_birth'), require_dob=False)
    if not ok:
        raise HTTPException(status_code=403, detail={'code': code, 'message': message})
    updated = await db.users.find_one_and_update(
        {
            'id': user['id'],
            'role': 'PLAYER',
            'status': user.get('status'),
            '$or': [
                {'contact_verified': True},
                {'email_verified': True},
                {'phone_verified': True},
            ],
        },
        {'$set': {
            'display_name': body.display_name.strip(),
            'country': body.country.strip(),
            'date_of_birth': body.date_of_birth,
            'avatar': body.avatar,
            'accepted_terms': True,
            'status': 'PROFILE_SUBMITTED',
        }},
        return_document=ReturnDocument.AFTER,
    )
    if not updated:
        _onboarding_state_conflict(await db.users.find_one({'id': user['id']}))
    return {'message': 'Profile saved. Review and submit for approval.', 'user': serialize_doc(updated)}


@router.post('/onboarding/submit')
async def onboarding_submit(user: dict = Depends(require_password_ready_user)):
    if user.get('role') != 'PLAYER':
        raise HTTPException(status_code=403, detail='Player onboarding is required')
    if not (user.get('contact_verified') or user.get('email_verified')
            or user.get('phone_verified')):
        raise HTTPException(status_code=403, detail='Verify your contact method first')
    if user.get('status') == 'ACTIVE':
        raise HTTPException(status_code=400, detail='Already approved')
    if user.get('status') not in ('PROFILE_SUBMITTED', 'PENDING', 'REJECTED'):
        raise HTTPException(status_code=400, detail='Complete your profile first')
    async def commit_submission(session):
        kwargs = {'session': session} if session is not None else {}
        updated = await db.users.find_one_and_update(
            {
                'id': user['id'],
                'role': 'PLAYER',
                'status': user.get('status'),
                '$or': [
                    {'contact_verified': True},
                    {'email_verified': True},
                    {'phone_verified': True},
                ],
            },
            {'$set': {'status': 'PENDING', 'submitted_at': _now()}},
            return_document=ReturnDocument.AFTER,
            **kwargs,
        )
        if not updated:
            _onboarding_state_conflict(await db.users.find_one(
                {'id': user['id']}, **kwargs,
            ))
        await _notify(
            user['id'], 'Onboarding submitted',
            'Your profile is under review. You will be notified once an operator approves your account.',
            'ONBOARDING', session=session,
        )
        return updated

    updated = await _run_onboarding_transaction(commit_submission)
    return {'message': 'Submitted for review. An operator will approve your account shortly.', 'user': serialize_doc(updated)}


@router.get('/onboarding/status')
async def onboarding_status(user: dict = Depends(require_password_ready_user)):
    if user.get('role') != 'PLAYER':
        raise HTTPException(status_code=403, detail='Player onboarding is required')
    return {
        'status': user.get('status'),
        'rejection_reason': user.get('rejection_reason'),
        'user': public_user(user),
    }


# ---------- Games ----------
@router.get('/catalog/games')
async def public_game_catalog(response: Response):
    """Read-only public projection of the CRM-managed game catalogue.

    The marketing site needs current publication state and artwork references,
    not a player session and never an admin or database credential.  Keeping the
    projection here makes that boundary explicit and ensures private game,
    account, wallet, round, and CRM fields cannot leak through serialization.
    """
    response.headers['Cache-Control'] = 'public, max-age=30, s-maxage=60, stale-while-revalidate=300'
    games = await db.games.find(
        {'status': {'$in': list(PUBLIC_GAME_STATUSES)}},
        {
            '_id': 0,
            'slug': 1,
            'name': 1,
            'category': 1,
            'tagline': 1,
            'description': 1,
            'status': 1,
            'featured': 1,
            'order': 1,
            'updated_at': 1,
        },
    ).sort('order', 1).to_list(100)

    public_games = []
    for game in games:
        game = project_catalogue_game(game)
        slug = str(game.get('slug', '')).strip().lower()
        name = str(game.get('name', '')).strip()
        if not re.fullmatch(r'[a-z0-9-]{1,100}', slug) or not name:
            continue
        try:
            display_order = int(game.get('order', 0))
        except (TypeError, ValueError):
            display_order = 0
        public_games.append({
            'slug': slug,
            'name': name,
            'category': str(game.get('category') or 'Games'),
            'tagline': str(game.get('tagline') or ''),
            'description': str(game.get('description') or ''),
            'status': game.get('status'),
            'featured': bool(game.get('featured', False)),
            'order': display_order,
            'artwork_url': f'{GAME_ART_BASE_URL}/{slug}.png',
            'updated_at': game.get('updated_at'),
        })

    return {
        'source': 'Chakri CRM game database',
        'games': public_games,
        'count': len(public_games),
        'retrieved_at': _now(),
    }


@router.get('/games')
async def list_games(user: dict = Depends(require_active_player)):
    games = await db.games.find({}, {'_id': 0}).sort('order', 1).to_list(100)
    games = [project_catalogue_game(game) for game in games]
    fresh = await db.users.find_one({'id': user['id']})
    favorites = fresh.get('favorites', []) if fresh else []
    recent = fresh.get('recent_games', []) if fresh else []
    return {'games': serialize_doc(games), 'favorites': favorites, 'recent': recent}


@router.get('/games/{slug}')
async def game_detail(slug: str, user: dict = Depends(require_active_player)):
    canonical_slug = normalise_game_slug(slug)
    game = await require_playable_game(canonical_slug)
    # track recently viewed (max 10, most recent first)
    recent = [s for s in user.get('recent_games', []) if s != canonical_slug]
    recent.insert(0, canonical_slug)
    await db.users.update_one({'id': user['id']}, {'$set': {'recent_games': recent[:10]}})
    is_fav = canonical_slug in user.get('favorites', [])
    return {'game': serialize_doc(game), 'is_favorite': is_fav}


@router.post('/games/{slug}/favorite')
async def toggle_favorite(slug: str, user: dict = Depends(require_active_player)):
    canonical_slug = normalise_game_slug(slug)
    await require_playable_game(canonical_slug)
    favs = user.get('favorites', [])
    if canonical_slug in favs:
        favs = [f for f in favs if f != canonical_slug]
        action = 'removed'
    else:
        favs = favs + [canonical_slug]
        action = 'added'
    await db.users.update_one({'id': user['id']}, {'$set': {'favorites': favs}})
    return {'favorites': favs, 'action': action}


# NOTE: gameplay endpoints (play/cashout/draw/history) live in routes_games.py


# ---------- Player balance (legacy API path retained for compatibility) ----------
@router.get('/chips/balance')
async def chip_balance(user: dict = Depends(require_active_player)):
    fresh = await db.users.find_one({'id': user['id']})
    return {
        'balance': fresh.get('chip_balance', 0),
        'points': fresh.get('points_balance', 0),
        'disclaimer': '18+ | PLAY RESPONSIBLY | TERMS APPLY',
    }


@router.post('/chips/convert')
async def convert_chips_points(body: ConvertRequest, user: dict = Depends(require_active_player)):
    """Legacy points conversion. Disabled when the source-aware wallet is in use."""
    require_legacy_chip_mutation_allowed()
    if user.get('role') == 'ADMIN':
        raise HTTPException(status_code=400, detail='Admins do not convert player balances')
    uid = user['id']
    if body.direction == 'CHIPS_TO_POINTS':
        raise HTTPException(
            status_code=400,
            detail='Converting promotional balance to points requires operator approval. Please submit a legacy balance request instead.',
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
        'balance_after': points_balance, 'note': f'Converted {body.amount} points to promotional balance (1:1)',
        'ref': 'convert', 'created_at': _now(),
    })
    chip_balance = await credit_chips(uid, body.amount, f'Converted {body.amount} points to promotional balance (1:1)', ref='convert', kind=ledger.DEPOSIT)
    message = f'Converted {body.amount} points. {body.amount} promotional balance units were credited.'
    return {'message': message, 'chip_balance': chip_balance, 'points_balance': points_balance}


@router.get('/points/transactions')
async def my_points_transactions(user: dict = Depends(require_active_player)):
    txs = await db.points_transactions.find({'user_id': user['id']}, {'_id': 0}).sort('created_at', -1).to_list(200)
    return {'transactions': serialize_doc(txs)}


@router.post('/chips/request')
async def create_chip_request(body: ChipRequestCreate, user: dict = Depends(require_active_player)):
    require_legacy_chip_requests_enabled()
    if user.get('role') == 'ADMIN':
        raise HTTPException(status_code=400, detail='Admins do not request promotional balance')
    # Checked when the request is made so the player is told now, and again at
    # approval so an operator cannot wave through what the limit refuses.
    await compliance.check_deposit(user['id'], body.amount)
    req = {
        'id': str(uuid.uuid4()), 'user_id': user['id'],
        **_requester_contact(user),
        'user_display_name': user.get('display_name'),
        'type': 'BUY',
        'amount': body.amount, 'note': body.note, 'status': 'PENDING',
        'admin_note': None, 'created_at': _now(), 'resolved_at': None,
    }
    req = await _create_chip_request_with_cap(req, 'BUY')
    return {'message': 'Legacy promotional balance request submitted for review.', 'request': serialize_doc(req)}


@router.post('/chips/sell-request')
async def create_sell_request(body: SellChipsRequestCreate, user: dict = Depends(require_active_player)):
    """Player asks the operator to sell chips for points (1:1).
    Chips stay in the balance until the admin approves the request."""
    require_legacy_chip_requests_enabled()
    if user.get('role') == 'ADMIN':
        raise HTTPException(status_code=400, detail='Admins do not convert promotional balance')
    fresh = await db.users.find_one({'id': user['id']})
    balance = fresh.get('chip_balance', 0) if fresh else 0
    if balance < body.amount:
        raise HTTPException(status_code=400, detail='Not enough promotional balance for this legacy conversion request.')
    req = {
        'id': str(uuid.uuid4()), 'user_id': user['id'],
        **_requester_contact(user),
        'user_display_name': user.get('display_name'),
        'type': 'SELL',
        'amount': body.amount, 'note': body.note, 'status': 'PENDING',
        'admin_note': None, 'created_at': _now(), 'resolved_at': None,
    }
    req = await _create_chip_request_with_cap(req, 'SELL')
    return {'message': 'Legacy conversion request submitted for operator review. The promotional balance changes only after approval.', 'request': serialize_doc(req)}


@router.post('/chips/return-request')
async def create_return_request(body: ReturnChipsRequestCreate, user: dict = Depends(require_active_player)):
    """Player asks the operator to return chips to the admin. Chips are deducted
    only when the admin approves the request (nothing is credited back)."""
    require_legacy_chip_requests_enabled()
    if user.get('role') == 'ADMIN':
        raise HTTPException(status_code=400, detail='Admins do not return promotional balance')
    fresh = await db.users.find_one({'id': user['id']})
    balance = fresh.get('chip_balance', 0) if fresh else 0
    if balance < body.amount:
        raise HTTPException(status_code=400, detail='Not enough promotional balance for this legacy return request.')
    req = {
        'id': str(uuid.uuid4()), 'user_id': user['id'],
        **_requester_contact(user),
        'user_display_name': user.get('display_name'),
        'type': 'RETURN',
        'amount': body.amount, 'note': body.note, 'status': 'PENDING',
        'admin_note': None, 'created_at': _now(), 'resolved_at': None,
    }
    req = await _create_chip_request_with_cap(req, 'RETURN')
    return {'message': 'Legacy balance return submitted for operator review. The promotional balance changes only after approval.', 'request': serialize_doc(req)}


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
async def support_thread(user: dict = Depends(require_password_ready_user)):
    """This user's full conversation with the admin. Marks admin replies read."""
    msgs = await db.support_messages.find({'user_id': user['id']}, {'_id': 0}).sort('created_at', 1).to_list(500)
    await db.support_messages.update_many(
        {'user_id': user['id'], 'sender': 'ADMIN', 'read_user': False}, {'$set': {'read_user': True}})
    return {'messages': serialize_doc(msgs)}


@router.get('/support/unread')
async def support_unread(user: dict = Depends(require_password_ready_user)):
    n = await db.support_messages.count_documents({'user_id': user['id'], 'sender': 'ADMIN', 'read_user': False})
    return {'unread': n}


@router.post('/support/message')
async def support_send(body: SupportMessageCreate, user: dict = Depends(require_password_ready_user)):
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
async def announcements(user: dict = Depends(require_password_ready_user)):
    await check_maintenance_for_players(user)
    items = await db.announcements.find({'active': True}, {'_id': 0}).sort([('pinned', -1), ('created_at', -1)]).to_list(100)
    return {'announcements': serialize_doc(items)}


# ---------- Notifications ----------
@router.get('/notifications')
async def notifications(user: dict = Depends(require_password_ready_user)):
    items = await db.notifications.find({'user_id': user['id']}, {'_id': 0}).sort('created_at', -1).to_list(100)
    unread = sum(1 for i in items if not i.get('read'))
    return {'notifications': serialize_doc(items), 'unread_count': unread}


@router.post('/notifications/{notification_id}/read')
async def mark_read(notification_id: str, user: dict = Depends(require_password_ready_user)):
    result = await db.notifications.update_one({'id': notification_id, 'user_id': user['id']}, {'$set': {'read': True}})
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail='Notification not found')
    return {'message': 'Marked as read'}


@router.post('/notifications/read-all')
async def mark_all_read(user: dict = Depends(require_password_ready_user)):
    await db.notifications.update_many({'user_id': user['id']}, {'$set': {'read': True}})
    return {'message': 'All notifications marked as read'}


# ---------- Settings / profile ----------
def _require_active_profile_player(user: dict) -> None:
    if user.get('role') != 'PLAYER' or user.get('status') != 'ACTIVE':
        raise HTTPException(status_code=403, detail={
            'code': 'ACTIVE_PLAYER_REQUIRED',
            'message': 'An active player account is required.',
        })


def _avatar_profile_projection() -> dict:
    return {
        '_id': 0,
        'display_name': 1,
        'avatar': 1,
        'avatar_source': 1,
        'avatar_upload_id': 1,
        'avatar_url': 1,
        'profile_updated_at': 1,
    }


async def _ensure_avatar_storage() -> None:
    """Create the public-id lookup once per API worker before first upload."""
    global _avatar_storage_ready
    if _avatar_storage_ready:
        return
    async with _avatar_storage_lock:
        if _avatar_storage_ready:
            return
        try:
            await db.avatar_uploads.create_index('id', unique=True)
        except Exception as exc:
            logger.error('Avatar upload storage is unavailable: %s', type(exc).__name__)
            raise HTTPException(status_code=503, detail={
                'code': 'AVATAR_STORAGE_UNAVAILABLE',
                'message': 'Avatar uploads are temporarily unavailable.',
            }) from exc
        _avatar_storage_ready = True


async def _restore_avatar_upload(user_id: str, previous: dict | None) -> None:
    """Restore the bounded upload row after a failed profile-state change."""
    try:
        if previous:
            await db.avatar_uploads.replace_one({'_id': user_id}, previous, upsert=True)
        else:
            await db.avatar_uploads.delete_one({'_id': user_id})
    except Exception as exc:  # the users document still keeps the new row private
        logger.error('Avatar upload rollback failed for %s: %s', user_id, type(exc).__name__)


async def _select_preset_avatar(avatar: str, user: dict) -> dict:
    _require_active_profile_player(user)
    now = _now()
    fresh = await db.users.find_one_and_update(
        {'id': user['id'], 'role': 'PLAYER', 'status': 'ACTIVE'},
        {
            '$set': {
                'avatar': avatar,
                'avatar_source': 'PRESET',
                'profile_updated_at': now,
            },
            '$unset': {
                'avatar_upload_id': '',
                'avatar_url': '',
            },
        },
        projection=_avatar_profile_projection(),
        return_document=ReturnDocument.AFTER,
    )
    if not fresh:
        raise HTTPException(status_code=409, detail={
            'code': 'ACCOUNT_STATE_CHANGED',
            'message': 'The player account changed. Refresh and try again.',
        })
    # The users document is the source of truth for public visibility. Cleanup
    # is best effort so a transient storage error cannot turn a successful
    # profile update into a misleading API failure; at most one dormant row can
    # exist because its Mongo _id is the user id.
    try:
        await db.avatar_uploads.delete_one({'_id': user['id']})
    except Exception as exc:  # noqa: BLE001 - bounded orphan is not user-facing failure
        logger.warning('Avatar upload cleanup failed for %s: %s', user['id'], type(exc).__name__)
    return fresh


@router.get('/profile/avatars')
async def list_profile_avatars(user: dict = Depends(require_password_ready_user)):
    """Return the selectable local catalogue and current avatar descriptor."""
    if user.get('role') != 'PLAYER':
        raise HTTPException(status_code=403, detail='Player profile is required')
    return {
        'presets': [
            {'key': key, 'asset_path': preset_asset_path(key)}
            for key in CARTOON_AVATAR_KEYS
        ],
        # Older profiles remain valid and editable during the visual rollout.
        'legacy_keys': sorted(LEGACY_AVATAR_KEYS),
        'upload': {
            'allowed_content_types': sorted(ALLOWED_UPLOAD_CONTENT_TYPES),
            'max_bytes': MAX_UPLOAD_BYTES,
            'output_content_type': 'image/webp',
        },
        'current': {
            'key': user.get('avatar') or deterministic_avatar_key(user['id']),
            'source': user.get('avatar_source') or 'PRESET',
            'url': user.get('avatar_url'),
        },
    }


@router.put('/profile/avatar')
async def select_profile_avatar(
        body: PlayerAvatarSelection,
        user: dict = Depends(require_password_ready_user)):
    fresh = await _select_preset_avatar(body.avatar, user)
    return {'message': 'Avatar updated.', 'profile': serialize_doc(fresh)}


async def _read_avatar_upload(file: UploadFile) -> bytes:
    content_type = str(file.content_type or '').split(';', 1)[0].strip().lower()
    if content_type not in ALLOWED_UPLOAD_CONTENT_TYPES:
        raise HTTPException(status_code=415, detail={
            'code': 'AVATAR_FILE_TYPE_UNSUPPORTED',
            'message': 'Upload a JPEG, PNG, or WebP image.',
        })
    chunks = []
    total = 0
    while True:
        chunk = await file.read(min(64 * 1024, MAX_UPLOAD_BYTES + 1 - total))
        if not chunk:
            break
        total += len(chunk)
        if total > MAX_UPLOAD_BYTES:
            raise HTTPException(status_code=413, detail={
                'code': 'AVATAR_FILE_TOO_LARGE',
                'message': 'The avatar image must be 5 MB or smaller.',
            })
        chunks.append(chunk)
    return b''.join(chunks)


@router.post('/profile/avatar/upload')
async def upload_profile_avatar(
        file: UploadFile = File(...),
        user: dict = Depends(require_password_ready_user)):
    """Normalize one player image and persist it in Mongo-backed storage."""
    _require_active_profile_player(user)
    try:
        payload = await _read_avatar_upload(file)
        normalized = await asyncio.to_thread(
            normalize_uploaded_avatar, payload, file.content_type,
        )
    except AvatarImageError as exc:
        raise HTTPException(status_code=422, detail={
            'code': 'AVATAR_IMAGE_INVALID',
            'message': str(exc),
        }) from exc
    finally:
        await file.close()

    await _ensure_avatar_storage()
    upload_id = upload_id_for_user(user['id'])
    avatar_url = (
        f'{uploaded_avatar_path(upload_id)}'
        f'?v={normalized["sha256"][:12]}'
    )
    now = _now()
    previous = await db.avatar_uploads.find_one({'_id': user['id']})
    upload_doc = {
        '_id': user['id'],
        'id': upload_id,
        'user_id': user['id'],
        'content': normalized['data'],
        'content_type': normalized['content_type'],
        'size': normalized['size'],
        'width': normalized['width'],
        'height': normalized['height'],
        'sha256': normalized['sha256'],
        'created_at': previous.get('created_at') if previous else now,
        'updated_at': now,
    }
    await db.avatar_uploads.replace_one({'_id': user['id']}, upload_doc, upsert=True)

    fallback_key = user.get('avatar')
    if fallback_key not in PLAYER_AVATAR_KEYS:
        fallback_key = deterministic_avatar_key(user['id'])
    try:
        fresh = await db.users.find_one_and_update(
            {'id': user['id'], 'role': 'PLAYER', 'status': 'ACTIVE'},
            {'$set': {
                'avatar': fallback_key,
                'avatar_source': 'UPLOAD',
                'avatar_upload_id': upload_id,
                # Relative to the canonical API origin. Clients already know that
                # origin from their authenticated API configuration.
                'avatar_url': avatar_url,
                'profile_updated_at': now,
            }},
            projection=_avatar_profile_projection(),
            return_document=ReturnDocument.AFTER,
        )
    except Exception:
        await _restore_avatar_upload(user['id'], previous)
        raise
    if not fresh:
        await _restore_avatar_upload(user['id'], previous)
        raise HTTPException(status_code=409, detail={
            'code': 'ACCOUNT_STATE_CHANGED',
            'message': 'The player account changed. Refresh and try again.',
        })
    return {
        'message': 'Avatar image updated.',
        'profile': serialize_doc(fresh),
    }


@router.get('/avatars/uploads/{upload_id}')
async def uploaded_avatar(upload_id: str):
    """Serve only an upload that is still selected by its owning player."""
    try:
        uploaded_avatar_path(upload_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail='Avatar not found') from exc
    row = await db.avatar_uploads.find_one({'id': upload_id})
    if not row:
        raise HTTPException(status_code=404, detail='Avatar not found')
    owner = await db.users.find_one({
        'id': row.get('user_id'),
        'role': 'PLAYER',
        'avatar_source': 'UPLOAD',
        'avatar_upload_id': upload_id,
    }, {'_id': 1})
    if not owner:
        raise HTTPException(status_code=404, detail='Avatar not found')
    return Response(
        content=bytes(row['content']),
        media_type='image/webp',
        headers={
            'Cache-Control': 'public, max-age=300',
            'ETag': f'"{row["sha256"]}"',
            'X-Content-Type-Options': 'nosniff',
        },
    )


@router.patch('/profile')
async def update_profile(body: PlayerProfileUpdate, user: dict = Depends(require_password_ready_user)):
    """Edit only the public game identity of an active player.

    Email, phone, country, date of birth, verification and balances are
    intentionally absent from the request model so this endpoint cannot become
    an identity, compliance or wallet mutation path.
    """
    _require_active_profile_player(user)
    updates = body.model_dump(exclude_none=True)
    if set(updates) == {'avatar'}:
        fresh = await _select_preset_avatar(updates['avatar'], user)
        return {'message': 'Game profile updated.', 'profile': serialize_doc(fresh)}
    updates['profile_updated_at'] = _now()
    mongo_update = {'$set': updates}
    choosing_preset = 'avatar' in updates
    if choosing_preset:
        updates['avatar_source'] = 'PRESET'
        mongo_update['$unset'] = {'avatar_upload_id': '', 'avatar_url': ''}
    fresh = await db.users.find_one_and_update(
        {'id': user['id'], 'role': 'PLAYER', 'status': 'ACTIVE'},
        mongo_update,
        projection=_avatar_profile_projection(),
        return_document=ReturnDocument.AFTER,
    )
    if not fresh:
        raise HTTPException(status_code=409, detail={
            'code': 'ACCOUNT_STATE_CHANGED',
            'message': 'The player account changed. Refresh and try again.',
        })
    if choosing_preset:
        try:
            await db.avatar_uploads.delete_one({'_id': user['id']})
        except Exception as exc:  # noqa: BLE001 - see _select_preset_avatar
            logger.warning('Avatar upload cleanup failed for %s: %s', user['id'], type(exc).__name__)
    return {'message': 'Game profile updated.', 'profile': serialize_doc(fresh)}


@router.patch('/settings')
async def update_settings(body: SettingsUpdate, user: dict = Depends(require_password_ready_user)):
    updates = {f'settings.{k}': v for k, v in body.model_dump(exclude_none=True).items()}
    if updates:
        await db.users.update_one({'id': user['id']}, {'$set': updates})
    fresh = await db.users.find_one({'id': user['id']})
    return {'settings': fresh.get('settings', {})}
