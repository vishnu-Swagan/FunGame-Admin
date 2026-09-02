"""Free Cash task wallet — referral rewards, claim at threshold."""
from __future__ import annotations

import hashlib
import random
import uuid
from datetime import datetime, timezone
from typing import Any, Mapping, Optional

from db import db
from fastapi import HTTPException

CLAIM_INR = 200.0
REGISTER_MIN, REGISTER_MAX = 0.01, 20.00
DEPOSIT_MIN, DEPOSIT_MAX = 0.01, 20.00


def _now():
    return datetime.now(timezone.utc)


def _session_kwargs(session=None):
    return {"session": session} if session is not None else {}


def _paise(amount_inr: float) -> int:
    return int(round(float(amount_inr) * 100))


def _rand_paise(lo: float, hi: float) -> int:
    return random.randint(_paise(lo), _paise(hi))


async def get_settings() -> dict[str, Any]:
    row = await db.promo_settings.find_one({"id": "promo-main"}, {"_id": 0}) or {}
    return {
        "free_cash_claim_inr": float(row.get("free_cash_claim_inr") or CLAIM_INR),
        "free_cash_register_min": float(row.get("free_cash_register_min") or REGISTER_MIN),
        "free_cash_register_max": float(row.get("free_cash_register_max") or REGISTER_MAX),
        "free_cash_deposit_min": float(row.get("free_cash_deposit_min") or DEPOSIT_MIN),
        "free_cash_deposit_max": float(row.get("free_cash_deposit_max") or DEPOSIT_MAX),
    }


async def _wallet(user_id: str, session=None) -> dict[str, Any]:
    kwargs = _session_kwargs(session)
    row = await db.free_cash_wallets.find_one({"user_id": user_id}, {"_id": 0}, **kwargs)
    if row:
        return row
    doc = {
        "id": str(uuid.uuid4()),
        "user_id": user_id,
        "balance_paise": 0,
        "lifetime_paise": 0,
        "claimed_paise": 0,
        "invite_code": (user_id.replace("-", "")[:8] or "chakri").upper(),
        "created_at": _now(),
        "updated_at": _now(),
    }
    await db.free_cash_wallets.update_one(
        {"user_id": user_id}, {"$setOnInsert": doc}, upsert=True, **kwargs,
    )
    return await db.free_cash_wallets.find_one({"user_id": user_id}, {"_id": 0}, **kwargs) or doc


def device_fingerprint(raw: str | None) -> str:
    value = (raw or "").strip()
    if len(value) < 8:
        return ""
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


async def credit(user_id: str, paise: int, reason: str, source_id: str, *, session=None) -> dict[str, Any]:
    if paise <= 0:
        return await public_state(user_id)
    kwargs = _session_kwargs(session)
    await _wallet(user_id, session=session)
    await db.free_cash_ledger.update_one(
        {"source_id": source_id},
        {"$setOnInsert": {
            "id": str(uuid.uuid4()), "user_id": user_id, "paise": int(paise),
            "reason": reason, "source_id": source_id, "created_at": _now(),
        }},
        upsert=True, **kwargs,
    )
    inserted = await db.free_cash_ledger.find_one({"source_id": source_id}, **kwargs)
    if inserted and inserted.get("user_id") == user_id:
        # Only bump balance when this source_id is new for this user.
        existing_count = await db.free_cash_ledger.count_documents({"source_id": source_id}, **kwargs)
        if existing_count == 1:
            await db.free_cash_wallets.update_one(
                {"user_id": user_id},
                {"$inc": {"balance_paise": int(paise), "lifetime_paise": int(paise)},
                 "$set": {"updated_at": _now()}},
                **kwargs,
            )
    return await public_state(user_id)


async def on_player_registered(user: Mapping[str, Any], device_id: str | None) -> None:
    referral = str(user.get("referral_code") or "").strip()
    if not referral:
        return
    inviter = await db.free_cash_wallets.find_one({"invite_code": referral.upper()}, {"_id": 0})
    if not inviter:
        # Also match users who share the code as username prefix.
        inviter = await db.users.find_one(
            {"id": {"$ne": user.get("id")}, "referral_invite_code": referral.upper()},
            {"_id": 0, "id": 1},
        )
        if inviter:
            inviter = {"user_id": inviter["id"]}
    if not inviter or inviter.get("user_id") == user.get("id"):
        return
    fp = device_fingerprint(device_id)
    if fp:
        taken = await db.free_cash_devices.find_one({"fingerprint": fp})
        if taken:
            return
        await db.free_cash_devices.update_one(
            {"fingerprint": fp},
            {"$setOnInsert": {
                "fingerprint": fp, "user_id": user.get("id"),
                "inviter_id": inviter["user_id"], "created_at": _now(),
            }},
            upsert=True,
        )
        stored = await db.free_cash_devices.find_one({"fingerprint": fp})
        if stored and stored.get("user_id") != user.get("id"):
            return
    elif not fp:
        return  # new-device rule: no fingerprint, no reward
    settings = await get_settings()
    paise = _rand_paise(settings["free_cash_register_min"], settings["free_cash_register_max"])
    await credit(
        inviter["user_id"], paise, "FRIEND_REGISTER",
        f"register:{user.get('id')}",
    )


async def on_friend_deposit(depositor_id: str, deposit_id: str) -> None:
    link = await db.free_cash_devices.find_one({"user_id": depositor_id}, {"_id": 0})
    if not link or not link.get("inviter_id"):
        user = await db.users.find_one({"id": depositor_id}, {"_id": 0, "referral_code": 1})
        if not user or not user.get("referral_code"):
            return
        inviter = await db.free_cash_wallets.find_one(
            {"invite_code": str(user["referral_code"]).upper()}, {"_id": 0, "user_id": 1},
        )
        if not inviter:
            return
        inviter_id = inviter["user_id"]
    else:
        inviter_id = link["inviter_id"]
    if inviter_id == depositor_id:
        return
    settings = await get_settings()
    paise = _rand_paise(settings["free_cash_deposit_min"], settings["free_cash_deposit_max"])
    await credit(inviter_id, paise, "FRIEND_DEPOSIT", f"deposit:{deposit_id}")


async def claim(user_id: str) -> dict[str, Any]:
    import ledger
    import wager
    settings = await get_settings()
    threshold = _paise(settings["free_cash_claim_inr"])
    wallet = await _wallet(user_id)
    if int(wallet.get("balance_paise") or 0) < threshold:
        need = threshold - int(wallet.get("balance_paise") or 0)
        raise HTTPException(status_code=409, detail={
            "code": "FREE_CASH_THRESHOLD",
            "message": f"Only need ₹{need/100:,.2f} to get ₹{settings['free_cash_claim_inr']:.0f}.",
            "remaining_paise": need,
        })
    result = await db.free_cash_wallets.find_one_and_update(
        {"user_id": user_id, "balance_paise": {"$gte": threshold}},
        {"$inc": {"balance_paise": -threshold, "claimed_paise": threshold}, "$set": {"updated_at": _now()}},
        return_document=True,
    )
    if not result:
        raise HTTPException(status_code=409, detail={
            "code": "FREE_CASH_THRESHOLD",
            "message": "Free Cash is below the claim amount.",
        })
    chips = max(1, threshold // 100 * wager.chips_per_inr())
    await ledger.credit_chips(
        user_id, chips, "Free Cash claim", ref=f"free-cash-claim:{uuid.uuid4()}", kind=ledger.BONUS,
    )
    from datetime import timedelta
    claim_source = f"free-cash:{uuid.uuid4()}"
    now = _now()
    await db.bonus_campaigns.insert_one({
        "id": str(uuid.uuid4()),
        "user_id": user_id,
        "source_id": claim_source,
        "bonus_chips": chips,
        "required_chips": chips,
        "remaining_chips": chips,
        "status": "ACTIVE",
        "starts_at": now,
        "expires_at": now + timedelta(hours=84),
        "created_at": now,
        "updated_at": now,
    })
    return await public_state(user_id)


async def public_state(user_id: str) -> dict[str, Any]:
    settings = await get_settings()
    wallet = await _wallet(user_id)
    balance = int(wallet.get("balance_paise") or 0)
    threshold = _paise(settings["free_cash_claim_inr"])
    need = max(0, threshold - balance)
    pct = 0 if threshold <= 0 else min(100, int(balance * 100 / threshold))
    origin = str(
        __import__("os").environ.get("PAYMENT_RETURN_URL", "https://chakri.casino")
    )
    from urllib.parse import quote, urlsplit
    host = urlsplit(origin)
    share_base = f"{host.scheme}://{host.hostname}/register"
    code = wallet.get("invite_code") or "CHAKRI"
    share_url = f"{share_base}?ref={code}"
    return {
        "balance_paise": balance,
        "threshold_paise": threshold,
        "remaining_paise": need,
        "progress_pct": pct,
        "can_claim": balance >= threshold,
        "invite_code": code,
        "share_url": share_url,
        "whatsapp_url": f"https://wa.me/?text={quote('Join me on Chakri Casino and we both get Free Cash: ' + share_url)}",
        "copy": f"Only need ₹{need/100:,.2f} to get ₹{threshold/100:,.0f}" if need else f"Claim ₹{threshold/100:,.0f} Free Cash",
        "rules": [
            f"You can get cash when your activated cash reaches ₹{threshold/100:,.2f}.",
            f"After your friends register accounts, you will randomly get ₹{settings['free_cash_register_min']:.2f}~₹{settings['free_cash_register_max']:.2f}.",
            f"After your friends deposit, you will randomly get ₹{settings['free_cash_deposit_min']:.2f}~₹{settings['free_cash_deposit_max']:.2f} (every time).",
            "Only inviting a new device user is valid.",
        ],
    }
