import asyncio, os, sys, types
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mongomock_motor import AsyncMongoMockClient
client = AsyncMongoMockClient()
sys.modules['db'] = types.SimpleNamespace(db=client['t'], serialize_doc=lambda d: d)
import ledger, revenue, crm

PASS = FAIL = 0
def T(name, cond, extra=''):
    global PASS, FAIL
    print(("  PASS  " if cond else "  FAIL  ") + name + (('   ' + extra) if extra and not cond else ''))
    PASS, FAIL = (PASS+1, FAIL) if cond else (PASS, FAIL+1)

DAY = '2026-07-15'
async def row(uid, kind, amt, day=DAY):
    await client['t'].chip_transactions.insert_one({
        'user_id': uid, 'kind': kind, 'amount': amt, 'gaming_day': day,
        'type': 'DEBIT' if kind in (ledger.STAKE, ledger.WITHDRAWAL) else 'CREDIT'})

async def main():
    # rounding, before anything else touches money
    T("bps rounds half up",        revenue.apply_bps(1000, 2550) == 255)
    T("bps rounds .5 up",          revenue.apply_bps(10, 500) == 1)       # 0.5 -> 1
    T("bps is symmetric on losses", revenue.apply_bps(-1000, 2550) == -255)
    T("bps of zero rate is zero",  revenue.apply_bps(999999, 0) == 0)

    d = await crm.create_distributor('Northern', 'nrth1', 2500, 'admin')
    house = await crm.ensure_house_account()
    for uid, dist in (('p1', d), ('p2', d), ('p3', house)):
        await client['t'].users.insert_one({'id': uid, 'role': 'PLAYER',
            'distributor_id': dist['id'], 'distributor_code': dist['code']})

    # p1: stakes 1000, wins 400, one bet refunded 200  -> turnover 800, ggr 400
    await row('p1', ledger.STAKE, 600); await row('p1', ledger.STAKE, 400)
    await row('p1', ledger.PAYOUT, 400); await row('p1', ledger.REFUND, 200)
    # p2: stakes 500, wins 900 -> a losing day for the house, ggr -400
    await row('p2', ledger.STAKE, 500); await row('p2', ledger.PAYOUT, 900)
    # p3 (house): stakes 300, no win, plus a 100 bonus granted
    await row('p3', ledger.STAKE, 300); await row('p3', ledger.BONUS, 100)
    # money that is NOT revenue and must be ignored entirely
    await row('p1', ledger.DEPOSIT, 5000); await row('p1', ledger.WITHDRAWAL, 2000)
    await row('p1', ledger.ADJUST, 750)
    # a bet on a different gaming day must not leak in
    await row('p1', ledger.STAKE, 9999, day='2026-07-16')

    await revenue.aggregate_day(DAY)
    p1 = await client['t'].player_days.find_one({'day': DAY, 'user_id': 'p1'})
    T("refund reverses turnover",  p1['turnover'] == 800, f"got {p1['turnover']}")
    T("ggr is net stake minus payout", p1['ggr'] == 400, f"got {p1['ggr']}")
    T("bet count excludes refunds as bets", p1['bets'] == 2, f"got {p1['bets']}")
    T("deposits/withdrawals/adjustments ignored",
      p1['stake'] == 1000 and p1['payout'] == 400)
    T("another day does not leak in", p1['stake'] == 1000)

    p2 = await client['t'].player_days.find_one({'day': DAY, 'user_id': 'p2'})
    T("a losing day stays negative", p2['ggr'] == -400, f"got {p2['ggr']}")

    # idempotency — the property that makes a retry safe
    before = await client['t'].player_days.count_documents({'day': DAY})
    await revenue.aggregate_day(DAY)
    await revenue.aggregate_day(DAY)
    after = await client['t'].player_days.count_documents({'day': DAY})
    p1b = await client['t'].player_days.find_one({'day': DAY, 'user_id': 'p1'})
    T("re-running does not duplicate rows", before == after == 3, f"{before}->{after}")
    T("re-running does not double the turnover", p1b['turnover'] == 800, f"got {p1b['turnover']}")

    # distributor rollup + NGR
    await revenue.aggregate_distributor_day(DAY)
    dd = await client['t'].distributor_days.find_one({'day': DAY, 'distributor_id': d['id']})
    T("distributor ggr sums its players", dd['ggr'] == 0, f"got {dd['ggr']}")   # 400 + (-400)
    T("two players counted",       dd['players'] == 2)
    hh = await client['t'].distributor_days.find_one({'day': DAY, 'distributor_id': house['id']})
    T("bonus is a cost against ngr", hh['ggr'] == 300 and hh['ngr'] == 200,
      f"ggr {hh['ggr']} ngr {hh['ngr']}")

    # deductions are frozen onto the row, not looked up later
    await revenue.aggregate_distributor_day(DAY, {'duty_bps': 2100, 'gateway_bps': 150})
    hh2 = await client['t'].distributor_days.find_one({'day': DAY, 'distributor_id': house['id']})
    exp = 300 - 100 - revenue.apply_bps(300, 150) - revenue.apply_bps(300, 2100)
    T("duty and gateway come off ngr", hh2['ngr'] == exp, f"got {hh2['ngr']} expected {exp}")
    T("the rates used are stored on the row",
      hh2['deductions_applied']['duty_bps'] == 2100)

    print(f"\n  {PASS} passed, {FAIL} failed")
    return FAIL
sys.exit(asyncio.run(main()))
