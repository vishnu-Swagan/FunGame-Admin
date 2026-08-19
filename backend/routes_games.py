"""Gameplay routes: live American Roulette + shared round history.

ALL 18 games now run as universal server-synchronized live rounds:
- American Roulette keeps its dedicated endpoints below (synchronized loop).
- Aviator + the 16 fixed-cycle games are served by routes_live.py.
- The legacy instant-play endpoint is gated with LIVE_ROUNDS.
"""
import uuid
import time
import logging
from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel, Field
from db import db, serialize_doc
from auth_utils import require_active_player
from ledger import credit_chips, debit_chips, InsufficientChips
import ledger
from game_engines import (RNG, MIN_BET, roulette_multiplier, roulette_color,
                          ROULETTE_POCKETS, roulette_payout)

logger = logging.getLogger('gameplay')
router = APIRouter(tags=['gameplay'])


def _now():
    return datetime.now(timezone.utc)


def _now_iso():
    return _now().isoformat()


def _masked_user_id(value: str):
    """Return a display-safe fragment without exposing the stored user id."""
    compact = ''.join(ch for ch in str(value or '') if ch.isalnum())
    if not compact:
        return 'P***R'
    if len(compact) <= 4:
        return f"{compact[0]}***{compact[-1]}"
    return f"{compact[:2]}***{compact[-2:]}"


class PlayRequest(BaseModel):
    bet: int = Field(ge=1, le=10_000_000)
    payload: dict = Field(default_factory=dict)


async def _get_enabled_game(slug: str):
    game = await db.games.find_one({'slug': slug})
    if not game:
        raise HTTPException(status_code=404, detail='Game not found')
    if game.get('status') != 'ENABLED':
        status = game.get('status', 'DISABLED')
        raise HTTPException(status_code=409, detail={'code': status, 'message': f"{game['name']} is currently not playable ({status.replace('_', ' ').title()})."})
    return game


async def _fresh_balance(user_id: str):
    u = await db.users.find_one({'id': user_id})
    return u.get('chip_balance', 0) if u else 0


# ---------------- Legacy instant play: everything is live now ----------------
@router.post('/games/{slug}/play')
async def play_game(slug: str, body: PlayRequest, user: dict = Depends(require_active_player)):
    game = await _get_enabled_game(slug)
    raise HTTPException(status_code=409, detail={
        'code': 'LIVE_ROUNDS',
        'message': f"{game['name']} runs in universal live synchronized rounds. Join the table from the game screen.",
    })


# ---------------- Live American Roulette (universal synchronized rounds) ----------------
# Rounds are derived from universal epoch time: every player worldwide sees the
# same round number, the same countdown and the same winning number.
BETTING_SECONDS = 60   # 0-60s: bets open — a full minute, as the machine gives
SPIN_SECONDS = 10      # 60-70s: the wheel spins, bets locked
ROUND_SECONDS = 75     # then 5s on the result before the next round
# 30-35s: result display, then the next round starts automatically

# Table limits (anti-Martingale). Even-money positions (red/black, odd/even,
# 1-18/19-36) are capped so that doubling on loss hits the ceiling within a few
# rounds and cannot be exploited. Inside/other positions get a higher ceiling.
EVEN_MONEY_TYPES = {"color", "parity", "range"}
# A 19-pocket wheel arc is an even-money position in all but name, so it takes the
# same anti-Martingale ceiling rather than the looser inside-bet one.
WIDE_SECTORS = {"zeroside", "dzeroside"}
EVEN_MONEY_MAX = MIN_BET * 200   # 2000 — 10,20,40,...,1280 then blocked
POSITION_MAX = MIN_BET * 1000    # 10000 — general per-position table max


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
        # rounds drawn before the American changeover were stored as ints; the API
        # contract is a label, so normalise on the way out
        return str(existing['winning_number'])
    # One draw per round number for the whole world. Stored as a LABEL ('0'..'36'
    # or '00') because the double zero is not an integer.
    n = RNG.choice(ROULETTE_POCKETS)
    try:
        await db.roulette_rounds.insert_one({
            'round_number': round_number, 'winning_number': n,
            'color': roulette_color(n), 'created_at': _now_iso(),
        })
        return n
    except Exception:
        # Another request/instance created it first - unique index guarantees one result
        existing = await db.roulette_rounds.find_one({'round_number': round_number})
        return str(existing['winning_number']) if existing else n


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
            payout = roulette_payout(b['amount'], mult)
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
            await credit_chips(user_id, total_payout, f'American Roulette win (round {rn})', ref=str(rn), kind=ledger.PAYOUT, game='fun-roulette')
        round_doc = {
            'id': str(uuid.uuid4()), 'user_id': user_id, 'slug': 'fun-roulette', 'game_name': 'American Roulette',
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
        'spin_seconds': SPIN_SECONDS,
        'round_seconds': ROUND_SECONDS,
        'limits': {
            'minimum': MIN_BET,
            'even_money_position_max': EVEN_MONEY_MAX,
            'position_max': POSITION_MAX,
        },
        'winning_number': winning_number,
        'winning_color': roulette_color(winning_number) if winning_number is not None else None,
        'my_bets': my_bets,
        'my_total': sum(b['amount'] for b in my_bets),
        'last_results': [{'round_number': r['round_number'], 'winning_number': r['winning_number'], 'color': r['color']} for r in last],
        'settled': settled,
        'balance': balance,
        'server_now': time.time(),
    }


@router.post('/games/fun-roulette/bets')
async def roulette_place_bet(body: RouletteBet, user: dict = Depends(require_active_player)):
    round_number, phase, phase_ends_in, _ = _roulette_clock()
    if phase != 'BETTING' or phase_ends_in < 0.4:
        raise HTTPException(status_code=409, detail={'code': 'BETS_CLOSED', 'message': 'Bets are closed - wait for the next round.'})
    if body.amount < MIN_BET:
        raise HTTPException(status_code=400, detail=f'Minimum bet is {MIN_BET} chips')
    # Validate the bet shape now (winning number irrelevant, just validation)
    roulette_multiplier(body.bet_type, body.value, '0')
    # Table limit — cap cumulative stake on this exact position. Even-money
    # positions get the lower ceiling so Martingale doubling cannot run away.
    wide_arc = body.bet_type == 'sector' and str(body.value) in WIDE_SECTORS
    cap = EVEN_MONEY_MAX if (body.bet_type in EVEN_MONEY_TYPES or wide_arc) else POSITION_MAX
    existing_pos = await db.roulette_bets.find(
        {'user_id': user['id'], 'round_number': round_number, 'status': 'OPEN',
         'bet_type': body.bet_type, 'value': body.value}, {'amount': 1},
    ).to_list(300)
    staked = sum(b['amount'] for b in existing_pos)
    if staked + body.amount > cap:
        kind = 'even-money' if (body.bet_type in EVEN_MONEY_TYPES or wide_arc) else 'table'
        raise HTTPException(status_code=400, detail={
            'code': 'TABLE_LIMIT',
            'message': f'Table limit — max {cap} chips on this position ({kind} limit). You have {staked} here.',
        })
    bet_id = str(uuid.uuid4())
    try:
        await debit_chips(user['id'], body.amount, f'American Roulette bet (round {round_number})', ref=bet_id, kind=ledger.STAKE, game='fun-roulette')
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
        await credit_chips(user['id'], refunded, f'American Roulette bets refunded (round {round_number})', ref=str(round_number), kind=ledger.REFUND, game='fun-roulette')
    balance = await _fresh_balance(user['id'])
    return {'message': 'Bets cleared', 'refunded': refunded, 'balance': balance}


@router.post('/games/fun-roulette/bets/undo')
async def roulette_undo_bet(user: dict = Depends(require_active_player)):
    """Undo the most-recently placed chip this round (refund just that one bet)."""
    round_number, phase, phase_ends_in, _ = _roulette_clock()
    if phase != 'BETTING' or phase_ends_in < 0.4:
        raise HTTPException(status_code=409, detail={'code': 'BETS_CLOSED', 'message': 'Bets are locked for this round.'})
    last = await db.roulette_bets.find(
        {'user_id': user['id'], 'round_number': round_number, 'status': 'OPEN'}
    ).sort('created_at', -1).to_list(1)
    refunded = 0
    if last:
        b = last[0]
        res = await db.roulette_bets.update_one({'id': b['id'], 'status': 'OPEN'}, {'$set': {'status': 'REFUNDED', 'settled_at': _now_iso()}})
        if res.modified_count:
            refunded = b['amount']
            await credit_chips(user['id'], refunded, f'American Roulette undo (round {round_number})', ref=b['id'], kind=ledger.REFUND, game='fun-roulette')
    my_bets = await db.roulette_bets.find(
        {'user_id': user['id'], 'round_number': round_number, 'status': 'OPEN'},
        {'_id': 0, 'bet_type': 1, 'value': 1, 'amount': 1},
    ).to_list(100)
    balance = await _fresh_balance(user['id'])
    return {'message': 'Last bet undone', 'refunded': refunded, 'my_bets': my_bets, 'my_total': sum(b['amount'] for b in my_bets), 'balance': balance}


# ---------------- Shared live winner rotation ----------------
@router.get('/games/{slug}/recent-winners')
async def recent_game_winners(slug: str, user: dict = Depends(require_active_player)):
    """Recent real payouts for the current table, safe for an in-game ticker.

    Values come only from settled game-round records. Raw user identifiers are
    intentionally never serialized; the frontend receives a masked fragment.
    """
    await _get_enabled_game(slug)
    rows = await db.game_rounds.find(
        {'slug': slug, 'status': 'SETTLED', 'payout': {'$gt': 0}},
        {
            '_id': 0, 'id': 1, 'user_id': 1, 'payout': 1, 'bet': 1,
            'round_number': 1, 'outcome.round_number': 1, 'settled_at': 1,
        },
    ).sort('settled_at', -1).to_list(18)
    return {
        'winners': [
            {
                'id': row.get('id'),
                'masked_id': _masked_user_id(row.get('user_id')),
                'payout': row.get('payout', 0),
                'bet': row.get('bet', 0),
                'round_number': row.get('round_number') or (row.get('outcome') or {}).get('round_number'),
                'settled_at': row.get('settled_at'),
            }
            for row in rows
        ],
    }


# ---------------- Round history ----------------
@router.get('/games/{slug}/history')
async def game_history(slug: str, user: dict = Depends(require_active_player)):
    rounds = await db.game_rounds.find(
        {'user_id': user['id'], 'slug': slug, 'status': 'SETTLED'}, {'_id': 0, 'crash_point': 0, 'deck': 0, 'cards': 0}
    ).sort('created_at', -1).to_list(15)
    if slug == 'aviator' and rounds:
        round_numbers = [r.get('round_number') for r in rounds if r.get('round_number') is not None]
        proof_docs = []
        if round_numbers:
            proof_docs = await db.aviator_rounds.find(
                {
                    'round_number': {'$in': round_numbers},
                    'status': 'SETTLED',
                    'server_seed': {'$exists': True, '$ne': ''},
                },
                {'_id': 0, 'round_number': 1},
            ).to_list(len(round_numbers))
        proof_rounds = {r['round_number'] for r in proof_docs}
        for round_doc in rounds:
            round_doc['proof_available'] = round_doc.get('round_number') in proof_rounds
    return {'rounds': serialize_doc(rounds)}
