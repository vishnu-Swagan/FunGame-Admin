"""The night commission run.

The deck draws this as one box — "night scheduler fires · cron 02:00" — and it
is the part that pays people, so it is the part where a mistake is a payment
that cannot be taken back. Four rules.

**A period is claimed before it is worked.** A scheduler retries. A container
restarts mid-run. Two instances fire at once. Any of those, against a run that
simply starts calculating, pays every distributor twice. The claim is an insert
against a unique index — the database decides who won, not the code.

**A closed period is never silently reworked.** Re-running a settled period is
refused. If it genuinely has to be redone, that is a new numbered version with
the old one kept, so a statement that was sent still reproduces.

**Negative revenue carries forward.** A distributor whose players won owes the
operator that loss before they earn again. Without it: a losing month pays them
nothing, the next month pays in full, and the operator has funded the losing
month. The carry is stored on the period, so it is auditable rather than
recomputed from the whole history each time.

**Every input is frozen onto the row.** The rate, the carry-in, the NGR and the
deductions that produced it. A rate change or a config edit next week must not
be able to alter what this period says it paid.
"""
import uuid
from datetime import datetime, timedelta, timezone

import ledger
import crm
from revenue import apply_bps
from db import db

CLAIMED = 'CLAIMED'
COMPLETED = 'COMPLETED'
FAILED = 'FAILED'

# A run that claimed a period and then died leaves the claim behind. After this
# long another run may take it over — short enough that a crash does not block
# settlement overnight, long enough that a slow run is never stolen mid-flight.
STALE_CLAIM_MINUTES = 30


def now_iso():
    return datetime.now(timezone.utc).isoformat()


class PeriodClosed(Exception):
    """The period has already been settled."""


class PeriodBusy(Exception):
    """Another run holds the claim and is still working."""


def previous_day(day):
    d = datetime.strptime(day, '%Y-%m-%d') - timedelta(days=1)
    return d.strftime('%Y-%m-%d')


async def _claim(period_start, period_end, actor, force_version=None):
    """Take the period, or refuse.

    The unique index on (period_start, period_end, version) is what makes this
    safe against two schedulers: both insert, one gets a duplicate-key error,
    and the loser does not calculate anything.
    """
    version = force_version if force_version is not None else 1
    existing = await db.commission_runs.find_one(
        {'period_start': period_start, 'period_end': period_end, 'version': version})
    if existing:
        if existing['status'] == COMPLETED:
            raise PeriodClosed(
                f'{period_start}..{period_end} was settled at {existing.get("finished_at")}')
        if existing['status'] == CLAIMED:
            started = datetime.fromisoformat(existing['started_at'])
            age = (datetime.now(timezone.utc) - started).total_seconds() / 60
            if age < STALE_CLAIM_MINUTES:
                raise PeriodBusy(f'A run claimed this period {age:.0f} minutes ago')
            # stale: the previous attempt died. Take it over — every write below
            # is an upsert keyed on the period, so resuming cannot double-pay.
            await db.commission_runs.update_one(
                {'id': existing['id']},
                {'$set': {'started_at': now_iso(), 'taken_over_from': existing.get('run_by'),
                          'run_by': actor}})
            return existing['id']
    doc = {
        'id': str(uuid.uuid4()),
        'period_start': period_start,
        'period_end': period_end,
        'version': version,
        'status': CLAIMED,
        'started_at': now_iso(),
        'finished_at': None,
        'run_by': actor,
        'settlement_tz': str(ledger.SETTLEMENT_TZ),
    }
    try:
        await db.commission_runs.insert_one(doc)
    except Exception as e:                       # duplicate key: someone else won
        raise PeriodBusy(f'Another run claimed this period first ({e.__class__.__name__})')
    return doc['id']


async def carry_in_for(distributor_id, period_start):
    """What this distributor brought forward from the last settled period.

    Read from the most recent settled row rather than recomputed from the whole
    history: recomputation has to agree with every rounding decision ever made,
    and one day it will not.
    """
    row = await db.commission_ledger.find_one(
        {'distributor_id': distributor_id, 'period_end': {'$lt': period_start}},
        sort=[('period_end', -1)])
    return int(row.get('carry_out', 0)) if row else 0


async def run_commission(period_start, period_end, actor='scheduler', version=1):
    """Settle one period. Safe to retry, refuses to settle twice."""
    run_id = await _claim(period_start, period_end, actor, force_version=version)

    # Every distributor with revenue in the window, plus any carrying a loss
    # forward — a distributor with no activity still has to have last period's
    # negative rolled on, or it silently disappears and they earn from zero.
    active = await db.distributor_days.distinct(
        'distributor_id', {'day': {'$gte': period_start, '$lte': period_end}})
    carrying = await db.commission_ledger.distinct(
        'distributor_id', {'period_end': {'$lt': period_start}, 'carry_out': {'$lt': 0}})
    ids = sorted(set(active) | set(carrying))

    rows, totals = [], {'commission': 0, 'ngr': 0, 'carried': 0}
    for distributor_id in ids:
        if distributor_id == 'UNATTRIBUTED':
            continue
        dist = await db.distributors.find_one({'id': distributor_id}, {'_id': 0})
        if not dist:
            continue

        days = await db.distributor_days.find(
            {'distributor_id': distributor_id,
             'day': {'$gte': period_start, '$lte': period_end}}, {'_id': 0}).to_list(400)
        ngr = sum(int(d['ngr']) for d in days)
        turnover = sum(int(d['turnover']) for d in days)
        payout = sum(int(d['payout']) for d in days)
        players = max((int(d['players']) for d in days), default=0)

        carry_in = await carry_in_for(distributor_id, period_start)
        basis = ngr + carry_in                      # carry_in is zero or negative

        # The rate as at the END of the period, and the end of a period is an
        # INSTANT, not a date. Asking for the rate "on 2026-07-31" compares a
        # timestamp against a bare date as strings, and every timestamp on that
        # day sorts after it — so a rate set at 09:00 read as not yet in force
        # for the day it was set, and the distributor quietly fell back.
        # Frozen onto the row, so editing the percentage tomorrow cannot restate
        # what was paid today.
        rate_at = ledger.day_bounds_utc(period_end)[1].isoformat()
        if dist.get('is_house'):
            rate_bps, rate_source = 0, 'HOUSE'
        else:
            rate_bps, rate_source = await crm.rate_on_detailed(distributor_id, rate_at)

        if basis > 0:
            commission = apply_bps(basis, rate_bps)
            carry_out = 0
        else:
            # Nothing earned, and the shortfall travels to the next period.
            commission = 0
            carry_out = basis

        row = {
            'id': str(uuid.uuid4()),
            'run_id': run_id,
            'distributor_id': distributor_id,
            'distributor_code': dist.get('code'),
            'period_start': period_start,
            'period_end': period_end,
            'version': version,
            'players': players,
            'turnover': turnover,
            'payout': payout,
            'ngr': ngr,
            'carry_in': carry_in,
            'basis': basis,
            'rate_bps': rate_bps,
            'rate_source': rate_source,
            'rate_as_at': rate_at,
            'commission': commission,
            'carry_out': carry_out,
            'status': 'ACCRUED',
            'computed_at': now_iso(),
        }
        # Upsert on the period, so a resumed run rewrites this distributor's row
        # rather than adding a second one.
        await db.commission_ledger.update_one(
            {'distributor_id': distributor_id, 'period_start': period_start,
             'period_end': period_end, 'version': version},
            {'$set': row}, upsert=True)
        rows.append(row)
        totals['commission'] += commission
        totals['ngr'] += ngr
        totals['carried'] += carry_out

    await db.commission_runs.update_one({'id': run_id}, {'$set': {
        'status': COMPLETED, 'finished_at': now_iso(),
        'distributors': len(rows), **{f'total_{k}': v for k, v in totals.items()}}})
    return {'run_id': run_id, 'period_start': period_start, 'period_end': period_end,
            'distributors': len(rows), **totals}


async def settle_day(day=None, actor='scheduler'):
    """Settle the gaming day that has just finished — what the 02:00 cron calls.

    Defaults to YESTERDAY in the settlement zone, not to `today`: a run fired at
    02:00 is settling the day that ended two hours ago. Deriving it from the
    zone rather than the server clock is what stops the two DST nights being
    settled twice or skipped.
    """
    target = day or previous_day(ledger.gaming_day())
    return await run_commission(target, target, actor=actor)


async def ensure_indexes():
    # The claim depends on this: without it, two schedulers both "claim" the
    # period and both pay.
    await db.commission_runs.create_index(
        [('period_start', 1), ('period_end', 1), ('version', 1)], unique=True)
    await db.commission_ledger.create_index(
        [('distributor_id', 1), ('period_start', 1), ('period_end', 1), ('version', 1)],
        unique=True)
    await db.commission_ledger.create_index([('distributor_id', 1), ('period_end', -1)])
    await db.commission_ledger.create_index('status')
