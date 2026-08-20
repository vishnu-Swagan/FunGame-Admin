"""Provider-neutral deposit and payout adapter contracts.

Only the deterministic mock adapter ships in this repository.  It is useful for
local tests, but is deliberately impossible to load in production: adding a
real provider means adding a separately reviewed adapter rather than silently
turning the mock into a money path.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import time
from dataclasses import dataclass
from typing import Any, Mapping, Optional, Protocol


MAX_WEBHOOK_BODY_BYTES = 64 * 1024
DEFAULT_WEBHOOK_TOLERANCE_SECONDS = 300


class ProviderConfigurationError(RuntimeError):
    pass


class ProviderRequestError(RuntimeError):
    """The provider refused or could not complete a request."""


class WebhookVerificationError(ValueError):
    pass


@dataclass(frozen=True)
class ProviderCapabilities:
    deposit_idempotency: bool
    payment_status_lookup: bool
    payout_idempotency: bool
    payout_status_lookup: bool
    payout_cancellation: bool = False
    refunds: bool = False


@dataclass(frozen=True)
class DepositSession:
    provider_order_id: str
    checkout_url: str
    status: str = "PENDING"


@dataclass(frozen=True)
class DepositStatus:
    """Authoritative provider view used for server-side reconciliation.

    A terminal payment decision is unsafe without the provider's amount,
    currency, and immutable payment reference.  Adapters must therefore return
    the complete object instead of a convenient status string.
    """

    status: str
    amount_paise: Optional[int]
    currency: Optional[str]
    provider_reference: Optional[str]


@dataclass(frozen=True)
class Beneficiary:
    provider_beneficiary_id: str
    status: str = "CREATED"


@dataclass(frozen=True)
class PayoutSubmission:
    provider_payout_id: str
    status: str = "PROCESSING"


@dataclass(frozen=True)
class PayoutStatus:
    """Authoritative provider payout state bound to the original instruction."""

    status: str
    amount_paise: Optional[int]
    currency: Optional[str]
    withdrawal_id: Optional[str]
    idempotency_key: Optional[str]
    provider_beneficiary_id: Optional[str]
    provider_reference: Optional[str]


@dataclass(frozen=True)
class ProviderEvent:
    event_id: str
    event_type: str
    object_id: str
    amount_paise: Optional[int]
    currency: Optional[str]
    provider_reference: Optional[str]
    occurred_at: Optional[str]
    data: dict[str, Any]


class PaymentProvider(Protocol):
    name: str
    capabilities: ProviderCapabilities

    async def create_deposit_order(
        self, *, deposit_id: str, amount_paise: int, currency: str,
        idempotency_key: str, return_url: str,
    ) -> DepositSession: ...

    async def create_checkout_session(
        self, *, provider_order_id: str, return_url: str,
    ) -> DepositSession: ...

    async def get_payment_status(self, provider_order_id: str) -> DepositStatus: ...

    async def create_beneficiary(
        self, *, bank_details: Mapping[str, str], idempotency_key: str,
    ) -> Beneficiary: ...

    async def submit_payout(
        self, *, withdrawal_id: str, provider_beneficiary_id: str,
        amount_paise: int, currency: str, idempotency_key: str,
    ) -> PayoutSubmission: ...

    async def get_payout_status(self, provider_payout_id: str) -> PayoutStatus: ...

    async def cancel_payout(self, provider_payout_id: str) -> str: ...

    async def refund_payment(self, provider_order_id: str, amount_paise: int) -> str: ...

    def verify_webhook(self, raw_body: bytes, headers: Mapping[str, str]) -> ProviderEvent: ...


def _header(headers: Mapping[str, str], name: str) -> str:
    wanted = name.lower()
    for key, value in headers.items():
        if str(key).lower() == wanted:
            return str(value).strip()
    return ""


def _strict_positive_int(value: Any, field: str) -> Optional[int]:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise WebhookVerificationError(f"{field} must be a positive integer")
    return value


class MockPaymentProvider:
    """Signed deterministic sandbox adapter.

    It performs no network or money movement.  Tests can create webhook bodies
    using :meth:`sign_webhook`; production refuses to instantiate this class.
    """

    name = "mock"
    capabilities = ProviderCapabilities(
        deposit_idempotency=True,
        payment_status_lookup=True,
        payout_idempotency=True,
        payout_status_lookup=True,
        payout_cancellation=True,
        refunds=True,
    )

    def __init__(self, webhook_secret: str, tolerance_seconds: int = DEFAULT_WEBHOOK_TOLERANCE_SECONDS):
        if len(webhook_secret) < 32:
            raise ProviderConfigurationError("PAYMENT_WEBHOOK_SECRET must contain at least 32 characters")
        if not 30 <= int(tolerance_seconds) <= 900:
            raise ProviderConfigurationError("PAYMENT_WEBHOOK_TOLERANCE_SECONDS must be between 30 and 900")
        self._secret = webhook_secret.encode("utf-8")
        self._tolerance = int(tolerance_seconds)
        self._deposit_orders: dict[str, tuple[int, str]] = {}
        self._payouts: dict[str, dict[str, Any]] = {}

    @staticmethod
    def _stable(prefix: str, value: str) -> str:
        return f"{prefix}_{hashlib.sha256(value.encode('utf-8')).hexdigest()[:24]}"

    async def create_deposit_order(
        self, *, deposit_id: str, amount_paise: int, currency: str,
        idempotency_key: str, return_url: str,
    ) -> DepositSession:
        provider_id = self._stable("mock_order", idempotency_key)
        self._deposit_orders[provider_id] = (int(amount_paise), str(currency))
        return DepositSession(provider_id, f"https://mock-payments.invalid/checkout/{provider_id}")

    async def create_checkout_session(
        self, *, provider_order_id: str, return_url: str,
    ) -> DepositSession:
        return DepositSession(provider_order_id, f"https://mock-payments.invalid/checkout/{provider_order_id}")

    async def get_payment_status(self, provider_order_id: str) -> DepositStatus:
        details = self._deposit_orders.get(provider_order_id)
        return DepositStatus(
            status="PENDING",
            amount_paise=details[0] if details else None,
            currency=details[1] if details else None,
            provider_reference=(
                self._stable("mock_payment", provider_order_id) if details else None
            ),
        )

    async def create_beneficiary(
        self, *, bank_details: Mapping[str, str], idempotency_key: str,
    ) -> Beneficiary:
        return Beneficiary(self._stable("mock_beneficiary", idempotency_key))

    async def submit_payout(
        self, *, withdrawal_id: str, provider_beneficiary_id: str,
        amount_paise: int, currency: str, idempotency_key: str,
    ) -> PayoutSubmission:
        provider_id = self._stable("mock_payout", idempotency_key)
        self._payouts[provider_id] = {
            "amount_paise": int(amount_paise), "currency": str(currency),
            "withdrawal_id": str(withdrawal_id), "idempotency_key": str(idempotency_key),
            "provider_beneficiary_id": str(provider_beneficiary_id),
        }
        return PayoutSubmission(provider_id, "PROCESSING")

    async def get_payout_status(self, provider_payout_id: str) -> PayoutStatus:
        details = self._payouts.get(provider_payout_id) or {}
        return PayoutStatus(
            status="PROCESSING",
            amount_paise=details.get("amount_paise"),
            currency=details.get("currency"),
            withdrawal_id=details.get("withdrawal_id"),
            idempotency_key=details.get("idempotency_key"),
            provider_beneficiary_id=details.get("provider_beneficiary_id"),
            provider_reference=provider_payout_id if details else None,
        )

    async def cancel_payout(self, provider_payout_id: str) -> str:
        return "CANCELLED"

    async def refund_payment(self, provider_order_id: str, amount_paise: int) -> str:
        return self._stable("mock_refund", f"{provider_order_id}:{amount_paise}")

    def sign_webhook(self, raw_body: bytes, timestamp: Optional[int] = None) -> dict[str, str]:
        stamp = int(time.time() if timestamp is None else timestamp)
        signed = str(stamp).encode("ascii") + b"." + raw_body
        signature = hmac.new(self._secret, signed, hashlib.sha256).hexdigest()
        return {
            "X-Chakri-Timestamp": str(stamp),
            "X-Chakri-Signature": f"sha256={signature}",
            "Content-Type": "application/json",
        }

    def verify_webhook(self, raw_body: bytes, headers: Mapping[str, str]) -> ProviderEvent:
        if not raw_body or len(raw_body) > MAX_WEBHOOK_BODY_BYTES:
            raise WebhookVerificationError("Webhook body is empty or too large")
        raw_stamp = _header(headers, "x-chakri-timestamp")
        supplied = _header(headers, "x-chakri-signature")
        if supplied.startswith("sha256="):
            supplied = supplied[7:]
        try:
            stamp = int(raw_stamp)
        except (TypeError, ValueError) as exc:
            raise WebhookVerificationError("Webhook timestamp is invalid") from exc
        if abs(int(time.time()) - stamp) > self._tolerance:
            raise WebhookVerificationError("Webhook timestamp is outside the replay window")
        if len(supplied) != 64:
            raise WebhookVerificationError("Webhook signature is invalid")
        expected = hmac.new(
            self._secret, str(stamp).encode("ascii") + b"." + raw_body, hashlib.sha256,
        ).hexdigest()
        if not hmac.compare_digest(expected, supplied.lower()):
            raise WebhookVerificationError("Webhook signature is invalid")
        try:
            payload = json.loads(raw_body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise WebhookVerificationError("Webhook body is not valid JSON") from exc
        if not isinstance(payload, dict):
            raise WebhookVerificationError("Webhook body must be an object")
        event_id = payload.get("id")
        event_type = payload.get("type")
        object_id = payload.get("object_id")
        if not all(isinstance(value, str) and 1 <= len(value) <= 160
                   for value in (event_id, event_type, object_id)):
            raise WebhookVerificationError("Webhook event identity is invalid")
        currency = payload.get("currency")
        if currency is not None and currency != "INR":
            raise WebhookVerificationError("Webhook currency is invalid")
        provider_reference = payload.get("provider_reference")
        if provider_reference is not None and (
            not isinstance(provider_reference, str) or not 1 <= len(provider_reference) <= 160
        ):
            raise WebhookVerificationError("Webhook provider reference is invalid")
        occurred_at = payload.get("occurred_at")
        if occurred_at is not None and not isinstance(occurred_at, str):
            raise WebhookVerificationError("Webhook occurred_at is invalid")
        return ProviderEvent(
            event_id=event_id,
            event_type=event_type.strip().lower(),
            object_id=object_id,
            amount_paise=_strict_positive_int(payload.get("amount_paise"), "amount_paise"),
            currency=currency,
            provider_reference=provider_reference,
            occurred_at=occurred_at,
            data={k: v for k, v in payload.items() if k not in {
                "id", "type", "object_id", "amount_paise", "currency",
                "provider_reference", "occurred_at",
            }},
        )


def load_payment_provider(environ: Optional[Mapping[str, str]] = None) -> PaymentProvider:
    env = os.environ if environ is None else environ
    name = str(env.get("PAYMENT_PROVIDER", "mock")).strip().lower()
    app_env = str(env.get("APP_ENV", "development")).strip().lower()
    if name == "mock":
        if app_env == "production":
            raise ProviderConfigurationError("The mock payment provider is forbidden in production")
        try:
            tolerance = int(
                env.get("PAYMENT_WEBHOOK_TOLERANCE_SECONDS", DEFAULT_WEBHOOK_TOLERANCE_SECONDS),
            )
        except (TypeError, ValueError) as exc:
            raise ProviderConfigurationError(
                "PAYMENT_WEBHOOK_TOLERANCE_SECONDS must be an integer",
            ) from exc
        return MockPaymentProvider(
            str(env.get("PAYMENT_WEBHOOK_SECRET", "")),
            tolerance,
        )
    raise ProviderConfigurationError(
        f"Payment provider {name!r} is not installed; add and review its adapter before enabling payments"
    )
