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
from pymongo.errors import DuplicateKeyError
from db import client, db, serialize_doc
from auth_utils import require_active_player
from ledger import credit_chips, debit_chips, InsufficientChips
import ledger
from game_engines import (RNG, MIN_BET, roulette_multiplier, roulette_color,
                          ROULETTE_POCKETS, roulette_payout)
from live_engines import (
    ROULETTE_TIMING, betting_mutation_open, fixed_cycle_clock,
    roulette_history_max_round,
)
from game_access import require_playable_game
from transactions import run_game_transaction

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


async def _fresh_balance(user_id: str):
    u = await db.users.find_one({'id': user_id})
    return u.get('chip_balance', 0) if u else 0


# ---------------- Legacy instant play: everything is live now ----------------
@router.post('/games/{slug}/play')
async def play_game(slug: str, body: PlayRequest, user: dict = Depends(require_active_player)):
    game = await require_playable_game(slug)
    raise HTTPException(status_code=409, detail={
        'code': 'LIVE_ROUNDS',
        'message': f"{game['name']} runs in universal live synchronized rounds. Join the table from the game screen.",
    })


# ---------------- Live American Roulette (universal synchronized rounds) ----------------
# Rounds are derived from universal epoch time: every player worldwide sees the
# same round number, the same countdown and the same winning number.
BETTING_SECONDS = ROULETTE_TIMING['bet']       # 0-30s: bets open
SPIN_SECONDS = ROULETTE_TIMING['spin']         # 30-50s: bets locked while the wheel spins
ROUND_SECONDS = sum(ROULETTE_TIMING.values())  # 50-60s: result display, then the next round
BETTING_MUTATION_GUARD = 0.4

# Table limits (anti-Martingale). Even-money positions (red/black, odd/even,
# 1-18/19-36) are capped so that doubling on loss hits the ceiling within a few
# rounds and cannot be exploited. Inside/other positions get a higher ceiling.
EVEN_MONEY_TYPES = {"color", "parity", "range"}
# A 19-pocket wheel arc is an even-money position in all but name, so it takes the
# same anti-Martingale ceiling rather than the looser inside-bet one.
WIDE_SECTORS = {"zeroside", "dzeroside"}
EVEN_MONEY_MAX = MIN_BET * 200   # 2000 — 10,20,40,...,1280 then blocked
POSITION_MAX = MIN_BET * 1000    # 10000 — general per-position table max
INSIDE_BET_TYPES = frozenset({'split', 'street', 'corner', 'sixline', 'basket'})


class RouletteBet(BaseModel):
    bet_type: str
    value: object = None
    amount: int = Field(ge=1, le=100_000)


def _roulette_position_key(bet_type, value):
    """Canonical key for enforcing a cap on one physical felt position.

    Settlement accepts integer or string pocket labels, while an inside bet is
    a set whose submitted order is irrelevant. Comparing the raw request value
    would therefore let the same position bypass its cap (for example ``7`` vs
    ``"7"`` or a reordered corner). The caller validates first, so this helper
    only needs deterministic normalization.
    """
    if bet_type == 'straight':
        return str(value).strip()
    if bet_type in INSIDE_BET_TYPES:
        return frozenset(part.strip() for part in str(value).split('-'))
    return value


def _roulette_clock(now=None):
    now = time.time() if now is None else now
    round_number, phase, phase_ends_in, round_ends_in, _ = fixed_cycle_clock(
        now, BETTING_SECONDS, SPIN_SECONDS, ROULETTE_TIMING['result'], 'SPINNING'
    )
    return round_number, phase, phase_ends_in, round_ends_in


def _require_roulette_betting(expected_round=None, message='Bets are closed - wait for the next round.'):
    """Sample the authoritative clock immediately before a wallet/bet mutation."""
    round_number, phase, phase_ends_in, _ = _roulette_clock()
    if not betting_mutation_open(
        phase, phase_ends_in, round_number, expected_round, BETTING_MUTATION_GUARD
    ):
        raise HTTPException(status_code=409, detail={'code': 'BETS_CLOSED', 'message': message})
    return round_number, phase_ends_in


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
    except DuplicateKeyError:
        # Another request/instance created it first - unique index guarantees one result
        existing = await db.roulette_rounds.find_one({'round_number': round_number})
        if existing is None:
            raise RuntimeError('Roulette result insert raced but no persisted round exists')
        return str(existing['winning_number'])


async def _roulette_settle_user(user_id: str, current_round: int, phase: str):
    """Idempotently settle all of this user's OPEN bets from closed betting windows."""
    query = {'user_id': user_id, 'slug': 'fun-roulette-bet', 'status': 'OPEN'}
    if phase == 'RESULT':
        query['round_number'] = {'$lte': current_round}
    else:
        query['round_number'] = {'$lt': current_round}
    # Discover rounds without applying a UI-page cap. Each complete round is
    # then read and settled inside its own transaction below.
    round_numbers = await db.roulette_bets.distinct('round_number', query)
    if not round_numbers:
        return None
    settled_summary = None
    for rn in sorted(round_numbers):
        winning = await _roulette_round_result(rn)

        async def settle_round(session):
            kwargs = {'session': session} if session is not None else {}
            bets = await db.roulette_bets.find({
                'user_id': user_id, 'slug': 'fun-roulette-bet',
                'round_number': rn, 'status': 'OPEN',
            }, **kwargs).to_list(length=None)
            total_bet, total_payout, bet_details, settled_refs = 0, 0, [], []
            for b in bets:
                try:
                    mult = roulette_multiplier(b['bet_type'], b['value'], winning)
                except HTTPException:
                    mult = 0
                payout = roulette_payout(b['amount'], mult)
                res = await db.roulette_bets.update_one(
                    {'id': b['id'], 'status': 'OPEN'},
                    {'$set': {
                        'status': 'SETTLED', 'payout': payout,
                        'winning_number': winning, 'settled_at': _now_iso(),
                    }},
                    **kwargs,
                )
                if res.modified_count == 0:
                    continue
                settled_refs.append(b['id'])
                total_bet += b['amount']
                total_payout += payout
                if payout > 0:
                    await credit_chips(
                        user_id, payout, f'American Roulette bet win (round {rn})',
                        ref=f'{rn}:{b["id"]}', kind=ledger.PAYOUT,
                        game='fun-roulette', session=session,
                        source_refs=[b['id']], settlement_ref=str(rn),
                    )
                bet_details.append({
                    'bet_type': b['bet_type'], 'value': b['value'],
                    'amount': b['amount'], 'payout': payout,
                })
            if total_bet == 0:
                return None
            await ledger.record_settlement(
                user_id, settled_refs, 'fun-roulette',
                status='SETTLED', settlement_ref=str(rn), session=session,
            )
            await db.game_rounds.insert_one({
                'id': str(uuid.uuid4()), 'user_id': user_id, 'slug': 'fun-roulette',
                'game_name': 'American Roulette', 'bet': total_bet,
                'payout': total_payout, 'status': 'SETTLED',
                'outcome': {
                    'round_number': rn, 'winning_number': winning,
                    'color': roulette_color(winning), 'bets': bet_details,
                },
                'created_at': _now_iso(), 'settled_at': _now_iso(),
            }, **kwargs)
            return {
                'round_number': rn, 'winning_number': winning,
                'color': roulette_color(winning), 'total_bet': total_bet,
                'payout': total_payout, 'bets': bet_details,
            }

        result = await run_game_transaction(client, settle_round)
        if result is not None:
            settled_summary = result
    return settled_summary


@router.get('/games/fun-roulette/state')
async def roulette_state(user: dict = Depends(require_active_player)):
    await require_playable_game('fun-roulette')
    clock_sampled_at = time.time()
    round_number, phase, phase_ends_in, next_round_in = _roulette_clock(clock_sampled_at)
    phase_offset = (BETTING_SECONDS if phase == 'BETTING'
                    else BETTING_SECONDS + SPIN_SECONDS if phase == 'SPINNING'
                    else ROUND_SECONDS)
    phase_ends_at = round_number * ROUND_SECONDS + phase_offset

    # Settle anything owed to this user (idempotent, lazy)
    settled = await _roulette_settle_user(user['id'], round_number, phase)

    winning_number = None
    if phase != 'BETTING':
        winning_number = await _roulette_round_result(round_number)

    my_bets = await db.roulette_bets.find(
        {'user_id': user['id'], 'round_number': round_number, 'status': {'$in': ['OPEN', 'SETTLED']}},
        {'_id': 0, 'bet_type': 1, 'value': 1, 'amount': 1},
    ).to_list(100)

    history_max = roulette_history_max_round(round_number, phase)
    last = await db.roulette_rounds.find(
        {'round_number': {'$lte': history_max}}, {'_id': 0}
    ).sort('round_number', -1).to_list(12)
    balance = await _fresh_balance(user['id'])
    return {
        'round_number': round_number,
        'phase': phase,
        'phase_ends_in': phase_ends_in,
        'next_round_in': next_round_in,
        'clock_sampled_at': clock_sampled_at,
        'phase_ends_at': phase_ends_at,
        'round_ends_at': (round_number + 1) * ROUND_SECONDS,
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
    await require_playable_game('fun-roulette')
    round_number, _ = _require_roulette_betting()
    if body.amount < MIN_BET:
        raise HTTPException(status_code=400, detail=f'Minimum bet is {MIN_BET} chips')
    # Validate the bet shape now (winning number irrelevant, just validation)
    roulette_multiplier(body.bet_type, body.value, '0')
    wide_arc = body.bet_type == 'sector' and str(body.value) in WIDE_SECTORS
    cap = EVEN_MONEY_MAX if (body.bet_type in EVEN_MONEY_TYPES or wide_arc) else POSITION_MAX
    bet_id = str(uuid.uuid4())
    doc = {
        'id': bet_id, 'user_id': user['id'], 'slug': 'fun-roulette-bet',
        'round_number': round_number, 'bet_type': body.bet_type, 'value': body.value,
        'amount': body.amount, 'status': 'OPEN', 'payout': 0, 'created_at': _now_iso(),
    }

    async def place_bet(session):
        kwargs = {'session': session} if session is not None else {}
        # Read and enforce the position cap in the same transaction as the
        # wallet debit, so concurrent chips cannot both pass a stale total.
        existing_type = await db.roulette_bets.find(
            {'user_id': user['id'], 'round_number': round_number, 'status': 'OPEN',
             'bet_type': body.bet_type},
            {'amount': 1, 'value': 1}, **kwargs,
        ).to_list(length=None)
        position_key = _roulette_position_key(body.bet_type, body.value)
        staked = sum(
            b['amount'] for b in existing_type
            if _roulette_position_key(body.bet_type, b.get('value')) == position_key
        )
        if staked + body.amount > cap:
            kind = 'even-money' if (body.bet_type in EVEN_MONEY_TYPES or wide_arc) else 'table'
            raise HTTPException(status_code=400, detail={
                'code': 'TABLE_LIMIT',
                'message': f'Table limit — max {cap} chips on this position ({kind} limit). You have {staked} here.',
            })
        # Validation and the table-limit read can consume the tail of the
        # window. Re-sample immediately before the balance/bet mutation.
        _require_roulette_betting(expected_round=round_number)
        await debit_chips(
            user['id'], body.amount, f'American Roulette bet (round {round_number})',
            ref=bet_id, kind=ledger.STAKE, game='fun-roulette', session=session,
        )
        await db.roulette_bets.insert_one(dict(doc), **kwargs)

    try:
        await run_game_transaction(client, place_bet)
    except InsufficientChips:
        raise HTTPException(status_code=400, detail='Your available balance is too low for this stake')
    my_bets = await db.roulette_bets.find(
        {'user_id': user['id'], 'round_number': round_number, 'status': 'OPEN'},
        {'_id': 0, 'bet_type': 1, 'value': 1, 'amount': 1},
    ).to_list(100)
    balance = await _fresh_balance(user['id'])
    return {'message': 'Bet placed', 'round_number': round_number, 'my_bets': my_bets, 'my_total': sum(b['amount'] for b in my_bets), 'balance': balance}


@router.post('/games/fun-roulette/bets/clear')
async def roulette_clear_bets(user: dict = Depends(require_active_player)):
    await require_playable_game('fun-roulette')
    round_number, _ = _require_roulette_betting(message='Bets are locked for this round.')
    async def clear_bets(session):
        kwargs = {'session': session} if session is not None else {}
        open_bets = await db.roulette_bets.find(
            {'user_id': user['id'], 'round_number': round_number, 'status': 'OPEN'},
            **kwargs,
        ).to_list(length=None)
        _require_roulette_betting(
            expected_round=round_number, message='Bets are locked for this round.',
        )
        refunded = 0
        refunded_refs = []
        for b in open_bets:
            res = await db.roulette_bets.update_one(
                {'id': b['id'], 'status': 'OPEN'},
                {'$set': {'status': 'REFUNDED', 'settled_at': _now_iso()}},
                **kwargs,
            )
            if res.modified_count:
                refunded += b['amount']
                refunded_refs.append(b['id'])
        if refunded > 0:
            await credit_chips(
                user['id'], refunded,
                f'American Roulette bets refunded (round {round_number})',
                ref=str(round_number), kind=ledger.REFUND,
                game='fun-roulette', session=session,
                source_refs=refunded_refs,
                settlement_ref=str(round_number),
            )
        return refunded

    refunded = await run_game_transaction(client, clear_bets)
    balance = await _fresh_balance(user['id'])
    return {'message': 'Bets cleared', 'refunded': refunded, 'balance': balance}


@router.post('/games/fun-roulette/bets/undo')
async def roulette_undo_bet(user: dict = Depends(require_active_player)):
    """Undo the most-recently placed chip this round (refund just that one bet)."""
    await require_playable_game('fun-roulette')
    round_number, _ = _require_roulette_betting(message='Bets are locked for this round.')
    async def undo_bet(session):
        kwargs = {'session': session} if session is not None else {}
        last = await db.roulette_bets.find(
            {'user_id': user['id'], 'round_number': round_number, 'status': 'OPEN'},
            **kwargs,
        ).sort('created_at', -1).to_list(1)
        if not last:
            return 0
        _require_roulette_betting(expected_round=round_number, message='Bets are locked for this round.')
        b = last[0]
        res = await db.roulette_bets.update_one(
            {'id': b['id'], 'status': 'OPEN'},
            {'$set': {'status': 'REFUNDED', 'settled_at': _now_iso()}},
            **kwargs,
        )
        if res.modified_count == 0:
            return 0
        refunded = b['amount']
        await credit_chips(
            user['id'], refunded, f'American Roulette undo (round {round_number})',
            ref=b['id'], kind=ledger.REFUND, game='fun-roulette', session=session,
        )
        return refunded

    refunded = await run_game_transaction(client, undo_bet)
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
    await require_playable_game(slug)
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
    await require_playable_game(slug)
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
