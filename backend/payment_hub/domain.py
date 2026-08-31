from __future__ import annotations

import re
import secrets
from datetime import datetime, timezone
from enum import StrEnum
from typing import Any, Mapping


class Direction(StrEnum):
    PAYIN = "PAYIN"
    PAYOUT = "PAYOUT"


class PayinStatus(StrEnum):
    CREATED = "CREATED"
    PENDING = "PENDING"
    REQUIRES_ACTION = "REQUIRES_ACTION"
    PROCESSING = "PROCESSING"
    SUCCEEDED = "SUCCEEDED"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"
    EXPIRED = "EXPIRED"
    PARTIALLY_REFUNDED = "PARTIALLY_REFUNDED"
    REFUNDED = "REFUNDED"
    REVERSED = "REVERSED"
    DISPUTED = "DISPUTED"


class PayoutStatus(StrEnum):
    CREATED = "CREATED"
    PENDING_APPROVAL = "PENDING_APPROVAL"
    APPROVED = "APPROVED"
    QUEUED = "QUEUED"
    PROCESSING = "PROCESSING"
    PAID = "PAID"
    FAILED = "FAILED"
    ON_HOLD = "ON_HOLD"
    CANCELLED = "CANCELLED"
    REVERSED = "REVERSED"


class ReconciliationStatus(StrEnum):
    UNMATCHED = "UNMATCHED"
    PARTIALLY_MATCHED = "PARTIALLY_MATCHED"
    MATCHED = "MATCHED"
    MISMATCHED = "MISMATCHED"
    EXCEPTION = "EXCEPTION"
    RESOLVED = "RESOLVED"
    IGNORED_WITH_APPROVAL = "IGNORED_WITH_APPROVAL"


class WebhookStatus(StrEnum):
    RECEIVED = "RECEIVED"
    SIGNATURE_INVALID = "SIGNATURE_INVALID"
    DUPLICATE = "DUPLICATE"
    PROCESSING = "PROCESSING"
    PROCESSED = "PROCESSED"
    RETRY_PENDING = "RETRY_PENDING"
    DEAD_LETTER = "DEAD_LETTER"
    IGNORED = "IGNORED"


class HealthStatus(StrEnum):
    UNKNOWN = "UNKNOWN"
    HEALTHY = "HEALTHY"
    DEGRADED = "DEGRADED"
    DOWN = "DOWN"
    DISABLED = "DISABLED"


class Capability(StrEnum):
    PAYIN = "PAYIN"
    PAYOUT = "PAYOUT"
    PAYMENT_STATUS_QUERY = "PAYMENT_STATUS_QUERY"
    PAYOUT_STATUS_QUERY = "PAYOUT_STATUS_QUERY"
    REFUND = "REFUND"
    PARTIAL_REFUND = "PARTIAL_REFUND"
    CANCELLATION = "CANCELLATION"
    REVERSAL = "REVERSAL"
    WEBHOOKS = "WEBHOOKS"
    HOSTED_CHECKOUT = "HOSTED_CHECKOUT"
    PAYMENT_LINK = "PAYMENT_LINK"
    QR = "QR"
    UPI = "UPI"
    CARD = "CARD"
    BANK_TRANSFER = "BANK_TRANSFER"
    WALLET = "WALLET"
    SETTLEMENT_API = "SETTLEMENT_API"
    SETTLEMENT_FILE = "SETTLEMENT_FILE"
    DISPUTES = "DISPUTES"


class GatewayError(RuntimeError):
    def __init__(self, code: str, message: str, *, retryable: bool = False, status_code: int = 400):
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable
        self.status_code = status_code


PAYIN_TRANSITIONS = {
    PayinStatus.CREATED: {PayinStatus.PENDING, PayinStatus.REQUIRES_ACTION, PayinStatus.PROCESSING, PayinStatus.SUCCEEDED, PayinStatus.FAILED, PayinStatus.CANCELLED},
    PayinStatus.PENDING: {PayinStatus.REQUIRES_ACTION, PayinStatus.PROCESSING, PayinStatus.SUCCEEDED, PayinStatus.FAILED, PayinStatus.CANCELLED, PayinStatus.EXPIRED},
    PayinStatus.REQUIRES_ACTION: {PayinStatus.PENDING, PayinStatus.PROCESSING, PayinStatus.SUCCEEDED, PayinStatus.FAILED, PayinStatus.CANCELLED, PayinStatus.EXPIRED},
    PayinStatus.PROCESSING: {PayinStatus.SUCCEEDED, PayinStatus.FAILED, PayinStatus.REVERSED, PayinStatus.DISPUTED},
    PayinStatus.SUCCEEDED: {PayinStatus.PARTIALLY_REFUNDED, PayinStatus.REFUNDED, PayinStatus.REVERSED, PayinStatus.DISPUTED},
    PayinStatus.PARTIALLY_REFUNDED: {PayinStatus.PARTIALLY_REFUNDED, PayinStatus.REFUNDED, PayinStatus.REVERSED, PayinStatus.DISPUTED},
    PayinStatus.DISPUTED: {PayinStatus.SUCCEEDED, PayinStatus.REVERSED},
}

PAYOUT_TRANSITIONS = {
    PayoutStatus.CREATED: {PayoutStatus.PENDING_APPROVAL, PayoutStatus.CANCELLED},
    PayoutStatus.PENDING_APPROVAL: {PayoutStatus.APPROVED, PayoutStatus.ON_HOLD, PayoutStatus.CANCELLED},
    PayoutStatus.APPROVED: {PayoutStatus.QUEUED, PayoutStatus.PROCESSING, PayoutStatus.ON_HOLD, PayoutStatus.CANCELLED},
    PayoutStatus.QUEUED: {PayoutStatus.PROCESSING, PayoutStatus.FAILED, PayoutStatus.ON_HOLD, PayoutStatus.CANCELLED},
    PayoutStatus.PROCESSING: {PayoutStatus.PAID, PayoutStatus.FAILED, PayoutStatus.ON_HOLD, PayoutStatus.REVERSED},
    PayoutStatus.ON_HOLD: {PayoutStatus.APPROVED, PayoutStatus.QUEUED, PayoutStatus.CANCELLED},
    PayoutStatus.PAID: {PayoutStatus.REVERSED},
}


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def require_transition(direction: Direction | str, current: str, target: str) -> None:
    try:
        if Direction(direction) == Direction.PAYIN:
            source, destination, matrix = PayinStatus(current), PayinStatus(target), PAYIN_TRANSITIONS
        else:
            source, destination, matrix = PayoutStatus(current), PayoutStatus(target), PAYOUT_TRANSITIONS
    except ValueError as exc:
        raise GatewayError("PAYMENT_INVALID_STATUS", "Payment status is invalid.") from exc
    if destination == source:
        return
    if destination not in matrix.get(source, set()):
        raise GatewayError(
            "PAYMENT_INVALID_STATE_TRANSITION",
            f"{source.value} cannot transition to {destination.value}.",
            status_code=409,
        )


def require_money(amount_minor: Any, currency: Any) -> tuple[int, str]:
    if isinstance(amount_minor, bool) or not isinstance(amount_minor, int) or amount_minor <= 0:
        raise GatewayError("PAYMENT_INVALID_AMOUNT", "Amount must be a positive integer in minor units.")
    code = str(currency or "").strip().upper()
    if not re.fullmatch(r"[A-Z]{3}", code):
        raise GatewayError("PAYMENT_INVALID_CURRENCY", "Currency must be an ISO 4217 code.")
    return amount_minor, code


def public_reference(prefix: str, when: datetime | None = None) -> str:
    stamp = (when or utcnow()).strftime("%Y%m%d")
    return f"{prefix}-{stamp}-{secrets.token_hex(4).upper()}"


_SENSITIVE = re.compile(r"(secret|token|password|authorization|signature|cvv|pan|account_number|api[_-]?key|private[_-]?key)", re.I)


def redact(value: Any, *, depth: int = 0) -> Any:
    if depth > 8:
        return "[TRUNCATED]"
    if isinstance(value, Mapping):
        result = {}
        for key, item in list(value.items())[:200]:
            result[str(key)] = "[REDACTED]" if _SENSITIVE.search(str(key)) else redact(item, depth=depth + 1)
        return result
    if isinstance(value, (list, tuple)):
        return [redact(item, depth=depth + 1) for item in value[:200]]
    if isinstance(value, str):
        return value[:2000]
    if value is None or isinstance(value, (int, float, bool, datetime)):
        return value
    return str(value)[:500]


def require_capability(capabilities: set[Capability] | set[str], capability: Capability) -> None:
    normalized = {Capability(item) for item in capabilities}
    if capability not in normalized:
        raise GatewayError("CAPABILITY_NOT_SUPPORTED", f"{capability.value} is not supported.", status_code=409)
