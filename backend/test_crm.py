"""Exercise the attribution rules against a real (in-memory) Mongo."""
import asyncio, os, sys, types
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mongomock_motor import AsyncMongoMockClient

client = AsyncMongoMockClient()
sys.modules['db'] = types.SimpleNamespace(db=client['test'], serialize_doc=lambda d: d)
import crm

PASS = FAIL = 0
def T(name, cond):
    global PASS, FAIL
    print(("  PASS  " if cond else "  FAIL  ") + name)
    if cond: PASS += 1
    else: FAIL += 1

async def main():
    # --- code folding: confusables must collapse, both ways ---
    T("O folds to 0",            crm.normalise_code('abcO') == 'ABC0')
    T("I and L fold to 1",       crm.normalise_code('aIbL') == 'A1B1')
    T("spaces and dashes go",    crm.normalise_code(' ab-c1 ') == 'ABC1')
    T("too short is refused",    crm.normalise_code('ab') is None)
    T("symbols are refused",     crm.normalise_code('ab*c') is None)
    T("HOUSE is reserved",       not crm.code_is_available('ADMIN'))

    # --- house account ---
    h1 = await crm.ensure_house_account()
    h2 = await crm.ensure_house_account()
    T("house is created once",   h1['id'] == h2['id'])
    T("house earns nothing",     await crm.rate_on(h1['id'], crm.now_iso()) == 0)

    # --- distributors ---
    d = await crm.create_distributor('Northern Agents', 'nrth1', 2550, 'admin1')
    T("rate stored as bps",      await crm.rate_on(d['id'], crm.now_iso()) == 2550)
    dup = None
    try: await crm.create_distributor('Copycat', 'NRTH1', 1000, 'admin1')
    except ValueError as e: dup = str(e)
    T("duplicate code refused",  dup is not None)
    conf = None
    try: await crm.create_distributor('Confusable', 'NRTHI', 1000, 'admin1')
    except ValueError as e: conf = str(e)
    T("confusable dup refused",  conf is not None)   # NRTHI folds to NRTH1

    # --- rate history is a history ---
    t0 = crm.now_iso()
    await asyncio.sleep(0.01)
    await crm.set_rate(d['id'], 3000, 'admin1')
    T("new rate applies now",    await crm.rate_on(d['id'], crm.now_iso()) == 3000)
    T("old rate still answers for the past", await crm.rate_on(d['id'], t0) == 2550)

    # --- attribution ---
    for uid in ('u-known', 'u-none', 'u-bad'):
        await client['test'].users.insert_one({'id': uid, 'role': 'PLAYER'})
    a = await crm.attribute_user('u-known', 'NRTH1')
    T("known code attributes",   a['distributor_id'] == d['id'] and a['source'] == 'CODE')
    b = await crm.attribute_user('u-none', None)
    T("no code goes to house",   b['distributor_id'] == h1['id'] and b['source'] == 'NO_CODE')
    c = await crm.attribute_user('u-bad', 'ZZZZ9')
    T("unknown code -> house, not an error",
                                 c['distributor_id'] == h1['id'] and c['source'] == 'UNKNOWN_CODE')
    T("typed code is kept for the admin", c['typed_code'] == 'ZZZZ9')

    # --- reassignment is audited and not retroactive ---
    d2 = await crm.create_distributor('Southern', 'sth22', 2000, 'admin1')
    await crm.reassign_user('u-known', d2['id'], 'admin1', note='agreed transfer')
    rows = await client['test'].player_attribution.find({'user_id': 'u-known'}).to_list(10)
    active = [r for r in rows if r.get('active')]
    closed = [r for r in rows if not r.get('active')]
    T("old attribution closed, not edited", len(closed) == 1 and closed[0]['distributor_id'] == d['id'])
    T("one active attribution",  len(active) == 1 and active[0]['distributor_id'] == d2['id'])
    T("the move is audited",     active[0]['source'] == 'ADMIN_MOVE' and active[0]['attributed_by'] == 'admin1')
    u = await client['test'].users.find_one({'id': 'u-known'})
    T("user row follows",        u['distributor_id'] == d2['id'] and u['distributor_code'] == 'STH22')

    # attributing a user that does not exist must not pass silently
    missing = None
    try: await crm.attribute_user('ghost', 'NRTH1')
    except ValueError as e: missing = str(e)
    T("unknown user is refused, not ignored", missing is not None)

    print(f"\n  {PASS} passed, {FAIL} failed")
    return FAIL

sys.exit(asyncio.run(main()))
