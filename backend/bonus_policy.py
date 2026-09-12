"""Chakri signup, play-through, deposit-match, referral and withdrawal policy.

The module is intentionally small and source-aware.  Promotional grants enter
the restricted wallet bucket, settled bonus-funded play moves only existing
value into the withdrawable bucket, and referral rewards enter as real chips.
Every financial effect has a deterministic source key.
"""
from __future__ import annotations

import hashlib
import os
import re
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable, Mapping
from urllib.parse import quote
from zoneinfo import ZoneInfo

from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError

from db import db


POLICY_VERSION = "chakri-bonus-v1"
SIGNUP_BONUS_CHIPS = 1_000
FIRST_DEPOSIT_MIN_PAISE = 10_000
FIRST_DEPOSIT_MAX_PAISE = 500_000
FIRST_DEPOSIT_MAX_BONUS_CHIPS = 5_000
DIRECT_REFERRAL_BPS = 1_000
DIRECT_REFERRAL_CAP_CHIPS = 500
SECOND_LEVEL_REFERRAL_BPS = 500
DAILY_WITHDRAWAL_LIMIT_PAISE = 50_000
WITHDRAWAL_TZ = ZoneInfo("Asia/Kolkata")

_READY = False
_INVITE_RE = re.compile(r"^[A-Z0-9]{8,20}$")


class BonusPolicyError(Exception):
    def __init__(
        self, code: str, message: str, status_code: int = 400,
        *, meta: Mapping[str, Any] | None = None,
    ):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code
        self.meta = dict(meta or {})


def now() -> datetime:
    return datetime.now(timezone.utc)


def _session_kwargs(session) -> dict[str, Any]:
    return {"session": session} if session is not None else {}


def program_enabled(environ: Mapping[str, str] | None = None) -> bool:
    env = os.environ if environ is None else environ
    return str(env.get("CHAKRI_BONUS_POLICY_ENABLED", "true")).strip().lower() == "true"


def wallet_source_enabled() -> bool:
    return bool(program_enabled() and _READY)


async def user_participates(user_id: str, *, session=None) -> bool:
    if not wallet_source_enabled():
        return False
    user = await db.users.find_one(
        {"id": str(user_id)}, {"_id": 0, "bonus_policy_version": 1},
        **_session_kwargs(session),
    )
    return bool(user and user.get("bonus_policy_version") == POLICY_VERSION)


async def ensure_indexes() -> None:
    """Create the minimal indexes required by this always-on policy."""
    await db.wallet_accounts.create_index(
        "user_id", unique=True, name="wallet_account_user_unique",
    )
    await db.wallet_bonus_lots.create_index(
        "id", unique=True, name="wallet_bonus_lot_id_unique",
    )
    await db.wallet_bonus_lots.create_index(
        "source_key", unique=True, name="wallet_bonus_lot_source_unique",
    )
    await db.wallet_operations.create_index(
        [("user_id", 1), ("idempotency_key", 1)], unique=True,
        name="wallet_operation_idempotency_unique",
    )
    await db.wallet_operations.create_index(
        "source_key", unique=True, name="wallet_operation_source_unique",
    )
    await db.wallet_entries.create_index(
        [("operation_id", 1), ("entry_no", 1)], unique=True,
        name="wallet_entry_operation_sequence_unique",
    )
    await db.wallet_source_consumptions.create_index(
        "stake_transaction_id", unique=True,
        name="wallet_source_consumption_stake_unique",
    )
    await db.chip_transactions.create_index(
        "id", unique=True, name="chip_transaction_id_unique",
    )
    await db.signup_bonus_grants.create_index(
        "user_id", unique=True, name="signup_bonus_grant_user_unique",
    )
    await db.player_referrals.create_index(
        "invite_code", unique=True,
        partialFilterExpression={"invite_code": {"$type": "string"}},
        name="player_referral_invite_code_unique",
    )
    await db.player_referrals.create_index(
        "user_id", unique=True,
        partialFilterExpression={"kind": "PROFILE"},
        name="player_referral_profile_user_unique",
    )
    await db.player_referrals.create_index(
        "invited_user_id", unique=True,
        partialFilterExpression={"invited_user_id": {"$type": "string"}},
        name="player_referral_invited_user_unique",
    )
    await db.bonus_deposit_events.create_index(
        "depositor_user_id", unique=True, name="bonus_first_deposit_user_unique",
    )
    await db.bonus_deposit_events.create_index(
        "deposit_id", unique=True, name="bonus_first_deposit_id_unique",
    )
    await db.first_deposit_bonus_claims.create_index(
        "user_id", unique=True, name="first_deposit_bonus_user_unique",
    )
    await db.bonus_referral_rewards.create_index(
        "source_key", unique=True, name="bonus_referral_reward_source_unique",
    )
    await db.bonus_wager_conversions.create_index(
        "source_transaction_id", unique=True,
        name="bonus_wager_conversion_source_unique",
    )
    await db.withdrawal_daily_guards.create_index(
        [("user_id", 1), ("withdrawal_day", 1)], unique=True,
        name="withdrawal_daily_guard_user_day_unique",
    )


async def prepare() -> dict[str, Any]:
    global _READY
    _READY = False
    if not program_enabled():
        return {"enabled": False, "ready": False}
    await ensure_indexes()
    _READY = True
    return {"enabled": True, "ready": True, "policy_version": POLICY_VERSION}


def signup_user_fields() -> dict[str, Any]:
    return {
        "bonus_policy_version": POLICY_VERSION,
        "bonus_policy_joined_at": now().isoformat(),
    }


async def grant_signup_bonus(
    user_id: str, *, source: str, session=None,
) -> dict[str, Any]:
    """Grant exactly one 1,000-chip restricted signup balance."""
    import ledger

    source_key = f"signup-bonus:{user_id}"
    kwargs = _session_kwargs(session)
    existing = await db.chip_transactions.find_one(
        {"user_id": user_id, "ref": source_key, "kind": ledger.BONUS},
        {"_id": 0, "id": 1}, **kwargs,
    )
    if existing:
        return {"chips": SIGNUP_BONUS_CHIPS, "duplicate": True}
    try:
        await db.signup_bonus_grants.insert_one({
            "id": source_key, "user_id": user_id, "source": str(source),
            "policy_version": POLICY_VERSION, "created_at": now(),
        }, **kwargs)
    except DuplicateKeyError:
        return {"chips": SIGNUP_BONUS_CHIPS, "duplicate": True}
    await ledger.credit_chips(
        user_id, SIGNUP_BONUS_CHIPS,
        "Welcome signup bonus (playing chips)",
        ref=source_key, kind=ledger.BONUS, session=session,
    )
    await db.users.update_one(
        {"id": user_id},
        {"$set": {
            "signup_bonus_chips": SIGNUP_BONUS_CHIPS,
            "signup_bonus_source": str(source),
            "signup_bonus_granted_at": now().isoformat(),
        }}, **kwargs,
    )
    await db.notifications.insert_one({
        "id": str(uuid.uuid4()), "user_id": user_id,
        "title": "1,000 signup chips added",
        "body": (
            "Your 1,000 playing chips are ready. Settled bonus-chip wagers "
            "progressively unlock remaining value as real chips."
        ),
        "type": "BONUS", "read": False, "created_at": now(),
    }, **kwargs)
    return {"chips": SIGNUP_BONUS_CHIPS, "duplicate": False}


def _invite_code() -> str:
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    return "".join(secrets.choice(alphabet) for _ in range(10))


def _invite_url(invite_code: str) -> str:
    origin = str(
        os.environ.get("PROMOTIONS_PUBLIC_APP_ORIGIN") or "https://chakri.casino"
    ).strip().rstrip("/")
    return f"{origin}/register?invite_code={quote(invite_code, safe='')}"


async def get_or_create_referral_profile(
    user_id: str, *, session=None,
) -> dict[str, Any]:
    kwargs = _session_kwargs(session)
    existing = await db.player_referrals.find_one(
        {"kind": "PROFILE", "user_id": user_id}, {"_id": 0}, **kwargs,
    )
    if existing:
        return existing
    for _ in range(5):
        profile = {
            "id": str(uuid.uuid4()), "kind": "PROFILE", "user_id": user_id,
            "invite_code": _invite_code(), "status": "ACTIVE",
            "policy_version": POLICY_VERSION, "created_at": now(), "updated_at": now(),
        }
        try:
            await db.player_referrals.insert_one(profile, **kwargs)
            profile.pop("_id", None)
            return profile
        except DuplicateKeyError:
            existing = await db.player_referrals.find_one(
                {"kind": "PROFILE", "user_id": user_id}, {"_id": 0}, **kwargs,
            )
            if existing:
                return existing
    raise BonusPolicyError(
        "INVITE_CODE_UNAVAILABLE", "Could not create a referral code.", 503,
    )


async def attach_referral(
    invited_user_id: str, invite_code: str, *, jurisdiction: str,
    consented_at: Any, session=None,
) -> dict[str, Any] | None:
    if not program_enabled():
        return None
    code = str(invite_code or "").strip().upper()
    if not _INVITE_RE.fullmatch(code):
        raise BonusPolicyError("INVALID_INVITE_CODE", "Invite code is invalid.")
    kwargs = _session_kwargs(session)
    existing = await db.player_referrals.find_one(
        {"kind": "RELATIONSHIP", "invited_user_id": invited_user_id},
        {"_id": 0}, **kwargs,
    )
    if existing:
        return existing
    profile = await db.player_referrals.find_one(
        {"kind": "PROFILE", "invite_code": code, "status": "ACTIVE"},
        {"_id": 0}, **kwargs,
    )
    if not profile:
        raise BonusPolicyError("INVITE_CODE_NOT_FOUND", "Invite code was not found.", 404)
    if profile.get("user_id") == invited_user_id:
        raise BonusPolicyError(
            "SELF_REFERRAL_NOT_ALLOWED", "A player cannot refer their own account.", 409,
        )
    relationship = {
        "id": str(uuid.uuid4()), "kind": "RELATIONSHIP",
        "invited_user_id": invited_user_id,
        "inviter_user_id": profile["user_id"],
        "invite_code_used": code, "status": "ACTIVE",
        "fraud_review_status": "CLEARED",
        "jurisdiction": str(jurisdiction or "").strip().upper(),
        "campaign_id": "chakri-first-deposit-referral",
        "campaign_version": 1, "terms_version": POLICY_VERSION,
        "campaign_snapshot": {
            "direct_bps": DIRECT_REFERRAL_BPS,
            "direct_cap_chips": DIRECT_REFERRAL_CAP_CHIPS,
            "second_level_bps": SECOND_LEVEL_REFERRAL_BPS,
        },
        "consented_at": consented_at, "created_at": now(), "updated_at": now(),
    }
    try:
        await db.player_referrals.insert_one(relationship, **kwargs)
    except DuplicateKeyError:
        duplicate = await db.player_referrals.find_one(
            {"kind": "RELATIONSHIP", "invited_user_id": invited_user_id},
            {"_id": 0}, **kwargs,
        )
        if duplicate:
            return duplicate
        raise
    relationship.pop("_id", None)
    return relationship


async def _credit_real_reward(
    user_id: str, chips: int, *, source_key: str, deposit_id: str,
    depositor_user_id: str, level: int, session=None,
) -> dict[str, Any]:
    import financial_wallet as finance
    import ledger

    amount = max(0, int(chips))
    if not amount:
        return {"chips": 0, "duplicate": False}
    movement = await finance.apply_wallet_movement(
        user_id=user_id, kind="REFERRAL_REAL_CHIPS",
        source_key=source_key, idempotency_key=source_key,
        deltas={"available_cash_chips": amount}, mirror_user_delta=amount,
        metadata={
            "deposit_id": deposit_id, "depositor_user_id": depositor_user_id,
            "referral_level": level, "policy_version": POLICY_VERSION,
        }, session=session,
    )
    if movement.get("duplicate"):
        return {"chips": amount, "duplicate": True}
    kwargs = _session_kwargs(session)
    user = await db.users.find_one(
        {"id": user_id}, {"_id": 0, "chip_balance": 1}, **kwargs,
    ) or {}
    digest = hashlib.sha256(source_key.encode("utf-8")).hexdigest()[:40]
    await ledger._write(
        user_id, ledger.BONUS, "CREDIT", amount,
        int(user.get("chip_balance", 0)),
        f"Level {level} first-deposit referral reward", source_key, None,
        event_id=f"referral-reward:{digest}",
        funding_allocation={
            "policy": "REFERRAL_REAL_CHIPS", "policy_version": POLICY_VERSION,
            "cash_chips": amount, "bonus_chips": 0,
            "operation_id": movement["operation_id"],
        }, session=session,
    )
    await db.bonus_referral_rewards.insert_one({
        "id": str(uuid.uuid4()), "source_key": source_key,
        "recipient_user_id": user_id, "depositor_user_id": depositor_user_id,
        "deposit_id": deposit_id, "level": level, "reward_chips": amount,
        "reward_paise": amount * 100, "status": "CREDITED",
        "wallet_operation_id": movement["operation_id"],
        "created_at": now(),
    }, **kwargs)
    await db.notifications.insert_one({
        "id": str(uuid.uuid4()), "user_id": user_id,
        "title": "Referral reward added",
        "body": f"{amount:,} real chips were added for a level {level} first deposit.",
        "type": "REFERRAL", "read": False, "created_at": now(),
    }, **kwargs)
    return {"chips": amount, "duplicate": False}


async def _award_first_deposit_referrals(
    user_id: str, deposit_id: str, chips: int, *, amount_paise: int, session=None,
) -> list[dict[str, Any]]:
    kwargs = _session_kwargs(session)
    first_event = {
        "id": str(uuid.uuid4()), "depositor_user_id": user_id,
        "deposit_id": deposit_id, "amount_paise": int(amount_paise),
        "deposit_chips": int(chips), "created_at": now(),
    }
    try:
        await db.bonus_deposit_events.insert_one(first_event, **kwargs)
    except DuplicateKeyError:
        return []

    direct = await db.player_referrals.find_one(
        {
            "kind": "RELATIONSHIP", "invited_user_id": user_id,
            "status": "ACTIVE", "fraud_review_status": {"$ne": "REJECTED"},
        }, {"_id": 0}, **kwargs,
    )
    if not direct:
        return []
    direct_user = str(direct.get("inviter_user_id") or "")
    if not direct_user or direct_user == user_id:
        return []
    awards = []
    direct_chips = min(
        int(chips) * DIRECT_REFERRAL_BPS // 10_000,
        DIRECT_REFERRAL_CAP_CHIPS,
    )
    if direct_chips:
        awards.append(await _credit_real_reward(
            direct_user, direct_chips,
            source_key=f"referral-first-deposit:{deposit_id}:level-1:{direct_user}",
            deposit_id=deposit_id, depositor_user_id=user_id, level=1,
            session=session,
        ))

    second = await db.player_referrals.find_one(
        {
            "kind": "RELATIONSHIP", "invited_user_id": direct_user,
            "status": "ACTIVE", "fraud_review_status": {"$ne": "REJECTED"},
        }, {"_id": 0}, **kwargs,
    )
    second_user = str((second or {}).get("inviter_user_id") or "")
    second_chips = int(chips) * SECOND_LEVEL_REFERRAL_BPS // 10_000
    if second_user and second_user not in {user_id, direct_user} and second_chips:
        awards.append(await _credit_real_reward(
            second_user, second_chips,
            source_key=f"referral-first-deposit:{deposit_id}:level-2:{second_user}",
            deposit_id=deposit_id, depositor_user_id=user_id, level=2,
            session=session,
        ))
    return awards


async def _award_first_deposit_bonus(
    user_id: str, deposit_id: str, chips: int, *, amount_paise: int, session=None,
) -> dict[str, Any] | None:
    import financial_wallet as finance
    import ledger

    if not FIRST_DEPOSIT_MIN_PAISE <= int(amount_paise) <= FIRST_DEPOSIT_MAX_PAISE:
        return None
    kwargs = _session_kwargs(session)
    if await db.first_deposit_bonus_claims.find_one({"user_id": user_id}, **kwargs):
        return None
    account = await finance._ensure_wallet_account(user_id, session=session)
    if int(account.get("available_bonus_chips", 0)) > 0:
        return None
    # The public promise is INR-denominated: ₹100 => 100 bonus chips and
    # ₹5,000 => 5,000, even if a future cash chip conversion rate changes.
    bonus = min(int(amount_paise) // 100, FIRST_DEPOSIT_MAX_BONUS_CHIPS)
    if bonus <= 0:
        return None
    claim = {
        "id": str(uuid.uuid4()), "user_id": user_id, "deposit_id": deposit_id,
        "amount_paise": int(amount_paise), "bonus_chips": bonus,
        "policy_version": POLICY_VERSION, "created_at": now(),
    }
    try:
        await db.first_deposit_bonus_claims.insert_one(claim, **kwargs)
    except DuplicateKeyError:
        return None
    await ledger.credit_chips(
        user_id, bonus, "100% first deposit bonus (playing chips)",
        ref=f"first-deposit-bonus:{deposit_id}", kind=ledger.BONUS, session=session,
    )
    await db.notifications.insert_one({
        "id": str(uuid.uuid4()), "user_id": user_id,
        "title": "100% deposit bonus added",
        "body": f"{bonus:,} playing chips were added to your bonus balance.",
        "type": "BONUS", "read": False, "created_at": now(),
    }, **kwargs)
    return {"bonus_chips": bonus, "deposit_id": deposit_id}


async def on_deposit_credited(
    user_id: str, deposit_id: str, *, amount_paise: int, chips: int, session=None,
) -> dict[str, Any]:
    """Apply deposit-match and first-deposit referral effects exactly once."""
    # Request handling is enabled only after startup has successfully created
    # the policy's uniqueness indexes.  This also keeps direct unit-test calls
    # and partially started workers on the legacy path instead of touching an
    # unprepared database.
    if not wallet_source_enabled():
        return {"applied": False, "reason": "POLICY_NOT_READY"}
    if not await user_participates(user_id, session=session):
        return {"applied": False, "reason": "NOT_PARTICIPATING"}
    referrals = await _award_first_deposit_referrals(
        user_id, deposit_id, chips, amount_paise=amount_paise, session=session,
    )
    deposit_bonus = await _award_first_deposit_bonus(
        user_id, deposit_id, chips, amount_paise=amount_paise, session=session,
    )
    return {
        "applied": bool(referrals or deposit_bonus),
        "referral_rewards": referrals, "deposit_bonus": deposit_bonus,
    }


async def handle_ledger_event(event: Mapping[str, Any], *, session=None) -> None:
    """Unlock existing restricted value from settled bonus-funded wagers."""
    if not wallet_source_enabled():
        return
    if str(event.get("kind") or "").upper() != "SETTLEMENT":
        return
    if str(event.get("settlement_status") or "").upper() != "SETTLED":
        return
    user_id = str(event.get("user_id") or "")
    if not user_id or not await user_participates(user_id, session=session):
        return
    allocation = dict(event.get("funding_allocation") or {})
    bonus_stake = max(0, int(allocation.get("bonus_chips", 0)))
    source_transaction_id = str(event.get("source_transaction_id") or "")
    if not bonus_stake or not source_transaction_id:
        return

    import financial_wallet as finance

    kwargs = _session_kwargs(session)
    if await db.bonus_wager_conversions.find_one(
        {"source_transaction_id": source_transaction_id}, **kwargs,
    ):
        return
    account = await finance._ensure_wallet_account(user_id, session=session)
    unlock = min(bonus_stake, int(account.get("available_bonus_chips", 0)))
    operation_id = None
    if unlock:
        lots = await finance.allocate_bonus_lots(user_id, unlock, session=session)
        movement = await finance.apply_wallet_movement(
            user_id=user_id, kind="BONUS_WAGER_UNLOCK",
            source_key=f"bonus-wager-unlock:{source_transaction_id}",
            idempotency_key=f"bonus-wager-unlock:{source_transaction_id}",
            deltas={
                "available_bonus_chips": -unlock,
                "available_cash_chips": unlock,
            },
            mirror_user_delta=0,
            metadata={
                "source_transaction_id": source_transaction_id,
                "settlement_event_id": event.get("id"),
                "settled_bonus_stake_chips": bonus_stake,
                "policy_version": POLICY_VERSION,
            },
            bonus_lot_changes=[{
                "lot_id": lot["lot_id"], "delta_chips": -int(lot["chips"]),
            } for lot in lots],
            session=session,
        )
        operation_id = movement.get("operation_id")
    await db.bonus_wager_conversions.insert_one({
        "id": str(uuid.uuid4()), "user_id": user_id,
        "source_transaction_id": source_transaction_id,
        "settlement_event_id": event.get("id"),
        "settled_bonus_stake_chips": bonus_stake,
        "converted_real_chips": unlock, "wallet_operation_id": operation_id,
        "created_at": now(),
    }, **kwargs)


def install_ledger_observer() -> None:
    import ledger
    ledger.register_ledger_observer(handle_ledger_event)


def withdrawal_day(when: datetime | None = None) -> str:
    stamp = when or now()
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=timezone.utc)
    return stamp.astimezone(WITHDRAWAL_TZ).strftime("%Y-%m-%d")


def withdrawal_day_bounds(day: str) -> tuple[datetime, datetime]:
    local = datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=WITHDRAWAL_TZ)
    return local.astimezone(timezone.utc), (local + timedelta(days=1)).astimezone(timezone.utc)


async def _historical_daily_withdrawal_paise(
    user_id: str, day: str, *, session=None,
) -> int:
    start, end = withdrawal_day_bounds(day)
    kwargs = _session_kwargs(session)
    operator_rows = await db.operator_payment_requests.find(
        {
            "user_id": user_id, "kind": "WITHDRAWAL",
            "status": {"$nin": ["REJECTED", "FAILED", "CANCELLED", "EXPIRED"]},
            "created_at": {"$gte": start, "$lt": end},
        }, {"_id": 0, "amount_paise": 1}, **kwargs,
    ).to_list(length=None)
    financial_rows = await db.withdrawal_requests.find(
        {
            "user_id": user_id,
            "status": {"$nin": ["REJECTED", "FAILED", "CANCELLED"]},
            "created_at": {"$gte": start, "$lt": end},
        },
        {"_id": 0, "amount_paise": 1}, **kwargs,
    ).to_list(length=None)
    return sum(
        max(0, int(row.get("amount_paise", 0)))
        for row in [*operator_rows, *financial_rows]
    )


async def reserve_daily_withdrawal(
    user_id: str, request_id: str, amount_paise: int, *, session=None,
) -> dict[str, int | str | bool]:
    """Atomically reserve against the shared ₹500 IST request cap."""
    amount = int(amount_paise)
    if amount <= 0 or amount > DAILY_WITHDRAWAL_LIMIT_PAISE:
        raise BonusPolicyError(
            "DAILY_WITHDRAWAL_LIMIT",
            "Withdrawal requests are limited to ₹500 per day.", 409,
            meta={"daily_limit_paise": DAILY_WITHDRAWAL_LIMIT_PAISE},
        )
    day = withdrawal_day()
    guard_id = f"{user_id}:{day}"
    kwargs = _session_kwargs(session)
    guard = await db.withdrawal_daily_guards.find_one({"_id": guard_id}, **kwargs)
    if not guard:
        historical = await _historical_daily_withdrawal_paise(
            user_id, day, session=session,
        )
        try:
            await db.withdrawal_daily_guards.insert_one({
                "_id": guard_id, "user_id": user_id, "withdrawal_day": day,
                "used_paise": historical, "request_ids": [],
                "created_at": now(), "updated_at": now(),
            }, **kwargs)
        except DuplicateKeyError:
            pass
    existing = await db.withdrawal_daily_guards.find_one(
        {"_id": guard_id, "request_ids": request_id}, **kwargs,
    )
    if existing:
        used = int(existing.get("used_paise", 0))
        return {
            "withdrawal_day": day, "used_paise": used,
            "remaining_paise": max(0, DAILY_WITHDRAWAL_LIMIT_PAISE - used),
            "duplicate": True,
        }
    updated = await db.withdrawal_daily_guards.find_one_and_update(
        {
            "_id": guard_id,
            "used_paise": {"$lte": DAILY_WITHDRAWAL_LIMIT_PAISE - amount},
            "request_ids": {"$ne": request_id},
        },
        {
            "$inc": {"used_paise": amount},
            "$push": {"request_ids": request_id},
            "$set": {"updated_at": now()},
        },
        return_document=ReturnDocument.AFTER, **kwargs,
    )
    if not updated:
        current = await db.withdrawal_daily_guards.find_one({"_id": guard_id}, **kwargs) or {}
        used = int(current.get("used_paise", 0))
        raise BonusPolicyError(
            "DAILY_WITHDRAWAL_LIMIT",
            "Withdrawal requests are limited to ₹500 per day.", 409,
            meta={
                "daily_limit_paise": DAILY_WITHDRAWAL_LIMIT_PAISE,
                "used_paise": used,
                "remaining_paise": max(0, DAILY_WITHDRAWAL_LIMIT_PAISE - used),
                "withdrawal_day": day,
            },
        )
    used = int(updated.get("used_paise", 0))
    return {
        "withdrawal_day": day, "used_paise": used,
        "remaining_paise": max(0, DAILY_WITHDRAWAL_LIMIT_PAISE - used),
        "duplicate": False,
    }


async def release_daily_withdrawal(
    user_id: str, request_id: str, amount_paise: int, *, session=None,
) -> bool:
    """Release a reservation when a withdrawal is rejected or fails unpaid."""
    amount = max(0, int(amount_paise))
    if not amount:
        return False
    updated = await db.withdrawal_daily_guards.find_one_and_update(
        {
            "user_id": user_id,
            "request_ids": request_id,
            "used_paise": {"$gte": amount},
        },
        {
            "$inc": {"used_paise": -amount},
            "$pull": {"request_ids": request_id},
            "$set": {"updated_at": now()},
        },
        return_document=ReturnDocument.AFTER,
        **_session_kwargs(session),
    )
    return bool(updated)


async def daily_withdrawal_state(user_id: str) -> dict[str, int | str]:
    day = withdrawal_day()
    guard = await db.withdrawal_daily_guards.find_one(
        {"_id": f"{user_id}:{day}"}, {"_id": 0, "used_paise": 1},
    )
    used = int((guard or {}).get("used_paise", 0))
    if not guard:
        used = await _historical_daily_withdrawal_paise(user_id, day)
    return {
        "withdrawal_day": day,
        "daily_limit_paise": DAILY_WITHDRAWAL_LIMIT_PAISE,
        "used_paise": used,
        "remaining_paise": max(0, DAILY_WITHDRAWAL_LIMIT_PAISE - used),
    }


async def public_state(user_id: str) -> dict[str, Any]:
    import financial_wallet as finance

    participant = await user_participates(user_id)
    wallet = await finance.wallet_public(user_id)
    claim = await db.first_deposit_bonus_claims.find_one(
        {"user_id": user_id}, {"_id": 0},
    )
    conversions = await db.bonus_wager_conversions.find(
        {"user_id": user_id}, {"_id": 0},
    ).to_list(length=None)
    bonus_remaining = max(0, int(wallet.get("bonus_chips", 0)))
    offer_eligible = bool(participant and not claim and bonus_remaining == 0)
    withdrawal = await daily_withdrawal_state(user_id)
    return {
        "enabled": program_enabled(), "participating": participant,
        "policy_version": POLICY_VERSION,
        "signup_bonus_chips": SIGNUP_BONUS_CHIPS,
        "conversion": {
            "settled_bonus_wager_chips": sum(
                int(row.get("settled_bonus_stake_chips", 0)) for row in conversions
            ),
            "converted_real_chips": sum(
                int(row.get("converted_real_chips", 0)) for row in conversions
            ),
            "remaining_playing_chips": bonus_remaining,
            "rule": "Each settled bonus chip wagered unlocks up to one remaining playing chip as a real chip.",
        },
        "first_deposit_offer": {
            "percentage": 100,
            "minimum_paise": FIRST_DEPOSIT_MIN_PAISE,
            "maximum_paise": FIRST_DEPOSIT_MAX_PAISE,
            "maximum_bonus_chips": FIRST_DEPOSIT_MAX_BONUS_CHIPS,
            "eligible": offer_eligible,
            "claimed": bool(claim),
            "status": (
                "CLAIMED" if claim else
                "AVAILABLE" if offer_eligible else
                "FINISH_PLAYING_CHIPS" if participant else "NOT_PARTICIPATING"
            ),
        },
        "referral": {
            "automatic_real_chips": True,
            "direct_percent": 10,
            "direct_cap_chips": DIRECT_REFERRAL_CAP_CHIPS,
            "second_level_percent": 5,
            "trigger": "REFERRED_PLAYER_FIRST_DEPOSIT",
        },
        "withdrawal": withdrawal,
    }


async def referral_summary(user_id: str) -> dict[str, Any]:
    profile = await get_or_create_referral_profile(user_id)
    rows = await db.bonus_referral_rewards.find(
        {"recipient_user_id": user_id}, {"_id": 0},
    ).sort("created_at", -1).to_list(length=250)
    total = sum(int(row.get("reward_chips", 0)) for row in rows)
    tasks = [{
        "id": row.get("id"),
        "task_key": f"LEVEL_{int(row.get('level', 1))}_FIRST_DEPOSIT",
        "task_type": "FIRST_DEPOSIT_REFERRAL",
        "title": (
            "Direct referral first-deposit reward"
            if int(row.get("level", 1)) == 1
            else "Second-level first-deposit reward"
        ),
        "description": "Automatically credited as withdrawable real chips.",
        "status": "CLAIMED", "reward_type": "REAL_CHIPS",
        "reward_chips": int(row.get("reward_chips", 0)),
        "reward_paise": int(row.get("reward_paise", 0)),
        "created_at": row.get("created_at"),
    } for row in rows]
    public_profile = {
        **profile, "invite_url": _invite_url(str(profile["invite_code"])),
        "automatic_rewards": True,
        "direct_percent": 10, "direct_cap_chips": DIRECT_REFERRAL_CAP_CHIPS,
        "second_level_percent": 5,
    }
    return {
        "referral": public_profile, "tasks": tasks,
        "rewards": {
            "verified_amount": total, "pending_amount": 0,
            "claim_threshold": 0, "remaining": 0,
            "progress_percent": 100 if total else 0,
            "claimable": False, "disabled_reason": "AUTOMATIC_REAL_CHIP_CREDIT",
        },
    }
