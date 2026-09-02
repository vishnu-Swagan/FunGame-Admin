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
    checkout_allowed_hosts: tuple[str, ...]

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

    async def create_deposit_order(self, *, deposit_id: str, amount_paise: int, currency: str, idempotency_key: str, return_url: str) -> DepositSession:
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

    async def get_payment_status(self, provider_order_id: str) -> DepositStatus:
        if not self.capabilities.payment_status_lookup:
            raise ProviderRequestError("Provider does not certify authoritative payment status lookup")
        response = await self._request("get_payment_status", locals())
        return DepositStatus(
            self._status("deposit", self._field("get_payment_status", response, "status")),
            self._authoritative_amount(self._field("get_payment_status", response, "amount_paise")),
            self._authoritative_currency(self._field("get_payment_status", response, "currency")),
            str(self._field("get_payment_status", response, "provider_reference")),
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
        event_data = {"provider_payload_hash": hashlib.sha256(raw_body).hexdigest()}
        payment_fingerprint_path = mapping.get("payment_instrument_fingerprint")
        if payment_fingerprint_path is not None:
            payment_fingerprint = _path_get(payload, payment_fingerprint_path)
            if not isinstance(payment_fingerprint, str) or not re.fullmatch(
                r"[A-Za-z0-9._:=+/\-]{16,512}", payment_fingerprint,
            ):
                raise WebhookVerificationError(
                    "Webhook payment_instrument_fingerprint is invalid",
                )
            # This trusted provider token is consumed and HMACed by the wallet;
            # neither it nor the raw body is persisted in financial records.
            event_data["payment_instrument_fingerprint"] = payment_fingerprint
        return ProviderEvent(
            event_id=event_id, event_type=event_type.lower(), object_id=object_id,
            amount_paise=amount, currency=currency, provider_reference=reference_value,
            occurred_at=occurred_value, data=event_data,
        )


def load_payment_provider(environ: Optional[Mapping[str, str]] = None) -> PaymentProvider:
    env = os.environ if environ is None else environ
    if not str(env.get("PAYMENT_PROVIDER", "")).strip():
        raise ProviderConfigurationError("PAYMENT_PROVIDER is required; there is no runtime default")
    return ConfiguredRestPaymentProvider(env)
