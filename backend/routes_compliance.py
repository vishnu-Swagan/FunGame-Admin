"""Responsible play — the player's own controls, and the operator's oversight.

The player routes deliberately hang off `get_current_user` rather than
`require_active_player`. That dependency is where exclusion is enforced, so
using it here would mean an excluded player could not reach the screen that
tells them they are excluded, or the one where they ask to come back. The tools
somebody needs when they have shut themselves out have to keep working after
they have.
"""
import logging

from fastapi import APIRouter, Depends, HTTPException

import compliance
import ledger
from auth_utils import get_current_user, require_admin
from db import db, serialize_doc
from models import (LimitSet, ExclusionCreate, ComplianceConfigUpdate,
                    AgeVerify, AdminExclusion)

logger = logging.getLogger('compliance')

router = APIRouter(prefix='/responsible', tags=['responsible play'])
admin_router = APIRouter(prefix='/admin/compliance', tags=['admin compliance'])

# Typing this exactly is the last chance to notice what is being agreed to.
PERMANENT_PHRASE = 'CLOSE MY ACCOUNT PERMANENTLY'


async def _spend_summary(user_id):
    """What each period has used, whether or not a limit is set on it.

    Shown even with no limit, because seeing the number is what prompts somebody
    to set one — a limits page that is blank until you already care is a page
    for people who already care.
    """
    out = {}
    for period in compliance.PERIODS:
        out[period] = {
            'deposited': await compliance.deposits_in(user_id, period),
            'lost': await compliance.net_loss_in(user_id, period),
            'from': compliance.window_start(period),
        }
    return out


async def _require_player_target(user_id: str, projection=None):
    """Resolve an admin action target only when it is a player account.

    The admin compliance endpoints are deliberately named ``/players``.  The
    role check is also the authorization boundary that prevents an operator
    from revoking another administrator's session through a crafted request.
    """
    user = await db.users.find_one({'id': user_id, 'role': 'PLAYER'}, projection)
    if not user:
        raise HTTPException(status_code=404, detail='Player not found')
    return user


# ------------------------------------------------------------------- player

@router.get('/me')
async def my_controls(user: dict = Depends(get_current_user)):
    if user.get('role') != 'PLAYER':
        raise HTTPException(status_code=403, detail='Only players have play limits')
    exclusion = await compliance.active_exclusion(user['id'])
    cfg = await compliance.get_config()
    return {
        'limits': serialize_doc(await compliance.limits_for(user['id'])),
        'usage': await _spend_summary(user['id']),
        'exclusion': serialize_doc(exclusion),
        'increase_delay_hours': cfg['limit_increase_delay_hours'],
        'reactivation_cooling_hours': cfg['reactivation_cooling_hours'],
        'permanent_phrase': PERMANENT_PHRASE,
    }


@router.post('/limits')
async def set_my_limit(body: LimitSet, user: dict = Depends(get_current_user)):
    if user.get('role') != 'PLAYER':
        raise HTTPException(status_code=403, detail='Only players have play limits')
    try:
        result = await compliance.set_limit(
            user['id'], body.kind.upper(), body.period.upper(), body.amount, actor='PLAYER')
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if result['outcome'] == 'IMMEDIATE':
        message = 'Limit set. It applies from now.'
    else:
        message = (f"Your request is recorded and takes effect in "
                   f"{result['delay_hours']} hours. Your current limit stays in "
                   f"place until then, and you can cancel the change at any time.")
    return {'message': message, **result}


@router.delete('/limits/{kind}/{period}/pending')
async def cancel_my_pending(kind: str, period: str, user: dict = Depends(get_current_user)):
    row = await compliance.cancel_pending(user['id'], kind.upper(), period.upper())
    return {'message': 'Change cancelled. Your current limit stays in place.',
            'limit': serialize_doc(row)}


@router.post('/exclusion')
async def take_a_break(body: ExclusionCreate, user: dict = Depends(get_current_user)):
    """Start a break or self-exclude. One-way until it expires."""
    if user.get('role') != 'PLAYER':
        raise HTTPException(status_code=403, detail='Only players can self-exclude')
    kind = (body.kind or compliance.BREAK).upper()
    if body.days is None:
        # Permanent. The confirmation phrase is the point: a permanent closure
        # reached by tapping through a dialogue is one somebody will reach by
        # accident.
        if kind != compliance.SELF_EXCLUSION:
            raise HTTPException(status_code=400, detail='A break has to have a length')
        if (body.confirm or '').strip().upper() != PERMANENT_PHRASE:
            raise HTTPException(status_code=400, detail={
                'code': 'CONFIRM_REQUIRED',
                'message': f'To close permanently, type: {PERMANENT_PHRASE}',
            })
    try:
        doc = await compliance.exclude(user['id'], kind=kind, days=body.days,
                                       source='PLAYER', reason=body.reason)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    # End the session immediately. Leaving a live token would mean the account
    # keeps playing until the next request happens to hit the guard.
    await db.users.update_one({'id': user['id']}, {'$set': {
        'active_session_id': f"excluded-{doc['id']}"}})
    logger.info('player %s excluded (%s, days=%s)', user['id'], kind, body.days)
    ends = doc['ends_at']
    return {'message': ('Your account is now closed to play.'
                        + (f" It reopens after {ends[:10]}." if ends else
                           ' This closure is permanent.')),
            'exclusion': serialize_doc(doc)}


@router.post('/reactivate')
async def reactivate(user: dict = Depends(get_current_user)):
    try:
        return await compliance.request_reactivation(user['id'])
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


# -------------------------------------------------------------------- admin

@admin_router.get('/config')
async def get_config(admin: dict = Depends(require_admin)):
    cfg = await compliance.get_config()
    return {'config': cfg, 'modes': list(compliance.MARKET_MODES),
            'known_countries': sorted(set(compliance._COUNTRY_NAMES.values()))}


@admin_router.patch('/config')
async def patch_config(body: ComplianceConfigUpdate, admin: dict = Depends(require_admin)):
    patch = {k: v for k, v in body.model_dump().items() if v is not None}
    if not patch:
        raise HTTPException(status_code=400, detail='Nothing to change')
    try:
        cfg = await compliance.set_config(patch, admin['id'])
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    logger.info('compliance config changed by %s: %s', admin['id'], sorted(patch))
    return {'message': 'Compliance settings saved', 'config': cfg}


@admin_router.get('/review')
async def review(admin: dict = Depends(require_admin)):
    """Who the CURRENT settings would exclude — before anything is enforced."""
    cfg = await compliance.get_config()
    result = await compliance.review_players(cfg)
    return {**result, 'enforcing': bool(cfg.get('enforce_market_on_login')),
            'market_mode': cfg['market_mode']}


@admin_router.get('/preview')
async def preview(market_mode: str = None, markets: str = None,
                  min_age: int = None, admin: dict = Depends(require_admin)):
    """The same report against settings that have NOT been saved.

    Turning on an allow-list is the one action here that can lock real players
    out of a real balance, so it should be possible to ask what it would do
    before doing it.
    """
    cfg = await compliance.get_config()
    if market_mode:
        cfg = {**cfg, 'market_mode': market_mode.upper()}
    if markets is not None:
        cfg = {**cfg, 'markets': [c for c in
                                  (compliance.normalise_country(x) for x in markets.split(',')) if c]}
    if min_age:
        cfg = {**cfg, 'min_age': int(min_age)}
    result = await compliance.review_players(cfg)
    return {**result, 'would_apply': {'market_mode': cfg['market_mode'],
                                      'markets': cfg['markets'], 'min_age': cfg['min_age']}}


@admin_router.get('/exclusions')
async def list_exclusions(admin: dict = Depends(require_admin)):
    rows = await db.exclusions.find({}, {'_id': 0}).sort('created_at', -1).to_list(300)
    ids = list({r['user_id'] for r in rows})
    users = await db.users.find({'id': {'$in': ids}},
                                {'_id': 0, 'id': 1, 'username': 1, 'chip_balance': 1}).to_list(300)
    by_id = {u['id']: u for u in users}
    for r in rows:
        u = by_id.get(r['user_id'], {})
        r['login_id'] = u.get('username')
        r['chip_balance'] = u.get('chip_balance', 0)
        r['in_force'] = bool(await compliance.active_exclusion(r['user_id'])) and r['status'] == 'ACTIVE'
    return {'exclusions': serialize_doc(rows),
            'active': sum(1 for r in rows if r['in_force'])}


@admin_router.post('/players/{user_id}/exclusion')
async def admin_exclude(user_id: str, body: AdminExclusion,
                        admin: dict = Depends(require_admin)):
    """The operator excluding a player — for a concern the player has not raised."""
    await _require_player_target(user_id)
    if not body.reason:
        raise HTTPException(status_code=400, detail='An operator exclusion has to have a reason recorded')
    kind = compliance.SELF_EXCLUSION if body.days is None else compliance.BREAK
    try:
        doc = await compliance.exclude(user_id, kind=kind, days=body.days,
                                       source='ADMIN', reason=body.reason)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    await db.users.update_one({'id': user_id}, {'$set': {
        'active_session_id': f"excluded-{doc['id']}"}})
    return {'message': 'Player excluded and signed out', 'exclusion': serialize_doc(doc)}


@admin_router.post('/players/{user_id}/exclusion/lift')
async def admin_lift(user_id: str, body: AdminExclusion, admin: dict = Depends(require_admin)):
    await _require_player_target(user_id)
    try:
        doc = await compliance.admin_lift(user_id, admin['id'], body.reason)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {'message': 'Exclusion lifted', 'exclusion': serialize_doc(doc)}


@admin_router.post('/players/{user_id}/age-verify')
async def verify_age(user_id: str, body: AgeVerify, admin: dict = Depends(require_admin)):
    user = await _require_player_target(user_id)
    age = compliance.age_on(user.get('date_of_birth'))
    if body.verified and age is None:
        raise HTTPException(status_code=400, detail=(
            'This account has no usable date of birth — record one before verifying it'))
    await db.users.update_one({'id': user_id}, {'$set': {
        'age_verified': bool(body.verified),
        'age_verified_at': compliance.now_iso() if body.verified else None,
        'age_verified_by': admin['id'] if body.verified else None,
        'age_verified_note': body.note,
    }})
    return {'message': 'Age verified' if body.verified else 'Age verification withdrawn',
            'age': age}


@admin_router.get('/players/{user_id}')
async def player_detail(user_id: str, admin: dict = Depends(require_admin)):
    user = await _require_player_target(
        user_id,
        {'_id': 0, 'id': 1, 'username': 1, 'country': 1, 'date_of_birth': 1,
         'age_verified': 1, 'age_verified_at': 1, 'status': 1, 'chip_balance': 1},
    )
    return {
        'player': serialize_doc(user),
        'age': compliance.age_on(user.get('date_of_birth')),
        'country_code': compliance.normalise_country(user.get('country')) or compliance.UNKNOWN,
        'limits': serialize_doc(await compliance.limits_for(user_id)),
        'usage': await _spend_summary(user_id),
        'exclusion': serialize_doc(await compliance.active_exclusion(user_id)),
    }


@admin_router.post('/players/{user_id}/limits')
async def admin_set_limit(user_id: str, body: LimitSet, admin: dict = Depends(require_admin)):
    """An operator-imposed limit. Tightening applies at once, like the player's.

    An operator RAISING a player's limit waits exactly as long as the player
    would. The delay protects against a decision made in the moment, and an
    operator asked to lift it in the moment is the same decision.
    """
    await _require_player_target(user_id)
    try:
        result = await compliance.set_limit(user_id, body.kind.upper(),
                                            body.period.upper(), body.amount,
                                            actor=f"admin:{admin['id']}")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {'message': 'Limit set' if result['outcome'] == 'IMMEDIATE'
            else f"Increase queued — it applies in {result['delay_hours']} hours", **result}
