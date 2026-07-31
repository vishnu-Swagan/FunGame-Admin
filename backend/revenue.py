"""Turnover, GGR and NGR — per player per gaming day.

This is the base every commission is calculated from, so it has three
properties that matter more than speed:

**It is derived, never accumulated.** A day is recomputed from the ledger rows
that fall in it, not incremented as bets arrive. Counters drift: a retry, a
crash between two writes, a bug fixed later, and the running total is wrong with
nothing to compare it against. A derived figure can always be rebuilt from the
rows and checked against the previous answer.

**It is idempotent.** Running the same day twice produces the same document, not
twice the turnover. That is what makes a scheduler safe to retry and a bad day
safe to re-run after a fix.

**It keeps negatives.** A day where the players won is negative revenue and must
stay negative. Clamping it to zero is how a distributor ends up paid on a
losing month — see the carryover rule in the design note.
"""
import uuid
from datetime import datetime, timezone

import ledger
from db import db


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def apply_bps(amount, bps):
    """`amount` times `bps`/10000, rounded half up, away from zero.

    Integer arithmetic throughout. A commission is a share of money and money is
    counted in whole units — doing this in floats gives an answer that does not
    reconcile to the sum of its own rows, and the difference grows with volume.

    Rounding away from zero keeps a negative period symmetrical with a positive
    one, so a carried-forward loss is not quietly shaved each time it is
    recalculated.
    """
    amount = int(amount)
    bps = int(bps)
    sign = -1 if amount < 0 else 1
    return sign * ((abs(amount) * bps + 5000) // 10000)


# Which ledger kinds move revenue, and in which direction. Anything not named
# here — a deposit, a withdrawal, a manual correction — is a movement of the
# player's own money and is not revenue.
def _blank():
    return {'stake': 0, 'payout': 0, 'refund': 0, 'bonus': 0, 'bets': 0}


async def aggregate_day(day, only_user=None):
    """Rebuild `player_days` for one gaming day from the ledger.

    Reads by the `gaming_day` stamped on each row rather than by a time range,
    so the boundary the ledger used and the boundary this uses are the same
    boundary — they cannot disagree about a bet placed at 00:00:01.
    """
    match = {'gaming_day': day, 'kind': {'$in': list(ledger.REVENUE_KINDS)}}
    if only_user:
        match['user_id'] = only_user

    totals = {}
    cursor = db.chip_transactions.find(match, {'_id': 0, 'user_id': 1, 'kind': 1, 'amount': 1})
    async for row in cursor:
        t = totals.setdefault(row['user_id'], _blank())
        kind, amt = row['kind'], int(row['amount'])
        if kind == ledger.STAKE:
            t['stake'] += amt
            t['bets'] += 1
        elif kind == ledger.PAYOUT:
            t['payout'] += amt
        elif kind == ledger.REFUND:
            t['refund'] += amt
        elif kind == ledger.BONUS:
            t['bonus'] += amt

    written = []
    for user_id, t in totals.items():
        user = await db.users.find_one({'id': user_id}, {'_id': 0, 'distributor_id': 1, 'distributor_code': 1})
        # A refunded stake was never at risk, so it is not turnover. Counting it
        # would inflate the base a distributor is paid on every time a round is
        # voided or a bet undone.
        turnover = t['stake'] - t['refund']
        ggr = turnover - t['payout']
        doc = {
            'day': day,
            'user_id': user_id,
            'distributor_id': (user or {}).get('distributor_id'),
            'distributor_code': (user or {}).get('distributor_code'),
            'stake': t['stake'],
            'refund': t['refund'],
            'turnover': turnover,
            'payout': t['payout'],
            'bonus': t['bonus'],
            'ggr': ggr,
            'bets': t['bets'],
            'computed_at': now_iso(),
        }
        # Upsert on (day, user) — a re-run replaces the day rather than adding to
        # it, which is what makes the whole thing safe to retry.
        await db.player_days.update_one(
            {'day': day, 'user_id': user_id}, {'$set': doc}, upsert=True)
        written.append(doc)
    return written


DEFAULT_DEDUCTIONS = {
    'bonus': True,          # free chips are a cost the operator carries
    'gateway_bps': 0,       # payment processing on that cohort's deposits
    'duty_bps': 0,          # gaming duty (UK RGD is charged on GGR)
    'platform_bps': 0,      # game provider / platform revenue share
}


async def aggregate_distributor_day(day, deductions=None):
    """Roll the player days up to distributors and compute NGR.

    The deductions used are written ONTO each row. Looking them up later would
    mean a config change silently restates every period already reported — the
    same fault as storing a commission rate as a single number.
    """
    ded = {**DEFAULT_DEDUCTIONS, **(deductions or {})}
    groups = {}
    cursor = db.player_days.find({'day': day}, {'_id': 0})
    async for row in cursor:
        d = row.get('distributor_id') or 'UNATTRIBUTED'
        g = groups.setdefault(d, {'turnover': 0, 'payout': 0, 'bonus': 0, 'ggr': 0,
                                  'bets': 0, 'players': 0, 'code': row.get('distributor_code')})
        g['turnover'] += row['turnover']
        g['payout'] += row['payout']
        g['bonus'] += row['bonus']
        g['ggr'] += row['ggr']
        g['bets'] += row['bets']
        g['players'] += 1

    written = []
    for distributor_id, g in groups.items():
        ggr = g['ggr']
        bonus_cost = g['bonus'] if ded['bonus'] else 0
        # Percentage deductions are taken on GGR, which is how duty and revenue
        # share are actually levied. Each is rounded once, here, not carried as a
        # fraction into the commission calculation.
        gateway = apply_bps(ggr, ded['gateway_bps'])
        duty = apply_bps(ggr, ded['duty_bps'])
        platform = apply_bps(ggr, ded['platform_bps'])
        ngr = ggr - bonus_cost - gateway - duty - platform
        doc = {
            'day': day,
            'distributor_id': distributor_id,
            'distributor_code': g['code'],
            'players': g['players'],
            'bets': g['bets'],
            'turnover': g['turnover'],
            'payout': g['payout'],
            'ggr': ggr,
            'bonus_cost': bonus_cost,
            'gateway_fee': gateway,
            'duty': duty,
            'platform_fee': platform,
            'ngr': ngr,
            # frozen, so this row can be reproduced exactly years from now
            'deductions_applied': ded,
            'computed_at': now_iso(),
        }
        await db.distributor_days.update_one(
            {'day': day, 'distributor_id': distributor_id}, {'$set': doc}, upsert=True)
        written.append(doc)
    return written


async def rebuild_day(day, deductions=None):
    """Both levels for one day. Safe to run repeatedly."""
    players = await aggregate_day(day)
    dists = await aggregate_distributor_day(day, deductions)
    return {'day': day, 'players': len(players), 'distributors': len(dists)}


async def ensure_indexes():
    await db.player_days.create_index([('day', 1), ('user_id', 1)], unique=True)
    await db.player_days.create_index([('day', 1), ('distributor_id', 1)])
    await db.distributor_days.create_index([('day', 1), ('distributor_id', 1)], unique=True)
    await db.chip_transactions.create_index([('gaming_day', 1), ('kind', 1)])
