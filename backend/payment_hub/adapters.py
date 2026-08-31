from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import http.client
import ipaddress
import json
import socket
import ssl
import time
import urllib.error
import urllib.parse
from dataclasses import dataclass
from typing import Any, Mapping, Protocol

from .domain import Capability, GatewayError, PayinStatus, PayoutStatus, redact, require_capability, require_money


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


class MockSandboxAdapter(BaseAdapter):
    code = "MOCK_SANDBOX"
    capabilities = frozenset(Capability)

    def __init__(self, config: Mapping[str, Any] | None = None, secrets: Mapping[str, str] | None = None):
        self.config = dict(config or {})
        self.secrets = dict(secrets or {})
        self._payins: dict[str, dict[str, Any]] = {}
        self._payouts: dict[str, dict[str, Any]] = {}

    async def validate_config(self) -> None:
        scenario = str(self.config.get("scenario", "success")).lower()
        if scenario not in {"success", "pending", "failure", "timeout"}:
            raise GatewayError("GATEWAY_CONFIG_INVALID", "Unsupported mock scenario.")

    async def health_check(self, context=None):
        await self.validate_config()
        return {"status": "HEALTHY", "latency_ms": 0, "adapter": self.code}

    @staticmethod
    def _id(prefix: str, value: str) -> str:
        return f"{prefix}_{hashlib.sha256(value.encode()).hexdigest()[:24]}"

    def _scenario(self) -> str:
        return str(self.config.get("scenario", "success")).lower()

    async def _simulate(self):
        if self._scenario() == "timeout":
            raise GatewayError("PROVIDER_TIMEOUT", "Sandbox timeout.", retryable=True, status_code=503)
        if self._scenario() == "failure":
            raise GatewayError("PROVIDER_DECLINED", "Sandbox transaction declined.")

    async def create_payin(self, request, idempotency_key):
        require_money(request.get("amount_minor"), request.get("currency"))
        await self._simulate()
        provider_id = self._id("mock_payin", idempotency_key)
        status = PayinStatus.PENDING.value if self._scenario() == "pending" else PayinStatus.SUCCEEDED.value
        self._payins[provider_id] = {**dict(request), "status": status}
        return AdapterResult(provider_id, status, f"https://mock-payments.invalid/checkout/{provider_id}")

    async def get_payin_status(self, provider_payment_id):
        row = self._payins.get(provider_payment_id)
        if not row:
            raise GatewayError("PROVIDER_PAYMENT_NOT_FOUND", "Sandbox payment was not found.", status_code=404)
        return AdapterResult(provider_payment_id, row["status"], provider_reference=self._id("mock_ref", provider_payment_id))

    async def cancel_payin(self, provider_payment_id):
        row = self._payins.get(provider_payment_id)
        if not row:
            raise GatewayError("PROVIDER_PAYMENT_NOT_FOUND", "Sandbox payment was not found.", status_code=404)
        row["status"] = PayinStatus.CANCELLED.value
        return AdapterResult(provider_payment_id, row["status"])

    async def refund_payin(self, request, idempotency_key):
        refund_id = self._id("mock_refund", idempotency_key)
        return AdapterResult(refund_id, PayinStatus.REFUNDED.value, provider_reference=refund_id)

    async def get_refund_status(self, provider_refund_id):
        return AdapterResult(provider_refund_id, PayinStatus.REFUNDED.value, provider_reference=provider_refund_id)

    async def create_payout(self, request, idempotency_key):
        require_money(request.get("amount_minor"), request.get("currency"))
        await self._simulate()
        provider_id = self._id("mock_payout", idempotency_key)
        status = PayoutStatus.PROCESSING.value if self._scenario() != "pending" else PayoutStatus.QUEUED.value
        self._payouts[provider_id] = {**dict(request), "status": status}
        return AdapterResult(provider_id, status)

    async def get_payout_status(self, provider_payout_id):
        row = self._payouts.get(provider_payout_id)
        if not row:
            raise GatewayError("PROVIDER_PAYOUT_NOT_FOUND", "Sandbox payout was not found.", status_code=404)
        return AdapterResult(provider_payout_id, row["status"], provider_reference=provider_payout_id)

    async def cancel_payout(self, provider_payout_id):
        row = self._payouts.get(provider_payout_id)
        if not row:
            raise GatewayError("PROVIDER_PAYOUT_NOT_FOUND", "Sandbox payout was not found.", status_code=404)
        row["status"] = PayoutStatus.CANCELLED.value
        return AdapterResult(provider_payout_id, row["status"])

    def _webhook_secret(self) -> bytes:
        secret = str(self.secrets.get("webhook_secret", ""))
        if len(secret) < 32:
            raise GatewayError("GATEWAY_SECRET_INVALID", "Sandbox webhook secret is not configured.", status_code=503)
        return secret.encode()

    def sign_webhook(self, raw_body: bytes, timestamp: int | None = None) -> dict[str, str]:
        stamp = int(time.time() if timestamp is None else timestamp)
        digest = hmac.new(self._webhook_secret(), f"{stamp}.".encode() + raw_body, hashlib.sha256).hexdigest()
        return {"X-Payment-Timestamp": str(stamp), "X-Payment-Signature": f"sha256={digest}"}

    def verify_webhook(self, headers, raw_body):
        if len(raw_body) > 1024 * 1024:
            raise GatewayError("WEBHOOK_TOO_LARGE", "Webhook body is too large.", status_code=413)
        lowered = {str(k).lower(): str(v) for k, v in headers.items()}
        try:
            stamp = int(lowered.get("x-payment-timestamp", ""))
        except ValueError as exc:
            raise GatewayError("WEBHOOK_SIGNATURE_INVALID", "Webhook verification failed.", status_code=401) from exc
        if abs(int(time.time()) - stamp) > int(self.config.get("replay_window_seconds", 300)):
            raise GatewayError("WEBHOOK_REPLAY_REJECTED", "Webhook timestamp is outside the replay window.", status_code=401)
        supplied = lowered.get("x-payment-signature", "").removeprefix("sha256=")
        expected = hmac.new(self._webhook_secret(), f"{stamp}.".encode() + raw_body, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(supplied, expected):
            raise GatewayError("WEBHOOK_SIGNATURE_INVALID", "Webhook verification failed.", status_code=401)

    def parse_webhook(self, headers, raw_body):
        self.verify_webhook(headers, raw_body)
        try:
            payload = json.loads(raw_body)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise GatewayError("WEBHOOK_PAYLOAD_INVALID", "Webhook payload is invalid.") from exc
        required = ("id", "type", "object_id", "status")
        if not isinstance(payload, dict) or any(not isinstance(payload.get(key), str) for key in required):
            raise GatewayError("WEBHOOK_PAYLOAD_INVALID", "Webhook identity is invalid.")
        return WebhookResult(
            event_id=payload["id"][:160], event_type=payload["type"][:160],
            object_id=payload["object_id"][:160], status=payload["status"].upper(),
            amount_minor=payload.get("amount_minor"), currency=payload.get("currency"),
            provider_reference=payload.get("provider_reference"), sanitized_payload=redact(payload),
        )

    async def fetch_settlements(self, request):
        return [{"provider_settlement_id": self._id("mock_settlement", str(request)), "status": "MATCHED"}]

    async def fetch_disputes(self, request):
        return []


def _is_public_ip(address: str) -> bool:
    ip = ipaddress.ip_address(address)
    return not (ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified)


def _get_path(payload: Mapping[str, Any], path: str, default=None):
    current: Any = payload
    for part in path.split("."):
        if not part or not isinstance(current, Mapping) or part not in current:
            return default
        current = current[part]
    return current


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
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
            raise GatewayError("GATEWAY_CONFIG_INVALID", "Provider base URL must be credential-free HTTPS.")
        host = parsed.hostname.lower().rstrip(".")
        if not self.allowed_domains or not any(host == item or host.endswith(f".{item}") for item in self.allowed_domains):
            raise GatewayError("GATEWAY_DOMAIN_NOT_ALLOWED", "Provider domain is not approved.")
        try:
            addresses = await asyncio.to_thread(socket.getaddrinfo, host, parsed.port or 443, type=socket.SOCK_STREAM)
        except socket.gaierror as exc:
            raise GatewayError("GATEWAY_DNS_FAILED", "Provider host could not be resolved.", retryable=True) from exc
        if not addresses or any(not _is_public_ip(item[4][0]) for item in addresses):
            raise GatewayError("GATEWAY_SSRF_BLOCKED", "Provider address is not publicly routable.")
        endpoints = self.config.get("endpoints", {})
        if not isinstance(endpoints, Mapping):
            raise GatewayError("GATEWAY_CONFIG_INVALID", "Provider endpoints must be an object.")
        for name, path in endpoints.items():
            if not isinstance(path, str) or not path.startswith("/") or "//" in path or ".." in path:
                raise GatewayError("GATEWAY_CONFIG_INVALID", f"Endpoint {name} is invalid.")
        headers = self.config.get("headers", {}) or {}
        if not isinstance(headers, Mapping):
            raise GatewayError("GATEWAY_CONFIG_INVALID", "Provider headers must be an object.")
        forbidden_headers = {"authorization", "proxy-authorization", "cookie", "host"}
        if any(str(name).strip().lower() in forbidden_headers for name in headers):
            raise GatewayError("GATEWAY_CONFIG_INVALID", "Sensitive or transport headers must use the credential/auth configuration.")
        if any(not isinstance(value, str) or len(value) > 1000 for value in headers.values()):
            raise GatewayError("GATEWAY_CONFIG_INVALID", "Provider header values are invalid.")
        if not isinstance(self.config.get("status_mapping", {}), Mapping):
            raise GatewayError("GATEWAY_CONFIG_INVALID", "Status mapping must be an object.")

    def _auth_headers(self, body: bytes) -> dict[str, str]:
        auth = self.config.get("auth", {}) or {}
        strategy = str(auth.get("strategy", "none")).lower()
        if strategy == "none":
            return {}
        if strategy == "bearer":
            return {"Authorization": f"Bearer {self.secrets.get('api_token', '')}"}
        if strategy == "basic":
            token = base64.b64encode(f"{self.secrets.get('username', '')}:{self.secrets.get('password', '')}".encode()).decode()
            return {"Authorization": f"Basic {token}"}
        if strategy == "api_key_header":
            name = str(auth.get("header_name", "X-API-Key"))
            return {name: str(self.secrets.get("api_key", ""))}
        if strategy in {"hmac-sha256", "hmac-sha512"}:
            algorithm = hashlib.sha256 if strategy.endswith("256") else hashlib.sha512
            stamp = str(int(time.time()))
            signature = hmac.new(str(self.secrets.get("api_secret", "")).encode(), stamp.encode() + b"." + body, algorithm).hexdigest()
            return {str(auth.get("timestamp_header", "X-Timestamp")): stamp, str(auth.get("signature_header", "X-Signature")): signature}
        raise GatewayError("GATEWAY_CONFIG_INVALID", "Authentication strategy is not supported.")

    async def _request(self, operation: str, payload: Mapping[str, Any] | None = None, idempotency_key: str | None = None) -> Mapping[str, Any]:
        await self.validate_config()
        endpoint = (self.config.get("endpoints", {}) or {}).get(operation)
        if not endpoint:
            raise GatewayError("CAPABILITY_NOT_SUPPORTED", f"Provider operation {operation} is not configured.", status_code=409)
        body = json.dumps(dict(payload or {}), separators=(",", ":")).encode()
        headers = {"Content-Type": "application/json", "Accept": "application/json", **self._auth_headers(body)}
        headers.update({str(k): str(v) for k, v in (self.config.get("headers", {}) or {}).items()})
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
                connection.request("POST", path, body=body, headers={**headers, "Host": url.hostname})
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

    def _result(self, payload: Mapping[str, Any]) -> AdapterResult:
        mapping = self.config.get("response_mapping", {}) or {}
        provider_id = _get_path(payload, str(mapping.get("provider_id", "id")))
        raw_status = str(_get_path(payload, str(mapping.get("status", "status")), "")).upper()
        status = str((self.config.get("status_mapping", {}) or {}).get(raw_status, raw_status))
        if not provider_id or not status:
            raise GatewayError("PROVIDER_RESPONSE_INVALID", "Provider identity or status is missing.", status_code=502)
        return AdapterResult(str(provider_id), status, _get_path(payload, str(mapping.get("checkout_url", "checkout_url"))), _get_path(payload, str(mapping.get("qr_payload", "qr_payload"))), _get_path(payload, str(mapping.get("provider_reference", "provider_reference"))), redact(payload))

    async def health_check(self, context=None):
        started = time.monotonic()
        await self._request("health_check", {"probe": True})
        return {"status": "HEALTHY", "latency_ms": int((time.monotonic() - started) * 1000), "adapter": self.code}

    async def create_payin(self, request, idempotency_key):
        require_capability(set(self.capabilities), Capability.PAYIN)
        require_money(request.get("amount_minor"), request.get("currency"))
        return self._result(await self._request("create_payin", request, idempotency_key))

    async def get_payin_status(self, provider_payment_id):
        require_capability(set(self.capabilities), Capability.PAYMENT_STATUS_QUERY)
        return self._result(await self._request("get_payin_status", {"provider_payment_id": provider_payment_id}))

    async def cancel_payin(self, provider_payment_id):
        require_capability(set(self.capabilities), Capability.CANCELLATION)
        return self._result(await self._request("cancel_payin", {"provider_payment_id": provider_payment_id}))

    async def refund_payin(self, request, idempotency_key):
        require_capability(set(self.capabilities), Capability.REFUND)
        require_money(request.get("amount_minor"), request.get("currency"))
        return self._result(await self._request("refund_payin", request, idempotency_key))

    async def get_refund_status(self, provider_refund_id):
        require_capability(set(self.capabilities), Capability.REFUND)
        return self._result(await self._request("get_refund_status", {"provider_refund_id": provider_refund_id}))

    async def create_payout(self, request, idempotency_key):
        require_capability(set(self.capabilities), Capability.PAYOUT)
        require_money(request.get("amount_minor"), request.get("currency"))
        return self._result(await self._request("create_payout", request, idempotency_key))

    async def get_payout_status(self, provider_payout_id):
        require_capability(set(self.capabilities), Capability.PAYOUT_STATUS_QUERY)
        return self._result(await self._request("get_payout_status", {"provider_payout_id": provider_payout_id}))

    async def cancel_payout(self, provider_payout_id):
        require_capability(set(self.capabilities), Capability.CANCELLATION)
        return self._result(await self._request("cancel_payout", {"provider_payout_id": provider_payout_id}))

    async def fetch_settlements(self, request):
        require_capability(set(self.capabilities), Capability.SETTLEMENT_API)
        response = await self._request("fetch_settlements", request)
        path = str((self.config.get("response_mapping", {}) or {}).get("settlement_items", "items"))
        items = _get_path(response, path, [])
        if not isinstance(items, list) or any(not isinstance(item, Mapping) for item in items):
            raise GatewayError("PROVIDER_RESPONSE_INVALID", "Provider settlement response must contain an item list.", status_code=502)
        return [redact(dict(item)) for item in items]

    async def fetch_disputes(self, request):
        require_capability(set(self.capabilities), Capability.DISPUTES)
        response = await self._request("fetch_disputes", request)
        path = str((self.config.get("response_mapping", {}) or {}).get("dispute_items", "items"))
        items = _get_path(response, path, [])
        if not isinstance(items, list) or any(not isinstance(item, Mapping) for item in items):
            raise GatewayError("PROVIDER_RESPONSE_INVALID", "Provider dispute response must contain an item list.", status_code=502)
        return [redact(dict(item)) for item in items]

    def verify_webhook(self, headers, raw_body):
        config = self.config.get("webhook", {}) or {}
        algorithm = str(config.get("algorithm", "hmac-sha256")).lower()
        digest = hashlib.sha256 if algorithm == "hmac-sha256" else hashlib.sha512 if algorithm == "hmac-sha512" else None
        if digest is None:
            raise GatewayError("GATEWAY_CONFIG_INVALID", "Webhook signature algorithm is not supported.")
        lowered = {str(k).lower(): str(v) for k, v in headers.items()}
        timestamp = lowered.get(str(config.get("timestamp_header", "X-Timestamp")).lower(), "")
        signature = lowered.get(str(config.get("signature_header", "X-Signature")).lower(), "").split("=")[-1]
        try:
            if abs(int(time.time()) - int(timestamp)) > int(config.get("replay_window_seconds", 300)):
                raise ValueError
        except ValueError as exc:
            raise GatewayError("WEBHOOK_REPLAY_REJECTED", "Webhook timestamp is invalid.", status_code=401) from exc
        expected = hmac.new(str(self.secrets.get("webhook_secret", "")).encode(), timestamp.encode() + b"." + raw_body, digest).hexdigest()
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
        event_id = _get_path(payload, str(mapping.get("event_id", "id")))
        event_type = _get_path(payload, str(mapping.get("event_type", "type")))
        object_id = _get_path(payload, str(mapping.get("object_id", "object_id")))
        raw_status = _get_path(payload, str(mapping.get("status", "status")))
        if any(not isinstance(value, str) or not value.strip() for value in (event_id, event_type, object_id, raw_status)):
            raise GatewayError("WEBHOOK_PAYLOAD_INVALID", "Webhook identity or status is missing.")
        normalized_status = str((self.config.get("status_mapping", {}) or {}).get(raw_status.upper(), raw_status.upper()))
        return WebhookResult(
            event_id[:160],
            event_type[:160],
            object_id[:160],
            normalized_status,
            _get_path(payload, str(mapping.get("amount_minor", "amount_minor"))),
            _get_path(payload, str(mapping.get("currency", "currency"))),
            _get_path(payload, str(mapping.get("provider_reference", "provider_reference"))),
            redact(payload),
        )
