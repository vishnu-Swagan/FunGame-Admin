import asyncio, sys, types
sys.path.insert(0, '/Users/vishnu/FunGame-Admin/backend')
from mongomock_motor import AsyncMongoMockClient
from datetime import datetime, timedelta, timezone
client = AsyncMongoMockClient()
sys.modules['db'] = types.SimpleNamespace(db=client['t'], serialize_doc=lambda d: d)
import crm, payouts

PASS = FAIL = 0
def T(name, cond, extra=''):
    global PASS, FAIL
    print(("  PASS  " if cond else "  FAIL  ") + name + (('   ' + extra) if extra and not cond else ''))
    PASS, FAIL = (PASS+1, FAIL) if cond else (PASS, FAIL+1)

def ago(n): return (datetime.now(timezone.utc) - timedelta(days=n)).strftime('%Y-%m-%d')

async def accrue(did, amount, days_ago):
    await client['t'].commission_ledger.insert_one({
        'id': f'e{amount}-{days_ago}', 'distributor_id': did,
        'period_start': ago(days_ago), 'period_end': ago(days_ago),
        'commission': amount, 'status': payouts.ACCRUED, 'version': 1})

async def main():
    d = await crm.create_distributor('Northern', 'nrth1', 2500, 'admin')
    did = d['id']

    # --- holdback: recent commission is not eligible yet ---
    await accrue(did, 50000, days_ago=1)
    p = await payouts.build_payout(did, holdback_days=7)
    T("commission inside the holdback is not paid", p is None)
    e = await client['t'].commission_ledger.find_one({'distributor_id': did})
    T("and it stays accrued, not stranded", e['status'] == payouts.ACCRUED)

    # --- threshold: eligible but too small to send ---
    await accrue(did, 3000, days_ago=30)
    p = await payouts.build_payout(did, min_payout=10000, holdback_days=7)
    T("a balance under the threshold is not sent", p is None)
    e = await client['t'].commission_ledger.find_one({'id': 'e3000-30'})
    T("the claim is released, not left queued", e['status'] == payouts.ACCRUED and 'payout_id' not in e)

    # --- enough to send ---
    await accrue(did, 9000, days_ago=20)
    p = await payouts.build_payout(did, min_payout=10000, holdback_days=7)
    T("an eligible balance raises a payout", p is not None and p['amount'] == 12000,
      f"got {p and p['amount']}")
    T("only aged entries are included",  p['entry_count'] == 2, f"got {p['entry_count']}")
    T("it starts pending",               p['status'] == payouts.PENDING)

    # --- an entry can never be in two payouts ---
    p2 = await payouts.build_payout(did, min_payout=1, holdback_days=7)
    T("a second build finds nothing left", p2 is None)

    # --- two builds racing must not both raise a payment ---
    d2 = await crm.create_distributor('Southern', 'sth22', 2000, 'admin')
    await accrue(d2['id'], 80000, days_ago=15)
    res = await asyncio.gather(
        payouts.build_payout(d2['id'], min_payout=1, holdback_days=7),
        payouts.build_payout(d2['id'], min_payout=1, holdback_days=7))
    made = [r for r in res if r]
    T("concurrent builds raise exactly one payment", len(made) == 1, f"got {len(made)}")
    total = await client['t'].payouts.count_documents({'distributor_id': d2['id']})
    T("and only one payout row exists", total == 1, f"got {total}")

    # --- approval flow ---
    bad = None
    try: await payouts.mark_paid(p['id'], 'admin', 'REF1')
    except ValueError as ex: bad = str(ex)
    T("cannot pay before approving", bad is not None)
    await payouts.approve(p['id'], 'admin')
    noref = None
    try: await payouts.mark_paid(p['id'], 'admin', '')
    except ValueError as ex: noref = str(ex)
    T("a payment needs a reference", noref is not None)
    paid = await payouts.mark_paid(p['id'], 'admin', 'BACS-99')
    T("paid records the reference",  paid['payment_ref'] == 'BACS-99')
    ents = await client['t'].commission_ledger.find({'payout_id': p['id']}).to_list(10)
    T("its entries close as paid",   all(e['status'] == payouts.PAID for e in ents))
    led = await client['t'].payout_ledger.find_one({'payout_id': p['id']})
    T("distributor money has its own ledger", led is not None and led['amount'] == -12000)
    again = None
    try: await payouts.mark_paid(p['id'], 'admin', 'BACS-99')
    except ValueError as ex: again = str(ex)
    T("a paid payout cannot be paid twice", again is not None)

    # --- rejection returns the money to the pool ---
    await accrue(did, 40000, days_ago=25)
    p3 = await payouts.build_payout(did, min_payout=1, holdback_days=7)
    await payouts.reject(p3['id'], 'admin', 'bank details unverified')
    e = await client['t'].commission_ledger.find_one({'id': 'e40000-25'})
    T("rejection returns entries to accrued", e['status'] == payouts.ACCRUED)
    p4 = await payouts.build_payout(did, min_payout=1, holdback_days=7)
    T("and they can be paid on a later run", p4 is not None and p4['amount'] == 40000,
      f"got {p4 and p4['amount']}")

    # --- clawback nets off the next payout, it does not edit the paid one ---
    await payouts.clawback(did, 5000, 'deposit reversed', 'admin')
    paid_row = await client['t'].commission_ledger.find_one({'id': 'e9000-20'})
    T("the paid entry is untouched", paid_row['status'] == payouts.PAID and paid_row['commission'] == 9000)
    bal = await payouts.balance_for(did)
    # 50000 still inside the holdback, 40000 queued in the rebuilt payout, less
    # the 5000 clawed back. The 12000 already paid is not owed twice.
    T("the clawback reduces what is owed", bal['accrued'] == 85000, f"got {bal['accrued']}")
    T("paid total is tracked separately", bal['paid'] == 12000, f"got {bal['paid']}")

    print(f"\n  {PASS} passed, {FAIL} failed")
    return FAIL
sys.exit(asyncio.run(main()))
