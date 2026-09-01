"""Who may play, from where, at what age, and how much they may lose.

Four controls live here — market eligibility, age, self-exclusion and player
limits — because they share one property that makes them different from every
other rule in the system: **they exist to stop the operator taking money it
would otherwise be happy to take.** A rule that costs revenue is a rule that
erodes unless it is enforced in one place, so all four are enforced here and
nowhere else, at choke points the game code cannot route around.

Three decisions shape the whole module.

**Enforcement ships OFF.** Market restriction defaults to `OFF` and age
verification to not-required, so deploying this changes nothing until the
operator turns it on. The alternative — an allow-list that starts empty and
therefore allows nobody — would lock the entire live player base out on the
first deploy. An inherited default must never suspend a real account.

**A restriction is never applied retroactively by a machine.** Turning on a
market, or raising a minimum age, does not suspend the players it would now
exclude. It reports them, and a human decides. Automatically locking accounts
out of their balance on a config change is the kind of irreversible surprise
that a config change should not be able to cause.

**Loosening is slow, tightening is instant.** A player lowering their limit is
protected immediately. A player raising one waits — because the moment somebody
wants their limit gone is exactly the moment the limit is doing its job. The
same asymmetry governs self-exclusion: it cannot be shortened, only extended,
and coming back afterwards takes a deliberate act and another wait.
"""
import re
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException

import ledger
from db import db

CONFIG_KEY = 'main'

# --- what an operator can configure ------------------------------------------
DEFAULTS = {
    # OFF | ALLOW (only listed countries) | BLOCK (everyone except listed)
    'market_mode': 'OFF',
    'markets': [],
    'min_age': 18,
    'min_age_by_country': {},          # e.g. {'US': 21}
    # Registration is always checked against the market and age rules. Applying
    # them to EXISTING accounts is separate and opt-in, because switching a
    # market off would otherwise lock established players away from a balance
    # they already hold. The operator reviews who it would hit first — see
    # review_players — and then turns this on deliberately.
    'enforce_market_on_login': False,
    'require_age_verification': False,
    # A raised limit takes this long to bite. 24h is the common regulatory
    # figure and the point is the wait, not the number.
    'limit_increase_delay_hours': 24,
    # After an exclusion expires, returning takes a deliberate request and then
    # this long. Coming back must not be a single tap on a bad evening.
    'reactivation_cooling_hours': 24,
}

MARKET_MODES = ('OFF', 'ALLOW', 'BLOCK')

# Exclusion kinds. A BREAK is short and self-serve; a SELF_EXCLUSION is the
# serious one and is the only kind that can be permanent.
BREAK = 'BREAK'
SELF_EXCLUSION = 'SELF_EXCLUSION'

DEPOSIT = 'DEPOSIT'
LOSS = 'LOSS'
PERIODS = {'DAY': 1, 'WEEK': 7, 'MONTH': 30}


class ComplianceBlock(HTTPException):
    """A refusal the player has to see.

    Raised as an HTTPException on purpose. The stake guard runs inside the
    ledger, which is called from five different game routes, each with its own
    error handling; a plain exception would surface as a 500 in whichever of
    them nobody remembered to update. This way a blocked stake is a correct 403
    everywhere, including the routes written before this module existed.
    """

    def __init__(self, code, message, **extra):
        super().__init__(status_code=403, detail={'code': code, 'message': message, **extra})


def now():
    return datetime.now(timezone.utc)


def now_iso():
    return now().isoformat()


def _parse(iso):
    if not iso:
        return None
    if isinstance(iso, datetime):
        return iso if iso.tzinfo else iso.replace(tzinfo=timezone.utc)
    dt = datetime.fromisoformat(str(iso).replace('Z', '+00:00'))
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


async def get_config(session=None):
    kwargs = {'session': session} if session is not None else {}
    cfg = await db.compliance_config.find_one(
        {'key': CONFIG_KEY}, {'_id': 0}, **kwargs)
    return {**DEFAULTS, **(cfg or {})}


def _validated_minimum_age(value, label='Minimum age'):
    """Return a configured age without ever crossing the legal-age floor."""
    if isinstance(value, bool):
        raise ValueError(f'{label} must be a whole number')
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f'{label} must be a whole number') from exc
    if isinstance(value, float) and not value.is_integer():
        raise ValueError(f'{label} must be a whole number')
    floor = int(DEFAULTS['min_age'])
    if not floor <= parsed <= 25:
        raise ValueError(f'{label} must be between {floor} and 25')
    return parsed


async def set_config(patch, actor, session=None):
    patch = {k: v for k, v in patch.items() if k in DEFAULTS}
    if 'market_mode' in patch and patch['market_mode'] not in MARKET_MODES:
        raise ValueError(f"Market mode must be one of {', '.join(MARKET_MODES)}")
    if 'markets' in patch:
        patch['markets'] = sorted({normalise_country(c) for c in patch['markets'] if normalise_country(c)})
    if 'min_age' in patch:
        patch['min_age'] = _validated_minimum_age(patch['min_age'])
    if 'min_age_by_country' in patch:
        values = patch['min_age_by_country']
        if not isinstance(values, dict):
            raise ValueError('Country minimum ages must be an object')
        normalised = {}
        for raw_country, raw_age in values.items():
            country = normalise_country(raw_country)
            if not country:
                raise ValueError(f'Unrecognised country for minimum age: {raw_country}')
            minimum = _validated_minimum_age(
                raw_age, f'Minimum age for {country}')
            if country in normalised and normalised[country] != minimum:
                raise ValueError(f'Conflicting minimum ages for {country}')
            normalised[country] = minimum
        patch['min_age_by_country'] = dict(sorted(normalised.items()))
    patch['updated_at'] = now_iso()
    patch['updated_by'] = actor
    kwargs = {'session': session} if session is not None else {}
    await db.compliance_config.update_one(
        {'key': CONFIG_KEY},
        {'$set': patch, '$setOnInsert': {'key': CONFIG_KEY}},
        upsert=True,
        **kwargs,
    )
    return await get_config(session=session)


# ------------------------------------------------------------------- markets

# Players registered before this module existed typed their country as free
# text, so the name has to resolve to a code. The map is deliberately partial:
# an unrecognised name becomes UNKNOWN rather than a guess, because a guess
# here either lets in a market the operator is not licensed for or locks out a
# player who is fine.
_COUNTRY_NAMES = {
    'UNITED KINGDOM': 'GB', 'UK': 'GB', 'GREAT BRITAIN': 'GB', 'ENGLAND': 'GB',
    'SCOTLAND': 'GB', 'WALES': 'GB', 'NORTHERN IRELAND': 'GB',
    'IRELAND': 'IE', 'INDIA': 'IN', 'UNITED STATES': 'US', 'USA': 'US',
    'UNITED STATES OF AMERICA': 'US', 'CANADA': 'CA', 'AUSTRALIA': 'AU',
    'NEW ZEALAND': 'NZ', 'GERMANY': 'DE', 'FRANCE': 'FR', 'SPAIN': 'ES',
    'ITALY': 'IT', 'PORTUGAL': 'PT', 'NETHERLANDS': 'NL', 'BELGIUM': 'BE',
    'SWEDEN': 'SE', 'NORWAY': 'NO', 'DENMARK': 'DK', 'FINLAND': 'FI',
    'POLAND': 'PL', 'ROMANIA': 'RO', 'GREECE': 'GR', 'MALTA': 'MT',
    'SWITZERLAND': 'CH', 'AUSTRIA': 'AT', 'SOUTH AFRICA': 'ZA',
    'NIGERIA': 'NG', 'KENYA': 'KE', 'GHANA': 'GH', 'UAE': 'AE',
    'UNITED ARAB EMIRATES': 'AE', 'SINGAPORE': 'SG', 'MALAYSIA': 'MY',
    'PHILIPPINES': 'PH', 'INDONESIA': 'ID', 'THAILAND': 'TH', 'VIETNAM': 'VN',
    'JAPAN': 'JP', 'SOUTH KOREA': 'KR', 'CHINA': 'CN', 'HONG KONG': 'HK',
    'BRAZIL': 'BR', 'MEXICO': 'MX', 'ARGENTINA': 'AR', 'CHILE': 'CL',
    'COLOMBIA': 'CO', 'PERU': 'PE', 'SRI LANKA': 'LK', 'BANGLADESH': 'BD',
    'PAKISTAN': 'PK', 'NEPAL': 'NP', 'TURKEY': 'TR', 'ISRAEL': 'IL',
}

UNKNOWN = 'UNKNOWN'


def normalise_country(raw):
    """A typed country to an ISO alpha-2 code, or None if it cannot be read."""
    if not raw:
        return None
    text = re.sub(r'[^A-Z ]', '', str(raw).strip().upper()).strip()
    # The name map is consulted first, and it holds the common two-letter names
    # that are NOT ISO codes — "UK" is the country everyone writes and GB is the
    # code, so treating any two letters as a code would file half the operator's
    # licensed market under a country that does not exist.
    if text in _COUNTRY_NAMES:
        return _COUNTRY_NAMES[text]
    if len(text) == 2 and text.isalpha():
        return text
    return None


def market_allows(cfg, country_code):
    """Whether a country may play, given the configured mode.

    UNKNOWN is refused under ALLOW and permitted under BLOCK, which is the same
    rule stated once: a country the operator has not positively listed is not a
    country it has said it is licensed for.
    """
    mode = cfg.get('market_mode', 'OFF')
    if mode == 'OFF':
        return True
    listed = country_code in (cfg.get('markets') or [])
    return listed if mode == 'ALLOW' else not listed


def min_age_for(cfg, country_code):
    floor = int(DEFAULTS['min_age'])
    configured = (cfg.get('min_age_by_country') or {}).get(
        country_code, cfg.get('min_age', floor))
    try:
        return max(floor, int(configured))
    except (TypeError, ValueError):
        # A malformed historical row must fail towards the statutory floor,
        # never towards admitting a minor or crashing the play guard.
        return floor


# ----------------------------------------------------------------------- age

def age_on(dob, when=None):
    """Whole years old, or None if the date of birth is unusable.

    Computed rather than stored, so a player who was too young at signup becomes
    eligible on their birthday without anyone having to remember to re-check.
    """
    if not dob:
        return None
    try:
        born = datetime.fromisoformat(str(dob).strip()[:10]).date()
    except ValueError:
        return None
    today = (when or now()).date()
    return today.year - born.year - ((today.month, today.day) < (born.month, born.day))


async def check_eligibility(country, dob, cfg=None, require_dob=True):
    """Market and age together, as one answer, for registration and approval.

    Returns (ok, code, message) rather than raising, because the callers do
    different things with a no.

    `require_dob` is False on the paths where an account legitimately may not
    have one yet — an operator provisions accounts by hand and records the date
    of birth separately. A missing date is then not a refusal here; it is a row
    in the compliance review for a human to chase, which is the same way
    `assert_playable` treats it. Refusing instead would block the operator's own
    provisioning flow to enforce a rule this check cannot actually evaluate.
    """
    cfg = cfg or await get_config()
    code = normalise_country(country) or UNKNOWN

    if not market_allows(cfg, code):
        where = code if code != UNKNOWN else 'an unrecognised country'
        return False, 'MARKET_BLOCKED', (
            f'Chakri.Casino is not available in {where}.')

    minimum = min_age_for(cfg, code)
    age = age_on(dob)
    if age is None:
        if require_dob:
            return False, 'AGE_UNKNOWN', 'A valid date of birth is required.'
        return True, None, None
    if age < minimum:
        return False, 'UNDERAGE', f'You must be at least {minimum} to play.'
    return True, None, None


# ---------------------------------------------------------------- exclusions

async def active_exclusion(user_id):
    """The exclusion currently in force, if any.

    A permanent exclusion has no end date, so the query cannot simply compare
    against now — it has to treat a missing end as "still running", which is
    the safe direction to fail in.
    """
    row = await db.exclusions.find_one(
        {'user_id': user_id, 'status': 'ACTIVE'}, {'_id': 0}, sort=[('created_at', -1)])
    if not row:
        return None
    ends = _parse(row.get('ends_at'))
    if ends and ends <= now():
        return None
    return row


async def exclude(user_id, kind=BREAK, days=None, source='PLAYER', reason=None):
    """Start a break or a self-exclusion. It can be extended, never shortened.

    An exclusion already running is not replaced by a shorter one, because the
    request to shorten it is the request the whole mechanism exists to refuse.
    A longer one supersedes it, and the superseded row is kept rather than
    edited so the history of what was asked for and when survives.
    """
    if kind not in (BREAK, SELF_EXCLUSION):
        raise ValueError('Unknown exclusion kind')
    if days is None and kind != SELF_EXCLUSION:
        raise ValueError('Only a self-exclusion can be permanent')
    if days is not None:
        days = int(days)
        if days < 1:
            raise ValueError('A break has to be at least a day')

    starts = now()
    ends = starts + timedelta(days=days) if days is not None else None

    current = await active_exclusion(user_id)
    if current:
        current_ends = _parse(current.get('ends_at'))
        if current_ends is None:
            raise ValueError('This account is permanently excluded and cannot be changed here')
        if ends is not None and ends <= current_ends:
            raise ValueError(
                f"An exclusion is already in force until {current_ends.date()} and "
                f"cannot be shortened. You can only extend it.")
        await db.exclusions.update_one(
            {'id': current['id']},
            {'$set': {'status': 'SUPERSEDED', 'superseded_at': now_iso()}})

    doc = {
        'id': str(uuid.uuid4()),
        'user_id': user_id,
        'kind': kind,
        'days': days,
        'starts_at': starts.isoformat(),
        'ends_at': ends.isoformat() if ends else None,
        'source': source,
        'reason': reason,
        'status': 'ACTIVE',
        'created_at': now_iso(),
        'reactivation_requested_at': None,
        'lifted_at': None, 'lifted_by': None,
    }
    await db.exclusions.insert_one(doc)
    doc.pop('_id', None)
    return doc


async def request_reactivation(user_id):
    """Ask to come back, once the exclusion has run its course.

    Two gates, both deliberate: the exclusion must have expired on its own, and
    then there is a wait. Neither is an obstacle to somebody who has genuinely
    decided; both are an obstacle to somebody deciding at 3am.
    """
    row = await db.exclusions.find_one(
        {'user_id': user_id, 'status': 'ACTIVE'}, sort=[('created_at', -1)])
    if not row:
        return {'status': 'NONE', 'message': 'There is no exclusion on this account.'}
    ends = _parse(row.get('ends_at'))
    if ends is None:
        raise ValueError('A permanent self-exclusion can only be lifted by the operator.')
    if ends > now():
        raise ValueError(f'Your exclusion runs until {ends.date()} and cannot be ended early.')

    cfg = await get_config()
    wait = int(cfg['reactivation_cooling_hours'])
    if not row.get('reactivation_requested_at'):
        await db.exclusions.update_one({'id': row['id']}, {'$set': {
            'reactivation_requested_at': now_iso()}})
        return {'status': 'WAITING', 'hours': wait, 'message':
                f'Request received. Your account reopens in {wait} hours.'}

    ready_at = _parse(row['reactivation_requested_at']) + timedelta(hours=wait)
    if now() < ready_at:
        left = max(1, int((ready_at - now()).total_seconds() // 3600))
        return {'status': 'WAITING', 'hours': left, 'message':
                f'Your account reopens in about {left} hour(s).'}

    await db.exclusions.update_one({'id': row['id']}, {'$set': {
        'status': 'LIFTED', 'lifted_at': now_iso(), 'lifted_by': 'PLAYER'}})
    return {'status': 'LIFTED', 'message': 'Welcome back. Your limits are unchanged.'}


async def admin_lift(user_id, actor, reason, session=None):
    """The operator ending an exclusion, including a permanent one.

    Requires a reason, and the reason is stored, because this is the one path
    that overrides a player's own decision and it has to be answerable later.
    """
    reason = str(reason or '').strip()
    if not reason:
        raise ValueError('Lifting an exclusion has to have a reason recorded')
    kwargs = {'session': session} if session is not None else {}
    row = await db.exclusions.find_one({'user_id': user_id, 'status': 'ACTIVE'},
                                       sort=[('created_at', -1)], **kwargs)
    if not row:
        raise ValueError('This account has no active exclusion')
    await db.exclusions.update_one({'id': row['id']}, {'$set': {
        'status': 'LIFTED', 'lifted_at': now_iso(), 'lifted_by': actor,
        'lift_reason': reason}}, **kwargs)
    return await db.exclusions.find_one({'id': row['id']}, {'_id': 0}, **kwargs)


async def assert_not_excluded(user_id):
    row = await active_exclusion(user_id)
    if not row:
        return
    ends = row.get('ends_at')
    raise ComplianceBlock(
        'SELF_EXCLUDED',
        'Your account is closed to play at your own request.'
        + (f" It reopens after {str(ends)[:10]}." if ends else
           ' This exclusion is permanent — contact support if you need to discuss it.'),
        ends_at=ends, kind=row['kind'])


async def assert_playable(user):
    """Every gate an existing account passes on its way into the app.

    One function, called from one dependency, so a new screen cannot be added
    that forgets one of them. Exclusion always applies; the other two apply
    only when the operator has switched them on.
    """
    await assert_not_excluded(user['id'])

    cfg = await get_config()
    code = normalise_country(user.get('country')) or UNKNOWN

    if cfg.get('enforce_market_on_login') and not market_allows(cfg, code):
        raise ComplianceBlock(
            'MARKET_BLOCKED',
            'Chakri.Casino is not available in your registered country. '
            'Contact support if this is wrong.')

    # Age is satisfied by the player's one-tap 18+ self-attestation (recorded as
    # accepted_terms during onboarding) or by an explicit operator age flag.
    # Requiring an operator to hand-verify age stranded live players behind
    # "Age verification failed"; the launch model is self-attest, and an actual
    # date of birth below the minimum is still refused below so a real minor
    # cannot slip through.
    if (cfg.get('require_age_verification')
            and not user.get('age_verified')
            and not user.get('accepted_terms')):
        raise ComplianceBlock(
            'AGE_NOT_VERIFIED',
            'Please confirm you are at least 18 to continue.')

    # Age is re-derived rather than trusted, so an account that got through
    # before is caught the next time it is used. The BASE minimum applies
    # whatever the settings say — an underage player is a legal line, not an
    # operator preference, and is not something to leave sitting in a review
    # queue. A minimum the operator has RAISED above it follows the same opt-in
    # path as the markets, because that one is a business decision and can
    # stand a human looking at it first.
    age = age_on(user.get('date_of_birth'))
    if age is None:
        return
    floor = int(DEFAULTS['min_age'])
    minimum = min_age_for(cfg, code) if cfg.get('enforce_market_on_login') else floor
    if age < minimum:
        raise ComplianceBlock('UNDERAGE', f'You must be at least {minimum} to play.')


# -------------------------------------------------------------------- limits

def _window_days(period):
    if period not in PERIODS:
        raise ValueError(f"Period must be one of {', '.join(PERIODS)}")
    return PERIODS[period]


def window_start(period, when=None):
    """The first gaming day inside a rolling window.

    Gaming days, not calendar days, so a limit and the revenue engine agree
    about which side of midnight a 00:30 bet falls on.
    """
    days = _window_days(period)
    base = when or now()
    return ledger.gaming_day(base - timedelta(days=days - 1))


async def set_limit(user_id, kind, period, amount, actor='PLAYER'):
    """Set or change a limit. Down now, up later.

    `amount` of None means "no limit", which is the largest possible increase
    and therefore also waits. Removing a limit instantly would make the delay
    trivially avoidable — set it to nothing, play, set it back.
    """
    if kind not in (DEPOSIT, LOSS):
        raise ValueError('Limit must be DEPOSIT or LOSS')
    _window_days(period)
    if amount is not None:
        amount = int(amount)
        if amount < 0:
            raise ValueError('A limit cannot be negative')

    cfg = await get_config()
    delay = int(cfg['limit_increase_delay_hours'])
    existing = await db.player_limits.find_one(
        {'user_id': user_id, 'kind': kind, 'period': period})
    current = existing.get('amount') if existing else None

    tightening = current is None or (amount is not None and amount < current)
    doc = {
        'user_id': user_id, 'kind': kind, 'period': period,
        'updated_at': now_iso(), 'updated_by': actor,
    }
    if tightening:
        # Includes setting a first limit, which is a tightening from nothing.
        doc.update({'amount': amount, 'effective_from': now_iso(),
                    'pending_amount': None, 'pending_effective_from': None})
        outcome = 'IMMEDIATE'
    else:
        doc.update({'pending_amount': amount,
                    'pending_effective_from': (now() + timedelta(hours=delay)).isoformat()})
        outcome = 'PENDING'

    await db.player_limits.update_one(
        {'user_id': user_id, 'kind': kind, 'period': period},
        {'$set': doc}, upsert=True)
    row = await db.player_limits.find_one(
        {'user_id': user_id, 'kind': kind, 'period': period}, {'_id': 0})
    return {'outcome': outcome, 'delay_hours': delay, 'limit': row}


async def cancel_pending(user_id, kind, period):
    """Drop a queued increase. Instant, because cancelling is a tightening."""
    await db.player_limits.update_one(
        {'user_id': user_id, 'kind': kind, 'period': period},
        {'$set': {'pending_amount': None, 'pending_effective_from': None,
                  'updated_at': now_iso()}})
    return await db.player_limits.find_one(
        {'user_id': user_id, 'kind': kind, 'period': period}, {'_id': 0})


async def _effective(row):
    """The limit in force, promoting a queued increase whose time has come.

    Promotion happens on read rather than on a schedule. A job that has to run
    for a limit to take effect is a job whose failure silently keeps a player
    restricted — or, if the change were applied optimistically, silently
    unrestricted. Reading is the only moment the answer is needed.
    """
    if not row:
        return None
    pending_at = _parse(row.get('pending_effective_from'))
    if pending_at and pending_at <= now():
        await db.player_limits.update_one(
            {'user_id': row['user_id'], 'kind': row['kind'], 'period': row['period']},
            {'$set': {'amount': row.get('pending_amount'),
                      'effective_from': row['pending_effective_from'],
                      'pending_amount': None, 'pending_effective_from': None}})
        row = {**row, 'amount': row.get('pending_amount'),
               'pending_amount': None, 'pending_effective_from': None}
    return row


async def limits_for(user_id, kind=None):
    q = {'user_id': user_id}
    if kind:
        q['kind'] = kind
    rows = await db.player_limits.find(q, {'_id': 0}).to_list(50)
    return [await _effective(r) for r in rows]


async def deposits_in(user_id, period):
    since = window_start(period)
    rows = await db.chip_transactions.find(
        {'user_id': user_id, 'kind': ledger.DEPOSIT, 'gaming_day': {'$gte': since}},
        {'_id': 0, 'amount': 1}).to_list(5000)
    return sum(int(r['amount']) for r in rows)


async def net_loss_in(user_id, period):
    """Staked minus won, over the window.

    Negative when the player is ahead, and left negative rather than floored at
    zero — a winning week genuinely means nothing has been lost, and clamping it
    would make a losing day inside a winning week count against the limit.
    """
    since = window_start(period)
    rows = await db.chip_transactions.find(
        {'user_id': user_id, 'gaming_day': {'$gte': since},
         'kind': {'$in': [ledger.STAKE, ledger.PAYOUT, ledger.REFUND]}},
        {'_id': 0, 'kind': 1, 'amount': 1}).to_list(20000)
    staked = sum(int(r['amount']) for r in rows if r['kind'] == ledger.STAKE)
    back = sum(int(r['amount']) for r in rows
               if r['kind'] in (ledger.PAYOUT, ledger.REFUND))
    return staked - back


async def check_deposit(user_id, amount):
    """Refuse a top-up that would breach a deposit limit."""
    for row in await limits_for(user_id, DEPOSIT):
        cap = row.get('amount')
        if cap is None:
            continue
        used = await deposits_in(user_id, row['period'])
        if used + int(amount) > cap:
            left = max(0, cap - used)
            raise ComplianceBlock(
                'DEPOSIT_LIMIT',
                f"This would take you past your {row['period'].lower()} deposit limit "
                f"of {cap:,}. You have {left:,} left in this period.",
                period=row['period'], limit=cap, used=used, remaining=left)


async def check_stake(user_id, amount):
    """Refuse a bet that could take the player past a loss limit.

    The whole stake is counted as a potential loss, because it is one — a bet
    that could still be won is a bet that could still be lost, and a limit that
    only bit after the money was gone would not be a limit.
    """
    for row in await limits_for(user_id, LOSS):
        cap = row.get('amount')
        if cap is None:
            continue
        lost = await net_loss_in(user_id, row['period'])
        if lost + int(amount) > cap:
            left = max(0, cap - lost)
            raise ComplianceBlock(
                'LOSS_LIMIT',
                f"This bet would take you past your {row['period'].lower()} loss limit "
                f"of {cap:,}. You have {left:,} left in this period.",
                period=row['period'], limit=cap, used=max(0, lost), remaining=left)


async def _stake_guard(user_id, amount):
    """Registered with the ledger, so every stake passes it.

    Hooked rather than called from the game routes because there are five of
    them and a sixth will be written; a check that has to be remembered is a
    check that will eventually be forgotten.
    """
    await assert_not_excluded(user_id)
    await check_stake(user_id, amount)


ledger.register_stake_guard(_stake_guard)


# ---------------------------------------------------------------- reporting

async def review_players(cfg=None, limit=500):
    """Who the current settings would exclude, without excluding them.

    This is what makes turning enforcement on safe: the operator sees the
    damage before doing it rather than discovering it in a support queue.
    """
    cfg = cfg or await get_config()
    rows = await db.users.find(
        {'role': 'PLAYER'},
        {'_id': 0, 'id': 1, 'username': 1, 'country': 1, 'date_of_birth': 1,
         'status': 1, 'chip_balance': 1},
    ).to_list(limit)
    flagged = []
    for u in rows:
        code = normalise_country(u.get('country')) or UNKNOWN
        reasons = []
        if not market_allows(cfg, code):
            reasons.append('MARKET' if code != UNKNOWN else 'COUNTRY_UNKNOWN')
        age = age_on(u.get('date_of_birth'))
        if age is None:
            reasons.append('NO_DOB')
        elif age < min_age_for(cfg, code):
            reasons.append('UNDERAGE')
        if reasons:
            flagged.append({'user_id': u['id'], 'login_id': u.get('username'),
                            'country': u.get('country'), 'country_code': code,
                            'age': age, 'status': u.get('status'),
                            'chip_balance': u.get('chip_balance', 0),
                            'reasons': reasons})
    return {'checked': len(rows), 'flagged': flagged}


async def ensure_indexes():
    await db.player_limits.create_index(
        [('user_id', 1), ('kind', 1), ('period', 1)], unique=True)
    await db.exclusions.create_index([('user_id', 1), ('status', 1)])
    # The loss window scans a player's own rows by gaming day on every bet.
    await db.chip_transactions.create_index([('user_id', 1), ('gaming_day', 1), ('kind', 1)])
