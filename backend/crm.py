"""Distributors, referral codes and attribution.

The three rules this module exists to enforce, all of which are cheap now and
very expensive to retrofit once there is money and history in the system:

1. **Attribution is decided once, at account creation, and is immutable.**
   A player belongs to whoever introduced them. If a code could be applied
   later, a distributor could claim a player another one acquired, and every
   statement already issued would be wrong. Admin CAN move a player, but that is
   an audited event with its own record and it is not retroactive by default —
   closed periods stay with the distributor who earned them.

2. **A rate is a history, not a number.** Commission for a period must use the
   rate that was in force *during that period*. Storing one percentage on the
   distributor means editing it today silently restates every statement ever
   produced. Rates are effective-dated rows and the engine asks for the rate on
   a date.

3. **There is no such thing as an unattributed player.** "No referral code"
   maps to a real house distributor row, not to null. Null spreads: every
   report, join and total then needs a special case for it, and one of them
   will be forgotten.

Rates are basis points (integer). 25.5% is 2550, never 0.255 — percentages of
money must not be floats.
"""
import logging
import re
import uuid
from datetime import datetime, timezone

from db import db
from pymongo.errors import DuplicateKeyError

HOUSE_CODE = 'HOUSE'
ACTIVE_ATTRIBUTION_INDEX = 'player_attribution_active_user_unique'
ACTIVE_ATTRIBUTION_PARTIAL = {'active': True}
LOGIN_ID_RESERVATION_INDEX = 'login_id_reservation_key_unique'
LOGIN_ID_RESERVATION_COVERAGE_VERSION = 1

# 0/O and 1/I/L are the same character to someone reading a code off a screen or
# hearing it over a phone, and a mistyped code silently pays the wrong person.
_CONFUSABLE = str.maketrans({'O': '0', 'I': '1', 'L': '1'})
_CODE_OK = re.compile(r'^[A-Z0-9]{4,12}$')
_LOGIN_USERNAME_OK = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{3,31}$')
_RESERVED = {'HOUSE', 'ADMIN', 'NULL', 'NONE', 'TEST', 'SYSTEM', 'CHAKRI'}
logger = logging.getLogger('crm')


class CrmConfigurationError(RuntimeError):
    """A fail-closed CRM invariant required before accepting registrations."""


def _session_kwargs(session):
    return {'session': session} if session is not None else {}


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def normalise_code(raw):
    """Fold a typed code to its canonical form, or return None if unusable.

    Folding is deliberately lossy and applied on BOTH sides — when a code is
    created and when one is redeemed — so `abc0` and `ABCO` are the same code
    and cannot be registered as two.
    """
    if not raw:
        return None
    code = str(raw).strip().upper().replace(' ', '').replace('-', '')
    code = code.translate(_CONFUSABLE)
    if not _CODE_OK.match(code):
        return None
    return code


def code_is_available(code):
    raw = str(code or '').strip().upper().replace(' ', '').replace('-', '')
    canonical = raw.translate(_CONFUSABLE)
    reserved_keys = {item.translate(_CONFUSABLE) for item in _RESERVED}
    return canonical not in reserved_keys


def normalise_login_username(raw):
    """Return a display Login ID and its case-insensitive uniqueness key."""
    username = str(raw or '').strip()
    if not _LOGIN_USERNAME_OK.fullmatch(username):
        raise ValueError(
            'Login ID must start with a letter or number and use 4-32 letters, numbers, dots, underscores or hyphens'
        )
    return username, username.casefold()


def login_id_reservation_aliases(username):
    """Case-insensitive and referral-code-confusable reservation keys."""
    display = str(username or '').strip()
    aliases = {display.casefold()}
    canonical_code = normalise_code(display)
    if canonical_code:
        aliases.add(canonical_code.casefold())
    return aliases


async def _assert_login_username_available(username, distributor_id=None, user_id=None,
                                           *, session=None):
    """Reserve partner Login IDs across CRM reservations and existing users."""
    kwargs = _session_kwargs(session)
    username, key = normalise_login_username(username)
    canonical_code = normalise_code(username)
    reserved_keys = {normalise_code(item) for item in _RESERVED}
    if username.upper() in _RESERVED or canonical_code in reserved_keys:
        raise ValueError(f'Login ID {username} is reserved')
    reserved = await db.distributors.find_one({'login_username_key': key}, **kwargs)
    if reserved and reserved.get('id') != distributor_id:
        raise ValueError(f'Login ID {username} is already reserved for another distributor')
    code_clauses = [
        {'code': {'$regex': f'^{re.escape(username)}$', '$options': 'i'}},
    ]
    if canonical_code:
        code_clauses.append({'code': canonical_code})
    code_owner = await db.distributors.find_one({'$or': code_clauses}, **kwargs)
    if code_owner and code_owner.get('id') != distributor_id:
        raise ValueError(f'Login ID {username} conflicts with another distributor referral code')
    taken = await db.users.find_one({'$or': [
        {'username_key': key},
        {'username': {'$regex': f'^{re.escape(username)}$', '$options': 'i'}},
    ]}, **kwargs)
    if taken and taken.get('id') != user_id:
        raise ValueError(f'Login ID {username} is already in use')
    reservation = await db.login_id_reservations.find_one({
        'key': {'$in': sorted(login_id_reservation_aliases(username))},
    }, **kwargs)
    if reservation and not (
        reservation.get('owner_type') == 'DISTRIBUTOR'
        and reservation.get('owner_id') == str(distributor_id or '')
    ):
        raise ValueError(f'Login ID {username} is already reserved')
    return username, key


async def distributor_login_id_is_reserved(username, *, session=None) -> bool:
    """Whether a player Login ID would consume a distributor reservation.

    An explicit independent partner Login ID and every referral code are both
    reservations: a code remains the backward-compatible portal default until
    an independent ID is chosen. Player provisioning consults this helper
    before inserting into ``users`` so it cannot strand an unprovisioned CRM
    record whose Login ID was already promised.
    """
    # Player Login IDs have their own (slightly broader) schema, so do not run
    # the distributor-only 4-32 character validator here.
    username = str(username or '').strip()
    if not username:
        return False
    key = username.casefold()
    canonical_code = normalise_code(username)
    reserved_keys = {normalise_code(item) for item in _RESERVED}
    if username.upper() in _RESERVED or canonical_code in reserved_keys:
        return True
    kwargs = _session_kwargs(session)
    code_queries = [
        {'code': {'$regex': f'^{re.escape(username)}$', '$options': 'i'}},
    ]
    if canonical_code:
        code_queries.append({'code': canonical_code})
    return bool(await db.distributors.find_one({'$or': [
        {'login_username_key': key},
        {'login_username': {'$regex': f'^{re.escape(username)}$', '$options': 'i'}},
        *code_queries,
    ]}, {'_id': 0, 'id': 1}, **kwargs))


async def reserve_login_id(username, owner_type, owner_id, *, session=None):
    """Atomically reserve one cross-collection Login ID.

    The unique reservation key closes the race that separate unique indexes on
    ``users`` and ``distributors`` cannot: a player approval and distributor
    provisioning can no longer both win the same case-insensitive ID.
    """
    display = str(username or '').strip()
    if not display:
        raise ValueError('Login ID cannot be blank')
    key = display.casefold()
    owner_type = str(owner_type or '').strip().upper()
    if owner_type not in {'DISTRIBUTOR', 'USER'} or not owner_id:
        raise ValueError('A valid Login ID reservation owner is required')
    kwargs = _session_kwargs(session)
    doc = {
        'id': str(uuid.uuid4()),
        'key': key,
        'display': display,
        'owner_type': owner_type,
        'owner_id': str(owner_id),
        'created_at': now_iso(),
    }
    existing = await db.login_id_reservations.find_one({'key': key}, **kwargs)
    if existing:
        if (
            existing.get('owner_type') == owner_type
            and existing.get('owner_id') == str(owner_id)
        ):
            return existing
        raise ValueError(f'Login ID {display} is already reserved')
    try:
        await db.login_id_reservations.insert_one(doc, **kwargs)
        return doc
    except DuplicateKeyError:
        # A duplicate-key write aborts a real Mongo transaction immediately;
        # do not issue a recovery read on that dead session. The surrounding
        # route maps the conflict and the client reloads. Outside a transaction
        # (startup/lazy legacy adoption), it is safe to read the winner.
        if session is not None:
            raise
        existing = await db.login_id_reservations.find_one({'key': key}, **kwargs)
        if (
            existing
            and existing.get('owner_type') == owner_type
            and existing.get('owner_id') == str(owner_id)
        ):
            return existing
        raise ValueError(f'Login ID {display} is already reserved')


async def reserve_login_id_aliases(username, owner_type, owner_id, *, session=None):
    """Claim every key that is visually equivalent in the referral namespace."""
    display = str(username or '').strip()
    aliases = login_id_reservation_aliases(display)
    await reserve_login_id(display, owner_type, owner_id, session=session)
    for alias in sorted(aliases - {display.casefold()}):
        await reserve_login_id(alias, owner_type, owner_id, session=session)


async def release_login_id_aliases(username, owner_type, owner_id, *,
                                   retain_usernames=(), session=None):
    retained = set()
    for retained_username in retain_usernames:
        if retained_username:
            retained.update(login_id_reservation_aliases(retained_username))
    for alias in login_id_reservation_aliases(username) - retained:
        await release_login_id(alias, owner_type, owner_id, session=session)


async def assert_player_login_id_available(username, user_id=None, *, session=None):
    """Validate a player Login ID against every current identity namespace."""
    username, key = normalise_login_username(username)
    kwargs = _session_kwargs(session)
    if await distributor_login_id_is_reserved(username, session=session):
        raise ValueError('Login ID is unavailable')
    taken = await db.users.find_one({'$or': [
        {'username_key': key},
        {'username': {'$regex': f'^{re.escape(username)}$', '$options': 'i'}},
    ]}, {'_id': 0, 'id': 1}, **kwargs)
    if taken and taken.get('id') != str(user_id or ''):
        raise ValueError('Login ID is unavailable')
    reservation_keys = login_id_reservation_aliases(username)
    reserved = await db.login_id_reservations.find_one({
        'key': {'$in': sorted(reservation_keys)},
    }, **kwargs)
    if reserved and not (
        reserved.get('owner_type') == 'USER'
        and reserved.get('owner_id') == str(user_id or '')
    ):
        raise ValueError('Login ID is unavailable')
    return username, key


async def reserve_player_login_id(username, user_id, *, session=None):
    """Validate and atomically reserve one user-chosen player Login ID."""
    username, key = await assert_player_login_id_available(
        username, user_id, session=session,
    )
    await reserve_login_id_aliases(username, 'USER', user_id, session=session)
    return username, key


async def ensure_login_id_reservation_coverage() -> None:
    """Adopt every legacy Login ID/referral-code alias before new writes.

    The version marker is written only after all identities have been claimed.
    Existing cross-namespace conflicts therefore keep registration and
    credential mutation fail-closed until an operator resolves the data.
    """
    # Clear a prior marker first. If this pass encounters a conflict, readiness
    # must not continue trusting stale coverage evidence.
    await db.system_config.update_one(
        {'key': 'main'},
        {'$unset': {
            'login_id_reservation_coverage_version': '',
            'login_id_reservation_covered_at': '',
        }},
        upsert=True,
    )

    distributor_user_owners = {}
    async for distributor in db.distributors.find(
        {'is_house': {'$ne': True}},
        {'_id': 0, 'id': 1, 'code': 1, 'login_username': 1, 'user_id': 1},
    ):
        owner_id = distributor.get('id')
        if not owner_id:
            raise CrmConfigurationError('A distributor is missing its identity owner')
        for identity in (distributor.get('code'), distributor.get('login_username')):
            if identity:
                try:
                    await reserve_login_id_aliases(identity, 'DISTRIBUTOR', owner_id)
                except (ValueError, DuplicateKeyError) as exc:
                    raise CrmConfigurationError(
                        f'Legacy distributor Login ID coverage conflicts for {owner_id}'
                    ) from exc
        linked_user_id = distributor.get('user_id')
        if linked_user_id:
            linked_user_id = str(linked_user_id)
            existing_owner = distributor_user_owners.get(linked_user_id)
            if existing_owner and existing_owner != owner_id:
                raise CrmConfigurationError(
                    f'Legacy distributor user {linked_user_id} has multiple owners'
                )
            distributor_user_owners[linked_user_id] = owner_id

    async for user in db.users.find(
        {'username': {'$type': 'string'}},
        {'_id': 0, 'id': 1, 'username': 1, 'role': 1},
    ):
        if not user.get('id') or not str(user.get('username') or '').strip():
            continue
        user_id = str(user['id'])
        owner_type = 'USER'
        owner_id = user_id
        if user.get('role') == 'DISTRIBUTOR':
            owner_id = distributor_user_owners.get(user_id)
            if not owner_id:
                raise CrmConfigurationError(
                    f'Legacy distributor portal user {user_id} has no CRM owner'
                )
            owner_type = 'DISTRIBUTOR'
        try:
            # A mismatched legacy portal username is still adopted under its
            # linked distributor owner, protecting every alias while leaving
            # profile repair to the audited CRM workflow.
            await reserve_login_id_aliases(user['username'], owner_type, owner_id)
        except (ValueError, DuplicateKeyError) as exc:
            raise CrmConfigurationError(
                f'Legacy user Login ID coverage conflicts for {user_id}'
            ) from exc

    await db.system_config.update_one(
        {'key': 'main'},
        {'$set': {
            'login_id_reservation_coverage_version': LOGIN_ID_RESERVATION_COVERAGE_VERSION,
            'login_id_reservation_covered_at': now_iso(),
        }},
        upsert=True,
    )


async def release_login_id(username, owner_type, owner_id, *, session=None):
    display = str(username or '').strip()
    if not display:
        return
    await db.login_id_reservations.delete_one({
        'key': display.casefold(),
        'owner_type': str(owner_type or '').strip().upper(),
        'owner_id': str(owner_id),
    }, **_session_kwargs(session))


# ---------------------------------------------------------------- distributors

async def ensure_house_account(*, session=None):
    """The fallback distributor. Created once, never deleted, never paid.

    Its commission rate is zero: house players earn nobody a commission, and
    making that explicit is safer than leaving the engine to infer it from a
    missing row.
    """
    kwargs = _session_kwargs(session)
    existing = await db.distributors.find_one({'code': HOUSE_CODE}, **kwargs)
    if existing:
        return existing
    doc = {
        'id': str(uuid.uuid4()),
        'code': HOUSE_CODE,
        'name': 'House account',
        'status': 'ACTIVE',
        'is_house': True,
        'email': None,
        'phone': None,
        'login_username': None,
        'login_username_key': None,
        'user_id': None,          # no portal login
        'record_version': 0,
        'credentials_version': 0,
        'created_at': now_iso(),
        'created_by': 'system',
        'note': 'Players who arrived without a referral code.',
    }
    try:
        await db.distributors.insert_one(doc, **kwargs)
    except DuplicateKeyError:
        # Concurrent startup workers can race the unique distributor-code
        # index. A transaction must propagate the error so its caller retries;
        # outside a transaction the winning row is safe to reuse.
        if session is not None:
            raise
        existing = await db.distributors.find_one({'code': HOUSE_CODE})
        if existing:
            return existing
        raise
    await set_rate(
        doc['id'], 0, 'system', note='House account earns no commission',
        session=session,
    )
    return doc


async def create_distributor(name, code, rate_bps, created_by, email=None,
                             phone=None, note=None, username=None, *, session=None):
    kwargs = _session_kwargs(session)
    code = normalise_code(code)
    if not code:
        raise ValueError('Code must be 4-12 letters or digits')
    if not code_is_available(code):
        raise ValueError(f'"{code}" is reserved')
    if await db.distributors.find_one({'code': code}, **kwargs):
        raise ValueError(f'Code "{code}" is already in use')
    if await db.distributors.find_one({'login_username_key': code.casefold()}, **kwargs):
        raise ValueError(f'Code "{code}" conflicts with a reserved distributor Login ID')
    rate_bps = int(rate_bps)
    if not 0 <= rate_bps <= 10000:
        raise ValueError('Commission must be between 0 and 100 percent')
    distributor_id = str(uuid.uuid4())
    # Referral codes and Login IDs share one confusable namespace. This check
    # also prevents a new partner code from consuming an existing player ID.
    await _assert_login_username_available(
        code, distributor_id=distributor_id, session=session,
    )
    login_username = login_username_key = None
    if username:
        login_username, login_username_key = await _assert_login_username_available(
            username, session=session,
        )
    await reserve_login_id_aliases(
        code, 'DISTRIBUTOR', distributor_id, session=session,
    )
    if login_username and login_username_key != code.casefold():
        await reserve_login_id_aliases(
            login_username, 'DISTRIBUTOR', distributor_id, session=session,
        )
    doc = {
        'id': distributor_id,
        'code': code,
        'name': name.strip(),
        'status': 'ACTIVE',
        'is_house': False,
        'email': (email or '').strip().lower() or None,
        'phone': (phone or '').strip() or None,
        'login_username': login_username,
        'login_username_key': login_username_key,
        'user_id': None,
        'record_version': 0,
        'credentials_version': 0,
        'created_at': now_iso(),
        'created_by': created_by,
        'note': note,
    }
    await db.distributors.insert_one(doc, **kwargs)
    await set_rate(
        doc['id'], rate_bps, created_by, note='Opening rate', session=session,
    )
    return doc


async def update_distributor(distributor_id, updates, actor, *, expected_version=None,
                             session=None):
    """Update mutable CRM profile fields without touching code or attribution.

    Contact and Login ID changes are mirrored to an existing portal account.
    Any authentication-identity change revokes its current session immediately.
    Missing fields on legacy rows remain valid; this function only writes keys
    explicitly supplied by the administrator.
    """
    kwargs = _session_kwargs(session)
    dist = await db.distributors.find_one({'id': distributor_id}, **kwargs)
    if not dist:
        raise ValueError('Unknown distributor')
    if dist.get('is_house'):
        raise ValueError('The house account profile cannot be edited')
    linked_user = None
    if dist.get('user_id'):
        linked_user = await db.users.find_one({'id': dist['user_id']}, **kwargs)
        if not linked_user or linked_user.get('role') != 'DISTRIBUTOR':
            raise ValueError('Distributor portal linkage is invalid; no profile was changed')

    allowed = {'name', 'email', 'phone', 'note', 'username'}
    unknown = set(updates) - allowed
    if unknown:
        raise ValueError(f'Unsupported distributor fields: {", ".join(sorted(unknown))}')
    patch = {}
    user_patch = {}
    revoke_session = False

    if 'name' in updates:
        name = str(updates.get('name') or '').strip()
        if len(name) < 2:
            raise ValueError('Distributor name must contain at least 2 characters')
        patch['name'] = name
        user_patch.update({'full_name': name, 'display_name': f"{name} ({dist['code']})"})

    if 'email' in updates:
        email = str(updates.get('email') or '').strip().lower() or None
        if email and '@' not in email:
            raise ValueError('A valid email is required')
        if dist.get('user_id') and not email:
            raise ValueError('A distributor with a portal login must keep a login email')
        if email and dist.get('user_id'):
            clash = await db.users.find_one({'$or': [
                {'email': email}, {'email_normalized': email},
            ]}, **kwargs)
            if clash and clash.get('id') != dist.get('user_id'):
                raise ValueError('That email already belongs to another account')
        patch['email'] = email
        if dist.get('user_id'):
            user_patch.update({'email': email, 'email_normalized': email})
            revoke_session = True

    if 'phone' in updates:
        patch['phone'] = str(updates.get('phone') or '').strip() or None
    if 'note' in updates:
        patch['note'] = str(updates.get('note') or '').strip() or None

    if 'username' in updates:
        raw_username = updates.get('username')
        if not raw_username:
            raise ValueError('Login ID cannot be blank; supply a replacement Login ID')
        username, key = await _assert_login_username_available(
            raw_username, distributor_id=distributor_id, user_id=dist.get('user_id'),
            session=session,
        )
        await reserve_login_id_aliases(
            username, 'DISTRIBUTOR', distributor_id, session=session,
        )
        patch.update({'login_username': username, 'login_username_key': key})
        if dist.get('user_id'):
            user_patch['username'] = username
            user_patch['username_key'] = key
            revoke_session = True

    if not patch:
        raise ValueError('Nothing to update')
    patch.update({'updated_at': now_iso(), 'updated_by': actor})
    if expected_version is None:
        expected_version = int(dist.get('record_version') or 0)
    else:
        expected_version = int(expected_version)
    version_query = {'id': distributor_id}
    if expected_version == 0:
        # Legacy rows have no version field; the first guarded write upgrades
        # them additively to version 1.
        version_query['$or'] = [
            {'record_version': 0},
            {'record_version': None},
            {'record_version': {'$exists': False}},
        ]
    else:
        version_query['record_version'] = expected_version
    result = await db.distributors.update_one(
        version_query,
        {'$set': patch, '$inc': {'record_version': 1}},
        **kwargs,
    )
    if result.matched_count != 1:
        raise ValueError('Distributor changed in another administrator session; reload and retry')
    if dist.get('user_id') and user_patch:
        if revoke_session:
            user_patch['active_session_id'] = f'revoked-{uuid.uuid4()}'
        user_patch['updated_at'] = now_iso()
        user_result = await db.users.update_one(
            {'id': dist['user_id'], 'role': 'DISTRIBUTOR'},
            {'$set': user_patch}, **kwargs,
        )
        if user_result.matched_count != 1:
            raise ValueError('Distributor portal linkage changed; reload and retry')
    old_username = dist.get('login_username')
    if (
        'username' in updates
        and old_username
        and old_username.casefold() != str(patch.get('login_username') or '').casefold()
        and old_username.casefold() != str(dist.get('code') or '').casefold()
    ):
        await release_login_id_aliases(
            old_username, 'DISTRIBUTOR', distributor_id,
            retain_usernames=(patch.get('login_username'), dist.get('code')),
            session=session,
        )
    return await db.distributors.find_one(
        {'id': distributor_id}, {'_id': 0}, **kwargs,
    )


async def set_distributor_status(distributor_id, status, actor, *, expected_version=None,
                                 session=None):
    """Change partner availability and revoke any live portal session."""
    kwargs = _session_kwargs(session)
    status = str(status or '').upper()
    if status not in {'ACTIVE', 'DISABLED', 'SUSPENDED', 'TERMINATED'}:
        raise ValueError('Unknown distributor status')
    dist = await db.distributors.find_one({'id': distributor_id}, **kwargs)
    if not dist:
        raise ValueError('Unknown distributor')
    if dist.get('is_house'):
        raise ValueError('The house account cannot be disabled')
    if dist.get('user_id'):
        linked_user = await db.users.find_one({'id': dist['user_id']}, **kwargs)
        if not linked_user or linked_user.get('role') != 'DISTRIBUTOR':
            raise ValueError('Distributor portal linkage is invalid; status was not changed')
    changed_at = now_iso()
    if expected_version is None:
        expected_version = int(dist.get('record_version') or 0)
    else:
        expected_version = int(expected_version)
    version_query = {'id': distributor_id}
    if expected_version == 0:
        version_query['$or'] = [
            {'record_version': 0},
            {'record_version': None},
            {'record_version': {'$exists': False}},
        ]
    else:
        version_query['record_version'] = expected_version
    result = await db.distributors.update_one(
        version_query,
        {'$set': {
            'status': status,
            'status_changed_at': changed_at,
            'status_changed_by': actor,
            'updated_at': changed_at,
            'updated_by': actor,
        }, '$inc': {'record_version': 1}},
        **kwargs,
    )
    if result.matched_count != 1:
        raise ValueError('Distributor changed in another administrator session; reload and retry')
    if dist.get('user_id'):
        common = {
            'active_session_id': f'revoked-{uuid.uuid4()}',
            'updated_at': changed_at,
        }
        if status == 'ACTIVE':
            # Only undo a disablement caused by this distributor status flow;
            # never revive a login independently disabled after compromise.
            await db.users.update_one(
                {'id': dist['user_id'], 'role': 'DISTRIBUTOR',
                 'disabled_by_distributor_status': {'$exists': True}},
                {'$set': {**common, 'status': 'ACTIVE'},
                 '$unset': {'disabled_by_distributor_status': ''}},
                **kwargs,
            )
            await db.users.update_one(
                {'id': dist['user_id'], 'role': 'DISTRIBUTOR',
                 'disabled_by_distributor_status': {'$exists': False}},
                {'$set': common}, **kwargs,
            )
        else:
            await db.users.update_one(
                {'id': dist['user_id'], 'role': 'DISTRIBUTOR'},
                {'$set': {
                    **common,
                    'status': 'DISABLED',
                    'disabled_by_distributor_status': status,
                }}, **kwargs,
            )
    return await db.distributors.find_one(
        {'id': distributor_id}, {'_id': 0}, **kwargs,
    )


async def set_rate(distributor_id, rate_bps, set_by, effective_from=None, note=None,
                   *, session=None):
    """Open a new rate period and close the one before it.

    Closing the previous row rather than overwriting it is the whole point: a
    statement produced last quarter has to keep reproducing the number it
    printed, whatever the rate is today.
    """
    rate_bps = int(rate_bps)
    if not 0 <= rate_bps <= 10000:
        raise ValueError('Commission must be between 0 and 100 percent')
    start = effective_from or now_iso()
    kwargs = _session_kwargs(session)
    await db.distributor_rates.update_many(
        {'distributor_id': distributor_id, 'effective_to': None},
        {'$set': {'effective_to': start}},
        **kwargs,
    )
    row = {
        'id': str(uuid.uuid4()),
        'distributor_id': distributor_id,
        'rate_bps': rate_bps,
        'effective_from': start,
        'effective_to': None,
        'set_by': set_by,
        'set_at': now_iso(),
        'note': note,
    }
    await db.distributor_rates.insert_one(row, **kwargs)
    return row


async def rate_on(distributor_id, when_iso):
    """The rate in force at an instant — what a commission run must ask for."""
    bps, _ = await rate_on_detailed(distributor_id, when_iso)
    return bps


async def rate_on_detailed(distributor_id, when_iso):
    """The rate, and WHERE it came from.

    Returning a bare 0 when no rate was in force is the dangerous answer: a
    mistyped effective date, or a period predating the distributor, would
    silently pay them nothing and nobody would find out until they queried a
    statement. A miss falls back to their earliest known rate and says so, and
    the caller writes that provenance onto the row where an auditor sees it.
    """
    row = await db.distributor_rates.find_one({
        'distributor_id': distributor_id,
        'effective_from': {'$lte': when_iso},
        '$or': [{'effective_to': None}, {'effective_to': {'$gt': when_iso}}],
    }, sort=[('effective_from', -1)])
    if row:
        return int(row['rate_bps']), 'IN_FORCE'
    earliest = await db.distributor_rates.find_one(
        {'distributor_id': distributor_id}, sort=[('effective_from', 1)])
    if earliest:
        return int(earliest['rate_bps']), 'EARLIEST_FALLBACK'
    return 0, 'NO_RATE'


# ----------------------------------------------------------------- attribution

async def resolve_code(raw, *, session=None):
    """A typed code to the distributor that owns it, or the house account.

    An unknown code is NOT an error at signup. Rejecting the registration
    because someone mistyped a friend's code loses the player; the account is
    created against the house and the code they typed is kept on the request so
    an admin can correct the attribution deliberately.
    """
    code = normalise_code(raw)
    if code:
        dist = await db.distributors.find_one(
            {'code': code, 'status': 'ACTIVE'}, **_session_kwargs(session),
        )
        if dist:
            return dist, code, 'CODE'
    house = await ensure_house_account(session=session)
    return house, code, ('UNKNOWN_CODE' if raw else 'NO_CODE')


async def attribute_user(user_id, raw_code, actor='system', *, session=None):
    """Bind a player to a distributor. Called once, when the account is created.

    Returns the attribution document so the caller can store the ids on the user
    row for cheap querying, while the audit trail lives here.
    """
    kwargs = _session_kwargs(session)
    dist, code, source = await resolve_code(raw_code, session=session)
    doc = {
        'id': str(uuid.uuid4()),
        'user_id': user_id,
        'distributor_id': dist['id'],
        'distributor_code': dist['code'],
        'typed_code': code,
        'source': source,          # CODE | NO_CODE | UNKNOWN_CODE | ADMIN_MOVE
        'attributed_at': now_iso(),
        'attributed_by': actor,
        'active': True,
    }
    await db.player_attribution.insert_one(doc, **kwargs)
    res = await db.users.update_one({'id': user_id}, {'$set': {
        'distributor_id': dist['id'],
        'distributor_code': dist['code'],
        'referral_code_typed': code,
    }}, **kwargs)
    # If the user row is not there, the attribution row exists but nothing on the
    # player points at a distributor — and every report that filters by
    # distributor_id silently drops that player. Better to fail here, where the
    # cause is one line away, than to find it in a statement three months on.
    if res.matched_count == 0:
        raise ValueError(f'Cannot attribute unknown user {user_id} — create the account first')
    return doc


async def reassign_user(user_id, new_distributor_id, actor, note=None):
    """Move a player, audibly, and only from now on.

    The old attribution row is closed rather than edited, so history keeps
    pointing at whoever held the player when the revenue was earned. Periods
    already settled are not restated — that would take money back off a
    distributor who has been paid.
    """
    dist = await db.distributors.find_one({'id': new_distributor_id})
    if not dist:
        raise ValueError('Unknown distributor')
    await db.player_attribution.update_many(
        {'user_id': user_id, 'active': True},
        {'$set': {'active': False, 'closed_at': now_iso(), 'closed_by': actor}},
    )
    doc = {
        'id': str(uuid.uuid4()),
        'user_id': user_id,
        'distributor_id': dist['id'],
        'distributor_code': dist['code'],
        'typed_code': None,
        'source': 'ADMIN_MOVE',
        'attributed_at': now_iso(),
        'attributed_by': actor,
        'active': True,
        'note': note,
    }
    await db.player_attribution.insert_one(doc)
    await db.users.update_one({'id': user_id}, {'$set': {
        'distributor_id': dist['id'], 'distributor_code': dist['code'],
    }})
    return doc


async def attach_login(distributor_id, email, password_hash, actor, username=None,
                       must_change_password=False, *, session=None):
    """Give a distributor a portal login, or reset the one they have.

    The login is an ordinary user row with role DISTRIBUTOR, so the portal
    inherits the session handling, the single-active-session rule and the
    password reset flow the player app already has, rather than growing a second
    authentication path that will be patched half as often.

    What it must NOT inherit is a wallet. The row carries no chip balance and
    `require_active_player` refuses the role outright: commission is the
    operator's money owed to a partner, chips are the player's, and an account
    that could hold both is an account that can quietly convert one into the
    other.

    Resetting revokes the existing session. A partner asking for a new password
    is often a partner who has lost control of the old one, and leaving their
    previous token valid for the rest of the week defeats the point of resetting.
    """
    kwargs = _session_kwargs(session)
    dist = await db.distributors.find_one({'id': distributor_id}, **kwargs)
    if not dist:
        raise ValueError('Unknown distributor')
    if dist.get('is_house'):
        raise ValueError('The house account is not a partner and has no portal login')
    linked_user = None
    if dist.get('user_id'):
        linked_user = await db.users.find_one({'id': dist['user_id']}, **kwargs)
        if not linked_user or linked_user.get('role') != 'DISTRIBUTOR':
            raise ValueError('Distributor portal linkage is invalid; credentials were not changed')
    email = (email or '').strip().lower()
    if '@' not in email:
        raise ValueError('A valid email is required for a portal login')

    clash = await db.users.find_one({'$or': [
        {'email': email}, {'email_normalized': email},
    ]}, **kwargs)
    if clash and clash.get('id') != dist.get('user_id'):
        raise ValueError('That email already belongs to another account')

    desired_username = username or dist.get('login_username') or dist['code']
    desired_username, username_key = await _assert_login_username_available(
        desired_username, distributor_id=distributor_id, user_id=dist.get('user_id'),
        session=session,
    )
    await reserve_login_id_aliases(
        dist['code'], 'DISTRIBUTOR', distributor_id, session=session,
    )
    await reserve_login_id_aliases(
        desired_username, 'DISTRIBUTOR', distributor_id, session=session,
    )
    provisioned_at = now_iso()

    if dist.get('user_id'):
        await db.users.update_one(
            {'id': dist['user_id'], 'role': 'DISTRIBUTOR'},
            {
                '$set': {
                    'username': desired_username,
                    'username_key': username_key,
                    'email': email,
                    'email_normalized': email,
                    'password_hash': password_hash,
                    'password_change_required': bool(must_change_password),
                    'password_provisioned_at': provisioned_at,
                    'password_provisioned_by': actor,
                    'password_failed_attempts': 0,
                    'active_session_id': f'revoked-{uuid.uuid4()}',
                    'updated_at': provisioned_at,
                },
                '$unset': {'locked_until': ''},
            },
            **kwargs,
        )
        await db.distributors.update_one({'id': distributor_id}, {'$set': {
            'email': email,
            'login_username': desired_username,
            'login_username_key': username_key,
            'credentials_updated_at': provisioned_at,
            'credentials_updated_by': actor,
        }, '$inc': {'credentials_version': 1, 'record_version': 1}}, **kwargs)
        previous_username = dist.get('login_username')
        if (
            previous_username
            and previous_username.casefold() != desired_username.casefold()
            and previous_username.casefold() != str(dist.get('code') or '').casefold()
        ):
            await release_login_id_aliases(
                previous_username, 'DISTRIBUTOR', distributor_id,
                retain_usernames=(desired_username, dist.get('code')),
                session=session,
            )
        return await db.users.find_one(
            {'id': dist['user_id'], 'role': 'DISTRIBUTOR'},
            {'_id': 0, 'password_hash': 0},
            **kwargs,
        )

    user = {
        'id': str(uuid.uuid4()),
        'username': desired_username,
        'username_key': username_key,
        'email': email,
        'email_normalized': email,
        'password_hash': password_hash,
        'role': 'DISTRIBUTOR',
        'status': 'ACTIVE',
        # Provisioned by the operator, who already has the partner's details —
        # there is nothing for an emailed code to prove.
        'email_verified': True,
        'full_name': dist['name'],
        'display_name': f"{dist['name']} ({dist['code']})",
        'chip_balance': 0,
        'password_change_required': bool(must_change_password),
        'password_failed_attempts': 0,
        'password_provisioned_at': provisioned_at,
        'password_provisioned_by': actor,
        'created_at': provisioned_at,
        'created_by': actor,
    }
    await db.users.insert_one(user, **kwargs)
    await db.distributors.update_one({'id': distributor_id}, {'$set': {
        'user_id': user['id'],
        'email': email,
        'login_username': desired_username,
        'login_username_key': username_key,
        'credentials_updated_at': provisioned_at,
        'credentials_updated_by': actor,
    }, '$inc': {'credentials_version': 1, 'record_version': 1}}, **kwargs)
    user.pop('_id', None)
    user.pop('password_hash', None)
    return user


async def ensure_indexes():
    """Uniqueness the application cannot be trusted to maintain on its own.

    Two admins creating the same code in the same second is a race the code
    above loses; the index does not.
    """
    await db.distributors.create_index('code', unique=True)
    await db.distributors.create_index('status')
    # Every portal request resolves the distributor from the signed-in user.
    await db.distributors.create_index('user_id', sparse=True)
    await db.distributor_rates.create_index([('distributor_id', 1), ('effective_from', -1)])
    await db.player_attribution.create_index([('user_id', 1), ('active', 1)])
    await db.player_attribution.create_index(
        [('user_id', 1)],
        unique=True,
        partialFilterExpression=ACTIVE_ATTRIBUTION_PARTIAL,
        name=ACTIVE_ATTRIBUTION_INDEX,
    )
    await db.player_attribution.create_index('distributor_id')
    await db.users.create_index('distributor_id')
    # New portal-parity indexes stay after the established attribution indexes.
    # Attempt every additive index independently so one legacy conflict never
    # suppresses the others, then surface a single readiness error. No data is
    # deleted automatically. Legacy identities are adopted into the additive
    # reservation collection only after every required index exists.
    failures = []
    specs = (
        (
            db.distributors, 'user_id',
            {'unique': True,
             'partialFilterExpression': {'user_id': {'$type': 'string'}},
             'name': 'distributor_portal_user_unique'},
        ),
        (
            db.distributors, 'login_username_key',
            {'unique': True,
             'partialFilterExpression': {'login_username_key': {'$type': 'string'}},
             'name': 'distributor_login_username_unique'},
        ),
        (
            db.users, 'username_key',
            {'unique': True,
             'partialFilterExpression': {'username_key': {'$type': 'string'}},
             'name': 'users_username_key_unique'},
        ),
        (
            db.login_id_reservations, 'key',
            {'unique': True, 'name': LOGIN_ID_RESERVATION_INDEX},
        ),
    )
    for collection, keys, options in specs:
        try:
            await collection.create_index(keys, **options)
        except Exception as exc:  # continue so later invariants are still attempted
            failures.append(f"{options['name']}:{type(exc).__name__}")
            logger.error(
                'CRM portal index %s unavailable: %s',
                options['name'], type(exc).__name__,
            )
    if failures:
        raise CrmConfigurationError(
            f'CRM portal identity indexes are unavailable ({", ".join(failures)})'
        )
    await ensure_login_id_reservation_coverage()


async def require_portal_identity_readiness() -> None:
    """Fail credential/Login-ID mutations closed without exact unique indexes."""
    expected = (
        (
            db.distributors, 'distributor_portal_user_unique', [('user_id', 1)],
            {'user_id': {'$type': 'string'}},
        ),
        (
            db.distributors, 'distributor_login_username_unique',
            [('login_username_key', 1)],
            {'login_username_key': {'$type': 'string'}},
        ),
        (
            db.users, 'users_username_key_unique', [('username_key', 1)],
            {'username_key': {'$type': 'string'}},
        ),
        (
            db.login_id_reservations, LOGIN_ID_RESERVATION_INDEX, [('key', 1)], None,
        ),
    )
    try:
        for collection, name, keys, partial in expected:
            spec = (await collection.index_information()).get(name) or {}
            if list(spec.get('key') or []) != keys or spec.get('unique') is not True:
                raise CrmConfigurationError(f'CRM portal identity index {name} is unavailable')
            actual_partial = spec.get('partialFilterExpression')
            if (
                (partial is None and actual_partial is not None)
                or (partial is not None and actual_partial != partial)
                or spec.get('sparse') is True
            ):
                raise CrmConfigurationError(f'CRM portal identity index {name} is invalid')
        coverage = await db.system_config.find_one(
            {'key': 'main'},
            {'_id': 0, 'login_id_reservation_coverage_version': 1},
        )
        if (
            not coverage
            or coverage.get('login_id_reservation_coverage_version')
            != LOGIN_ID_RESERVATION_COVERAGE_VERSION
        ):
            raise CrmConfigurationError('CRM Login ID reservation coverage is unavailable')
    except CrmConfigurationError:
        raise
    except Exception as exc:
        raise CrmConfigurationError('CRM portal identity storage is unavailable') from exc


async def portal_identity_ready() -> bool:
    try:
        await require_portal_identity_readiness()
    except Exception:
        return False
    return True


async def require_registration_attribution_readiness() -> None:
    """Require the exact invariant that keeps every player singly attributed."""
    try:
        indexes = await db.player_attribution.index_information()
        spec = indexes.get(ACTIVE_ATTRIBUTION_INDEX) or {}
        house = await db.distributors.find_one({
            'code': HOUSE_CODE, 'status': 'ACTIVE', 'is_house': True,
        })
    except Exception as exc:
        raise CrmConfigurationError('CRM registration storage is unavailable') from exc
    if (
        list(spec.get('key') or []) != [('user_id', 1)]
        or spec.get('unique') is not True
        or spec.get('partialFilterExpression') != ACTIVE_ATTRIBUTION_PARTIAL
        or not house
    ):
        raise CrmConfigurationError('CRM registration invariants are unavailable')


async def registration_attribution_ready() -> bool:
    try:
        await require_registration_attribution_readiness()
    except Exception:
        return False
    return True
