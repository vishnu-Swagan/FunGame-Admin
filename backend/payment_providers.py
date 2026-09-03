"""Provider-neutral deposit and payout adapter contracts.

The runtime ships only a fail-closed, explicitly configured HTTPS bridge.  It
does not contain a mock provider or any provider-specific endpoint guesses.
Deterministic payment fakes belong in tests, never in the application runtime.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import http.client
import ipaddress
import json
import os
import re
import socket
import ssl
import time
import urllib.error
import urllib.parse
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
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


# Naive SgPay timestamps are treated as India Standard Time (no DST).
IST = timezone(timedelta(hours=5, minutes=30))

# Capture-like keys first. created_at is last so checkout-start is never
# preferred over an explicit paid/updated/date field when both exist.
_PROVIDER_OCCURRED_KEYS = (
    "paid_at",
    "captured_at",
    "completed_at",
    "settled_at",
    "txn_date",
    "transaction_date",
    "payment_date",
    "txn_time",
    "date",
    "datetime",
    "timestamp",
    "occurred_at",
    "updated_at",
    "created_at",
)


def parse_provider_datetime(value: Any) -> Optional[datetime]:
    """Parse a provider timestamp and return timezone-aware UTC.

    Timezone-aware values keep their offset. Naive wall-clock values from
    Indian gateways are treated as Asia/Kolkata. Unparseable input is None.
    """
    if value is None or isinstance(value, bool):
        return None
    dt: Optional[datetime] = None
    if isinstance(value, datetime):
        dt = value
    elif isinstance(value, (int, float)):
        stamp = float(value)
        if stamp > 1e12:
            stamp /= 1000.0
        if not 1e9 <= stamp < 1e11:
            return None
        dt = datetime.fromtimestamp(stamp, tz=timezone.utc)
    elif isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        if re.fullmatch(r"\d{10,13}", text):
            return parse_provider_datetime(int(text))
        normalized = text.replace("Z", "+00:00")
        try:
            dt = datetime.fromisoformat(normalized)
        except ValueError:
            dt = None
            for fmt in (
                "%Y-%m-%d %H:%M:%S",
                "%Y-%m-%d %H:%M:%S.%f",
                "%d-%m-%Y %H:%M:%S",
                "%d/%m/%Y %H:%M:%S",
                "%Y/%m/%d %H:%M:%S",
                "%d-%m-%Y %H:%M",
                "%Y-%m-%d",
            ):
                try:
                    dt = datetime.strptime(text, fmt)
                    break
                except ValueError:
                    continue
            if dt is None:
                return None
    else:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=IST)
    return dt.astimezone(timezone.utc)


def datetime_to_iso_utc(value: Any) -> Optional[str]:
    """Serialize a datetime (or parseable string) as ISO-8601 UTC with Z."""
    if value is None:
        return None
    if isinstance(value, datetime):
        dt = value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)
    else:
        dt = parse_provider_datetime(value)
    if dt is None:
        return None
    text = dt.isoformat(timespec="milliseconds")
    if text.endswith("+00:00"):
        text = text[:-6] + "Z"
    return text


def extract_provider_occurred_at(*payloads: Any) -> Optional[datetime]:
    """Return the first parseable capture timestamp from an allowlist of keys."""
    for payload in payloads:
        if not isinstance(payload, Mapping):
            continue
        sources = [payload]
        nested = payload.get("data")
        if isinstance(nested, Mapping):
            sources.append(nested)
        for source in sources:
            for key in _PROVIDER_OCCURRED_KEYS:
                if key not in source:
                    continue
                parsed = parse_provider_datetime(source.get(key))
                if parsed is not None:
                    return parsed
    return None


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
    occurred_at: Optional[datetime] = None


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
    occurred_at: Optional[datetime] = None


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
    checkout_allowed_hosts: tuple[str, ...]

    async def create_deposit_order(
        self, *, deposit_id: str, amount_paise: int, currency: str,
        idempotency_key: str, return_url: str,
        customer: Optional[Mapping[str, Any]] = None,
    ) -> DepositSession: ...

    async def create_checkout_session(
        self, *, provider_order_id: str, return_url: str,
    ) -> DepositSession: ...

    async def get_payment_status(
        self, provider_order_id: str, *, expected_amount_paise: Optional[int] = None,
    ) -> DepositStatus: ...

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


_PROVIDER_NAME_RE = re.compile(r"^[a-z][a-z0-9_-]{1,39}$")
_ENV_NAME_RE = re.compile(r"^PAYMENT_PROVIDER_[A-Z0-9_]{3,80}$")
_HEADER_NAME_RE = re.compile(r"^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$")
_FORBIDDEN_PROVIDER_NAMES = {"mock", "mock_sandbox", "sandbox_mock", "fake", "test"}
_FORBIDDEN_HEADERS = {
    "authorization", "connection", "content-length", "cookie", "host", "proxy-authorization",
    "te", "trailer", "transfer-encoding", "upgrade",
}
_SENSITIVE_CONFIG_KEYS = {
    "api_key", "api_secret", "authorization", "bearer_token", "client_secret",
    "password", "private_key", "secret", "token", "webhook_secret",
}
_DEPOSIT_STATUSES = {
    "CREATED", "PENDING", "PROCESSING", "AUTHORIZED", "PAID", "SUCCESS",
    "SUCCEEDED", "CAPTURED", "CREDITED", "FAILED", "EXPIRED", "REFUNDED",
}
_PAYOUT_STATUSES = {
    "CREATED", "PENDING", "PROCESSING", "SUBMITTED", "QUEUED", "PAID",
    "SUCCESS", "SUCCEEDED", "COMPLETED", "FAILED", "CANCELLED",
}
_WEBHOOK_EVENTS = {
    "deposit.paid", "deposit.failed", "deposit.expired", "deposit.refunded",
    "withdrawal.processing", "withdrawal.paid", "withdrawal.failed",
}


def _json_object(env: Mapping[str, str], name: str) -> dict[str, Any]:
    raw = str(env.get(name, "")).strip()
    if not raw:
        raise ProviderConfigurationError(f"{name} is required")
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ProviderConfigurationError(f"{name} must contain valid JSON") from exc
    if not isinstance(value, dict):
        raise ProviderConfigurationError(f"{name} must contain a JSON object")
    return value


def _reject_embedded_secrets(value: Any, path: str = "config") -> None:
    if not isinstance(value, Mapping):
        if isinstance(value, list):
            for index, item in enumerate(value):
                _reject_embedded_secrets(item, f"{path}[{index}]")
        return
    for key, item in value.items():
        normalized = str(key).strip().lower()
        if normalized in _SENSITIVE_CONFIG_KEYS:
            raise ProviderConfigurationError(
                f"{path}.{key} must reference a secret-manager environment variable, not contain a credential",
            )
        _reject_embedded_secrets(item, f"{path}.{key}")


def _public_ip(address: str) -> bool:
    try:
        ip = ipaddress.ip_address(address)
    except ValueError:
        return False
    return not (
        ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved
        or ip.is_multicast or ip.is_unspecified
    )


def _approved_domain(value: str) -> bool:
    host = str(value).strip().lower().rstrip(".")
    if not host or host == "localhost" or host.endswith(".local") or ".." in host:
        return False
    try:
        ipaddress.ip_address(host)
    except ValueError:
        return "." in host and bool(re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?", host))
    return _public_ip(host)


def _path_get(payload: Mapping[str, Any], path: str, default: Any = None) -> Any:
    current: Any = payload
    for part in str(path).split("."):
        if not part or not isinstance(current, Mapping) or part not in current:
            return default
        current = current[part]
    return current


def _path_set(payload: dict[str, Any], path: str, value: Any) -> None:
    parts = str(path).split(".")
    if any(not part or part in {"__class__", "__dict__", "__proto__"} for part in parts):
        raise ProviderConfigurationError("Provider request mapping contains an invalid target path")
    current = payload
    for part in parts[:-1]:
        child = current.setdefault(part, {})
        if not isinstance(child, dict):
            raise ProviderConfigurationError("Provider request mapping contains conflicting target paths")
        current = child
    current[parts[-1]] = value


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    """Connect to a reviewed public IP while retaining TLS hostname checks."""

    def __init__(self, address: str, hostname: str, port: int, *, timeout: int):
        super().__init__(hostname, port=port, timeout=timeout, context=ssl.create_default_context())
        self._provider_address = address
        self._provider_hostname = hostname

    def connect(self):
        self.sock = socket.create_connection((self._provider_address, self.port), self.timeout)
        self.sock = self._context.wrap_socket(self.sock, server_hostname=self._provider_hostname)


class ConfiguredRestPaymentProvider:
    """Strict provider bridge driven only by an approved merchant contract.

    Endpoint paths, field mappings, status mappings and credential *variable
    names* are configuration.  Credential values remain in the process secret
    store.  The bridge intentionally cannot infer a provider's contract.
    """

    def __init__(self, environ: Mapping[str, str]):
        self._env = dict(environ)
        self.name = str(self._env.get("PAYMENT_PROVIDER", "")).strip().lower()
        if not _PROVIDER_NAME_RE.fullmatch(self.name) or self.name in _FORBIDDEN_PROVIDER_NAMES:
            raise ProviderConfigurationError("PAYMENT_PROVIDER must name an installed, non-mock provider")
        self._config = _json_object(self._env, "PAYMENT_PROVIDER_CONFIG_JSON")
        if str(self._config.get("provider_name", "")).strip().lower() != self.name:
            raise ProviderConfigurationError("PAYMENT_PROVIDER_CONFIG_JSON provider_name must match PAYMENT_PROVIDER")
        _reject_embedded_secrets({
            key: value for key, value in self._config.items()
            if key not in {"auth", "webhook"}
        })
        self._validate_base_url()
        self._validate_capabilities()
        self._validate_contract()

    def _validate_base_url(self) -> None:
        try:
            parsed = urllib.parse.urlsplit(str(self._config.get("base_url", "")))
            port = parsed.port
        except ValueError as exc:
            raise ProviderConfigurationError("Provider base_url is invalid") from exc
        if (
            parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
            or parsed.query or parsed.fragment
        ):
            raise ProviderConfigurationError("Provider base_url must be a credential-free HTTPS URL without query or fragment")
        self._base_url = parsed
        self._port = port or 443
        self._host = parsed.hostname.lower().rstrip(".")
        self._allowed_domains = {
            item.strip().lower().rstrip(".")
            for item in str(self._env.get("PAYMENT_PROVIDER_ALLOWED_DOMAINS", "")).split(",")
            if item.strip()
        }
        if (
            not self._allowed_domains or any(not _approved_domain(item) for item in self._allowed_domains)
            or not any(
                self._host == item or self._host.endswith(f".{item}")
                for item in self._allowed_domains
            )
        ):
            raise ProviderConfigurationError("Provider base_url host is not in PAYMENT_PROVIDER_ALLOWED_DOMAINS")
        self._checkout_allowed_domains = {
            item.strip().lower().rstrip(".")
            for item in str(self._env.get("PAYMENT_PROVIDER_CHECKOUT_ALLOWED_DOMAINS", "")).split(",")
            if item.strip()
        }
        if any(not _approved_domain(item) for item in self._checkout_allowed_domains):
            raise ProviderConfigurationError("PAYMENT_PROVIDER_CHECKOUT_ALLOWED_DOMAINS is invalid")

    def _safe_checkout_url(self, value: Any) -> str:
        text = str(value or "")
        try:
            parsed = urllib.parse.urlsplit(text)
            port = parsed.port
        except ValueError as exc:
            raise ProviderRequestError("Provider checkout URL is unsafe") from exc
        host = (parsed.hostname or "").lower().rstrip(".")
        if (
            parsed.scheme != "https" or not host or parsed.username or parsed.password
            or parsed.fragment or port not in {None, 443}
            or host not in self._checkout_allowed_domains
        ):
            raise ProviderRequestError("Provider checkout URL is unsafe")
        return text

    @property
    def checkout_allowed_hosts(self) -> tuple[str, ...]:
        """Return the exact, non-secret hosts approved for player redirects."""
        return tuple(sorted(self._checkout_allowed_domains))

    def _validate_capabilities(self) -> None:
        values = self._config.get("capabilities")
        fields = tuple(ProviderCapabilities.__dataclass_fields__)
        if not isinstance(values, Mapping) or set(values) != set(fields):
            raise ProviderConfigurationError(f"Provider capabilities must explicitly define: {', '.join(fields)}")
        if any(not isinstance(values[field], bool) for field in fields):
            raise ProviderConfigurationError("Provider capabilities must be booleans")
        self.capabilities = ProviderCapabilities(**{field: values[field] for field in fields})

    def _validate_contract(self) -> None:
        endpoints = self._config.get("endpoints")
        requests = self._config.get("request_mapping")
        responses = self._config.get("response_mapping")
        statuses = self._config.get("status_mapping")
        if not all(isinstance(value, Mapping) for value in (endpoints, requests, responses, statuses)):
            raise ProviderConfigurationError("Provider endpoints and request/response/status mappings must be objects")
        deposit_statuses = statuses.get("deposit")
        payout_statuses = statuses.get("payout")
        deposit_contract_enabled = (
            self.capabilities.deposit_idempotency
            or self.capabilities.payment_status_lookup
            or self.capabilities.refunds
        )
        payout_contract_enabled = (
            self.capabilities.payout_idempotency
            or self.capabilities.payout_status_lookup
            or self.capabilities.payout_cancellation
        )
        if self.capabilities.deposit_idempotency and not self._checkout_allowed_domains:
            raise ProviderConfigurationError(
                "PAYMENT_PROVIDER_CHECKOUT_ALLOWED_DOMAINS is required for deposits",
            )
        if (
            deposit_contract_enabled
            and (
                not isinstance(deposit_statuses, Mapping) or not deposit_statuses
                or any(
                    not isinstance(key, str) or not key.strip() or key != key.upper()
                    or str(value).upper() not in _DEPOSIT_STATUSES
                    for key, value in deposit_statuses.items()
                )
            )
        ):
            raise ProviderConfigurationError("Provider deposit status mapping is invalid")
        if (
            payout_contract_enabled
            and (
                not isinstance(payout_statuses, Mapping) or not payout_statuses
                or any(
                    not isinstance(key, str) or not key.strip() or key != key.upper()
                    or str(value).upper() not in _PAYOUT_STATUSES
                    for key, value in payout_statuses.items()
                )
            )
        ):
            raise ProviderConfigurationError("Provider payout status mapping is invalid")
        required = {"verify_webhook"}
        if self.capabilities.deposit_idempotency:
            required.update({"create_deposit_order", "create_checkout_session"})
        if self.capabilities.payment_status_lookup:
            required.add("get_payment_status")
        if self.capabilities.payout_idempotency:
            required.update({"create_beneficiary", "submit_payout"})
        if self.capabilities.payout_status_lookup:
            required.add("get_payout_status")
        if self.capabilities.payout_cancellation:
            required.add("cancel_payout")
        if self.capabilities.refunds:
            required.add("refund_payment")
        status_lookups = {"get_payment_status", "get_payout_status"}
        for operation in required - {"verify_webhook"}:
            endpoint = endpoints.get(operation)
            if not isinstance(endpoint, Mapping):
                raise ProviderConfigurationError(f"Provider endpoint {operation} is required")
            path = endpoint.get("path")
            method = str(endpoint.get("method", "POST")).upper()
            if (
                not isinstance(path, str) or not path.startswith("/") or "//" in path
                or ".." in path or "?" in path or "#" in path or method not in {"GET", "POST"}
            ):
                raise ProviderConfigurationError(f"Provider endpoint {operation} is invalid")
            if method == "GET" and operation not in status_lookups:
                raise ProviderConfigurationError(
                    f"Provider mutation endpoint {operation} must use POST",
                )
            if not isinstance(requests.get(operation), Mapping) or not isinstance(responses.get(operation), Mapping):
                raise ProviderConfigurationError(f"Provider mappings for {operation} are required")
        required_response_fields = {
            "create_deposit_order": {"provider_order_id", "checkout_url", "status"},
            "create_checkout_session": {"provider_order_id", "checkout_url", "status"},
            "get_payment_status": {"status", "amount_paise", "currency", "provider_reference"},
            "create_beneficiary": {"provider_beneficiary_id", "status"},
            "submit_payout": {"provider_payout_id", "status"},
            "get_payout_status": {
                "status", "amount_paise", "currency", "withdrawal_id", "idempotency_key",
                "provider_beneficiary_id", "provider_reference",
            },
            "cancel_payout": {"status"},
            "refund_payment": {"provider_reference"},
        }
        required_request_fields = {
            "create_deposit_order": {"deposit_id", "amount_paise", "currency"},
            "create_checkout_session": {"provider_order_id"},
            "get_payment_status": {"provider_order_id"},
            "create_beneficiary": {"bank_details"},
            "submit_payout": {"withdrawal_id", "provider_beneficiary_id", "amount_paise", "currency"},
            "get_payout_status": {"provider_payout_id"},
            "cancel_payout": {"provider_payout_id"},
            "refund_payment": {"provider_order_id", "amount_paise"},
        }
        for operation in required - {"verify_webhook"}:
            missing_request = required_request_fields.get(operation, set()) - set(requests[operation])
            if missing_request:
                raise ProviderConfigurationError(f"Provider request mapping for {operation} is missing: {', '.join(sorted(missing_request))}")
            missing = required_response_fields.get(operation, set()) - set(responses[operation])
            if missing:
                raise ProviderConfigurationError(f"Provider response mapping for {operation} is missing: {', '.join(sorted(missing))}")
            if any(not isinstance(key, str) or not isinstance(value, str) or not value for key, value in requests[operation].items()):
                raise ProviderConfigurationError(f"Provider request mapping for {operation} is invalid")
            if any(not isinstance(key, str) or not isinstance(value, str) or not value for key, value in responses[operation].items()):
                raise ProviderConfigurationError(f"Provider response mapping for {operation} is invalid")
        self._validate_auth()
        self._validate_webhook()
        idempotency_header = str(self._config.get("idempotency_header", ""))
        if not _HEADER_NAME_RE.fullmatch(idempotency_header) or idempotency_header.lower() in _FORBIDDEN_HEADERS:
            raise ProviderConfigurationError("Provider idempotency_header is invalid")
        headers = self._config.get("headers", {}) or {}
        if not isinstance(headers, Mapping):
            raise ProviderConfigurationError("Provider headers must be an object")
        if headers:
            raise ProviderConfigurationError(
                "Static provider headers are not supported; use configured secret authentication",
            )
        auth_config = self._config.get("auth", {}) or {}
        if isinstance(auth_config, Mapping):
            for field in ("header_name", "timestamp_header", "signature_header"):
                if (
                    auth_config.get(field)
                    and str(auth_config[field]).lower() == idempotency_header.lower()
                ):
                    raise ProviderConfigurationError(
                        "Provider idempotency and authentication headers must be distinct",
                    )
        for name, default, minimum, maximum in (
            ("timeout_seconds", 15, 1, 30),
            ("max_response_bytes", 1024 * 1024, 1024, 4 * 1024 * 1024),
        ):
            try:
                configured = int(self._config.get(name, default))
            except (TypeError, ValueError) as exc:
                raise ProviderConfigurationError(f"Provider {name} must be an integer") from exc
            if not minimum <= configured <= maximum:
                raise ProviderConfigurationError(f"Provider {name} is outside the allowed range")

    def _credential(self, env_name: Any, purpose: str, *, minimum: int = 1) -> str:
        name = str(env_name or "").strip()
        if not _ENV_NAME_RE.fullmatch(name):
            raise ProviderConfigurationError(f"Provider {purpose} credential environment name is invalid")
        value = str(self._env.get(name, ""))
        if len(value) < minimum:
            raise ProviderConfigurationError(f"Provider {purpose} credential is unavailable")
        return value

    def _validate_auth(self) -> None:
        auth = self._config.get("auth")
        if not isinstance(auth, Mapping):
            raise ProviderConfigurationError("Provider auth configuration is required")
        strategy = str(auth.get("strategy", "")).lower()
        allowed_fields = {
            "bearer": {"strategy", "credential_env"},
            "api_key_header": {"strategy", "header_name", "credential_env"},
            "basic": {"strategy", "username_env", "password_env"},
            "hmac-sha256": {"strategy", "secret_env", "timestamp_header", "signature_header", "signature_prefix"},
            "hmac-sha512": {"strategy", "secret_env", "timestamp_header", "signature_header", "signature_prefix"},
        }
        if strategy not in allowed_fields or set(auth) - allowed_fields[strategy]:
            raise ProviderConfigurationError("Provider auth configuration contains unsupported fields")
        prefix = auth.get("signature_prefix", "")
        if not isinstance(prefix, str) or "\r" in prefix or "\n" in prefix or len(prefix) > 32:
            raise ProviderConfigurationError("Provider auth signature_prefix is invalid")
        if strategy == "bearer":
            self._credential(auth.get("credential_env"), "bearer")
        elif strategy == "api_key_header":
            name = str(auth.get("header_name", ""))
            if not _HEADER_NAME_RE.fullmatch(name) or name.lower() in _FORBIDDEN_HEADERS | {"host"}:
                raise ProviderConfigurationError("Provider API-key header name is invalid")
            self._credential(auth.get("credential_env"), "API key")
        elif strategy == "basic":
            self._credential(auth.get("username_env"), "username")
            self._credential(auth.get("password_env"), "password")
        elif strategy in {"hmac-sha256", "hmac-sha512"}:
            self._credential(auth.get("secret_env"), "HMAC secret", minimum=16)
            for field in ("timestamp_header", "signature_header"):
                header = str(auth.get(field, ""))
                if not _HEADER_NAME_RE.fullmatch(header) or header.lower() in _FORBIDDEN_HEADERS:
                    raise ProviderConfigurationError(f"Provider auth {field} is invalid")
            if str(auth.get("timestamp_header")).lower() == str(auth.get("signature_header")).lower():
                raise ProviderConfigurationError("Provider auth signature headers must be distinct")
        else:
            raise ProviderConfigurationError("Provider auth strategy is not supported")

    def _validate_webhook(self) -> None:
        config = self._config.get("webhook")
        if not isinstance(config, Mapping):
            raise ProviderConfigurationError("Provider webhook contract is required")
        if str(config.get("algorithm", "")).lower() not in {"hmac-sha256", "hmac-sha512"}:
            raise ProviderConfigurationError("Provider webhook algorithm is not supported")
        allowed = {
            "algorithm", "timestamp_header", "signature_header", "signature_prefix",
            "secret_env", "replay_window_seconds", "mapping", "event_type_mapping",
        }
        if set(config) - allowed:
            raise ProviderConfigurationError("Provider webhook configuration contains unsupported fields")
        prefix = config.get("signature_prefix", "")
        if not isinstance(prefix, str) or "\r" in prefix or "\n" in prefix or len(prefix) > 32:
            raise ProviderConfigurationError("Provider webhook signature_prefix is invalid")
        for field in ("timestamp_header", "signature_header"):
            if not _HEADER_NAME_RE.fullmatch(str(config.get(field, ""))):
                raise ProviderConfigurationError(f"Provider webhook {field} is invalid")
        if str(config.get("timestamp_header")).lower() == str(config.get("signature_header")).lower():
            raise ProviderConfigurationError("Provider webhook signature headers must be distinct")
        self._credential(config.get("secret_env"), "webhook secret", minimum=32)
        try:
            tolerance = int(config.get("replay_window_seconds", DEFAULT_WEBHOOK_TOLERANCE_SECONDS))
        except (TypeError, ValueError) as exc:
            raise ProviderConfigurationError("Provider webhook replay_window_seconds must be an integer") from exc
        if not 30 <= tolerance <= 900:
            raise ProviderConfigurationError("Provider webhook replay_window_seconds must be between 30 and 900")
        mapping = config.get("mapping")
        required = {"event_id", "event_type", "object_id", "amount_paise", "currency", "provider_reference", "occurred_at"}
        if not isinstance(mapping, Mapping) or not required.issubset(mapping):
            raise ProviderConfigurationError("Provider webhook field mapping is incomplete")
        event_mapping = config.get("event_type_mapping")
        if not isinstance(event_mapping, Mapping) or not event_mapping:
            raise ProviderConfigurationError("Provider webhook event_type_mapping is required")
        if any(str(value).lower() not in _WEBHOOK_EVENTS for value in event_mapping.values()):
            raise ProviderConfigurationError("Provider webhook event_type_mapping contains an unsupported event")

    def _resolve_public_addresses(self) -> list[str]:
        try:
            rows = socket.getaddrinfo(self._host, self._port, type=socket.SOCK_STREAM)
        except socket.gaierror as exc:
            raise ProviderRequestError("Provider host could not be resolved") from exc
        addresses = [str(row[4][0]) for row in rows]
        if not addresses or any(not _public_ip(address) for address in addresses):
            raise ProviderConfigurationError("Provider host resolved to a non-public address")
        return list(dict.fromkeys(addresses))

    def _auth_headers(self, body: bytes) -> dict[str, str]:
        auth = self._config["auth"]
        strategy = str(auth["strategy"]).lower()
        if strategy == "bearer":
            return {"Authorization": f"Bearer {self._credential(auth['credential_env'], 'bearer')}"}
        if strategy == "api_key_header":
            return {str(auth["header_name"]): self._credential(auth["credential_env"], "API key")}
        if strategy == "basic":
            raw = f"{self._credential(auth['username_env'], 'username')}:{self._credential(auth['password_env'], 'password')}"
            return {"Authorization": f"Basic {base64.b64encode(raw.encode()).decode()}"}
        algorithm = hashlib.sha256 if strategy == "hmac-sha256" else hashlib.sha512
        stamp = str(int(time.time()))
        signed = stamp.encode() + b"." + body
        signature = hmac.new(self._credential(auth["secret_env"], "HMAC secret").encode(), signed, algorithm).hexdigest()
        prefix = str(auth.get("signature_prefix", ""))
        return {str(auth["timestamp_header"]): stamp, str(auth["signature_header"]): f"{prefix}{signature}"}

    def _mapped_request(self, operation: str, values: Mapping[str, Any]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for source, target in self._config["request_mapping"][operation].items():
            value = _path_get(values, str(source), None)
            if value is not None:
                _path_set(result, str(target), value)
        return result

    async def _request(
        self, operation: str, values: Mapping[str, Any], *, idempotency_key: Optional[str] = None,
    ) -> Mapping[str, Any]:
        endpoint = self._config["endpoints"].get(operation)
        if not isinstance(endpoint, Mapping):
            raise ProviderRequestError(f"Provider operation {operation} is not configured")
        payload = self._mapped_request(operation, values)
        method = str(endpoint.get("method", "POST")).upper()
        body = b"" if method == "GET" else json.dumps(payload, separators=(",", ":"), ensure_ascii=True).encode()
        headers = {"Accept": "application/json", **self._auth_headers(body)}
        if method == "POST":
            headers["Content-Type"] = "application/json"
        headers.update({str(key): str(value) for key, value in (self._config.get("headers", {}) or {}).items()})
        if idempotency_key:
            headers[str(self._config["idempotency_header"])] = str(idempotency_key)
        path = (self._base_url.path.rstrip("/") + str(endpoint["path"])) or "/"
        if method == "GET" and payload:
            path = f"{path}?{urllib.parse.urlencode(payload)}"
        timeout = min(30, max(1, int(self._config.get("timeout_seconds", 15))))
        maximum = min(4 * 1024 * 1024, max(1024, int(self._config.get("max_response_bytes", 1024 * 1024))))

        def send() -> Mapping[str, Any]:
            address = self._resolve_public_addresses()[0]
            connection = _PinnedHTTPSConnection(address, self._host, self._port, timeout=timeout)
            try:
                # The connection retains the logical provider host/port while
                # connect() pins the reviewed IP.  Let http.client build Host
                # from that logical authority so non-default ports and IPv6
                # bracket notation are preserved correctly.
                connection.request(method, path, body=body or None, headers=headers)
                response = connection.getresponse()
                if 300 <= response.status < 400:
                    raise ProviderRequestError("Provider redirect was rejected")
                if response.status >= 400:
                    raise ProviderRequestError("Provider returned an unsuccessful response")
                raw = response.read(maximum + 1)
                if len(raw) > maximum:
                    raise ProviderRequestError("Provider response exceeded the configured limit")
                parsed = json.loads(raw or b"{}")
                if not isinstance(parsed, Mapping):
                    raise ProviderRequestError("Provider response must be an object")
                return parsed
            finally:
                connection.close()

        try:
            return await asyncio.wait_for(asyncio.to_thread(send), timeout=timeout + 1)
        except ProviderRequestError:
            raise
        except (OSError, ssl.SSLError, http.client.HTTPException, urllib.error.URLError, asyncio.TimeoutError, json.JSONDecodeError) as exc:
            raise ProviderRequestError("Provider request failed") from exc

    def _field(self, operation: str, payload: Mapping[str, Any], field: str) -> Any:
        path = self._config["response_mapping"][operation].get(field)
        value = _path_get(payload, str(path), None)
        if value is None or value == "":
            raise ProviderRequestError(f"Provider response omitted authoritative {field}")
        return value

    def _status(self, category: str, raw: Any) -> str:
        mapping = self._config["status_mapping"].get(category)
        if not isinstance(mapping, Mapping):
            raise ProviderConfigurationError(f"Provider {category} status mapping is required")
        normalized = mapping.get(str(raw).strip().upper())
        allowed = _DEPOSIT_STATUSES if category == "deposit" else _PAYOUT_STATUSES
        if not isinstance(normalized, str) or normalized.upper() not in allowed:
            raise ProviderRequestError("Provider returned an unmapped status")
        return normalized.upper()

    @staticmethod
    def _authoritative_amount(value: Any) -> int:
        if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
            raise ProviderRequestError("Provider amount must be a positive integer in minor units")
        return value

    @staticmethod
    def _authoritative_currency(value: Any) -> str:
        currency = str(value).upper()
        if currency != "INR":
            raise ProviderRequestError("Provider currency does not match the configured INR wallet")
        return currency

    async def create_deposit_order(
        self, *, deposit_id: str, amount_paise: int, currency: str,
        idempotency_key: str, return_url: str,
        customer: Optional[Mapping[str, Any]] = None,
    ) -> DepositSession:
        if not self.capabilities.deposit_idempotency:
            raise ProviderRequestError("Provider does not certify deposit idempotency")
        response = await self._request("create_deposit_order", locals(), idempotency_key=idempotency_key)
        return DepositSession(
            str(self._field("create_deposit_order", response, "provider_order_id")),
            self._safe_checkout_url(self._field("create_deposit_order", response, "checkout_url")),
            self._status("deposit", self._field("create_deposit_order", response, "status")),
        )

    async def create_checkout_session(self, *, provider_order_id: str, return_url: str) -> DepositSession:
        if not self.capabilities.deposit_idempotency:
            raise ProviderRequestError("Provider does not certify deposit idempotency")
        idempotency_key = f"checkout:{provider_order_id}"
        response = await self._request("create_checkout_session", locals(), idempotency_key=idempotency_key)
        return DepositSession(
            str(self._field("create_checkout_session", response, "provider_order_id")),
            self._safe_checkout_url(self._field("create_checkout_session", response, "checkout_url")),
            self._status("deposit", self._field("create_checkout_session", response, "status")),
        )

    async def get_payment_status(
        self, provider_order_id: str, *, expected_amount_paise: Optional[int] = None,
    ) -> DepositStatus:
        if not self.capabilities.payment_status_lookup:
            raise ProviderRequestError("Provider does not certify authoritative payment status lookup")
        response = await self._request("get_payment_status", locals())
        return DepositStatus(
            self._status("deposit", self._field("get_payment_status", response, "status")),
            self._authoritative_amount(self._field("get_payment_status", response, "amount_paise")),
            self._authoritative_currency(self._field("get_payment_status", response, "currency")),
            str(self._field("get_payment_status", response, "provider_reference")),
            extract_provider_occurred_at(response),
        )

    async def create_beneficiary(self, *, bank_details: Mapping[str, str], idempotency_key: str) -> Beneficiary:
        if not self.capabilities.payout_idempotency:
            raise ProviderRequestError("Provider does not certify payout idempotency")
        response = await self._request("create_beneficiary", locals(), idempotency_key=idempotency_key)
        return Beneficiary(
            str(self._field("create_beneficiary", response, "provider_beneficiary_id")),
            self._status("payout", self._field("create_beneficiary", response, "status")),
        )

    async def submit_payout(self, *, withdrawal_id: str, provider_beneficiary_id: str, amount_paise: int, currency: str, idempotency_key: str) -> PayoutSubmission:
        if not self.capabilities.payout_idempotency:
            raise ProviderRequestError("Provider does not certify payout idempotency")
        response = await self._request("submit_payout", locals(), idempotency_key=idempotency_key)
        return PayoutSubmission(
            str(self._field("submit_payout", response, "provider_payout_id")),
            self._status("payout", self._field("submit_payout", response, "status")),
        )

    async def get_payout_status(self, provider_payout_id: str) -> PayoutStatus:
        if not self.capabilities.payout_status_lookup:
            raise ProviderRequestError("Provider does not certify authoritative payout status lookup")
        response = await self._request("get_payout_status", locals())
        operation = "get_payout_status"
        return PayoutStatus(
            self._status("payout", self._field(operation, response, "status")),
            self._authoritative_amount(self._field(operation, response, "amount_paise")),
            self._authoritative_currency(self._field(operation, response, "currency")),
            str(self._field(operation, response, "withdrawal_id")),
            str(self._field(operation, response, "idempotency_key")),
            str(self._field(operation, response, "provider_beneficiary_id")),
            str(self._field(operation, response, "provider_reference")),
            extract_provider_occurred_at(response),
        )

    async def cancel_payout(self, provider_payout_id: str) -> str:
        if not self.capabilities.payout_cancellation:
            raise ProviderRequestError("Provider payout cancellation is not supported")
        response = await self._request("cancel_payout", locals(), idempotency_key=f"cancel:{provider_payout_id}")
        return self._status("payout", self._field("cancel_payout", response, "status"))

    async def refund_payment(self, provider_order_id: str, amount_paise: int) -> str:
        if not self.capabilities.refunds:
            raise ProviderRequestError("Provider refunds are not supported")
        idempotency_key = f"refund:{provider_order_id}:{amount_paise}"
        response = await self._request("refund_payment", locals(), idempotency_key=idempotency_key)
        return str(self._field("refund_payment", response, "provider_reference"))

    def verify_webhook(self, raw_body: bytes, headers: Mapping[str, str]) -> ProviderEvent:
        if not raw_body or len(raw_body) > MAX_WEBHOOK_BODY_BYTES:
            raise WebhookVerificationError("Webhook body is empty or too large")
        config = self._config["webhook"]
        timestamp = _header(headers, str(config["timestamp_header"]))
        supplied = _header(headers, str(config["signature_header"]))
        prefix = str(config.get("signature_prefix", ""))
        if prefix:
            if not supplied.startswith(prefix):
                raise WebhookVerificationError("Webhook signature is invalid")
            supplied = supplied[len(prefix):]
        try:
            stamp = int(timestamp)
            tolerance = int(config.get("replay_window_seconds", DEFAULT_WEBHOOK_TOLERANCE_SECONDS))
        except (TypeError, ValueError) as exc:
            raise WebhookVerificationError("Webhook timestamp is invalid") from exc
        if abs(int(time.time()) - stamp) > tolerance:
            raise WebhookVerificationError("Webhook timestamp is outside the replay window")
        algorithm = hashlib.sha256 if str(config["algorithm"]).lower() == "hmac-sha256" else hashlib.sha512
        signed = timestamp.encode() + b"." + raw_body
        expected = hmac.new(self._credential(config["secret_env"], "webhook secret").encode(), signed, algorithm).hexdigest()
        if not hmac.compare_digest(expected, supplied.lower()):
            raise WebhookVerificationError("Webhook signature is invalid")
        try:
            payload = json.loads(raw_body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise WebhookVerificationError("Webhook body is not valid JSON") from exc
        if not isinstance(payload, Mapping):
            raise WebhookVerificationError("Webhook body must be an object")
        mapping = config["mapping"]
        event_id = _path_get(payload, mapping["event_id"])
        raw_event_type = _path_get(payload, mapping["event_type"])
        object_id = _path_get(payload, mapping["object_id"])
        if not all(isinstance(value, str) and 1 <= len(value) <= 160 for value in (event_id, raw_event_type, object_id)):
            raise WebhookVerificationError("Webhook event identity is invalid")
        event_type = config["event_type_mapping"].get(raw_event_type)
        if not isinstance(event_type, str) or event_type.lower() not in _WEBHOOK_EVENTS:
            raise WebhookVerificationError("Webhook event type is not mapped")
        currency_value = _path_get(payload, mapping["currency"])
        try:
            currency = self._authoritative_currency(currency_value)
        except ProviderRequestError as exc:
            raise WebhookVerificationError("Webhook currency is invalid") from exc
        reference_value = _path_get(payload, mapping["provider_reference"])
        occurred_value = _path_get(payload, mapping["occurred_at"])
        if not isinstance(reference_value, str) or not 1 <= len(reference_value) <= 160:
            raise WebhookVerificationError("Webhook provider reference is invalid")
        if occurred_value is not None and not isinstance(occurred_value, str):
            raise WebhookVerificationError("Webhook occurred_at is invalid")
        amount = _strict_positive_int(_path_get(payload, mapping["amount_paise"]), "amount_paise")
        if amount is None:
            raise WebhookVerificationError("Webhook amount_paise is required")
        return ProviderEvent(
            event_id=event_id, event_type=event_type.lower(), object_id=object_id,
            amount_paise=amount, currency=currency, provider_reference=reference_value,
            occurred_at=occurred_value, data={"provider_payload_hash": hashlib.sha256(raw_body).hexdigest()},
        )


class SgPay24PaymentProvider:
    """SgPay24 hosted UPI deposits plus Admin-approved player payouts.

    SgPay24 does not document a webhook signature.  ``verify_webhook`` therefore
    validates only the notification shape and marks it as untrusted.  Callers
    must perform ``get_payment_status`` with the server-held API token before a
    notification can change an order or credit chips. Player cash-out is
    Admin-approved then submitted through ``submit_payout``.
    """

    name = "sgpay24"
    capabilities = ProviderCapabilities(
        deposit_idempotency=True,
        payment_status_lookup=True,
        payout_idempotency=True,
        payout_status_lookup=True,
        payout_cancellation=False,
        refunds=False,
    )
    checkout_allowed_hosts = ("root.sgpay24.com",)
    status_lookup_uses_order_amount = True
    webhook_requires_status_lookup = True
    _host = "root.sgpay24.com"
    _port = 443
    _create_path = "/api/createPayingRequest"
    _status_path = "/api/check-status"
    _payout_path = "/api/createPayoutRequest"
    _payout_status_path = "/api/check-payout-status"
    _v1_payout_host = "api.sgpay24.in"
    _v1_payout_path = "/v1/payout"
    _PAID_STATUS_NAMES = frozenset({
        "complete", "completed", "success", "succeeded", "paid", "credited",
    })
    _DEFAULT_NOTIFY_URL = "https://api.chakri.casino/api/payments/webhooks/sgpay24"
    _FAILED_STATUS_NAMES = frozenset({"failed", "cancelled", "canceled", "expired", "rejected"})
    _PENDING_STATUS_NAMES = frozenset({"pending", "processing"})

    def __init__(self, environ: Mapping[str, str]):
        self._env = dict(environ)
        self._merchant_id = str(self._env.get("SGPAY24_MERCHANT_ID", "")).strip()
        self._api_token = str(self._env.get("SGPAY24_API_TOKEN", "")).strip()
        self._fallback_email = str(
            self._env.get("SGPAY24_CUSTOMER_EMAIL_FALLBACK", "payments@chakri.casino"),
        ).strip().lower()
        if not re.fullmatch(r"MER[A-Za-z0-9_-]{2,37}", self._merchant_id):
            raise ProviderConfigurationError("SGPAY24_MERCHANT_ID is invalid")
        if not 16 <= len(self._api_token) <= 256 or any(char.isspace() for char in self._api_token):
            raise ProviderConfigurationError("SGPAY24_API_TOKEN is unavailable or invalid")
        if not self._valid_email(self._fallback_email):
            raise ProviderConfigurationError("SGPAY24_CUSTOMER_EMAIL_FALLBACK is invalid")
        try:
            self._timeout = int(self._env.get("SGPAY24_TIMEOUT_SECONDS", "15"))
        except (TypeError, ValueError) as exc:
            raise ProviderConfigurationError("SGPAY24_TIMEOUT_SECONDS must be an integer") from exc
        if not 3 <= self._timeout <= 30:
            raise ProviderConfigurationError("SGPAY24_TIMEOUT_SECONDS must be between 3 and 30")
        configured_return = str(self._env.get("PAYMENT_RETURN_URL", "")).strip()
        self._return_contract = self._validated_return_url(configured_return)
        self._payout_redirect = str(self._env.get("SGPAY24_PAYOUT_REDIRECT_URL") or "").strip()
        if self._payout_redirect:
            try:
                self._validated_return_url(self._payout_redirect)
            except ProviderConfigurationError as exc:
                raise ProviderConfigurationError(
                    "SGPAY24_PAYOUT_REDIRECT_URL must be a public HTTPS URL",
                ) from exc

    @staticmethod
    def _valid_email(value: str) -> bool:
        if len(value) > 254 or value.endswith(".invalid"):
            return False
        return bool(re.fullmatch(r"[^\s@]+@[^\s@]+\.[A-Za-z]{2,63}", value))

    @staticmethod
    def _amount_to_paise(value: Any) -> int:
        if isinstance(value, bool):
            raise ProviderRequestError("Provider amount is invalid")
        try:
            paise = Decimal(str(value)) * 100
        except (InvalidOperation, ValueError) as exc:
            raise ProviderRequestError("Provider amount is invalid") from exc
        if paise <= 0 or paise != paise.to_integral_value():
            raise ProviderRequestError("Provider amount is invalid")
        return int(paise)

    @staticmethod
    def _amount_in_rupees(amount_paise: int) -> int | float:
        if isinstance(amount_paise, bool) or not isinstance(amount_paise, int) or amount_paise <= 0:
            raise ProviderRequestError("Payment amount is invalid")
        whole, fraction = divmod(amount_paise, 100)
        return whole if fraction == 0 else float(f"{whole}.{fraction:02d}")

    @classmethod
    def _status_code(cls, raw_status: Any) -> int:
        if isinstance(raw_status, bool):
            raise ProviderRequestError("Provider returned an invalid payment status")
        if isinstance(raw_status, int):
            if raw_status in {0, 1, 2}:
                return raw_status
            raise ProviderRequestError("Provider returned an unsupported payment status")
        if isinstance(raw_status, str):
            token = raw_status.strip()
            if token in {"0", "1", "2"}:
                return int(token)
            key = token.lower()
            if key in cls._PAID_STATUS_NAMES:
                return 1
            if key in cls._FAILED_STATUS_NAMES:
                return 2
            if key in cls._PENDING_STATUS_NAMES:
                return 0
        raise ProviderRequestError("Provider omitted the numeric payment status")

    @classmethod
    def _status(cls, payload: Mapping[str, Any]) -> str:
        raw_type = str(payload.get("type", "")).strip().lower()
        if raw_type == "unauthorized":
            raise ProviderRequestError("Provider authentication was rejected")
        status_code = cls._status_code(payload.get("status"))
        if status_code == 1:
            return "PAID"
        if status_code == 2:
            return "FAILED"
        return "PENDING"

    @staticmethod
    def _order_id(value: Any) -> str:
        order_id = str(value or "").strip()
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{7,159}", order_id):
            raise ProviderRequestError("Provider order reference is invalid")
        return order_id

    def _validated_return_url(self, value: str) -> tuple[str, str, str]:
        try:
            parsed = urllib.parse.urlsplit(value)
            port = parsed.port
        except ValueError as exc:
            raise ProviderConfigurationError("PAYMENT_RETURN_URL is invalid") from exc
        if (
            parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
            or parsed.fragment or port not in {None, 443}
        ):
            raise ProviderConfigurationError("PAYMENT_RETURN_URL must be a public HTTPS URL")
        return parsed.scheme, parsed.hostname.lower().rstrip("."), parsed.path.rstrip("/") or "/"

    def _safe_return_url(self, value: str) -> str:
        try:
            parsed = urllib.parse.urlsplit(str(value or ""))
            port = parsed.port
        except ValueError as exc:
            raise ProviderRequestError("Payment return URL is invalid") from exc
        contract = (parsed.scheme, (parsed.hostname or "").lower().rstrip("."), parsed.path.rstrip("/") or "/")
        if (
            contract != self._return_contract or parsed.username or parsed.password
            or parsed.fragment or port not in {None, 443}
        ):
            raise ProviderRequestError("Payment return URL is outside the approved return path")
        return urllib.parse.urlunsplit(parsed)

    def _approved_return_url(self) -> str:
        scheme, host, path = self._return_contract
        return urllib.parse.urlunsplit((scheme, host, path, "", ""))

    def _payout_redirect_url(self, requested: str = "") -> str:
        """Return a docs-required redirect_url that cannot open-redirect.

        Caller-supplied URLs must match PAYMENT_RETURN_URL. A dedicated
        SGPAY24_PAYOUT_REDIRECT_URL is operator-configured and validated at
        init as a public HTTPS URL. Otherwise use the approved return URL.
        https://chakri.casino/chips/withdraw is only used when that URL is
        already the configured return contract.
        """
        requested = str(requested or "").strip()
        if requested:
            return self._safe_return_url(requested)
        if self._payout_redirect:
            return self._payout_redirect
        return self._approved_return_url()

    @classmethod
    def _map_payout_status(cls, raw_status: Any) -> str:
        try:
            code = cls._status_code(raw_status)
            return {1: "PAID", 2: "FAILED", 0: "PROCESSING"}[code]
        except ProviderRequestError:
            status_raw = str(raw_status or "").upper()
            if status_raw in {"PAID", "SUCCESS", "SUCCEEDED", "COMPLETED", "COMPLETE"}:
                return "PAID"
            if status_raw in {"FAILED", "REJECTED", "CANCELLED", "CANCELED", "EXPIRED"}:
                return "FAILED"
            return "PROCESSING"

    @staticmethod
    def _safe_checkout_url(value: Any) -> str:
        text = str(value or "").strip()
        try:
            parsed = urllib.parse.urlsplit(text)
            port = parsed.port
        except ValueError as exc:
            raise ProviderRequestError("Provider checkout URL is unsafe") from exc
        if (
            parsed.scheme != "https" or (parsed.hostname or "").lower().rstrip(".") != "root.sgpay24.com"
            or parsed.username or parsed.password or parsed.fragment or port not in {None, 443}
            or not parsed.path.startswith("/api/pay/")
        ):
            raise ProviderRequestError("Provider checkout URL is unsafe")
        return text

    def _notify_callback_url(self) -> str:
        return (
            str(self._env.get("SGPAY24_NOTIFY_URL") or "").strip()
            or str(self._env.get("SGPAY24_CALLBACK_URL") or "").strip()
            or self._DEFAULT_NOTIFY_URL
        )

    def _customer(self, customer: Optional[Mapping[str, Any]]) -> tuple[str, str, str]:
        source = customer or {}
        name = str(source.get("full_name") or source.get("display_name") or "Chakri Player").strip()
        if not 2 <= len(name) <= 100:
            raise ProviderRequestError("Customer name is invalid")
        digits = re.sub(r"\D", "", str(source.get("phone") or source.get("phone_normalized") or ""))
        if len(digits) == 12 and digits.startswith("91"):
            digits = digits[2:]
        if len(digits) != 10 or digits[0] not in "6789":
            raise ProviderRequestError("A valid Indian mobile number is required for UPI checkout")
        email = str(source.get("email") or "").strip().lower()
        if not source.get("email_verified") or not self._valid_email(email):
            email = self._fallback_email
        return name, email, digits

    def _resolve_public_addresses(self) -> list[str]:
        try:
            rows = socket.getaddrinfo(self._host, self._port, type=socket.SOCK_STREAM)
        except socket.gaierror as exc:
            raise ProviderRequestError("Provider host could not be resolved") from exc
        addresses = [str(row[4][0]) for row in rows]
        if not addresses or any(not _public_ip(address) for address in addresses):
            raise ProviderConfigurationError("Provider host resolved to a non-public address")
        return list(dict.fromkeys(addresses))

    @staticmethod
    def _provider_error_message(status: int, raw: bytes) -> str:
        text = ""
        try:
            parsed = json.loads(raw or b"{}")
            if isinstance(parsed, Mapping):
                text = str(parsed.get("msg") or parsed.get("message") or parsed.get("error") or "").strip()
        except Exception:
            text = ""
        if text:
            return f"SgPay payout failed ({status}): {text}"[:300]
        return f"SgPay payout failed ({status}): Provider rejected withdrawal request."

    async def _request_json(
        self, path: str, payload: Mapping[str, Any], *, as_query: bool = False,
    ) -> Mapping[str, Any]:
        allowed = {self._create_path, self._status_path, self._payout_path, self._payout_status_path}
        extra = str(self._env.get("SGPAY24_PAYOUT_PATH") or "").strip()
        if extra.startswith("/api/") and len(extra) < 80 and ".." not in extra:
            allowed.add(extra)
        if path not in allowed:
            raise ProviderConfigurationError("SgPay24 endpoint is not approved")
        cleaned = {
            str(key): value for key, value in dict(payload).items()
            if value not in {None, ""}
        }
        timeout = self._timeout
        if as_query:
            query = urllib.parse.urlencode(
                {key: str(value) for key, value in cleaned.items()},
                doseq=False,
            )
            request_path = f"{path}?{query}"
            body = None
            headers = {"Accept": "application/json"}
        else:
            request_path = path
            body = json.dumps(cleaned, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
            headers = {"Accept": "application/json", "Content-Type": "application/json"}

        def send() -> Mapping[str, Any]:
            connection = _PinnedHTTPSConnection(
                self._resolve_public_addresses()[0], self._host, self._port, timeout=timeout,
            )
            try:
                connection.request("POST", request_path, body=body, headers=headers)
                response = connection.getresponse()
                raw = response.read(1024 * 1024 + 1)
                if 300 <= response.status < 400:
                    raise ProviderRequestError("Provider redirect was rejected")
                if response.status >= 400:
                    raise ProviderRequestError(self._provider_error_message(response.status, raw))
                if len(raw) > 1024 * 1024:
                    raise ProviderRequestError("Provider response exceeded the configured limit")
                parsed = json.loads(raw or b"{}")
                if not isinstance(parsed, Mapping):
                    raise ProviderRequestError("Provider response must be an object")
                return parsed
            finally:
                connection.close()

        try:
            return await asyncio.wait_for(asyncio.to_thread(send), timeout=timeout + 1)
        except ProviderRequestError:
            raise
        except (
            OSError, ssl.SSLError, http.client.HTTPException, urllib.error.URLError,
            asyncio.TimeoutError, json.JSONDecodeError,
        ) as exc:
            raise ProviderRequestError("Provider request failed") from exc

    async def create_deposit_order(
        self, *, deposit_id: str, amount_paise: int, currency: str,
        idempotency_key: str, return_url: str,
        customer: Optional[Mapping[str, Any]] = None,
    ) -> DepositSession:
        del idempotency_key  # SgPay24 binds the request to the unique order_id.
        if str(currency).upper() != "INR":
            raise ProviderRequestError("SgPay24 supports INR deposits only")
        order_id = self._order_id(deposit_id)
        name, email, phone = self._customer(customer)
        expected_paise = int(amount_paise)
        notify_url = self._notify_callback_url()
        response = await self._request_json(self._create_path, {
            "merchant_id": self._merchant_id,
            "order_id": order_id,
            "amount": self._amount_in_rupees(expected_paise),
            "name": name,
            "email": email,
            "phone": phone,
            "redirect_url": self._safe_return_url(return_url),
            "callback_url": notify_url,
            "notify_url": notify_url,
            "api_token": self._api_token,
            "remark": f"Chakri chips {order_id[:24]}",
        })
        data = response.get("data")
        if not isinstance(data, Mapping):
            raise ProviderRequestError("Provider response omitted payment data")
        returned_order = self._order_id(data.get("order_id"))
        if returned_order != order_id or self._amount_to_paise(data.get("amount")) != expected_paise:
            raise ProviderRequestError("Provider checkout did not match the requested order")
        transaction_id = data.get("transaction_id")
        if isinstance(transaction_id, bool) or not isinstance(transaction_id, int) or transaction_id <= 0:
            raise ProviderRequestError("Provider response omitted the transaction reference")
        return DepositSession(
            provider_order_id=returned_order,
            checkout_url=self._safe_checkout_url(data.get("checkout_url")),
            status=self._status(data),
        )

    async def create_checkout_session(
        self, *, provider_order_id: str, return_url: str,
    ) -> DepositSession:
        del provider_order_id, return_url
        raise ProviderRequestError("SgPay24 checkout sessions cannot be recreated without a new order")

    async def get_payment_status(
        self, provider_order_id: str, *, expected_amount_paise: Optional[int] = None,
    ) -> DepositStatus:
        order_id = self._order_id(provider_order_id)
        response = await self._request_json(self._status_path, {
            "merchant_id": self._merchant_id,
            "order_id": order_id,
            "api_token": self._api_token,
        })
        returned_order = self._order_id(response.get("order_id"))
        if returned_order != order_id:
            raise ProviderRequestError("Provider status did not match the requested order")
        returned_merchant = response.get("merchant_id")
        if returned_merchant not in {None, "", self._merchant_id}:
            raise ProviderRequestError("Provider status returned another merchant")
        status = self._status(response)
        amount_value = response.get("amount")
        if amount_value is None and isinstance(response.get("data"), Mapping):
            amount_value = response["data"].get("amount")
        if amount_value is None:
            if (
                isinstance(expected_amount_paise, bool)
                or not isinstance(expected_amount_paise, int)
                or expected_amount_paise <= 0
            ):
                raise ProviderRequestError("Provider status omitted the order-bound amount")
            amount_paise = expected_amount_paise
        else:
            amount_paise = self._amount_to_paise(amount_value)
            if expected_amount_paise is not None and amount_paise != expected_amount_paise:
                raise ProviderRequestError("Provider status amount did not match the order")
        utr = str(response.get("utr") or "").strip().upper()
        if re.fullmatch(r"[A-Za-z0-9_-]{4,80}", utr):
            reference = utr
        else:
            reference = f"sgpay24:{order_id}:failed" if status == "FAILED" else None
        return DepositStatus(
            status, amount_paise, "INR", reference,
            extract_provider_occurred_at(response),
        )

    def _payout_endpoint(self) -> str:
        extra = str(self._env.get("SGPAY24_PAYOUT_PATH") or "").strip()
        if extra.startswith("/api/") and len(extra) < 80 and ".." not in extra:
            return extra
        return self._payout_path

    def _payout_api_kind(self) -> str:
        """Default stays the live collection host. api.sgpay24.in is opt-in only."""
        raw = str(self._env.get("SGPAY24_PAYOUT_API") or "").strip().lower()
        if raw in {"", "root", "root.sgpay24.com", "createpayoutrequest"}:
            return "root"
        if raw in {"v1", "api.sgpay24.in", "https://api.sgpay24.in/v1/payout"}:
            return "v1"
        raise ProviderConfigurationError("SGPAY24_PAYOUT_API is not an approved payout API")

    async def _submit_payout_v1(self, payload: Mapping[str, Any], *, amount_paise: int) -> Mapping[str, Any]:
        """Bearer JSON payout used only when SGPAY24_PAYOUT_API selects v1.

        The merchant runbook does not name api.sgpay24.in for this account, so
        production must keep the default root.sgpay24.com createPayoutRequest.
        """
        body = {
            "amount": self._amount_in_rupees(amount_paise),
            "currency": "INR",
            "account_number": payload.get("account") or payload.get("account_number") or "",
            "ifsc_code": payload.get("ifsc_no") or payload.get("ifsc_code") or payload.get("ifsc") or "",
            "beneficiary_name": (
                payload.get("benifeciryname")
                or payload.get("beneficiary_name")
                or payload.get("name")
                or ""
            ),
            "mode": payload.get("mode") or "IMPS",
            "reference_id": payload.get("reference_id") or payload.get("order_id") or "",
        }
        if payload.get("upi_id") and not body["account_number"]:
            body["upi_id"] = payload["upi_id"]
            body["mode"] = "UPI"
        timeout = self._timeout
        encoded = json.dumps(body, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
        headers = {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self._api_token}",
        }

        def send() -> Mapping[str, Any]:
            try:
                rows = socket.getaddrinfo(self._v1_payout_host, 443, type=socket.SOCK_STREAM)
            except socket.gaierror as exc:
                raise ProviderRequestError("Provider host could not be resolved") from exc
            addresses = [str(row[4][0]) for row in rows]
            if not addresses or any(not _public_ip(address) for address in addresses):
                raise ProviderConfigurationError("Provider host resolved to a non-public address")
            connection = _PinnedHTTPSConnection(addresses[0], self._v1_payout_host, 443, timeout=timeout)
            try:
                connection.request("POST", self._v1_payout_path, body=encoded, headers=headers)
                response = connection.getresponse()
                raw = response.read(1024 * 1024 + 1)
                if 300 <= response.status < 400:
                    raise ProviderRequestError("Provider redirect was rejected")
                if response.status >= 400:
                    raise ProviderRequestError(self._provider_error_message(response.status, raw))
                parsed = json.loads(raw or b"{}")
                if not isinstance(parsed, Mapping):
                    raise ProviderRequestError("Provider response must be an object")
                return parsed
            finally:
                connection.close()

        try:
            return await asyncio.wait_for(asyncio.to_thread(send), timeout=timeout + 1)
        except ProviderRequestError:
            raise
        except (
            OSError, ssl.SSLError, http.client.HTTPException, urllib.error.URLError,
            asyncio.TimeoutError, json.JSONDecodeError,
        ) as exc:
            raise ProviderRequestError("Provider request failed") from exc

    async def create_beneficiary(self, **kwargs) -> Beneficiary:
        method_id = str(kwargs.get("payout_method_id") or kwargs.get("provider_beneficiary_id") or "local")
        return Beneficiary(provider_beneficiary_id=method_id, status="CREATED")

    async def submit_payout(self, **kwargs) -> PayoutSubmission:
        currency = str(kwargs.get("currency") or "INR").upper()
        if currency != "INR":
            raise ProviderRequestError("SgPay24 supports INR payouts only")
        amount_paise = int(kwargs.get("amount_paise") or 0)
        if amount_paise <= 0:
            raise ProviderRequestError("Payout amount is invalid")
        withdrawal_id = str(kwargs.get("withdrawal_id") or "")
        order_id = self._order_id(withdrawal_id or kwargs.get("idempotency_key") or "payout")
        account_number = str(kwargs.get("account_number") or kwargs.get("account") or "").strip()
        ifsc = str(
            kwargs.get("ifsc_code") or kwargs.get("ifsc_no") or kwargs.get("ifsc") or ""
        ).strip()
        upi = str(kwargs.get("payout_identifier") or kwargs.get("upi_id") or "").strip()
        if not account_number and not upi:
            raise ProviderRequestError("Payout needs a bank account or UPI id")
        phone = re.sub(r"\D", "", str(kwargs.get("phone") or ""))
        if len(phone) == 12 and phone.startswith("91"):
            phone = phone[2:]
        if len(phone) != 10 or phone[0] not in "6789":
            raise ProviderRequestError("A valid Indian mobile number is required for payout")
        email = str(kwargs.get("email") or "").strip().lower()
        if not self._valid_email(email):
            email = self._fallback_email
        holder = str(
            kwargs.get("account_holder_name")
            or kwargs.get("benifeciryname")
            or kwargs.get("beneficiary_name")
            or "Player"
        ).strip()[:80]
        # Merchant payout docs (createPayoutRequest): mid, api_token, order_id,
        # amount, account, ifsc_no, bank_name, benifeciryname, email, phone,
        # redirect_url, remark. Webhook URL is dashboard-configured, not per-request.
        payload = {
            "mid": self._merchant_id,
            "merchant_id": self._merchant_id,
            "api_token": self._api_token,
            "order_id": order_id,
            "amount": self._amount_in_rupees(amount_paise),
            "benifeciryname": holder,
            "email": email,
            "phone": phone,
            "redirect_url": self._payout_redirect_url(
                str(kwargs.get("return_url") or kwargs.get("redirect_url") or ""),
            ),
            "remark": f"Chakri payout {order_id[:24]}",
        }
        if account_number:
            bank_name = str(kwargs.get("bank_name") or "").strip()
            if not bank_name:
                raise ProviderRequestError("Payout needs a bank name")
            if not ifsc:
                raise ProviderRequestError("Payout needs an IFSC code")
            payload["account"] = account_number
            payload["ifsc_no"] = ifsc
            payload["bank_name"] = bank_name
        if upi:
            payload["upi_id"] = upi
        if self._payout_api_kind() == "v1":
            response = await self._submit_payout_v1(payload, amount_paise=amount_paise)
        else:
            # Live createPayoutRequest ignores JSON bodies ("All fields are required")
            # and only reads query-string fields. Keep that transport; send docs keys.
            response = await self._request_json(self._payout_endpoint(), payload, as_query=True)
        data = response.get("data") if isinstance(response.get("data"), Mapping) else response
        if not isinstance(data, Mapping):
            data = response
        provider_id = str(
            data.get("payout_id") or data.get("transaction_id") or data.get("order_id") or order_id
        )
        raw_status = data.get("status")
        if raw_status is None:
            raw_status = response.get("status")
        mapped = self._map_payout_status(raw_status)
        return PayoutSubmission(provider_payout_id=provider_id, status=mapped)

    async def get_payout_status(self, provider_payout_id: str) -> PayoutStatus:
        order_id = self._order_id(provider_payout_id)
        response = await self._request_json(self._payout_status_path, {
            "merchant_id": self._merchant_id,
            "order_id": order_id,
            "api_token": self._api_token,
        })
        mapped = self._map_payout_status(response.get("status"))
        amount_value = response.get("amount")
        amount_paise = self._amount_to_paise(amount_value) if amount_value is not None else None
        return PayoutStatus(
            status=mapped,
            amount_paise=amount_paise,
            currency="INR",
            withdrawal_id=None,
            idempotency_key=None,
            provider_beneficiary_id=None,
            provider_reference=str(response.get("utr") or order_id),
            occurred_at=extract_provider_occurred_at(response),
        )

    async def cancel_payout(self, _provider_payout_id: str) -> str:
        raise ProviderRequestError("SgPay24 payout cancellation is not available")

    async def refund_payment(self, _provider_order_id: str, _amount_paise: int) -> str:
        raise ProviderRequestError("SgPay24 refunds are not enabled")

    def verify_webhook(self, raw_body: bytes, headers: Mapping[str, str]) -> ProviderEvent:
        del headers
        if not raw_body or len(raw_body) > MAX_WEBHOOK_BODY_BYTES:
            raise WebhookVerificationError("Webhook body is empty or too large")
        try:
            payload = json.loads(raw_body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise WebhookVerificationError("Webhook body is not valid JSON") from exc
        if not isinstance(payload, Mapping):
            raise WebhookVerificationError("Webhook body must be an object")
        try:
            order_id = self._order_id(
                payload.get("order_id") or payload.get("payout_id") or payload.get("reference_id"),
            )
            amount_value = payload.get("amount")
            amount_paise = 0 if amount_value is None else self._amount_to_paise(amount_value)
            raw_status = payload.get("status")
            if raw_status is None:
                raw_status = payload.get("type")
            status_code = self._status_code(raw_status)
        except (ProviderRequestError, TypeError, ValueError) as exc:
            raise WebhookVerificationError("Webhook payment fields are invalid") from exc
        transaction_id = payload.get("transaction_id")
        payout_like = bool(
            payload.get("payout_id")
            or str(payload.get("event") or payload.get("event_type") or payload.get("kind") or "").lower()
            in {"payout", "withdrawal", "payout.paid", "payout.failed", "payout.processing"}
            or str(payload.get("type") or "").lower() in {"payout", "withdrawal"}
        )
        if not payout_like:
            if isinstance(transaction_id, bool) or not isinstance(transaction_id, int) or transaction_id <= 0:
                raise WebhookVerificationError("Webhook transaction reference is invalid")
        elif isinstance(transaction_id, bool) or (
            transaction_id is not None and (not isinstance(transaction_id, int) or transaction_id <= 0)
        ):
            transaction_id = None
        if status_code not in {0, 1, 2}:
            raise WebhookVerificationError("Webhook status is invalid")
        utr = str(payload.get("utr") or "").strip()
        if payout_like:
            if status_code == 2:
                event_type = "payout.failed"
            elif status_code == 1:
                event_type = "payout.paid"
            else:
                event_type = "payout.processing"
        else:
            event_type = "deposit.failed" if status_code == 2 else "deposit.paid"
        notice_key = f"{order_id}:{transaction_id}:{status_code}:{utr}:{event_type}"
        occurred = extract_provider_occurred_at(payload)
        return ProviderEvent(
            event_id=f"sgpay24-notice:{hashlib.sha256(notice_key.encode()).hexdigest()[:40]}",
            event_type=event_type,
            object_id=order_id,
            amount_paise=amount_paise,
            currency="INR",
            provider_reference=utr or None,
            occurred_at=datetime_to_iso_utc(occurred),
            data={
                "requires_authenticated_status_lookup": True,
                "transaction_id": transaction_id,
                "notice_kind": "payout" if payout_like else "collection",
            },
        )


def load_payment_provider(environ: Optional[Mapping[str, str]] = None) -> PaymentProvider:
    env = os.environ if environ is None else environ
    provider_name = str(env.get("PAYMENT_PROVIDER", "")).strip().lower()
    if not provider_name:
        raise ProviderConfigurationError("PAYMENT_PROVIDER is required; there is no runtime default")
    if provider_name == "sgpay24":
        return SgPay24PaymentProvider(env)
    return ConfiguredRestPaymentProvider(env)
