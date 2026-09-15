"""Single-submit SGPay withdrawals; only authenticated status reads settle them.

Approval already debits chips. An ambiguous send is never replayed or refunded;
polling and unsigned webhook notifications share the same bound status lookup.
"""
from __future__ import annotations

import logging
import os
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Mapping

from db import db
from fastapi import HTTPException
from pymongo import ReturnDocument

log = logging.getLogger("sgpay_payout")
_OPEN_PAYOUT_STATUSES = frozenset({
    "SUBMITTING", "SUBMISSION_UNKNOWN", "PROCESSING", "SUBMITTED", "QUEUED", "PENDING",
})
_PAID_PROVIDER_STATUSES = frozenset({"PAID", "SUCCESS", "SUCCEEDED", "COMPLETED", "COMPLETE", "CREDITED"})
_FAILED_PROVIDER_STATUSES = frozenset({"FAILED", "REJECTED", "CANCELLED", "CANCELED", "EXPIRED"})


def payouts_enabled() -> bool:
    return (os.environ.get("SGPAY24_PAYOUTS_ENABLED") or "true").strip().lower() in {"1", "true", "yes", "on"}


def _now():
    return datetime.now(timezone.utc)


def _backoff_seconds(attempts: int) -> int:
    return min(8 * (2 ** min(max(int(attempts), 0), 4)), 60)


def _status_value(raw: Any) -> str:
    return str(raw or "").strip().upper()


def _error(code: str, message: str, status: int = 409) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "message": message})


def _result(row: Mapping[str, Any], **extra) -> dict[str, Any]:
    return {
        "id": row.get("id"), "status": row.get("status"),
        "payout_status": row.get("payout_status"),
        "provider_ref": row.get("payout_provider_id") or row.get("payout_ref"),
        "provider_reference": row.get("provider_reference"), **extra,
    }


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
    # Never replace the beneficiary approved for this request with another account.
    method = await db.payout_methods.find_one({
        "id": method_id, "user_id": user_id, "status": "ACTIVE",
    }) if method_id else None
    if not method:
        raise _error("PAYOUT_METHOD_MISSING", "The exact saved payout method is unavailable. Review this withdrawal.")
    return method


def _fresh_submission_query(request_id: str) -> dict[str, Any]:
    return {
        "id": request_id, "kind": "WITHDRAWAL", "status": "APPROVED",
        "payout_status": {"$in": [None, "PREPARATION_FAILED"]},
        "payout_submission_claim_id": None, "payout_submission_started_at": None,
        "payout_provider_id": None, "payout_ref": None,
    }


async def send_operator_payout(request: Mapping[str, Any], *, actor: str, retry: bool = False) -> dict[str, Any]:
    from payment_providers import PayoutBankAccountRequired, PayoutSubmission, load_payment_provider
    request_id = str(request.get("id") or "")
    row = await db.operator_payment_requests.find_one({"id": request_id, "kind": "WITHDRAWAL"})
    if not row:
        raise _error("OPERATOR_REQUEST_NOT_FOUND", "The withdrawal was not found.", 404)
    if _status_value(row.get("status")) == "PAID":
        return _result(row, duplicate=True)
    if _status_value(row.get("status")) != "APPROVED":
        raise _error("PAYOUT_NOT_APPROVED", "Only an approved withdrawal can be sent.")
    state = _status_value(row.get("payout_status"))
    issued = any(row.get(key) for key in (
        "payout_submission_claim_id", "payout_submission_started_at", "payout_provider_id", "payout_ref",
    )) or state not in {"", "PREPARATION_FAILED"}
    # Legacy blank/FAILED rows may have lost the accepted response. Retry is a
    # status check, never another transfer. Only a proven preflight failure retries.
    if issued or (retry and state != "PREPARATION_FAILED"):
        if state == "SUBMITTING":
            return _result(row, duplicate=True, reconciliation_required=True)
        return await reconcile_operator_payout(request_id, actor=actor)
    if not payouts_enabled():
        # Approval already debited chips. Persist proof that this fresh order
        # never reached the provider so re-enabling intake permits one send.
        # The same CAS as the submission claim cannot overwrite a concurrent send.
        await db.operator_payment_requests.update_one(_fresh_submission_query(request_id), {"$set": {
            "payout_status": "PREPARATION_FAILED", "payout_updated_at": _now(), "payout_actor": actor,
            "payout_error": "New SGPay payouts are currently disabled. This payout was not sent.",
        }})
        raise _error("SGPAY_PAYOUT_DISABLED", "New SGPay payouts are currently disabled.", 503)

    try:
        method_id = row.get("payout_method_id") or row.get("bank_account_id") or row.get("bank_detail_id")
        method = await load_payout_method(row["user_id"], method_id)
        details = await _decrypt_method(method)
        amount = int(row.get("amount_paise") or 0)
        if amount <= 0:
            raise ValueError("Missing committed withdrawal amount")
        provider = load_payment_provider()
        if provider.name != "sgpay24" or not getattr(provider, "merchant_id", None):
            raise ValueError("Wrong payout provider")
        user = await db.users.find_one({"id": row["user_id"]}, {
            "email": 1, "email_normalized": 1, "phone": 1, "phone_normalized": 1,
        }) or {}
        kwargs = {
            "withdrawal_id": request_id, "provider_beneficiary_id": str(method["id"]),
            "amount_paise": amount, "currency": "INR", "idempotency_key": f"op-wd-{request_id}",
            **details,
            "phone": str(user.get("phone_normalized") or user.get("phone") or row.get("phone") or ""),
            "email": str(user.get("email_normalized") or user.get("email") or row.get("user_email") or ""),
        }
        provider.validate_payout(**kwargs)
    except Exception as exc:
        message = ("SGPay payouts require a saved bank account, IFSC and bank name. This payout was not sent."
                   if isinstance(exc, PayoutBankAccountRequired)
                   else "Payout preparation failed; check the saved beneficiary and payout configuration.")
        await db.operator_payment_requests.update_one(_fresh_submission_query(request_id), {"$set": {
            "payout_status": "PREPARATION_FAILED", "payout_updated_at": _now(), "payout_actor": actor,
            "payout_error": message,
        }})
        if isinstance(exc, PayoutBankAccountRequired):
            raise _error("PAYOUT_BANK_ACCOUNT_REQUIRED", message) from exc
        if isinstance(exc, HTTPException):
            raise
        raise _error("PAYOUT_PREPARATION_FAILED", "Payout was not sent. Check the saved beneficiary and payout configuration.") from exc

    claim_id = str(uuid.uuid4())
    claimed = await db.operator_payment_requests.find_one_and_update(
        _fresh_submission_query(request_id), {"$set": {
            "payout_status": "SUBMITTING", "payout_submission_claim_id": claim_id,
            "payout_submission_started_at": _now(), "payout_merchant_order_id": request_id,
            "payout_provider": "sgpay24", "payout_merchant_id": provider.merchant_id,
            "payout_method_id": method["id"],
            "payout_method_snapshot": dict(method), "payout_idempotency_key": kwargs["idempotency_key"],
            "payout_actor": actor, "payout_error": None, "payout_updated_at": _now(),
            # Allow the provider's bounded HTTP call to finish before normal polling.
            "next_payout_reconcile_at": _now() + timedelta(seconds=60), "payout_reconcile_attempts": 0,
        }}, return_document=ReturnDocument.AFTER,
    )
    if not claimed:
        latest = await db.operator_payment_requests.find_one({"id": request_id}) or row
        return _result(latest, duplicate=True, reconciliation_required=True)
    claim_query = {
        "id": request_id, "status": "APPROVED", "payout_submission_claim_id": claim_id,
        "payout_status": {"$in": ["SUBMITTING", "SUBMISSION_UNKNOWN"]},
    }
    try:
        submission = await provider.submit_payout(**kwargs)
        if not isinstance(submission, PayoutSubmission):
            raise ValueError("Invalid payout submission response")
        # A webhook may have settled while create was in flight. Preserve its
        # terminal state while retaining the receipt for the same claimed order.
        if submission.provider_payout_id:
            await db.operator_payment_requests.update_one({
                "id": request_id, "payout_submission_claim_id": claim_id,
                "payout_provider_id": None,
            }, {"$set": {
                "payout_provider_id": submission.provider_payout_id,
                "payout_ref": submission.provider_payout_id,
            }})
        await db.operator_payment_requests.update_one(claim_query, {"$set": {
            "payout_status": "PROCESSING", "payout_submission_status": submission.status,
            "payout_error": None, "payout_updated_at": _now(),
            "next_payout_reconcile_at": _now() + timedelta(seconds=8),
        }})
    except Exception as exc:
        # Even HTTP errors can occur after provider acceptance. Durable claim is
        # never released, and no raw provider response/beneficiary leaks into UI.
        await db.operator_payment_requests.update_one(claim_query, {"$set": {
            "payout_status": "SUBMISSION_UNKNOWN", "payout_updated_at": _now(),
            "payout_error": "Submission outcome is unknown. Sync provider status; do not resend.",
            "next_payout_reconcile_at": _now() + timedelta(seconds=8),
        }})
        log.warning("SGPay payout submission uncertain request_id=%s error=%s", request_id, type(exc).__name__)
        raise _error("PAYOUT_SUBMISSION_UNKNOWN", "Submission outcome is unknown. Funds remain reserved; sync provider status without resending.", 503) from exc
    latest = await db.operator_payment_requests.find_one({"id": request_id}) or claimed
    return _result(latest)


async def _schedule_reconciliation(row: Mapping[str, Any], actor: str, code: str) -> None:
    attempts = int(row.get("payout_reconcile_attempts") or 0) + 1
    await db.operator_payment_requests.update_one({
        "id": row["id"], "status": "APPROVED", "payout_status": row.get("payout_status"),
        "payout_failure_confirmed": {"$ne": True},
    }, {"$set": {
        "next_payout_reconcile_at": _now() + timedelta(seconds=_backoff_seconds(attempts)),
        "payout_updated_at": _now(), "last_payout_reconcile_error": code, "payout_reconcile_actor": actor,
    }, "$inc": {"payout_reconcile_attempts": 1}})


async def reconcile_operator_payout(request_id: str, provider=None, *, actor: str = "payout-reconciliation-job") -> dict[str, Any]:
    """Read status only. No transfer, refund, replay or trust in callback contents."""
    from payment_providers import PayoutStatus, load_payment_provider
    row = await db.operator_payment_requests.find_one({"id": request_id, "kind": "WITHDRAWAL"})
    if not row:
        raise _error("OPERATOR_REQUEST_NOT_FOUND", "The withdrawal was not found.", 404)
    if _status_value(row.get("status")) == "PAID":
        return _result(row, duplicate=True)
    if _status_value(row.get("status")) != "APPROVED":
        raise _error("PAYOUT_NOT_APPROVED", "Only approved withdrawals can be reconciled.")
    if _status_value(row.get("payout_status")) == "PREPARATION_FAILED":
        return _result(row, skipped=True)
    order_id = str(row.get("payout_merchant_order_id") or request_id)
    try:
        provider = provider or load_payment_provider()
        if (provider.name != "sgpay24" or row.get("payout_provider") not in (None, "sgpay24")
                or row.get("payout_merchant_id") not in (None, provider.merchant_id) or order_id != request_id):
            raise ValueError("Payout provider provenance mismatch")
        authoritative = await provider.get_payout_status(order_id)
    except Exception as exc:
        await _schedule_reconciliation(row, actor, "PAYOUT_STATUS_UNAVAILABLE")
        raise _error("PAYOUT_STATUS_UNAVAILABLE", "Provider status could not be confirmed. No transfer was resent.", 503) from exc
    binding_valid = (
        isinstance(authoritative, PayoutStatus)
        and bool(getattr(provider, "merchant_id", None))
        and authoritative.provider_merchant_id == provider.merchant_id
        and authoritative.withdrawal_id == order_id
        and (authoritative.amount_paise is None or authoritative.amount_paise == row.get("amount_paise"))
        and (authoritative.currency is None or authoritative.currency == "INR")
        and (not row.get("payout_provider_id") or not authoritative.provider_payout_id
             or str(authoritative.provider_payout_id) == str(row["payout_provider_id"]))
    )
    if not binding_valid:
        await _schedule_reconciliation(row, actor, "PAYOUT_STATUS_BINDING_MISMATCH")
        raise _error("PAYOUT_STATUS_BINDING_MISMATCH", "Provider status did not match this withdrawal. Funds remain reserved.")
    mapped = _status_value(authoritative.status)
    fields: dict[str, Any] = {
        "payout_provider": "sgpay24", "payout_merchant_id": provider.merchant_id,
        "payout_merchant_order_id": order_id,
        "payout_updated_at": _now(), "payout_reconcile_actor": actor, "last_payout_reconcile_error": None,
    }
    if authoritative.provider_payout_id:
        fields.update(payout_provider_id=str(authoritative.provider_payout_id), payout_ref=str(authoritative.provider_payout_id))
    if authoritative.provider_reference:
        fields["provider_reference"] = authoritative.provider_reference
    if mapped in _PAID_PROVIDER_STATUSES:
        fields.update(status="PAID", payout_status="PAID", paid_at=_now(), payout_error=None, next_payout_reconcile_at=None)
    elif mapped in _FAILED_PROVIDER_STATUSES:
        fields.update(payout_status="FAILED", payout_failure_confirmed=True,
                      payout_error="Provider payout status: FAILED. Manual review required; do not resend.", next_payout_reconcile_at=None)
    else:
        # An older pending response cannot reverse a confirmed failure.
        if row.get("payout_failure_confirmed"):
            return _result(row, duplicate=True)
        fields.update(payout_status="PROCESSING", payout_error=None,
                      next_payout_reconcile_at=_now() + timedelta(seconds=_backoff_seconds(int(row.get("payout_reconcile_attempts") or 0) + 1)))
    query = {"id": request_id, "status": "APPROVED"}
    if fields["payout_status"] != "PAID":
        query["payout_status"] = row.get("payout_status")
        query["payout_reconcile_attempts"] = row.get("payout_reconcile_attempts")
    await db.operator_payment_requests.update_one(query, {"$set": fields, "$inc": {"payout_reconcile_attempts": 1}})
    latest = await db.operator_payment_requests.find_one({"id": request_id}) or row
    return _result(latest)


def _due_reconciliation_query() -> dict[str, Any]:
    return {"kind": "WITHDRAWAL", "status": "APPROVED", "payout_provider": {"$in": [None, "sgpay24"]}, "$and": [
        {"$or": [
            {"payout_status": {"$in": list(_OPEN_PAYOUT_STATUSES | {"PAID"}) + [None]}},
            {"payout_status": "FAILED", "payout_failure_confirmed": {"$ne": True}},
        ]},
        {"$or": [{"next_payout_reconcile_at": None}, {"next_payout_reconcile_at": {"$lte": _now()}}]},
    ]}


async def operator_payout_reconciliation_needed() -> bool:
    """Keep worker polling outstanding obligations when new intake is disabled."""
    if payouts_enabled():
        return True
    return bool(await db.operator_payment_requests.find_one(_due_reconciliation_query(), {"id": 1}))


async def reconcile_operator_payout_batch(provider=None, limit: int = 25) -> dict[str, int]:
    """Reconcile issued/legacy uncertain payouts even when new payouts are disabled."""
    cap = max(1, min(int(limit), 100))
    query = _due_reconciliation_query()
    rows = await db.operator_payment_requests.find(query, {"id": 1}).sort("next_payout_reconcile_at", 1).limit(cap).to_list(cap)
    updated = errors = 0
    for row in rows:
        try:
            result = await reconcile_operator_payout(row["id"], provider)
            if result.get("payout_status") in {"PAID", "FAILED"} and not result.get("duplicate"):
                updated += 1
        except Exception as exc:
            log.warning("Payout reconciliation deferred request_id=%s error=%s", row["id"], type(exc).__name__)
            errors += 1
    return {"checked": len(rows), "updated": updated, "errors": errors}
