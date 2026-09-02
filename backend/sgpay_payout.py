"""Send approved player withdrawals through SgPay24 to the saved payout method."""
from __future__ import annotations

import logging
import os
import uuid
from datetime import datetime, timezone
from typing import Any, Mapping, Optional

from db import db
from fastapi import HTTPException

log = logging.getLogger("sgpay_payout")


def payouts_enabled() -> bool:
    raw = (os.environ.get("SGPAY24_PAYOUTS_ENABLED") or "true").strip().lower()
    return raw in {"1", "true", "yes", "on"}


def _now():
    return datetime.now(timezone.utc)


def _paise_to_rupees_str(paise: int) -> str:
    return f"{int(paise) / 100:.2f}"


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
            {"$set": {
                "payout_status": "FAILED",
                "payout_error": str(exc)[:500],
                "payout_updated_at": _now(),
                "payout_actor": actor,
            }},
        )
        raise HTTPException(status_code=502, detail={
            "code": "SGPAY_PAYOUT_FAILED",
            "message": "SgPay did not accept the payout. Chips are already reserved; retry from Admin.",
            "error": str(exc)[:300],
        }) from exc

    provider_ref = getattr(submission, "provider_payout_id", None) or (submission.get("provider_payout_id") if isinstance(submission, dict) else None)
    status = getattr(submission, "status", None) or (submission.get("status") if isinstance(submission, dict) else "PROCESSING")
    await db.operator_payment_requests.update_one(
        {"id": request_id},
        {"$set": {
            "payout_status": str(status or "PROCESSING"),
            "payout_ref": provider_ref,
            "payout_error": None,
            "payout_updated_at": _now(),
            "payout_actor": actor,
            "payout_idempotency_key": idempotency,
        }},
    )
    return {"id": request_id, "payout_status": status, "provider_ref": provider_ref}
