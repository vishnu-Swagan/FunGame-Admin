"""Deposit wager lock and time-boxed bonus campaigns.

Players cannot cash out until settled STAKE bets cover each deposit (default 1x).
A separate bonus campaign (cash-guarantee) may sit on top with a countdown.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Mapping, Optional

from db import db
from fastapi import HTTPException

SETTINGS_ID = "promo-main"
DEFAULTS = {
    "deposit_wager_multiplier": 1.0,
    "bonus_amount_inr": 500.0,
    "bonus_wager_multiplier": 30.0,
    "bonus_duration_hours": 84,
    "bonus_on": "first_deposit",  # first_deposit | every_deposit | off
}


class WagerBlocked(HTTPException):
    def __init__(self, remaining_chips: int, remaining_paise: int):
        rupees = remaining_paise / 100
        super().__init__(
            status_code=409,
            detail={
                "code": "WAGER_REMAINING",
                "message": (
                    f"You still need to wager ₹{rupees:,.2f} from your deposits "
                    "before you can request a withdrawal."
                ),
                "remaining_chips": int(remaining_chips),
                "remaining_paise": int(remaining_paise),
            },
        )


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _session_kwargs(session=None) -> dict[str, Any]:
    return {"session": session} if session is not None else {}


def chips_per_inr() -> int:
    try:
        from operator_rail import hosted_upi_chips_per_inr
        return max(1, int(hosted_upi_chips_per_inr()))
    except Exception:
        try:
            return max(1, int(os.environ.get("UPI_CHIPS_PER_INR") or os.environ.get("CHIPS_PER_INR") or 1))
        except (TypeError, ValueError):
            return 1


def chips_to_paise(chips: int) -> int:
    rate = chips_per_inr()
    return int(chips) * 100 // rate


def inr_to_chips(amount_inr: float) -> int:
    return int(round(float(amount_inr) * chips_per_inr()))


async def get_settings() -> dict[str, Any]:
    row = await db.promo_settings.find_one({"id": SETTINGS_ID}, {"_id": 0})
    merged = dict(DEFAULTS)
    if row:
        merged.update({k: row[k] for k in DEFAULTS if k in row})
    return merged


async def save_settings(patch: Mapping[str, Any], actor: str) -> dict[str, Any]:
    current = await get_settings()
    allowed = dict(DEFAULTS)
    for key, default in allowed.items():
        if key not in patch:
            continue
        value = patch[key]
        if key == "bonus_on":
            value = str(value or "off").strip().lower()
            if value not in {"first_deposit", "every_deposit", "off"}:
                raise HTTPException(status_code=400, detail={"code": "PROMO_SETTING_INVALID", "message": "bonus_on is invalid."})
            current[key] = value
            continue
        if key == "bonus_duration_hours":
            current[key] = max(1, min(int(value), 24 * 30))
            continue
        current[key] = max(0.0, float(value))
    current.update({"id": SETTINGS_ID, "updated_at": _now(), "updated_by": actor})
    await db.promo_settings.update_one({"id": SETTINGS_ID}, {"$set": current}, upsert=True)
    return await get_settings()


async def remaining_deposit_wager(user_id: str, session=None) -> int:
    kwargs = _session_kwargs(session)
    cursor = db.wager_buckets.find(
        {"user_id": user_id, "kind": "DEPOSIT", "remaining_chips": {"$gt": 0}},
        {"_id": 0, "remaining_chips": 1},
        **kwargs,
    )
    total = 0
    async for row in cursor:
        total += int(row.get("remaining_chips") or 0)
    return total


async def require_clear_for_withdrawal(user_id: str, session=None) -> None:
    remaining = await remaining_deposit_wager(user_id, session=session)
    if remaining > 0:
        raise WagerBlocked(remaining, chips_to_paise(remaining))


async def open_deposit_bucket(
    user_id: str, chips: int, source_id: str, *, session=None,
) -> dict[str, Any]:
    settings = await get_settings()
    required = max(0, int(round(int(chips) * float(settings["deposit_wager_multiplier"]))))
    doc = {
        "id": str(uuid.uuid4()),
        "user_id": user_id,
        "kind": "DEPOSIT",
        "source_id": source_id,
        "required_chips": required,
        "remaining_chips": required,
        "created_at": _now(),
        "updated_at": _now(),
    }
    await db.wager_buckets.update_one(
        {"user_id": user_id, "kind": "DEPOSIT", "source_id": source_id},
        {"$setOnInsert": doc},
        upsert=True,
        **_session_kwargs(session),
    )
    bonus = await maybe_open_bonus_campaign(user_id, int(chips), source_id, session=session)
    return {"bucket": doc, "bonus": bonus}


async def maybe_open_bonus_campaign(
    user_id: str, deposit_chips: int, source_id: str, *, session=None,
) -> Optional[dict[str, Any]]:
    settings = await get_settings()
    mode = str(settings.get("bonus_on") or "off")
    if mode == "off" or float(settings.get("bonus_amount_inr") or 0) <= 0:
        return None
    kwargs = _session_kwargs(session)
    if mode == "first_deposit":
        prior = await db.bonus_campaigns.find_one({"user_id": user_id}, {"_id": 1}, **kwargs)
        if prior:
            return None
    bonus_chips = inr_to_chips(float(settings["bonus_amount_inr"]))
    required = max(0, int(round(bonus_chips * float(settings["bonus_wager_multiplier"]))))
    hours = int(settings["bonus_duration_hours"])
    now = _now()
    doc = {
        "id": str(uuid.uuid4()),
        "user_id": user_id,
        "source_id": source_id,
        "bonus_chips": bonus_chips,
        "required_chips": required,
        "remaining_chips": required,
        "status": "ACTIVE",
        "starts_at": now,
        "expires_at": now + timedelta(hours=hours),
        "created_at": now,
        "updated_at": now,
    }
    await db.bonus_campaigns.update_one(
        {"user_id": user_id, "source_id": source_id},
        {"$setOnInsert": doc},
        upsert=True,
        **kwargs,
    )
    return doc


async def consume_stake(user_id: str, chips: int, *, session=None) -> None:
    amount = int(chips)
    if amount <= 0:
        return
    kwargs = _session_kwargs(session)
    buckets = db.wager_buckets.find(
        {"user_id": user_id, "kind": "DEPOSIT", "remaining_chips": {"$gt": 0}},
        **kwargs,
    ).sort("created_at", 1)
    async for bucket in buckets:
        if amount <= 0:
            break
        take = min(amount, int(bucket.get("remaining_chips") or 0))
        await db.wager_buckets.update_one(
            {"id": bucket["id"], "remaining_chips": {"$gte": take}},
            {"$inc": {"remaining_chips": -take}, "$set": {"updated_at": _now()}},
            **kwargs,
        )
        amount -= take
    campaign = await db.bonus_campaigns.find_one(
        {"user_id": user_id, "status": "ACTIVE", "expires_at": {"$gt": _now()}},
        **kwargs,
    )
    if campaign and amount >= 0:
        leftover = int(campaign.get("remaining_chips") or 0)
        take = min(int(chips), leftover)  # campaign also counts the same stake
        take = min(int(campaign.get("remaining_chips") or 0), int(chips))
        remaining = leftover - min(leftover, int(chips))
        status = "ACTIVE" if remaining > 0 else "COMPLETED"
        await db.bonus_campaigns.update_one(
            {"id": campaign["id"], "status": "ACTIVE"},
            {"$set": {"remaining_chips": max(0, remaining), "status": status, "updated_at": _now()}},
            **kwargs,
        )


async def expire_due_campaigns(user_id: str | None = None, *, session=None) -> int:
    kwargs = _session_kwargs(session)
    query: dict[str, Any] = {"status": "ACTIVE", "expires_at": {"$lte": _now()}}
    if user_id:
        query["user_id"] = user_id
    result = await db.bonus_campaigns.update_many(
        query, {"$set": {"status": "EXPIRED", "updated_at": _now()}}, **kwargs,
    )
    return int(getattr(result, "modified_count", 0) or 0)


def _countdown(expires_at: datetime) -> dict[str, Any]:
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    delta = expires_at - _now()
    seconds = max(0, int(delta.total_seconds()))
    days, rem = divmod(seconds, 86400)
    hours, rem = divmod(rem, 3600)
    minutes = rem // 60
    return {
        "days": days,
        "hours": hours,
        "minutes": minutes,
        "label": f"{days}d {hours}h" if days else (f"{hours}h {minutes}m" if hours else f"{minutes}m"),
        "expires_at": expires_at.isoformat(),
        "seconds": seconds,
    }


async def public_state(user_id: str) -> dict[str, Any]:
    await expire_due_campaigns(user_id)
    remaining = await remaining_deposit_wager(user_id)
    remaining_paise = chips_to_paise(remaining)
    campaign = await db.bonus_campaigns.find_one(
        {"user_id": user_id, "status": "ACTIVE", "expires_at": {"$gt": _now()}},
        {"_id": 0},
    )
    bonus = None
    overlay = None
    if campaign:
        required = int(campaign.get("required_chips") or 0)
        left = int(campaign.get("remaining_chips") or 0)
        progressed = max(0, required - left)
        pct = 0 if required <= 0 else min(100, int(progressed * 100 / required))
        countdown = _countdown(campaign["expires_at"])
        bonus_paise = chips_to_paise(int(campaign.get("bonus_chips") or 0))
        target_paise = chips_to_paise(required)
        left_paise = chips_to_paise(left)
        bonus = {
            "id": campaign.get("id"),
            "bonus_chips": int(campaign.get("bonus_chips") or 0),
            "bonus_paise": bonus_paise,
            "required_chips": required,
            "remaining_chips": left,
            "required_paise": target_paise,
            "remaining_paise": left_paise,
            "progress_pct": pct,
            "countdown": countdown,
            "copy": (
                f"You have {countdown['label']} to wager "
                f"₹{target_paise/100:,.2f} to get guaranteed ₹{bonus_paise/100:,.2f} cash."
            ),
        }
        overlay = dict(bonus)
        overlay["show_fullscreen"] = True
    return {
        "deposit_wager": {
            "remaining_chips": remaining,
            "remaining_paise": remaining_paise,
            "cleared": remaining <= 0,
            "copy": (
                "Withdrawal unlocked."
                if remaining <= 0
                else f"Wager ₹{remaining_paise/100:,.2f} more from your deposits to unlock withdrawal."
            ),
        },
        "bonus": bonus,
        "overlay": overlay,
        "settings": await get_settings(),
    }


async def overlay_for_deposit(user_id: str, source_id: str) -> Optional[dict[str, Any]]:
    await expire_due_campaigns(user_id)
    campaign = await db.bonus_campaigns.find_one(
        {"user_id": user_id, "source_id": source_id}, {"_id": 0},
    )
    state = await public_state(user_id)
    if campaign and campaign.get("status") == "ACTIVE":
        return state.get("overlay")
    return state.get("overlay")
