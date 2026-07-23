"""First Person Blackjack — stateful per-player game API.

Deal -> (optional insurance) -> your decisions (hit/stand/double/split) ->
dealer plays -> settle. One active game per user, held in db.blackjack_games.
Deck stays server-side. All chips move through the ledger.
"""
import uuid
from datetime import datetime, timezone
from typing import Optional, List
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel, Field
from db import db
from auth_utils import require_active_player
from ledger import credit_chips, debit_chips, InsufficientChips
from game_engines import MIN_BET, MAX_BET
import blackjack as bj

router = APIRouter(tags=['blackjack'])


def _now():
    return datetime.now(timezone.utc).isoformat()


def _tuple(c):
    return (c[0], c[1])


def _tuples(cards):
    return [(_tuple(c)) for c in cards]


class HandBet(BaseModel):
    bet: int = Field(ge=1, le=MAX_BET)
    pp: int = Field(default=0, ge=0, le=MAX_BET)   # Perfect Pairs side bet
    t3: int = Field(default=0, ge=0, le=MAX_BET)   # 21+3 side bet


class DealBody(BaseModel):
    hands: List[HandBet] = Field(min_length=1, max_length=5)


class ActionBody(BaseModel):
    action: str  # hit | stand | double | split


class InsuranceBody(BaseModel):
    take: bool


async def _balance(uid):
    u = await db.users.find_one({'id': uid})
    return u.get('chip_balance', 0) if u else 0


def _sanitize(g, balance):
    done = g['status'] == 'done'
    dealer_cards = g['dealer']
    if done:
        dealer = {'cards': bj.cards_str([_tuple(c) for c in dealer_cards]), 'value': bj.hand_value([_tuple(c) for c in dealer_cards])}
    else:
        up = _tuple(dealer_cards[0])
        dealer = {'cards': [bj.card_str(up), '??'], 'value': bj.card_value(up[0])}
    hands = []
    for i, h in enumerate(g['hands']):
        cards = [_tuple(c) for c in h['cards']]
        hands.append({
            'bet': h['bet'], 'cards': bj.cards_str(cards), 'value': bj.hand_value(cards),
            'soft': bj.hand_total(cards)[1], 'done': h['done'], 'outcome': h.get('outcome'),
            'payout': h.get('payout', 0), 'doubled': h.get('doubled', False),
            'blackjack': bj.is_blackjack(cards) and not h.get('from_split_aces'),
            'bust': bj.is_bust(cards),
            'pp': h.get('pp', 0), 'pp_mult': h.get('pp_mult', 0), 'pp_label': h.get('pp_label'),
            't3': h.get('t3', 0), 't3_mult': h.get('t3_mult', 0), 't3_label': h.get('t3_label'),
            'can_double': (not h['done'] and len(cards) == 2 and not h.get('from_split_aces')),
            'can_split': (not h['done'] and len(cards) == 2 and cards[0][0] == cards[1][0] and len(g['hands']) < 6),
        })
    return {
        'status': g['status'], 'active': g.get('active', 0), 'hands': hands, 'dealer': dealer,
        'insurance_offered': g.get('insurance_offered', False), 'insurance_bet': g.get('insurance_bet', 0),
        'total_staked': g.get('total_staked', 0), 'total_payout': g.get('total_payout', 0),
        'net': g.get('total_payout', 0) - g.get('total_staked', 0) if done else None,
        'balance': balance,
    }


async def _save(g):
    await db.blackjack_games.replace_one({'user_id': g['user_id']}, g, upsert=True)


async def _load(uid):
    return await db.blackjack_games.find_one({'user_id': uid})


def _draw(g):
    return g['shoe'].pop()


def _first_live(g):
    for i, h in enumerate(g['hands']):
        if not h['done']:
            return i
    return -1


def _advance(g):
    """Move to the next unfinished hand, or run the dealer + settle."""
    nxt = _first_live(g)
    if nxt >= 0:
        g['active'] = nxt
        g['status'] = 'player_turn'
        return
    _dealer_and_settle(g)


def _dealer_and_settle(g):
    dealer = [_tuple(c) for c in g['dealer']]
    any_live = any(not bj.is_bust([_tuple(c) for c in h['cards']]) for h in g['hands'])
    if any_live:
        while bj.dealer_should_hit(dealer):
            dealer.append(_tuple(_draw(g)))
    g['dealer'] = [list(c) for c in dealer]
    total_payout = g.get('total_payout', 0)  # side bets already added
    for h in g['hands']:
        player = [_tuple(c) for c in h['cards']]
        payout, outcome = bj.settle_hand(player, dealer, h['bet'], from_split_aces=h.get('from_split_aces', False))
        h['payout'] = payout
        h['outcome'] = outcome
        total_payout += payout
    g['total_payout'] = total_payout
    g['status'] = 'done'
    g['settled_at'] = _now()


@router.get('/blackjack/state')
async def bj_state(user: dict = Depends(require_active_player)):
    g = await _load(user['id'])
    bal = await _balance(user['id'])
    if not g:
        return {'status': 'idle', 'balance': bal, 'min_bet': MIN_BET}
    return {**_sanitize(g, bal), 'min_bet': MIN_BET}


@router.post('/blackjack/deal')
async def bj_deal(body: DealBody, user: dict = Depends(require_active_player)):
    uid = user['id']
    existing = await _load(uid)
    if existing and existing['status'] not in ('done', 'idle'):
        raise HTTPException(status_code=409, detail='Finish your current hand first')
    stake = 0
    for hb in body.hands:
        if hb.bet < MIN_BET:
            raise HTTPException(status_code=400, detail=f'Minimum bet is {MIN_BET} chips per hand')
        stake += hb.bet + hb.pp + hb.t3
    ref = str(uuid.uuid4())
    try:
        await debit_chips(uid, stake, 'Blackjack deal', ref=ref)
    except InsufficientChips:
        raise HTTPException(status_code=400, detail='Not enough play chips for these bets')

    shoe = [list(c) for c in bj.new_shoe(6)]
    g = {
        'user_id': uid, 'id': ref, 'shoe': shoe, 'status': 'player_turn', 'active': 0,
        'dealer': [], 'hands': [], 'total_staked': stake, 'total_payout': 0,
        'insurance_offered': False, 'insurance_bet': 0, 'created_at': _now(),
    }
    for hb in body.hands:
        g['hands'].append({'bet': hb.bet, 'cards': [], 'done': False, 'outcome': None, 'payout': 0,
                           'doubled': False, 'from_split_aces': False, 'pp': hb.pp, 't3': hb.t3})
    # deal two rounds
    for h in g['hands']:
        h['cards'].append(_draw(g))
    g['dealer'].append(_draw(g))
    for h in g['hands']:
        h['cards'].append(_draw(g))
    g['dealer'].append(_draw(g))

    # side bets settle now (using dealer up card)
    dealer_up = _tuple(g['dealer'][0])
    side_payout = 0
    for h in g['hands']:
        two = [_tuple(c) for c in h['cards']]
        if h['pp'] > 0:
            m, lab = bj.eval_perfect_pairs(two)
            h['pp_mult'], h['pp_label'] = m, lab
            side_payout += h['pp'] * (m + 1) if m > 0 else 0
        if h['t3'] > 0:
            m, lab = bj.eval_21plus3(two, dealer_up)
            h['t3_mult'], h['t3_label'] = m, lab
            side_payout += h['t3'] * (m + 1) if m > 0 else 0
    g['total_payout'] += side_payout

    # naturals: mark blackjack hands done
    for h in g['hands']:
        if bj.is_blackjack([_tuple(c) for c in h['cards']]):
            h['done'] = True

    # dealer peek / insurance
    if dealer_up[0] == 14:  # Ace up -> offer insurance, then peek
        g['status'] = 'insurance'
        g['insurance_offered'] = True
    elif bj.card_value(dealer_up[0]) == 10 and bj.is_blackjack([_tuple(c) for c in g['dealer']]):
        _dealer_and_settle(g)
    else:
        _advance(g)

    await _save(g)
    if side_payout > 0:
        await credit_chips(uid, side_payout, 'Blackjack side bets', ref=ref)
    if g['status'] == 'done':
        await _finalize(g, uid, ref)
    bal = await _balance(uid)
    return {**_sanitize(g, bal), 'min_bet': MIN_BET}


@router.post('/blackjack/insurance')
async def bj_insurance(body: InsuranceBody, user: dict = Depends(require_active_player)):
    uid = user['id']
    g = await _load(uid)
    if not g or g['status'] != 'insurance':
        raise HTTPException(status_code=400, detail='No insurance decision pending')
    ref = g['id']
    dealer = [_tuple(c) for c in g['dealer']]
    dealer_bj = bj.is_blackjack(dealer)
    if body.take:
        ins = sum(h['bet'] for h in g['hands']) // 2
        try:
            await debit_chips(uid, ins, 'Blackjack insurance', ref=ref)
        except InsufficientChips:
            raise HTTPException(status_code=400, detail='Not enough chips for insurance')
        g['insurance_bet'] = ins
        g['total_staked'] += ins
        if dealer_bj:
            g['total_payout'] += ins * 3  # 2:1
    g['insurance_offered'] = False
    if dealer_bj:
        _dealer_and_settle(g)
        await _save(g)
        await _finalize(g, uid, ref)
    else:
        _advance(g)
        await _save(g)
    bal = await _balance(uid)
    return {**_sanitize(g, bal), 'min_bet': MIN_BET}


@router.post('/blackjack/action')
async def bj_action(body: ActionBody, user: dict = Depends(require_active_player)):
    uid = user['id']
    g = await _load(uid)
    if not g or g['status'] != 'player_turn':
        raise HTTPException(status_code=400, detail='No hand in play')
    i = g['active']
    h = g['hands'][i]
    cards = [_tuple(c) for c in h['cards']]
    act = body.action
    ref = g['id']
    extra_debit = 0

    if act == 'hit':
        h['cards'].append(_draw(g))
        if bj.is_bust([_tuple(c) for c in h['cards']]) or bj.hand_value([_tuple(c) for c in h['cards']]) == 21:
            h['done'] = True
    elif act == 'stand':
        h['done'] = True
    elif act == 'double':
        if len(cards) != 2 or h.get('from_split_aces'):
            raise HTTPException(status_code=400, detail='Cannot double this hand')
        extra_debit = h['bet']
        h['bet'] *= 2
        h['doubled'] = True
        h['cards'].append(_draw(g))
        h['done'] = True
    elif act == 'split':
        if len(cards) != 2 or cards[0][0] != cards[1][0] or len(g['hands']) >= 6:
            raise HTTPException(status_code=400, detail='Cannot split this hand')
        extra_debit = h['bet']
        is_aces = cards[0][0] == 14
        c0, c1 = h['cards'][0], h['cards'][1]
        new_hand = {'bet': h['bet'], 'cards': [c1], 'done': False, 'outcome': None, 'payout': 0,
                    'doubled': False, 'from_split_aces': is_aces, 'pp': 0, 't3': 0}
        h['cards'] = [c0]
        h['from_split_aces'] = is_aces
        h['cards'].append(_draw(g))
        new_hand['cards'].append(_draw(g))
        if is_aces:
            h['done'] = True
            new_hand['done'] = True
        g['hands'].insert(i + 1, new_hand)
    else:
        raise HTTPException(status_code=400, detail='Unknown action')

    if extra_debit > 0:
        try:
            await debit_chips(uid, extra_debit, f'Blackjack {act}', ref=ref)
        except InsufficientChips:
            raise HTTPException(status_code=400, detail='Not enough chips')
        g['total_staked'] += extra_debit

    if h['done'] and act != 'split':
        _advance(g)
    elif act == 'split' and h['done']:
        _advance(g)

    await _save(g)
    if g['status'] == 'done':
        await _finalize(g, uid, ref)
    bal = await _balance(uid)
    return {**_sanitize(g, bal), 'min_bet': MIN_BET}


async def _finalize(g, uid, ref):
    """Credit the main+insurance winnings (side bets already credited on deal)."""
    main = sum(h.get('payout', 0) for h in g['hands'])
    ins = g['insurance_bet'] * 3 if (g.get('insurance_bet', 0) > 0 and bj.is_blackjack([_tuple(c) for c in g['dealer']])) else 0
    payout = main + ins
    if payout > 0:
        await credit_chips(uid, payout, 'Blackjack payout', ref=ref)
    game = await db.games.find_one({'slug': 'blackjack'})
    gname = game['name'] if game else 'Blackjack'
    await db.game_rounds.insert_one({
        'id': str(uuid.uuid4()), 'user_id': uid, 'slug': 'blackjack', 'game_name': gname,
        'bet': g['total_staked'], 'payout': g['total_payout'], 'status': 'SETTLED',
        'outcome': {'dealer': bj.cards_str([_tuple(c) for c in g['dealer']]),
                    'hands': [{'cards': bj.cards_str([_tuple(c) for c in h['cards']]), 'outcome': h.get('outcome'), 'payout': h.get('payout', 0)} for h in g['hands']]},
        'created_at': _now(), 'settled_at': _now(),
    })
