"""Universal 24/7 live-round routes - every player sees the SAME rounds.

- Fixed-cycle games (16): rounds derived from epoch time; one outcome per
  (slug, round_number) created atomically and shared by all players.
- Aviator: DB-chained variable-length rounds (BETTING -> FLYING -> CRASHED)
  kept alive 24/7 by a background task in server.py.

All chip movement is server-authoritative through the ledger.
"""
import uuid
import time
import asyncio
import logging
from datetime import datetime, timezone
from typing import Optional
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel, Field
from db import db
from auth_utils import require_active_player
from ledger import credit_chips, debit_chips, InsufficientChips
from game_engines import (
    MIN_BET, MAX_BET, AVIATOR_GROWTH,
    aviator_crash_point, aviator_multiplier, aviator_time_for,
)
from live_engines import (
    LIVE_GAMES, SIDE_OPTIONS, generate_outcome, validate_selection,
    settle_bet, summarize_outcome, make_bingo_card,
)

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
# AVIATOR - Spribe-style crash game with universal live rounds
# ======================================================================
AV_BETTING = 6.0   # seconds bets are open before takeoff
AV_RESULT = 4.0    # seconds the crash result stays on screen


class AviatorBet(BaseModel):
    amount: int = Field(ge=1, le=100_000)
    panel: int = Field(default=1, ge=1, le=2)
    auto_cashout: Optional[float] = Field(default=None, ge=1.01, le=200)


class BetRef(BaseModel):
    bet_id: str


async def _av_create_round(round_number: int, start_ts: float):
    crash = aviator_crash_point()
    fly_start = start_ts + AV_BETTING
    crash_at = fly_start + aviator_time_for(crash)
    doc = {
        'round_number': round_number, 'betting_start': start_ts, 'fly_start': fly_start,
        'crash_point': crash, 'crash_at': crash_at, 'ends_at': crash_at + AV_RESULT,
        'status': 'OPEN', 'created_at': _now_iso(),
    }
    try:
        await db.aviator_rounds.insert_one(dict(doc))
        return doc
    except Exception:
        # unique index on round_number: someone else created it first
        return await db.aviator_rounds.find_one({'round_number': round_number})


async def _av_history_doc(bet, payout, outcome):
    await db.game_rounds.insert_one({
        'id': str(uuid.uuid4()), 'user_id': bet['user_id'], 'slug': 'aviator', 'game_name': 'Aviator',
        'bet': bet['amount'], 'payout': payout, 'status': 'SETTLED', 'outcome': outcome,
        'created_at': _now_iso(), 'settled_at': _now_iso(),
    })


async def _av_cash_bet(bet, mult, crash_point=None, auto=False):
    """Idempotently settle one OPEN bet as cashed out. Returns payout or None."""
    payout = int(round(bet['amount'] * mult))
    res = await db.aviator_bets.update_one(
        {'id': bet['id'], 'status': 'OPEN'},
        {'$set': {'status': 'CASHED', 'payout': payout, 'multiplier': mult, 'auto': auto, 'settled_at': _now_iso()}},
    )
    if res.modified_count == 0:
        return None
    await credit_chips(bet['user_id'], payout, f'Aviator cashout {mult}x', ref=bet['id'])
    await _av_history_doc(bet, payout, {'result': 'cashed_out', 'multiplier': mult, 'crash_point': crash_point})
    return payout


async def _av_settle_round(r):
    """Settle every OPEN bet of a crashed round. Idempotent."""
    crash = r['crash_point']
    bets = await db.aviator_bets.find({'round_number': r['round_number'], 'status': 'OPEN'}).to_list(500)
    for b in bets:
        auto = b.get('auto_cashout')
        if auto and auto <= crash:
            await _av_cash_bet(b, auto, crash_point=crash, auto=True)
        else:
            res = await db.aviator_bets.update_one(
                {'id': b['id'], 'status': 'OPEN'},
                {'$set': {'status': 'LOST', 'payout': 0, 'settled_at': _now_iso()}},
            )
            if res.modified_count:
                await _av_history_doc(b, 0, {'result': 'crashed', 'crash_point': crash})
    await db.aviator_rounds.update_one(
        {'round_number': r['round_number'], 'status': 'OPEN'}, {'$set': {'status': 'SETTLED'}}
    )


async def _av_auto_cash_flying(r, now):
    """Eagerly cash out auto-cashout bets whose target multiplier was reached."""
    mult = aviator_multiplier(now - r['fly_start'])
    bets = await db.aviator_bets.find({
        'round_number': r['round_number'], 'status': 'OPEN',
        'auto_cashout': {'$ne': None, '$lte': mult},
    }).to_list(200)
    for b in bets:
        await _av_cash_bet(b, b['auto_cashout'], crash_point=None, auto=True)


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
    r = await advance_aviator()
    now = time.time()
    phase, t = _av_phase(r, now)
    rn = r['round_number']

    # Independent reads run concurrently (one DB round-trip window instead of four).
    my, feed_raw, hist, balance = await asyncio.gather(
        db.aviator_bets.find(
            {'user_id': user['id'], 'round_number': {'$in': [rn, rn + 1]}},
            {'_id': 0, 'user_id': 0},
        ).sort('created_at', 1).to_list(20),
        db.aviator_bets.find(
            {'round_number': rn, 'status': {'$in': ['OPEN', 'CASHED', 'LOST']}}, {'_id': 0}
        ).sort('amount', -1).to_list(40),
        db.aviator_rounds.find(
            {'status': 'SETTLED'}, {'_id': 0, 'round_number': 1, 'crash_point': 1}
        ).sort('round_number', -1).to_list(20),
        _fresh_balance(user['id']),
    )
    for b in my:
        b['queued'] = b['round_number'] > rn

    ids = list({b['user_id'] for b in feed_raw})
    names = {}
    if ids:
        users = await db.users.find({'id': {'$in': ids}}, {'_id': 0, 'id': 1, 'display_name': 1, 'email': 1}).to_list(60)
        names = {u['id']: (u.get('display_name') or u.get('email', 'Player').split('@')[0]) for u in users}
    feed = [{
        'name': _mask(names.get(b['user_id'], 'Player')), 'amount': b['amount'],
        'status': b['status'], 'multiplier': b.get('multiplier'), 'payout': b.get('payout', 0),
    } for b in feed_raw]
    resp = {
        'round_number': rn, 'phase': phase, 'server_now': now,
        'betting_seconds': AV_BETTING, 'result_seconds': AV_RESULT, 'growth': AVIATOR_GROWTH,
        'my_bets': my, 'all_bets': feed, 'players': len(feed_raw),
        'total_staked': sum(b['amount'] for b in feed_raw),
        'history': [{'round_number': h['round_number'], 'crash_point': h['crash_point']} for h in hist],
        'balance': balance,
    }
    if phase == 'BETTING':
        resp['phase_ends_in'] = round(t, 2)
    elif phase == 'FLYING':
        resp['fly_elapsed'] = round(t, 3)
        resp['multiplier'] = aviator_multiplier(t)
    else:
        resp['phase_ends_in'] = round(t, 2)
        resp['crash_point'] = r['crash_point']
    return resp


@router.post('/live/aviator/bets')
async def aviator_place_bet(body: AviatorBet, user: dict = Depends(require_active_player)):
    if body.amount < MIN_BET:
        raise HTTPException(status_code=400, detail=f'Minimum bet is {MIN_BET} chips')
    r = await advance_aviator()
    now = time.time()
    phase, t = _av_phase(r, now)
    # Bets during a flight/result queue for the NEXT round (Spribe behaviour)
    if phase == 'BETTING' and t > 0.3:
        target_rn = r['round_number']
    else:
        target_rn = r['round_number'] + 1
    existing = await db.aviator_bets.find_one(
        {'user_id': user['id'], 'round_number': target_rn, 'panel': body.panel, 'status': 'OPEN'})
    if existing:
        raise HTTPException(status_code=409, detail='You already have an active bet on this panel for that round')
    bet_id = str(uuid.uuid4())
    try:
        await debit_chips(user['id'], body.amount, f'Aviator bet (round {target_rn})', ref=bet_id)
    except InsufficientChips:
        raise HTTPException(status_code=400, detail='Not enough play chips for this bet')
    auto = round(float(body.auto_cashout), 2) if body.auto_cashout else None
    await db.aviator_bets.insert_one({
        'id': bet_id, 'user_id': user['id'], 'round_number': target_rn, 'panel': body.panel,
        'amount': body.amount, 'auto_cashout': auto, 'status': 'OPEN', 'payout': 0,
        'multiplier': None, 'created_at': _now_iso(),
    })
    balance = await _fresh_balance(user['id'])
    return {
        'bet_id': bet_id, 'round_number': target_rn, 'panel': body.panel,
        'queued': target_rn != r['round_number'], 'balance': balance,
    }


@router.post('/live/aviator/bets/cancel')
async def aviator_cancel_bet(body: BetRef, user: dict = Depends(require_active_player)):
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
    res = await db.aviator_bets.update_one(
        {'id': b['id'], 'status': 'OPEN'},
        {'$set': {'status': 'CANCELLED', 'settled_at': _now_iso()}},
    )
    if res.modified_count == 0:
        raise HTTPException(status_code=400, detail='Bet already settled')
    balance = await credit_chips(user['id'], b['amount'], 'Aviator bet cancelled', ref=b['id'])
    return {'message': 'Bet cancelled', 'refunded': b['amount'], 'balance': balance}


@router.post('/live/aviator/cashout')
async def aviator_cashout(body: BetRef, user: dict = Depends(require_active_player)):
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
    payout = await _av_cash_bet(b, mult)
    if payout is None:
        raise HTTPException(status_code=400, detail='Bet already settled')
    balance = await _fresh_balance(user['id'])
    return {'result': 'cashed_out', 'multiplier': mult, 'payout': payout, 'balance': balance}


# ======================================================================
# GENERIC fixed-cycle live games (16 games)
# ======================================================================
class LiveBet(BaseModel):
    amount: int = Field(ge=1, le=100_000)
    selection: object = None


def _live_clock(slug):
    cfg = LIVE_GAMES[slug]
    total = cfg['bet'] + cfg['reveal'] + cfg['result']
    now = time.time()
    rn = int(now // total)
    t = now % total
    if t < cfg['bet']:
        phase, ends = 'BETTING', cfg['bet'] - t
    elif t < cfg['bet'] + cfg['reveal']:
        phase, ends = 'REVEAL', cfg['bet'] + cfg['reveal'] - t
    else:
        phase, ends = 'RESULT', total - t
    return rn, phase, round(ends, 2), total


async def _live_outcome(slug, rn):
    """Get or atomically create the universal outcome for (slug, round)."""
    ex = await db.live_outcomes.find_one({'slug': slug, 'round_number': rn}, {'_id': 0})
    if ex:
        return ex['outcome']
    outcome = generate_outcome(slug)
    doc = {
        'slug': slug, 'round_number': rn, 'outcome': outcome,
        'summary': summarize_outcome(slug, outcome), 'created_at': _now_iso(),
    }
    try:
        await db.live_outcomes.insert_one(doc)
        return outcome
    except Exception:
        ex = await db.live_outcomes.find_one({'slug': slug, 'round_number': rn}, {'_id': 0})
        return ex['outcome'] if ex else outcome


async def _live_settle_user(user_id, slug, current_rn, phase):
    """Idempotently settle this user's OPEN bets from closed betting windows."""
    query = {'user_id': user_id, 'slug': slug, 'status': 'OPEN'}
    query['round_number'] = {'$lte': current_rn} if phase == 'RESULT' else {'$lt': current_rn}
    open_bets = await db.live_bets.find(query).to_list(200)
    if not open_bets:
        return None
    game = await db.games.find_one({'slug': slug})
    gname = game['name'] if game else slug
    summary = None
    by_round = {}
    for b in open_bets:
        by_round.setdefault(b['round_number'], []).append(b)
    for rn, bets in sorted(by_round.items()):
        outcome = await _live_outcome(slug, rn)
        total_bet, total_payout, details = 0, 0, []
        for b in bets:
            try:
                payout, detail = settle_bet(slug, outcome, b.get('selection'), b['amount'], card=b.get('card'))
            except HTTPException:
                payout, detail = 0, {'result': 'void'}
            payout = int(payout)
            res = await db.live_bets.update_one(
                {'id': b['id'], 'status': 'OPEN'},
                {'$set': {'status': 'SETTLED', 'payout': payout, 'settled_at': _now_iso()}},
            )
            if res.modified_count == 0:
                continue
            total_bet += b['amount']
            total_payout += payout
            entry = {'selection': b.get('selection'), 'amount': b['amount'], 'payout': payout}
            entry.update(detail)
            if b.get('card'):
                entry['card'] = b['card']
            details.append(entry)
        if total_bet == 0:
            continue
        if total_payout > 0:
            await credit_chips(user_id, total_payout, f'{gname} win (round {rn})', ref=str(rn))
        await db.game_rounds.insert_one({
            'id': str(uuid.uuid4()), 'user_id': user_id, 'slug': slug, 'game_name': gname,
            'bet': total_bet, 'payout': total_payout, 'status': 'SETTLED',
            'outcome': {'round_number': rn, 'summary': summarize_outcome(slug, outcome), 'bets': details},
            'created_at': _now_iso(), 'settled_at': _now_iso(),
        })
        summary = {
            'round_number': rn, 'total_bet': total_bet, 'payout': total_payout,
            'outcome': outcome, 'bets': details,
        }
    return summary


@router.get('/live/{slug}/state')
async def live_state(slug: str, user: dict = Depends(require_active_player)):
    if slug not in LIVE_GAMES:
        raise HTTPException(status_code=404, detail='No live table for this game')
    rn, phase, ends_in, total = _live_clock(slug)
    settled = await _live_settle_user(user['id'], slug, rn, phase)

    outcome = None
    if phase != 'BETTING':
        outcome = await _live_outcome(slug, rn)

    prev = await db.live_outcomes.find(
        {'slug': slug, 'round_number': {'$lt': rn}}, {'_id': 0, 'round_number': 1, 'summary': 1}
    ).sort('round_number', -1).to_list(10)
    if len(prev) < 10:
        have = {p['round_number'] for p in prev}
        for i in range(1, 11):
            past = rn - i
            if past >= 0 and past not in have:
                await _live_outcome(slug, past)
        prev = await db.live_outcomes.find(
            {'slug': slug, 'round_number': {'$lt': rn}}, {'_id': 0, 'round_number': 1, 'summary': 1}
        ).sort('round_number', -1).to_list(10)

    my_bets, balance = await asyncio.gather(
        db.live_bets.find(
            {'user_id': user['id'], 'slug': slug, 'round_number': rn, 'status': {'$in': ['OPEN', 'SETTLED']}},
            {'_id': 0, 'user_id': 0},
        ).to_list(50),
        _fresh_balance(user['id']),
    )
    cfg = LIVE_GAMES[slug]
    return {
        'round_number': rn, 'phase': phase, 'phase_ends_in': ends_in,
        'timings': {'bet': cfg['bet'], 'reveal': cfg['reveal'], 'result': cfg['result'], 'total': total},
        'kind': cfg['kind'], 'options': SIDE_OPTIONS.get(slug),
        'outcome': outcome, 'my_bets': my_bets,
        'my_total': sum(b['amount'] for b in my_bets),
        'last_results': [{'round_number': p['round_number'], **(p.get('summary') or {})} for p in prev],
        'settled': settled, 'balance': balance, 'server_now': time.time(),
    }


@router.post('/live/{slug}/bets')
async def live_place_bet(slug: str, body: LiveBet, user: dict = Depends(require_active_player)):
    if slug not in LIVE_GAMES:
        raise HTTPException(status_code=404, detail='No live table for this game')
    rn, phase, ends_in, _ = _live_clock(slug)
    if phase != 'BETTING' or ends_in < 0.4:
        raise HTTPException(status_code=409, detail={'code': 'BETS_CLOSED', 'message': 'Bets are closed - wait for the next round.'})
    if body.amount < MIN_BET:
        raise HTTPException(status_code=400, detail=f'Minimum bet is {MIN_BET} chips')
    selection = validate_selection(slug, body.selection)
    card = make_bingo_card() if slug == 'bingo' else None
    bet_id = str(uuid.uuid4())
    try:
        await debit_chips(user['id'], body.amount, f'Live bet {slug} (round {rn})', ref=bet_id)
    except InsufficientChips:
        raise HTTPException(status_code=400, detail='Not enough play chips for this bet')
    doc = {
        'id': bet_id, 'user_id': user['id'], 'slug': slug, 'round_number': rn,
        'selection': selection, 'amount': body.amount, 'status': 'OPEN', 'payout': 0,
        'created_at': _now_iso(),
    }
    if card:
        doc['card'] = card
    await db.live_bets.insert_one(dict(doc))
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
    if slug not in LIVE_GAMES:
        raise HTTPException(status_code=404, detail='No live table for this game')
    rn, phase, ends_in, _ = _live_clock(slug)
    if phase != 'BETTING' or ends_in < 0.4:
        raise HTTPException(status_code=409, detail={'code': 'BETS_CLOSED', 'message': 'Bets are locked for this round.'})
    open_bets = await db.live_bets.find(
        {'user_id': user['id'], 'slug': slug, 'round_number': rn, 'status': 'OPEN'}
    ).to_list(100)
    refunded = 0
    for b in open_bets:
        res = await db.live_bets.update_one(
            {'id': b['id'], 'status': 'OPEN'}, {'$set': {'status': 'REFUNDED', 'settled_at': _now_iso()}})
        if res.modified_count:
            refunded += b['amount']
    if refunded > 0:
        await credit_chips(user['id'], refunded, f'Live bets refunded ({slug} round {rn})', ref=str(rn))
    balance = await _fresh_balance(user['id'])
    return {'message': 'Bets cleared', 'refunded': refunded, 'balance': balance}
