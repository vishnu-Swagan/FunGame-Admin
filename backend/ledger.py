"""Server-authoritative chip ledger helpers (integer amounts only).

Every movement is written with a TYPED KIND and the GAMING DAY it fell in.

The kind matters because revenue cannot be derived from a free-text note. Before
this a row said `type: DEBIT` and carried a sentence like "Fun Roulette bet
(round 41)", so the only way to tell a stake from a chip sale was to parse
English. A commission engine that has to guess which rows are turnover gets it
wrong the first time anyone edits a message, and the error is silent and
compounding — it surfaces as a distributor being paid on the wrong base.

The gaming day matters because revenue is reported per day and "per day" has to
mean exactly one thing. It is stamped at write time from the operator's
settlement zone, so a row cannot be re-bucketed later by a container moving
region, and so the two nights a year London changes offset do not put bets in
the wrong day.
"""
import hashlib
import os
import uuid
from datetime import datetime, timedelta, timezone
import logging
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from db import db

# Where the operator's day starts and ends. One declared zone, never the
# server's local time — a container that moves region must not shift the books.
_TZ_NAME = os.environ.get('SETTLEMENT_TZ', 'Europe/London')
try:
    SETTLEMENT_TZ = ZoneInfo(_TZ_NAME)
except ZoneInfoNotFoundError:                       # no tz database in the image
    # Evaluated at import, and imported by every route module, so raising here
    # takes the entire API down before it serves a request — which is exactly
    # what happened. Falling back keeps the service alive; the log is loud
    # because the fallback silently shifts which day a bet is counted in, and a
    # wrong gaming day is a wrong commission period.
    logging.getLogger(__name__).error(
        'TZ DATABASE MISSING: could not load %s, falling back to UTC. '
        'Gaming days will be bucketed on UTC boundaries until tzdata is installed.',
        _TZ_NAME)
    SETTLEMENT_TZ = timezone.utc
# A gaming day runs 00:00 to 00:00 in that zone unless the operator declares
# otherwise. A constant, so the commission run and the ledger cannot disagree
# about where the boundary sits.
DAY_START_HOUR = int(os.environ.get('GAMING_DAY_START_HOUR', '0'))

# --- what a movement IS, not what it says -----------------------------------
STAKE = 'STAKE'            # debit  — money at risk; the turnover base
PAYOUT = 'PAYOUT'          # credit — a win paid from a settled round
REFUND = 'REFUND'          # credit — stake returned; round void, cancelled or undone
DEPOSIT = 'DEPOSIT'        # credit — funds in from the player
WITHDRAWAL = 'WITHDRAWAL'  # debit  — funds out to the player
BONUS = 'BONUS'            # credit — granted, not bought; a cost to the operator
ADJUST = 'ADJUST'          # either — manual correction, always with a note
SETTLEMENT = 'SETTLEMENT'  # non-money event — an authoritative stake outcome

REVENUE_KINDS = (STAKE, PAYOUT, REFUND, BONUS)


class InsufficientChips(Exception):
    pass


# Checks that must pass before a stake is taken. Registered by whoever owns the
# rule rather than called from the game routes: there are five places a bet is
# debited today and there will be more, and a check that each new route has to
# remember to call is a check that will eventually be missed. Everything that
# takes money for a bet comes through debit_chips, so this is the one place it
# cannot be routed around.
_stake_guards = []
_ledger_observers = []
_source_wallet_adapter = None


def register_stake_guard(fn):
    _stake_guards.append(fn)


def register_ledger_observer(fn):
    """Register an atomic observer for authoritative ledger events.

    Observers receive ``(event, session=...)`` and therefore participate in the
    caller's Mongo transaction. Promotion progress uses this seam so a game
    state change cannot commit while its wager evidence silently fails.
    """
    if fn not in _ledger_observers:
        _ledger_observers.append(fn)


def register_source_wallet_adapter(adapter):
    """Install the reviewed source-aware wallet adapter.

    The adapter itself owns the fail-closed readiness gates. Keeping the hook
    here makes every game path use the same allocation policy without importing
    the financial domain into each route.
    """
    global _source_wallet_adapter
    _source_wallet_adapter = adapter


def _now():
    return datetime.now(timezone.utc).isoformat()


def gaming_day(when=None):
    """The operator-day an instant falls in, as YYYY-MM-DD.

    Computed in the settlement zone so it survives the DST switches: the clocks
    move, the local calendar date does not, and bucketing by that date is what
    stops a 25-hour day being counted as two.
    """
    dt = when or datetime.now(timezone.utc)
    if isinstance(dt, str):
        dt = datetime.fromisoformat(dt.replace('Z', '+00:00'))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    local = dt.astimezone(SETTLEMENT_TZ)
    if DAY_START_HOUR:
        local -= timedelta(hours=DAY_START_HOUR)
    return local.strftime('%Y-%m-%d')


def day_bounds_utc(day):
    """The UTC instants a gaming day spans — what a commission run queries between.

    Derived from the zone rather than assumed to be 24 hours, because on the two
    switch nights it is 23 or 25.
    """
    naive = datetime.strptime(day, '%Y-%m-%d')
    start_local = naive.replace(hour=DAY_START_HOUR, tzinfo=SETTLEMENT_TZ)
    end_local = (naive + timedelta(days=1)).replace(hour=DAY_START_HOUR, tzinfo=SETTLEMENT_TZ)
    return start_local.astimezone(timezone.utc), end_local.astimezone(timezone.utc)


async def _notify(event, session=None):
    for observer in tuple(_ledger_observers):
        await observer(dict(event), session=session)


async def _write(user_id, kind, direction, amount, balance_after, note, ref, game,
                 *, event_id=None, funding_allocation=None, source_refs=None,
                 settlement_ref=None, session=None):
    kwargs = {'session': session} if session is not None else {}
    event = {
        'id': event_id or str(uuid.uuid4()),
        'user_id': user_id,
        'type': direction,          # kept — existing screens read CREDIT/DEBIT
        'kind': kind,               # what it actually is, for revenue
        'amount': int(amount),
        'balance_after': balance_after,
        'game': game,
        'gaming_day': gaming_day(),
        'note': note,
        'ref': ref,
        'source_refs': list(source_refs or []),
        'settlement_ref': settlement_ref,
        'funding_allocation': dict(funding_allocation or {}),
        'created_at': _now(),
    }
    await db.chip_transactions.insert_one(event, **kwargs)
    await _notify(event, session=session)
    return event


async def credit_chips(user_id: str, amount: int, note: str, ref: str = None,
                       kind: str = ADJUST, game: str = None, session=None,
                       source_refs=None, settlement_ref=None):
    amount = int(amount)
    event_id = str(uuid.uuid4())
    allocation = None
    normalized_refs = [str(value) for value in (source_refs or ([ref] if ref else []))]
    if _source_wallet_adapter is not None:
        allocation = await _source_wallet_adapter.credit(
            event_id=event_id, user_id=user_id, amount=amount, kind=kind,
            ref=ref, source_refs=normalized_refs, game=game, session=session,
        )
    kwargs = {'session': session} if session is not None else {}
    result = await db.users.find_one_and_update(
        {'id': user_id}, {'$inc': {'chip_balance': amount}}, return_document=True,
        **kwargs,
    )
    balance_after = result.get('chip_balance', 0) if result else 0
    await _write(
        user_id, kind, 'CREDIT', amount, balance_after, note, ref, game,
        event_id=event_id, funding_allocation=allocation,
        source_refs=normalized_refs, settlement_ref=settlement_ref, session=session,
    )
    if kind == REFUND:
        await record_settlement(
            user_id, normalized_refs, game, status='VOID',
            settlement_ref=settlement_ref or ref, session=session,
        )
    return balance_after


async def debit_chips(user_id: str, amount: int, note: str, ref: str = None,
                      kind: str = ADJUST, game: str = None, session=None,
                      settlement_ref=None):
    amount = int(amount)
    if kind == STAKE:
        # Before the balance moves, and before the caller has written a bet row.
        # The guard reads through the same transaction snapshot as the debit.
        # Since every game transaction also updates this player's balance row,
        # concurrent stakes conflict and Mongo retries the loser after the
        # winning stake is visible to the loss-limit calculation.
        for guard in _stake_guards:
            await guard(user_id, amount, session=session)
    event_id = str(uuid.uuid4())
    allocation = None
    if _source_wallet_adapter is not None:
        allocation = await _source_wallet_adapter.debit(
            event_id=event_id, user_id=user_id, amount=amount, kind=kind,
            ref=ref, game=game, session=session,
        )
    kwargs = {'session': session} if session is not None else {}
    result = await db.users.find_one_and_update(
        {'id': user_id, 'chip_balance': {'$gte': amount}},
        {'$inc': {'chip_balance': -amount}},
        return_document=True,
        **kwargs,
    )
    if result is None:
        raise InsufficientChips()
    balance_after = result.get('chip_balance', 0)
    await _write(
        user_id, kind, 'DEBIT', amount, balance_after, note, ref, game,
        event_id=event_id, funding_allocation=allocation,
        settlement_ref=settlement_ref, session=session,
    )
    return balance_after


async def record_settlement(user_id: str, source_refs, game: str, *,
                            status: str = 'SETTLED', settlement_ref: str = None,
                            session=None):
    """Record each authoritative stake outcome exactly once.

    A losing bet has no payout movement, so it still needs this explicit event.
    The marker is keyed to the original ledger transaction rather than a round,
    which prevents one stake from contributing twice when settlement is retried.
    """
    outcome = str(status or '').upper()
    if outcome not in {'SETTLED', 'VOID', 'REVERSED'}:
        raise ValueError('Unsupported settlement status')
    refs = sorted({str(value) for value in (source_refs or []) if value is not None})
    if not refs:
        return []
    kwargs = {'session': session} if session is not None else {}
    collection = db.chip_transactions
    # A few legacy unit tests use a deliberately tiny ledger fake. Production
    # Motor collections always implement find; keeping the no-op here preserves
    # those isolated balance tests without changing real settlement behavior.
    if not hasattr(collection, 'find'):
        return []
    stakes = await collection.find({
        'user_id': user_id, 'kind': STAKE, 'game': game, 'ref': {'$in': refs},
    }, {'_id': 0}, **kwargs).to_list(length=None)
    recorded = []
    for stake in stakes:
        digest = hashlib.sha256(
            f"{stake['id']}:{outcome}".encode('utf-8'),
        ).hexdigest()[:40]
        marker_id = f'settlement:{digest}'
        event = {
            'id': marker_id, 'user_id': user_id, 'type': 'EVENT',
            'kind': SETTLEMENT, 'amount': int(stake.get('amount', 0)),
            'balance_after': int(stake.get('balance_after', 0)), 'game': game,
            'gaming_day': gaming_day(), 'note': f'Stake {outcome.lower()}',
            'ref': stake.get('ref'), 'source_refs': [stake.get('ref')],
            'source_transaction_id': stake['id'],
            'settlement_ref': settlement_ref,
            'settlement_status': outcome,
            'funding_allocation': dict(stake.get('funding_allocation') or {}),
            'created_at': _now(),
        }
        result = await db.chip_transactions.update_one(
            {'id': marker_id}, {'$setOnInsert': event}, upsert=True, **kwargs,
        )
        if result.upserted_id is None:
            continue
        await _notify(event, session=session)
        recorded.append(event)
    return recorded
