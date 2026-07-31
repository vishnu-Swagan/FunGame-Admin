"""The pending payout queue — commission earned becoming money sent.

Section 4 of the deck ends "commission ledger entry → pending payout queue →
admin approval → distributor paid → statement updated". The gap between the
first and last of those is where the operator's exposure lives, so:

**An entry belongs to exactly one payout, ever.** Entries are CLAIMED by a
payout id in a single conditional update before anything is summed. Two builds
running together cannot both pick up the same commission, because the second
update matches nothing — the same reason the commission run claims its period.

**Money is held back before it is released.** A commission earned on a deposit
that is later reversed has been paid out of revenue that never existed. Entries
younger than the holdback are simply not eligible yet; they stay accrued and are
picked up by a later build.

**Small balances roll forward rather than being sent.** Raising a payment for
under the threshold costs more in fees and reconciliation than it moves. Below
it, the claim is released and the commission stays accrued.

**A payment already made is never edited.** A reversal is a new negative entry
against the next period — a clawback — so the paid row still reproduces the
statement that was sent.

Distributor money is kept in its own ledger. It is not player money and must
never share a balance with the chip wallet.
"""
import uuid
from datetime import datetime, timedelta, timezone

from db import db

ACCRUED = 'ACCRUED'
QUEUED = 'QUEUED'
PAID = 'PAID'

PENDING = 'PENDING'
APPROVED = 'APPROVED'
REJECTED = 'REJECTED'

# Defaults. Both belong in operator config once there is a settings screen for
# them; they are here so the behaviour is defined rather than implicit.
DEFAULT_MIN_PAYOUT = 10_000       # minor units
DEFAULT_HOLDBACK_DAYS = 7


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def _cutoff(holdback_days):
    return (datetime.now(timezone.utc) - timedelta(days=holdback_days)).strftime('%Y-%m-%d')


async def build_payout(distributor_id, actor='scheduler',
                       min_payout=DEFAULT_MIN_PAYOUT, holdback_days=DEFAULT_HOLDBACK_DAYS):
    """Gather eligible commission into one pending payout, or leave it accrued.

    Returns the payout document, or None when there is nothing eligible or the
    total is under the threshold.
    """
    payout_id = str(uuid.uuid4())
    cutoff = _cutoff(holdback_days)

    # Claim first, count second. Doing it the other way round leaves a window in
    # which a second build sums the same entries and raises a duplicate payment.
    claimed = await db.commission_ledger.update_many(
        {'distributor_id': distributor_id, 'status': ACCRUED,
         'commission': {'$gt': 0}, 'period_end': {'$lte': cutoff}},
        {'$set': {'status': QUEUED, 'payout_id': payout_id, 'queued_at': now_iso()}})
    if not claimed.modified_count:
        return None

    entries = await db.commission_ledger.find(
        {'payout_id': payout_id}, {'_id': 0}).to_list(1000)
    total = sum(int(e['commission']) for e in entries)

    if total < min_payout:
        # Not worth sending. Release the claim so the commission is picked up by
        # a later build once it has grown past the threshold.
        await db.commission_ledger.update_many(
            {'payout_id': payout_id},
            {'$set': {'status': ACCRUED}, '$unset': {'payout_id': '', 'queued_at': ''}})
        return None

    dist = await db.distributors.find_one({'id': distributor_id}, {'_id': 0}) or {}
    doc = {
        'id': payout_id,
        'distributor_id': distributor_id,
        'distributor_code': dist.get('code'),
        'distributor_name': dist.get('name'),
        'amount': total,
        'entry_count': len(entries),
        'period_from': min(e['period_start'] for e in entries),
        'period_to': max(e['period_end'] for e in entries),
        'status': PENDING,
        'created_at': now_iso(),
        'created_by': actor,
        'holdback_days': holdback_days,
        'min_payout': min_payout,
        'approved_at': None, 'approved_by': None,
        'paid_at': None, 'paid_by': None, 'payment_ref': None,
        'rejected_reason': None,
    }
    await db.payouts.insert_one(doc)
    return doc


async def build_all(actor='scheduler', **kw):
    ids = await db.commission_ledger.distinct(
        'distributor_id', {'status': ACCRUED, 'commission': {'$gt': 0}})
    built = []
    for did in ids:
        doc = await build_payout(did, actor=actor, **kw)
        if doc:
            built.append(doc)
    return built


async def approve(payout_id, actor, note=None):
    res = await db.payouts.update_one(
        {'id': payout_id, 'status': PENDING},
        {'$set': {'status': APPROVED, 'approved_at': now_iso(),
                  'approved_by': actor, 'approval_note': note}})
    if not res.modified_count:
        raise ValueError('Payout is not pending — it may already be approved, paid or rejected')
    return await db.payouts.find_one({'id': payout_id}, {'_id': 0})


async def reject(payout_id, actor, reason):
    """Send the commission back to accrued so it can be paid another day.

    Rejecting is not writing the money off — the entries return to the pool and
    the next build picks them up. Writing it off is a clawback, which is a
    different, deliberate act.
    """
    if not reason:
        raise ValueError('A rejection has to have a reason recorded')
    res = await db.payouts.update_one(
        {'id': payout_id, 'status': {'$in': [PENDING, APPROVED]}},
        {'$set': {'status': REJECTED, 'rejected_reason': reason,
                  'rejected_at': now_iso(), 'rejected_by': actor}})
    if not res.modified_count:
        raise ValueError('Only a pending or approved payout can be rejected')
    await db.commission_ledger.update_many(
        {'payout_id': payout_id},
        {'$set': {'status': ACCRUED}, '$unset': {'payout_id': '', 'queued_at': ''}})
    return await db.payouts.find_one({'id': payout_id}, {'_id': 0})


async def mark_paid(payout_id, actor, payment_ref):
    """Record that the money left, and close the entries behind it."""
    if not payment_ref:
        raise ValueError('A payment reference is required — an unreferenced payment cannot be reconciled')
    payout = await db.payouts.find_one({'id': payout_id})
    if not payout:
        raise ValueError('Payout not found')
    if payout['status'] != APPROVED:
        raise ValueError('Only an approved payout can be marked paid')
    await db.payouts.update_one({'id': payout_id}, {'$set': {
        'status': PAID, 'paid_at': now_iso(), 'paid_by': actor, 'payment_ref': payment_ref}})
    await db.commission_ledger.update_many(
        {'payout_id': payout_id}, {'$set': {'status': PAID, 'paid_at': now_iso()}})
    # Distributor money, in its own ledger. It is not player money and must
    # never share a balance with the chip wallet.
    await db.payout_ledger.insert_one({
        'id': str(uuid.uuid4()),
        'distributor_id': payout['distributor_id'],
        'payout_id': payout_id,
        'type': 'PAYOUT',
        'amount': -int(payout['amount']),
        'payment_ref': payment_ref,
        'created_at': now_iso(),
        'created_by': actor,
    })
    return await db.payouts.find_one({'id': payout_id}, {'_id': 0})


async def clawback(distributor_id, amount, reason, actor, period_end=None):
    """Reverse commission already paid, as a new negative entry.

    Editing the paid row would change a statement that has been sent. The
    reversal is its own entry with a negative commission, so it nets off the
    NEXT payout and both documents stay true.
    """
    amount = abs(int(amount))
    if not reason:
        raise ValueError('A clawback has to have a reason recorded')
    day = period_end or datetime.now(timezone.utc).strftime('%Y-%m-%d')
    row = {
        'id': str(uuid.uuid4()),
        'distributor_id': distributor_id,
        'period_start': day, 'period_end': day,
        'version': 1,
        'ngr': 0, 'carry_in': 0, 'basis': 0,
        'rate_bps': 0, 'rate_source': 'CLAWBACK',
        'commission': -amount,
        'carry_out': 0,
        'status': ACCRUED,
        'is_clawback': True,
        'reason': reason,
        'computed_at': now_iso(),
        'created_by': actor,
    }
    await db.commission_ledger.insert_one(row)
    row.pop('_id', None)
    return row


async def balance_for(distributor_id):
    """What a distributor is owed, and what has been sent."""
    accrued = await db.commission_ledger.find(
        {'distributor_id': distributor_id, 'status': {'$in': [ACCRUED, QUEUED]}},
        {'_id': 0, 'commission': 1}).to_list(5000)
    paid = await db.payout_ledger.find(
        {'distributor_id': distributor_id}, {'_id': 0, 'amount': 1}).to_list(5000)
    return {
        'accrued': sum(int(e['commission']) for e in accrued),
        'paid': -sum(int(p['amount']) for p in paid),
    }


async def ensure_indexes():
    await db.payouts.create_index([('distributor_id', 1), ('status', 1)])
    await db.payouts.create_index('status')
    await db.commission_ledger.create_index([('status', 1), ('period_end', 1)])
    await db.payout_ledger.create_index('distributor_id')
