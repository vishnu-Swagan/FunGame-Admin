"""First Person Blackjack — stateful per-player game API.

Deal -> (optional insurance) -> your decisions (hit/stand/double/split) ->
dealer plays -> settle. One active game per user, held in db.blackjack_games.
Deck stays server-side. All chips move through the ledger.
"""
import copy
import uuid
from datetime import datetime, timezone
from typing import List
from fastapi import APIRouter, HTTPException, Depends
from pymongo.errors import ConfigurationError, InvalidOperation, OperationFailure
from pydantic import BaseModel, Field
from db import db
from auth_utils import require_active_player
from ledger import credit_chips, debit_chips, InsufficientChips
import ledger
from game_engines import MIN_BET, MAX_BET
import blackjack as bj
from game_access import require_playable_game

router = APIRouter(tags=['blackjack'])


TRANSACTIONS_UNAVAILABLE = {
    'code': 'GAME_TRANSACTIONS_UNAVAILABLE',
    'message': 'Blackjack is temporarily unavailable. No chips were moved.',
}
_TRANSACTION_UNAVAILABLE_CODES = {20, 251, 263, 303}


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


def _session_kwargs(session):
    return {'session': session} if session is not None else {}


async def _run_transaction(fn):
    """Run a Blackjack mutation atomically; never replay it without a transaction."""
    try:
        session_cm = await db.client.start_session()
    except (AttributeError, NotImplementedError, ConfigurationError, InvalidOperation) as exc:
        raise HTTPException(status_code=503, detail=TRANSACTIONS_UNAVAILABLE) from exc
    except OperationFailure as exc:
        if exc.code in _TRANSACTION_UNAVAILABLE_CODES:
            raise HTTPException(status_code=503, detail=TRANSACTIONS_UNAVAILABLE) from exc
        raise
    try:
        async with session_cm as session:
            return await session.with_transaction(fn)
    except (ConfigurationError, InvalidOperation) as exc:
        raise HTTPException(status_code=503, detail=TRANSACTIONS_UNAVAILABLE) from exc
    except OperationFailure as exc:
        # Standalone MongoDB and deployments without transaction support report
        # one of these codes.  Failing closed is essential: replaying the
        # callback without a session could debit or pay the hand twice.
        if exc.code in _TRANSACTION_UNAVAILABLE_CODES:
            raise HTTPException(status_code=503, detail=TRANSACTIONS_UNAVAILABLE) from exc
        raise


async def _balance(uid, session=None):
    u = await db.users.find_one({'id': uid}, **_session_kwargs(session))
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


async def _save(g, session=None):
    await db.blackjack_games.replace_one(
        {'user_id': g['user_id']}, g, upsert=True, **_session_kwargs(session)
    )


async def _load(uid, session=None):
    return await db.blackjack_games.find_one({'user_id': uid}, **_session_kwargs(session))


def _intent(g):
    return g['id'], int(g.get('revision', 0))


def _require_same_intent(g, game_id, revision, required_status):
    if (not g or g.get('id') != game_id
            or int(g.get('revision', 0)) != revision
            or g.get('status') != required_status):
        raise HTTPException(status_code=409, detail={
            'code': 'STALE_GAME_ACTION',
            'message': 'The hand changed before this action completed. Refresh the table.',
        })


def _history_outcome(g):
    return {
        'dealer': bj.cards_str([_tuple(c) for c in g['dealer']]),
        'hands': [
            {
                'cards': bj.cards_str([_tuple(c) for c in h['cards']]),
                'outcome': h.get('outcome'),
                'payout': h.get('payout', 0),
            }
            for h in g['hands']
        ],
    }


async def _acknowledge_legacy_finalization(g, session):
    """Acknowledge only legacy hands whose durable history proves completion.

    The legacy finalizer credited the wallet before inserting ``game_rounds``.
    A payout ledger entry without the matching round can therefore represent a
    partially finalized hand.  Conversely, a matching settled round proves the
    old sequence reached its final durable write, so replacing the hand is safe.
    """
    if (g.get('status') != 'done' or g.get('finalized_at')
            or not g.get('id') or not g.get('settled_at')
            or 'total_staked' not in g or 'total_payout' not in g
            or not g.get('dealer') or not g.get('hands')):
        return False
    if any(
        not h.get('done') or not h.get('cards') or h.get('outcome') is None
        or 'payout' not in h
        for h in g['hands']
    ):
        return False
    try:
        outcome = _history_outcome(g)
    except (KeyError, TypeError, ValueError, IndexError):
        return False

    proof = await db.game_rounds.find_one(
        {
            'user_id': g['user_id'],
            'slug': 'blackjack',
            'status': 'SETTLED',
            'bet': g['total_staked'],
            'payout': g['total_payout'],
            'outcome': outcome,
            # The legacy round was inserted after the completed hand was saved.
            # This excludes an older coincidentally identical result.
            'settled_at': {'$gte': g['settled_at']},
        },
        {'_id': 1, 'id': 1, 'settled_at': 1},
        **_session_kwargs(session),
    )
    if not proof:
        return False

    acknowledged_at = _now()
    claimed = await db.blackjack_games.update_one(
        {
            'user_id': g['user_id'],
            'id': g['id'],
            'status': 'done',
            'finalized_at': {'$exists': False},
        },
        {'$set': {
            'finalized_at': proof.get('settled_at') or acknowledged_at,
            'legacy_finalization_acknowledged_at': acknowledged_at,
            'legacy_finalization_round_id': proof.get('id') or str(proof.get('_id')),
        }},
        **_session_kwargs(session),
    )
    return claimed.modified_count == 1


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
    await require_playable_game('blackjack')
    g = await _load(user['id'])
    bal = await _balance(user['id'])
    if not g:
        return {'status': 'idle', 'balance': bal, 'min_bet': MIN_BET}
    return {**_sanitize(g, bal), 'min_bet': MIN_BET}


@router.post('/blackjack/deal')
async def bj_deal(body: DealBody, user: dict = Depends(require_active_player)):
    await require_playable_game('blackjack')
    uid = user['id']
    stake = 0
    for hb in body.hands:
        if hb.bet < MIN_BET:
            raise HTTPException(status_code=400, detail=f'Minimum bet is {MIN_BET} chips per hand')
        stake += hb.bet + hb.pp + hb.t3
    ref = str(uuid.uuid4())
    shoe = [list(c) for c in bj.new_shoe(6)]
    blueprint = {
        'user_id': uid, 'id': ref, 'shoe': shoe, 'status': 'player_turn', 'active': 0,
        'dealer': [], 'hands': [], 'total_staked': stake, 'total_payout': 0,
        'insurance_offered': False, 'insurance_bet': 0, 'revision': 1,
        'created_at': _now(),
    }
    for hb in body.hands:
        blueprint['hands'].append({
            'bet': hb.bet, 'cards': [], 'done': False, 'outcome': None, 'payout': 0,
            'doubled': False, 'from_split_aces': False, 'pp': hb.pp, 't3': hb.t3,
        })
    # deal two rounds
    for h in blueprint['hands']:
        h['cards'].append(_draw(blueprint))
    blueprint['dealer'].append(_draw(blueprint))
    for h in blueprint['hands']:
        h['cards'].append(_draw(blueprint))
    blueprint['dealer'].append(_draw(blueprint))

    # side bets settle now (using dealer up card)
    dealer_up = _tuple(blueprint['dealer'][0])
    side_payout = 0
    for h in blueprint['hands']:
        two = [_tuple(c) for c in h['cards']]
        if h['pp'] > 0:
            m, lab = bj.eval_perfect_pairs(two)
            h['pp_mult'], h['pp_label'] = m, lab
            side_payout += h['pp'] * (m + 1) if m > 0 else 0
        if h['t3'] > 0:
            m, lab = bj.eval_21plus3(two, dealer_up)
            h['t3_mult'], h['t3_label'] = m, lab
            side_payout += h['t3'] * (m + 1) if m > 0 else 0
    blueprint['total_payout'] += side_payout

    # naturals: mark blackjack hands done
    for h in blueprint['hands']:
        if bj.is_blackjack([_tuple(c) for c in h['cards']]):
            h['done'] = True

    # dealer peek / insurance
    if dealer_up[0] == 14:  # Ace up -> offer insurance, then peek
        blueprint['status'] = 'insurance'
        blueprint['insurance_offered'] = True
    elif (bj.card_value(dealer_up[0]) == 10
          and bj.is_blackjack([_tuple(c) for c in blueprint['dealer']])):
        _dealer_and_settle(blueprint)
    else:
        _advance(blueprint)

    async def deal(session):
        existing = await _load(uid, session=session)
        if (existing and existing.get('status') == 'done'
                and not existing.get('finalized_at')):
            acknowledged = await _acknowledge_legacy_finalization(existing, session)
            if not acknowledged:
                # Legacy hands were saved as done before their non-transactional
                # payout/history writes. Replacing one without proof would
                # destroy the evidence needed to reconcile a partial finalization.
                raise HTTPException(status_code=409, detail={
                    'code': 'LEGACY_HAND_REVIEW_REQUIRED',
                    'message': 'Your previous hand is being verified before a new deal.',
                })
        if existing and existing['status'] not in ('done', 'idle'):
            raise HTTPException(status_code=409, detail='Finish your current hand first')
        g = copy.deepcopy(blueprint)
        await debit_chips(
            uid, stake, 'Blackjack deal', ref=ref, kind=ledger.STAKE,
            game='blackjack', session=session,
        )
        await _save(g, session=session)
        if side_payout > 0:
            await credit_chips(
                uid, side_payout, 'Blackjack side bets', ref=ref,
                kind=ledger.PAYOUT, game='blackjack', session=session,
            )
        if g['status'] == 'done':
            await _finalize(g, uid, ref, session=session)
        return g

    try:
        g = await _run_transaction(deal)
    except InsufficientChips:
        raise HTTPException(status_code=400, detail='Not enough play chips for these bets')
    bal = await _balance(uid)
    return {**_sanitize(g, bal), 'min_bet': MIN_BET}


@router.post('/blackjack/insurance')
async def bj_insurance(body: InsuranceBody, user: dict = Depends(require_active_player)):
    await require_playable_game('blackjack')
    uid = user['id']
    current = await _load(uid)
    if not current or current['status'] != 'insurance':
        raise HTTPException(status_code=400, detail='No insurance decision pending')
    ref, revision = _intent(current)

    async def insure(session):
        g = await _load(uid, session=session)
        _require_same_intent(g, ref, revision, 'insurance')
        dealer = [_tuple(c) for c in g['dealer']]
        dealer_bj = bj.is_blackjack(dealer)
        if body.take:
            ins = sum(h['bet'] for h in g['hands']) // 2
            await debit_chips(
                uid, ins, 'Blackjack insurance', ref=ref, kind=ledger.STAKE,
                game='blackjack', session=session,
            )
            g['insurance_bet'] = ins
            g['total_staked'] += ins
            if dealer_bj:
                g['total_payout'] += ins * 3  # 2:1
        g['insurance_offered'] = False
        if dealer_bj:
            _dealer_and_settle(g)
        else:
            _advance(g)
        g['revision'] = revision + 1
        await _save(g, session=session)
        if g['status'] == 'done':
            await _finalize(g, uid, ref, session=session)
        return g

    try:
        g = await _run_transaction(insure)
    except InsufficientChips:
        raise HTTPException(status_code=400, detail='Not enough chips for insurance')
    bal = await _balance(uid)
    return {**_sanitize(g, bal), 'min_bet': MIN_BET}


@router.post('/blackjack/action')
async def bj_action(body: ActionBody, user: dict = Depends(require_active_player)):
    await require_playable_game('blackjack')
    uid = user['id']
    act = body.action
    if act not in ('hit', 'stand', 'double', 'split'):
        raise HTTPException(status_code=400, detail='Unknown action')
    current = await _load(uid)
    if not current or current['status'] != 'player_turn':
        raise HTTPException(status_code=400, detail='No hand in play')
    ref, revision = _intent(current)

    async def apply_action(session):
        g = await _load(uid, session=session)
        _require_same_intent(g, ref, revision, 'player_turn')
        i = g['active']
        h = g['hands'][i]
        cards = [_tuple(c) for c in h['cards']]
        extra_debit = 0

        if act == 'hit':
            h['cards'].append(_draw(g))
            if (bj.is_bust([_tuple(c) for c in h['cards']])
                    or bj.hand_value([_tuple(c) for c in h['cards']]) == 21):
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
        else:  # split
            if len(cards) != 2 or cards[0][0] != cards[1][0] or len(g['hands']) >= 6:
                raise HTTPException(status_code=400, detail='Cannot split this hand')
            extra_debit = h['bet']
            is_aces = cards[0][0] == 14
            c0, c1 = h['cards'][0], h['cards'][1]
            new_hand = {
                'bet': h['bet'], 'cards': [c1], 'done': False,
                'outcome': None, 'payout': 0, 'doubled': False,
                'from_split_aces': is_aces, 'pp': 0, 't3': 0,
            }
            h['cards'] = [c0]
            h['from_split_aces'] = is_aces
            h['cards'].append(_draw(g))
            new_hand['cards'].append(_draw(g))
            if is_aces:
                h['done'] = True
                new_hand['done'] = True
            g['hands'].insert(i + 1, new_hand)

        if extra_debit > 0:
            await debit_chips(
                uid, extra_debit, f'Blackjack {act}', ref=ref,
                kind=ledger.STAKE, game='blackjack', session=session,
            )
            g['total_staked'] += extra_debit

        if h['done']:
            _advance(g)

        g['revision'] = revision + 1
        await _save(g, session=session)
        if g['status'] == 'done':
            await _finalize(g, uid, ref, session=session)
        return g

    try:
        g = await _run_transaction(apply_action)
    except InsufficientChips:
        raise HTTPException(status_code=400, detail='Not enough chips')
    bal = await _balance(uid)
    return {**_sanitize(g, bal), 'min_bet': MIN_BET}


async def _finalize(g, uid, ref, session):
    """Credit and record a completed hand exactly once inside its transaction."""
    finalized_at = _now()
    claimed = await db.blackjack_games.update_one(
        {
            'user_id': uid, 'id': ref, 'status': 'done',
            'finalized_at': {'$exists': False},
        },
        {'$set': {'finalized_at': finalized_at}},
        **_session_kwargs(session),
    )
    if claimed.modified_count == 0:
        return False
    g['finalized_at'] = finalized_at
    main = sum(h.get('payout', 0) for h in g['hands'])
    ins = g['insurance_bet'] * 3 if (g.get('insurance_bet', 0) > 0 and bj.is_blackjack([_tuple(c) for c in g['dealer']])) else 0
    payout = main + ins
    if payout > 0:
        await credit_chips(
            uid, payout, 'Blackjack payout', ref=ref, kind=ledger.PAYOUT,
            game='blackjack', session=session,
        )
    game = await db.games.find_one({'slug': 'blackjack'}, **_session_kwargs(session))
    gname = game['name'] if game else 'Blackjack'
    await db.game_rounds.insert_one({
        '_id': f'blackjack:{ref}', 'id': f'blackjack:{ref}',
        'user_id': uid, 'slug': 'blackjack', 'game_name': gname,
        'bet': g['total_staked'], 'payout': g['total_payout'], 'status': 'SETTLED',
        'outcome': _history_outcome(g),
        'created_at': finalized_at, 'settled_at': finalized_at,
    }, **_session_kwargs(session))
    return True
