"""Send approved player withdrawals through SgPay24 to the saved payout method.

Merchant dashboards cannot set a payout callback URL, so PROCESSING payouts are
settled by polling check-payout-status (mirrors hosted UPI deposit reconcile).
"""
from __future__ import annotations

import logging
import os
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Mapping, Optional

from db import db
from fastapi import HTTPException

log = logging.getLogger("sgpay_payout")

_OPEN_PAYOUT_STATUSES = frozenset({"PROCESSING", "SUBMITTED", "QUEUED", "PENDING"})
_PAID_PROVIDER_STATUSES = frozenset({
    "PAID", "SUCCESS", "SUCCEEDED", "COMPLETED", "COMPLETE", "CREDITED",
})
_FAILED_PROVIDER_STATUSES = frozenset({
    "FAILED", "REJECTED", "CANCELLED", "CANCELED", "EXPIRED",
})
# Request-row terminal once SgPay confirms the bank/UPI transfer.
_PAID_REQUEST_STATUS = "PAID"


def payouts_enabled() -> bool:
    raw = (os.environ.get("SGPAY24_PAYOUTS_ENABLED") or "true").strip().lower()
    return raw in {"1", "true", "yes", "on"}


def _now():
    return datetime.now(timezone.utc)


def _paise_to_rupees_str(paise: int) -> str:
    return f"{int(paise) / 100:.2f}"


def _backoff_seconds(attempts: int) -> int:
    """8s, 16s, 32s, 64s capped at 60s — same shape as hosted UPI reconcile."""
    return min(8 * (2 ** min(max(int(attempts), 0), 4)), 60)


async def _decrypt_method(method: Mapping[str, Any]) -> dict[str, str]:
    from financial_wallet import decrypt_payout_details
    details = decrypt_payout_details(method)
    return {
        "account_holder_name": str(details.get("account_holder_name") or details.get("holder") or ""),
        "account_number": str(details.get("account_number") or details.get("account") or ""),
        "ifsc_code": str(details.get("ifsc_code") or details.get("ifsc") or ""),
        "payout_identifier": str(details.get("payout_identifier") or details.get("upi") or ""),
        "bank_name": str(details.get("bank_name") or details.get("bank") or ""),
    }


async def load_payout_method(user_id: str, method_id: str | None) -> dict[str, Any]:
    query: dict[str, Any] = {"user_id": user_id}
    if method_id:
        query["$or"] = [{"id": method_id}, {"_id": method_id}]
    method = await db.payout_methods.find_one(query)
    if method is None:
        method = await db.payout_methods.find_one({"user_id": user_id, "status": {"$ne": "DELETED"}})
    if method is None:
        # Operator-rail bank details collection used by /payments/bank-details
        method = await db.bank_details.find_one({"user_id": user_id})
    if method is None:
        raise HTTPException(status_code=409, detail={
            "code": "PAYOUT_METHOD_MISSING",
            "message": "Player has no saved bank or UPI payout method.",
        })
    return method


def _status_value(raw: Any) -> str:
    return str(raw or "").strip().upper()


async def send_operator_payout(
    request: Mapping[str, Any],
    *,
    actor: str,
    retry: bool = False,
) -> dict[str, Any]:
    """After Admin approves an operator withdrawal, push it to SgPay24."""
    if not payouts_enabled():
        raise HTTPException(status_code=503, detail={
            "code": "SGPAY_PAYOUT_DISABLED",
            "message": "SgPay payouts are turned off (SGPAY24_PAYOUTS_ENABLED).",
        })
    request_id = request.get("id")
    existing = str(request.get("payout_status") or "")
    if existing in {"PAID", "PROCESSING"} and not retry:
        return {"id": request_id, "payout_status": existing, "provider_ref": request.get("payout_ref")}
    if existing == "PAID":
        return {"id": request_id, "payout_status": "PAID", "provider_ref": request.get("payout_ref")}

    user_id = request["user_id"]
    method_id = request.get("payout_method_id") or request.get("bank_account_id") or request.get("bank_detail_id")
    method = await load_payout_method(user_id, method_id)
    details = await _decrypt_method(method)

    chips = int(request.get("chips") or 0)
    from wager import chips_to_paise
    paise = int(request.get("amount_paise") or chips_to_paise(chips))
    idempotency = f"op-wd-{request_id}"

    user = await db.users.find_one({"id": user_id}, {
        "_id": 0, "email": 1, "email_normalized": 1, "phone": 1, "phone_normalized": 1,
    }) or {}
    phone = str(user.get("phone_normalized") or user.get("phone") or request.get("phone") or "")
    email = str(user.get("email_normalized") or user.get("email") or request.get("user_email") or "")

    from payment_providers import load_payment_provider
    provider = load_payment_provider()
    try:
        submission = await provider.submit_payout(
            withdrawal_id=str(request_id),
            provider_beneficiary_id=str(method.get("id") or method_id or user_id),
            amount_paise=paise,
            currency="INR",
            idempotency_key=idempotency,
            account_holder_name=details["account_holder_name"],
            account_number=details["account_number"],
            ifsc_code=details["ifsc_code"],
            payout_identifier=details["payout_identifier"],
            bank_name=details["bank_name"],
            phone=phone,
            email=email,
        )
    except Exception as exc:
        log.exception("SgPay payout failed for %s", request_id)
        await db.operator_payment_requests.update_one(
            {"id": request_id},
            {"$setOnInsert": {
                **dict(request),
                "id": request_id,
                "created_at": request.get("created_at") or _now(),
            }, "$set": {
                "payout_status": "FAILED",
                "payout_error": str(exc)[:500],
                "payout_updated_at": _now(),
                "payout_actor": actor,
            }},
            upsert=True,
        )
        raise HTTPException(status_code=502, detail={
            "code": "SGPAY_PAYOUT_FAILED",
            "message": f"SgPay did not accept the payout: {str(exc)[:200]}. Funds remain reserved; retry from Admin.",
            "error": str(exc)[:300],
        }) from exc

    provider_ref = getattr(submission, "provider_payout_id", None) or (submission.get("provider_payout_id") if isinstance(submission, dict) else None)
    status = getattr(submission, "status", None) or (submission.get("status") if isinstance(submission, dict) else "PROCESSING")
    status_text = str(status or "PROCESSING")
    update: dict[str, Any] = {
        "payout_status": status_text,
        "payout_ref": provider_ref,
        "payout_error": None,
        "payout_updated_at": _now(),
        "payout_actor": actor,
        "payout_idempotency_key": idempotency,
    }
    # Merchant cannot configure a payout webhook — schedule status polling.
    if status_text.upper() in _OPEN_PAYOUT_STATUSES:
        update["next_payout_reconcile_at"] = _now() + timedelta(seconds=8)
        update["payout_reconcile_attempts"] = 0
    await db.operator_payment_requests.update_one(
        {"id": request_id},
        {"$set": update},
    )
    return {"id": request_id, "payout_status": status, "provider_ref": provider_ref}


async def reconcile_operator_payout(
    request_id: str,
    provider=None,
    *,
    actor: str = "payout-reconciliation-job",
) -> dict[str, Any]:
    """Poll SgPay check-payout-status and settle one PROCESSING operator withdrawal.

    Chips were already debited on Admin approve. FAILED leaves the request
    APPROVED with payout_status FAILED so Admin can retry — never silent-refund.
    """
    row = await db.operator_payment_requests.find_one({"id": request_id}, {"_id": 0})
    if not row:
        raise HTTPException(status_code=404, detail={
            "code": "OPERATOR_REQUEST_NOT_FOUND",
            "message": "The request was not found.",
        })
    if str(row.get("kind") or "").upper() != "WITHDRAWAL":
        raise HTTPException(status_code=409, detail={
            "code": "PAYOUT_NOT_WITHDRAWAL",
            "message": "Only withdrawals can be payout-reconciled.",
        })

    payout_status = _status_value(row.get("payout_status"))
    if payout_status == "PAID" or _status_value(row.get("status")) == _PAID_REQUEST_STATUS:
        return {
            "id": request_id,
            "payout_status": "PAID",
            "status": row.get("status") or _PAID_REQUEST_STATUS,
            "duplicate": True,
        }
    if payout_status not in _OPEN_PAYOUT_STATUSES and payout_status != "FAILED":
        # FAILED rows are not auto-polled by the batch; sync endpoint may still
        # re-check if Admin wants a fresh provider read after a flake.
        if payout_status and payout_status not in {"FAILED", "SUBMITTED", "PROCESSING", "QUEUED", "PENDING"}:
            return {
                "id": request_id,
                "payout_status": payout_status or None,
                "status": row.get("status"),
                "skipped": True,
            }

    if provider is None:
        from payment_providers import load_payment_provider
        provider = load_payment_provider()

    order_id = str(row.get("payout_ref") or request_id)
    try:
        authoritative = await provider.get_payout_status(order_id)
    except Exception as exc:
        log.warning("SgPay payout status lookup failed for %s: %s", request_id, type(exc).__name__)
        attempts = int(row.get("payout_reconcile_attempts") or 0) + 1
        await db.operator_payment_requests.update_one(
            {"id": request_id},
            {"$set": {
                "next_payout_reconcile_at": _now() + timedelta(seconds=_backoff_seconds(attempts)),
                "payout_updated_at": _now(),
                "last_payout_reconcile_error": str(exc)[:300],
                "payout_reconcile_actor": actor,
            }, "$inc": {"payout_reconcile_attempts": 1}},
        )
        return {
            "id": request_id,
            "payout_status": payout_status or "PROCESSING",
            "status": row.get("status"),
            "error": type(exc).__name__,
        }

    mapped = _status_value(
        getattr(authoritative, "status", None)
        if not isinstance(authoritative, Mapping)
        else authoritative.get("status")
    )
    provider_reference = (
        getattr(authoritative, "provider_reference", None)
        if not isinstance(authoritative, Mapping)
        else authoritative.get("provider_reference")
    )
    utr = str(provider_reference or "").strip() or None

    if mapped in _PAID_PROVIDER_STATUSES or mapped == "PAID":
        set_fields: dict[str, Any] = {
            "payout_status": "PAID",
            "payout_error": None,
            "payout_updated_at": _now(),
            "payout_reconcile_actor": actor,
            "status": _PAID_REQUEST_STATUS,
            "paid_at": _now(),
            "next_payout_reconcile_at": None,
        }
        if utr:
            set_fields["provider_reference"] = utr
        await db.operator_payment_requests.update_one(
            {
                "id": request_id,
                "payout_status": {"$in": list(_OPEN_PAYOUT_STATUSES | {"FAILED"})},
            },
            {"$set": set_fields},
        )
        refreshed = await db.operator_payment_requests.find_one({"id": request_id}, {"_id": 0})
        log.info(
            "operator payout reconcile request_id=%s result=PAID actor=%s",
            request_id, actor,
        )
        return {
            "id": request_id,
            "payout_status": "PAID",
            "status": (refreshed or {}).get("status") or _PAID_REQUEST_STATUS,
            "provider_reference": utr,
        }

    if mapped in _FAILED_PROVIDER_STATUSES:
        # Chips stay reserved (already debited on approve). Admin retries via
        # /retry-payout — do not invent a silent refund.
        error_text = f"Provider payout status: {mapped}"
        await db.operator_payment_requests.update_one(
            {
                "id": request_id,
                "payout_status": {"$in": list(_OPEN_PAYOUT_STATUSES)},
            },
            {"$set": {
                "payout_status": "FAILED",
                "payout_error": error_text[:500],
                "payout_updated_at": _now(),
                "payout_reconcile_actor": actor,
                "next_payout_reconcile_at": None,
            }},
        )
        log.info(
            "operator payout reconcile request_id=%s result=FAILED actor=%s",
            request_id, actor,
        )
        return {
            "id": request_id,
            "payout_status": "FAILED",
            "status": row.get("status"),
            "payout_error": error_text,
        }

    # Still PROCESSING / SUBMITTED / unknown — backoff and try again.
    attempts = int(row.get("payout_reconcile_attempts") or 0) + 1
    next_at = _now() + timedelta(seconds=_backoff_seconds(attempts))
    await db.operator_payment_requests.update_one(
        {"id": request_id, "payout_status": {"$in": list(_OPEN_PAYOUT_STATUSES)}},
        {"$set": {
            "payout_status": mapped if mapped in _OPEN_PAYOUT_STATUSES else "PROCESSING",
            "next_payout_reconcile_at": next_at,
            "payout_updated_at": _now(),
            "payout_reconcile_actor": actor,
            "payout_error": None,
        }, "$inc": {"payout_reconcile_attempts": 1}},
    )
    return {
        "id": request_id,
        "payout_status": mapped if mapped in _OPEN_PAYOUT_STATUSES else "PROCESSING",
        "status": row.get("status"),
        "next_payout_reconcile_at": next_at.isoformat(),
    }


async def reconcile_operator_payout_batch(
    provider=None, limit: int = 25,
) -> dict[str, int]:
    """Poll due PROCESSING/SUBMITTED operator withdrawals."""
    if not payouts_enabled():
        return {"checked": 0, "updated": 0, "errors": 0}
    if provider is None:
        from payment_providers import load_payment_provider
        provider = load_payment_provider()
    cap = max(1, min(int(limit), 100))
    due = _now()
    query = {
        "kind": "WITHDRAWAL",
        "payout_status": {"$in": list(_OPEN_PAYOUT_STATUSES)},
        "$or": [
            {"next_payout_reconcile_at": {"$exists": False}},
            {"next_payout_reconcile_at": None},
            {"next_payout_reconcile_at": {"$lte": due}},
        ],
    }
    rows = await db.operator_payment_requests.find(
        query, {"_id": 0, "id": 1},
    ).sort("created_at", 1).limit(cap).to_list(cap)
    updated = errors = 0
    request_ids = [row["id"] for row in rows]
    for row in rows:
        try:
            result = await reconcile_operator_payout(
                row["id"], provider, actor="payout-reconciliation-job",
            )
            if result.get("payout_status") in {"PAID", "FAILED"} and not result.get("duplicate"):
                updated += 1
        except HTTPException:
            errors += 1
        except Exception:
            log.exception("operator payout reconcile failed for %s", row.get("id"))
            errors += 1
    log.info(
        "operator payout batch checked=%s updated=%s errors=%s ids=%s",
        len(rows), updated, errors, request_ids,
    )
    return {"checked": len(rows), "updated": updated, "errors": errors}
