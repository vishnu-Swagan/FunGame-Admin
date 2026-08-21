import asyncio, os, sys, types
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mongomock_motor import AsyncMongoMockClient
client = AsyncMongoMockClient()
sys.modules['db'] = types.SimpleNamespace(db=client['t'], serialize_doc=lambda d: d)
import ledger, revenue, crm, commission
from datetime import datetime, timedelta, timezone
TODAY = datetime.strptime(ledger.gaming_day(datetime.now(timezone.utc)), '%Y-%m-%d')
def D(n):  # n gaming days from now, so rates created 'now' are in force
    return (TODAY + timedelta(days=n)).strftime('%Y-%m-%d')

PASS = FAIL = 0
def T(name, cond, extra=''):
    global PASS, FAIL
    print(("  PASS  " if cond else "  FAIL  ") + name + (('   ' + extra) if extra and not cond else ''))
    PASS, FAIL = (PASS+1, FAIL) if cond else (PASS, FAIL+1)

async def day_row(dist_id, day, ngr, turnover=0, payout=0, players=1):
    await client['t'].distributor_days.update_one(
        {'day': day, 'distributor_id': dist_id},
        {'$set': {'day': day, 'distributor_id': dist_id, 'ngr': ngr, 'turnover': turnover,
                  'payout': payout, 'players': players, 'bets': 1, 'distributor_code': 'X'}},
        upsert=True)

async def main():
    d = await crm.create_distributor('Northern', 'nrth1', 2500, 'admin')   # 25%
    did = d['id']

    # --- a straightforward winning period ---
    await day_row(did, D(0), ngr=10000, turnover=40000, payout=30000)
    r1 = await commission.run_commission(D(0), D(0), 'test')
    row = await client['t'].commission_ledger.find_one({'distributor_id': did, 'period_end': D(0)})
    T("commission is 25% of ngr",   row['commission'] == 2500, f"got {row['commission']}")
    T("rate frozen on the row",     row['rate_bps'] == 2500)
    T("rate provenance recorded",   row['rate_source'] == 'IN_FORCE', f"got {row.get('rate_source')}")
    T("nothing carried forward",    row['carry_out'] == 0)

    # --- settling the same period twice must be refused ---
    closed = None
    try: await commission.run_commission(D(0), D(0), 'test')
    except commission.PeriodClosed as e: closed = str(e)
    T("a settled period is refused", closed is not None)
    n = await client['t'].commission_ledger.count_documents({'distributor_id': did})
    T("no second row was written",  n == 1, f"got {n}")

    # --- a losing period pays nothing and carries the loss ---
    await day_row(did, D(1), ngr=-4000)
    await commission.run_commission(D(1), D(1), 'test')
    row2 = await client['t'].commission_ledger.find_one({'distributor_id': did, 'period_end': D(1)})
    T("a losing period pays nothing", row2['commission'] == 0)
    T("the loss carries forward",     row2['carry_out'] == -4000, f"got {row2['carry_out']}")

    # --- the next period must clear the loss BEFORE earning ---
    await day_row(did, D(2), ngr=4000)
    await commission.run_commission(D(2), D(2), 'test')
    row3 = await client['t'].commission_ledger.find_one({'distributor_id': did, 'period_end': D(2)})
    T("carry-in is applied",        row3['carry_in'] == -4000, f"got {row3['carry_in']}")
    T("basis nets to zero",         row3['basis'] == 0, f"got {row3['basis']}")
    T("nothing is paid on a recovered loss", row3['commission'] == 0,
      f"got {row3['commission']} — this is the bug that funds a losing month")
    T("the carry is cleared",       row3['carry_out'] == 0)

    # --- and a genuine profit after that pays normally ---
    await day_row(did, D(3), ngr=8000)
    await commission.run_commission(D(3), D(3), 'test')
    row4 = await client['t'].commission_ledger.find_one({'distributor_id': did, 'period_end': D(3)})
    T("a clean period pays in full", row4['commission'] == 2000, f"got {row4['commission']}")

    # --- a distributor with NO activity still carries its loss on ---
    d2 = await crm.create_distributor('Quiet', 'qut22', 3000, 'admin')
    await day_row(d2['id'], D(4), ngr=-1500)
    await commission.run_commission(D(4), D(4), 'test')
    await commission.run_commission(D(5), D(5), 'test')   # no days at all
    q = await client['t'].commission_ledger.find_one({'distributor_id': d2['id'], 'period_end': D(5)})
    T("an idle period still rolls the loss", q is not None and q['carry_out'] == -1500,
      f"got {q and q['carry_out']}")

    # --- two schedulers firing at once ---
    await day_row(did, D(6), ngr=10000)
    results = await asyncio.gather(
        commission.run_commission(D(6), D(6), 'sched-a'),
        commission.run_commission(D(6), D(6), 'sched-b'),
        return_exceptions=True)
    ok = [r for r in results if isinstance(r, dict)]
    refused = [r for r in results if isinstance(r, Exception)]
    rows10 = await client['t'].commission_ledger.count_documents(
        {'distributor_id': did, 'period_end': D(6)})
    T("only one run settles the period", len(ok) == 1 and len(refused) == 1,
      f"ok={len(ok)} refused={len(refused)}")
    T("and only one ledger row exists",  rows10 == 1, f"got {rows10}")

    # --- the house never earns ---
    h = await crm.ensure_house_account()
    await day_row(h['id'], D(7), ngr=50000)
    await commission.run_commission(D(7), D(7), 'test')
    hr = await client['t'].commission_ledger.find_one({'distributor_id': h['id']})
    T("house earns no commission",  hr['commission'] == 0 and hr['rate_bps'] == 0)

    # a period that predates every rate must NOT silently pay zero
    d3 = await crm.create_distributor('Backdated', 'bkd33', 4000, 'admin')
    await day_row(d3['id'], '2020-01-01', ngr=10000)
    await commission.run_commission('2020-01-01', '2020-01-01', 'test')
    b = await client['t'].commission_ledger.find_one({'distributor_id': d3['id']})
    T("a period before any rate falls back, loudly",
      b['rate_bps'] == 4000 and b['rate_source'] == 'EARLIEST_FALLBACK',
      f"bps {b['rate_bps']} source {b.get('rate_source')}")

    print(f"\n  {PASS} passed, {FAIL} failed")
    return FAIL
sys.exit(asyncio.run(main()))
