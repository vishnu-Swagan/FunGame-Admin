"""The partner portal's two dangerous properties: scoping, and separation.

Every route in the portal takes its distributor from the signed-in user, so the
test that matters is not "does the dashboard add up" — it is "can a partner
reach a number that is not theirs", and "can a partner reach the wallet".
"""
import asyncio, os, sys, types
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mongomock_motor import AsyncMongoMockClient

client = AsyncMongoMockClient()
sys.modules['db'] = types.SimpleNamespace(db=client['test'], serialize_doc=lambda d: d)
import crm
import auth_utils
import routes_distributor as portal
from fastapi import HTTPException

db = client['test']

PASS = FAIL = 0
def T(name, cond):
    global PASS, FAIL
    print(("  PASS  " if cond else "  FAIL  ") + name)
    if cond: PASS += 1
    else: FAIL += 1


async def raises(coro, contains=None):
    try:
        await coro
        return False
    except HTTPException as e:
        detail = e.detail if isinstance(e.detail, str) else str(e.detail)
        return contains is None or contains.lower() in detail.lower()
    except ValueError as e:
        return contains is None or contains.lower() in str(e).lower()


async def seed_day(day, distributor_id, code, user_id, turnover, ggr, ngr):
    await db.player_days.insert_one({
        'day': day, 'user_id': user_id, 'distributor_id': distributor_id,
        'distributor_code': code, 'turnover': turnover, 'payout': turnover - ggr,
        'ggr': ggr, 'bonus': 0, 'bets': 3, 'refund': 0, 'stake': turnover})
    await db.distributor_days.insert_one({
        'day': day, 'distributor_id': distributor_id, 'distributor_code': code,
        'players': 1, 'bets': 3, 'turnover': turnover, 'payout': turnover - ggr,
        'ggr': ggr, 'bonus_cost': 0, 'gateway_fee': 0, 'duty': 0,
        'platform_fee': 0, 'ngr': ngr})


async def main():
    await crm.ensure_house_account()
    north = await crm.create_distributor('Northern Agents', 'NRTH1', 2500, 'admin')
    south = await crm.create_distributor('Southern Agents', 'STH22', 3000, 'admin')

    # --- provisioning ---------------------------------------------------
    user = await crm.attach_login(north['id'], 'north@example.com', 'hashed', 'admin')
    T("login id is the referral code",  user['username'] == 'NRTH1')
    T("role is DISTRIBUTOR",            user['role'] == 'DISTRIBUTOR')
    T("no wallet on the account",       user.get('chip_balance') == 0)
    T("no email round trip needed",     user['email_verified'] is True)

    house = await db.distributors.find_one({'code': 'HOUSE'})
    T("house gets no portal login",
      await raises(crm.attach_login(house['id'], 'h@x.com', 'h', 'admin'), 'house'))
    T("an email cannot be shared",
      await raises(crm.attach_login(south['id'], 'north@example.com', 'h', 'admin'), 'already belongs'))

    # A reset must not leave the old session alive.
    before = await db.users.find_one({'id': user['id']})
    await db.users.update_one({'id': user['id']}, {'$set': {'active_session_id': 'live-session'}})
    await crm.attach_login(north['id'], 'north@example.com', 'newhash', 'admin')
    after = await db.users.find_one({'id': user['id']})
    T("reset revokes the old session",  after['active_session_id'].startswith('revoked-'))
    T("reset changes the password",     after['password_hash'] == 'newhash')
    T("reset reuses the same account",  after['id'] == before['id'])

    # --- separation from the player app ---------------------------------
    T("a partner cannot reach the games",
      await raises(auth_utils.require_active_player(after), 'cannot play'))
    T("a partner is not an admin",
      await raises(auth_utils.require_admin(after), 'admin'))

    # --- the dependency, which is where scoping actually lives ------------
    ctx = await auth_utils.require_distributor(after)
    T("resolves to the right distributor", ctx['distributor']['id'] == north['id'])

    await db.distributors.update_one({'id': north['id']}, {'$set': {'status': 'SUSPENDED'}})
    T("suspension closes the portal now",
      await raises(auth_utils.require_distributor(after), 'suspended'))
    await db.distributors.update_one({'id': north['id']}, {'$set': {'status': 'ACTIVE'}})

    stranger = {'id': 'nobody', 'role': 'DISTRIBUTOR'}
    T("an unlinked login is refused",
      await raises(auth_utils.require_distributor(stranger), 'not linked'))
    T("a player cannot use the portal",
      await raises(auth_utils.require_distributor({'id': 'p1', 'role': 'PLAYER'}), 'portal'))

    # --- scoping, with two distributors trading on the same day ----------
    today = portal._day()
    yday = portal._day(-1)
    await seed_day(today, north['id'], 'NRTH1', 'p-north', 10_000, 4_000, 4_000)
    await seed_day(yday, north['id'], 'NRTH1', 'p-north', 6_000, 1_000, 1_000)
    await seed_day(today, south['id'], 'STH22', 'p-south', 99_000, 50_000, 50_000)

    ctx = await auth_utils.require_distributor(after)
    s = await portal.summary(ctx)
    T("today is this partner's only",   s['today']['turnover'] == 10_000)
    T("yesterday is separate",          s['yesterday']['turnover'] == 6_000)
    T("the month adds its own days",    s['month']['turnover'] == 16_000)
    T("today is flagged provisional",   s['today']['provisional'] is True)
    T("the rate comes from the ledger", s['rate_bps'] == 2500)

    # A player active on both days is one player, not two.
    T("players are counted once",       s['month']['players'] == 1)

    d = await portal.daily(frm=yday, to=today, ctx=ctx)
    T("a range returns both days",      len(d['days']) == 2)
    T("a reversed range is corrected",
      (await portal.daily(frm=today, to=yday, ctx=ctx))['totals']['turnover'] == 16_000)
    T("a bad date is refused",
      await raises(portal.daily(frm='last-tuesday', to=today, ctx=ctx), 'YYYY-MM-DD'))

    # --- statements and payouts ------------------------------------------
    await db.commission_ledger.insert_many([
        {'id': 'c1', 'distributor_id': north['id'], 'period_start': yday, 'period_end': yday,
         'ngr': 1_000, 'carry_in': 0, 'basis': 1_000, 'rate_bps': 2500, 'rate_source': 'IN_FORCE',
         'commission': 250, 'carry_out': 0, 'status': 'ACCRUED', 'computed_at': yday},
        {'id': 'c2', 'distributor_id': south['id'], 'period_start': yday, 'period_end': yday,
         'ngr': 50_000, 'carry_in': 0, 'basis': 50_000, 'rate_bps': 3000, 'rate_source': 'IN_FORCE',
         'commission': 15_000, 'carry_out': 0, 'status': 'ACCRUED', 'computed_at': yday},
    ])
    st = await portal.statements(ctx)
    T("statements are scoped",          len(st['entries']) == 1 and st['entries'][0]['id'] == 'c1')
    T("accrued excludes other partners", st['accrued'] == 250)

    await db.payouts.insert_many([
        {'id': 'po1', 'distributor_id': north['id'], 'amount': 250, 'status': 'PAID',
         'created_at': yday, 'paid_by': 'admin-1', 'created_by': 'cron', 'payment_ref': 'BACS-1'},
        {'id': 'po2', 'distributor_id': south['id'], 'amount': 15_000, 'status': 'PAID',
         'created_at': yday, 'paid_by': 'admin-1', 'created_by': 'cron', 'payment_ref': 'BACS-2'},
    ])
    p = await portal.my_payouts(ctx)
    T("payouts are scoped",             len(p['payouts']) == 1)
    T("paid total is this partner's",   p['paid_total'] == 250)
    T("operator staff ids are withheld", 'paid_by' not in p['payouts'][0])
    T("the payment reference is shown", p['payouts'][0]['payment_ref'] == 'BACS-1')

    # --- player privacy ---------------------------------------------------
    await db.users.insert_one({
        'id': 'p-north', 'username': 'GK1234567', 'role': 'PLAYER', 'status': 'ACTIVE',
        'distributor_id': north['id'], 'email': 'player@example.com', 'phone': '07700900000',
        'date_of_birth': '1990-01-01', 'chip_balance': 4_500, 'created_at': yday})
    await db.users.insert_one({
        'id': 'p-south', 'username': 'GK7654321', 'role': 'PLAYER', 'status': 'ACTIVE',
        'distributor_id': south['id'], 'email': 'other@example.com', 'created_at': yday})

    pl = await portal.my_players(ctx)
    row = pl['players'][0]
    T("only this partner's players",    pl['count'] == 1 and row['login_id'] == 'GK1234567')
    T("no email is exposed",            'email' not in row)
    T("no phone or DOB is exposed",     'phone' not in row and 'date_of_birth' not in row)
    T("no chip balance is exposed",     'chip_balance' not in row)
    # Month-to-date, so yesterday counts unless the run straddles a month end.
    expect = 16_000 if yday >= portal._month_start(today) else 10_000
    T("turnover is attributed",         row['month_turnover'] == expect)

    # --- exports ----------------------------------------------------------
    csv_daily = await portal.export_daily(frm=yday, to=today, ctx=ctx)
    body = csv_daily.body.decode()
    T("the export downloads",           'attachment' in csv_daily.headers['content-disposition'])
    T("the export is named by code",    'NRTH1' in csv_daily.headers['content-disposition'])
    T("the export has a header row",    body.splitlines()[0].startswith('Gaming day'))
    T("the export has both days",       len(body.strip().splitlines()) == 3)
    T("the export carries no other partner", '99000' not in body)

    csv_st = await portal.export_statements(ctx)
    st_body = csv_st.body.decode()
    T("statement export is scoped",     len(st_body.strip().splitlines()) == 2)
    T("the rate exports as a percent",  ',25,' in st_body)

    print(f"\n  {PASS} passed, {FAIL} failed")
    return 1 if FAIL else 0


sys.exit(asyncio.run(main()))
