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
import re
import uuid
from datetime import datetime, timezone

from db import db

HOUSE_CODE = 'HOUSE'

# 0/O and 1/I/L are the same character to someone reading a code off a screen or
# hearing it over a phone, and a mistyped code silently pays the wrong person.
_CONFUSABLE = str.maketrans({'O': '0', 'I': '1', 'L': '1'})
_CODE_OK = re.compile(r'^[A-Z0-9]{4,12}$')
_RESERVED = {'HOUSE', 'ADMIN', 'NULL', 'NONE', 'TEST', 'SYSTEM', 'CHAKRI'}


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
    return code not in _RESERVED or code == HOUSE_CODE


# ---------------------------------------------------------------- distributors

async def ensure_house_account():
    """The fallback distributor. Created once, never deleted, never paid.

    Its commission rate is zero: house players earn nobody a commission, and
    making that explicit is safer than leaving the engine to infer it from a
    missing row.
    """
    existing = await db.distributors.find_one({'code': HOUSE_CODE})
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
        'user_id': None,          # no portal login
        'created_at': now_iso(),
        'created_by': 'system',
        'note': 'Players who arrived without a referral code.',
    }
    await db.distributors.insert_one(doc)
    await set_rate(doc['id'], 0, 'system', note='House account earns no commission')
    return doc


async def create_distributor(name, code, rate_bps, created_by, email=None,
                             phone=None, note=None):
    code = normalise_code(code)
    if not code:
        raise ValueError('Code must be 4-12 letters or digits')
    if not code_is_available(code):
        raise ValueError(f'"{code}" is reserved')
    if await db.distributors.find_one({'code': code}):
        raise ValueError(f'Code "{code}" is already in use')
    rate_bps = int(rate_bps)
    if not 0 <= rate_bps <= 10000:
        raise ValueError('Commission must be between 0 and 100 percent')
    doc = {
        'id': str(uuid.uuid4()),
        'code': code,
        'name': name.strip(),
        'status': 'ACTIVE',
        'is_house': False,
        'email': (email or '').strip().lower() or None,
        'phone': (phone or '').strip() or None,
        'user_id': None,
        'created_at': now_iso(),
        'created_by': created_by,
        'note': note,
    }
    await db.distributors.insert_one(doc)
    await set_rate(doc['id'], rate_bps, created_by, note='Opening rate')
    return doc


async def set_rate(distributor_id, rate_bps, set_by, effective_from=None, note=None):
    """Open a new rate period and close the one before it.

    Closing the previous row rather than overwriting it is the whole point: a
    statement produced last quarter has to keep reproducing the number it
    printed, whatever the rate is today.
    """
    rate_bps = int(rate_bps)
    if not 0 <= rate_bps <= 10000:
        raise ValueError('Commission must be between 0 and 100 percent')
    start = effective_from or now_iso()
    await db.distributor_rates.update_many(
        {'distributor_id': distributor_id, 'effective_to': None},
        {'$set': {'effective_to': start}},
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
    await db.distributor_rates.insert_one(row)
    return row


async def rate_on(distributor_id, when_iso):
    """The rate in force at an instant — what a commission run must ask for."""
    row = await db.distributor_rates.find_one({
        'distributor_id': distributor_id,
        'effective_from': {'$lte': when_iso},
        '$or': [{'effective_to': None}, {'effective_to': {'$gt': when_iso}}],
    }, sort=[('effective_from', -1)])
    return int(row['rate_bps']) if row else 0


# ----------------------------------------------------------------- attribution

async def resolve_code(raw):
    """A typed code to the distributor that owns it, or the house account.

    An unknown code is NOT an error at signup. Rejecting the registration
    because someone mistyped a friend's code loses the player; the account is
    created against the house and the code they typed is kept on the request so
    an admin can correct the attribution deliberately.
    """
    code = normalise_code(raw)
    if code:
        dist = await db.distributors.find_one({'code': code, 'status': 'ACTIVE'})
        if dist:
            return dist, code, 'CODE'
    house = await ensure_house_account()
    return house, code, ('UNKNOWN_CODE' if raw else 'NO_CODE')


async def attribute_user(user_id, raw_code, actor='system'):
    """Bind a player to a distributor. Called once, when the account is created.

    Returns the attribution document so the caller can store the ids on the user
    row for cheap querying, while the audit trail lives here.
    """
    dist, code, source = await resolve_code(raw_code)
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
    await db.player_attribution.insert_one(doc)
    res = await db.users.update_one({'id': user_id}, {'$set': {
        'distributor_id': dist['id'],
        'distributor_code': dist['code'],
        'referral_code_typed': code,
    }})
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


async def ensure_indexes():
    """Uniqueness the application cannot be trusted to maintain on its own.

    Two admins creating the same code in the same second is a race the code
    above loses; the index does not.
    """
    await db.distributors.create_index('code', unique=True)
    await db.distributors.create_index('status')
    await db.distributor_rates.create_index([('distributor_id', 1), ('effective_from', -1)])
    await db.player_attribution.create_index([('user_id', 1), ('active', 1)])
    await db.player_attribution.create_index('distributor_id')
    await db.users.create_index('distributor_id')
