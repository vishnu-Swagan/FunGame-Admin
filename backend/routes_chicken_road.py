"""Chicken Road — stateful per-player game API.

start (bet + difficulty) -> step / step / ... -> cashout (or a truck ends it).
One active run per user in db.chicken_road_games. The crash lane is fixed at
start by secure RNG and never leaked until the run is over. Chips move through
the ledger.
"""
import uuid
from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel, Field
from db import db
from auth_utils import require_active_player
from ledger import credit_chips, debit_chips, InsufficientChips
from game_engines import MIN_BET, MAX_BET
import chicken_road as cr

router = APIRouter(tags=['chicken-road'])


def _now():
    return datetime.now(timezone.utc).isoformat()


class StartBody(BaseModel):
    bet: int = Field(ge=1, le=MAX_BET)
    difficulty: str


async def _balance(uid):
    u = await db.users.find_one({'id': uid})
    return u.get('chip_balance', 0) if u else 0


async def _load(uid):
    return await db.chicken_road_games.find_one({'user_id': uid})


async def _save(g):
    await db.chicken_road_games.replace_one({'user_id': g['user_id']}, g, upsert=True)


def _sanitize(g, balance):
    mults = cr.cr_multipliers(g['difficulty'])
    pos = g['position']
    done = g['status'] in ('lost', 'cashed')
    return {
        'status': g['status'],
        'difficulty': g['difficulty'],
        'bet': g['bet'],
        'position': pos,                                   # lanes crossed so far
        'lanes': len(mults),
        'multipliers': mults,
        'current_mult': mults[pos - 1] if pos >= 1 else 0,
        'next_mult': mults[pos] if pos < len(mults) else None,
        'cashout_value': int(g['bet'] * mults[pos - 1]) if pos >= 1 and g['status'] == 'running' else 0,
        'payout': g.get('payout', 0),
        'crash_at': g['crash_at'] if done else None,       # revealed only when over
        'balance': balance,
    }


async def _record_round(g, uid):
    game = await db.games.find_one({'slug': 'chicken-road'})
    gname = game['name'] if game else 'Chicken Road'
    await db.game_rounds.insert_one({
        'id': str(uuid.uuid4()), 'user_id': uid, 'slug': 'chicken-road', 'game_name': gname,
        'bet': g['bet'], 'payout': g.get('payout', 0),
        'status': 'SETTLED',
        'outcome': {'difficulty': g['difficulty'], 'position': g['position'],
                    'crash_at': g['crash_at'], 'result': g['status']},
        'created_at': g['created_at'], 'settled_at': _now(),
    })


@router.get('/chicken-road/state')
async def cr_state(user: dict = Depends(require_active_player)):
    g = await _load(user['id'])
    bal = await _balance(user['id'])
    base = {'config': cr.cr_config(), 'min_bet': MIN_BET, 'max_bet': MAX_BET}
    if not g or g['status'] != 'running':
        return {'status': 'idle', 'balance': bal, **base}
    return {**_sanitize(g, bal), **base}


@router.post('/chicken-road/start')
async def cr_start(body: StartBody, user: dict = Depends(require_active_player)):
    uid = user['id']
    if body.difficulty not in cr.CR_DIFF:
        raise HTTPException(status_code=400, detail='Unknown difficulty')
    if body.bet < MIN_BET:
        raise HTTPException(status_code=400, detail=f'Minimum bet is {MIN_BET} chips')
    existing = await _load(uid)
    if existing and existing['status'] == 'running':
        raise HTTPException(status_code=409, detail='Finish your current run first')
    ref = str(uuid.uuid4())
    try:
        await debit_chips(uid, body.bet, 'Chicken Road bet', ref=ref)
    except InsufficientChips:
        raise HTTPException(status_code=400, detail='Not enough play chips for this bet')
    g = {
        'user_id': uid, 'id': ref, 'difficulty': body.difficulty, 'bet': body.bet,
        'position': 0, 'crash_at': cr.cr_generate_crash(body.difficulty),
        'status': 'running', 'payout': 0, 'created_at': _now(),
    }
    await _save(g)
    return {**_sanitize(g, await _balance(uid)), 'config': cr.cr_config(), 'min_bet': MIN_BET, 'max_bet': MAX_BET}


@router.post('/chicken-road/step')
async def cr_step(user: dict = Depends(require_active_player)):
    uid = user['id']
    g = await _load(uid)
    if not g or g['status'] != 'running':
        raise HTTPException(status_code=400, detail='No run in progress')
    lanes = len(cr.cr_multipliers(g['difficulty']))
    g['position'] += 1
    if g['position'] >= g['crash_at']:
        # stepped onto a truck — run over, bet already taken
        g['status'] = 'lost'
        g['payout'] = 0
        await _save(g)
        await _record_round(g, uid)
        return {**_sanitize(g, await _balance(uid)), 'config': cr.cr_config(), 'min_bet': MIN_BET, 'max_bet': MAX_BET}
    if g['position'] >= lanes:
        # crossed the whole road — auto cash out at the max multiplier
        return await _do_cashout(g, uid)
    await _save(g)
    return {**_sanitize(g, await _balance(uid)), 'config': cr.cr_config(), 'min_bet': MIN_BET, 'max_bet': MAX_BET}


async def _do_cashout(g, uid):
    mults = cr.cr_multipliers(g['difficulty'])
    payout = int(g['bet'] * mults[g['position'] - 1])
    g['status'] = 'cashed'
    g['payout'] = payout
    await credit_chips(uid, payout, 'Chicken Road cashout', ref=g['id'])
    await _save(g)
    await _record_round(g, uid)
    return {**_sanitize(g, await _balance(uid)), 'config': cr.cr_config(), 'min_bet': MIN_BET, 'max_bet': MAX_BET}


@router.post('/chicken-road/cashout')
async def cr_cashout(user: dict = Depends(require_active_player)):
    uid = user['id']
    g = await _load(uid)
    if not g or g['status'] != 'running':
        raise HTTPException(status_code=400, detail='No run in progress')
    if g['position'] < 1:
        raise HTTPException(status_code=400, detail='Take at least one step before cashing out')
    return await _do_cashout(g, uid)
