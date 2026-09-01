"""Admin-reviewed player payment requests.

This rail lets players save bank details and submit buy/withdraw requests
while REAL_MONEY_ENABLED / PAYMENTS_V2 / GAME_WALLET_INTEGRATION_READY stay
fail-closed. Requests appear on the Admin deposits and withdrawals queues.
Wallet credit or debit happens only when an administrator approves.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Mapping

from fastapi import HTTPException
from pymongo import ReturnDocument

import ledger
from ledger import InsufficientChips
from db import db


COLLECTION = "operator_payment_requests"

OPERATOR_LIMITS = {
    "chips_per_inr": 1,
    "min_deposit_paise": 50_000,
    "max_deposit_paise": 10_000_000,
    "min_withdrawal_paise": 100_000,
    "min_withdrawal_chips": 1_000,
    "max_withdrawal_chips": 1_000_000,
}


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _crm_method(row: Mapping[str, Any], *, kind: str) -> dict[str, Any]:
    return {
        "code": row.get("code") or row.get("agent_type") or row.get("agentType"),
        "name": row.get("display_name") or row.get("agent_name") or row.get("agentName"),
        "category": row.get("category") or row.get("agent_type") or row.get("agentType"),
        "kind": kind,
    }


async def crm_payment_flags() -> dict[str, Any]:
    """Player money actions follow CRM payment-gateway settings, not env flags."""
    settings = await db.payment_platform_settings.find_one({}, {"_id": 0}) or {}
    platform_deposits = bool(settings.get("deposits_enabled") or settings.get("depositsEnabled"))
    platform_withdrawals = bool(settings.get("withdrawals_enabled") or settings.get("withdrawalsEnabled"))
    auto_deposits = bool(settings.get("deposit_auto_approve") or settings.get("depositAutoApprove"))
    auto_withdrawals = bool(settings.get("withdrawal_auto_approve") or settings.get("withdrawalAutoApprove"))

    gateways = await db.payment_gateways.find(
        {"$or": [{"deposits_enabled": True}, {"withdrawals_enabled": True}]},
        {
            "_id": 0, "code": 1, "display_name": 1, "category": 1,
            "deposits_enabled": 1, "withdrawals_enabled": 1,
            "auto_approve_deposits": 1, "auto_approve_withdrawals": 1,
        },
    ).to_list(200)
    deposit_gateways = [row for row in gateways if row.get("deposits_enabled")]
    withdrawal_gateways = [row for row in gateways if row.get("withdrawals_enabled")]
    auto_deposits = auto_deposits or any(row.get("auto_approve_deposits") for row in deposit_gateways)
    auto_withdrawals = auto_withdrawals or any(row.get("auto_approve_withdrawals") for row in withdrawal_gateways)

    agents = await db.payment_local_agents.find(
        {"$or": [{"deposit_enabled": True}, {"withdrawal_enabled": True}, {"depositEnabled": True}, {"withdrawalEnabled": True}]},
        {"_id": 0, "agent_type": 1, "agentType": 1, "agent_name": 1, "agentName": 1,
         "deposit_enabled": 1, "depositEnabled": 1, "withdrawal_enabled": 1, "withdrawalEnabled": 1},
    ).to_list(200)
    deposit_agents = [row for row in agents if row.get("deposit_enabled") or row.get("depositEnabled")]
    withdrawal_agents = [row for row in agents if row.get("withdrawal_enabled") or row.get("withdrawalEnabled")]

    deposits_enabled = platform_deposits or bool(deposit_gateways) or bool(deposit_agents)
    withdrawals_enabled = platform_withdrawals or bool(withdrawal_gateways) or bool(withdrawal_agents)
    methods = [_crm_method(row, kind="DEPOSIT") for row in deposit_gateways + deposit_agents]
    return {
        "enabled": deposits_enabled or withdrawals_enabled,
        "rail": "CRM",
        "deposits_enabled": deposits_enabled,
        "withdrawals_enabled": withdrawals_enabled,
        "auto_approve_deposits": bool(auto_deposits) and deposits_enabled,
        "auto_approve_withdrawals": bool(auto_withdrawals) and withdrawals_enabled,
        "methods": methods,
        "limits": dict(OPERATOR_LIMITS),
    }


async def operator_status() -> dict[str, Any]:
    return await crm_payment_flags()


async def require_crm_feature(kind: str) -> dict[str, Any]:
    flags = await crm_payment_flags()
    wanted = str(kind or "").upper()
    if wanted == "DEPOSIT" and not flags["deposits_enabled"]:
        raise HTTPException(status_code=403, detail={
            "code": "CRM_DEPOSITS_DISABLED",
            "message": "Buy Chips opens after deposits are enabled in Admin payment settings.",
        })
    if wanted == "WITHDRAWAL" and not flags["withdrawals_enabled"]:
        raise HTTPException(status_code=403, detail={
            "code": "CRM_WITHDRAWALS_DISABLED",
            "message": "Withdrawals open after they are enabled in Admin payment settings.",
        })
    return flags


def request_dto(row: Mapping[str, Any] | None) -> dict[str, Any]:
    row = row or {}
    kind = str(row.get("kind") or "").upper()
    return {
        "id": row.get("id"),
        "user_id": row.get("user_id"),
        "user_email": row.get("user_email"),
        "kind": kind,
        "amount_paise": int(row.get("amount_paise") or 0),
        "chips": int(row.get("chips") or 0),
        "status": row.get("status") or "PENDING",
        "bank_detail_id": row.get("bank_detail_id"),
        "bank_name": row.get("bank_name"),
        "account_number_masked": row.get("account_number_masked"),
        "note": row.get("note") or "",
        "admin_note": row.get("admin_note") or "",
        "source": "ADMIN_REVIEW",
        "created_at": row.get("created_at"),
        "resolved_at": row.get("resolved_at"),
        "resolved_by": row.get("resolved_by"),
    }


def _chips_for_paise(amount_paise: int) -> int:
    return (int(amount_paise) * OPERATOR_LIMITS["chips_per_inr"]) // 100


def _created_sort_key(row: Mapping[str, Any]) -> float:
    value = row.get("created_at")
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.timestamp()
    return 0.0


def sort_newest(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(rows, key=_created_sort_key, reverse=True)


def as_player_deposit(row: Mapping[str, Any]) -> dict[str, Any]:
    dto = request_dto(row)
    return {
        "id": dto["id"],
        "status": dto["status"],
        "amount_paise": dto["amount_paise"],
        "currency": "INR",
        "chips": dto["chips"],
        "source": "ADMIN_REVIEW",
        "created_at": dto["created_at"],
        "updated_at": dto["resolved_at"],
    }


def as_player_withdrawal(row: Mapping[str, Any]) -> dict[str, Any]:
    dto = request_dto(row)
    status = str(dto["status"] or "PENDING").upper()
    display = "PENDING" if status in {"PENDING", "PROCESSING"} else status
    return {
        "id": dto["id"],
        "status": display,
        "amount_chips": dto["chips"],
        "amount_paise": dto["amount_paise"],
        "currency": "INR",
        "bank_detail": {
            "bank_name": dto["bank_name"],
            "account_number_masked": dto["account_number_masked"],
        },
        "source": "ADMIN_REVIEW",
        "created_at": dto["created_at"],
        "updated_at": dto["resolved_at"],
    }


def as_admin_deposit(row: Mapping[str, Any]) -> dict[str, Any]:
    dto = request_dto(row)
    return {
        **as_player_deposit(row),
        "user_id": dto["user_id"],
        "user_email": dto["user_email"],
        "provider_order_id": "ADMIN_REVIEW",
        "provider_reference": None,
        "admin_note": dto["admin_note"],
        "note": dto["note"],
    }


def as_admin_withdrawal(row: Mapping[str, Any]) -> dict[str, Any]:
    dto = request_dto(row)
    status = str(dto["status"] or "PENDING").upper()
    player = as_player_withdrawal(row)
    return {
        **player,
        "internal_status": status,
        "user_id": dto["user_id"],
        "user_email": dto["user_email"],
        "admin_note": dto["admin_note"],
        "note": dto["note"],
    }


async def has_open_withdrawal(user_id: str, method_id: str) -> bool:
    row = await db[COLLECTION].find_one({
        "user_id": user_id,
        "kind": "WITHDRAWAL",
        "bank_detail_id": method_id,
        "status": {"$in": ["PENDING", "PROCESSING"]},
    }, {"_id": 0, "id": 1})
    return bool(row)


def _require_amount(kind: str, amount_paise: int, chips: int | None = None) -> tuple[int, int]:
    paise = int(amount_paise)
    resolved_chips = int(chips) if chips is not None else _chips_for_paise(paise)
    if kind == "DEPOSIT":
        if paise < OPERATOR_LIMITS["min_deposit_paise"] or paise > OPERATOR_LIMITS["max_deposit_paise"]:
            raise HTTPException(status_code=400, detail={
                "code": "OPERATOR_AMOUNT_INVALID",
                "message": "Enter a buy amount inside the published operator limits.",
            })
    else:
        if (
            paise < OPERATOR_LIMITS["min_withdrawal_paise"]
            or resolved_chips < OPERATOR_LIMITS["min_withdrawal_chips"]
            or resolved_chips > OPERATOR_LIMITS["max_withdrawal_chips"]
        ):
            raise HTTPException(status_code=400, detail={
                "code": "OPERATOR_AMOUNT_INVALID",
                "message": "Enter a withdrawal amount inside the published operator limits.",
            })
        if resolved_chips * 100 != paise * OPERATOR_LIMITS["chips_per_inr"]:
            raise HTTPException(status_code=400, detail={
                "code": "OPERATOR_AMOUNT_INVALID",
                "message": "Withdrawal amount must convert to a whole chip count.",
            })
    return paise, resolved_chips


async def create_request(
    user: Mapping[str, Any],
    *,
    kind: str,
    amount_paise: int,
    chips: int | None = None,
    bank_detail_id: str | None = None,
    note: str = "",
) -> dict[str, Any]:
    kind = str(kind or "").upper()
    if kind not in {"DEPOSIT", "WITHDRAWAL"}:
        raise HTTPException(status_code=400, detail={"code": "OPERATOR_KIND_INVALID", "message": "Request type is invalid."})
    paise, resolved_chips = _require_amount(kind, amount_paise, chips)
    bank_name = None
    account_masked = None
    if kind == "WITHDRAWAL":
        method = await db.payout_methods.find_one({
            "id": bank_detail_id, "user_id": user["id"], "status": "ACTIVE",
        }, {"_id": 0})
        if not method:
            raise HTTPException(status_code=400, detail={
                "code": "BANK_DETAILS_REQUIRED",
                "message": "Add and select a bank account before withdrawing.",
            })
        bank_name = method.get("bank_name")
        account_masked = method.get("account_number_masked")
        user_row = await db.users.find_one({"id": user["id"]}, {"_id": 0, "chip_balance": 1})
        if int((user_row or {}).get("chip_balance") or 0) < resolved_chips:
            raise HTTPException(status_code=409, detail={
                "code": "OPERATOR_BALANCE_INSUFFICIENT",
                "message": "You do not have enough chips for this withdrawal.",
            })
    row = {
        "id": str(uuid.uuid4()),
        "user_id": user["id"],
        "user_email": user.get("email"),
        "kind": kind,
        "amount_paise": paise,
        "chips": resolved_chips,
        "bank_detail_id": bank_detail_id if kind == "WITHDRAWAL" else None,
        "bank_name": bank_name,
        "account_number_masked": account_masked,
        "status": "PENDING",
        "note": str(note or "")[:500],
        "source": "ADMIN_REVIEW",
        "created_at": utcnow(),
    }
    await db[COLLECTION].insert_one(row)
    row.pop("_id", None)
    return request_dto(row)


async def list_for_user(user_id: str, kind: str | None = None) -> list[dict[str, Any]]:
    query: dict[str, Any] = {"user_id": user_id}
    if kind:
        query["kind"] = kind.upper()
    rows = await db[COLLECTION].find(query, {"_id": 0}).sort("created_at", -1).to_list(200)
    return [request_dto(row) for row in rows]


async def list_for_admin(kind: str, status: str | None = None) -> list[dict[str, Any]]:
    query: dict[str, Any] = {"kind": kind.upper()}
    if status:
        query["status"] = status.upper()
    rows = await db[COLLECTION].find(query, {"_id": 0}).sort("created_at", -1).to_list(500)
    return [request_dto(row) for row in rows]


async def resolve_request(request_id: str, admin: Mapping[str, Any], *, approve: bool, note: str = "") -> dict[str, Any]:
    claimed = await db[COLLECTION].find_one_and_update(
        {"id": request_id, "status": "PENDING"},
        {"$set": {"status": "PROCESSING", "updated_at": utcnow()}},
        return_document=ReturnDocument.AFTER,
    )
    if not claimed:
        existing = await db[COLLECTION].find_one({"id": request_id}, {"_id": 0})
        if not existing:
            raise HTTPException(status_code=404, detail={"code": "OPERATOR_REQUEST_NOT_FOUND", "message": "The request was not found."})
        raise HTTPException(status_code=409, detail={"code": "OPERATOR_REQUEST_RESOLVED", "message": "This request was already resolved."})
    claimed.pop("_id", None)
    status = "APPROVED" if approve else "REJECTED"
    try:
        if approve and claimed.get("kind") == "DEPOSIT":
            await ledger.credit_chips(
                claimed["user_id"], int(claimed["chips"]),
                note or "Admin-reviewed chip purchase",
                ref=f"operator-deposit:{claimed['id']}",
                kind=ledger.DEPOSIT,
            )
        if approve and claimed.get("kind") == "WITHDRAWAL":
            await ledger.debit_chips(
                claimed["user_id"], int(claimed["chips"]),
                note or "Admin-reviewed withdrawal",
                ref=f"operator-withdrawal:{claimed['id']}",
                kind=ledger.WITHDRAWAL,
            )
    except InsufficientChips as exc:
        await db[COLLECTION].update_one({"id": request_id, "status": "PROCESSING"}, {"$set": {"status": "PENDING"}})
        raise HTTPException(status_code=409, detail={
            "code": "OPERATOR_BALANCE_INSUFFICIENT",
            "message": "The player does not have enough chips for this withdrawal.",
        }) from exc
    except Exception:
        await db[COLLECTION].update_one({"id": request_id, "status": "PROCESSING"}, {"$set": {"status": "PENDING"}})
        raise
    updated = await db[COLLECTION].find_one_and_update(
        {"id": request_id, "status": "PROCESSING"},
        {"$set": {
            "status": status,
            "admin_note": str(note or "")[:500],
            "resolved_at": utcnow(),
            "resolved_by": admin.get("id"),
        }},
        return_document=ReturnDocument.AFTER,
    )
    if updated:
        updated.pop("_id", None)
        return request_dto(updated)
    return request_dto({**claimed, "status": status})
