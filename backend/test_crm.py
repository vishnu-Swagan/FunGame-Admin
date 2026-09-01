"""Exercise the attribution rules against a real (in-memory) Mongo."""
import asyncio, os, sys, types
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mongomock_motor import AsyncMongoMockClient
from pymongo.errors import DuplicateKeyError

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
    # Pre-index rows model identities created by the production system before
    # the shared reservation namespace was introduced.
    await client['test'].distributors.insert_one({
        'id': 'legacy-distributor', 'code': 'LGC01', 'is_house': False,
        'login_username': 'Legacy.Partner',
        'login_username_key': 'legacy.partner',
        'user_id': 'legacy-distributor-user', 'status': 'ACTIVE',
    })
    await client['test'].users.insert_one({
        'id': 'legacy-distributor-user', 'role': 'DISTRIBUTOR',
        # Deliberately differs from the CRM display field. Backfill must adopt
        # it under the linked distributor owner, never silently skip it.
        'username': 'MNOO', 'username_key': 'mnoo',
    })
    await client['test'].users.insert_one({
        'id': 'legacy-player', 'role': 'PLAYER',
        'username': 'USRO', 'username_key': 'usro',
    })
    await crm.ensure_indexes()
    T("legacy distributor code is backfilled", bool(
        await client['test'].login_id_reservations.find_one({
            'key': 'lgc01', 'owner_id': 'legacy-distributor',
        })
    ))
    T("legacy independent Login ID is backfilled", bool(
        await client['test'].login_id_reservations.find_one({
            'key': 'legacy.partner', 'owner_id': 'legacy-distributor',
        })
    ))
    T("legacy player confusable alias is backfilled", bool(
        await client['test'].login_id_reservations.find_one({
            'key': 'usr0', 'owner_id': 'legacy-player',
        })
    ))
    T("mismatched linked partner alias is backfilled", bool(
        await client['test'].login_id_reservations.find_one({
            'key': 'mn00', 'owner_type': 'DISTRIBUTOR',
            'owner_id': 'legacy-distributor',
        })
    ))
    await crm.ensure_login_id_reservation_coverage()
    T("legacy reservation backfill is idempotent",
      await crm.portal_identity_ready())
    # --- code folding: confusables must collapse, both ways ---
    T("O folds to 0",            crm.normalise_code('abcO') == 'ABC0')
    T("I and L fold to 1",       crm.normalise_code('aIbL') == 'A1B1')
    T("spaces and dashes go",    crm.normalise_code(' ab-c1 ') == 'ABC1')
    T("too short is refused",    crm.normalise_code('ab') is None)
    T("symbols are refused",     crm.normalise_code('ab*c') is None)
    T("reserved codes are refused", not crm.code_is_available('ADMIN'))
    T("reserved confusable aliases are refused",
      not crm.code_is_available('ADM1N') and not crm.code_is_available('H0USE'))

    # --- house account ---
    h1 = await crm.ensure_house_account()
    h2 = await crm.ensure_house_account()
    T("house is created once",   h1['id'] == h2['id'])
    T("house earns nothing",     await crm.rate_on(h1['id'], crm.now_iso()) == 0)

    # --- distributors ---
    d = await crm.create_distributor(
        'Northern Agents', 'nrth1', 2550, 'admin1',
        email='north@example.com', phone='+441234567890', note='Internal note',
        username='north.partner',
    )
    T("rate stored as bps",      await crm.rate_on(d['id'], crm.now_iso()) == 2550)
    T("contact fields are preserved", d['phone'] == '+441234567890' and d['note'] == 'Internal note')
    T("login id is independent", d['login_username'] == 'north.partner' and d['code'] == 'NRTH1')
    reserved = None
    try:
        await crm.create_distributor(
            'Reserved Login', 'rsv22', 1000, 'admin1', username='NORTH.PARTNER')
    except ValueError as e:
        reserved = str(e)
    T("login id reservation is case-insensitive", reserved is not None)
    dup = None
    try: await crm.create_distributor('Copycat', 'NRTH1', 1000, 'admin1')
    except ValueError as e: dup = str(e)
    T("duplicate code refused",  dup is not None)
    conf = None
    try: await crm.create_distributor('Confusable', 'NRTHI', 1000, 'admin1')
    except ValueError as e: conf = str(e)
    T("confusable dup refused",  conf is not None)   # NRTHI folds to NRTH1
    player_alias_blocked = None
    try:
        await crm.reserve_player_login_id('NRTHI', 'alias-player-one')
    except ValueError as e:
        player_alias_blocked = str(e)
    T("referral-code aliases are reserved from players", player_alias_blocked is not None)
    await crm.reserve_player_login_id('ABCO', 'alias-player-two')
    await client['test'].users.insert_one({
        'id': 'alias-player-two', 'role': 'PLAYER',
        'username': 'ABCO', 'username_key': 'abco',
    })
    distributor_alias_blocked = None
    try:
        await crm.create_distributor('Alias Conflict', 'ABC0', 1000, 'admin1')
    except ValueError as e:
        distributor_alias_blocked = str(e)
    T("player aliases are reserved from referral codes", distributor_alias_blocked is not None)

    # --- rate history is a history ---
    t0 = crm.now_iso()
    await asyncio.sleep(0.01)
    await crm.set_rate(d['id'], 3000, 'admin1')
    T("new rate applies now",    await crm.rate_on(d['id'], crm.now_iso()) == 3000)
    T("old rate still answers for the past", await crm.rate_on(d['id'], t0) == 2550)

    # --- additive profile updates never mutate the referral code ----------
    updated = await crm.update_distributor(d['id'], {
        'name': 'Northern Network',
        'phone': '+441111111111',
        'note': 'Updated internal note',
        'username': 'north.network',
    }, 'admin2')
    T("profile update preserves referral code", updated['code'] == 'NRTH1')
    T("profile update preserves contact/note", updated['phone'] == '+441111111111'
      and updated['note'] == 'Updated internal note')
    T("login reservation can be changed", updated['login_username'] == 'north.network')

    # Confusable Login-ID renames share one canonical reservation. Releasing
    # the old display alias must not release the canonical key retained by the
    # replacement.
    alias_dist = await crm.create_distributor(
        'Alias Rename', 'XYZ22', 1000, 'admin1', username='PQRO',
    )
    await crm.update_distributor(
        alias_dist['id'], {'username': 'PQR0'}, 'admin2',
    )
    retained_alias = await client['test'].login_id_reservations.find_one({
        'key': 'pqr0', 'owner_type': 'DISTRIBUTOR', 'owner_id': alias_dist['id'],
    })
    T("confusable rename retains canonical reservation", retained_alias is not None)
    obsolete_alias = await client['test'].login_id_reservations.find_one({
        'key': 'pqro', 'owner_type': 'DISTRIBUTOR', 'owner_id': alias_dist['id'],
    })
    T("confusable rename releases obsolete display alias", obsolete_alias is None)

    await crm.attach_login(
        alias_dist['id'], 'alias.rename@example.com', 'hash-one', 'admin2',
        username='LMNO',
    )
    await crm.attach_login(
        alias_dist['id'], 'alias.rename@example.com', 'hash-two', 'admin2',
        username='LMN0',
    )
    attached_alias = await client['test'].login_id_reservations.find_one({
        'key': 'lmn0', 'owner_type': 'DISTRIBUTOR', 'owner_id': alias_dist['id'],
    })
    attached_obsolete = await client['test'].login_id_reservations.find_one({
        'key': 'lmno', 'owner_type': 'DISTRIBUTOR', 'owner_id': alias_dist['id'],
    })
    T("credential rename retains canonical reservation", attached_alias is not None)
    T("credential rename releases obsolete display alias", attached_obsolete is None)

    # The reservation index itself must be globally unique. A partial index
    # with the expected name is not an acceptable substitute.
    await client['test'].login_id_reservations.drop_index(
        crm.LOGIN_ID_RESERVATION_INDEX,
    )
    await client['test'].login_id_reservations.create_index(
        'key', unique=True,
        partialFilterExpression={'owner_type': {'$type': 'string'}},
        name=crm.LOGIN_ID_RESERVATION_INDEX,
    )
    malformed_ready = await crm.portal_identity_ready()
    T("partial reservation index fails readiness", malformed_ready is False)
    await client['test'].login_id_reservations.drop_index(
        crm.LOGIN_ID_RESERVATION_INDEX,
    )
    await client['test'].login_id_reservations.create_index(
        'key', unique=True, name=crm.LOGIN_ID_RESERVATION_INDEX,
    )
    T("exact reservation index restores readiness", await crm.portal_identity_ready())

    # --- attribution ---
    for uid in ('u-known', 'u-none', 'u-bad'):
        await client['test'].users.insert_one({'id': uid, 'role': 'PLAYER'})
    a = await crm.attribute_user('u-known', 'NRTH1')
    T("known code attributes",   a['distributor_id'] == d['id'] and a['source'] == 'CODE')
    duplicate_active = None
    try:
        await crm.attribute_user('u-known', 'NRTH1')
    except DuplicateKeyError as exc:
        duplicate_active = exc
    T("active attribution is uniquely guarded", duplicate_active is not None)
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
    T("registration attribution readiness is exact",
      await crm.registration_attribution_ready())

    # A legacy cross-namespace conflict must clear the migration marker and
    # hold all new identity mutation fail-closed until the data is repaired.
    await client['test'].distributors.insert_one({
        'id': 'legacy-conflict-distributor', 'code': 'BACK0',
        'is_house': False, 'status': 'ACTIVE',
    })
    await client['test'].users.insert_one({
        'id': 'legacy-conflict-player', 'role': 'PLAYER',
        'username': 'BACKO', 'username_key': 'backo',
    })
    coverage_conflict = None
    try:
        await crm.ensure_login_id_reservation_coverage()
    except crm.CrmConfigurationError as exc:
        coverage_conflict = exc
    T("legacy alias conflict aborts coverage", coverage_conflict is not None)
    T("failed coverage keeps portal identity fail-closed",
      not await crm.portal_identity_ready())
    await client['test'].users.delete_one({'id': 'legacy-conflict-player'})
    await client['test'].distributors.delete_one({'id': 'legacy-conflict-distributor'})
    await client['test'].login_id_reservations.delete_many({
        'owner_id': {'$in': ['legacy-conflict-player', 'legacy-conflict-distributor']},
    })
    await crm.ensure_login_id_reservation_coverage()
    T("coverage recovers after legacy conflict repair",
      await crm.portal_identity_ready())

    await client['test'].users.insert_one({
        'id': 'orphan-distributor-user', 'role': 'DISTRIBUTOR',
        'username': 'ORPHO', 'username_key': 'orpho',
    })
    orphan_conflict = None
    try:
        await crm.ensure_login_id_reservation_coverage()
    except crm.CrmConfigurationError as exc:
        orphan_conflict = exc
    T("orphan partner identity fails coverage closed", orphan_conflict is not None)
    T("orphan partner identity clears readiness", not await crm.portal_identity_ready())
    await client['test'].users.delete_one({'id': 'orphan-distributor-user'})
    await crm.ensure_login_id_reservation_coverage()
    T("coverage recovers after orphan partner repair",
      await crm.portal_identity_ready())

    print(f"\n  {PASS} passed, {FAIL} failed")
    return FAIL

sys.exit(asyncio.run(main()))
