"""Gameplay routes: server-authoritative rounds, bets and settlement.

- Client sends commands (bet + selection), never outcomes.
- Chips are debited/credited only here on the server via the ledger.
- Rounds are recorded in game_rounds; settlement is idempotent.
"""
import uuid
import time
import logging
from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel, Field
from typing import Optional
from db import db, serialize_doc
from auth_utils import require_active_player
from ledger import credit_chips, debit_chips, InsufficientChips
from game_engines import (
    ENGINES, MIN_BET, MAX_BET, RNG, new_deck, draw_cards, card_str, vp_result,
    aviator_crash_point, aviator_multiplier, roulette_multiplier, roulette_color,
)

logger = logging.getLogger('gameplay')
router = APIRouter(tags=['gameplay'])


def _now():
    return datetime.now(timezone.utc)


def _now_iso():
    return _now().isoformat()


class PlayRequest(BaseModel):
    bet: int = Field(ge=1, le=10_000_000)
    payload: dict = Field(default_factory=dict)


class RoundRef(BaseModel):
    round_id: str


class DrawRequest(BaseModel):
    round_id: str
    holds: list = Field(default_factory=list)


async def _get_enabled_game(slug: str):
    game = await db.games.find_one({'slug': slug})
    if not game:
        raise HTTPException(status_code=404, detail='Game not found')
    if game.get('status') != 'ENABLED':
        status = game.get('status', 'DISABLED')
        raise HTTPException(status_code=409, detail={'code': status, 'message': f"{game['name']} is currently not playable ({status.replace('_', ' ').title()})."})
    return game


def _validate_bet(bet: int, balance: int):
    if bet < MIN_BET:
        raise HTTPException(status_code=400, detail=f'Minimum bet is {MIN_BET} chips')
    if bet > MAX_BET:
        raise HTTPException(status_code=400, detail=f'Maximum bet is {MAX_BET} chips')
    if bet > balance:
        raise HTTPException(status_code=400, detail='Not enough play chips for this bet')


async def _fresh_balance(user_id: str):
    u = await db.users.find_one({'id': user_id})
    return u.get('chip_balance', 0) if u else 0


def _round_public(r):
    r = serialize_doc(r)
    for private in ('crash_point', 'deck'):
        r.pop(private, None)
    return r


# ---------------- Generic instant play ----------------
@router.post('/games/{slug}/play')
async def play_game(slug: str, body: PlayRequest, user: dict = Depends(require_active_player)):
    game = await _get_enabled_game(slug)
    balance = await _fresh_balance(user['id'])
    _validate_bet(body.bet, balance)

    # Stateful games
    if slug == 'aviator':
        return await _aviator_start(user, body.bet)
    if slug == 'champion-poker':
        return await _champion_deal(user, body.bet)
    if slug == 'fun-roulette':
        raise HTTPException(status_code=409, detail={'code': 'LIVE_ROUNDS', 'message': 'Fun Roulette runs in live synchronized rounds. Join the table from the game screen.'})

    engine = ENGINES.get(slug)
    if not engine:
        raise HTTPException(status_code=409, detail={'code': 'NOT_AVAILABLE', 'message': 'This game is not available yet.'})

    # Compute outcome first (validates payload) so we never debit on invalid input
    outcome, payout = engine(body.bet, body.payload)
    payout = int(payout)

    round_id = str(uuid.uuid4())
    try:
        await debit_chips(user['id'], body.bet, f"{game['name']} bet", ref=round_id)
    except InsufficientChips:
        raise HTTPException(status_code=400, detail='Not enough play chips for this bet')
    balance_after = await _fresh_balance(user['id'])
    if payout > 0:
        balance_after = await credit_chips(user['id'], payout, f"{game['name']} win", ref=round_id)

    round_doc = {
        'id': round_id, 'user_id': user['id'], 'slug': slug, 'game_name': game['name'],
        'bet': body.bet, 'payout': payout, 'status': 'SETTLED',
        'outcome': outcome, 'created_at': _now_iso(), 'settled_at': _now_iso(),
    }
    await db.game_rounds.insert_one(round_doc)
    return {'round': _round_public(round_doc), 'balance': balance_after}


# ---------------- Aviator (crash) ----------------
async def _aviator_start(user: dict, bet: int):
    round_id = str(uuid.uuid4())
    try:
        await debit_chips(user['id'], bet, 'Aviator bet', ref=round_id)
    except InsufficientChips:
        raise HTTPException(status_code=400, detail='Not enough play chips for this bet')
    crash = aviator_crash_point()
    started_at = _now_iso()
    round_doc = {
        'id': round_id, 'user_id': user['id'], 'slug': 'aviator', 'game_name': 'Aviator',
        'bet': bet, 'payout': 0, 'status': 'ACTIVE', 'crash_point': crash,
        'outcome': None, 'created_at': started_at, 'started_at': started_at, 'settled_at': None,
    }
    await db.game_rounds.insert_one(round_doc)
    balance = await _fresh_balance(user['id'])
    return {'round_id': round_id, 'started_at': started_at, 'status': 'ACTIVE', 'balance': balance}


async def _aviator_settle_crash(r):
    """Idempotently settle an active aviator round as crashed."""
    result = await db.game_rounds.update_one(
        {'id': r['id'], 'status': 'ACTIVE'},
        {'$set': {
            'status': 'SETTLED', 'payout': 0, 'settled_at': _now_iso(),
            'outcome': {'result': 'crashed', 'crash_point': r['crash_point']},
        }},
    )
    return result.modified_count > 0


@router.get('/games/aviator/round/{round_id}')
async def aviator_round_state(round_id: str, user: dict = Depends(require_active_player)):
    r = await db.game_rounds.find_one({'id': round_id, 'user_id': user['id'], 'slug': 'aviator'})
    if not r:
        raise HTTPException(status_code=404, detail='Round not found')
    if r['status'] == 'ACTIVE':
        elapsed = (_now() - datetime.fromisoformat(r['started_at'])).total_seconds()
        current = aviator_multiplier(elapsed)
        if current >= r['crash_point']:
            await _aviator_settle_crash(r)
            balance = await _fresh_balance(user['id'])
            return {'status': 'CRASHED', 'crash_point': r['crash_point'], 'balance': balance}
        return {'status': 'ACTIVE', 'elapsed': round(elapsed, 2)}
    outcome = r.get('outcome') or {}
    return {'status': 'SETTLED', 'outcome': outcome, 'payout': r.get('payout', 0)}


@router.post('/games/aviator/cashout')
async def aviator_cashout(body: RoundRef, user: dict = Depends(require_active_player)):
    r = await db.game_rounds.find_one({'id': body.round_id, 'user_id': user['id'], 'slug': 'aviator'})
    if not r:
        raise HTTPException(status_code=404, detail='Round not found')
    if r['status'] != 'ACTIVE':
        raise HTTPException(status_code=400, detail='Round already settled')
    elapsed = (_now() - datetime.fromisoformat(r['started_at'])).total_seconds()
    current = aviator_multiplier(elapsed)
    if current >= r['crash_point']:
        await _aviator_settle_crash(r)
        balance = await _fresh_balance(user['id'])
        return {'result': 'crashed', 'crash_point': r['crash_point'], 'payout': 0, 'balance': balance}
    payout = int(r['bet'] * current)
    # Idempotent settle: only one settlement wins
    result = await db.game_rounds.update_one(
        {'id': r['id'], 'status': 'ACTIVE'},
        {'$set': {
            'status': 'SETTLED', 'payout': payout, 'settled_at': _now_iso(),
            'outcome': {'result': 'cashed_out', 'multiplier': current, 'crash_point': r['crash_point']},
        }},
    )
    if result.modified_count == 0:
        raise HTTPException(status_code=400, detail='Round already settled')
    balance = await credit_chips(user['id'], payout, f'Aviator cashout {current}x', ref=r['id'])
    return {'result': 'cashed_out', 'multiplier': current, 'payout': payout, 'crash_point': r['crash_point'], 'balance': balance}


# ---------------- Champion Poker (hold & draw) ----------------
async def _champion_deal(user: dict, bet: int):
    round_id = str(uuid.uuid4())
    try:
        await debit_chips(user['id'], bet, 'Champion Poker bet', ref=round_id)
    except InsufficientChips:
        raise HTTPException(status_code=400, detail='Not enough play chips for this bet')
    deck = new_deck()
    hand = draw_cards(5, deck)
    round_doc = {
        'id': round_id, 'user_id': user['id'], 'slug': 'champion-poker', 'game_name': 'Champion Poker',
        'bet': bet, 'payout': 0, 'status': 'AWAITING_DRAW',
        'cards': [list(c) for c in hand], 'deck': [list(c) for c in deck],
        'outcome': None, 'created_at': _now_iso(), 'settled_at': None,
    }
    await db.game_rounds.insert_one(round_doc)
    balance = await _fresh_balance(user['id'])
    return {
        'round_id': round_id, 'status': 'AWAITING_DRAW',
        'cards': [card_str(tuple(c)) for c in round_doc['cards']], 'balance': balance,
    }


@router.post('/games/champion-poker/draw')
async def champion_draw(body: DrawRequest, user: dict = Depends(require_active_player)):
    r = await db.game_rounds.find_one({'id': body.round_id, 'user_id': user['id'], 'slug': 'champion-poker'})
    if not r:
        raise HTTPException(status_code=404, detail='Round not found')
    if r['status'] != 'AWAITING_DRAW':
        raise HTTPException(status_code=400, detail='Round already settled')
    holds = body.holds if isinstance(body.holds, list) else []
    holds = [bool(holds[i]) if i < len(holds) else False for i in range(5)]
    hand = [tuple(c) for c in r['cards']]
    deck = [tuple(c) for c in r['deck']]
    final = []
    for i in range(5):
        if holds[i]:
            final.append(hand[i])
        else:
            final.append(draw_cards(1, deck)[0])
    label, mult = vp_result(final)
    payout = r['bet'] * mult
    result = await db.game_rounds.update_one(
        {'id': r['id'], 'status': 'AWAITING_DRAW'},
        {'$set': {
            'status': 'SETTLED', 'payout': payout, 'settled_at': _now_iso(),
            'outcome': {'cards': [card_str(c) for c in final], 'hand': label, 'multiplier': mult, 'holds': holds},
        }, '$unset': {'deck': ''}},
    )
    if result.modified_count == 0:
        raise HTTPException(status_code=400, detail='Round already settled')
    balance = await _fresh_balance(user['id'])
    if payout > 0:
        balance = await credit_chips(user['id'], payout, f'Champion Poker win ({label})', ref=r['id'])
    return {'cards': [card_str(c) for c in final], 'hand': label, 'multiplier': mult, 'payout': payout, 'balance': balance}


# ---------------- Live Fun Roulette (universal synchronized rounds) ----------------
# Rounds are derived from universal epoch time: every player worldwide sees the
# same round number, the same countdown and the same winning number.
ROUND_SECONDS = 25
BETTING_SECONDS = 17   # 0-17s: bets open
SPIN_SECONDS = 5       # 17-22s: wheel spins (bets locked)
# 22-25s: result display, then the next round starts automatically


class RouletteBet(BaseModel):
    bet_type: str
    value: object = None
    amount: int = Field(ge=1, le=100_000)


def _roulette_clock():
    now = time.time()
    round_number = int(now // ROUND_SECONDS)
    t = now % ROUND_SECONDS
    if t < BETTING_SECONDS:
        phase = 'BETTING'
        phase_ends_in = BETTING_SECONDS - t
    elif t < BETTING_SECONDS + SPIN_SECONDS:
        phase = 'SPINNING'
        phase_ends_in = BETTING_SECONDS + SPIN_SECONDS - t
    else:
        phase = 'RESULT'
        phase_ends_in = ROUND_SECONDS - t
    return round_number, phase, round(phase_ends_in, 2), round(ROUND_SECONDS - t, 2)


async def _roulette_round_result(round_number: int):
    """Get (or atomically create) the universal winning number for a round."""
    existing = await db.roulette_rounds.find_one({'round_number': round_number})
    if existing:
        return existing['winning_number']
    n = RNG.randint(0, 36)
    try:
        await db.roulette_rounds.insert_one({
            'round_number': round_number, 'winning_number': n,
            'color': roulette_color(n), 'created_at': _now_iso(),
        })
        return n
    except Exception:
        # Another request/instance created it first - unique index guarantees one result
        existing = await db.roulette_rounds.find_one({'round_number': round_number})
        return existing['winning_number'] if existing else n


async def _roulette_settle_user(user_id: str, current_round: int, phase: str):
    """Idempotently settle all of this user's OPEN bets from closed betting windows."""
    query = {'user_id': user_id, 'slug': 'fun-roulette-bet', 'status': 'OPEN'}
    if phase == 'RESULT':
        query['round_number'] = {'$lte': current_round}
    else:
        query['round_number'] = {'$lt': current_round}
    open_bets = await db.roulette_bets.find(query).to_list(200)
    if not open_bets:
        return None
    settled_summary = None
    by_round = {}
    for b in open_bets:
        by_round.setdefault(b['round_number'], []).append(b)
    for rn, bets in sorted(by_round.items()):
        winning = await _roulette_round_result(rn)
        total_bet, total_payout, bet_details = 0, 0, []
        for b in bets:
            mult = 0
            try:
                mult = roulette_multiplier(b['bet_type'], b['value'], winning)
            except HTTPException:
                mult = 0
            payout = b['amount'] * mult
            res = await db.roulette_bets.update_one(
                {'id': b['id'], 'status': 'OPEN'},
                {'$set': {'status': 'SETTLED', 'payout': payout, 'winning_number': winning, 'settled_at': _now_iso()}},
            )
            if res.modified_count == 0:
                continue  # already settled elsewhere
            total_bet += b['amount']
            total_payout += payout
            bet_details.append({'bet_type': b['bet_type'], 'value': b['value'], 'amount': b['amount'], 'payout': payout})
        if total_bet == 0:
            continue
        if total_payout > 0:
            await credit_chips(user_id, total_payout, f'Fun Roulette win (round {rn})', ref=str(rn))
        round_doc = {
            'id': str(uuid.uuid4()), 'user_id': user_id, 'slug': 'fun-roulette', 'game_name': 'Fun Roulette',
            'bet': total_bet, 'payout': total_payout, 'status': 'SETTLED',
            'outcome': {'round_number': rn, 'winning_number': winning, 'color': roulette_color(winning), 'bets': bet_details},
            'created_at': _now_iso(), 'settled_at': _now_iso(),
        }
        await db.game_rounds.insert_one(round_doc)
        settled_summary = {'round_number': rn, 'winning_number': winning, 'color': roulette_color(winning), 'total_bet': total_bet, 'payout': total_payout, 'bets': bet_details}
    return settled_summary


@router.get('/games/fun-roulette/state')
async def roulette_state(user: dict = Depends(require_active_player)):
    round_number, phase, phase_ends_in, next_round_in = _roulette_clock()

    # Settle anything owed to this user (idempotent, lazy)
    settled = await _roulette_settle_user(user['id'], round_number, phase)

    winning_number = None
    if phase != 'BETTING':
        winning_number = await _roulette_round_result(round_number)

    my_bets = await db.roulette_bets.find(
        {'user_id': user['id'], 'round_number': round_number, 'status': {'$in': ['OPEN', 'SETTLED']}},
        {'_id': 0, 'bet_type': 1, 'value': 1, 'amount': 1},
    ).to_list(100)

    last = await db.roulette_rounds.find({}, {'_id': 0}).sort('round_number', -1).to_list(12)
    balance = await _fresh_balance(user['id'])
    return {
        'round_number': round_number,
        'phase': phase,
        'phase_ends_in': phase_ends_in,
        'next_round_in': next_round_in,
        'betting_seconds': BETTING_SECONDS,
        'round_seconds': ROUND_SECONDS,
        'winning_number': winning_number,
        'winning_color': roulette_color(winning_number) if winning_number is not None else None,
        'my_bets': my_bets,
        'my_total': sum(b['amount'] for b in my_bets),
        'last_results': [{'round_number': r['round_number'], 'winning_number': r['winning_number'], 'color': r['color']} for r in last],
        'settled': settled,
        'balance': balance,
    }


@router.post('/games/fun-roulette/bets')
async def roulette_place_bet(body: RouletteBet, user: dict = Depends(require_active_player)):
    round_number, phase, phase_ends_in, _ = _roulette_clock()
    if phase != 'BETTING' or phase_ends_in < 0.4:
        raise HTTPException(status_code=409, detail={'code': 'BETS_CLOSED', 'message': 'Bets are closed - wait for the next round.'})
    if body.amount < MIN_BET:
        raise HTTPException(status_code=400, detail=f'Minimum bet is {MIN_BET} chips')
    # Validate the bet shape now (winning number irrelevant, just validation)
    roulette_multiplier(body.bet_type, body.value, 0)
    bet_id = str(uuid.uuid4())
    try:
        await debit_chips(user['id'], body.amount, f'Fun Roulette bet (round {round_number})', ref=bet_id)
    except InsufficientChips:
        raise HTTPException(status_code=400, detail='Not enough play chips for this bet')
    await db.roulette_bets.insert_one({
        'id': bet_id, 'user_id': user['id'], 'slug': 'fun-roulette-bet',
        'round_number': round_number, 'bet_type': body.bet_type, 'value': body.value,
        'amount': body.amount, 'status': 'OPEN', 'payout': 0, 'created_at': _now_iso(),
    })
    my_bets = await db.roulette_bets.find(
        {'user_id': user['id'], 'round_number': round_number, 'status': 'OPEN'},
        {'_id': 0, 'bet_type': 1, 'value': 1, 'amount': 1},
    ).to_list(100)
    balance = await _fresh_balance(user['id'])
    return {'message': 'Bet placed', 'round_number': round_number, 'my_bets': my_bets, 'my_total': sum(b['amount'] for b in my_bets), 'balance': balance}


@router.post('/games/fun-roulette/bets/clear')
async def roulette_clear_bets(user: dict = Depends(require_active_player)):
    round_number, phase, phase_ends_in, _ = _roulette_clock()
    if phase != 'BETTING' or phase_ends_in < 0.4:
        raise HTTPException(status_code=409, detail={'code': 'BETS_CLOSED', 'message': 'Bets are locked for this round.'})
    open_bets = await db.roulette_bets.find({'user_id': user['id'], 'round_number': round_number, 'status': 'OPEN'}).to_list(100)
    refunded = 0
    for b in open_bets:
        res = await db.roulette_bets.update_one({'id': b['id'], 'status': 'OPEN'}, {'$set': {'status': 'REFUNDED', 'settled_at': _now_iso()}})
        if res.modified_count:
            refunded += b['amount']
    if refunded > 0:
        await credit_chips(user['id'], refunded, f'Fun Roulette bets refunded (round {round_number})', ref=str(round_number))
    balance = await _fresh_balance(user['id'])
    return {'message': 'Bets cleared', 'refunded': refunded, 'balance': balance}


# ---------------- Round history ----------------
@router.get('/games/{slug}/history')
async def game_history(slug: str, user: dict = Depends(require_active_player)):
    # Lazily settle stale aviator rounds
    if slug == 'aviator':
        stale = await db.game_rounds.find({'user_id': user['id'], 'slug': 'aviator', 'status': 'ACTIVE'}).to_list(20)
        for r in stale:
            elapsed = (_now() - datetime.fromisoformat(r['started_at'])).total_seconds()
            if aviator_multiplier(elapsed) >= r['crash_point']:
                await _aviator_settle_crash(r)
    rounds = await db.game_rounds.find(
        {'user_id': user['id'], 'slug': slug, 'status': 'SETTLED'}, {'_id': 0, 'crash_point': 0, 'deck': 0, 'cards': 0}
    ).sort('created_at', -1).to_list(15)
    return {'rounds': serialize_doc(rounds)}
