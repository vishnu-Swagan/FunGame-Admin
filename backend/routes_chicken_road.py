"""Chicken Road — a server-authoritative hop-across-lanes table.

The chicken starts on the sidewalk. Play debits the stake and hops onto the
first manhole. GO hops one more lane. CASH OUT credits bet × the current
lane multiplier. A seeded crash lane ends the round with a loss (no credit).

This is original IP: discrete lanes, not an Aviator climb curve. Chip movement
still goes through run_game_transaction / the shared ledger so the table stays
unit-testable against a mock database.

PLAY CHIPS ONLY.
"""
import uuid
import time
import logging
import hashlib
import secrets
from datetime import datetime, timezone, timedelta
from typing import Optional

from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel, Field
from pymongo.errors import DuplicateKeyError

from db import client, db
from auth_utils import require_active_player
from ledger import credit_chips, debit_chips, InsufficientChips
import ledger
from game_engines import (
    CHICKEN_ROAD_DIFFICULTIES,
    CHICKEN_ROAD_FAIRNESS_VERSION,
    CHICKEN_ROAD_LANE_COUNT,
    chicken_road_commitment,
    chicken_road_commitment_payload,
    chicken_road_crash_lane,
    chicken_road_lane_multipliers,
)
from live_engines import limits_for
from game_access import require_playable_game
from transactions import run_game_transaction

logger = logging.getLogger('chicken_road')
router = APIRouter(tags=['chicken-road'])

SLUG = 'chicken-road'
GAME_NAME = 'Chicken Road'


def _now_iso():
    return datetime.now(timezone.utc).isoformat()


async def _fresh_balance(user_id: str):
    u = await db.users.find_one({'id': user_id})
    return u.get('chip_balance', 0) if u else 0


def _mask(name: str):
    name = (name or 'Player').strip()
    if len(name) <= 2:
        return name + '***'
    return f"{name[0]}***{name[-1]}"


def _payout_for(amount: int, multiplier: float) -> int:
    return int(round(int(amount) * float(multiplier)))


def _public_round(r: dict, *, reveal: bool = False) -> dict:
    """Serialize a hop round without leaking the crash lane while PLAYING."""
    status = r.get('status')
    current_lane = int(r.get('current_lane') or 0)
    current_mult = float(r.get('current_multiplier') or 1.0)
    amount = int(r.get('amount') or 0)
    out = {
        'id': r['id'],
        'round_number': r.get('round_number'),
        'amount': amount,
        'difficulty': r.get('difficulty', 'easy'),
        'lane_count': int(r.get('lane_count') or CHICKEN_ROAD_LANE_COUNT),
        'multipliers': list(r.get('multipliers') or []),
        'current_lane': current_lane,
        'current_multiplier': current_mult,
        'cashout_amount': _payout_for(amount, current_mult) if current_lane >= 1 and status == 'PLAYING' else 0,
        'status': status,
        'server_seed_hash': r.get('server_seed_hash', ''),
        'fairness_version': int(r.get('fairness_version') or CHICKEN_ROAD_FAIRNESS_VERSION),
    }
    if status in ('CRASHED', 'CASHED') or reveal:
        out['crash_lane'] = r.get('crash_lane')
        out['server_seed'] = r.get('server_seed')
        out['payout'] = int(r.get('payout') or 0)
    return out


class PlayBody(BaseModel):
    amount: int = Field(ge=1, le=100_000)
    difficulty: str = Field(default='easy')


class RoundRef(BaseModel):
    round_id: str


# ======================================================================
# Round helpers
# ======================================================================
async def _next_round_number():
    last = await db.chicken_road_rounds.find_one({}, sort=[('round_number', -1)])
    return int((last or {}).get('round_number') or 0) + 1


async def _history_doc(round_doc, payout, outcome, session=None):
    kwargs = {'session': session} if session is not None else {}
    await db.game_rounds.insert_one({
        'id': str(uuid.uuid4()),
        'user_id': round_doc['user_id'],
        'slug': SLUG,
        'game_name': GAME_NAME,
        'round_number': round_doc.get('round_number'),
        'bet': round_doc['amount'],
        'payout': payout,
        'status': 'SETTLED',
        'outcome': outcome,
        'created_at': _now_iso(),
        'settled_at': _now_iso(),
    }, **kwargs)


def _hop_onto(round_doc, next_lane: int):
    """Apply one hop. Mutates a copy of the round fields; does not write."""
    crash_lane = int(round_doc['crash_lane'])
    multipliers = list(round_doc['multipliers'])
    lane_count = int(round_doc['lane_count'])
    if next_lane < 1 or next_lane > lane_count:
        return {'crashed': False, 'blocked': True, 'lane': round_doc['current_lane'],
                'multiplier': float(round_doc['current_multiplier'])}
    if next_lane == crash_lane:
        return {'crashed': True, 'blocked': False, 'lane': next_lane,
                'multiplier': float(multipliers[next_lane - 1])}
    return {'crashed': False, 'blocked': False, 'lane': next_lane,
            'multiplier': float(multipliers[next_lane - 1])}


async def _settle_crash(round_doc):
    async def settle(session):
        kwargs = {'session': session} if session is not None else {}
        current = await db.chicken_road_rounds.find_one(
            {'id': round_doc['id'], 'status': 'PLAYING'}, **kwargs,
        )
        if not current:
            return None
        res = await db.chicken_road_rounds.update_one(
            {'id': current['id'], 'status': 'PLAYING'},
            {'$set': {
                'status': 'CRASHED',
                'payout': 0,
                'settled_at': _now_iso(),
            }},
            **kwargs,
        )
        if res.modified_count == 0:
            return None
        await _history_doc(
            current, 0,
            {
                'result': 'crashed',
                'lane': current.get('current_lane'),
                'crash_lane': current.get('crash_lane'),
                'difficulty': current.get('difficulty'),
            },
            session=session,
        )
        return True

    return await run_game_transaction(client, settle)


async def _settle_cashout(round_doc, multiplier: float):
    payout = _payout_for(round_doc['amount'], multiplier)

    async def settle(session):
        kwargs = {'session': session} if session is not None else {}
        current = await db.chicken_road_rounds.find_one(
            {'id': round_doc['id'], 'status': 'PLAYING'}, **kwargs,
        )
        if not current:
            return None
        if int(current.get('current_lane') or 0) < 1:
            return None
        res = await db.chicken_road_rounds.update_one(
            {'id': current['id'], 'status': 'PLAYING'},
            {'$set': {
                'status': 'CASHED',
                'payout': payout,
                'current_multiplier': float(multiplier),
                'settled_at': _now_iso(),
            }},
            **kwargs,
        )
        if res.modified_count == 0:
            return None
        await credit_chips(
            current['user_id'], payout, f'Chicken Road cashout {multiplier}x',
            ref=current['id'], kind=ledger.PAYOUT, game=SLUG, session=session,
        )
        await _history_doc(
            current, payout,
            {
                'result': 'cashed_out',
                'lane': current.get('current_lane'),
                'multiplier': float(multiplier),
                'difficulty': current.get('difficulty'),
            },
            session=session,
        )
        return payout

    return await run_game_transaction(client, settle)


async def advance_chicken_road():
    """Kept so the Aviator keepalive can still import us.

    Hop rounds are player-paced, so there is no global clock to tick. Abandoned
    PLAYING rounds older than 15 minutes are settled as crashes so a dropped
    client cannot hold chips in limbo forever.
    """
    cutoff = (datetime.now(timezone.utc) - timedelta(minutes=15)).isoformat()
    stale = await db.chicken_road_rounds.find(
        {'status': 'PLAYING', 'created_at': {'$lt': cutoff}},
    ).to_list(50)
    for r in stale:
        try:
            await _settle_crash(r)
        except Exception:
            logger.exception('chicken-road stale crash %s', r.get('id'))
    return None


# ======================================================================
# Endpoints
# ======================================================================
@router.get('/live/chicken-road/state')
async def chicken_road_state(user: dict = Depends(require_active_player)):
    await require_playable_game(SLUG)
    balance = await _fresh_balance(user['id'])
    active = await db.chicken_road_rounds.find_one(
        {'user_id': user['id'], 'status': 'PLAYING'}, {'_id': 0},
    )
    hist = await db.chicken_road_rounds.find(
        {'user_id': user['id'], 'status': {'$in': ['CASHED', 'CRASHED']}},
        {'_id': 0, 'round_number': 1, 'status': 1, 'current_multiplier': 1,
         'payout': 1, 'crash_lane': 1, 'current_lane': 1, 'difficulty': 1},
    ).sort('round_number', -1).to_list(12)

    wins_raw = await db.game_rounds.find(
        {'slug': SLUG, 'status': 'SETTLED', 'payout': {'$gt': 0}},
        {'_id': 0, 'user_id': 1, 'payout': 1, 'outcome': 1, 'created_at': 1},
    ).sort('created_at', -1).to_list(12)
    names = {}
    user_ids = list({row['user_id'] for row in wins_raw})
    if user_ids:
        users = await db.users.find(
            {'id': {'$in': user_ids}}, {'_id': 0, 'id': 1, 'display_name': 1, 'email': 1},
        ).to_list(40)
        names = {
            item['id']: (item.get('display_name') or item.get('email', 'Player').split('@')[0])
            for item in users
        }
    live_wins = [{
        'name': _mask(names.get(row['user_id'], 'Player')),
        'payout': int(row.get('payout') or 0),
        'multiplier': float((row.get('outcome') or {}).get('multiplier') or 0),
    } for row in wins_raw]

    playing_now = await db.chicken_road_rounds.count_documents({'status': 'PLAYING'})
    # A lively floor so the ticker matches the reference cabinet's "Online" feel
    # without implying a scraped third-party count.
    minute_jitter = int(time.time() // 20) % 1800
    online = 45200 + playing_now + minute_jitter

    difficulties = {}
    for key, spec in CHICKEN_ROAD_DIFFICULTIES.items():
        difficulties[key] = {
            'label': spec['label'],
            'traffic': spec['traffic'],
            'speed': spec['speed'],
            'multipliers': chicken_road_lane_multipliers(key),
        }

    low, high = limits_for(SLUG)
    return {
        'balance': balance,
        'min_bet': low,
        'max_bet': high,
        'chip_presets': [20, 50, 100, 500],
        'difficulties': difficulties,
        'active': _public_round(active) if active else None,
        'history': [{
            'round_number': h.get('round_number'),
            'status': h.get('status'),
            'lane': h.get('current_lane'),
            'multiplier': h.get('current_multiplier'),
            'payout': h.get('payout') or 0,
        } for h in hist],
        'live_wins': live_wins,
        'online': online,
        'players': playing_now,
    }


@router.get('/live/chicken-road/rounds/{round_number}/fairness')
async def chicken_road_round_fairness(round_number: int, user: dict = Depends(require_active_player)):
    await require_playable_game(SLUG)
    r = await db.chicken_road_rounds.find_one({'round_number': round_number}, {'_id': 0})
    if not r:
        raise HTTPException(status_code=404, detail='Round not found')
    if r.get('status') not in ('CASHED', 'CRASHED') or not r.get('server_seed'):
        raise HTTPException(status_code=409, detail='The server seed is revealed after the round settles')
    fairness_version = int(r.get('fairness_version') or CHICKEN_ROAD_FAIRNESS_VERSION)
    difficulty = r.get('difficulty', 'easy')
    result_hash = hashlib.sha256(f"chicken-road-hop-v1:{r['server_seed']}".encode()).hexdigest()
    return {
        'createdAt': r.get('created_at'),
        'serverSeed': r['server_seed'],
        'serverSeedHash': r.get('server_seed_hash', ''),
        'resultHash': result_hash,
        'roundNumber': round_number,
        'crashLane': r.get('crash_lane'),
        'difficulty': difficulty,
        'fairnessVersion': fairness_version,
        'commitmentPayload': chicken_road_commitment_payload(
            r['server_seed'], difficulty, fairness_version,
        ),
        'algorithm': 'SHA256 / chicken-road-hop-v1',
    }


@router.get('/live/chicken-road/top')
async def chicken_road_top(period: str = 'day', user: dict = Depends(require_active_player)):
    await require_playable_game(SLUG)
    windows = {'day': timedelta(days=1), 'month': timedelta(days=31), 'year': timedelta(days=366)}
    if period not in windows:
        raise HTTPException(status_code=400, detail='Period must be day, month, or year')
    cutoff = (datetime.now(timezone.utc) - windows[period]).isoformat()
    rows = await db.game_rounds.find(
        {'slug': SLUG, 'status': 'SETTLED', 'payout': {'$gt': 0}, 'created_at': {'$gte': cutoff}},
        {'_id': 0, 'user_id': 1, 'bet': 1, 'payout': 1, 'outcome': 1, 'created_at': 1},
    ).sort('payout', -1).to_list(50)
    user_ids = list({row['user_id'] for row in rows})
    names = {}
    if user_ids:
        users = await db.users.find(
            {'id': {'$in': user_ids}}, {'_id': 0, 'id': 1, 'display_name': 1, 'email': 1},
        ).to_list(60)
        names = {
            item['id']: (item.get('display_name') or item.get('email', 'Player').split('@')[0])
            for item in users
        }
    return {'data': [{
        'betAmount': float(row.get('bet', 0)),
        'cashOut': float(row.get('payout', 0)),
        'cashoutAt': float((row.get('outcome') or {}).get('multiplier', 0)),
        'createdAt': row.get('created_at'),
        'userinfo': [{'userName': _mask(names.get(row['user_id'], 'Player')), 'avatar': ''}],
    } for row in rows]}


@router.post('/live/chicken-road/play')
async def chicken_road_play(body: PlayBody, user: dict = Depends(require_active_player)):
    await require_playable_game(SLUG)
    difficulty = (body.difficulty or 'easy').strip().lower()
    if difficulty not in CHICKEN_ROAD_DIFFICULTIES:
        raise HTTPException(status_code=400, detail='Difficulty must be easy, medium, hard, or hardcore')
    _min, _max = limits_for(SLUG)
    if body.amount < _min:
        raise HTTPException(status_code=400, detail=f'Minimum bet is {_min} chips')
    if body.amount > _max:
        raise HTTPException(status_code=400, detail=f'Maximum bet is {_max} chips')

    existing = await db.chicken_road_rounds.find_one(
        {'user_id': user['id'], 'status': 'PLAYING'},
    )
    if existing:
        raise HTTPException(status_code=409, detail='You already have a chicken on the road')

    server_seed = secrets.token_hex(32)
    multipliers = chicken_road_lane_multipliers(difficulty)
    lane_count = len(multipliers)
    crash_lane = chicken_road_crash_lane(server_seed, difficulty, lane_count)
    fairness_version = CHICKEN_ROAD_FAIRNESS_VERSION
    server_seed_hash = chicken_road_commitment(server_seed, difficulty, fairness_version)
    round_id = str(uuid.uuid4())
    round_number = await _next_round_number()

    # Play always attempts the first hop onto lane 1 (the 1.01x manhole).
    first = _hop_onto({
        'crash_lane': crash_lane,
        'multipliers': multipliers,
        'lane_count': lane_count,
        'current_lane': 0,
        'current_multiplier': 1.0,
    }, 1)
    crashed = bool(first['crashed'])
    status = 'CRASHED' if crashed else 'PLAYING'
    current_lane = 1
    current_mult = first['multiplier']

    doc = {
        'id': round_id,
        'user_id': user['id'],
        'round_number': round_number,
        'amount': body.amount,
        'difficulty': difficulty,
        'lane_count': lane_count,
        'multipliers': multipliers,
        'crash_lane': crash_lane,
        'current_lane': current_lane,
        'current_multiplier': current_mult,
        'status': status,
        'payout': 0,
        'server_seed': server_seed,
        'server_seed_hash': server_seed_hash,
        'fairness_version': fairness_version,
        'created_at': _now_iso(),
    }
    if crashed:
        doc['settled_at'] = _now_iso()

    async def reserve_and_debit(session):
        kwargs = {'session': session} if session is not None else {}
        existing_again = await db.chicken_road_rounds.find_one(
            {'user_id': user['id'], 'status': 'PLAYING'}, **kwargs,
        )
        if existing_again:
            raise DuplicateKeyError('active Chicken Road round already exists')
        await debit_chips(
            user['id'], body.amount, f'Chicken Road bet (round {round_number})',
            ref=round_id, kind=ledger.STAKE, game=SLUG, session=session,
        )
        await db.chicken_road_rounds.insert_one(dict(doc), **kwargs)
        if crashed:
            await _history_doc(
                doc, 0,
                {
                    'result': 'crashed',
                    'lane': 1,
                    'crash_lane': crash_lane,
                    'difficulty': difficulty,
                },
                session=session,
            )

    try:
        await run_game_transaction(client, reserve_and_debit)
    except DuplicateKeyError:
        raise HTTPException(status_code=409, detail='You already have a chicken on the road')
    except InsufficientChips:
        raise HTTPException(status_code=400, detail='Not enough play chips for this bet')

    balance = await _fresh_balance(user['id'])
    persisted = await db.chicken_road_rounds.find_one({'id': round_id}, {'_id': 0})
    return {
        'result': 'crashed' if crashed else 'hopped',
        'balance': balance,
        'round': _public_round(persisted),
    }


@router.post('/live/chicken-road/go')
async def chicken_road_go(body: RoundRef, user: dict = Depends(require_active_player)):
    await require_playable_game(SLUG)
    r = await db.chicken_road_rounds.find_one({'id': body.round_id, 'user_id': user['id']})
    if not r:
        raise HTTPException(status_code=404, detail='Round not found')
    if r.get('status') != 'PLAYING':
        raise HTTPException(status_code=400, detail='This crossing has already ended')

    hop = _hop_onto(r, int(r.get('current_lane') or 0) + 1)
    if hop['blocked']:
        raise HTTPException(status_code=400, detail='The chicken is already on the last lane — cash out')

    if hop['crashed']:
        await db.chicken_road_rounds.update_one(
            {'id': r['id'], 'status': 'PLAYING'},
            {'$set': {
                'current_lane': hop['lane'],
                'current_multiplier': hop['multiplier'],
            }},
        )
        r['current_lane'] = hop['lane']
        r['current_multiplier'] = hop['multiplier']
        settled = await _settle_crash(r)
        if settled is None:
            latest = await db.chicken_road_rounds.find_one({'id': r['id']}, {'_id': 0})
            balance = await _fresh_balance(user['id'])
            return {
                'result': 'crashed' if latest and latest.get('status') == 'CRASHED' else latest.get('status'),
                'balance': balance,
                'round': _public_round(latest) if latest else None,
            }
        latest = await db.chicken_road_rounds.find_one({'id': r['id']}, {'_id': 0})
        balance = await _fresh_balance(user['id'])
        return {'result': 'crashed', 'balance': balance, 'round': _public_round(latest)}

    res = await db.chicken_road_rounds.update_one(
        {'id': r['id'], 'status': 'PLAYING', 'current_lane': r['current_lane']},
        {'$set': {
            'current_lane': hop['lane'],
            'current_multiplier': hop['multiplier'],
        }},
    )
    if res.modified_count == 0:
        latest = await db.chicken_road_rounds.find_one({'id': r['id']}, {'_id': 0})
        raise HTTPException(status_code=409, detail='Hop already applied')
    latest = await db.chicken_road_rounds.find_one({'id': r['id']}, {'_id': 0})
    balance = await _fresh_balance(user['id'])
    return {'result': 'hopped', 'balance': balance, 'round': _public_round(latest)}


@router.post('/live/chicken-road/cashout')
async def chicken_road_cashout(body: RoundRef, user: dict = Depends(require_active_player)):
    await require_playable_game(SLUG)
    r = await db.chicken_road_rounds.find_one({'id': body.round_id, 'user_id': user['id']})
    if not r:
        raise HTTPException(status_code=404, detail='Round not found')
    if r.get('status') != 'PLAYING':
        raise HTTPException(status_code=400, detail='This crossing has already ended')
    if int(r.get('current_lane') or 0) < 1:
        raise HTTPException(status_code=400, detail='The chicken has not reached a manhole yet')

    payout = await _settle_cashout(r, float(r.get('current_multiplier') or 1.0))
    latest = await db.chicken_road_rounds.find_one({'id': r['id']}, {'_id': 0})
    balance = await _fresh_balance(user['id'])
    if payout is None:
        if latest and latest.get('status') == 'CRASHED':
            return {'result': 'crashed', 'payout': 0, 'balance': balance, 'round': _public_round(latest)}
        raise HTTPException(status_code=400, detail='Round already settled')
    return {
        'result': 'cashed_out',
        'multiplier': float(latest.get('current_multiplier') or 0),
        'payout': payout,
        'balance': balance,
        'round': _public_round(latest),
    }


# Back-compat aliases so a stale client that still posts /bets cannot silently
# talk to the deleted Aviator-style machine. These always 410.
class _Gone(BaseModel):
    amount: Optional[int] = None
    bet_id: Optional[str] = None
    panel: Optional[int] = None
    auto_cashout: Optional[float] = None


@router.post('/live/chicken-road/bets')
async def chicken_road_place_bet_gone(body: _Gone = None, user: dict = Depends(require_active_player)):
    raise HTTPException(status_code=410, detail='Chicken Road now uses /play, /go and /cashout')


@router.post('/live/chicken-road/bets/cancel')
async def chicken_road_cancel_gone(body: _Gone = None, user: dict = Depends(require_active_player)):
    raise HTTPException(status_code=410, detail='Chicken Road now uses /play, /go and /cashout')
