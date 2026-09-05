"""Universal 24/7 live-round routes - every player sees the SAME rounds.

- Fixed-cycle games (17): rounds derived from epoch time; one outcome per
  (slug, round_number) created atomically and shared by all players.
- Aviator: DB-chained variable-length rounds (BETTING -> FLYING -> CRASHED)
  kept alive 24/7 by a background task in server.py.

All chip movement is server-authoritative through the ledger.
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
    MIN_BET, MAX_BET, AVIATOR_GROWTH, KENO_PAYTABLE,
    aviator_crash_point, aviator_multiplier, aviator_return_factor, aviator_time_for,
    aviator_multiplier_hundredths, aviator_payout_chips,
)
from live_engines import (
    LIVE_GAMES, SIDE_OPTIONS, generate_outcome, validate_selection,
    settle_bet, summarize_outcome, make_bingo_card, paytable_for, limits_for,
    PICTURE_SYMBOLS, PICTURE_BASE_MULTIPLIER, betting_mutation_open,
    fixed_cycle_clock,
)
from game_access import require_playable_game
from transactions import run_game_transaction

logger = logging.getLogger('live')
router = APIRouter(tags=['live'])


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


# ======================================================================
# AVIATOR - server-authoritative crash game with universal live rounds
# ======================================================================
# Aviator uses a short launch window so consecutive crash rounds keep their
# compact live cadence. The value is returned by /state, so every client draws
# the same countdown from the server rather than maintaining its own schedule.
AV_BETTING = 5.0   # seconds bets are open before takeoff
AV_RESULT = 2.5    # compact crash-result cadence


class AviatorBet(BaseModel):
    amount: int = Field(ge=1, le=100_000)
    panel: int = Field(default=1, ge=1, le=2)
    auto_cashout: Optional[float] = Field(default=None, ge=1.01, le=1000)


class BetRef(BaseModel):
    bet_id: str


async def _av_create_round(round_number: int, start_ts: float):
    server_seed = secrets.token_hex(32)
    verification_factor = aviator_return_factor()
    fairness_version = AVIATOR_FAIRNESS_VERSION
    server_seed_hash = aviator_commitment(server_seed, verification_factor, fairness_version)
    crash = aviator_crash_point(server_seed, verification_factor)
    fly_start = start_ts + AV_BETTING
    crash_at = fly_start + aviator_time_for(crash)
    doc = {
        'round_number': round_number, 'betting_start': start_ts, 'fly_start': fly_start,
        'crash_point': crash, 'crash_at': crash_at, 'ends_at': crash_at + AV_RESULT,
        'status': 'OPEN', 'created_at': _now_iso(),
        # Never serialized by /state. It is revealed only after settlement by
        # the authenticated fairness endpoint below.
        'server_seed': server_seed, 'server_seed_hash': server_seed_hash,
        'verification_factor': verification_factor, 'fairness_version': fairness_version,
    }
    try:
        await db.aviator_rounds.insert_one(dict(doc))
        return doc
    except DuplicateKeyError:
        # unique index on round_number: someone else created it first
        persisted = await db.aviator_rounds.find_one({'round_number': round_number})
        if persisted is None:
            raise RuntimeError('Aviator round insert raced but no persisted round exists')
        return persisted


async def _av_history_doc(bet, payout, outcome, session=None):
    await db.game_rounds.insert_one({
        'id': str(uuid.uuid4()), 'user_id': bet['user_id'], 'slug': 'aviator', 'game_name': 'Aviator',
        'round_number': bet['round_number'], 'bet': bet['amount'], 'payout': payout,
        'status': 'SETTLED', 'outcome': outcome,
        'created_at': _now_iso(), 'settled_at': _now_iso(),
    }, session=session)


async def _av_cash_bet(bet, mult, crash_point=None, auto=False, cashout_deadline=None):
    """Atomically settle one OPEN bet and its wallet/history movements."""
    async def settle(session):
        if cashout_deadline is not None and time.time() >= cashout_deadline:
            return None
        current = await db.aviator_bets.find_one(
            {'id': bet['id'], 'status': 'OPEN'}, session=session,
        )
        if not current:
            return None
        multiplier_hundredths = aviator_multiplier_hundredths(mult)
        payout = aviator_payout_chips(current['amount'], mult)
        res = await db.aviator_bets.update_one(
            {'id': current['id'], 'status': 'OPEN'},
            {'$set': {
                'status': 'CASHED', 'active': False, 'payout': payout,
                'multiplier': multiplier_hundredths / 100,
                'multiplier_hundredths': multiplier_hundredths,
                'payout_rounding': 'INTEGER_HALF_UP_TO_CHIP',
                'auto': auto, 'settled_at': _now_iso(),
            }},
            session=session,
        )
        if res.modified_count == 0:
            return None
        await credit_chips(
            current['user_id'], payout, f'Aviator cashout {mult}x', ref=current['id'],
            kind=ledger.PAYOUT, game='aviator', session=session,
            source_refs=[current['id']], settlement_ref=str(current['round_number']),
        )
        await ledger.record_settlement(
            current['user_id'], [current['id']], 'aviator', status='SETTLED',
            settlement_ref=str(current['round_number']), session=session,
        )
        await _av_history_doc(
            current, payout,
            {'result': 'cashed_out', 'multiplier': mult, 'crash_point': crash_point},
            session=session,
        )
        return payout

    async with await client.start_session() as session:
        return await session.with_transaction(settle)


async def _av_lose_bet(bet, crash_point):
    """Atomically mark one bet lost and append its personal round history."""
    async def settle(session):
        current = await db.aviator_bets.find_one(
            {'id': bet['id'], 'status': 'OPEN'}, session=session,
        )
        if not current:
            return False
        res = await db.aviator_bets.update_one(
            {'id': current['id'], 'status': 'OPEN'},
            {'$set': {
                'status': 'LOST', 'active': False, 'payout': 0,
                'settled_at': _now_iso(),
            }},
            session=session,
        )
        if res.modified_count == 0:
            return False
        await ledger.record_settlement(
            current['user_id'], [current['id']], 'aviator', status='SETTLED',
            settlement_ref=str(current['round_number']), session=session,
        )
        await _av_history_doc(
            current, 0, {'result': 'crashed', 'crash_point': crash_point},
            session=session,
        )
        return True

    async with await client.start_session() as session:
        return await session.with_transaction(settle)


async def _av_settle_round(r):
    """Settle every OPEN bet of a crashed round. Idempotent."""
    crash = r['crash_point']
    while True:
        bets = await db.aviator_bets.find(
            {'round_number': r['round_number'], 'status': 'OPEN'}
        ).to_list(500)
        if not bets:
            break
        for b in bets:
            auto = b.get('auto_cashout')
            if auto and auto <= crash:
                await _av_cash_bet(b, auto, crash_point=crash, auto=True)
            else:
                await _av_lose_bet(b, crash)
    await db.aviator_rounds.update_one(
        {'round_number': r['round_number'], 'status': 'OPEN'}, {'$set': {'status': 'SETTLED'}}
    )


async def _av_auto_cash_flying(r, now):
    """Eagerly cash out auto-cashout bets whose target multiplier was reached."""
    mult = aviator_multiplier(now - r['fly_start'])
    while True:
        if time.time() >= r['crash_at']:
            return
        bets = await db.aviator_bets.find({
            'round_number': r['round_number'], 'status': 'OPEN',
            'auto_cashout': {'$ne': None, '$lte': mult},
        }).to_list(200)
        if not bets:
            break
        for b in bets:
            payout = await _av_cash_bet(
                b, b['auto_cashout'], crash_point=None, auto=True,
                cashout_deadline=r['crash_at'],
            )
            if payout is None and time.time() >= r['crash_at']:
                return


async def advance_aviator():
    """Advance the global aviator machine. Idempotent - safe to call from
    the background keepalive task AND from any request."""
    now = time.time()
    r = await db.aviator_rounds.find_one({}, sort=[('round_number', -1)])
    if r is None:
        return await _av_create_round(1, now)
    if now >= r['crash_at'] and r.get('status') == 'OPEN':
        await _av_settle_round(r)
        r = await db.aviator_rounds.find_one({'round_number': r['round_number']})
    if now >= r['ends_at']:
        return await _av_create_round(r['round_number'] + 1, max(now, r['ends_at']))
    if r['fly_start'] <= now < r['crash_at']:
        await _av_auto_cash_flying(r, now)
    return r


def _av_phase(r, now):
    if now < r['fly_start']:
        return 'BETTING', r['fly_start'] - now
    if now < r['crash_at']:
        return 'FLYING', now - r['fly_start']
    return 'CRASHED', max(0.0, r['ends_at'] - now)


@router.get('/live/aviator/state')
async def aviator_state(user: dict = Depends(require_active_player)):
    await require_playable_game('aviator')
    r = await advance_aviator()
    now = time.time()
    phase, t = _av_phase(r, now)
    rn = r['round_number']

    # Independent reads run concurrently (one DB round-trip window instead of six).
    my, feed_raw, previous_raw, hist, balance = await asyncio.gather(
        db.aviator_bets.find(
            {'user_id': user['id'], 'round_number': {'$in': [rn - 1, rn, rn + 1]}},
            {'_id': 0, 'user_id': 0},
        ).sort('created_at', 1).to_list(20),
        db.aviator_bets.find(
            {'round_number': rn, 'status': {'$in': ['OPEN', 'CASHED', 'LOST']}}, {'_id': 0}
        ).sort('amount', -1).to_list(40),
        db.aviator_bets.find(
            {'round_number': rn - 1, 'status': {'$in': ['CASHED', 'LOST']}}, {'_id': 0}
        ).sort('amount', -1).to_list(40),
        db.aviator_rounds.find(
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
        # This commitment is public while betting is open; the seed itself is
        # revealed only after settlement by the fairness endpoint.
        'server_seed_hash': r.get('server_seed_hash', ''),
        'betting_seconds': AV_BETTING, 'result_seconds': AV_RESULT, 'growth': AVIATOR_GROWTH,
        'my_bets': my, 'all_bets': feed, 'players': len(feed_raw),
        'previous_bets': previous_feed,
        'total_staked': sum(b['amount'] for b in feed_raw),
        'history': [{
            'round_number': h['round_number'], 'crash_point': h['crash_point'],
            'proof_available': bool(h.get('server_seed')),
        } for h in hist],
        'balance': balance,
        'min_bet': limits_for('aviator')[0], 'max_bet': limits_for('aviator')[1],
    }
    if phase == 'BETTING':
        resp['phase_ends_in'] = round(t, 2)
    elif phase == 'FLYING':
        resp['fly_elapsed'] = round(t, 3)
        resp['multiplier'] = aviator_multiplier(t)
    else:
        resp['phase_ends_in'] = round(t, 2)
        resp['crash_point'] = r['crash_point']
        resp['flight_seconds'] = round(max(0, r['crash_at'] - r['fly_start']), 3)
    return resp


@router.get('/live/aviator/rounds/{round_number}/fairness')
async def aviator_round_fairness(round_number: int, user: dict = Depends(require_active_player)):
    await require_playable_game('aviator')
    r = await db.aviator_rounds.find_one({'round_number': round_number}, {'_id': 0})
    if not r:
        raise HTTPException(status_code=404, detail='Round not found')
    if r.get('status') != 'SETTLED' or not r.get('server_seed'):
        raise HTTPException(status_code=409, detail='The server seed is revealed after the round settles')
    fairness_version = int(r.get('fairness_version') or 1)
    verification_factor_text = aviator_factor_text(r['verification_factor'])
    result_hash = hashlib.sha256(f"aviator-crash-v1:{r['server_seed']}".encode()).hexdigest()
    return {
        'createdAt': r.get('created_at'),
        'serverSeed': r['server_seed'],
        'serverSeedHash': r.get('server_seed_hash', ''),
        'resultHash': result_hash,
        'seedOfUsers': [],
        'flyDetailID': round_number,
        'crashPoint': r['crash_point'],
        'target': r['crash_point'],
        # Returned only after settlement so the client can independently derive
        # and verify the published crash point. It is not shown in the game UI.
        'verificationFactor': r['verification_factor'],
        'verificationFactorText': verification_factor_text,
        'fairnessVersion': fairness_version,
        'commitmentPayload': aviator_commitment_payload(
            r['server_seed'], r['verification_factor'], fairness_version,
        ),
        'algorithm': 'SHA256 / crash-v1',
    }


@router.get('/live/aviator/top')
async def aviator_top(period: str = 'day', user: dict = Depends(require_active_player)):
    await require_playable_game('aviator')
    windows = {'day': timedelta(days=1), 'month': timedelta(days=31), 'year': timedelta(days=366)}
    if period not in windows:
        raise HTTPException(status_code=400, detail='Period must be day, month, or year')
    cutoff = (datetime.now(timezone.utc) - windows[period]).isoformat()
    rows = await db.game_rounds.find(
        {'slug': 'aviator', 'status': 'SETTLED', 'payout': {'$gt': 0}, 'created_at': {'$gte': cutoff}},
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


@router.post('/live/aviator/bets')
async def aviator_place_bet(body: AviatorBet, user: dict = Depends(require_active_player)):
    await require_playable_game('aviator')
    _min, _max = limits_for('aviator')
    if body.amount < _min:
        raise HTTPException(status_code=400, detail=f'Minimum bet is {_min} chips')
    if body.amount > _max:
        raise HTTPException(status_code=400, detail=f'Maximum bet is {_max} chips')
    r = await advance_aviator()
    now = time.time()
    phase, t = _av_phase(r, now)
    # Bets during a flight/result queue for the next round.
    if phase == 'BETTING' and t > 0.3:
        target_rn = r['round_number']
    else:
        target_rn = r['round_number'] + 1
    bet_id = str(uuid.uuid4())
    auto_hundredths = (
        aviator_multiplier_hundredths(body.auto_cashout)
        if body.auto_cashout is not None else None
    )
    auto = auto_hundredths / 100 if auto_hundredths is not None else None
    bet = {
        'id': bet_id, 'user_id': user['id'], 'round_number': target_rn, 'panel': body.panel,
        'amount': body.amount, 'auto_cashout': auto,
        'auto_cashout_hundredths': auto_hundredths,
        'status': 'OPEN', 'active': True,
        'payout': 0, 'multiplier': None, 'created_at': _now_iso(),
    }

    async def reserve_and_debit(session):
        existing = await db.aviator_bets.find_one({
            'user_id': user['id'], 'round_number': target_rn,
            'panel': body.panel, 'status': 'OPEN',
        }, session=session)
        if existing:
            raise DuplicateKeyError('active Aviator panel bet already exists')
        await db.aviator_bets.insert_one(dict(bet), session=session)
        await debit_chips(
            user['id'], body.amount, f'Aviator bet (round {target_rn})', ref=bet_id,
            kind=ledger.STAKE, game='aviator', session=session,
        )

    try:
        async with await client.start_session() as session:
            await session.with_transaction(reserve_and_debit)
    except DuplicateKeyError:
        raise HTTPException(status_code=409, detail='You already have an active bet on this panel for that round')
    except InsufficientChips:
        raise HTTPException(status_code=400, detail='Your available balance is too low for this stake')
    balance = await _fresh_balance(user['id'])
    return {
        'bet_id': bet_id, 'round_number': target_rn, 'panel': body.panel,
        'queued': target_rn != r['round_number'], 'balance': balance,
    }


@router.post('/live/aviator/bets/cancel')
async def aviator_cancel_bet(body: BetRef, user: dict = Depends(require_active_player)):
    await require_playable_game('aviator')
    b = await db.aviator_bets.find_one({'id': body.bet_id, 'user_id': user['id']})
    if not b:
        raise HTTPException(status_code=404, detail='Bet not found')
    if b['status'] != 'OPEN':
        raise HTTPException(status_code=400, detail='Bet already settled')
    r = await db.aviator_rounds.find_one({}, sort=[('round_number', -1)])
    now = time.time()
    phase, t = _av_phase(r, now) if r else ('BETTING', 99)
    cancellable = b['round_number'] > r['round_number'] or (
        b['round_number'] == r['round_number'] and phase == 'BETTING' and t > 0.3)
    if not cancellable:
        raise HTTPException(status_code=400, detail='Too late to cancel - the plane is taking off')
    async def cancel_and_refund(session):
        current = await db.aviator_bets.find_one(
            {'id': b['id'], 'user_id': user['id'], 'status': 'OPEN'}, session=session,
        )
        if not current:
            return None
        res = await db.aviator_bets.update_one(
            {'id': current['id'], 'status': 'OPEN'},
            {'$set': {'status': 'CANCELLED', 'active': False, 'settled_at': _now_iso()}},
            session=session,
        )
        if res.modified_count == 0:
            return None
        return await credit_chips(
            user['id'], current['amount'], 'Aviator bet cancelled', ref=current['id'],
            kind=ledger.REFUND, game='aviator', session=session,
        )

    async with await client.start_session() as session:
        balance = await session.with_transaction(cancel_and_refund)
    if balance is None:
        raise HTTPException(status_code=400, detail='Bet already settled')
    return {'message': 'Bet cancelled', 'refunded': b['amount'], 'balance': balance}


@router.post('/live/aviator/cashout')
async def aviator_cashout(body: BetRef, user: dict = Depends(require_active_player)):
    await require_playable_game('aviator')
    b = await db.aviator_bets.find_one({'id': body.bet_id, 'user_id': user['id']})
    if not b:
        raise HTTPException(status_code=404, detail='Bet not found')
    if b['status'] != 'OPEN':
        raise HTTPException(status_code=400, detail='Bet already settled')
    r = await db.aviator_rounds.find_one({'round_number': b['round_number']})
    if not r:
        raise HTTPException(status_code=400, detail='Round not found')
    now = time.time()
    if now < r['fly_start']:
        raise HTTPException(status_code=400, detail='The round has not taken off yet')
    if now >= r['crash_at']:
        if r.get('status') == 'OPEN':
            await _av_settle_round(r)
        balance = await _fresh_balance(user['id'])
        return {'result': 'crashed', 'crash_point': r['crash_point'], 'payout': 0, 'balance': balance}
    mult = aviator_multiplier(now - r['fly_start'])
    payout = await _av_cash_bet(b, mult, cashout_deadline=r['crash_at'])
    if payout is None:
        now = time.time()
        if now >= r['crash_at']:
            if r.get('status') == 'OPEN':
                await _av_settle_round(r)
            balance = await _fresh_balance(user['id'])
            return {'result': 'crashed', 'crash_point': r['crash_point'], 'payout': 0, 'balance': balance}
        raise HTTPException(status_code=400, detail='Bet already settled')
    balance = await _fresh_balance(user['id'])
    return {'result': 'cashed_out', 'multiplier': mult, 'payout': payout, 'balance': balance}


# ======================================================================
# GENERIC fixed-cycle live games (16 games)
# ======================================================================
class LiveBet(BaseModel):
    amount: int = Field(ge=1, le=100_000)
    selection: object = None


def _live_clock(slug, now=None):
    cfg = LIVE_GAMES[slug]
    now = time.time() if now is None else now
    rn, phase, ends, _, total = fixed_cycle_clock(
        now, cfg['bet'], cfg['reveal'], cfg['result']
    )
    return rn, phase, round(ends, 2), total


BETTING_MUTATION_GUARD = 0.4


def _require_live_betting(slug, expected_round=None, message='Bets are closed - wait for the next round.'):
    """Sample the shared clock immediately before mutating a bet or wallet."""
    rn, phase, ends_in, _ = _live_clock(slug)
    if not betting_mutation_open(
        phase, ends_in, rn, expected_round, BETTING_MUTATION_GUARD
    ):
        raise HTTPException(status_code=409, detail={'code': 'BETS_CLOSED', 'message': message})
    return rn, ends_in


# A round's universal outcome is immutable once created, so an in-process cache
# is always correct and removes one DB read from every player's poll (the single
# hottest query at scale — thousands of players share the same few live rounds).
_OUTCOME_CACHE = {}
_OUTCOME_CACHE_MAX = 5000


def _cache_outcome(slug, rn, outcome):
    if len(_OUTCOME_CACHE) >= _OUTCOME_CACHE_MAX:
        for k in list(_OUTCOME_CACHE.keys())[:1000]:  # drop the oldest ~1000
            _OUTCOME_CACHE.pop(k, None)
    _OUTCOME_CACHE[(slug, rn)] = outcome


async def _live_outcome(slug, rn):
    """Get or atomically create the universal outcome for (slug, round)."""
    hit = _OUTCOME_CACHE.get((slug, rn))
    if hit is not None:
        return hit
    ex = await db.live_outcomes.find_one({'slug': slug, 'round_number': rn}, {'_id': 0})
    if ex:
        _cache_outcome(slug, rn, ex['outcome'])
        return ex['outcome']
    outcome = generate_outcome(slug)
    doc = {
        'slug': slug, 'round_number': rn, 'outcome': outcome,
        'summary': summarize_outcome(slug, outcome), 'created_at': _now_iso(),
    }
    try:
        await db.live_outcomes.insert_one(doc)
        _cache_outcome(slug, rn, outcome)
        return outcome
    except DuplicateKeyError:
        ex = await db.live_outcomes.find_one({'slug': slug, 'round_number': rn}, {'_id': 0})
        if ex is None:
            raise RuntimeError('Live outcome insert raced but no persisted outcome exists')
        final = ex['outcome']
        _cache_outcome(slug, rn, final)
        return final


async def _live_settle_user(user_id, slug, current_rn, phase):
    """Idempotently settle this user's OPEN bets from closed betting windows."""
    query = {'user_id': user_id, 'slug': slug, 'status': 'OPEN'}
    query['round_number'] = {'$lte': current_rn} if phase == 'RESULT' else {'$lt': current_rn}
    # Discover rounds without applying a UI-page cap. Each complete round is
    # then read and settled inside its own transaction below.
    round_numbers = await db.live_bets.distinct('round_number', query)
    if not round_numbers:
        return None
    game = await db.games.find_one({'slug': slug})
    gname = game['name'] if game else slug
    summary = None
    for rn in sorted(round_numbers):
        outcome = await _live_outcome(slug, rn)
        async def settle_round(session):
            kwargs = {'session': session} if session is not None else {}
            bets = await db.live_bets.find({
                'user_id': user_id, 'slug': slug, 'round_number': rn, 'status': 'OPEN',
            }, **kwargs).to_list(length=None)
            total_bet, total_payout, details, settled_refs = 0, 0, [], []
            for b in bets:
                try:
                    payout, detail = settle_bet(
                        slug, outcome, b.get('selection'), b['amount'], card=b.get('card'),
                    )
                except HTTPException:
                    payout, detail = 0, {'result': 'void'}
                payout = int(payout)
                res = await db.live_bets.update_one(
                    {'id': b['id'], 'status': 'OPEN'},
                    {'$set': {'status': 'SETTLED', 'payout': payout, 'settled_at': _now_iso()}},
                    **kwargs,
                )
                if res.modified_count == 0:
                    continue
                settled_refs.append(b['id'])
                total_bet += b['amount']
                total_payout += payout
                if payout > 0:
                    await credit_chips(
                        user_id, payout, f'{gname} bet win (round {rn})',
                        ref=f'{rn}:{b["id"]}', kind=ledger.PAYOUT,
                        game=slug, session=session, source_refs=[b['id']],
                        settlement_ref=str(rn),
                    )
                entry = {'selection': b.get('selection'), 'amount': b['amount'], 'payout': payout}
                entry.update(detail)
                if b.get('card'):
                    entry['card'] = b['card']
                details.append(entry)
            if total_bet == 0:
                return None
            await ledger.record_settlement(
                user_id, settled_refs, slug, status='SETTLED',
                settlement_ref=str(rn), session=session,
            )
            await db.game_rounds.insert_one({
                'id': str(uuid.uuid4()), 'user_id': user_id, 'slug': slug, 'game_name': gname,
                'bet': total_bet, 'payout': total_payout, 'status': 'SETTLED',
                'outcome': {'round_number': rn, 'summary': summarize_outcome(slug, outcome), 'bets': details},
                'created_at': _now_iso(), 'settled_at': _now_iso(),
            }, **kwargs)
            return {
                'round_number': rn, 'total_bet': total_bet, 'payout': total_payout,
                'outcome': outcome, 'bets': details,
            }

        settled_round = await run_game_transaction(client, settle_round)
        if settled_round is not None:
            summary = settled_round
    return summary


@router.get('/live/{slug}/state')
async def live_state(slug: str, user: dict = Depends(require_active_player)):
    await require_playable_game(slug)
    if slug not in LIVE_GAMES:
        raise HTTPException(status_code=404, detail='No live table for this game')
    clock_sampled_at = time.time()
    rn, phase, ends_in, total = _live_clock(slug, clock_sampled_at)
    phase_offset = (LIVE_GAMES[slug]['bet'] if phase == 'BETTING'
                    else LIVE_GAMES[slug]['bet'] + LIVE_GAMES[slug]['reveal'] if phase == 'REVEAL'
                    else total)
    phase_ends_at = rn * total + phase_offset
    settled = await _live_settle_user(user['id'], slug, rn, phase)

    outcome = None
    if phase != 'BETTING':
        outcome = await _live_outcome(slug, rn)

    # 7Up7Down prints rolling percentages calculated from the last 100 shared
    # rounds. Other cabinets only need their compact ten-result strip.
    history_limit = 100 if slug in ('seven-up-down', 'andar-bahar', 'pappu-pictures') else 10
    history_floor = history_limit
    prev = await db.live_outcomes.find(
        {'slug': slug, 'round_number': {'$lt': rn}}, {'_id': 0, 'round_number': 1, 'summary': 1}
    ).sort('round_number', -1).to_list(history_limit)
    if len(prev) < history_floor:
        have = {p['round_number'] for p in prev}
        missing = [rn - i for i in range(1, history_floor + 1) if rn - i >= 0 and rn - i not in have]
        # Seed the empty roadmap in one bounded concurrent window. Each result
        # is still created by the same atomic outcome path used by live rounds.
        for start in range(0, len(missing), 20):
            await asyncio.gather(*(_live_outcome(slug, past) for past in missing[start:start + 20]))
        prev = await db.live_outcomes.find(
            {'slug': slug, 'round_number': {'$lt': rn}}, {'_id': 0, 'round_number': 1, 'summary': 1}
        ).sort('round_number', -1).to_list(history_limit)

    my_bets, balance, win_rows = await asyncio.gather(
        db.live_bets.find(
            {'user_id': user['id'], 'slug': slug, 'round_number': rn, 'status': {'$in': ['OPEN', 'SETTLED']}},
            {'_id': 0, 'user_id': 0},
        ).to_list(50),
        _fresh_balance(user['id']),
        db.game_rounds.find(
            {'slug': slug, 'payout': {'$gt': 0}},
            {'_id': 0, 'id': 1, 'user_id': 1, 'payout': 1, 'bet': 1},
        ).sort('settled_at', -1).to_list(16),
    )

    # Real cross-player winners for the live floor (masked, excludes self).
    winners = []
    win_uids = list({w['user_id'] for w in win_rows if w['user_id'] != user['id']})
    wnames = {}
    if win_uids:
        wus = await db.users.find(
            {'id': {'$in': win_uids}}, {'_id': 0, 'id': 1, 'display_name': 1, 'email': 1}
        ).to_list(40)
        wnames = {u['id']: (u.get('display_name') or u.get('email', 'Player').split('@')[0]) for u in wus}
    for w in win_rows:
        if w['user_id'] == user['id']:
            continue
        winners.append({
            'id': w['id'], 'name': _mask(wnames.get(w['user_id'], 'Player')),
            'payout': w['payout'], 'bet': w.get('bet', 0),
        })
        if len(winners) >= 10:
            break

    cfg = LIVE_GAMES[slug]
    return {
        'round_number': rn, 'phase': phase, 'phase_ends_in': ends_in,
        'clock_sampled_at': clock_sampled_at,
        'phase_ends_at': phase_ends_at,
        'round_ends_at': (rn + 1) * total,
        'timings': {'bet': cfg['bet'], 'reveal': cfg['reveal'], 'result': cfg['result'], 'total': total},
        'kind': cfg['kind'], 'options': SIDE_OPTIONS.get(slug),
        # The stake limits the table is actually held to. The cabinet screens
        # print these on the message rail and size their chip rail from them, and
        # a table that offered a chip this endpoint would refuse — or printed a
        # minimum that was not the minimum — would be lying to the player about
        # what it accepts. Sent rather than hardcoded in the client for the same
        # reason the odds are.
        'min_bet': limits_for(slug)[0], 'max_bet': limits_for(slug)[1],
        # The engine's own price list, so the felt cannot quote an offer
        # settlement would not honour.
        'paytable': paytable_for(slug),
        'game_config': ({
            'pool': 36,
            'draw_count': 10,
            'max_picks': 10,
            'paytable': KENO_PAYTABLE,
        } if slug == 'keno' else ({
            'symbols': list(PICTURE_SYMBOLS),
            'base_multiplier': PICTURE_BASE_MULTIPLIER,
            'roadmap_size': 36,
        } if slug == 'pappu-pictures' else None)),
        'outcome': outcome, 'my_bets': my_bets,
        'my_total': sum(b['amount'] for b in my_bets),
        'last_results': [{'round_number': p['round_number'], **(p.get('summary') or {})} for p in prev],
        'winners': winners,
        'settled': settled, 'balance': balance, 'server_now': time.time(),
    }


@router.post('/live/{slug}/bets')
async def live_place_bet(slug: str, body: LiveBet, user: dict = Depends(require_active_player)):
    await require_playable_game(slug)
    if slug not in LIVE_GAMES:
        raise HTTPException(status_code=404, detail='No live table for this game')
    rn, _ = _require_live_betting(slug)
    _min, _max = limits_for(slug)
    if body.amount < _min:
        raise HTTPException(status_code=400, detail=f'Minimum bet is {_min} chips')
    if body.amount > _max:
        raise HTTPException(status_code=400, detail=f'Maximum bet is {_max} chips')
    selection = validate_selection(slug, body.selection)
    card = make_bingo_card() if slug == 'bingo' else None
    bet_id = str(uuid.uuid4())
    doc = {
        'id': bet_id, 'user_id': user['id'], 'slug': slug, 'round_number': rn,
        'selection': selection, 'amount': body.amount, 'status': 'OPEN', 'payout': 0,
        'created_at': _now_iso(),
    }
    if card:
        doc['card'] = card

    async def place_bet(session):
        kwargs = {'session': session} if session is not None else {}
        # Selection validation may be non-trivial (and Bingo creates a card),
        # so close the race immediately before the atomic wallet/bet mutation.
        _require_live_betting(slug, expected_round=rn)
        await debit_chips(
            user['id'], body.amount, f'Live bet {slug} (round {rn})',
            ref=bet_id, kind=ledger.STAKE, game=slug, session=session,
        )
        await db.live_bets.insert_one(dict(doc), **kwargs)

    try:
        await run_game_transaction(client, place_bet)
    except InsufficientChips:
        raise HTTPException(status_code=400, detail='Your available balance is too low for this stake')
    my_bets = await db.live_bets.find(
        {'user_id': user['id'], 'slug': slug, 'round_number': rn, 'status': 'OPEN'},
        {'_id': 0, 'user_id': 0},
    ).to_list(50)
    balance = await _fresh_balance(user['id'])
    return {
        'message': 'Bet placed', 'bet_id': bet_id, 'round_number': rn,
        'my_bets': my_bets, 'my_total': sum(b['amount'] for b in my_bets), 'balance': balance,
    }


@router.post('/live/{slug}/bets/clear')
async def live_clear_bets(slug: str, user: dict = Depends(require_active_player)):
    await require_playable_game(slug)
    if slug not in LIVE_GAMES:
        raise HTTPException(status_code=404, detail='No live table for this game')
    rn, _ = _require_live_betting(slug, message='Bets are locked for this round.')
    async def clear_bets(session):
        kwargs = {'session': session} if session is not None else {}
        open_bets = await db.live_bets.find(
            {'user_id': user['id'], 'slug': slug, 'round_number': rn, 'status': 'OPEN'},
            **kwargs,
        ).to_list(length=None)
        _require_live_betting(slug, expected_round=rn, message='Bets are locked for this round.')
        refunded = 0
        refunded_refs = []
        for b in open_bets:
            res = await db.live_bets.update_one(
                {'id': b['id'], 'status': 'OPEN'},
                {'$set': {'status': 'REFUNDED', 'settled_at': _now_iso()}},
                **kwargs,
            )
            if res.modified_count:
                refunded += b['amount']
                refunded_refs.append(b['id'])
        if refunded > 0:
            await credit_chips(
                user['id'], refunded, f'Live bets refunded ({slug} round {rn})',
                ref=str(rn), kind=ledger.REFUND, game=slug, session=session,
                source_refs=refunded_refs, settlement_ref=str(rn),
            )
        return refunded

    refunded = await run_game_transaction(client, clear_bets)
    balance = await _fresh_balance(user['id'])
    return {'message': 'Bets cleared', 'refunded': refunded, 'balance': balance}


@router.post('/live/{slug}/bets/undo')
async def live_undo_bet(slug: str, user: dict = Depends(require_active_player)):
    """Refund only the most recently placed chip in the open betting window."""
    await require_playable_game(slug)
    if slug not in LIVE_GAMES:
        raise HTTPException(status_code=404, detail='No live table for this game')
    rn, _ = _require_live_betting(slug, message='Bets are locked for this round.')

    async def undo_bet(session):
        kwargs = {'session': session} if session is not None else {}
        bet = await db.live_bets.find_one(
            {'user_id': user['id'], 'slug': slug, 'round_number': rn, 'status': 'OPEN'},
            sort=[('created_at', -1)], **kwargs,
        )
        if not bet:
            return 0
        _require_live_betting(slug, expected_round=rn, message='Bets are locked for this round.')
        res = await db.live_bets.update_one(
            {'id': bet['id'], 'status': 'OPEN'},
            {'$set': {'status': 'REFUNDED', 'settled_at': _now_iso()}},
            **kwargs,
        )
        if res.modified_count == 0:
            return 0
        refunded = bet['amount']
        await credit_chips(
            user['id'], refunded, f'Live bet undone ({slug} round {rn})',
            ref=bet['id'], kind=ledger.REFUND, game=slug, session=session,
        )
        return refunded

    refunded = await run_game_transaction(client, undo_bet)

    my_bets = await db.live_bets.find(
        {'user_id': user['id'], 'slug': slug, 'round_number': rn, 'status': 'OPEN'},
        {'_id': 0, 'user_id': 0},
    ).sort('created_at', 1).to_list(50)
    balance = await _fresh_balance(user['id'])
    return {
        'message': 'Last bet undone' if refunded else 'No open bet to undo',
        'refunded': refunded, 'my_bets': my_bets,
        'my_total': sum(b['amount'] for b in my_bets), 'balance': balance,
    }
