"""Admin-reviewed player payment requests.

This rail lets players save bank details and submit buy/withdraw requests
while REAL_MONEY_ENABLED / PAYMENTS_V2 / GAME_WALLET_INTEGRATION_READY stay
fail-closed. Requests appear on the Admin deposits and withdrawals queues.
Wallet credit or debit happens only when an administrator approves.
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
import urllib.parse
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Mapping

from fastapi import HTTPException
from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError

import compliance
import ledger
import financial_wallet as finance
from ledger import InsufficientChips
from db import client, db
from payment_providers import (
    DepositStatus,
    PaymentProvider,
    ProviderConfigurationError,
    ProviderRequestError,
    load_payment_provider,
)


COLLECTION = "operator_payment_requests"
DAILY_GUARD_COLLECTION = "upi_daily_purchase_guards"
UPI_SOURCE = "SGPAY24_UPI"
ADMIN_SOURCE = "ADMIN_REVIEW"
HOSTED_TERMINAL = frozenset({"CREDITED", "FAILED", "EXPIRED", "RECONCILIATION_REQUIRED"})
IDEMPOTENCY_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{7,159}$")
_TEST_HOSTED_LOCKS: dict[str, asyncio.Lock] = {}

OPERATOR_LIMITS = {
    "chips_per_inr": 1,
    "min_deposit_paise": 10_000,
    "max_deposit_paise": 10_000_000,
    "min_withdrawal_paise": 100_000,
    "min_withdrawal_chips": 1_000,
    "max_withdrawal_chips": 1_000_000,
}


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _env_true(name: str, environ: Mapping[str, str] | None = None) -> bool:
    env = os.environ if environ is None else environ
    return str(env.get(name, "false")).strip().lower() == "true"


def hosted_upi_requested(environ: Mapping[str, str] | None = None) -> bool:
    return _env_true("UPI_CHIP_PURCHASES_ENABLED", environ)


def hosted_upi_chips_per_inr(environ: Mapping[str, str] | None = None) -> int:
    env = os.environ if environ is None else environ
    raw = env.get("UPI_CHIPS_PER_INR")
    if raw is None or str(raw).strip() == "":
        raise ProviderConfigurationError("UPI_CHIPS_PER_INR must be explicitly configured")
    try:
        rate = int(raw)
    except (TypeError, ValueError) as exc:
        raise ProviderConfigurationError("UPI_CHIPS_PER_INR must be an integer") from exc
    if not 1 <= rate <= 1_000_000:
        raise ProviderConfigurationError("UPI_CHIPS_PER_INR is outside the allowed range")
    return rate


def hosted_upi_daily_limit_paise(environ: Mapping[str, str] | None = None) -> int:
    env = os.environ if environ is None else environ
    raw = env.get("UPI_MAX_DAILY_DEPOSIT_PAISE")
    if raw is None or str(raw).strip() == "":
        raise ProviderConfigurationError("UPI_MAX_DAILY_DEPOSIT_PAISE must be explicitly configured")
    try:
        limit = int(raw)
    except (TypeError, ValueError) as exc:
        raise ProviderConfigurationError("UPI_MAX_DAILY_DEPOSIT_PAISE must be an integer") from exc
    if not OPERATOR_LIMITS["min_deposit_paise"] <= limit <= 100_000_000:
        raise ProviderConfigurationError("UPI_MAX_DAILY_DEPOSIT_PAISE is outside the allowed range")
    return limit


def hosted_upi_provider(
    environ: Mapping[str, str] | None = None,
) -> PaymentProvider:
    if not hosted_upi_requested(environ):
        raise ProviderConfigurationError("UPI chip purchases are disabled")
    provider = load_payment_provider(environ)
    if provider.name != "sgpay24":
        raise ProviderConfigurationError("UPI chip purchases require the SgPay24 provider")
    hosted_upi_chips_per_inr(environ)
    hosted_upi_daily_limit_paise(environ)
    return provider


def hosted_upi_reconciliation_provider(
    environ: Mapping[str, str] | None = None,
) -> PaymentProvider:
    provider = load_payment_provider(environ)
    if provider.name != "sgpay24":
        raise ProviderConfigurationError("UPI reconciliation requires the SgPay24 provider")
    return provider


async def hosted_upi_reconciliation_needed() -> bool:
    if hosted_upi_requested():
        return True
    # With no SgPay24 provider configured there cannot be a valid hosted-UPI
    # obligation. During an intake rollback PAYMENT_PROVIDER and credentials
    # stay configured, so existing open orders continue through the query below.
    if str(os.environ.get("PAYMENT_PROVIDER", "")).strip().lower() != "sgpay24":
        return False
    open_order = await db[COLLECTION].find_one({
        "source": UPI_SOURCE,
        "kind": "DEPOSIT",
        "status": {"$in": ["CREATED", "PENDING"]},
    }, {"_id": 0, "id": 1})
    return bool(open_order)


def operator_status() -> dict[str, Any]:
    hosted_requested = hosted_upi_requested()
    hosted_ready = False
    checkout_hosts: list[str] = []
    if hosted_requested:
        try:
            checkout_hosts = list(hosted_upi_provider().checkout_allowed_hosts)
            hosted_ready = bool(checkout_hosts)
        except ProviderConfigurationError:
            hosted_ready = False
    return {
        "enabled": True,
        "rail": "UPI_HOSTED" if hosted_requested else ADMIN_SOURCE,
        "deposits_enabled": hosted_ready if hosted_requested else True,
        "withdrawals_enabled": True,
        "hosted_checkout": hosted_ready,
        "checkout_hosts": checkout_hosts,
        "availability_code": (
            "AVAILABLE" if hosted_ready or not hosted_requested else "UPI_PROVIDER_NOT_READY"
        ),
        "limits": {
            **OPERATOR_LIMITS,
            "chips_per_inr": (
                hosted_upi_chips_per_inr() if hosted_ready else OPERATOR_LIMITS["chips_per_inr"]
            ),
            "max_daily_deposit_paise": (
                hosted_upi_daily_limit_paise() if hosted_ready else None
            ),
        },
    }


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
        "source": row.get("source") or ADMIN_SOURCE,
        "utr_required": bool(row.get("utr_required")) or (
            row.get("source") == UPI_SOURCE
            and str(row.get("status") or "").upper() in {"CREATED", "PENDING"}
        ),
        "utr_submitted": bool(row.get("utr_claim")) or bool(row.get("utr_submitted")),
        "created_at": row.get("created_at"),
        "resolved_at": row.get("resolved_at"),
        "resolved_by": row.get("resolved_by"),
        "payout_status": row.get("payout_status"),
        "payout_ref": row.get("payout_ref"),
        "payout_error": row.get("payout_error"),
        "last_error": row.get("last_error"),
        "provider_order_id": row.get("provider_order_id"),
        "provider_reference": row.get("provider_reference"),
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
        "source": dto["source"],
        "utr_required": dto["utr_required"],
        "utr_submitted": dto["utr_submitted"],
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
        "source": dto["source"],
        "created_at": dto["created_at"],
        "updated_at": dto["resolved_at"],
    }


def as_admin_deposit(row: Mapping[str, Any]) -> dict[str, Any]:
    dto = request_dto(row)
    return {
        **as_player_deposit(row),
        "user_id": dto["user_id"],
        "user_email": dto["user_email"],
        "provider_order_id": row.get("provider_order_id") or ADMIN_SOURCE,
        "provider_reference": row.get("provider_reference"),
        "admin_note": dto["admin_note"],
        "note": dto["note"],
        "last_error": dto.get("last_error") or row.get("last_error"),
        "utr_required": dto["utr_required"],
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
        "payout_status": dto.get("payout_status"),
        "payout_ref": dto.get("payout_ref"),
        "payout_error": dto.get("payout_error"),
        "provider_reference": dto.get("payout_ref") or row.get("provider_reference"),
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
        import wager
        await wager.require_clear_for_withdrawal(user["id"])
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
        "source": ADMIN_SOURCE,
        "created_at": utcnow(),
    }
    await db[COLLECTION].insert_one(row)
    row.pop("_id", None)
    return request_dto(row)


def _deposit_return_url(deposit_id: str) -> str:
    base = str(
        os.environ.get(
            "PAYMENT_RETURN_URL", "https://chakri.casino/chips/deposit/return",
        ),
    ).strip()
    try:
        parsed = urllib.parse.urlsplit(base)
    except ValueError as exc:
        raise ProviderConfigurationError("PAYMENT_RETURN_URL is invalid") from exc
    query = [
        (key, value) for key, value in urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
        if key not in {"deposit_id", "order_id"}
    ]
    query.append(("deposit_id", deposit_id))
    return urllib.parse.urlunsplit(parsed._replace(query=urllib.parse.urlencode(query)))


def _hosted_idempotency(value: str) -> str:
    key = str(value or "").strip()
    if not IDEMPOTENCY_RE.fullmatch(key):
        raise HTTPException(status_code=400, detail={
            "code": "IDEMPOTENCY_KEY_REQUIRED",
            "message": "Idempotency-Key must be 8-160 safe characters.",
        })
    return key


def payment_contact_state(user: Mapping[str, Any]) -> dict[str, bool]:
    """Return contact evidence accepted by the payment rails.

    Phone/email OTP flags are canonical.  The only non-OTP alternative is the
    explicit, fully audited contact approval written by the manual-registration
    workflow; partial or legacy-looking records remain unverified.
    """
    manual_reviewed_at = user.get("manual_contact_reviewed_at")
    manual_reviewed_by = user.get("manual_contact_reviewed_by")
    email = user.get("email_normalized")
    phone = user.get("phone_normalized")
    manual_contact_reviewed = bool(
        user.get("registration_source") == "SELF_SERVICE"
        and user.get("activation_mode") == "ADMIN_REVIEW"
        and user.get("manual_contact_reviewed") is True
        and user.get("contact_verification_status") == "ADMIN_APPROVED"
        and manual_reviewed_at
        and manual_reviewed_by
        and user.get("approved_at") == manual_reviewed_at
        and user.get("approved_by") == manual_reviewed_by
        and user.get("accepted_terms") is True
        and user.get("submitted_at")
        and email
        and user.get("email") == email
        and phone
        and user.get("phone") == phone
        and user.get("primary_identity") == phone
        and user.get("primary_identity_channel") == "PHONE"
        and not user.get("pending_email")
        and not user.get("pending_phone")
    )
    mobile_reviewed = bool(
        user.get("mobile_review_status") == "ADMIN_APPROVED"
        and user.get("mobile_reviewed_at")
        and user.get("mobile_reviewed_by")
        and user.get("mobile_review_note")
        and phone
        and user.get("mobile_review_phone_snapshot") == phone
    )
    return {
        "phone_verified": (
            user.get("phone_verified") is True
            or manual_contact_reviewed
            or mobile_reviewed
        ),
        "email_verified": user.get("email_verified") is True or manual_contact_reviewed,
    }


async def require_hosted_deposit_eligible(user: Mapping[str, Any]) -> Mapping[str, Any]:
    """Apply the complete hosted-UPI eligibility contract to a fresh user row."""
    if user.get("role") != "PLAYER" or user.get("status") != "ACTIVE":
        raise HTTPException(status_code=403, detail={
            "code": "FINANCIAL_ACCOUNT_NOT_ACTIVE",
            "message": "An active player account is required.",
        })
    contact = payment_contact_state(user)
    if not contact["phone_verified"]:
        raise HTTPException(status_code=403, detail={
            "code": "CONTACT_NOT_VERIFIED",
            "message": "Verify your mobile number before using UPI.",
        })
    # Age is satisfied by the one-tap 18+ self-attestation (accepted_terms) or an
    # explicit operator age flag; UPI chip purchases no longer require an operator
    # to hand-verify age. compliance.assert_playable below still refuses an actual
    # under-minimum date of birth.
    if not (user.get("age_verified") is True or user.get("accepted_terms") is True):
        raise HTTPException(status_code=403, detail={
            "code": "AGE_NOT_VERIFIED",
            "message": "Please confirm you are at least 18 to continue.",
        })
    # KYC is a cash-OUT control, not a chip-purchase control. A hosted UPI deposit
    # only adds value to the game wallet, so a self-serve player (phone-verified,
    # 18+ self-attested, in an allowed market, not restricted/excluded) can buy
    # chips without an operator hand-verifying identity first. Identity/KYC remains
    # required on the withdrawal path. Self-exclusion, market, frozen-account and
    # deposit-limit gates below still apply.
    if str(user.get("financial_status") or "").upper() in {
        "BLOCKED", "FROZEN", "REVIEW_REQUIRED",
    }:
        raise HTTPException(status_code=403, detail={
            "code": "FINANCIAL_ACCOUNT_RESTRICTED",
            "message": "Financial activity is restricted on this account.",
        })
    country = compliance.normalise_country(user.get("country"))
    allowed = {
        item.strip().upper()
        for item in os.environ.get("FINANCIAL_ALLOWED_COUNTRIES", "").split(",")
        if item.strip()
    }
    if not country or country not in allowed:
        raise HTTPException(status_code=403, detail={
            "code": "FINANCIAL_MARKET_BLOCKED",
            "message": "UPI purchases are unavailable in your registered country.",
        })
    await compliance.assert_playable(user)
    return user


def _hosted_customer(user: Mapping[str, Any]) -> dict[str, Any]:
    digits = re.sub(r"\D", "", str(user.get("phone") or user.get("phone_normalized") or ""))
    if len(digits) == 12 and digits.startswith("91"):
        digits = digits[2:]
    contact = payment_contact_state(user)
    if not contact["phone_verified"] or len(digits) != 10 or digits[0] not in "6789":
        raise HTTPException(status_code=400, detail={
            "code": "UPI_PHONE_REQUIRED",
            "message": "Verify a valid Indian mobile number before using UPI checkout.",
        })
    return {
        "full_name": user.get("full_name") or user.get("display_name"),
        "email": user.get("email"),
        "email_verified": contact["email_verified"],
        "phone": digits,
        "phone_verified": True,
    }


async def _ensure_hosted_checkout(
    row: Mapping[str, Any], provider: PaymentProvider,
) -> tuple[dict[str, Any], str]:
    if row.get("source") != UPI_SOURCE or row.get("provider") != provider.name:
        raise HTTPException(status_code=409, detail={
            "code": "UPI_PROVIDER_MISMATCH", "message": "This purchase belongs to another payment flow.",
        })
    if str(row.get("status") or "").upper() in HOSTED_TERMINAL:
        return dict(row), ""
    user = await db.users.find_one({"id": row["user_id"]}, {"_id": 0})
    if not user:
        raise HTTPException(status_code=404, detail={
            "code": "PLAYER_NOT_FOUND", "message": "The player account was not found.",
        })
    try:
        await require_hosted_deposit_eligible(user)
    except HTTPException as exc:
        error = f"ELIGIBILITY_{(exc.detail or {}).get('code', 'BLOCKED')}"
        # Decide from the current database row, not the possibly stale row
        # passed by an overlapping idempotent request. Once an external order
        # exists it must stay visible to reconciliation even if eligibility is
        # revoked while checkout creation is racing.
        transition = await db[COLLECTION].update_one(
            {
                "id": row["id"], "source": UPI_SOURCE,
                "status": {"$in": ["CREATED", "PENDING"]},
                "provider_order_id": {"$nin": [None, ""]},
            },
            {"$set": {
                "status": "RECONCILIATION_REQUIRED",
                "last_error": error,
                "resolved_at": utcnow(),
                "updated_at": utcnow(),
            }},
        )
        if transition.matched_count == 0:
            await db[COLLECTION].update_one(
                {
                    "id": row["id"], "source": UPI_SOURCE,
                    "status": {"$in": ["CREATED", "PENDING"]},
                    "$or": [
                        {"provider_order_id": {"$exists": False}},
                        {"provider_order_id": None},
                        {"provider_order_id": ""},
                    ],
                },
                {"$set": {
                    "status": "FAILED", "last_error": error,
                    "resolved_at": utcnow(), "updated_at": utcnow(),
                }},
            )
        raise
    if row.get("checkout_url") and row.get("provider_order_id"):
        return dict(row), str(row["checkout_url"])
    try:
        checkout = await provider.create_deposit_order(
            deposit_id=str(row["id"]),
            amount_paise=int(row["amount_paise"]),
            currency="INR",
            idempotency_key=f"upi-chip:{row['id']}",
            return_url=_deposit_return_url(str(row["id"])),
            customer=_hosted_customer(user),
        )
    except HTTPException:
        raise
    except (ProviderConfigurationError, ProviderRequestError) as exc:
        await db[COLLECTION].update_one(
            {"id": row["id"], "source": UPI_SOURCE, "status": "CREATED"},
            {"$set": {"last_error": type(exc).__name__, "updated_at": utcnow()}},
        )
        raise HTTPException(status_code=503, detail={
            "code": "UPI_CHECKOUT_UNAVAILABLE",
            "message": "UPI checkout is temporarily unavailable. No chips were credited.",
        }) from exc
    stored = await db[COLLECTION].find_one_and_update(
        {"id": row["id"], "source": UPI_SOURCE, "status": {"$in": ["CREATED", "PENDING"]}},
        {"$set": {
            "status": "PENDING",
            "provider_order_id": checkout.provider_order_id,
            "checkout_url": checkout.checkout_url,
            "last_error": None,
            "next_reconcile_at": utcnow() + timedelta(seconds=8),
            "updated_at": utcnow(),
        }},
        return_document=ReturnDocument.AFTER,
    )
    if not stored:
        stored = await db[COLLECTION].find_one({"id": row["id"]})
    if not stored or stored.get("provider_order_id") != checkout.provider_order_id:
        raise HTTPException(status_code=409, detail={
            "code": "UPI_CHECKOUT_CONFLICT",
            "message": "UPI checkout needs review. No chips were credited.",
        })
    stored.pop("_id", None)
    return stored, str(stored.get("checkout_url") or checkout.checkout_url)


async def create_hosted_deposit(
    user: Mapping[str, Any], amount_paise: int, idempotency_key: str,
    provider: PaymentProvider | None = None,
) -> tuple[dict[str, Any], str]:
    gateway = provider or hosted_upi_provider()
    key = _hosted_idempotency(idempotency_key)
    paise, _ = _require_amount("DEPOSIT", amount_paise)
    rate = hosted_upi_chips_per_inr()
    if paise * rate % 100:
        raise HTTPException(status_code=400, detail={
            "code": "UPI_AMOUNT_INVALID",
            "message": "Choose an INR amount that converts to a whole chip amount.",
        })
    chips = (paise * rate) // 100
    fresh_user = await db.users.find_one({"id": user["id"]}, {"_id": 0})
    if not fresh_user:
        raise HTTPException(status_code=404, detail={
            "code": "PLAYER_NOT_FOUND", "message": "The player account was not found.",
        })
    await require_hosted_deposit_eligible(fresh_user)
    user = fresh_user
    _hosted_customer(user)
    existing = await db[COLLECTION].find_one({
        "user_id": user["id"], "source": UPI_SOURCE, "idempotency_key": key,
    }, {"_id": 0})
    if existing:
        if int(existing.get("amount_paise", -1)) != paise:
            raise HTTPException(status_code=409, detail={
                "code": "IDEMPOTENCY_CONFLICT",
                "message": "This purchase key belongs to another amount.",
            })
        return await _ensure_hosted_checkout(existing, gateway)
    gaming_day = ledger.gaming_day()
    day_start, day_end = ledger.day_bounds_utc(gaming_day)
    row = {
        "id": str(uuid.uuid4()),
        "user_id": user["id"],
        "user_email": user.get("email"),
        "kind": "DEPOSIT",
        "amount_paise": paise,
        "chips": chips,
        "rate_snapshot": {"chips_per_inr": rate, "version": "sgpay24-upi-v1"},
        "reservation_gaming_day": gaming_day,
        "status": "CREATED",
        "source": UPI_SOURCE,
        "provider": gateway.name,
        "provider_order_id": None,
        "provider_reference": None,
        "checkout_url": None,
        "idempotency_key": key,
        "created_at": utcnow(),
        "updated_at": utcnow(),
    }
    async def reserve_and_insert(session):
        kwargs = {"session": session} if session is not None else {}
        # Force concurrent purchases for the same player/day to contend on one
        # document. The transaction then re-reads limits and inserts atomically.
        guard_id = f"{user['id']}:{gaming_day}"
        await db[DAILY_GUARD_COLLECTION].update_one(
            {"_id": guard_id},
            {"$inc": {"version": 1}, "$setOnInsert": {
                "user_id": user["id"], "gaming_day": str(gaming_day),
                "created_at": utcnow(),
            }},
            upsert=True,
            **kwargs,
        )
        duplicate = await db[COLLECTION].find_one({
            "user_id": user["id"], "source": UPI_SOURCE, "idempotency_key": key,
        }, {"_id": 0}, **kwargs)
        if duplicate:
            if int(duplicate.get("amount_paise", -1)) != paise:
                raise HTTPException(status_code=409, detail={
                    "code": "IDEMPOTENCY_CONFLICT",
                    "message": "This purchase key belongs to another request.",
                })
            return duplicate
        await finance._touch_deposit_limit_lock(user["id"], session=session)
        violations = await finance._deposit_limit_violations(
            user["id"], chips, session=session,
        )
        if violations:
            violation = violations[0]
            raise HTTPException(status_code=403, detail={
                "code": "DEPOSIT_LIMIT",
                "message": (
                    f"This would take you past your {str(violation.get('period') or 'deposit').lower()} "
                    f"deposit limit. You have {int(violation.get('remaining', 0)):,} chips left in this period."
                ),
            })
        pending_count = await db[COLLECTION].count_documents({
            "user_id": user["id"], "source": UPI_SOURCE,
            "status": {"$in": ["CREATED", "PENDING"]},
        }, **kwargs)
        if pending_count >= 5:
            raise HTTPException(status_code=429, detail={
                "code": "UPI_PENDING_LIMIT",
                "message": "Complete or wait for an existing UPI purchase before starting another.",
            })
        totals = await db[COLLECTION].aggregate([
            {"$match": {
                "user_id": user["id"], "source": UPI_SOURCE,
                "status": {"$in": ["CREATED", "PENDING", "CREDITED", "RECONCILIATION_REQUIRED"]},
                "created_at": {"$gte": day_start, "$lt": day_end},
            }},
            {"$group": {"_id": None, "amount_paise": {"$sum": "$amount_paise"}}},
        ], **kwargs).to_list(1)
        used_paise = int((totals[0] if totals else {}).get("amount_paise", 0))
        if used_paise + paise > hosted_upi_daily_limit_paise():
            raise HTTPException(status_code=409, detail={
                "code": "UPI_DAILY_LIMIT",
                "message": "This purchase would exceed the daily UPI purchase limit.",
            })
        await db[COLLECTION].insert_one(dict(row), **kwargs)
        return row

    try:
        if str(os.environ.get("APP_ENV", "")).strip().lower() == "test":
            lock = _TEST_HOSTED_LOCKS.setdefault(str(user["id"]), asyncio.Lock())
            async with lock:
                stored = await _run_hosted_transaction(reserve_and_insert)
        else:
            stored = await _run_hosted_transaction(reserve_and_insert)
    except DuplicateKeyError:
        duplicate = await db[COLLECTION].find_one({
            "user_id": user["id"], "source": UPI_SOURCE, "idempotency_key": key,
        }, {"_id": 0})
        if not duplicate or int(duplicate.get("amount_paise", -1)) != paise:
            raise HTTPException(status_code=409, detail={
                "code": "IDEMPOTENCY_CONFLICT",
                "message": "This purchase key belongs to another request.",
            })
        stored = duplicate
    return await _ensure_hosted_checkout(stored, gateway)


async def _run_hosted_transaction(work):
    if str(os.environ.get("APP_ENV", "")).strip().lower() == "test":
        return await work(None)
    async with await client.start_session() as session:
        return await session.with_transaction(lambda active: work(active))


async def settle_hosted_deposit(
    request_id: str, authoritative: DepositStatus, *, actor: str,
) -> dict[str, Any]:
    status = str(authoritative.status or "").strip().upper()
    if status in {"CREATED", "PENDING", "PROCESSING", "AUTHORIZED"}:
        attempts = 1
        current = await db[COLLECTION].find_one({"id": request_id, "source": UPI_SOURCE})
        if current:
            attempts += int(current.get("reconcile_attempts", 0))
        await db[COLLECTION].update_one(
            {"id": request_id, "source": UPI_SOURCE, "status": {"$in": ["CREATED", "PENDING"]}},
            {"$set": {
                "status": "PENDING",
                "next_reconcile_at": utcnow() + timedelta(seconds=min(8 * (2 ** min(attempts, 4)), 60)),
                "updated_at": utcnow(),
            }, "$inc": {"reconcile_attempts": 1}},
        )
        return {"id": request_id, "status": "PENDING"}
    if status in {"FAILED", "EXPIRED"}:
        await db[COLLECTION].update_one(
            {"id": request_id, "source": UPI_SOURCE, "status": {"$in": ["CREATED", "PENDING"]}},
            {"$set": {"status": status, "resolved_at": utcnow(), "updated_at": utcnow()}},
        )
        return {"id": request_id, "status": status}
    if status not in {"PAID", "SUCCESS", "SUCCEEDED", "CREDITED"}:
        raise HTTPException(status_code=409, detail={
            "code": "UPI_STATUS_INVALID", "message": "UPI payment returned an unsupported status.",
        })

    async def work(session):
        kwargs = {"session": session} if session is not None else {}
        current = await db[COLLECTION].find_one(
            {"id": request_id, "source": UPI_SOURCE}, {"_id": 0}, **kwargs,
        )
        if not current:
            raise HTTPException(status_code=404, detail={
                "code": "UPI_PURCHASE_NOT_FOUND", "message": "The UPI purchase was not found.",
            })
        if current.get("status") == "CREDITED":
            if str(current.get("provider_reference") or "").upper() != str(authoritative.provider_reference or "").upper():
                raise HTTPException(status_code=409, detail={
                    "code": "UPI_TERMINAL_CONFLICT",
                    "message": "The verified payment reference changed and needs review.",
                })
            return {"id": request_id, "status": "CREDITED", "duplicate": True}
        if current.get("status") in HOSTED_TERMINAL:
            raise HTTPException(status_code=409, detail={
                "code": "UPI_TERMINAL_CONFLICT",
                "message": "This purchase already has a terminal status.",
            })
        reference = str(authoritative.provider_reference or "").strip().upper()
        if (
            authoritative.amount_paise != int(current["amount_paise"])
            or authoritative.currency != "INR"
            or not re.fullmatch(r"[A-Z0-9_-]{4,80}", reference)
        ):
            await db[COLLECTION].update_one(
                {"id": request_id, "source": UPI_SOURCE},
                {"$set": {"status": "RECONCILIATION_REQUIRED", "updated_at": utcnow()}},
                **kwargs,
            )
            return {"id": request_id, "status": "RECONCILIATION_REQUIRED"}
        claim = str(current.get("utr_claim") or "").strip().upper()
        # Authenticated SgPay PAID/Complete already carries the provider UTR.
        # Credit immediately unless the player pasted a conflicting claim.
        if claim and claim != reference.upper():
            await db[COLLECTION].update_one(
                {"id": request_id, "source": UPI_SOURCE, "status": {"$in": ["CREATED", "PENDING"]}},
                {"$set": {
                    "status": "PENDING",
                    "last_error": "UTR_MISMATCH",
                    "next_reconcile_at": utcnow() + timedelta(seconds=60),
                    "updated_at": utcnow(),
                }},
                **kwargs,
            )
            return {"id": request_id, "status": "PENDING", "utr_mismatch": True}
        duplicate_reference = await db[COLLECTION].find_one(
            {
                "source": UPI_SOURCE,
                "provider": current.get("provider"),
                "provider_reference": reference,
                "id": {"$ne": request_id},
            },
            {"_id": 0, "id": 1},
            **kwargs,
        )
        if duplicate_reference:
            await db[COLLECTION].update_one(
                {"id": request_id, "source": UPI_SOURCE},
                {"$set": {"status": "RECONCILIATION_REQUIRED", "last_error": "DUPLICATE_UTR", "updated_at": utcnow()}},
                **kwargs,
            )
            return {"id": request_id, "status": "RECONCILIATION_REQUIRED"}
        user = await db.users.find_one({"id": current["user_id"]}, {"_id": 0}, **kwargs)
        if not user:
            raise HTTPException(status_code=409, detail={
                "code": "UPI_PLAYER_MISSING", "message": "The purchase needs operator review.",
            })
        try:
            await require_hosted_deposit_eligible(user)
        except HTTPException as exc:
            try:
                await db[COLLECTION].update_one(
                    {"id": request_id, "source": UPI_SOURCE, "status": {"$in": ["CREATED", "PENDING"]}},
                    {"$set": {
                        "status": "RECONCILIATION_REQUIRED",
                        # Preserve the authoritative paid reference so the
                        # unique provider-reference index continues to protect
                        # every other order from duplicate credit.
                        "provider_reference": reference,
                        "last_error": f"ELIGIBILITY_{(exc.detail or {}).get('code', 'BLOCKED')}",
                        "resolved_at": utcnow(),
                        "updated_at": utcnow(),
                    }},
                    **kwargs,
                )
            except DuplicateKeyError:
                await db[COLLECTION].update_one(
                    {"id": request_id, "source": UPI_SOURCE},
                    {"$set": {
                        "status": "RECONCILIATION_REQUIRED",
                        "last_error": "DUPLICATE_UTR",
                        "resolved_at": utcnow(),
                        "updated_at": utcnow(),
                    }},
                    **kwargs,
                )
            return {"id": request_id, "status": "RECONCILIATION_REQUIRED"}
        await ledger.credit_chips(
            current["user_id"], int(current["chips"]),
            "Verified UPI chip purchase",
            ref=f"upi-chip:{request_id}", kind=ledger.DEPOSIT, session=session,
        )
        import wager
        await wager.open_deposit_bucket(
            current["user_id"], int(current["chips"]), request_id, session=session,
        )
        await db[COLLECTION].update_one(
            {"id": request_id, "source": UPI_SOURCE, "status": {"$in": ["CREATED", "PENDING"]}},
            {"$set": {
                "status": "CREDITED",
                "provider_reference": reference,
                "last_error": None,
                "resolved_at": utcnow(),
                "resolved_by": actor,
                "updated_at": utcnow(),
            }},
            **kwargs,
        )
        return {"id": request_id, "status": "CREDITED", "duplicate": False}

    try:
        result = await _run_hosted_transaction(work)
    except DuplicateKeyError:
        await db[COLLECTION].update_one(
            {"id": request_id, "source": UPI_SOURCE, "status": {"$ne": "CREDITED"}},
            {"$set": {"status": "RECONCILIATION_REQUIRED", "last_error": "DUPLICATE_UTR", "updated_at": utcnow()}},
        )
        return {"id": request_id, "status": "RECONCILIATION_REQUIRED"}
    if result.get("status") == "CREDITED" and not result.get("duplicate"):
        try:
            import free_cash
            row = await db[COLLECTION].find_one({"id": request_id}, {"_id": 0, "user_id": 1})
            if row:
                await free_cash.on_friend_deposit(row["user_id"], request_id)
        except Exception:
            logging.getLogger("operator_rail").exception("free-cash deposit reward failed for %s", request_id)
        try:
            import wager
            overlay = await wager.overlay_for_deposit(result.get("user_id") or (await db[COLLECTION].find_one({"id": request_id}) or {}).get("user_id"), request_id)
            result["overlay"] = overlay
            result["promo"] = await wager.public_state((await db[COLLECTION].find_one({"id": request_id}) or {}).get("user_id"))
        except Exception:
            logging.getLogger("operator_rail").exception("promo overlay failed for %s", request_id)
    return result


async def reconcile_hosted_deposit(
    request_id: str, provider: PaymentProvider | None = None, *, actor: str = "upi-status-worker",
) -> dict[str, Any]:
    gateway = provider or hosted_upi_reconciliation_provider()
    row = await db[COLLECTION].find_one({
        "id": request_id, "source": UPI_SOURCE, "kind": "DEPOSIT",
    }, {"_id": 0})
    if not row:
        raise HTTPException(status_code=404, detail={
            "code": "UPI_PURCHASE_NOT_FOUND", "message": "The UPI purchase was not found.",
        })
    if row.get("status") in HOSTED_TERMINAL:
        return {"id": request_id, "status": row["status"], "terminal": True}
    lookup_order_id = str(row.get("provider_order_id") or "").strip()
    if not lookup_order_id:
        # Checkout uses deposit_id as the SgPay order_id. A pending row may
        # already exist at the provider even if we never persisted the id.
        try:
            authoritative = await gateway.get_payment_status(
                str(row["id"]), expected_amount_paise=int(row["amount_paise"]),
            )
        except (ProviderConfigurationError, ProviderRequestError):
            stored, _ = await _ensure_hosted_checkout(row, gateway)
            logging.getLogger("operator_rail").info(
                "hosted UPI missing provider_order_id request_id=%s fell back to checkout",
                request_id,
            )
            return {"id": request_id, "status": stored.get("status", "PENDING")}
        await db[COLLECTION].update_one(
            {"id": request_id, "source": UPI_SOURCE},
            {"$set": {"provider_order_id": str(row["id"]), "updated_at": utcnow()}},
        )
        logging.getLogger("operator_rail").info(
            "hosted UPI looked up request_id=%s by deposit id", request_id,
        )
        return await settle_hosted_deposit(request_id, authoritative, actor=actor)
    try:
        authoritative = await gateway.get_payment_status(
            lookup_order_id, expected_amount_paise=int(row["amount_paise"]),
        )
    except (ProviderConfigurationError, ProviderRequestError) as exc:
        await db[COLLECTION].update_one(
            {"id": request_id, "source": UPI_SOURCE},
            {"$set": {
                "last_error": type(exc).__name__,
                "next_reconcile_at": utcnow() + timedelta(seconds=15),
                "updated_at": utcnow(),
            }, "$inc": {"reconcile_attempts": 1}},
        )
        raise HTTPException(status_code=503, detail={
            "code": "UPI_STATUS_UNAVAILABLE",
            "message": "UPI payment status is temporarily unavailable.",
        }) from exc
    result = await settle_hosted_deposit(request_id, authoritative, actor=actor)
    logging.getLogger("operator_rail").info(
        "hosted UPI reconcile request_id=%s status=%s actor=%s",
        request_id, result.get("status"), actor,
    )
    return result


async def refresh_hosted_deposit(
    request_id: str, user_id: str, provider: PaymentProvider | None = None,
) -> dict[str, Any]:
    current = await db[COLLECTION].find_one({
        "id": request_id, "user_id": user_id, "source": UPI_SOURCE,
    }, {"_id": 0})
    if not current:
        raise HTTPException(status_code=404, detail={
            "code": "UPI_PURCHASE_NOT_FOUND", "message": "The UPI purchase was not found.",
        })
    if current.get("status") in HOSTED_TERMINAL:
        return request_dto(current)
    claimed = await db[COLLECTION].find_one_and_update(
        {
            "id": request_id, "user_id": user_id, "source": UPI_SOURCE,
            "status": {"$in": ["CREATED", "PENDING"]},
            "$or": [
                {"next_client_check_at": {"$exists": False}},
                {"next_client_check_at": {"$lte": utcnow()}},
            ],
        },
        {"$set": {"next_client_check_at": utcnow() + timedelta(seconds=7)}},
        return_document=ReturnDocument.AFTER,
    )
    if claimed:
        try:
            await reconcile_hosted_deposit(request_id, provider, actor=f"player-return:{user_id}")
        except HTTPException as exc:
            if exc.status_code < 500:
                raise
    stored = await db[COLLECTION].find_one({"id": request_id, "user_id": user_id}, {"_id": 0})
    return request_dto(stored)


def _normalize_utr(value: str) -> str:
    utr = str(value or "").strip().upper()
    if not re.fullmatch(r"[A-Z0-9_-]{4,80}", utr):
        raise HTTPException(status_code=400, detail={
            "code": "UPI_UTR_INVALID",
            "message": "Enter the UTR shown by your UPI app.",
        })
    return utr


async def submit_hosted_utr(
    request_id: str, user_id: str, utr: str, provider: PaymentProvider | None = None,
) -> dict[str, Any]:
    claim = _normalize_utr(utr)
    current = await db[COLLECTION].find_one({
        "id": request_id,
        "user_id": user_id,
        "source": UPI_SOURCE,
        "kind": "DEPOSIT",
    }, {"_id": 0})
    if not current:
        raise HTTPException(status_code=404, detail={
            "code": "UPI_PURCHASE_NOT_FOUND",
            "message": "The UPI purchase was not found.",
        })
    if current.get("status") == "CREDITED":
        return current
    if current.get("status") in HOSTED_TERMINAL:
        raise HTTPException(status_code=409, detail={
            "code": "UPI_PURCHASE_TERMINAL",
            "message": "This UPI purchase can no longer be confirmed.",
        })
    await db[COLLECTION].update_one(
        {"id": request_id, "user_id": user_id, "source": UPI_SOURCE, "status": {"$in": ["CREATED", "PENDING"]}},
        {"$set": {
            "utr_claim": claim,
            "utr_claimed_at": utcnow(),
            "last_error": None,
            "next_reconcile_at": utcnow(),
            "updated_at": utcnow(),
        }, "$inc": {"utr_submit_attempts": 1}},
    )
    result = await reconcile_hosted_deposit(
        request_id, provider, actor=f"player-utr:{user_id}",
    )
    if result.get("utr_mismatch"):
        raise HTTPException(status_code=409, detail={
            "code": "UPI_UTR_NOT_CONFIRMED",
            "message": "SgPay24 has not confirmed this UTR for the purchase.",
        })
    stored = await db[COLLECTION].find_one(
        {"id": request_id, "user_id": user_id, "source": UPI_SOURCE}, {"_id": 0},
    )
    return stored


async def reconcile_hosted_batch(
    provider: PaymentProvider | None = None, limit: int = 25,
) -> dict[str, int]:
    if not await hosted_upi_reconciliation_needed():
        return {"checked": 0, "updated": 0, "errors": 0}
    gateway = provider or hosted_upi_reconciliation_provider()
    cap = max(1, min(int(limit), 100))
    rows = await db[COLLECTION].find({
        "source": UPI_SOURCE,
        "kind": "DEPOSIT",
        "status": {"$in": ["CREATED", "PENDING"]},
        "$or": [
            {"next_reconcile_at": {"$exists": False}},
            {"next_reconcile_at": {"$lte": utcnow()}},
        ],
    }, {"_id": 0, "id": 1}).sort("created_at", 1).limit(cap).to_list(cap)
    updated = errors = 0
    request_ids = [row["id"] for row in rows]
    for row in rows:
        try:
            result = await reconcile_hosted_deposit(row["id"], gateway)
            if result.get("status") in HOSTED_TERMINAL:
                updated += 1
        except HTTPException:
            errors += 1
    logging.getLogger("operator_rail").info(
        "hosted UPI batch checked=%s updated=%s errors=%s ids=%s",
        len(rows), updated, errors, request_ids,
    )
    return {"checked": len(rows), "updated": updated, "errors": errors}


async def ensure_hosted_indexes() -> None:
    await db[COLLECTION].create_index("id", unique=True, name="operator_request_id_unique")
    await db[COLLECTION].create_index(
        [("user_id", 1), ("source", 1), ("idempotency_key", 1)],
        unique=True,
        partialFilterExpression={"source": UPI_SOURCE, "idempotency_key": {"$type": "string"}},
        name="operator_upi_user_idempotency_unique",
    )
    await db[COLLECTION].create_index(
        [("provider", 1), ("provider_order_id", 1)],
        unique=True,
        partialFilterExpression={"source": UPI_SOURCE, "provider_order_id": {"$type": "string"}},
        name="operator_upi_provider_order_unique",
    )
    await db[COLLECTION].create_index(
        [("provider", 1), ("provider_reference", 1)],
        unique=True,
        partialFilterExpression={"source": UPI_SOURCE, "provider_reference": {"$type": "string"}},
        name="operator_upi_provider_reference_unique",
    )
    await db[COLLECTION].create_index(
        [("source", 1), ("status", 1), ("next_reconcile_at", 1)],
        name="operator_upi_reconciliation_due",
    )
    await db[COLLECTION].create_index(
        [("user_id", 1), ("source", 1), ("created_at", -1)],
        name="operator_upi_user_daily_limit",
    )
    await db[DAILY_GUARD_COLLECTION].create_index(
        "gaming_day", name="upi_daily_guard_gaming_day",
    )


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
        {
            "id": request_id,
            "status": "PENDING",
            "$or": [
                {"source": ADMIN_SOURCE},
                {"source": {"$exists": False}},
            ],
        },
        {"$set": {"status": "PROCESSING", "updated_at": utcnow()}},
        return_document=ReturnDocument.AFTER,
    )
    if not claimed:
        existing = await db[COLLECTION].find_one({"id": request_id}, {"_id": 0})
        if not existing:
            raise HTTPException(status_code=404, detail={"code": "OPERATOR_REQUEST_NOT_FOUND", "message": "The request was not found."})
        if existing.get("source") == UPI_SOURCE:
            raise HTTPException(status_code=409, detail={
                "code": "UPI_PROVIDER_VERIFICATION_REQUIRED",
                "message": "Hosted UPI purchases settle only after authenticated provider status verification.",
            })
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
            import wager
            await wager.open_deposit_bucket(claimed["user_id"], int(claimed["chips"]), claimed["id"])
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
    else:
        updated = {**claimed, "status": status}
    if approve and claimed.get("kind") == "WITHDRAWAL":
        try:
            import sgpay_payout
            await sgpay_payout.send_operator_payout(updated, actor=str(admin.get("id") or "admin"))
            refreshed = await db[COLLECTION].find_one({"id": request_id}, {"_id": 0})
            if refreshed:
                updated = refreshed
        except HTTPException:
            refreshed = await db[COLLECTION].find_one({"id": request_id}, {"_id": 0})
            if refreshed:
                updated = refreshed
        except Exception:
            logging.getLogger("operator_rail").exception("SgPay payout failed for %s", request_id)
    return request_dto(updated)
