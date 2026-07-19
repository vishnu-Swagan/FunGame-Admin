"""Gameplay routes: server-authoritative rounds, bets and settlement.

- Client sends commands (bet + selection), never outcomes.
- Chips are debited/credited only here on the server via the ledger.
- Rounds are recorded in game_rounds; settlement is idempotent.
"""
import uuid
import logging
from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel, Field
from typing import Optional
from db import db, serialize_doc
from auth_utils import require_active_player
from ledger import credit_chips, debit_chips, InsufficientChips
from game_engines import (
    ENGINES, MIN_BET, MAX_BET, new_deck, draw_cards, card_str, vp_result,
    aviator_crash_point, aviator_multiplier,
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
