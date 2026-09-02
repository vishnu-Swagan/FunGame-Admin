"""Chicken Road - a server-authoritative crash table with universal live rounds.

Chicken Road is original IP built on the SAME crash round engine as Aviator: a
chicken crosses a night highway, the multiplier climbs on Aviator's shared
flight curve, and the player cashes out before a vehicle hits it. Every player
sees the SAME rounds (a DB-chained BETTING -> RUNNING -> CRASHED machine kept
alive 24/7 by a background task in server.py), and all chip movement is
server-authoritative through the same ledger every other table uses.

This module deliberately mirrors the Aviator machine in routes_live.py rather
than sharing its internals, so a change to one table can never destabilise the
other. Wallet/bet mutations run through run_game_transaction (the same atomic
runner the generic live tables use), which keeps the settlement paths unit
testable against a mock database.

PLAY CHIPS ONLY.
"""
import uuid
import time
import asyncio
import logging
import secrets
import hashlib
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
    CHICKEN_ROAD_GROWTH, CHICKEN_ROAD_FAIRNESS_VERSION,
    aviator_factor_text,
    chicken_road_commitment, chicken_road_commitment_payload,
    chicken_road_crash_point, chicken_road_multiplier, chicken_road_return_factor,
    chicken_road_time_for,
)
from live_engines import limits_for
from game_access import require_playable_game
from transactions import run_game_transaction

logger = logging.getLogger('chicken_road')
router = APIRouter(tags=['chicken-road'])

SLUG = 'chicken-road'
GAME_NAME = 'Chicken Road'

# A short crossing cadence keeps consecutive crash rounds snappy. Both values are
# returned by /state so every client draws the same countdown from the server.
CR_BETTING = 5.0   # seconds bets are open before the chicken starts crossing
CR_RESULT = 3.0    # crash-result hold before the next round opens


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


class ChickenRoadBet(BaseModel):
    amount: int = Field(ge=1, le=100_000)
    panel: int = Field(default=1, ge=1, le=2)
    auto_cashout: Optional[float] = Field(default=None, ge=1.01, le=1000)


class BetRef(BaseModel):
    bet_id: str


# ======================================================================
# Round machine
# ======================================================================
async def _cr_create_round(round_number: int, start_ts: float):
    server_seed = secrets.token_hex(32)
    return_factor = chicken_road_return_factor()
    fairness_version = CHICKEN_ROAD_FAIRNESS_VERSION
    server_seed_hash = chicken_road_commitment(server_seed, return_factor, fairness_version)
    crash = chicken_road_crash_point(server_seed, return_factor)
    run_start = start_ts + CR_BETTING
    crash_at = run_start + chicken_road_time_for(crash)
    doc = {
        'round_number': round_number, 'betting_start': start_ts, 'run_start': run_start,
        'crash_point': crash, 'crash_at': crash_at, 'ends_at': crash_at + CR_RESULT,
        'status': 'OPEN', 'created_at': _now_iso(),
        # Never serialized by /state. Revealed only after settlement by the
        # authenticated fairness endpoint below.
        'server_seed': server_seed, 'server_seed_hash': server_seed_hash,
        'verification_factor': return_factor, 'fairness_version': fairness_version,
    }
    try:
        await db.chicken_road_rounds.insert_one(dict(doc))
        return doc
    except DuplicateKeyError:
        persisted = await db.chicken_road_rounds.find_one({'round_number': round_number})
        if persisted is None:
            raise RuntimeError('Chicken Road round insert raced but no persisted round exists')
        return persisted


async def _cr_history_doc(bet, payout, outcome, session=None):
    kwargs = {'session': session} if session is not None else {}
    await db.game_rounds.insert_one({
        'id': str(uuid.uuid4()), 'user_id': bet['user_id'], 'slug': SLUG, 'game_name': GAME_NAME,
        'round_number': bet['round_number'], 'bet': bet['amount'], 'payout': payout,
        'status': 'SETTLED', 'outcome': outcome,
        'created_at': _now_iso(), 'settled_at': _now_iso(),
    }, **kwargs)


async def _cr_cash_bet(bet, mult, crash_point=None, auto=False, cashout_deadline=None):
    """Atomically settle one OPEN bet and its wallet/history movements."""
    async def settle(session):
        kwargs = {'session': session} if session is not None else {}
        if cashout_deadline is not None and time.time() >= cashout_deadline:
            return None
        current = await db.chicken_road_bets.find_one(
            {'id': bet['id'], 'status': 'OPEN'}, **kwargs,
        )
        if not current:
            return None
        payout = int(round(current['amount'] * mult))
        res = await db.chicken_road_bets.update_one(
            {'id': current['id'], 'status': 'OPEN'},
            {'$set': {
                'status': 'CASHED', 'active': False, 'payout': payout,
                'multiplier': mult, 'auto': auto, 'settled_at': _now_iso(),
            }},
            **kwargs,
        )
        if res.modified_count == 0:
            return None
        await credit_chips(
            current['user_id'], payout, f'Chicken Road cashout {mult}x', ref=current['id'],
            kind=ledger.PAYOUT, game=SLUG, session=session,
        )
        await _cr_history_doc(
            current, payout,
            {'result': 'cashed_out', 'multiplier': mult, 'crash_point': crash_point},
            session=session,
        )
        return payout

    return await run_game_transaction(client, settle)


async def _cr_lose_bet(bet, crash_point):
    """Atomically mark one bet lost and append its personal round history."""
    async def settle(session):
        kwargs = {'session': session} if session is not None else {}
        current = await db.chicken_road_bets.find_one(
            {'id': bet['id'], 'status': 'OPEN'}, **kwargs,
        )
        if not current:
            return False
        res = await db.chicken_road_bets.update_one(
            {'id': current['id'], 'status': 'OPEN'},
            {'$set': {
                'status': 'LOST', 'active': False, 'payout': 0, 'settled_at': _now_iso(),
            }},
            **kwargs,
        )
        if res.modified_count == 0:
            return False
        await _cr_history_doc(
            current, 0, {'result': 'crashed', 'crash_point': crash_point}, session=session,
        )
        return True

    return await run_game_transaction(client, settle)


async def _cr_settle_round(r):
    """Settle every OPEN bet of a crashed round. Idempotent."""
    crash = r['crash_point']
    while True:
        bets = await db.chicken_road_bets.find(
            {'round_number': r['round_number'], 'status': 'OPEN'}
        ).to_list(500)
        if not bets:
            break
        for b in bets:
            auto = b.get('auto_cashout')
            if auto and auto <= crash:
                await _cr_cash_bet(b, auto, crash_point=crash, auto=True)
            else:
                await _cr_lose_bet(b, crash)
    await db.chicken_road_rounds.update_one(
        {'round_number': r['round_number'], 'status': 'OPEN'}, {'$set': {'status': 'SETTLED'}}
    )


async def _cr_auto_cash_running(r, now):
    """Eagerly cash out auto-cashout bets whose target multiplier was reached."""
    mult = chicken_road_multiplier(now - r['run_start'])
    while True:
        if time.time() >= r['crash_at']:
            return
        bets = await db.chicken_road_bets.find({
            'round_number': r['round_number'], 'status': 'OPEN',
            'auto_cashout': {'$ne': None, '$lte': mult},
        }).to_list(200)
        if not bets:
            break
        for b in bets:
            payout = await _cr_cash_bet(
                b, b['auto_cashout'], crash_point=None, auto=True,
                cashout_deadline=r['crash_at'],
            )
            if payout is None and time.time() >= r['crash_at']:
                return


async def advance_chicken_road():
    """Advance the global Chicken Road machine. Idempotent - safe to call from
    the background keepalive task AND from any request."""
    now = time.time()
    r = await db.chicken_road_rounds.find_one({}, sort=[('round_number', -1)])
    if r is None:
        return await _cr_create_round(1, now)
    if now >= r['crash_at'] and r.get('status') == 'OPEN':
        await _cr_settle_round(r)
        r = await db.chicken_road_rounds.find_one({'round_number': r['round_number']})
    if now >= r['ends_at']:
        return await _cr_create_round(r['round_number'] + 1, max(now, r['ends_at']))
    if r['run_start'] <= now < r['crash_at']:
        await _cr_auto_cash_running(r, now)
    return r


def _cr_phase(r, now):
    if now < r['run_start']:
        return 'BETTING', r['run_start'] - now
    if now < r['crash_at']:
        return 'RUNNING', now - r['run_start']
    return 'CRASHED', max(0.0, r['ends_at'] - now)


# ======================================================================
# Endpoints
# ======================================================================
@router.get('/live/chicken-road/state')
async def chicken_road_state(user: dict = Depends(require_active_player)):
    await require_playable_game(SLUG)
    r = await advance_chicken_road()
    now = time.time()
    phase, t = _cr_phase(r, now)
    rn = r['round_number']

    my, feed_raw, previous_raw, hist, balance = await asyncio.gather(
        db.chicken_road_bets.find(
            {'user_id': user['id'], 'round_number': {'$in': [rn - 1, rn, rn + 1]}},
            {'_id': 0, 'user_id': 0},
        ).sort('created_at', 1).to_list(20),
        db.chicken_road_bets.find(
            {'round_number': rn, 'status': {'$in': ['OPEN', 'CASHED', 'LOST']}}, {'_id': 0}
        ).sort('amount', -1).to_list(40),
        db.chicken_road_bets.find(
            {'round_number': rn - 1, 'status': {'$in': ['CASHED', 'LOST']}}, {'_id': 0}
        ).sort('amount', -1).to_list(40),
        db.chicken_road_rounds.find(
            {'status': 'SETTLED'},
            {'_id': 0, 'round_number': 1, 'crash_point': 1, 'server_seed': 1},
        ).sort('round_number', -1).to_list(20),
        _fresh_balance(user['id']),
    )
    proof_rounds = {h['round_number'] for h in hist if h.get('server_seed')}
    for b in my:
        b['queued'] = b['round_number'] > rn
        b['proof_available'] = b['round_number'] in proof_rounds or (
            b['round_number'] == rn and bool(r.get('server_seed'))
        )

    ids = list({b['user_id'] for b in [*feed_raw, *previous_raw]})
    names = {}
    if ids:
        users = await db.users.find(
            {'id': {'$in': ids}}, {'_id': 0, 'id': 1, 'display_name': 1, 'email': 1}
        ).to_list(len(ids))
        names = {u['id']: (u.get('display_name') or u.get('email', 'Player').split('@')[0]) for u in users}

    def public_bet(b):
        return {
            'name': _mask(names.get(b['user_id'], 'Player')), 'amount': b['amount'],
            'status': b['status'], 'multiplier': b.get('multiplier'),
            'payout': b.get('payout', 0),
        }

    feed = [public_bet(b) for b in feed_raw]
    previous_feed = [public_bet(b) for b in previous_raw]
    resp = {
        'round_number': rn, 'phase': phase, 'server_now': now,
        'server_seed_hash': r.get('server_seed_hash', ''),
        'betting_seconds': CR_BETTING, 'result_seconds': CR_RESULT, 'growth': CHICKEN_ROAD_GROWTH,
        'my_bets': my, 'all_bets': feed, 'players': len(feed_raw),
        'previous_bets': previous_feed,
        'total_staked': sum(b['amount'] for b in feed_raw),
        'history': [{
            'round_number': h['round_number'], 'crash_point': h['crash_point'],
            'proof_available': bool(h.get('server_seed')),
        } for h in hist],
        'balance': balance,
        'min_bet': limits_for(SLUG)[0], 'max_bet': limits_for(SLUG)[1],
    }
    if phase == 'BETTING':
        resp['phase_ends_in'] = round(t, 2)
    elif phase == 'RUNNING':
        resp['run_elapsed'] = round(t, 3)
        resp['multiplier'] = chicken_road_multiplier(t)
    else:
        resp['phase_ends_in'] = round(t, 2)
        resp['crash_point'] = r['crash_point']
        resp['run_seconds'] = round(max(0, r['crash_at'] - r['run_start']), 3)
    return resp


@router.get('/live/chicken-road/rounds/{round_number}/fairness')
async def chicken_road_round_fairness(round_number: int, user: dict = Depends(require_active_player)):
    await require_playable_game(SLUG)
    r = await db.chicken_road_rounds.find_one({'round_number': round_number}, {'_id': 0})
    if not r:
        raise HTTPException(status_code=404, detail='Round not found')
    if r.get('status') != 'SETTLED' or not r.get('server_seed'):
        raise HTTPException(status_code=409, detail='The server seed is revealed after the round settles')
    fairness_version = int(r.get('fairness_version') or 1)
    verification_factor_text = aviator_factor_text(r['verification_factor'])
    result_hash = hashlib.sha256(f"chicken-road-crash-v1:{r['server_seed']}".encode()).hexdigest()
    return {
        'createdAt': r.get('created_at'),
        'serverSeed': r['server_seed'],
        'serverSeedHash': r.get('server_seed_hash', ''),
        'resultHash': result_hash,
        'roundNumber': round_number,
        'crashPoint': r['crash_point'],
        'target': r['crash_point'],
        'verificationFactor': r['verification_factor'],
        'verificationFactorText': verification_factor_text,
        'fairnessVersion': fairness_version,
        'commitmentPayload': chicken_road_commitment_payload(
            r['server_seed'], r['verification_factor'], fairness_version,
        ),
        'algorithm': 'SHA256 / chicken-road-crash-v1',
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
            {'id': {'$in': user_ids}}, {'_id': 0, 'id': 1, 'display_name': 1, 'email': 1}
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


@router.post('/live/chicken-road/bets')
async def chicken_road_place_bet(body: ChickenRoadBet, user: dict = Depends(require_active_player)):
    await require_playable_game(SLUG)
    _min, _max = limits_for(SLUG)
    if body.amount < _min:
        raise HTTPException(status_code=400, detail=f'Minimum bet is {_min} chips')
    if body.amount > _max:
        raise HTTPException(status_code=400, detail=f'Maximum bet is {_max} chips')
    r = await advance_chicken_road()
    now = time.time()
    phase, t = _cr_phase(r, now)
    # Bets during a run/result queue for the next round.
    if phase == 'BETTING' and t > 0.3:
        target_rn = r['round_number']
    else:
        target_rn = r['round_number'] + 1
    bet_id = str(uuid.uuid4())
    auto = round(float(body.auto_cashout), 2) if body.auto_cashout else None
    bet = {
        'id': bet_id, 'user_id': user['id'], 'round_number': target_rn, 'panel': body.panel,
        'amount': body.amount, 'auto_cashout': auto, 'status': 'OPEN', 'active': True,
        'payout': 0, 'multiplier': None, 'created_at': _now_iso(),
    }

    async def reserve_and_debit(session):
        kwargs = {'session': session} if session is not None else {}
        existing = await db.chicken_road_bets.find_one({
            'user_id': user['id'], 'round_number': target_rn,
            'panel': body.panel, 'status': 'OPEN',
        }, **kwargs)
        if existing:
            raise DuplicateKeyError('active Chicken Road panel bet already exists')
        await debit_chips(
            user['id'], body.amount, f'Chicken Road bet (round {target_rn})', ref=bet_id,
            kind=ledger.STAKE, game=SLUG, session=session,
        )
        await db.chicken_road_bets.insert_one(dict(bet), **kwargs)

    try:
        await run_game_transaction(client, reserve_and_debit)
    except DuplicateKeyError:
        raise HTTPException(status_code=409, detail='You already have an active bet on this panel for that round')
    except InsufficientChips:
        raise HTTPException(status_code=400, detail='Not enough play chips for this bet')
    balance = await _fresh_balance(user['id'])
    return {
        'bet_id': bet_id, 'round_number': target_rn, 'panel': body.panel,
        'queued': target_rn != r['round_number'], 'balance': balance,
    }


@router.post('/live/chicken-road/bets/cancel')
async def chicken_road_cancel_bet(body: BetRef, user: dict = Depends(require_active_player)):
    await require_playable_game(SLUG)
    b = await db.chicken_road_bets.find_one({'id': body.bet_id, 'user_id': user['id']})
    if not b:
        raise HTTPException(status_code=404, detail='Bet not found')
    if b['status'] != 'OPEN':
        raise HTTPException(status_code=400, detail='Bet already settled')
    r = await db.chicken_road_rounds.find_one({}, sort=[('round_number', -1)])
    now = time.time()
    phase, t = _cr_phase(r, now) if r else ('BETTING', 99)
    cancellable = b['round_number'] > r['round_number'] or (
        b['round_number'] == r['round_number'] and phase == 'BETTING' and t > 0.3)
    if not cancellable:
        raise HTTPException(status_code=400, detail='Too late to cancel - the chicken is crossing')

    async def cancel_and_refund(session):
        kwargs = {'session': session} if session is not None else {}
        current = await db.chicken_road_bets.find_one(
            {'id': b['id'], 'user_id': user['id'], 'status': 'OPEN'}, **kwargs,
        )
        if not current:
            return None
        res = await db.chicken_road_bets.update_one(
            {'id': current['id'], 'status': 'OPEN'},
            {'$set': {'status': 'CANCELLED', 'active': False, 'settled_at': _now_iso()}},
            **kwargs,
        )
        if res.modified_count == 0:
            return None
        return await credit_chips(
            user['id'], current['amount'], 'Chicken Road bet cancelled', ref=current['id'],
            kind=ledger.REFUND, game=SLUG, session=session,
        )

    balance = await run_game_transaction(client, cancel_and_refund)
    if balance is None:
        raise HTTPException(status_code=400, detail='Bet already settled')
    return {'message': 'Bet cancelled', 'refunded': b['amount'], 'balance': balance}


@router.post('/live/chicken-road/cashout')
async def chicken_road_cashout(body: BetRef, user: dict = Depends(require_active_player)):
    await require_playable_game(SLUG)
    b = await db.chicken_road_bets.find_one({'id': body.bet_id, 'user_id': user['id']})
    if not b:
        raise HTTPException(status_code=404, detail='Bet not found')
    if b['status'] != 'OPEN':
        raise HTTPException(status_code=400, detail='Bet already settled')
    r = await db.chicken_road_rounds.find_one({'round_number': b['round_number']})
    if not r:
        raise HTTPException(status_code=400, detail='Round not found')
    now = time.time()
    if now < r['run_start']:
        raise HTTPException(status_code=400, detail='The chicken has not started crossing yet')
    if now >= r['crash_at']:
        if r.get('status') == 'OPEN':
            await _cr_settle_round(r)
        balance = await _fresh_balance(user['id'])
        return {'result': 'crashed', 'crash_point': r['crash_point'], 'payout': 0, 'balance': balance}
    mult = chicken_road_multiplier(now - r['run_start'])
    payout = await _cr_cash_bet(b, mult, cashout_deadline=r['crash_at'])
    if payout is None:
        now = time.time()
        if now >= r['crash_at']:
            if r.get('status') == 'OPEN':
                await _cr_settle_round(r)
            balance = await _fresh_balance(user['id'])
            return {'result': 'crashed', 'crash_point': r['crash_point'], 'payout': 0, 'balance': balance}
        raise HTTPException(status_code=400, detail='Bet already settled')
    balance = await _fresh_balance(user['id'])
    return {'result': 'cashed_out', 'multiplier': mult, 'payout': payout, 'balance': balance}