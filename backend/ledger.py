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

REVENUE_KINDS = (STAKE, PAYOUT, REFUND, BONUS)


class InsufficientChips(Exception):
    pass


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


async def _write(user_id, kind, direction, amount, balance_after, note, ref, game):
    await db.chip_transactions.insert_one({
        'id': str(uuid.uuid4()),
        'user_id': user_id,
        'type': direction,          # kept — existing screens read CREDIT/DEBIT
        'kind': kind,               # what it actually is, for revenue
        'amount': int(amount),
        'balance_after': balance_after,
        'game': game,
        'gaming_day': gaming_day(),
        'note': note,
        'ref': ref,
        'created_at': _now(),
    })


async def credit_chips(user_id: str, amount: int, note: str, ref: str = None,
                       kind: str = ADJUST, game: str = None):
    amount = int(amount)
    result = await db.users.find_one_and_update(
        {'id': user_id}, {'$inc': {'chip_balance': amount}}, return_document=True,
    )
    balance_after = result.get('chip_balance', 0) if result else 0
    await _write(user_id, kind, 'CREDIT', amount, balance_after, note, ref, game)
    return balance_after


async def debit_chips(user_id: str, amount: int, note: str, ref: str = None,
                      kind: str = ADJUST, game: str = None):
    amount = int(amount)
    result = await db.users.find_one_and_update(
        {'id': user_id, 'chip_balance': {'$gte': amount}},
        {'$inc': {'chip_balance': -amount}},
        return_document=True,
    )
    if result is None:
        raise InsufficientChips()
    balance_after = result.get('chip_balance', 0)
    await _write(user_id, kind, 'DEBIT', amount, balance_after, note, ref, game)
    return balance_after
