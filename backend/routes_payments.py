"""Player and administrator HTTP routes for the feature-gated financial core."""
from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime, timedelta, timezone
from typing import Any, Mapping, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from pydantic import BaseModel, Field
from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError

import compliance
from auth_utils import get_current_user, require_recent_admin_step_up
from db import db
import financial_wallet as finance
import operator_rail
from payment_providers import (
    MAX_WEBHOOK_BODY_BYTES,
    DepositStatus,
    ProviderConfigurationError,
    ProviderEvent,
    ProviderRequestError,
    WebhookVerificationError,
    load_payment_provider,
)


router = APIRouter(tags=["payments"])
admin_router = APIRouter(prefix="/admin", tags=["admin-payments"])


class DepositCreate(BaseModel):
    amount_paise: int = Field(ge=1, le=finance.DEPOSIT_REQUEST_MAX_PAISE)


class BankDetailsCreate(BaseModel):
    account_holder_name: str = Field(min_length=2, max_length=100)
    bank_name: str = Field(min_length=2, max_length=100)
    account_number: str = Field(min_length=6, max_length=50)
    ifsc_code: str = Field(min_length=11, max_length=11)
    payout_identifier: Optional[str] = Field(default=None, max_length=100)


class WithdrawalCreate(BaseModel):
    amount_chips: int = Field(ge=1, le=finance.WITHDRAWAL_REQUEST_MAX_CHIPS)
    bank_detail_id: str = Field(min_length=8, max_length=80)


class AdminNote(BaseModel):
    note: Optional[str] = Field(default=None, max_length=500)


class AdminReject(BaseModel):
    reason: str = Field(min_length=2, max_length=500)


class ProviderReference(BaseModel):
    provider_reference: str = Field(min_length=2, max_length=160)


class RecoveredProviderReference(ProviderReference):
    reason: str = Field(min_length=5, max_length=500)


class WithdrawalModeUpdate(BaseModel):
    mode: str
    reason: str = Field(min_length=2, max_length=500)


class KycReview(BaseModel):
    status: str
    reason: str = Field(min_length=5, max_length=500)


class OperatorDepositCreate(BaseModel):
    amount_paise: int = Field(ge=1, le=operator_rail.OPERATOR_LIMITS["max_deposit_paise"])
    note: Optional[str] = Field(default=None, max_length=500)


class UtrSubmission(BaseModel):
    utr: str = Field(min_length=4, max_length=80, pattern=r"^[A-Za-z0-9_-]+$")


class OperatorWithdrawalCreate(BaseModel):
    amount_chips: int = Field(ge=1, le=operator_rail.OPERATOR_LIMITS["max_withdrawal_chips"])
    bank_detail_id: str = Field(min_length=8, max_length=80)
    note: Optional[str] = Field(default=None, max_length=500)


class OperatorResolve(BaseModel):
    note: Optional[str] = Field(default=None, max_length=500)
    reason: Optional[str] = Field(default=None, max_length=500)


def _financial_http(exc: finance.FinancialError):
    raise HTTPException(
        status_code=exc.status_code,
        detail={"code": exc.code, "message": exc.message},
    ) from exc


def _provider():
    try:
        return load_payment_provider()
    except ProviderConfigurationError as exc:
        raise HTTPException(
            status_code=503,
            detail={"code": "PAYMENT_PROVIDER_NOT_READY", "message": str(exc)},
        ) from exc


def _country_allowlist() -> set[str]:
    return {
        item.strip().upper()
        for item in os.environ.get("FINANCIAL_ALLOWED_COUNTRIES", "").split(",")
        if item.strip()
    }


def _payment_verification_state(user: Mapping[str, Any]) -> dict[str, bool]:
    """Resolve verified evidence without trusting stale aggregate flags.

    Older phone-OTP accounts can have ``phone_verified=True`` while the later
    ``contact_verified`` aggregate is absent or stale.  Temporary admin-review
    registrations carry an explicit, audited contact decision instead of
    pretending an OTP occurred.  Both are valid evidence for payments; an
    unreviewed contact or a bare aggregate flag is not.

    Age and identity/KYC remain fail-closed on their canonical explicit
    approvals so the payment, gameplay and compliance gates cannot disagree.
    """
    contact = operator_rail.payment_contact_state(user)
    return {
        "contact_verified": contact["phone_verified"] or contact["email_verified"],
        "phone_verified": contact["phone_verified"],
        "age_verified": user.get("age_verified") is True,
        "kyc_verified": str(user.get("kyc_status") or "").upper() == "VERIFIED",
    }


async def _require_player(feature: str, user: dict) -> dict:
    try:
        finance.require_financial_feature(feature)
    except finance.FinancialError as exc:
        _financial_http(exc)
    if user.get("role") != "PLAYER" or user.get("status") != "ACTIVE":
        raise HTTPException(
            status_code=403,
            detail={"code": "FINANCIAL_ACCOUNT_NOT_ACTIVE", "message": "An active player account is required."},
        )
    verification = _payment_verification_state(user)
    if not verification["contact_verified"]:
        raise HTTPException(
            status_code=403,
            detail={"code": "CONTACT_NOT_VERIFIED", "message": "Verify your email address or phone number first."},
        )
    if not verification["age_verified"]:
        raise HTTPException(
            status_code=403,
            detail={"code": "AGE_NOT_VERIFIED", "message": "Age verification is required."},
        )
    # Contact OTP verification is not KYC.  Until an audited identity workflow
    # writes this explicit status, money mutations remain fail-closed.
    if not verification["kyc_verified"]:
        raise HTTPException(
            status_code=403,
            detail={"code": "KYC_REQUIRED", "message": "Identity verification is required."},
        )
    if user.get("financial_status") in {"BLOCKED", "FROZEN", "REVIEW_REQUIRED"}:
        raise HTTPException(
            status_code=403,
            detail={"code": "FINANCIAL_ACCOUNT_RESTRICTED", "message": "Financial activity is restricted on this account."},
        )
    country = compliance.normalise_country(user.get("country"))
    allowed = _country_allowlist()
    if not country or country not in allowed:
        raise HTTPException(
            status_code=403,
            detail={"code": "FINANCIAL_MARKET_BLOCKED", "message": "Financial services are unavailable in your registered country."},
        )
    if feature == "deposits":
        # Self-exclusion and the central compliance gate must apply before a
        # player can add value.  Withdrawals deliberately remain accessible.
        await compliance.assert_playable(user)
    return user


async def require_payment_reader(user: dict = Depends(get_current_user)):
    if user.get("role") != "PLAYER":
        raise HTTPException(
            status_code=403,
            detail={"code": "PLAYER_REQUIRED", "message": "Player account required."},
        )
    return user


async def require_operator_player(user: dict = Depends(get_current_user)):
    if user.get("role") != "PLAYER" or user.get("status") != "ACTIVE":
        raise HTTPException(
            status_code=403,
            detail={"code": "PLAYER_REQUIRED", "message": "An active player account is required."},
        )
    return user


async def require_operator_deposit_player(user: dict = Depends(get_current_user)):
    user = await require_operator_player(user)
    if not operator_rail.hosted_upi_requested():
        return user
    return await operator_rail.require_hosted_deposit_eligible(user)


async def require_deposit_player(user: dict = Depends(get_current_user)):
    return await _require_player("deposits", user)


async def require_withdrawal_player(user: dict = Depends(get_current_user)):
    # Deliberately does not call require_active_player/compliance.assert_playable:
    # self-exclusion blocks deposits and play, not access to legitimate funds.
    return await _require_player("withdrawals", user)


def _permissions(user: dict) -> set[str]:
    if "admin_permissions" not in user and "permissions" not in user:
        # Pre-RBAC production administrators retain read-only access to the
        # provider-readiness and audit surfaces during migration. No payment
        # mutation grant is implied by this compatibility path.
        return {"PAYMENTS_VIEW", "AUDIT_VIEW"}
    values = (
        user.get("admin_permissions")
        if "admin_permissions" in user
        else user.get("permissions")
    ) or []
    return {str(value).strip().upper() for value in values if value}


def _is_super_admin(user: dict) -> bool:
    return user.get("role") == "ADMIN" and str(user.get("admin_role", "")).upper() == "SUPER_ADMIN"


def _admin_dependency(
    permission: str | tuple[str, ...], *, super_only: bool = False, step_up: bool = False,
):
    required = (
        tuple(value.upper() for value in permission)
        if isinstance(permission, tuple) else (permission.upper(),)
    )

    async def dependency(user: dict = Depends(get_current_user)):
        if user.get("role") != "ADMIN" or user.get("status") != "ACTIVE":
            raise HTTPException(
                status_code=403,
                detail={"code": "ADMIN_REQUIRED", "message": "Administrator access is required."},
            )
        is_super = _is_super_admin(user)
        if super_only and not is_super:
            raise HTTPException(
                status_code=403,
                detail={"code": "SUPER_ADMIN_REQUIRED", "message": "A designated Super Admin is required."},
            )
        missing = () if is_super else tuple(value for value in required if value not in _permissions(user))
        if missing:
            raise HTTPException(
                status_code=403,
                detail={
                    "code": "ADMIN_PERMISSION_REQUIRED",
                    "message": f"Missing permission: {', '.join(missing)}.",
                },
            )
        if step_up:
            _require_recent_step_up(user)
        return user

    return dependency


def _require_recent_step_up(admin: dict) -> None:
    require_recent_admin_step_up(admin)


payments_view = _admin_dependency("PAYMENTS_VIEW")
withdrawals_approve = _admin_dependency("WITHDRAWALS_APPROVE")
withdrawals_pay = _admin_dependency("WITHDRAWALS_MARK_PAID", step_up=True)
ledger_view = _admin_dependency("LEDGER_VIEW")
audit_view = _admin_dependency("AUDIT_VIEW")
settings_write = _admin_dependency("PAYMENT_SETTINGS_WRITE", super_only=True, step_up=True)
payments_reconcile = _admin_dependency("PAYMENTS_RECONCILE", step_up=True)
payments_reconcile_and_pay = _admin_dependency(
    ("PAYMENTS_RECONCILE", "WITHDRAWALS_MARK_PAID"), step_up=True,
)
kyc_view = _admin_dependency("KYC_VIEW")
kyc_review = _admin_dependency("KYC_REVIEW", step_up=True)


async def _financial_rate_limit(user_id: str, action: str, limit: int, window_seconds: int) -> None:
    stamp = int(datetime.now(timezone.utc).timestamp())
    bucket = stamp // window_seconds
    subject = hashlib.sha256(str(user_id).encode("utf-8")).hexdigest()
    key = f"{action}:{subject}:{bucket}"
    try:
        row = await db.financial_rate_limits.find_one_and_update(
            {"_id": key, "count": {"$lt": limit}},
            {
                "$inc": {"count": 1},
                "$setOnInsert": {
                    "action": action, "subject_hash": subject,
                    "created_at": datetime.now(timezone.utc),
                    "expires_at": datetime.now(timezone.utc) + timedelta(seconds=window_seconds * 2),
                },
            },
            upsert=True, return_document=ReturnDocument.AFTER,
        )
    except DuplicateKeyError:
        row = None
    if not row:
        raise HTTPException(
            status_code=429,
            detail={"code": "FINANCIAL_RATE_LIMITED", "message": "Please wait before trying again."},
            headers={"Retry-After": str(window_seconds - (stamp % window_seconds))},
        )


# ------------------------------------------------------------------ player


@router.get("/payments/wallet")
async def payment_wallet(user: dict = Depends(require_payment_reader)):
    internal = finance.financial_status()
    try:
        money_config = finance.public_money_config()
    except ProviderConfigurationError:
        # Wallet balance reads remain available while a malformed runtime
        # payment setting fails the mutation surfaces closed. Do not expose the
        # invalid value or internal configuration diagnostics to the player.
        money_config = None
    config_ready = money_config is not None
    operator = operator_rail.operator_status()
    return {
        "wallet": await finance.wallet_public(user["id"]),
        "money_config": money_config,
        "financial": {
            "ready": bool(internal["ready"] and config_ready),
            "features": (
                internal["features"] if config_ready
                else {name: False for name in internal["features"]}
            ),
            "availability_code": (
                "AVAILABLE" if internal["ready"] and config_ready
                else "PAYMENTS_UNAVAILABLE"
            ),
            "operator": operator,
        },
    }


@router.post("/payments/deposits", status_code=201)
async def create_deposit(
    body: DepositCreate,
    idempotency_key: str = Header(default="", alias="Idempotency-Key"),
    user: dict = Depends(require_deposit_player),
):
    try:
        await _financial_rate_limit(user["id"], "deposit-create", 10, 900)
        deposit, checkout_url = await finance.create_deposit(
            user["id"], body.amount_paise, idempotency_key, _provider(),
        )
        return {"deposit": finance.deposit_dto(deposit), "checkout_url": checkout_url}
    except finance.FinancialError as exc:
        _financial_http(exc)


@router.get("/payments/deposits")
async def list_deposits(user: dict = Depends(require_payment_reader)):
    rows = await db.deposit_orders.find({"user_id": user["id"]}, {"_id": 0}).sort("created_at", -1).to_list(200)
    operator_rows = await operator_rail.list_for_user(user["id"], "DEPOSIT")
    deposits = [finance.deposit_dto(row) for row in rows] + [
        operator_rail.as_player_deposit(row) for row in operator_rows
    ]
    return {"deposits": operator_rail.sort_newest(deposits)}


@router.get("/payments/deposits/{deposit_id}")
async def deposit_detail(deposit_id: str, user: dict = Depends(require_payment_reader)):
    row = await db.deposit_orders.find_one({"id": deposit_id, "user_id": user["id"]}, {"_id": 0})
    if row:
        return {"deposit": finance.deposit_dto(row)}
    operator_row = await db[operator_rail.COLLECTION].find_one({
        "id": deposit_id, "user_id": user["id"], "kind": "DEPOSIT",
    }, {"_id": 0})
    if operator_row:
        return {"deposit": operator_rail.as_player_deposit(operator_row)}
    raise HTTPException(status_code=404, detail={"code": "DEPOSIT_NOT_FOUND", "message": "Deposit was not found."})


@router.post("/payments/deposits/{deposit_id}/refresh")
async def refresh_deposit_status(
    deposit_id: str, user: dict = Depends(require_payment_reader),
):
    operator_row = await db[operator_rail.COLLECTION].find_one({
        "id": deposit_id, "user_id": user["id"], "kind": "DEPOSIT",
        "source": operator_rail.UPI_SOURCE,
    }, {"_id": 0})
    if operator_row:
        refreshed = await operator_rail.refresh_hosted_deposit(deposit_id, user["id"])
        return {"deposit": operator_rail.as_player_deposit(refreshed)}
    row = await db.deposit_orders.find_one({"id": deposit_id, "user_id": user["id"]}, {"_id": 0})
    if not row:
        raise HTTPException(status_code=404, detail={"code": "DEPOSIT_NOT_FOUND", "message": "Deposit was not found."})
    if row.get("status") in {"CREATED", "PENDING", "RECONCILIATION_REQUIRED"}:
        try:
            await finance.reconcile_deposit(deposit_id, _provider(), actor=f"player-return:{user['id']}")
        except finance.FinancialError as exc:
            if exc.status_code < 500:
                _financial_http(exc)
    stored = await db.deposit_orders.find_one({"id": deposit_id, "user_id": user["id"]}, {"_id": 0})
    return {"deposit": finance.deposit_dto(stored or row)}


@router.post("/payments/deposits/{deposit_id}/utr")
async def submit_deposit_utr(
    deposit_id: str,
    body: UtrSubmission,
    user: dict = Depends(require_payment_reader),
):
    await _financial_rate_limit(user["id"], "upi-utr-submit", 8, 3600)
    deposit = await operator_rail.submit_hosted_utr(deposit_id, user["id"], body.utr)
    return {"deposit": operator_rail.as_player_deposit(deposit)}


@router.get("/payments/bank-details")
async def bank_details(user: dict = Depends(require_operator_player)):
    return {"bank_details": await finance.list_payout_methods(user["id"])}


@router.post("/payments/bank-details", status_code=201)
async def add_bank_details(body: BankDetailsCreate, user: dict = Depends(require_operator_player)):
    try:
        await _financial_rate_limit(user["id"], "bank-details-create", 5, 3600)
        method = await finance.create_payout_method(user["id"], **body.model_dump())
        return {"bank_detail": finance.payout_method_dto(method)}
    except ProviderConfigurationError:
        raise HTTPException(
            status_code=503,
            detail={
                "code": "PAYOUT_ENCRYPTION_NOT_READY",
                "message": "Bank details cannot be saved until payout encryption is configured.",
            },
        )
    except finance.FinancialError as exc:
        _financial_http(exc)


@router.delete("/payments/bank-details/{method_id}")
async def remove_bank_details(
    method_id: str, user: dict = Depends(require_operator_player),
):
    if await operator_rail.has_open_withdrawal(user["id"], method_id):
        raise HTTPException(
            status_code=409,
            detail={
                "code": "BANK_DETAILS_IN_USE",
                "message": "This bank account is used by a pending withdrawal request.",
            },
        )
    try:
        await _financial_rate_limit(user["id"], "bank-details-remove", 5, 3600)
        method = await finance.deactivate_payout_method(user["id"], method_id)
        return {
            "message": "Bank details removed.",
            "bank_detail": finance.payout_method_dto(method),
        }
    except finance.FinancialError as exc:
        _financial_http(exc)


@router.get("/payments/withdrawals")
async def list_withdrawals(user: dict = Depends(require_payment_reader)):
    rows = await db.withdrawal_requests.find(
        {"user_id": user["id"]}, {"_id": 0},
    ).sort("created_at", -1).to_list(200)
    operator_rows = await operator_rail.list_for_user(user["id"], "WITHDRAWAL")
    withdrawals = [finance.withdrawal_dto(row) for row in rows] + [
        operator_rail.as_player_withdrawal(row) for row in operator_rows
    ]
    return {"withdrawals": operator_rail.sort_newest(withdrawals)}


@router.post("/payments/withdrawals", status_code=201)
async def create_withdrawal(
    body: WithdrawalCreate,
    idempotency_key: str = Header(default="", alias="Idempotency-Key"),
    user: dict = Depends(require_withdrawal_player),
):
    try:
        await _financial_rate_limit(user["id"], "withdrawal-create", 5, 3600)
        row = await finance.create_withdrawal(
            user["id"], body.amount_chips, body.bank_detail_id,
            idempotency_key, _provider(),
        )
        return {"withdrawal": finance.withdrawal_dto(row)}
    except finance.FinancialError as exc:
        _financial_http(exc)


@router.post("/payments/operator/deposits", status_code=201)
async def create_operator_deposit(
    body: OperatorDepositCreate,
    idempotency_key: str = Header(default="", alias="Idempotency-Key"),
    user: dict = Depends(require_operator_deposit_player),
):
    await _financial_rate_limit(user["id"], "operator-deposit-create", 10, 900)
    if operator_rail.hosted_upi_requested():
        row, checkout_url = await operator_rail.create_hosted_deposit(
            user, body.amount_paise, idempotency_key,
        )
        return {
            "deposit": operator_rail.as_player_deposit(row),
            "checkout_url": checkout_url,
            "source": operator_rail.UPI_SOURCE,
        }
    row = await operator_rail.create_request(
        user, kind="DEPOSIT", amount_paise=body.amount_paise, note=body.note or "",
    )
    return {"deposit": operator_rail.as_player_deposit(row), "source": operator_rail.ADMIN_SOURCE}


@router.post("/payments/operator/withdrawals", status_code=201)
async def create_operator_withdrawal(
    body: OperatorWithdrawalCreate,
    user: dict = Depends(require_operator_player),
):
    await _financial_rate_limit(user["id"], "operator-withdrawal-create", 5, 3600)
    paise = (int(body.amount_chips) * 100) // operator_rail.OPERATOR_LIMITS["chips_per_inr"]
    row = await operator_rail.create_request(
        user,
        kind="WITHDRAWAL",
        amount_paise=paise,
        chips=body.amount_chips,
        bank_detail_id=body.bank_detail_id,
        note=body.note or "",
    )
    return {"withdrawal": operator_rail.as_player_withdrawal(row), "source": "ADMIN_REVIEW"}


@router.post("/payments/webhooks/{provider_name}")
async def provider_webhook(provider_name: str, request: Request):
    status = finance.financial_status()
    financial_live = bool(status["ready"] and status["features"]["real_money"])
    operator_live = await operator_rail.hosted_upi_reconciliation_needed()
    if not financial_live and not operator_live:
        raise HTTPException(status_code=404, detail="Not found")
    chunks: list[bytes] = []
    body_size = 0
    async for chunk in request.stream():
        body_size += len(chunk)
        if body_size > MAX_WEBHOOK_BODY_BYTES:
            raise HTTPException(
                status_code=413,
                detail={"code": "WEBHOOK_TOO_LARGE", "message": "Webhook body is too large."},
            )
        chunks.append(chunk)
    raw_body = b"".join(chunks)
    provider = _provider()
    if provider_name.strip().lower() != provider.name:
        raise HTTPException(status_code=404, detail="Not found")
    try:
        event = provider.verify_webhook(raw_body, request.headers)
    except WebhookVerificationError as exc:
        raise HTTPException(
            status_code=401,
            detail={"code": "INVALID_WEBHOOK", "message": "Webhook verification failed."},
        ) from exc
    if event.data.get("requires_authenticated_status_lookup"):
        operator_order = await db[operator_rail.COLLECTION].find_one({
            "source": operator_rail.UPI_SOURCE,
            "provider": provider.name,
            "provider_order_id": event.object_id,
        }, {"_id": 0})
        financial_order = None
        if not operator_order and financial_live:
            financial_order = await db.deposit_orders.find_one({
                "provider": provider.name, "provider_order_id": event.object_id,
            }, {"_id": 0})
        order = operator_order or financial_order
        if not order:
            raise HTTPException(status_code=404, detail="Not found")
        try:
            authoritative = await provider.get_payment_status(
                str(event.object_id), expected_amount_paise=int(order["amount_paise"]),
            )
        except (ProviderConfigurationError, ProviderRequestError) as exc:
            raise HTTPException(
                status_code=503,
                detail={"code": "PAYMENT_STATUS_UNAVAILABLE", "message": "Payment status could not be verified."},
            ) from exc
        provider_status = str(authoritative.status or "").strip().upper()
        if operator_order:
            return await operator_rail.settle_hosted_deposit(
                str(operator_order["id"]), authoritative, actor="sgpay24-status-webhook",
            )
        if provider_status in {"CREATED", "PENDING", "PROCESSING", "AUTHORIZED"}:
            return {"status": "PENDING", "verified": True}
        event_type = (
            "deposit.paid"
            if provider_status in {"PAID", "SUCCESS", "SUCCEEDED", "CREDITED"}
            else "deposit.failed"
        )
        canonical = {
            "order_id": event.object_id,
            "status": provider_status,
            "amount_paise": authoritative.amount_paise,
            "currency": authoritative.currency,
            "provider_reference": authoritative.provider_reference,
        }
        raw_body = json.dumps(canonical, sort_keys=True, separators=(",", ":")).encode("utf-8")
        event = ProviderEvent(
            event_id=f"sgpay24-status:{hashlib.sha256(raw_body).hexdigest()[:40]}",
            event_type=event_type,
            object_id=str(event.object_id),
            amount_paise=authoritative.amount_paise,
            currency=authoritative.currency,
            provider_reference=authoritative.provider_reference,
            occurred_at=None,
            data={"authenticated_status_lookup": True},
        )
    try:
        return await finance.process_provider_event(provider, event, raw_body)
    except finance.FinancialError as exc:
        raise HTTPException(
            status_code=503 if exc.status_code >= 500 else 409,
            detail={"code": "WEBHOOK_PROCESSING_FAILED", "message": "Webhook could not be processed."},
        ) from exc


# ------------------------------------------------------------------- admin


def _admin_deposit_dto(row):
    return {**finance.deposit_dto(row), "user_id": row.get("user_id"),
            "provider_order_id": row.get("provider_order_id"),
            "provider_reference": row.get("provider_reference")}


@admin_router.get("/payments/deposits")
async def admin_deposits(
    status: Optional[str] = Query(default=None, max_length=40),
    admin: dict = Depends(payments_view),
):
    query = {"status": status.upper()} if status else {}
    rows = await db.deposit_orders.find(query, {"_id": 0}).sort("created_at", -1).to_list(500)
    operator_rows = await operator_rail.list_for_admin("DEPOSIT", status)
    deposits = [_admin_deposit_dto(row) for row in rows] + [
        operator_rail.as_admin_deposit(row) for row in operator_rows
    ]
    return {"deposits": operator_rail.sort_newest(deposits)}


@admin_router.get("/payments/withdrawals")
async def admin_withdrawals(
    status: Optional[str] = Query(default=None, max_length=40),
    admin: dict = Depends(payments_view),
):
    query = {"status": status.upper()} if status else {}
    rows = await db.withdrawal_requests.find(query, {"_id": 0}).sort("created_at", -1).to_list(500)
    operator_status = None if not status else (
        "PENDING" if status.upper() in {"PENDING", "REQUESTED", "PENDING_ADMIN"} else status
    )
    operator_rows = await operator_rail.list_for_admin("WITHDRAWAL", operator_status)
    withdrawals = [finance.withdrawal_dto(row, admin=True) for row in rows] + [
        operator_rail.as_admin_withdrawal(row) for row in operator_rows
    ]
    return {"withdrawals": operator_rail.sort_newest(withdrawals)}


@admin_router.get("/payments/events")
async def admin_payment_events(
    status: Optional[str] = Query(default=None, max_length=40),
    admin: dict = Depends(payments_view),
):
    query = {"status": status.upper()} if status else {}
    rows = await db.provider_webhook_events.find(query, {"_id": 0}).sort("received_at", -1).to_list(500)
    events = [{
        "id": row.get("id"), "provider": row.get("provider"),
        "event_id": row.get("event_id"), "event_type": row.get("event_type"),
        "object_id": row.get("object_id"), "status": row.get("status"),
        "error_code": row.get("error_code"), "received_at": row.get("received_at"),
        "processed_at": row.get("processed_at"),
    } for row in rows]
    return {"events": events}


@admin_router.get("/payments/summary")
async def admin_payment_summary(admin: dict = Depends(payments_view)):
    pending_deposits = await db.deposit_orders.count_documents({
        "status": {"$in": ["CREATED", "PENDING", "RECONCILIATION_REQUIRED"]},
    })
    pending_withdrawals = await db.withdrawal_requests.count_documents({
        "status": {"$nin": list(finance.WITHDRAWAL_TERMINAL)},
    })
    pending_deposits += await db[operator_rail.COLLECTION].count_documents({
        "kind": "DEPOSIT", "status": "PENDING",
    })
    pending_withdrawals += await db[operator_rail.COLLECTION].count_documents({
        "kind": "WITHDRAWAL", "status": {"$in": ["PENDING", "PROCESSING"]},
    })
    failed_payment_events = await db.provider_webhook_events.count_documents({
        "status": {"$in": ["RETRY", "REVIEW_REQUIRED"]},
    })
    totals = await db.wallet_accounts.aggregate([{
        "$group": {"_id": None, "held_chips": {"$sum": "$held_cash_chips"}},
    }]).to_list(1)
    return {
        "pending_deposits": int(pending_deposits),
        "pending_withdrawals": int(pending_withdrawals),
        "failed_payment_events": int(failed_payment_events),
        "held_chips": int(totals[0].get("held_chips", 0)) if totals else 0,
    }


def _mask_email(value: Optional[str]) -> Optional[str]:
    if not value or "@" not in value:
        return None
    local, domain = value.split("@", 1)
    hidden = "•" * max(2, len(local) - 1)
    return f"{local[:1]}{hidden}@{domain}"


def _mask_phone(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    raw = str(value)
    hidden = "•" * max(4, len(raw) - 4)
    return f"{hidden}{raw[-4:]}"


_AUDIT_SECRET_KEYS = {
    "account_number", "ciphertext", "nonce", "secret", "token",
    "payout_identifier", "password", "otp",
}


def _sanitize_audit_value(value: Any) -> Any:
    """Return useful audit context without ever serializing financial secrets."""
    if isinstance(value, Mapping):
        return {
            str(key): _sanitize_audit_value(item)
            for key, item in value.items()
            if str(key).lower() not in _AUDIT_SECRET_KEYS
        }
    if isinstance(value, (list, tuple)):
        return [_sanitize_audit_value(item) for item in value[:100]]
    if isinstance(value, str):
        return value[:500]
    if value is None or isinstance(value, (int, float, bool, datetime)):
        return value
    return str(value)[:500]


@admin_router.get("/payments/kyc")
async def admin_kyc_queue(
    status: Optional[str] = Query(default=None, max_length=20),
    admin: dict = Depends(kyc_view),
):
    query: dict = {"role": "PLAYER"}
    if status:
        wanted = status.strip().upper()
        if wanted == "UNVERIFIED":
            query["$or"] = [
                {"kyc_status": {"$exists": False}},
                {"kyc_status": {"$in": [None, "", "UNVERIFIED"]}},
            ]
        elif wanted in {"PENDING", "VERIFIED", "REJECTED"}:
            query["kyc_status"] = wanted
        else:
            raise HTTPException(
                status_code=422,
                detail={"code": "INVALID_KYC_STATUS", "message": "Invalid KYC status filter."},
            )
    rows = await db.users.find(query, {
        "_id": 0, "id": 1, "email": 1, "phone": 1, "country": 1,
        "age_verified": 1, "email_verified": 1, "phone_verified": 1,
        "kyc_status": 1, "kyc_reviewed_at": 1,
        "age_verification_status": 1, "mobile_verification_status": 1,
        "mobile_review_status": 1, "mobile_reviewed_at": 1,
        "mobile_reviewed_by": 1, "mobile_review_note": 1,
        "mobile_review_phone_snapshot": 1, "phone_normalized": 1,
        "registration_source": 1, "activation_mode": 1,
        "manual_contact_reviewed": 1, "contact_verification_status": 1,
        "manual_contact_reviewed_at": 1, "manual_contact_reviewed_by": 1,
        "approved_at": 1, "approved_by": 1, "accepted_terms": 1,
        "submitted_at": 1, "email_normalized": 1, "primary_identity": 1,
        "primary_identity_channel": 1, "pending_email": 1, "pending_phone": 1,
    }).sort("created_at", -1).to_list(500)
    players = []
    for row in rows:
        contact = operator_rail.payment_contact_state(row)
        players.append({
            "id": row.get("id"), "email_masked": _mask_email(row.get("email")),
            "phone_masked": _mask_phone(row.get("phone")), "country": row.get("country"),
            "phone_available": bool(row.get("phone_normalized") or row.get("phone")),
            "age_verified": bool(row.get("age_verified")),
            "age_verification_status": row.get("age_verification_status") or "NOT_REQUESTED",
            "mobile_verification_status": row.get("mobile_verification_status") or "NOT_REQUESTED",
            "mobile_manually_verified": row.get("mobile_review_status") == "ADMIN_APPROVED",
            "contact_verified": contact["phone_verified"] or contact["email_verified"],
            "kyc_status": str(row.get("kyc_status") or "UNVERIFIED").upper(),
            "reviewed_at": row.get("kyc_reviewed_at"),
        })
    return {"players": players}


@admin_router.patch("/payments/kyc/{user_id}")
async def admin_review_kyc(
    user_id: str, body: KycReview, admin: dict = Depends(kyc_review),
):
    try:
        user = await finance.review_player_kyc(
            user_id, body.status, admin["id"], body.reason,
        )
        return {
            "message": "KYC review recorded.",
            "player": {"id": user["id"], "kyc_status": user.get("kyc_status")},
        }
    except finance.FinancialError as exc:
        _financial_http(exc)


async def _settings_response():
    settings = await db.payment_settings.find_one({"key": "main"}, {"_id": 0}) or {
        "withdrawal_mode": finance.MANUAL, "mode_version": 1,
        "updated_at": None,
    }
    return {
        "settings": {
            "withdrawal_mode": settings.get("withdrawal_mode", finance.MANUAL),
            "mode_version": int(settings.get("mode_version", 1)),
            "updated_at": settings.get("updated_at"),
        },
        "financial": finance.financial_status(),
    }


@admin_router.get("/payments/settings")
@admin_router.get("/payment-settings")
async def admin_payment_settings(admin: dict = Depends(payments_view)):
    return await _settings_response()


@admin_router.patch("/payments/settings/withdrawal-mode")
@admin_router.patch("/payment-settings/withdrawal-mode")
async def update_withdrawal_mode(
    body: WithdrawalModeUpdate,
    admin: dict = Depends(settings_write),
):
    try:
        finance.require_financial_core()
        provider = _provider() if body.mode.strip().upper() == finance.AUTOMATIC else None
        await finance.set_withdrawal_mode(body.mode, admin["id"], body.reason, provider)
        return {"message": "Withdrawal mode updated.", **(await _settings_response())}
    except finance.FinancialError as exc:
        _financial_http(exc)


@admin_router.post("/payments/operator-requests/{request_id}/approve")
async def admin_approve_operator_request(
    request_id: str, body: OperatorResolve, admin: dict = Depends(payments_view),
):
    row = await operator_rail.resolve_request(
        request_id, admin, approve=True, note=body.note or body.reason or "",
    )
    return {
        "message": "Request approved.",
        "request": row,
        "deposit": operator_rail.as_admin_deposit(row) if row.get("kind") == "DEPOSIT" else None,
        "withdrawal": operator_rail.as_admin_withdrawal(row) if row.get("kind") == "WITHDRAWAL" else None,
    }


@admin_router.post("/payments/operator-requests/{request_id}/reject")
async def admin_reject_operator_request(
    request_id: str, body: OperatorResolve, admin: dict = Depends(payments_view),
):
    reason = str(body.reason or body.note or "").strip()
    if len(reason) < 2:
        raise HTTPException(
            status_code=400,
            detail={"code": "OPERATOR_REASON_REQUIRED", "message": "Enter a rejection reason."},
        )
    row = await operator_rail.resolve_request(request_id, admin, approve=False, note=reason)
    return {
        "message": "Request rejected.",
        "request": row,
        "deposit": operator_rail.as_admin_deposit(row) if row.get("kind") == "DEPOSIT" else None,
        "withdrawal": operator_rail.as_admin_withdrawal(row) if row.get("kind") == "WITHDRAWAL" else None,
    }


@admin_router.post("/withdrawals/{withdrawal_id}/approve")
async def admin_approve_withdrawal(
    withdrawal_id: str, body: AdminNote,
    admin: dict = Depends(withdrawals_approve),
):
    try:
        finance.require_financial_core()
        row = await finance.approve_withdrawal(withdrawal_id, admin["id"], body.note)
        return {"message": "Withdrawal approved.", "withdrawal": finance.withdrawal_dto(row, admin=True)}
    except finance.FinancialError as exc:
        _financial_http(exc)


@admin_router.post("/withdrawals/{withdrawal_id}/reject")
async def admin_reject_withdrawal(
    withdrawal_id: str, body: AdminReject,
    admin: dict = Depends(withdrawals_approve),
):
    try:
        finance.require_financial_core()
        row = await finance.reject_withdrawal(withdrawal_id, admin["id"], body.reason)
        return {"message": "Withdrawal rejected and held chips released.",
                "withdrawal": finance.withdrawal_dto(row, admin=True)}
    except finance.FinancialError as exc:
        _financial_http(exc)


@admin_router.post("/withdrawals/{withdrawal_id}/mark-submitted")
async def admin_mark_submitted(
    withdrawal_id: str, body: ProviderReference,
    admin: dict = Depends(withdrawals_pay),
):
    try:
        finance.require_financial_core()
        row = await finance.mark_withdrawal_submitted(
            withdrawal_id, admin["id"], body.provider_reference,
        )
        return {"message": "Withdrawal marked submitted.",
                "withdrawal": finance.withdrawal_dto(row, admin=True)}
    except finance.FinancialError as exc:
        _financial_http(exc)


@admin_router.post("/withdrawals/{withdrawal_id}/mark-paid")
async def admin_mark_paid(
    withdrawal_id: str, body: ProviderReference,
    admin: dict = Depends(withdrawals_pay),
):
    try:
        finance.require_financial_core()
        row = await finance.mark_withdrawal_paid(
            withdrawal_id, admin["id"], body.provider_reference, manual_only=True,
        )
        return {"message": "Withdrawal marked paid.",
                "withdrawal": finance.withdrawal_dto(row, admin=True)}
    except finance.FinancialError as exc:
        _financial_http(exc)


@admin_router.post("/withdrawals/{withdrawal_id}/attach-provider-reference")
async def admin_attach_provider_reference(
    withdrawal_id: str, body: RecoveredProviderReference,
    admin: dict = Depends(payments_reconcile_and_pay),
):
    try:
        finance.require_financial_core()
        row = await finance.attach_unknown_payout_reference(
            withdrawal_id, admin["id"], body.provider_reference, body.reason,
        )
        return {
            "message": "Provider reference attached for reconciliation.",
            "withdrawal": finance.withdrawal_dto(row, admin=True),
        }
    except finance.FinancialError as exc:
        _financial_http(exc)


@admin_router.get("/payments/ledger")
async def admin_financial_ledger(
    user_id: Optional[str] = Query(default=None, max_length=80),
    admin: dict = Depends(ledger_view),
):
    query = {"user_id": user_id} if user_id else {"user_id": {"$ne": None}}
    rows = await db.wallet_entries.find(query, {"_id": 0}).sort("created_at", -1).to_list(500)
    entries = [{
        "id": row.get("id"), "operation_id": row.get("operation_id"),
        "user_id": row.get("user_id"), "bucket": row.get("bucket"),
        "delta_chips": row.get("delta_chips"), "balance_after": row.get("balance_after"),
        "created_at": row.get("created_at"),
    } for row in rows]
    return {"entries": entries}


@admin_router.get("/payments/audit")
async def admin_financial_audit(admin: dict = Depends(audit_view)):
    rows = await db.financial_audit.find({}, {"_id": 0}).sort("created_at", -1).to_list(500)
    audits = [{
        "id": row.get("id"), "actor_id": row.get("actor_id"),
        "action": row.get("action"), "target_type": row.get("target_type"),
        "target_id": row.get("target_id"), "reason": row.get("reason"),
        "before": _sanitize_audit_value(row.get("before")),
        "after": _sanitize_audit_value(row.get("after")),
        "metadata": _sanitize_audit_value(row.get("metadata")),
        "created_at": row.get("created_at"),
    } for row in rows]
    return {"audit": audits}


@admin_router.post("/payments/events/{event_id}/reconcile")
async def admin_reconcile_payment_event(
    event_id: str, admin: dict = Depends(payments_reconcile),
):
    try:
        finance.require_financial_core()
        result = await finance.reconcile_payment_event(event_id, _provider(), admin["id"])
        return {"message": "Payment event reconciled.", "result": result}
    except finance.FinancialError as exc:
        _financial_http(exc)


@admin_router.post("/payments/reconcile")
async def admin_reconcile_payments(
    limit: int = Query(default=50, ge=1, le=100),
    admin: dict = Depends(payments_reconcile),
):
    try:
        finance.require_financial_core()
        result = await finance.reconcile_financial_records(
            _provider(), limit=limit, actor=admin["id"],
        )
        return {"result": result}
    except finance.FinancialError as exc:
        _financial_http(exc)


@admin_router.post("/payments/process-outbox")
async def admin_process_payment_outbox(
    limit: int = Query(default=20, ge=1, le=100),
    admin: dict = Depends(withdrawals_pay),
):
    try:
        finance.require_financial_feature("automatic_withdrawals")
        result = await finance.process_outbox_batch(_provider(), limit)
        return {"result": result}
    except finance.FinancialError as exc:
        _financial_http(exc)
