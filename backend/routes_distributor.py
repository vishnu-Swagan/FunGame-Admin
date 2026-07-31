"""The partner portal — section 5 of the deck, read from the distributor's side.

Everything here is READ-ONLY, and that is a design decision rather than a
missing feature. A distributor cannot change their commission rate, cannot
adjust a figure, cannot raise their own payout. The only writes a partner can
make in this system are a support message and a password change, both of which
already exist elsewhere. A portal that could alter the numbers it reports is a
portal whose numbers mean nothing.

Two rules shape every response:

**Scoped at the dependency, not in the query.** The distributor id comes from
`require_distributor`, which resolves it from the signed-in user. No route takes
a distributor id from the caller, so there is no route where forgetting to check
one would let a partner read another partner's revenue.

**Settled and unsettled are labelled, never blended.** Today's figures are
provisional: the day is still running, the aggregation is rebuilt each night and
a void or a correction moves them. The commission a partner is actually owed is
the settled ledger. Showing both is useful; showing them as the same kind of
number is how a partner ends up expecting a payment that was never earned.

Player detail is deliberately thin. A distributor sees who they introduced, when
and whether the account is live — not the player's email, phone or date of
birth. They are an introducer, not a joint controller of that data, and the
operator is UK-based.
"""
import csv
import io
import logging
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Response

import crm
import ledger
import payouts as payouts_mod
from auth_utils import require_distributor
from db import db, serialize_doc

logger = logging.getLogger('distributor')
router = APIRouter(prefix='/distributor', tags=['distributor'])

# A gaming day is a string key, so a range query is a string comparison. That
# only holds while the format is zero-padded ISO, which `ledger.gaming_day`
# guarantees.
MAX_RANGE_DAYS = 400


def _day(offset=0):
    return ledger.gaming_day(datetime.now(timezone.utc) + timedelta(days=offset))


def _month_start(day):
    return day[:8] + '01'


def _totals(rows):
    keys = ('turnover', 'payout', 'ggr', 'ngr', 'bets', 'bonus_cost', 'duty',
            'gateway_fee', 'platform_fee')
    return {k: sum(int(r.get(k) or 0) for r in rows) for k in keys}


async def _days_between(distributor_id, start, end):
    return await db.distributor_days.find(
        {'distributor_id': distributor_id, 'day': {'$gte': start, '$lte': end}},
        {'_id': 0},
    ).sort('day', 1).to_list(MAX_RANGE_DAYS)


async def _distinct_players(distributor_id, start, end):
    """Players who staked in the range, counted once each.

    Summing the per-day player counts would count a player who played on five
    days as five players, and a partner reading their own dashboard would find
    the number that flatters them is the wrong one.
    """
    ids = await db.player_days.distinct('user_id', {
        'distributor_id': distributor_id, 'day': {'$gte': start, '$lte': end}})
    return len(ids)


def _clean_range(frm, to):
    today = _day()
    to = (to or today)[:10]
    frm = (frm or _month_start(to))[:10]
    for value in (frm, to):
        try:
            datetime.strptime(value, '%Y-%m-%d')
        except ValueError:
            raise HTTPException(status_code=400, detail='Dates must be YYYY-MM-DD')
    if frm > to:
        frm, to = to, frm
    return frm, to


# ------------------------------------------------------------------ identity

@router.get('/me')
async def me(ctx: dict = Depends(require_distributor)):
    """Who the partner is, and what they earn — both read-only.

    The rate is reported as the one in force NOW, with its provenance, because a
    partner asking "what is my percentage" is asking about the next period. What
    each past period was settled at is on the statement rows, where it belongs.
    """
    dist = ctx['distributor']
    rate_bps, rate_source = await crm.rate_on_detailed(dist['id'], crm.now_iso())
    balance = await payouts_mod.balance_for(dist['id'])
    return {
        'distributor': {
            'name': dist['name'],
            'code': dist['code'],
            'status': dist['status'],
            'email': dist.get('email'),
            'phone': dist.get('phone'),
            'since': dist.get('created_at'),
        },
        'rate_bps': rate_bps,
        'rate_source': rate_source,
        'balance': balance,
        'settlement_timezone': str(ledger.SETTLEMENT_TZ),
    }


# ----------------------------------------------------------------- dashboard

@router.get('/summary')
async def summary(ctx: dict = Depends(require_distributor)):
    """The landing screen: today, yesterday, this month, and what is owed."""
    dist = ctx['distributor']
    did = dist['id']
    today, yesterday = _day(), _day(-1)
    month_from = _month_start(today)

    today_rows = await _days_between(did, today, today)
    yday_rows = await _days_between(did, yesterday, yesterday)
    month_rows = await _days_between(did, month_from, today)

    rate_bps, _ = await crm.rate_on_detailed(did, crm.now_iso())
    balance = await payouts_mod.balance_for(did)

    pending = await db.payouts.find(
        {'distributor_id': did, 'status': {'$in': [payouts_mod.PENDING, payouts_mod.APPROVED]}},
        {'_id': 0, 'amount': 1},
    ).to_list(200)

    # Settled commission for the month, from the ledger rather than derived from
    # today's rate — a rate change mid-month must not restate the days before it.
    settled = await db.commission_ledger.find(
        {'distributor_id': did, 'period_end': {'$gte': month_from, '$lte': today}},
        {'_id': 0, 'commission': 1},
    ).to_list(400)

    return {
        'today': {**_totals(today_rows), 'day': today, 'provisional': True,
                  'players': await _distinct_players(did, today, today)},
        'yesterday': {**_totals(yday_rows), 'day': yesterday,
                      'players': await _distinct_players(did, yesterday, yesterday)},
        'month': {**_totals(month_rows), 'from': month_from, 'to': today,
                  'players': await _distinct_players(did, month_from, today)},
        'month_commission_settled': sum(int(r['commission']) for r in settled),
        'rate_bps': rate_bps,
        'accrued': balance['accrued'],
        'paid_to_date': balance['paid'],
        'in_flight': sum(int(p['amount']) for p in pending),
        'total_players': await db.users.count_documents(
            {'distributor_id': did, 'role': 'PLAYER'}),
    }


@router.get('/daily')
async def daily(frm: str = None, to: str = None, ctx: dict = Depends(require_distributor)):
    """Day-by-day revenue for a range. Defaults to the current month."""
    frm, to = _clean_range(frm, to)
    rows = await _days_between(ctx['distributor']['id'], frm, to)
    return {'from': frm, 'to': to, 'days': rows, 'totals': _totals(rows),
            'players': await _distinct_players(ctx['distributor']['id'], frm, to)}


# ---------------------------------------------------------------- statements

@router.get('/statements')
async def statements(ctx: dict = Depends(require_distributor)):
    """Settled commission periods — the numbers a payment is actually made on.

    `carry_in` and `carry_out` are shown rather than netted away. A losing period
    carries forward against the next one, and a partner who sees only "£0 this
    month" without the carried figure will read the following month's reduced
    commission as an error.
    """
    rows = await db.commission_ledger.find(
        {'distributor_id': ctx['distributor']['id']}, {'_id': 0},
    ).sort('period_end', -1).to_list(500)
    return {
        'entries': rows,
        'accrued': sum(int(r['commission']) for r in rows
                       if r['status'] == payouts_mod.ACCRUED),
        'carried': rows[0].get('carry_out', 0) if rows else 0,
    }


@router.get('/payouts')
async def my_payouts(ctx: dict = Depends(require_distributor)):
    rows = await db.payouts.find(
        {'distributor_id': ctx['distributor']['id']},
        # The internal actor ids on a payout are of no use to a partner and are
        # operator staff records; the dates and the reference are what they need.
        {'_id': 0, 'created_by': 0, 'approved_by': 0, 'paid_by': 0, 'rejected_by': 0},
    ).sort('created_at', -1).to_list(300)
    return {'payouts': rows,
            'paid_total': sum(int(r['amount']) for r in rows if r['status'] == payouts_mod.PAID)}


@router.get('/players')
async def my_players(ctx: dict = Depends(require_distributor)):
    """Who this partner introduced. Identity stays with the operator.

    Login ID, join date and account status are what a partner needs to answer
    "did my referral come through". Email, phone and date of birth are the
    operator's to hold, and are not projected here.
    """
    rows = await db.users.find(
        {'distributor_id': ctx['distributor']['id'], 'role': 'PLAYER'},
        {'_id': 0, 'id': 1, 'username': 1, 'status': 1, 'created_at': 1, 'last_login_at': 1},
    ).sort('created_at', -1).to_list(1000)

    # Lifetime turnover per player, so a partner can see which introductions are
    # actually generating revenue. Chip balances are not theirs to see.
    since = _month_start(_day())
    played = {}
    cursor = db.player_days.find(
        {'distributor_id': ctx['distributor']['id'], 'day': {'$gte': since}},
        {'_id': 0, 'user_id': 1, 'turnover': 1, 'bets': 1})
    async for row in cursor:
        p = played.setdefault(row['user_id'], {'turnover': 0, 'bets': 0})
        p['turnover'] += int(row.get('turnover') or 0)
        p['bets'] += int(row.get('bets') or 0)

    out = []
    for r in rows:
        stats = played.get(r['id'], {'turnover': 0, 'bets': 0})
        out.append({'login_id': r.get('username'), 'status': r.get('status'),
                    'joined': r.get('created_at'), 'last_login': r.get('last_login_at'),
                    'month_turnover': stats['turnover'], 'month_bets': stats['bets']})
    return {'players': serialize_doc(out), 'count': len(out), 'month_from': since}


# ------------------------------------------------------------------- exports

def _csv_response(filename, header, rows):
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(header)
    writer.writerows(rows)
    return Response(
        content=buf.getvalue(),
        media_type='text/csv',
        # Without this the browser renders the CSV as a page of text instead of
        # saving it, which on a phone means the export cannot be kept at all.
        headers={'Content-Disposition': f'attachment; filename="{filename}"'},
    )


@router.get('/exports/daily.csv')
async def export_daily(frm: str = None, to: str = None,
                       ctx: dict = Depends(require_distributor)):
    frm, to = _clean_range(frm, to)
    dist = ctx['distributor']
    rows = await _days_between(dist['id'], frm, to)
    return _csv_response(
        f"{dist['code']}-revenue-{frm}-to-{to}.csv",
        ['Gaming day', 'Players', 'Bets', 'Turnover', 'Payout', 'GGR',
         'Bonus cost', 'Duty', 'Platform fee', 'NGR'],
        [[r['day'], r.get('players', 0), r.get('bets', 0), r.get('turnover', 0),
          r.get('payout', 0), r.get('ggr', 0), r.get('bonus_cost', 0),
          r.get('duty', 0), r.get('platform_fee', 0), r.get('ngr', 0)] for r in rows],
    )


@router.get('/exports/statements.csv')
async def export_statements(ctx: dict = Depends(require_distributor)):
    dist = ctx['distributor']
    rows = await db.commission_ledger.find(
        {'distributor_id': dist['id']}, {'_id': 0},
    ).sort('period_end', 1).to_list(500)
    return _csv_response(
        f"{dist['code']}-statements.csv",
        ['Period start', 'Period end', 'NGR', 'Carried in', 'Basis',
         'Rate %', 'Commission', 'Carried out', 'Status', 'Settled at'],
        [[r['period_start'], r['period_end'], r.get('ngr', 0), r.get('carry_in', 0),
          r.get('basis', 0), f"{int(r.get('rate_bps', 0)) / 100:g}",
          r.get('commission', 0), r.get('carry_out', 0), r.get('status'),
          r.get('computed_at')] for r in rows],
    )
