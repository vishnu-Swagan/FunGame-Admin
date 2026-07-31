"""The four controls, and the asymmetries that make them worth having.

The interesting assertions here are all about direction: tightening lands now,
loosening waits; an exclusion extends but never shortens; enforcement changes
report rather than suspend. A test suite that only checked "a limit blocks a
bet" would pass on an implementation that let a player remove the limit and bet
anyway.
"""
import asyncio, os, sys, types
from datetime import datetime, timedelta, timezone
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mongomock_motor import AsyncMongoMockClient

client = AsyncMongoMockClient()
sys.modules['db'] = types.SimpleNamespace(db=client['test'], serialize_doc=lambda d: d)
import ledger
import compliance as C
from fastapi import HTTPException

db = client['test']
PASS = FAIL = 0


def T(name, cond):
    global PASS, FAIL
    print(("  PASS  " if cond else "  FAIL  ") + name)
    if cond: PASS += 1
    else: FAIL += 1


async def blocked(coro, code=None):
    try:
        await coro
        return False
    except HTTPException as e:
        d = e.detail if isinstance(e.detail, dict) else {'code': str(e.detail)}
        return code is None or d.get('code') == code
    except ValueError:
        return False


async def refused(coro, contains=None):
    try:
        await coro
        return False
    except ValueError as e:
        return contains is None or contains.lower() in str(e).lower()


async def stake(user_id, amount, day=None):
    """A bet as the ledger records one, for the loss window to read back."""
    await db.chip_transactions.insert_one({
        'user_id': user_id, 'kind': ledger.STAKE, 'amount': amount,
        'gaming_day': day or ledger.gaming_day(), 'type': 'DEBIT'})


async def payout(user_id, amount, day=None):
    await db.chip_transactions.insert_one({
        'user_id': user_id, 'kind': ledger.PAYOUT, 'amount': amount,
        'gaming_day': day or ledger.gaming_day(), 'type': 'CREDIT'})


async def deposit(user_id, amount, day=None):
    await db.chip_transactions.insert_one({
        'user_id': user_id, 'kind': ledger.DEPOSIT, 'amount': amount,
        'gaming_day': day or ledger.gaming_day(), 'type': 'CREDIT'})


async def main():
    # --- countries ------------------------------------------------------
    T("a code passes through",        C.normalise_country('gb') == 'GB')
    T("a name resolves",              C.normalise_country('United Kingdom') == 'GB')
    T("punctuation is tolerated",     C.normalise_country(' u.k. ') == 'GB')
    T("an unknown name is not guessed", C.normalise_country('Freedonia') is None)

    off = {**C.DEFAULTS}
    allow = {**C.DEFAULTS, 'market_mode': 'ALLOW', 'markets': ['GB', 'IE']}
    block = {**C.DEFAULTS, 'market_mode': 'BLOCK', 'markets': ['US']}
    T("OFF lets everyone in",         C.market_allows(off, 'US') and C.market_allows(off, C.UNKNOWN))
    T("ALLOW admits the listed",      C.market_allows(allow, 'GB'))
    T("ALLOW refuses the unlisted",   not C.market_allows(allow, 'US'))
    T("ALLOW refuses the unknown",    not C.market_allows(allow, C.UNKNOWN))
    T("BLOCK refuses the listed",     not C.market_allows(block, 'US'))
    T("BLOCK admits the unknown",     C.market_allows(block, C.UNKNOWN))

    # --- age ------------------------------------------------------------
    today = datetime.now(timezone.utc).date()
    just18 = today.replace(year=today.year - 18).isoformat()
    almost = (today.replace(year=today.year - 18) + timedelta(days=1)).isoformat()
    T("18 today is 18",               C.age_on(just18) == 18)
    T("18 tomorrow is 17",            C.age_on(almost) == 17)
    T("a bad date is unknown",        C.age_on('not-a-date') is None)
    T("no date is unknown",           C.age_on(None) is None)

    per_country = {**allow, 'min_age_by_country': {'GB': 21}}
    T("a per-country minimum wins",   C.min_age_for(per_country, 'GB') == 21)
    T("others keep the default",      C.min_age_for(per_country, 'IE') == 18)

    ok, code, _ = await C.check_eligibility('United Kingdom', just18)
    T("eligible passes",              ok)
    ok, code, _ = await C.check_eligibility('United Kingdom', almost)
    T("underage is refused",          not ok and code == 'UNDERAGE')
    ok, code, _ = await C.check_eligibility('United Kingdom', None)
    T("no date of birth is refused",  not ok and code == 'AGE_UNKNOWN')

    await C.set_config({'market_mode': 'ALLOW', 'markets': ['GB']}, 'admin')
    ok, code, _ = await C.check_eligibility('India', just18)
    T("an unlisted market is refused", not ok and code == 'MARKET_BLOCKED')
    ok, _, _ = await C.check_eligibility('gb', just18)
    T("a listed market is admitted",  ok)

    # --- config safety ---------------------------------------------------
    fresh = AsyncMongoMockClient()['fresh']
    T("enforcement ships off",        C.DEFAULTS['market_mode'] == 'OFF'
                                      and C.DEFAULTS['enforce_market_on_login'] is False)
    T("a nonsense mode is refused",   await refused(C.set_config({'market_mode': 'MAYBE'}, 'a'), 'mode'))
    T("an absurd age is refused",     await refused(C.set_config({'min_age': 40}, 'a'), 'between'))
    cfg = await C.set_config({'markets': ['gb', 'United Kingdom', 'ie']}, 'admin')
    T("markets are folded and unique", cfg['markets'] == ['GB', 'IE'])

    # --- a config change reports rather than suspends ---------------------
    await db.users.insert_many([
        {'id': 'u-gb', 'role': 'PLAYER', 'username': 'GK0000001', 'country': 'United Kingdom',
         'date_of_birth': just18, 'status': 'ACTIVE', 'chip_balance': 500},
        {'id': 'u-in', 'role': 'PLAYER', 'username': 'GK0000002', 'country': 'India',
         'date_of_birth': just18, 'status': 'ACTIVE', 'chip_balance': 9_000},
        {'id': 'u-kid', 'role': 'PLAYER', 'username': 'GK0000003', 'country': 'United Kingdom',
         'date_of_birth': almost, 'status': 'ACTIVE', 'chip_balance': 20},
        {'id': 'u-nodob', 'role': 'PLAYER', 'username': 'GK0000004', 'country': 'Freedonia',
         'status': 'ACTIVE', 'chip_balance': 0},
    ])
    report = await C.review_players()
    flagged = {r['user_id']: r['reasons'] for r in report['flagged']}
    T("the report finds the market",  'MARKET' in flagged.get('u-in', []))
    T("the report finds the minor",   'UNDERAGE' in flagged.get('u-kid', []))
    T("the report finds no DOB",      'NO_DOB' in flagged.get('u-nodob', []))
    T("the report finds unknown countries", 'COUNTRY_UNKNOWN' in flagged.get('u-nodob', []))
    T("the eligible are not flagged", 'u-gb' not in flagged)
    T("nobody was suspended by it",
      await db.users.count_documents({'role': 'PLAYER', 'status': 'ACTIVE'}) == 4)

    # An out-of-market player still plays until the operator opts in.
    u_in = await db.users.find_one({'id': 'u-in'})
    T("out of market still plays while enforcement is off",
      await C.assert_playable(u_in) is None)
    await C.set_config({'enforce_market_on_login': True}, 'admin')
    T("opting in closes the market",  await blocked(C.assert_playable(u_in), 'MARKET_BLOCKED'))
    await C.set_config({'enforce_market_on_login': False}, 'admin')

    # The legal floor is not opt-in.
    u_kid = await db.users.find_one({'id': 'u-kid'})
    T("a minor is refused regardless", await blocked(C.assert_playable(u_kid), 'UNDERAGE'))
    u_nodob = await db.users.find_one({'id': 'u-nodob'})
    T("an unknown age is not auto-blocked", await C.assert_playable(u_nodob) is None)

    # --- age verification gate -------------------------------------------
    await C.set_config({'require_age_verification': True}, 'admin')
    u_gb = await db.users.find_one({'id': 'u-gb'})
    T("unverified is held",           await blocked(C.assert_playable(u_gb), 'AGE_NOT_VERIFIED'))
    await db.users.update_one({'id': 'u-gb'}, {'$set': {'age_verified': True}})
    T("verified passes",              await C.assert_playable(await db.users.find_one({'id': 'u-gb'})) is None)
    await C.set_config({'require_age_verification': False}, 'admin')

    # --- limits: down now, up later ---------------------------------------
    r = await C.set_limit('u-gb', C.LOSS, 'DAY', 1_000)
    T("a first limit is immediate",   r['outcome'] == 'IMMEDIATE' and r['limit']['amount'] == 1_000)
    r = await C.set_limit('u-gb', C.LOSS, 'DAY', 400)
    T("lowering is immediate",        r['outcome'] == 'IMMEDIATE' and r['limit']['amount'] == 400)
    r = await C.set_limit('u-gb', C.LOSS, 'DAY', 5_000)
    T("raising waits",                r['outcome'] == 'PENDING')
    live = (await C.limits_for('u-gb', C.LOSS))[0]
    T("the old limit still applies",  live['amount'] == 400)
    T("the queued one is visible",    live['pending_amount'] == 5_000)

    r = await C.set_limit('u-gb', C.LOSS, 'DAY', None)
    T("removing a limit also waits",  r['outcome'] == 'PENDING' and r['limit']['pending_amount'] is None
                                      and r['limit']['amount'] == 400)

    await C.cancel_pending('u-gb', C.LOSS, 'DAY')
    live = (await C.limits_for('u-gb', C.LOSS))[0]
    T("cancelling is immediate",      live['pending_effective_from'] is None and live['amount'] == 400)

    T("an unknown period is refused", await refused(C.set_limit('u-gb', C.LOSS, 'FORTNIGHT', 1), 'period'))
    T("an unknown kind is refused",   await refused(C.set_limit('u-gb', 'VIBES', 'DAY', 1), 'DEPOSIT'))
    T("a negative limit is refused",  await refused(C.set_limit('u-gb', C.LOSS, 'DAY', -5), 'negative'))

    # Time passing promotes the queued increase, with no scheduler involved.
    await C.set_limit('u-gb', C.LOSS, 'DAY', 9_000)
    await db.player_limits.update_one(
        {'user_id': 'u-gb', 'kind': C.LOSS, 'period': 'DAY'},
        {'$set': {'pending_effective_from': (C.now() - timedelta(minutes=1)).isoformat()}})
    live = (await C.limits_for('u-gb', C.LOSS))[0]
    T("the wait elapsing promotes it", live['amount'] == 9_000 and live['pending_amount'] is None)
    stored = await db.player_limits.find_one({'user_id': 'u-gb', 'kind': C.LOSS, 'period': 'DAY'})
    T("promotion is written down",    stored['amount'] == 9_000)

    # --- what a loss actually is ------------------------------------------
    await C.set_limit('u-gb', C.LOSS, 'DAY', 500)
    await stake('u-gb', 300)
    T("staking counts as a loss",     await C.net_loss_in('u-gb', 'DAY') == 300)
    await payout('u-gb', 500)
    T("winnings come back off",       await C.net_loss_in('u-gb', 'DAY') == -200)
    T("a player who is ahead can bet", await C.check_stake('u-gb', 400) is None)
    await stake('u-gb', 900)
    T("the net is what counts",       await C.net_loss_in('u-gb', 'DAY') == 700)

    # Raising 500 to 800 is an increase, so it queues — the bet below is judged
    # against the 500 still in force, which is the whole point of the delay.
    await C.set_limit('u-gb', C.LOSS, 'DAY', 800)
    T("a raise does not unlock the session",
      await blocked(C.check_stake('u-gb', 1), 'LOSS_LIMIT'))

    # A separate player, at 700 lost against a limit of 800, for the boundary.
    await C.set_limit('u-edge', C.LOSS, 'DAY', 800)
    await stake('u-edge', 700)
    T("a bet inside the limit passes", await C.check_stake('u-edge', 50) is None)
    T("a bet past the limit is refused", await blocked(C.check_stake('u-edge', 500), 'LOSS_LIMIT'))
    T("the whole stake is at risk",   await blocked(C.check_stake('u-edge', 101), 'LOSS_LIMIT'))
    T("exactly reaching it is allowed", await C.check_stake('u-edge', 100) is None)

    # Yesterday's losses are outside a daily window and inside a weekly one.
    yday = ledger.gaming_day(C.now() - timedelta(days=1))
    await stake('u-week', 5_000, day=yday)
    T("yesterday is outside the day", await C.net_loss_in('u-week', 'DAY') == 0)
    T("yesterday is inside the week", await C.net_loss_in('u-week', 'WEEK') == 5_000)
    old = ledger.gaming_day(C.now() - timedelta(days=40))
    await stake('u-week', 90_000, day=old)
    T("forty days ago is outside the month", await C.net_loss_in('u-week', 'MONTH') == 5_000)

    # --- deposits ---------------------------------------------------------
    await C.set_limit('u-gb', C.DEPOSIT, 'WEEK', 1_000)
    await deposit('u-gb', 600)
    T("deposits accumulate",          await C.deposits_in('u-gb', 'WEEK') == 600)
    T("a top-up inside the limit passes", await C.check_deposit('u-gb', 400) is None)
    T("a top-up past it is refused",  await blocked(C.check_deposit('u-gb', 401), 'DEPOSIT_LIMIT'))
    T("a loss limit does not block a deposit", await C.check_deposit('u-nodob', 999_999) is None)

    # --- the stake guard is not optional ----------------------------------
    await db.users.update_one({'id': 'u-gb'}, {'$set': {'chip_balance': 100_000}})
    T("the ledger runs the guard",
      await blocked(ledger.debit_chips('u-gb', 5_000, 'test bet', kind=ledger.STAKE), 'LOSS_LIMIT'))
    before = (await db.users.find_one({'id': 'u-gb'}))['chip_balance']
    await blocked(ledger.debit_chips('u-gb', 5_000, 'test bet', kind=ledger.STAKE))
    after = (await db.users.find_one({'id': 'u-gb'}))['chip_balance']
    T("a refused bet takes nothing",  before == after)
    T("a withdrawal is not a stake",
      await ledger.debit_chips('u-gb', 10, 'not a bet', kind=ledger.WITHDRAWAL) is not None)

    # --- exclusion ---------------------------------------------------------
    doc = await C.exclude('u-ex', C.BREAK, days=7, source='PLAYER')
    T("a break starts",               doc['status'] == 'ACTIVE' and doc['ends_at'] is not None)
    T("it blocks play",               await blocked(C.assert_not_excluded('u-ex'), 'SELF_EXCLUDED'))
    T("it cannot be shortened",       await refused(C.exclude('u-ex', C.BREAK, days=1), 'shortened'))
    T("it can be extended",           (await C.exclude('u-ex', C.BREAK, days=30))['days'] == 30)
    T("the superseded row is kept",
      await db.exclusions.count_documents({'user_id': 'u-ex'}) == 2)
    T("a break cannot be permanent",  await refused(C.exclude('u-ex2', C.BREAK, days=None), 'permanent'))
    T("zero days is refused",         await refused(C.exclude('u-ex3', C.BREAK, days=0), 'at least a day'))

    T("it cannot be ended early",     await refused(C.request_reactivation('u-ex'), 'cannot be ended early'))

    # Expire it by hand and walk the return path.
    row = await db.exclusions.find_one({'user_id': 'u-ex', 'status': 'ACTIVE'})
    await db.exclusions.update_one({'id': row['id']}, {'$set': {
        'ends_at': (C.now() - timedelta(hours=1)).isoformat()}})
    T("an expired exclusion stops blocking", await C.active_exclusion('u-ex') is None)
    r = await C.request_reactivation('u-ex')
    T("coming back is a request",     r['status'] == 'WAITING')
    r = await C.request_reactivation('u-ex')
    T("asking twice does not skip the wait", r['status'] == 'WAITING')
    await db.exclusions.update_one({'id': row['id']}, {'$set': {
        'reactivation_requested_at': (C.now() - timedelta(hours=48)).isoformat()}})
    r = await C.request_reactivation('u-ex')
    T("the wait elapsing reopens it", r['status'] == 'LIFTED')

    # Permanent, and who may end it.
    await C.exclude('u-perm', C.SELF_EXCLUSION, days=None, source='PLAYER')
    T("permanent has no end date",    (await C.active_exclusion('u-perm'))['ends_at'] is None)
    T("permanent blocks play",        await blocked(C.assert_not_excluded('u-perm'), 'SELF_EXCLUDED'))
    T("the player cannot lift it",    await refused(C.request_reactivation('u-perm'), 'operator'))
    T("it cannot be replaced",        await refused(C.exclude('u-perm', C.BREAK, days=1), 'permanently'))
    T("lifting needs a reason",       await refused(C.admin_lift('u-perm', 'admin', ''), 'reason'))
    lifted = await C.admin_lift('u-perm', 'admin-1', 'Identity confirmed, player requested review')
    T("the operator can lift it",     lifted['status'] == 'LIFTED')
    T("the reason is kept",           'Identity confirmed' in lifted['lift_reason'])
    T("play resumes after lifting",   await C.active_exclusion('u-perm') is None)

    # And exclusion beats limits: the guard checks it first.
    await C.exclude('u-gb', C.BREAK, days=1, source='PLAYER')
    T("an excluded player cannot bet at all",
      await blocked(ledger.debit_chips('u-gb', 1, 'tiny bet', kind=ledger.STAKE), 'SELF_EXCLUDED'))

    print(f"\n  {PASS} passed, {FAIL} failed")
    return 1 if FAIL else 0


sys.exit(asyncio.run(main()))
