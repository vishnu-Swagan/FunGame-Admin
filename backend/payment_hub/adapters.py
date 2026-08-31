from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import http.client
import ipaddress
import json
import re
import socket
import ssl
import time
import urllib.error
import urllib.parse
from dataclasses import dataclass
from typing import Any, Mapping, Protocol

from .domain import (
    Capability, Direction, GatewayError, PayinStatus, PayoutStatus, redact,
    require_capability, require_money,
)


_HEADER_RE = re.compile(r"^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$")
_SECRET_NAME_RE = re.compile(r"^[a-z][a-z0-9_]{1,63}$")
_FORBIDDEN_HEADERS = {
    "authorization", "connection", "content-length", "cookie", "host",
    "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade",
}
_SENSITIVE_KEYS = re.compile(
    r"^(?:api[_-]?key|api[_-]?secret|authorization|bearer[_-]?token|client[_-]?secret|password|private[_-]?key|secret|token|webhook[_-]?secret)$",
    re.I,
)
_NORMALIZED_STATUSES = {item.value for item in PayinStatus} | {item.value for item in PayoutStatus}
_DIRECTION_STATUSES = {
    Direction.PAYIN: {item.value for item in PayinStatus},
    Direction.PAYOUT: {item.value for item in PayoutStatus},
}
_CAPABILITY_OPERATIONS = {
    Capability.PAYIN: {"create_payin"},
    Capability.PAYOUT: {"create_payout"},
    Capability.PAYMENT_STATUS_QUERY: {"get_payin_status"},
    Capability.PAYOUT_STATUS_QUERY: {"get_payout_status"},
    Capability.REFUND: {"refund_payin", "get_refund_status"},
    Capability.PARTIAL_REFUND: {"refund_payin", "get_refund_status"},
    Capability.SETTLEMENT_API: {"fetch_settlements"},
    Capability.DISPUTES: {"fetch_disputes"},
    Capability.HOSTED_CHECKOUT: {"create_payin"},
    Capability.PAYMENT_LINK: {"create_payin"},
    Capability.QR: {"create_payin"},
    Capability.UPI: {"create_payin"},
    Capability.CARD: {"create_payin"},
    Capability.BANK_TRANSFER: {"create_payin"},
    Capability.WALLET: {"create_payin"},
}


@dataclass(frozen=True)
class AdapterResult:
    provider_id: str
    status: str
    checkout_url: str | None = None
    qr_payload: str | None = None
    provider_reference: str | None = None
    raw: Mapping[str, Any] | None = None


@dataclass(frozen=True)
class WebhookResult:
    event_id: str
    event_type: str
    direction: str
    object_id: str
    status: str
    amount_minor: int | None
    currency: str | None
    provider_reference: str | None
    sanitized_payload: Mapping[str, Any]


class GatewayAdapter(Protocol):
    code: str
    capabilities: frozenset[Capability]

    async def validate_config(self) -> None: ...
    async def health_check(self, context: Mapping[str, Any] | None = None) -> Mapping[str, Any]: ...
    async def create_payin(self, request: Mapping[str, Any], idempotency_key: str) -> AdapterResult: ...
    async def get_payin_status(self, provider_payment_id: str) -> AdapterResult: ...
    async def cancel_payin(self, provider_payment_id: str) -> AdapterResult: ...
    async def refund_payin(self, request: Mapping[str, Any], idempotency_key: str) -> AdapterResult: ...
    async def get_refund_status(self, provider_refund_id: str) -> AdapterResult: ...
    async def create_payout(self, request: Mapping[str, Any], idempotency_key: str) -> AdapterResult: ...
    async def get_payout_status(self, provider_payout_id: str) -> AdapterResult: ...
    async def cancel_payout(self, provider_payout_id: str) -> AdapterResult: ...
    def verify_webhook(self, headers: Mapping[str, str], raw_body: bytes) -> None: ...
    def parse_webhook(self, headers: Mapping[str, str], raw_body: bytes) -> WebhookResult: ...
    async def fetch_settlements(self, request: Mapping[str, Any]) -> list[Mapping[str, Any]]: ...
    async def fetch_disputes(self, request: Mapping[str, Any]) -> list[Mapping[str, Any]]: ...
    def normalize_error(self, error: Exception) -> GatewayError: ...
    def redact_sensitive_data(self, payload: Any) -> Any: ...


class BaseAdapter:
    code = "BASE"
    capabilities: frozenset[Capability] = frozenset()

    def _unsupported(self, capability: Capability):
        require_capability(set(self.capabilities), capability)

    async def cancel_payin(self, provider_payment_id: str) -> AdapterResult:
        self._unsupported(Capability.CANCELLATION)

    async def refund_payin(self, request: Mapping[str, Any], idempotency_key: str) -> AdapterResult:
        self._unsupported(Capability.REFUND)

    async def get_refund_status(self, provider_refund_id: str) -> AdapterResult:
        self._unsupported(Capability.REFUND)

    async def cancel_payout(self, provider_payout_id: str) -> AdapterResult:
        self._unsupported(Capability.CANCELLATION)

    async def fetch_settlements(self, request: Mapping[str, Any]) -> list[Mapping[str, Any]]:
        self._unsupported(Capability.SETTLEMENT_API)

    async def fetch_disputes(self, request: Mapping[str, Any]) -> list[Mapping[str, Any]]:
        self._unsupported(Capability.DISPUTES)

    def normalize_error(self, error: Exception) -> GatewayError:
        if isinstance(error, GatewayError):
            return error
        if isinstance(error, (TimeoutError, asyncio.TimeoutError)):
            return GatewayError("PROVIDER_TIMEOUT", "The provider timed out.", retryable=True, status_code=503)
        return GatewayError("PROVIDER_ERROR", "The provider request failed.", retryable=False, status_code=502)

    def redact_sensitive_data(self, payload: Any) -> Any:
        return redact(payload)


def _is_public_ip(address: str) -> bool:
    try:
        ip = ipaddress.ip_address(address)
    except ValueError:
        return False
    return not (ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified)


def _approved_host_entry(value: str) -> bool:
    host = str(value).strip().lower().rstrip(".")
    if not host or host == "localhost" or host.endswith(".local") or ".." in host:
        return False
    try:
        ipaddress.ip_address(host)
    except ValueError:
        return "." in host and bool(re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?", host))
    return _is_public_ip(host)


def _get_path(payload: Mapping[str, Any], path: str, default=None):
    current: Any = payload
    for part in path.split("."):
        if not part or not isinstance(current, Mapping) or part not in current:
            return default
        current = current[part]
    return current


def _set_path(payload: dict[str, Any], path: str, value: Any) -> None:
    parts = str(path).split(".")
    if any(not part or part in {"__class__", "__dict__", "__proto__"} for part in parts):
        raise GatewayError("GATEWAY_CONFIG_INVALID", "Provider field mapping is invalid.")
    current = payload
    for part in parts[:-1]:
        child = current.setdefault(part, {})
        if not isinstance(child, dict):
            raise GatewayError("GATEWAY_CONFIG_INVALID", "Provider field mappings conflict.")
        current = child
    current[parts[-1]] = value


def _reject_embedded_secrets(value: Any, path: str = "non_secret_config") -> None:
    if isinstance(value, Mapping):
        for key, item in value.items():
            if _SENSITIVE_KEYS.fullmatch(str(key)):
                raise GatewayError(
                    "GATEWAY_CONFIG_INVALID",
                    f"{path}.{key} must use the encrypted credential store.",
                )
            _reject_embedded_secrets(item, f"{path}.{key}")
    elif isinstance(value, list):
        for index, item in enumerate(value):
            _reject_embedded_secrets(item, f"{path}[{index}]")


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    """Connect to a reviewed IP while retaining TLS hostname verification."""

    def __init__(self, address: str, hostname: str, port: int, *, timeout: int):
        super().__init__(hostname, port=port, timeout=timeout, context=ssl.create_default_context())
        self._payment_address = address
        self._payment_hostname = hostname

    def connect(self):
        self.sock = socket.create_connection((self._payment_address, self.port), self.timeout)
        self.sock = self._context.wrap_socket(self.sock, server_hostname=self._payment_hostname)


class GenericRestAdapter(BaseAdapter):
    code = "GENERIC_REST"

    def __init__(self, config: Mapping[str, Any], secrets: Mapping[str, str] | None = None, allowed_domains: set[str] | None = None):
        self.config = dict(config or {})
        self.secrets = dict(secrets or {})
        self.capabilities = frozenset(Capability(item) for item in self.config.get("capabilities", []))
        self.allowed_domains = {item.lower() for item in (allowed_domains or set())}

    async def validate_config(self) -> None:
        parsed = urllib.parse.urlsplit(str(self.config.get("base_url", "")))
        if (
            parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
            or parsed.query or parsed.fragment
        ):
            raise GatewayError("GATEWAY_CONFIG_INVALID", "Provider base URL must be credential-free HTTPS.")
        host = parsed.hostname.lower().rstrip(".")
        if (
            not self.allowed_domains or any(not _approved_host_entry(item) for item in self.allowed_domains)
            or not any(host == item or host.endswith(f".{item}") for item in self.allowed_domains)
        ):
            raise GatewayError("GATEWAY_DOMAIN_NOT_ALLOWED", "Provider domain is not approved.")
        try:
            addresses = await asyncio.to_thread(socket.getaddrinfo, host, parsed.port or 443, type=socket.SOCK_STREAM)
        except socket.gaierror as exc:
            raise GatewayError("GATEWAY_DNS_FAILED", "Provider host could not be resolved.", retryable=True) from exc
        if not addresses or any(not _is_public_ip(item[4][0]) for item in addresses):
            raise GatewayError("GATEWAY_SSRF_BLOCKED", "Provider address is not publicly routable.")
        endpoints = self.config.get("endpoints", {})
        if not isinstance(endpoints, Mapping) or not endpoints:
            raise GatewayError("GATEWAY_CONFIG_INVALID", "Provider endpoints must be an object.")
        for name, path in endpoints.items():
            if not isinstance(path, str) or not path.startswith("/") or "//" in path or ".." in path:
                raise GatewayError("GATEWAY_CONFIG_INVALID", f"Endpoint {name} is invalid.")
        required_operations = {"health_check"}
        for capability in self.capabilities:
            required_operations.update(_CAPABILITY_OPERATIONS.get(capability, set()))
        payin_method_capabilities = {
            Capability.HOSTED_CHECKOUT, Capability.PAYMENT_LINK, Capability.QR,
            Capability.UPI, Capability.CARD, Capability.BANK_TRANSFER, Capability.WALLET,
        }
        if self.capabilities & payin_method_capabilities and Capability.PAYIN not in self.capabilities:
            raise GatewayError(
                "GATEWAY_CONFIG_INVALID",
                "Pay-in method capabilities require the pay-in capability.",
            )
        if Capability.PARTIAL_REFUND in self.capabilities and Capability.REFUND not in self.capabilities:
            raise GatewayError(
                "GATEWAY_CONFIG_INVALID",
                "Partial refund requires the refund capability.",
            )
        if Capability.CANCELLATION in self.capabilities:
            if not ({Capability.PAYIN, Capability.PAYOUT} & self.capabilities):
                raise GatewayError(
                    "GATEWAY_CONFIG_INVALID",
                    "Cancellation requires a configured pay-in or payout capability.",
                )
            if Capability.PAYIN in self.capabilities:
                required_operations.add("cancel_payin")
            if Capability.PAYOUT in self.capabilities:
                required_operations.add("cancel_payout")
        if Capability.REVERSAL in self.capabilities:
            raise GatewayError(
                "GATEWAY_CONFIG_INVALID",
                "The generic REST bridge does not expose an authoritative reversal operation.",
            )
        missing_operations = required_operations - set(endpoints)
        if missing_operations:
            raise GatewayError(
                "GATEWAY_CONFIG_INVALID",
                f"Declared capabilities require endpoints: {', '.join(sorted(missing_operations))}.",
            )
        checkout_hosts = self.config.get("checkout_hosts", [])
        if not isinstance(checkout_hosts, list) or any(
            not isinstance(item, str) or not _approved_host_entry(item)
            for item in checkout_hosts
        ):
            raise GatewayError("GATEWAY_CONFIG_INVALID", "Checkout hosts must be an exact public-host list.")
        normalized_checkout_hosts = [item.strip().lower().rstrip(".") for item in checkout_hosts]
        if len(normalized_checkout_hosts) != len(set(normalized_checkout_hosts)) or len(normalized_checkout_hosts) > 20:
            raise GatewayError("GATEWAY_CONFIG_INVALID", "Checkout hosts must be unique and limited.")
        if (Capability.HOSTED_CHECKOUT in self.capabilities or "create_payin" in endpoints) and not checkout_hosts:
            raise GatewayError("GATEWAY_CONFIG_INVALID", "An exact checkout host allowlist is required.")
        if Capability.HOSTED_CHECKOUT in self.capabilities and Capability.PAYIN not in self.capabilities:
            raise GatewayError("GATEWAY_CONFIG_INVALID", "Hosted checkout requires the pay-in capability.")
        request_mapping = self.config.get("request_mapping")
        response_mapping = self.config.get("response_mapping")
        if not isinstance(request_mapping, Mapping) or not isinstance(response_mapping, Mapping):
            raise GatewayError("GATEWAY_CONFIG_INVALID", "Explicit request and response mappings are required.")
        required_requests = {
            "create_payin": {"amount_minor", "currency", "reference"},
            "get_payin_status": {"provider_payment_id"},
            "cancel_payin": {"provider_payment_id"},
            "refund_payin": {"provider_payment_id", "amount_minor", "currency"},
            "get_refund_status": {"provider_refund_id"},
            "create_payout": {"withdrawal_id", "provider_beneficiary_id", "amount_minor", "currency"},
            "get_payout_status": {"provider_payout_id"},
            "cancel_payout": {"provider_payout_id"},
            "fetch_settlements": set(),
            "fetch_disputes": set(),
        }
        required_responses = {
            "create_payin": {"provider_id", "status", "checkout_url"},
            "get_payin_status": {"provider_id", "status", "amount_minor", "currency", "provider_reference"},
            "cancel_payin": {"provider_id", "status"},
            "refund_payin": {"provider_id", "status", "provider_reference"},
            "get_refund_status": {"provider_id", "status", "amount_minor", "currency", "provider_reference"},
            "create_payout": {"provider_id", "status"},
            "get_payout_status": {
                "provider_id", "status", "amount_minor", "currency", "provider_reference",
                "withdrawal_id", "idempotency_key", "provider_beneficiary_id",
            },
            "cancel_payout": {"provider_id", "status"},
            "fetch_settlements": {"items"},
            "fetch_disputes": {"items"},
        }
        for operation in endpoints:
            if operation == "health_check":
                if not isinstance(request_mapping.get(operation), Mapping):
                    raise GatewayError("GATEWAY_CONFIG_INVALID", "Health-check request mapping is required.")
                continue
            request_fields = request_mapping.get(operation)
            response_fields = response_mapping.get(operation)
            if not isinstance(request_fields, Mapping) or not isinstance(response_fields, Mapping):
                raise GatewayError("GATEWAY_CONFIG_INVALID", f"Mappings for {operation} are required.")
            if required_requests.get(operation, set()) - set(request_fields):
                raise GatewayError("GATEWAY_CONFIG_INVALID", f"Request mapping for {operation} is incomplete.")
            if required_responses.get(operation, {"provider_id", "status"}) - set(response_fields):
                raise GatewayError("GATEWAY_CONFIG_INVALID", f"Response mapping for {operation} is incomplete.")
            if any(not isinstance(key, str) or not isinstance(value, str) or not value for key, value in request_fields.items()):
                raise GatewayError("GATEWAY_CONFIG_INVALID", f"Request mapping for {operation} is invalid.")
            if any(not isinstance(key, str) or not isinstance(value, str) or not value for key, value in response_fields.items()):
                raise GatewayError("GATEWAY_CONFIG_INVALID", f"Response mapping for {operation} is invalid.")
        idempotency_header = str(self.config.get("idempotency_header", ""))
        if not _HEADER_RE.fullmatch(idempotency_header) or idempotency_header.lower() in _FORBIDDEN_HEADERS:
            raise GatewayError("GATEWAY_CONFIG_INVALID", "Provider idempotency header is invalid.")
        auth_config = self.config.get("auth", {}) or {}
        if isinstance(auth_config, Mapping):
            for field in ("header_name", "timestamp_header", "signature_header"):
                if auth_config.get(field):
                    if str(auth_config[field]).lower() == idempotency_header.lower():
                        raise GatewayError("GATEWAY_CONFIG_INVALID", "Idempotency and authentication headers must be distinct.")
        headers = self.config.get("headers", {}) or {}
        if not isinstance(headers, Mapping):
            raise GatewayError("GATEWAY_CONFIG_INVALID", "Provider headers must be an object.")
        if headers:
            raise GatewayError(
                "GATEWAY_CONFIG_INVALID",
                "Static provider headers are not supported; use encrypted authentication credentials.",
            )
        status_mapping = self.config.get("status_mapping")
        if (
            not isinstance(status_mapping, Mapping) or not status_mapping
            or any(
                not isinstance(key, str) or not key.strip() or key != key.upper()
                or str(value).upper() not in _NORMALIZED_STATUSES
                for key, value in status_mapping.items()
            )
        ):
            raise GatewayError("GATEWAY_CONFIG_INVALID", "Explicit normalized status mapping is required.")
        _reject_embedded_secrets({
            key: value for key, value in self.config.items() if key not in {"auth", "webhook"}
        })
        self._validate_auth_config()
        if Capability.WEBHOOKS in self.capabilities:
            self._validate_webhook_config()
        for name, default, minimum, maximum in (
            ("timeout_seconds", 15, 1, 30),
            ("max_response_bytes", 1024 * 1024, 1024, 4 * 1024 * 1024),
        ):
            try:
                configured = int(self.config.get(name, default))
            except (TypeError, ValueError) as exc:
                raise GatewayError("GATEWAY_CONFIG_INVALID", f"Provider {name} must be an integer.") from exc
            if not minimum <= configured <= maximum:
                raise GatewayError("GATEWAY_CONFIG_INVALID", f"Provider {name} is outside the allowed range.")

    def _secret(self, name: Any, purpose: str, *, minimum: int = 1) -> str:
        key = str(name or "")
        if not _SECRET_NAME_RE.fullmatch(key):
            raise GatewayError("GATEWAY_CONFIG_INVALID", f"Provider {purpose} credential name is invalid.")
        value = str(self.secrets.get(key, ""))
        if len(value) < minimum:
            raise GatewayError("GATEWAY_SECRET_INVALID", f"Provider {purpose} credential is unavailable.", status_code=503)
        return value

    def _validate_auth_config(self) -> None:
        auth = self.config.get("auth")
        if not isinstance(auth, Mapping):
            raise GatewayError("GATEWAY_CONFIG_INVALID", "Provider authentication configuration is required.")
        strategy = str(auth.get("strategy", "")).lower()
        allowed_fields = {
            "bearer": {"strategy", "credential_key"},
            "basic": {"strategy", "username_key", "password_key"},
            "api_key_header": {"strategy", "header_name", "credential_key"},
            "hmac-sha256": {"strategy", "credential_key", "timestamp_header", "signature_header"},
            "hmac-sha512": {"strategy", "credential_key", "timestamp_header", "signature_header"},
        }
        if strategy not in allowed_fields or set(auth) - allowed_fields[strategy]:
            raise GatewayError("GATEWAY_CONFIG_INVALID", "Authentication configuration contains unsupported fields.")
        if strategy == "bearer":
            self._secret(auth.get("credential_key"), "bearer token")
        elif strategy == "basic":
            self._secret(auth.get("username_key"), "username")
            self._secret(auth.get("password_key"), "password")
        elif strategy == "api_key_header":
            header_name = str(auth.get("header_name", ""))
            if not _HEADER_RE.fullmatch(header_name) or header_name.lower() in _FORBIDDEN_HEADERS:
                raise GatewayError("GATEWAY_CONFIG_INVALID", "Provider API-key header name is invalid.")
            self._secret(auth.get("credential_key"), "API key")
        elif strategy in {"hmac-sha256", "hmac-sha512"}:
            self._secret(auth.get("credential_key"), "HMAC secret", minimum=16)
            for field in ("timestamp_header", "signature_header"):
                header = str(auth.get(field, ""))
                if not _HEADER_RE.fullmatch(header) or header.lower() in _FORBIDDEN_HEADERS:
                    raise GatewayError("GATEWAY_CONFIG_INVALID", f"Provider {field} is invalid.")
            if str(auth.get("timestamp_header")).lower() == str(auth.get("signature_header")).lower():
                raise GatewayError("GATEWAY_CONFIG_INVALID", "Provider signature headers must be distinct.")
        else:
            raise GatewayError("GATEWAY_CONFIG_INVALID", "Authentication strategy is not supported.")

    def _validate_webhook_config(self) -> None:
        config = self.config.get("webhook")
        if not isinstance(config, Mapping) or str(config.get("algorithm", "")).lower() not in {"hmac-sha256", "hmac-sha512"}:
            raise GatewayError("GATEWAY_CONFIG_INVALID", "Signed webhook configuration is required.")
        allowed = {
            "algorithm", "credential_key", "timestamp_header", "signature_header",
            "signature_prefix", "replay_window_seconds",
        }
        if set(config) - allowed:
            raise GatewayError("GATEWAY_CONFIG_INVALID", "Webhook configuration contains unsupported fields.")
        prefix = config.get("signature_prefix", "")
        if not isinstance(prefix, str) or "\r" in prefix or "\n" in prefix or len(prefix) > 32:
            raise GatewayError("GATEWAY_CONFIG_INVALID", "Webhook signature prefix is invalid.")
        self._secret(config.get("credential_key"), "webhook secret", minimum=32)
        for field in ("timestamp_header", "signature_header"):
            if not _HEADER_RE.fullmatch(str(config.get(field, ""))):
                raise GatewayError("GATEWAY_CONFIG_INVALID", f"Webhook {field} is invalid.")
        if str(config.get("timestamp_header")).lower() == str(config.get("signature_header")).lower():
            raise GatewayError("GATEWAY_CONFIG_INVALID", "Webhook signature headers must be distinct.")
        try:
            replay = int(config.get("replay_window_seconds"))
        except (TypeError, ValueError) as exc:
            raise GatewayError("GATEWAY_CONFIG_INVALID", "Webhook replay window is invalid.") from exc
        if not 30 <= replay <= 900:
            raise GatewayError("GATEWAY_CONFIG_INVALID", "Webhook replay window is invalid.")
        mapping = self.config.get("webhook_mapping")
        required = {"event_id", "event_type", "object_id", "status", "amount_minor", "currency", "provider_reference"}
        if not isinstance(mapping, Mapping) or required - set(mapping):
            raise GatewayError("GATEWAY_CONFIG_INVALID", "Authoritative webhook mapping is incomplete.")
        event_mapping = self.config.get("webhook_event_mapping")
        if not isinstance(event_mapping, Mapping) or not event_mapping:
            raise GatewayError("GATEWAY_CONFIG_INVALID", "Explicit webhook event mapping is required.")
        for provider_event_type, rule in event_mapping.items():
            if (
                not isinstance(provider_event_type, str) or not provider_event_type.strip()
                or len(provider_event_type) > 160 or not isinstance(rule, Mapping)
                or set(rule) != {"event_type", "direction"}
            ):
                raise GatewayError("GATEWAY_CONFIG_INVALID", "Webhook event mapping is invalid.")
            try:
                direction = Direction(str(rule.get("direction", "")).upper())
            except ValueError as exc:
                raise GatewayError("GATEWAY_CONFIG_INVALID", "Webhook event direction is invalid.") from exc
            canonical_type = str(rule.get("event_type", "")).strip().upper()
            if (
                len(canonical_type) > 160
                or not re.fullmatch(r"(?:PAYIN|PAYOUT)\.[A-Z0-9][A-Z0-9_.-]{0,153}", canonical_type)
                or not canonical_type.startswith(f"{direction.value}.")
            ):
                raise GatewayError("GATEWAY_CONFIG_INVALID", "Webhook canonical event type is invalid.")

    def _auth_headers(self, body: bytes) -> dict[str, str]:
        auth = self.config.get("auth", {}) or {}
        strategy = str(auth.get("strategy", "")).lower()
        if strategy == "bearer":
            return {"Authorization": f"Bearer {self._secret(auth.get('credential_key'), 'bearer token')}"}
        if strategy == "basic":
            token = base64.b64encode(
                f"{self._secret(auth.get('username_key'), 'username')}:{self._secret(auth.get('password_key'), 'password')}".encode(),
            ).decode()
            return {"Authorization": f"Basic {token}"}
        if strategy == "api_key_header":
            name = str(auth.get("header_name"))
            return {name: self._secret(auth.get("credential_key"), "API key")}
        if strategy in {"hmac-sha256", "hmac-sha512"}:
            algorithm = hashlib.sha256 if strategy.endswith("256") else hashlib.sha512
            stamp = str(int(time.time()))
            signature = hmac.new(
                self._secret(auth.get("credential_key"), "HMAC secret", minimum=16).encode(),
                stamp.encode() + b"." + body, algorithm,
            ).hexdigest()
            return {str(auth.get("timestamp_header")): stamp, str(auth.get("signature_header")): signature}
        raise GatewayError("GATEWAY_CONFIG_INVALID", "Authentication strategy is not supported.")

    def _mapped_request(self, operation: str, values: Mapping[str, Any]) -> dict[str, Any]:
        mapping = (self.config.get("request_mapping", {}) or {}).get(operation)
        if not isinstance(mapping, Mapping):
            raise GatewayError("GATEWAY_CONFIG_INVALID", f"Request mapping for {operation} is unavailable.")
        payload: dict[str, Any] = {}
        for source, target in mapping.items():
            value = _get_path(values, str(source))
            if value is not None:
                _set_path(payload, str(target), value)
        return payload

    @staticmethod
    def _required_text(value: Any, field: str) -> str:
        text = str(value or "").strip()
        if not text or len(text) > 200:
            raise GatewayError("PAYMENT_REQUEST_INVALID", f"{field} is required.")
        return text

    def _require_idempotency(self, value: Any) -> str:
        text = self._required_text(value, "idempotency_key")
        if len(text) < 8:
            raise GatewayError("PAYMENT_REQUEST_INVALID", "idempotency_key is too short.")
        return text

    async def _request(self, operation: str, payload: Mapping[str, Any] | None = None, idempotency_key: str | None = None) -> Mapping[str, Any]:
        await self.validate_config()
        endpoint = (self.config.get("endpoints", {}) or {}).get(operation)
        if not endpoint:
            raise GatewayError("CAPABILITY_NOT_SUPPORTED", f"Provider operation {operation} is not configured.", status_code=409)
        body = json.dumps(self._mapped_request(operation, dict(payload or {})), separators=(",", ":")).encode()
        headers = {"Content-Type": "application/json", "Accept": "application/json", **self._auth_headers(body)}
        if idempotency_key:
            headers[str(self.config.get("idempotency_header", "Idempotency-Key"))] = idempotency_key
        url = urllib.parse.urlsplit(urllib.parse.urljoin(self.config["base_url"].rstrip("/") + "/", endpoint.lstrip("/")))
        timeout = min(30, max(1, int(self.config.get("timeout_seconds", 15))))
        max_bytes = min(4 * 1024 * 1024, max(1024, int(self.config.get("max_response_bytes", 1024 * 1024))))

        def send():
            addresses = socket.getaddrinfo(url.hostname, url.port or 443, type=socket.SOCK_STREAM)
            public = [item[4][0] for item in addresses if _is_public_ip(item[4][0])]
            if not public or len(public) != len(addresses):
                raise GatewayError("GATEWAY_SSRF_BLOCKED", "Provider address is not publicly routable.")
            connection = _PinnedHTTPSConnection(public[0], url.hostname, url.port or 443, timeout=timeout)
            try:
                path = urllib.parse.urlunsplit(("", "", url.path or "/", url.query, ""))
                # The pinned connection still owns the logical provider
                # hostname and port.  http.client must generate Host from that
                # authority so non-default ports and IPv6 brackets are kept.
                connection.request("POST", path, body=body, headers=headers)
                response = connection.getresponse()
                if 300 <= response.status < 400:
                    raise GatewayError("PROVIDER_REDIRECT_REJECTED", "Provider redirect was rejected.", status_code=502)
                if response.status >= 400:
                    raise GatewayError(
                        "PROVIDER_HTTP_ERROR", "Provider returned an unsuccessful response.",
                        retryable=response.status == 429 or response.status >= 500,
                        status_code=503 if response.status == 429 or response.status >= 500 else 502,
                    )
                raw = response.read(max_bytes + 1)
                if len(raw) > max_bytes:
                    raise GatewayError("PROVIDER_RESPONSE_TOO_LARGE", "Provider response exceeded the configured limit.", status_code=502)
                return json.loads(raw or b"{}")
            finally:
                connection.close()
        try:
            result = await asyncio.wait_for(asyncio.to_thread(send), timeout=timeout + 1)
        except GatewayError:
            raise
        except (urllib.error.URLError, http.client.HTTPException, OSError, ssl.SSLError, TimeoutError, asyncio.TimeoutError) as exc:
            raise GatewayError("PROVIDER_UNAVAILABLE", "Provider request is unavailable.", retryable=True, status_code=503) from exc
        except json.JSONDecodeError as exc:
            raise GatewayError("PROVIDER_RESPONSE_INVALID", "Provider returned invalid JSON.", status_code=502) from exc
        if not isinstance(result, Mapping):
            raise GatewayError("PROVIDER_RESPONSE_INVALID", "Provider response must be an object.", status_code=502)
        return result

    def _result(self, operation: str, payload: Mapping[str, Any]) -> AdapterResult:
        mapping = (self.config.get("response_mapping", {}) or {}).get(operation)
        if not isinstance(mapping, Mapping):
            raise GatewayError("GATEWAY_CONFIG_INVALID", f"Response mapping for {operation} is unavailable.")
        provider_id = _get_path(payload, str(mapping.get("provider_id", "")))
        raw_status = str(_get_path(payload, str(mapping.get("status", "")), "")).upper()
        status = (self.config.get("status_mapping", {}) or {}).get(raw_status)
        if not provider_id or not status:
            raise GatewayError("PROVIDER_RESPONSE_INVALID", "Provider identity or status is missing.", status_code=502)
        canonical = {
            field: _get_path(payload, str(path)) for field, path in mapping.items()
        }
        for field in ("amount_minor", "currency", "provider_reference"):
            if field in mapping and (canonical.get(field) is None or canonical.get(field) == ""):
                raise GatewayError("PROVIDER_RESPONSE_INVALID", f"Provider response omitted authoritative {field}.", status_code=502)
        if "amount_minor" in canonical:
            require_money(canonical["amount_minor"], canonical.get("currency"))
        if operation == "get_payout_status" and any(
            canonical.get(field) is None or canonical.get(field) == ""
            for field in ("withdrawal_id", "idempotency_key", "provider_beneficiary_id", "provider_reference")
        ):
            raise GatewayError("PROVIDER_RESPONSE_INVALID", "Provider payout response is not bound to the instruction.", status_code=502)
        checkout_url = canonical.get("checkout_url")
        if checkout_url:
            try:
                parsed = urllib.parse.urlsplit(str(checkout_url))
                checkout_port = parsed.port
            except ValueError as exc:
                raise GatewayError("PROVIDER_RESPONSE_INVALID", "Provider checkout URL is unsafe.", status_code=502) from exc
            checkout_host = (parsed.hostname or "").lower().rstrip(".")
            checkout_hosts = {
                str(item).strip().lower().rstrip(".")
                for item in (self.config.get("checkout_hosts", []) or [])
            }
            if (
                parsed.scheme != "https" or not checkout_host or parsed.username or parsed.password
                or checkout_port not in {None, 443} or parsed.fragment
                or checkout_host not in checkout_hosts
            ):
                raise GatewayError("PROVIDER_RESPONSE_INVALID", "Provider checkout URL is unsafe.", status_code=502)
        return AdapterResult(
            str(provider_id), str(status).upper(), checkout_url, canonical.get("qr_payload"),
            canonical.get("provider_reference"), redact(canonical),
        )

    async def health_check(self, context=None):
        started = time.monotonic()
        await self._request("health_check", {"probe": True})
        return {"status": "HEALTHY", "latency_ms": int((time.monotonic() - started) * 1000), "adapter": self.code}

    async def create_payin(self, request, idempotency_key):
        require_capability(set(self.capabilities), Capability.PAYIN)
        require_money(request.get("amount_minor"), request.get("currency"))
        self._required_text(request.get("reference"), "reference")
        self._require_idempotency(idempotency_key)
        return self._result("create_payin", await self._request("create_payin", request, idempotency_key))

    async def get_payin_status(self, provider_payment_id):
        require_capability(set(self.capabilities), Capability.PAYMENT_STATUS_QUERY)
        self._required_text(provider_payment_id, "provider_payment_id")
        return self._result("get_payin_status", await self._request("get_payin_status", {"provider_payment_id": provider_payment_id}))

    async def cancel_payin(self, provider_payment_id):
        require_capability(set(self.capabilities), Capability.CANCELLATION)
        self._required_text(provider_payment_id, "provider_payment_id")
        return self._result("cancel_payin", await self._request("cancel_payin", {"provider_payment_id": provider_payment_id}))

    async def refund_payin(self, request, idempotency_key):
        require_capability(set(self.capabilities), Capability.REFUND)
        require_money(request.get("amount_minor"), request.get("currency"))
        self._required_text(request.get("provider_payment_id"), "provider_payment_id")
        self._require_idempotency(idempotency_key)
        return self._result("refund_payin", await self._request("refund_payin", request, idempotency_key))

    async def get_refund_status(self, provider_refund_id):
        require_capability(set(self.capabilities), Capability.REFUND)
        self._required_text(provider_refund_id, "provider_refund_id")
        return self._result("get_refund_status", await self._request("get_refund_status", {"provider_refund_id": provider_refund_id}))

    async def create_payout(self, request, idempotency_key):
        require_capability(set(self.capabilities), Capability.PAYOUT)
        require_money(request.get("amount_minor"), request.get("currency"))
        self._required_text(request.get("withdrawal_id"), "withdrawal_id")
        self._required_text(request.get("provider_beneficiary_id"), "provider_beneficiary_id")
        self._require_idempotency(idempotency_key)
        return self._result("create_payout", await self._request("create_payout", request, idempotency_key))

    async def get_payout_status(self, provider_payout_id):
        require_capability(set(self.capabilities), Capability.PAYOUT_STATUS_QUERY)
        self._required_text(provider_payout_id, "provider_payout_id")
        return self._result("get_payout_status", await self._request("get_payout_status", {"provider_payout_id": provider_payout_id}))

    async def cancel_payout(self, provider_payout_id):
        require_capability(set(self.capabilities), Capability.CANCELLATION)
        self._required_text(provider_payout_id, "provider_payout_id")
        return self._result("cancel_payout", await self._request("cancel_payout", {"provider_payout_id": provider_payout_id}))

    async def fetch_settlements(self, request):
        require_capability(set(self.capabilities), Capability.SETTLEMENT_API)
        response = await self._request("fetch_settlements", request)
        path = str(((self.config.get("response_mapping", {}) or {}).get("fetch_settlements", {}) or {}).get("items", ""))
        items = _get_path(response, path, [])
        if not isinstance(items, list) or any(not isinstance(item, Mapping) for item in items):
            raise GatewayError("PROVIDER_RESPONSE_INVALID", "Provider settlement response must contain an item list.", status_code=502)
        return [redact(dict(item)) for item in items]

    async def fetch_disputes(self, request):
        require_capability(set(self.capabilities), Capability.DISPUTES)
        response = await self._request("fetch_disputes", request)
        path = str(((self.config.get("response_mapping", {}) or {}).get("fetch_disputes", {}) or {}).get("items", ""))
        items = _get_path(response, path, [])
        if not isinstance(items, list) or any(not isinstance(item, Mapping) for item in items):
            raise GatewayError("PROVIDER_RESPONSE_INVALID", "Provider dispute response must contain an item list.", status_code=502)
        return [redact(dict(item)) for item in items]

    def verify_webhook(self, headers, raw_body):
        config = self.config.get("webhook", {}) or {}
        if not raw_body or len(raw_body) > 1024 * 1024:
            raise GatewayError("WEBHOOK_TOO_LARGE", "Webhook body is empty or too large.", status_code=413)
        algorithm = str(config.get("algorithm", "")).lower()
        digest = hashlib.sha256 if algorithm == "hmac-sha256" else hashlib.sha512 if algorithm == "hmac-sha512" else None
        if digest is None:
            raise GatewayError("GATEWAY_CONFIG_INVALID", "Webhook signature algorithm is not supported.")
        lowered = {str(k).lower(): str(v) for k, v in headers.items()}
        timestamp = lowered.get(str(config.get("timestamp_header", "")).lower(), "")
        supplied = lowered.get(str(config.get("signature_header", "")).lower(), "")
        prefix = str(config.get("signature_prefix", ""))
        if prefix:
            if not supplied.startswith(prefix):
                raise GatewayError("WEBHOOK_SIGNATURE_INVALID", "Webhook verification failed.", status_code=401)
            supplied = supplied[len(prefix):]
        signature = supplied.lower()
        try:
            if abs(int(time.time()) - int(timestamp)) > int(config.get("replay_window_seconds")):
                raise ValueError
        except (TypeError, ValueError) as exc:
            raise GatewayError("WEBHOOK_REPLAY_REJECTED", "Webhook timestamp is invalid.", status_code=401) from exc
        expected = hmac.new(
            self._secret(config.get("credential_key"), "webhook secret", minimum=32).encode(),
            timestamp.encode() + b"." + raw_body, digest,
        ).hexdigest()
        if not hmac.compare_digest(signature.lower(), expected):
            raise GatewayError("WEBHOOK_SIGNATURE_INVALID", "Webhook verification failed.", status_code=401)

    def parse_webhook(self, headers, raw_body):
        self.verify_webhook(headers, raw_body)
        try:
            payload = json.loads(raw_body)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise GatewayError("WEBHOOK_PAYLOAD_INVALID", "Webhook payload is invalid.") from exc
        if not isinstance(payload, Mapping):
            raise GatewayError("WEBHOOK_PAYLOAD_INVALID", "Webhook payload must be an object.")
        mapping = self.config.get("webhook_mapping", {}) or {}
        event_id = _get_path(payload, str(mapping.get("event_id", "")))
        event_type = _get_path(payload, str(mapping.get("event_type", "")))
        object_id = _get_path(payload, str(mapping.get("object_id", "")))
        raw_status = _get_path(payload, str(mapping.get("status", "")))
        if any(
            not isinstance(value, str) or not value.strip() or len(value) > 160
            for value in (event_id, event_type, object_id, raw_status)
        ):
            raise GatewayError("WEBHOOK_PAYLOAD_INVALID", "Webhook identity or status is missing.")
        event_rule = (self.config.get("webhook_event_mapping", {}) or {}).get(event_type)
        if not isinstance(event_rule, Mapping):
            raise GatewayError("WEBHOOK_EVENT_UNSUPPORTED", "Webhook event type is not supported.", status_code=409)
        try:
            direction = Direction(str(event_rule.get("direction", "")).upper())
        except ValueError as exc:
            raise GatewayError("GATEWAY_CONFIG_INVALID", "Webhook event direction is invalid.") from exc
        canonical_event_type = str(event_rule.get("event_type", "")).strip().upper()
        if not canonical_event_type.startswith(f"{direction.value}."):
            raise GatewayError("GATEWAY_CONFIG_INVALID", "Webhook canonical event type is invalid.")
        normalized_status = (self.config.get("status_mapping", {}) or {}).get(raw_status.upper())
        if not normalized_status:
            raise GatewayError("WEBHOOK_PAYLOAD_INVALID", "Webhook status is not mapped.")
        normalized_status = str(normalized_status).upper()
        if normalized_status not in _DIRECTION_STATUSES[direction]:
            raise GatewayError("WEBHOOK_STATUS_DIRECTION_MISMATCH", "Webhook status does not match its direction.", status_code=409)
        amount = _get_path(payload, str(mapping.get("amount_minor", "")))
        currency = _get_path(payload, str(mapping.get("currency", "")))
        amount, currency = require_money(amount, currency)
        provider_reference = _get_path(payload, str(mapping.get("provider_reference", "")))
        if not isinstance(provider_reference, str) or not provider_reference.strip() or len(provider_reference) > 200:
            raise GatewayError("WEBHOOK_PAYLOAD_INVALID", "Webhook provider reference is missing.")
        canonical_payload = {
            "event_id": event_id,
            "event_type": canonical_event_type,
            "direction": direction.value,
            "object_id": object_id,
            "status": normalized_status,
            "amount_minor": amount,
            "currency": currency,
            "provider_reference": provider_reference,
        }
        return WebhookResult(
            event_id,
            canonical_event_type,
            direction.value,
            object_id,
            normalized_status,
            amount,
            currency,
            provider_reference,
            canonical_payload,
        )
