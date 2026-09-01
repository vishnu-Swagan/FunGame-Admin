from __future__ import annotations

import base64
import hashlib
import json
import ipaddress
import os
import re
import urllib.parse
import uuid
from datetime import timedelta
from typing import Any, Mapping

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from pymongo import ASCENDING, DESCENDING, ReturnDocument
from pymongo.errors import DuplicateKeyError

from db import db
from .domain import (
    Capability, Direction, GatewayError, HealthStatus, PayinStatus,
    ReconciliationStatus, WebhookStatus, redact,
    require_money, require_transition, utcnow,
)
from .registry import registry


GATEWAY_CODE = re.compile(r"^[A-Z][A-Z0-9_]{2,39}$")
_EMBEDDED_SECRET_KEY = re.compile(
    r"^(?:api[_-]?key|api[_-]?secret|authorization|bearer[_-]?token|client[_-]?secret|password|private[_-]?key|secret|token|webhook[_-]?secret)$",
    re.I,
)
TERMINAL_PAYIN = {item.value for item in (PayinStatus.SUCCEEDED, PayinStatus.FAILED, PayinStatus.CANCELLED, PayinStatus.EXPIRED, PayinStatus.REFUNDED, PayinStatus.REVERSED)}
WEBHOOK_PROCESSING_LEASE_SECONDS = 120


def enabled(name: str) -> bool:
    return str(os.environ.get(name, "false")).strip().lower() in {"1", "true", "yes", "on"}


def _public_webhook_base_url() -> str | None:
    """Return a credential-free public HTTPS origin, or ``None`` if invalid."""
    raw = str(os.environ.get("PAYMENT_WEBHOOK_PUBLIC_BASE_URL", "")).strip()
    if not raw:
        return None
    try:
        parsed = urllib.parse.urlsplit(raw)
        port = parsed.port
    except ValueError:
        return None
    if (
        parsed.scheme.lower() != "https" or not parsed.hostname or parsed.username
        or parsed.password or parsed.query or parsed.fragment or parsed.path not in {"", "/"}
    ):
        return None
    host = parsed.hostname.lower().rstrip(".")
    if host == "localhost" or host.endswith(".local"):
        return None
    ipv6 = False
    try:
        address = ipaddress.ip_address(host)
        if (
            address.is_private or address.is_loopback or address.is_link_local
            or address.is_reserved or address.is_multicast or address.is_unspecified
        ):
            return None
        ipv6 = address.version == 6
    except ValueError:
        try:
            host = host.encode("idna").decode("ascii")
        except UnicodeError:
            return None
        if (
            "." not in host or ".." in host
            or not re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?", host)
        ):
            return None
    authority_host = f"[{host}]" if ipv6 else host
    authority = authority_host if port in {None, 443} else f"{authority_host}:{port}"
    return f"https://{authority}"


def feature_status() -> dict[str, Any]:
    payments_v2 = enabled("PAYMENTS_V2_ENABLED")
    base_url = _public_webhook_base_url()
    provider = str(os.environ.get("PAYMENT_PROVIDER", "")).strip().lower()
    v1_provider_code = provider if re.fullmatch(r"[a-z][a-z0-9_-]{1,39}", provider) else None
    v1_webhook_url = (
        f"{base_url}/api/payments/webhooks/{urllib.parse.quote(provider, safe='')}"
        if base_url and v1_provider_code
        else None
    )
    return {
        "payments_v2": payments_v2,
        "admin": enabled("PAYMENT_GATEWAY_ADMIN_ENABLED"),
        "live_allowed": enabled("PAYMENT_LIVE_MODE_ALLOWED"),
        "installed_adapters": registry.codes(),
        "webhook_base_url": base_url,
        "v1_provider_code": v1_provider_code,
        "v1_webhook_url": v1_webhook_url,
    }


def require_admin_feature() -> None:
    if not enabled("PAYMENT_GATEWAY_ADMIN_ENABLED"):
        raise GatewayError("PAYMENT_GATEWAY_ADMIN_DISABLED", "Payment gateway administration is disabled.", status_code=404)


def require_payments_v2_activation() -> None:
    """Keep all activation paths unavailable while the hub is preview-only."""
    require_admin_feature()
    if not enabled("PAYMENTS_V2_ENABLED"):
        raise GatewayError(
            "PAYMENTS_V2_DISABLED",
            "Payment gateway activation requires PAYMENTS_V2_ENABLED in Render. Stored configuration and webhook URLs remain available.",
            status_code=404,
        )


def _master_key() -> bytes:
    raw = str(os.environ.get("PAYMENT_CREDENTIALS_MASTER_KEY", ""))
    try:
        key = base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4))
    except Exception as exc:  # noqa: BLE001 - normalized below
        raise GatewayError("PAYMENT_SECRET_STORE_NOT_READY", "Credential encryption is unavailable.", status_code=503) from exc
    if len(key) != 32:
        raise GatewayError("PAYMENT_SECRET_STORE_NOT_READY", "Credential encryption is unavailable.", status_code=503)
    return key


def _encrypt(gateway_id: str, name: str, value: str) -> dict[str, str]:
    nonce = os.urandom(12)
    aad = f"payment-gateway:{gateway_id}:{name}:v1".encode()
    ciphertext = AESGCM(_master_key()).encrypt(nonce, value.encode(), aad)
    return {
        "ciphertext": base64.urlsafe_b64encode(ciphertext).decode(),
        "nonce": base64.urlsafe_b64encode(nonce).decode(), "key_version": "v1",
    }


def _decrypt(row: Mapping[str, Any]) -> str:
    aad = f"payment-gateway:{row['gateway_id']}:{row['secret_key_name']}:{row['key_version']}".encode()
    try:
        return AESGCM(_master_key()).decrypt(
            base64.urlsafe_b64decode(row["nonce"]),
            base64.urlsafe_b64decode(row["ciphertext"]), aad,
        ).decode()
    except Exception as exc:  # noqa: BLE001
        raise GatewayError("PAYMENT_SECRET_DECRYPTION_FAILED", "Gateway credentials could not be decrypted.", status_code=503) from exc


# --- CRM operator parity ---------------------------------------------------
# The rollback CRM presents each stored provider grouped by a payment category
# and as either an automated integration or a manual/instructions method. These
# are presentation and stored-configuration concepts only: they never move money
# and are deliberately excluded from the gateway config hash so toggling them
# cannot invalidate a health check or reopen an activation approval.
PAYMENT_CATEGORIES = ("CARD", "CRYPTO", "EWALLET", "BANK", "OTHER")
PROVIDER_TYPES = ("AUTOMATED", "MANUAL")
LOCAL_AGENT_TYPES = ("CASH", "BANK", "UPI", "CARD", "OTHER")
GATEWAY_TOGGLES = (
    "deposits_enabled", "withdrawals_enabled",
    "auto_approve_deposits", "auto_approve_withdrawals",
)
MANUAL_CONFIG_KEYS = (
    "walletAddress", "qrImageUrl", "instructions",
    "bankName", "accountHolderName", "accountNumber", "swiftIban",
    "accountIdentifier",
)
AUTOMATED_CONFIG_KEYS = (
    "apiBaseUrl", "gatewayServer", "merchantId", "projectId", "orderCurrency",
    "allowedPayTokens", "orderValidMinutes",
)


def _derive_category(row: Mapping[str, Any]) -> str:
    explicit = str(row.get("category", "")).strip().upper()
    if explicit in PAYMENT_CATEGORIES:
        return explicit
    capabilities = {str(item).strip().upper() for item in row.get("capabilities", [])}
    if "BANK_TRANSFER" in capabilities:
        return "BANK"
    if capabilities & {"UPI", "WALLET"}:
        return "EWALLET"
    if "CARD" in capabilities:
        return "CARD"
    return "CARD"


def _derive_provider_type(row: Mapping[str, Any]) -> str:
    explicit = str(row.get("provider_type", "")).strip().upper()
    return explicit if explicit in PROVIDER_TYPES else "AUTOMATED"


def _gateway_toggles(row: Mapping[str, Any]) -> dict[str, bool]:
    return {toggle: bool(row.get(toggle, False)) for toggle in GATEWAY_TOGGLES}


def _is_configured(provider_type: str, config: Mapping[str, Any], hints: Mapping[str, Any]) -> bool:
    if provider_type == "MANUAL":
        return any(str(config.get(key, "")).strip() for key in MANUAL_CONFIG_KEYS)
    return bool(str(config.get("apiBaseUrl", "")).strip()) and bool(hints)


def gateway_dto(row: Mapping[str, Any]) -> dict[str, Any]:
    allowed = {
        "id", "code", "display_name", "adapter_type", "environment", "status",
        "merchant_reference_masked", "base_url", "capabilities", "non_secret_config",
        "health_status", "last_health_check_at", "last_success_at", "last_failure_at",
        "consecutive_failure_count", "last_error_code", "last_error_summary", "is_enabled",
        "created_at", "updated_at", "version", "credential_hints",
    }
    result = redact({
        key: value for key, value in row.items()
        if key in allowed and key not in {"non_secret_config", "credential_hints"}
    })
    public_config = _public_non_secret_config(row.get("non_secret_config", {}))
    result["non_secret_config"] = public_config
    hints = row.get("credential_hints", {}) or {}
    result["credential_hints"] = {
        str(key): str(value)[:20] for key, value in hints.items()
        if re.fullmatch(r"[a-z][a-z0-9_]{1,63}", str(key))
    }
    base_url = _public_webhook_base_url()
    code = str(row.get("code", "")).strip().upper()
    result["webhook_url"] = (
        f"{base_url}/api/webhooks/payments/{urllib.parse.quote(code, safe='')}"
        if base_url and GATEWAY_CODE.fullmatch(code) else None
    )
    # Read-only origin verification URL a provider dashboard can echo back to
    # confirm the callback origin. It carries no credential and, like the
    # webhook URL, is copyable while PAYMENTS_V2_ENABLED remains false.
    result["origin_verification_url"] = (
        f"{base_url}/api/webhooks/payments/{urllib.parse.quote(code, safe='')}/origin"
        if base_url and GATEWAY_CODE.fullmatch(code) else None
    )
    provider_type = _derive_provider_type(row)
    result["category"] = _derive_category(row)
    result["provider_type"] = provider_type
    result["mode"] = "LIVE" if str(row.get("environment", "")).upper() == "LIVE" else "SANDBOX"
    result["connection_tested"] = str(row.get("health_status", "")).upper() == HealthStatus.HEALTHY.value
    result["configured"] = _is_configured(provider_type, public_config, result["credential_hints"])
    result.update(_gateway_toggles(row))
    countries = row.get("countries") or public_config.get("countries") or []
    if isinstance(countries, str):
        countries = [item.strip().upper() for item in countries.split(",") if item.strip()]
    else:
        countries = [str(item).strip().upper() for item in countries if str(item).strip()]
    description = str(row.get("description") or public_config.get("description") or "")
    last_tested = row.get("last_health_check_at") or row.get("last_success_at")
    last_status = "PASS" if result["connection_tested"] else (
        str(row.get("health_status") or "UNKNOWN").upper() if row.get("last_health_check_at") else "NOT_TESTED"
    )
    # CRM rollback aliases (camelCase). Snake_case fields above stay canonical.
    result.update({
        "name": result.get("display_name"),
        "integrationMode": provider_type,
        "depositEnabled": result["deposits_enabled"],
        "withdrawalEnabled": result["withdrawals_enabled"],
        "depositAutoApprove": result["auto_approve_deposits"],
        "withdrawalAutoApprove": result["auto_approve_withdrawals"],
        "sandboxMode": result["mode"] != "LIVE",
        "configuration": public_config,
        "webhookUrl": result.get("webhook_url"),
        "originVerificationUrl": result.get("origin_verification_url"),
        "countries": countries,
        "description": description,
        "slug": code,
        "lastTestStatus": last_status,
        "lastTestedAt": last_tested,
        "secrets": {
            key: {"configured": True} for key in result["credential_hints"]
        },
    })
    return result


def _non_secret_config(value: Any) -> dict[str, Any]:
    """Validate and copy CRM config without corrupting safe signature metadata."""
    if not isinstance(value, Mapping):
        raise GatewayError("GATEWAY_CONFIG_INVALID", "Non-secret gateway configuration must be an object.")
    try:
        encoded = json.dumps(value, separators=(",", ":"), ensure_ascii=True)
    except (TypeError, ValueError) as exc:
        raise GatewayError("GATEWAY_CONFIG_INVALID", "Gateway configuration must contain JSON values only.") from exc
    if len(encoded.encode()) > 64 * 1024:
        raise GatewayError("GATEWAY_CONFIG_INVALID", "Gateway configuration is too large.")
    copied = json.loads(encoded)
    static_headers = copied.get("headers")
    if static_headers not in (None, {}):
        raise GatewayError(
            "GATEWAY_CONFIG_INVALID",
            "Static provider headers are not supported; use the encrypted credential store.",
        )
    copied.pop("headers", None)

    def inspect(item: Any, depth: int = 0) -> None:
        if depth > 12:
            raise GatewayError("GATEWAY_CONFIG_INVALID", "Gateway configuration is too deeply nested.")
        if isinstance(item, Mapping):
            for key, child in item.items():
                if _EMBEDDED_SECRET_KEY.fullmatch(str(key)):
                    raise GatewayError(
                        "GATEWAY_CONFIG_INVALID",
                        "Credential values must use the encrypted credential store.",
                    )
                inspect(child, depth + 1)
        elif isinstance(item, list):
            for child in item:
                inspect(child, depth + 1)

    inspect(copied)
    return copied


def _public_non_secret_config(value: Any) -> dict[str, Any]:
    """Return CRM-safe config while hiding any legacy static-header or secret values."""
    if not isinstance(value, Mapping):
        return {}

    def scrub(item: Any, depth: int = 0) -> Any:
        if depth > 12:
            return None
        if isinstance(item, Mapping):
            result = {}
            for key, child in item.items():
                name = str(key)
                if name.lower() == "headers" or _EMBEDDED_SECRET_KEY.fullmatch(name):
                    continue
                result[name] = scrub(child, depth + 1)
            return result
        if isinstance(item, list):
            return [scrub(child, depth + 1) for child in item]
        return item

    return _non_secret_config(scrub(value))


def _credential_epoch(row: Mapping[str, Any]) -> int:
    """Return the monotonic secret-set version, including legacy rows."""
    try:
        return max(0, int(row.get("credential_epoch", 0)))
    except (TypeError, ValueError):
        return 0


def _gateway_config_hash(row: Mapping[str, Any]) -> str:
    """Hash every persisted field that can change provider behaviour."""
    canonical = {
        "code": str(row.get("code", "")).strip().upper(),
        "display_name": str(row.get("display_name", "")),
        "adapter_type": str(row.get("adapter_type", "")).strip().upper(),
        "environment": str(row.get("environment", "")).strip().upper(),
        "merchant_reference_masked": str(row.get("merchant_reference_masked", "")),
        "base_url": str(row.get("base_url", "")),
        "capabilities": sorted(str(item) for item in row.get("capabilities", [])),
        "non_secret_config": _non_secret_config(row.get("non_secret_config", {})),
    }
    encoded = json.dumps(canonical, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(encoded.encode()).hexdigest()


def _gateway_binding(row: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "target_version": int(row.get("version", 1)),
        "target_credential_epoch": _credential_epoch(row),
        "target_config_hash": _gateway_config_hash(row),
    }


def _epoch_filter(expected_epoch: int) -> dict[str, Any]:
    if expected_epoch == 0:
        return {"$or": [
            {"credential_epoch": 0},
            {"credential_epoch": {"$exists": False}},
        ]}
    return {"credential_epoch": expected_epoch}


async def _expire_activation_approvals(
    gateway_id: str, actor_id: str, reason: str,
) -> None:
    expired_at = utcnow()
    result = await db.approval_requests.update_many(
        {
            "action_type": "GATEWAY_ACTIVATION",
            "target_type": "PAYMENT_GATEWAY",
            "target_id": gateway_id,
            "status": "PENDING",
        },
        {"$set": {
            "status": "EXPIRED",
            "expired_at": expired_at,
            "expiration_reason": reason,
        }},
    )
    if result.modified_count:
        await audit(
            actor_id, "GATEWAY_ACTIVATION_APPROVALS_EXPIRED",
            "PAYMENT_GATEWAY", gateway_id,
            metadata={"reason": reason, "count": result.modified_count},
        )


async def audit(actor_id: str, event_type: str, target_type: str, target_id: str, *, before=None, after=None, metadata=None, correlation_id=None) -> None:
    await db.activity_events.insert_one({
        "id": str(uuid.uuid4()), "event_type": event_type, "actor_type": "ADMIN",
        "actor_id": actor_id, "target_type": target_type, "target_id": target_id,
        "before_snapshot": redact(before), "after_snapshot": redact(after),
        "metadata": redact(metadata), "correlation_id": correlation_id or str(uuid.uuid4()),
        "occurred_at": utcnow(), "retention_class": "FINANCIAL_AUDIT",
    })


async def ensure_indexes() -> None:
    await db.payment_gateways.create_index("id", unique=True, name="payment_gateway_id_unique")
    await db.payment_gateways.create_index("code", unique=True, name="payment_gateway_code_unique")
    await db.payment_gateway_secrets.create_index([("gateway_id", ASCENDING), ("secret_key_name", ASCENDING), ("status", ASCENDING)], name="gateway_secret_lookup")
    await db.payment_gateway_secrets.create_index([("gateway_id", ASCENDING), ("secret_key_name", ASCENDING)], unique=True, partialFilterExpression={"status": "ACTIVE"}, name="gateway_active_secret_unique")
    await db.payment_routes.create_index("id", unique=True, name="payment_route_id_unique")
    await db.payment_routes.create_index([("direction", 1), ("payment_method", 1), ("currency", 1), ("is_enabled", 1), ("priority", 1)], name="payment_route_selection")
    await db.payment_orders_v2.create_index("id", unique=True, name="payment_order_v2_id_unique")
    await db.payment_orders_v2.create_index("public_reference", unique=True, name="payment_order_v2_public_unique")
    await db.payment_orders_v2.create_index([("operation_scope", 1), ("idempotency_key", 1)], unique=True, name="payment_order_v2_idempotency_unique")
    await db.payment_orders_v2.create_index([("gateway_id", 1), ("provider_payment_id", 1)], unique=True, partialFilterExpression={"provider_payment_id": {"$type": "string"}}, name="payment_order_v2_provider_unique")
    await db.webhook_events_v2.create_index([("gateway_id", 1), ("provider_event_id", 1)], unique=True, name="webhook_v2_event_unique")
    await db.webhook_events_v2.create_index([("processing_status", 1), ("next_retry_at", 1)], name="webhook_v2_retry")
    await db.approval_requests.create_index("id", unique=True, name="approval_request_id_unique")
    await db.approval_requests.create_index([("target_type", 1), ("target_id", 1), ("status", 1)], name="approval_target_status")
    await db.activity_events.create_index("id", unique=True, name="activity_event_id_unique")
    await db.activity_events.create_index([("occurred_at", DESCENDING), ("event_type", 1)], name="activity_event_timeline")
    await db.reconciliation_cases.create_index("id", unique=True, name="reconciliation_case_id_unique")
    await db.reconciliation_cases.create_index([("status", 1), ("created_at", -1)], name="reconciliation_status_created")
    await db.settlements.create_index([("gateway_id", 1), ("provider_settlement_id", 1)], unique=True, name="settlement_provider_unique")
    await db.settlement_imports.create_index([("gateway_id", 1), ("source_file_checksum", 1)], unique=True, name="settlement_file_checksum_unique")
    await db.payment_local_agents.create_index("id", unique=True, name="payment_local_agent_id_unique")
    await db.payment_local_agents.create_index([("country_code", ASCENDING), ("agent_type", ASCENDING)], name="payment_local_agent_lookup")
    await db.payment_platform_settings.create_index("id", unique=True, name="payment_platform_settings_id_unique")


async def create_gateway(payload: Mapping[str, Any], actor_id: str) -> dict[str, Any]:
    require_admin_feature()
    code = str(payload.get("code", "")).strip().upper()
    adapter_type = str(payload.get("adapter_type", "")).strip().upper()
    environment = str(payload.get("environment", "SANDBOX")).strip().upper()
    if not GATEWAY_CODE.fullmatch(code) or adapter_type not in registry.codes() or environment not in {"SANDBOX", "LIVE"}:
        raise GatewayError("GATEWAY_CONFIG_INVALID", "Gateway identity or adapter is invalid.")
    capabilities = sorted({Capability(item).value for item in payload.get("capabilities", [])})
    category = str(payload.get("category", "")).strip().upper()
    if category and category not in PAYMENT_CATEGORIES:
        raise GatewayError("GATEWAY_CONFIG_INVALID", "Payment category is invalid.")
    provider_type = str(payload.get("provider_type", "")).strip().upper()
    if provider_type and provider_type not in PROVIDER_TYPES:
        raise GatewayError("GATEWAY_CONFIG_INVALID", "Provider type is invalid.")
    now = utcnow()
    row = {
        "id": str(uuid.uuid4()), "code": code,
        "display_name": str(payload.get("display_name", code)).strip()[:100],
        "adapter_type": adapter_type, "environment": environment, "status": "DRAFT",
        "merchant_reference_masked": str(payload.get("merchant_reference_masked", ""))[:80],
        "base_url": str(payload.get("base_url", ""))[:500], "capabilities": capabilities,
        "non_secret_config": _non_secret_config(payload.get("non_secret_config", {})),
        "health_status": HealthStatus.UNKNOWN.value, "consecutive_failure_count": 0,
        "is_enabled": False, "created_by_admin_id": actor_id, "updated_by_admin_id": actor_id,
        "created_at": now, "updated_at": now, "version": 1,
        "credential_epoch": 0, "credential_hints": {},
        # CRM operator-parity presentation fields. Stored configuration only;
        # they never authorize a wallet credit or debit.
        "category": category or _derive_category({"capabilities": capabilities}),
        "provider_type": provider_type or "AUTOMATED",
        "deposits_enabled": bool(payload.get("deposits_enabled", False)),
        "withdrawals_enabled": bool(payload.get("withdrawals_enabled", False)),
        "auto_approve_deposits": False,
        "auto_approve_withdrawals": False,
    }
    try:
        await db.payment_gateways.insert_one(row)
    except DuplicateKeyError as exc:
        raise GatewayError("GATEWAY_CODE_EXISTS", "Gateway code already exists.", status_code=409) from exc
    await audit(actor_id, "GATEWAY_CREATED", "PAYMENT_GATEWAY", row["id"], after=gateway_dto(row))
    return row


async def update_gateway(gateway_id: str, payload: Mapping[str, Any], actor_id: str, expected_version: int) -> dict[str, Any]:
    require_admin_feature()
    current = await db.payment_gateways.find_one({"id": gateway_id})
    if not current:
        raise GatewayError("GATEWAY_NOT_FOUND", "Gateway was not found.", status_code=404)
    if current.get("status") == "ACTIVE":
        raise GatewayError("GATEWAY_ACTIVE_CONFIG_LOCKED", "Disable the gateway before changing configuration.", status_code=409)
    allowed = {"display_name", "base_url", "capabilities", "non_secret_config", "merchant_reference_masked"}
    updates = {key: payload[key] for key in allowed if key in payload}
    if "capabilities" in updates:
        updates["capabilities"] = sorted({Capability(item).value for item in updates["capabilities"]})
    if "non_secret_config" in updates:
        updates["non_secret_config"] = _non_secret_config(updates["non_secret_config"])
    updates.update({
        "updated_by_admin_id": actor_id,
        "updated_at": utcnow(),
        "health_status": HealthStatus.UNKNOWN.value,
        "consecutive_failure_count": 0,
        "last_error_code": None,
        "last_error_summary": None,
    })
    changed = await db.payment_gateways.find_one_and_update(
        {"id": gateway_id, "version": expected_version},
        {
            "$set": updates,
            "$unset": {
                "health_checked_version": "",
                "health_checked_credential_epoch": "",
                "health_checked_config_hash": "",
                "last_health_check_at": "",
                "last_success_at": "",
                "last_failure_at": "",
            },
            "$inc": {"version": 1},
        },
        return_document=ReturnDocument.AFTER,
    )
    if not changed:
        raise GatewayError("GATEWAY_VERSION_CONFLICT", "Gateway changed; refresh and retry.", status_code=409)
    await _expire_activation_approvals(gateway_id, actor_id, "GATEWAY_CONFIGURATION_CHANGED")
    await audit(actor_id, "GATEWAY_UPDATED", "PAYMENT_GATEWAY", gateway_id, before=gateway_dto(current), after=gateway_dto(changed))
    return changed


def normalize_crm_gateway_payload(payload: Mapping[str, Any]) -> dict[str, Any]:
    """Accept the rollback-CRM camelCase body and return hub field names."""
    if not isinstance(payload, Mapping):
        return {}
    inner = payload.get("input") if isinstance(payload.get("input"), Mapping) else payload
    aliases = {
        "name": "display_name",
        "displayName": "display_name",
        "integrationMode": "provider_type",
        "depositEnabled": "deposits_enabled",
        "withdrawalEnabled": "withdrawals_enabled",
        "depositAutoApprove": "auto_approve_deposits",
        "withdrawalAutoApprove": "auto_approve_withdrawals",
        "configuration": "non_secret_config",
        "baseUrl": "base_url",
        "merchantReferenceMasked": "merchant_reference_masked",
    }
    normalized: dict[str, Any] = {}
    for key, value in inner.items():
        target = aliases.get(key, key)
        if target in {"currentPassword", "current_password", "secrets"}:
            continue
        normalized[target] = value
    if "sandboxMode" in inner:
        normalized["environment"] = "SANDBOX" if inner["sandboxMode"] else "LIVE"
    if isinstance(inner.get("countries"), list):
        normalized["countries"] = [
            str(item).strip().upper() for item in inner["countries"] if str(item).strip()
        ]
    elif isinstance(inner.get("countries"), str):
        normalized["countries"] = [
            item.strip().upper() for item in inner["countries"].split(",") if item.strip()
        ]
    if "description" in inner:
        normalized["description"] = str(inner.get("description") or "")[:500]
    secrets = inner.get("secrets") or payload.get("secrets")
    if isinstance(secrets, Mapping):
        secret_aliases = {
            "apiSecret": "api_secret",
            "webhookSecret": "webhook_secret",
            "authKey": "auth_key",
            "encryptionKey": "encryption_key",
        }
        extracted = {}
        for key, value in secrets.items():
            name = secret_aliases.get(str(key).strip(), str(key).strip())
            if isinstance(value, Mapping):
                raw = value.get("value")
            else:
                raw = value
            if raw:
                extracted[name] = str(raw)
        if extracted:
            normalized["_secrets"] = extracted
    return normalized


async def update_gateway_crm(gateway_id: str, payload: Mapping[str, Any], actor_id: str) -> dict[str, Any]:
    """Apply CRM operator changes to a stored provider.

    Handles the rollback-CRM controls: payment category, automated vs manual
    provider type, deposit/withdrawal enable toggles, auto-approve toggles, and
    the manual/automated non-secret configuration fields.

    Money never moves here. Enabling deposits/withdrawals or auto-approve only
    records operator intent; a live wallet credit/debit still requires the
    financial readiness flags enforced in :mod:`financial_wallet`. Auto-approve
    can only be turned on for an AUTOMATED provider that has a passing connection
    test and whose matching direction toggle is on. Provider-behaviour fields
    (base_url, capabilities, non_secret_config, display_name) may change only
    while the gateway is not ACTIVE, mirroring :func:`update_gateway`, and doing
    so resets the health check and expires pending activation approvals.
    """
    require_admin_feature()
    current = await db.payment_gateways.find_one({"id": gateway_id})
    if not current:
        raise GatewayError("GATEWAY_NOT_FOUND", "Gateway was not found.", status_code=404)

    updates: dict[str, Any] = {}
    reset_health = False

    if "category" in payload:
        category = str(payload["category"]).strip().upper()
        if category not in PAYMENT_CATEGORIES:
            raise GatewayError("GATEWAY_CONFIG_INVALID", "Payment category is invalid.")
        updates["category"] = category

    provider_type = _derive_provider_type(current)
    if "provider_type" in payload:
        provider_type = str(payload["provider_type"]).strip().upper()
        if provider_type not in PROVIDER_TYPES:
            raise GatewayError("GATEWAY_CONFIG_INVALID", "Provider type is invalid.")
        updates["provider_type"] = provider_type

    behaviour_keys = {
        "display_name", "base_url", "capabilities",
        "non_secret_config", "merchant_reference_masked", "environment",
    }
    if any(key in payload for key in behaviour_keys):
        if current.get("status") == "ACTIVE":
            raise GatewayError(
                "GATEWAY_ACTIVE_CONFIG_LOCKED",
                "Disable the gateway before changing configuration.",
                status_code=409,
            )
        reset_health = True
        if "display_name" in payload:
            updates["display_name"] = str(payload["display_name"]).strip()[:100]
        if "merchant_reference_masked" in payload:
            updates["merchant_reference_masked"] = str(payload["merchant_reference_masked"])[:80]
        if "base_url" in payload:
            updates["base_url"] = str(payload["base_url"])[:500]
        if "capabilities" in payload:
            updates["capabilities"] = sorted({Capability(item).value for item in payload["capabilities"]})
        if "non_secret_config" in payload:
            updates["non_secret_config"] = _non_secret_config(payload["non_secret_config"])
        if "environment" in payload:
            environment = str(payload["environment"]).strip().upper()
            if environment not in {"SANDBOX", "LIVE"}:
                raise GatewayError("GATEWAY_CONFIG_INVALID", "Gateway environment is invalid.")
            updates["environment"] = environment

    if "countries" in payload:
        updates["countries"] = [
            str(item).strip().upper()[:2] for item in (payload.get("countries") or [])
            if str(item).strip()
        ]
    if "description" in payload:
        updates["description"] = str(payload.get("description") or "")[:500]

    deposits_enabled = bool(current.get("deposits_enabled", False))
    withdrawals_enabled = bool(current.get("withdrawals_enabled", False))
    if "deposits_enabled" in payload:
        deposits_enabled = bool(payload["deposits_enabled"])
        updates["deposits_enabled"] = deposits_enabled
    if "withdrawals_enabled" in payload:
        withdrawals_enabled = bool(payload["withdrawals_enabled"])
        updates["withdrawals_enabled"] = withdrawals_enabled

    # A configuration change in this request invalidates the prior test, so
    # auto-approve cannot be enabled in the same call that alters behaviour.
    connection_tested = (
        not reset_health
        and str(current.get("health_status", "")).upper() == HealthStatus.HEALTHY.value
    )

    def _require_auto_approve(direction_enabled: bool) -> None:
        if provider_type != "AUTOMATED" or not connection_tested or not direction_enabled:
            raise GatewayError(
                "GATEWAY_AUTO_APPROVE_NOT_ALLOWED",
                "Auto-approve requires an automated provider with the matching "
                "direction enabled and a successful connection test.",
            )

    if "auto_approve_deposits" in payload and bool(payload["auto_approve_deposits"]):
        _require_auto_approve(deposits_enabled)
        updates["auto_approve_deposits"] = True
    elif "auto_approve_deposits" in payload:
        updates["auto_approve_deposits"] = False

    if "auto_approve_withdrawals" in payload and bool(payload["auto_approve_withdrawals"]):
        _require_auto_approve(withdrawals_enabled)
        updates["auto_approve_withdrawals"] = True
    elif "auto_approve_withdrawals" in payload:
        updates["auto_approve_withdrawals"] = False

    # Preserve the invariant: switching to manual, disabling a direction, or
    # changing behaviour clears any auto-approve that would otherwise linger on.
    final_auto_deposits = updates.get("auto_approve_deposits", bool(current.get("auto_approve_deposits", False)))
    if final_auto_deposits and (provider_type != "AUTOMATED" or not deposits_enabled or reset_health):
        updates["auto_approve_deposits"] = False
    final_auto_withdrawals = updates.get("auto_approve_withdrawals", bool(current.get("auto_approve_withdrawals", False)))
    if final_auto_withdrawals and (provider_type != "AUTOMATED" or not withdrawals_enabled or reset_health):
        updates["auto_approve_withdrawals"] = False

    if not updates:
        return current

    updates["updated_by_admin_id"] = actor_id
    updates["updated_at"] = utcnow()
    mongo_update: dict[str, Any] = {"$set": dict(updates), "$inc": {"version": 1}}
    if reset_health:
        mongo_update["$set"].update({
            "health_status": HealthStatus.UNKNOWN.value,
            "consecutive_failure_count": 0,
            "last_error_code": None,
            "last_error_summary": None,
        })
        mongo_update["$unset"] = {
            "health_checked_version": "", "health_checked_credential_epoch": "",
            "health_checked_config_hash": "", "last_health_check_at": "",
            "last_success_at": "", "last_failure_at": "",
        }
    changed = await db.payment_gateways.find_one_and_update(
        {"id": gateway_id, "version": int(current.get("version", 1))},
        mongo_update, return_document=ReturnDocument.AFTER,
    )
    if not changed:
        raise GatewayError("GATEWAY_VERSION_CONFLICT", "Gateway changed; refresh and retry.", status_code=409)
    if reset_health:
        await _expire_activation_approvals(gateway_id, actor_id, "GATEWAY_CONFIGURATION_CHANGED")
    await audit(actor_id, "GATEWAY_CRM_UPDATED", "PAYMENT_GATEWAY", gateway_id, before=gateway_dto(current), after=gateway_dto(changed))
    return changed


# --- Payment platform settings (CRM "Payment platform settings") -----------
_PLATFORM_SETTINGS_ID = "main"
_SAFE_RETURN_PATH = re.compile(r"^/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{0,255}$")


def _valid_return_page(value: str) -> bool:
    """Accept a site-relative path or a public https URL (CRM return pages)."""
    if _SAFE_RETURN_PATH.fullmatch(value):
        return True
    try:
        parsed = urllib.parse.urlsplit(value)
    except ValueError:
        return False
    return (
        parsed.scheme.lower() == "https"
        and bool(parsed.hostname)
        and not parsed.username
        and not parsed.password
        and len(value) <= 500
    )


def platform_settings_dto(row: Mapping[str, Any] | None) -> dict[str, Any]:
    row = row or {}
    return_pages = row.get("return_pages") or row.get("returnPages") or {}
    success = str(
        return_pages.get("success_path")
        or return_pages.get("successPath")
        or "/play/wallet"
    )
    failure = str(
        return_pages.get("failure_path")
        or return_pages.get("failurePath")
        or "/play/wallet"
    )
    deposits = bool(row.get("deposits_enabled", False))
    withdrawals = bool(row.get("withdrawals_enabled", False))
    deposit_auto = bool(row.get("deposit_auto_approve", False))
    withdrawal_auto = bool(row.get("withdrawal_auto_approve", False))
    wallet = bool(row.get("wallet_to_wallet_enabled", False))
    return {
        "return_pages": {"success_path": success, "failure_path": failure},
        "deposits_enabled": deposits,
        "withdrawals_enabled": withdrawals,
        "deposit_auto_approve": deposit_auto,
        "withdrawal_auto_approve": withdrawal_auto,
        "wallet_to_wallet_enabled": wallet,
        "updated_at": row.get("updated_at"),
        # CRM aliases
        "returnPages": {"successPath": success, "failurePath": failure},
        "localSettings": {
            "depositsEnabled": deposits,
            "withdrawalsEnabled": withdrawals,
            "depositAutoApprove": deposit_auto,
            "withdrawalAutoApprove": withdrawal_auto,
        },
        "walletToWalletEnabled": wallet,
    }


async def get_platform_settings() -> dict[str, Any]:
    require_admin_feature()
    row = await db.payment_platform_settings.find_one({"id": _PLATFORM_SETTINGS_ID}, {"_id": 0})
    return platform_settings_dto(row)


async def update_platform_settings(payload: Mapping[str, Any], actor_id: str) -> dict[str, Any]:
    require_admin_feature()
    current = await db.payment_platform_settings.find_one({"id": _PLATFORM_SETTINGS_ID}, {"_id": 0})
    merged = platform_settings_dto(current)
    updates: dict[str, Any] = {}
    pages_in = payload.get("return_pages") or payload.get("returnPages")
    if isinstance(pages_in, Mapping):
        pages = dict(merged["return_pages"])
        mapping = {
            "success_path": pages_in.get("success_path", pages_in.get("successPath")),
            "failure_path": pages_in.get("failure_path", pages_in.get("failurePath")),
        }
        for key, value in mapping.items():
            if value is None:
                continue
            text = str(value).strip()
            if not _valid_return_page(text):
                raise GatewayError("PAYMENT_SETTINGS_INVALID", "Return pages must be a site-relative path or https URL.")
            pages[key] = text
        updates["return_pages"] = pages
    local = payload.get("localSettings") if isinstance(payload.get("localSettings"), Mapping) else {}
    flag_aliases = {
        "deposits_enabled": ("deposits_enabled", "depositsEnabled"),
        "withdrawals_enabled": ("withdrawals_enabled", "withdrawalsEnabled"),
        "deposit_auto_approve": ("deposit_auto_approve", "depositAutoApprove"),
        "withdrawal_auto_approve": ("withdrawal_auto_approve", "withdrawalAutoApprove"),
        "wallet_to_wallet_enabled": ("wallet_to_wallet_enabled", "walletToWalletEnabled"),
    }
    for dest, names in flag_aliases.items():
        if dest == "wallet_to_wallet_enabled":
            source = payload
        else:
            source = local if any(name in local for name in names) else payload
        for name in names:
            if name in source:
                updates[dest] = bool(source[name])
                break
    if not updates:
        return merged
    updates["updated_at"] = utcnow()
    updates["updated_by_admin_id"] = actor_id
    await db.payment_platform_settings.update_one(
        {"id": _PLATFORM_SETTINGS_ID},
        {"$set": updates, "$setOnInsert": {"id": _PLATFORM_SETTINGS_ID, "created_at": utcnow()}},
        upsert=True,
    )
    row = await db.payment_platform_settings.find_one({"id": _PLATFORM_SETTINGS_ID}, {"_id": 0})
    await audit(
        actor_id, "PAYMENT_PLATFORM_SETTINGS_UPDATED",
        "PAYMENT_PLATFORM_SETTINGS", _PLATFORM_SETTINGS_ID, after=platform_settings_dto(row),
    )
    return platform_settings_dto(row)


# --- Local deposit agents (CRM "Local deposits") ---------------------------
_COUNTRY_CODE = re.compile(r"^[A-Z]{2}$")


def local_agent_dto(row: Mapping[str, Any]) -> dict[str, Any]:
    show_details = bool(row.get("show_details") or row.get("showDetails") or False)
    raw_details = str(row.get("details", ""))
    agent_type = row.get("agent_type") or row.get("agentType")
    agent_name = row.get("agent_name") or row.get("agentName")
    country = row.get("country_code") or row.get("countryCode")
    deposit = bool(row.get("deposit_enabled", row.get("depositEnabled", False)))
    withdrawal = bool(row.get("withdrawal_enabled", row.get("withdrawalEnabled", False)))
    return {
        "id": row.get("id"),
        "agent_type": agent_type,
        "agent_name": agent_name,
        "country_code": country,
        "deposit_enabled": deposit,
        "withdrawal_enabled": withdrawal,
        "show_details": show_details,
        # Receiving details stay hidden unless the operator explicitly published them.
        "details": raw_details if show_details else None,
        "details_hidden": bool(raw_details.strip()) and not show_details,
        "details_configured": bool(raw_details.strip()),
        "created_at": row.get("created_at"),
        "agentType": agent_type,
        "agentName": agent_name,
        "countryCode": country,
        "depositEnabled": deposit,
        "withdrawalEnabled": withdrawal,
        "showDetails": show_details,
        "detailsConfigured": bool(raw_details.strip()) and show_details,
    }


async def list_local_agents() -> list[dict[str, Any]]:
    require_admin_feature()
    rows = await db.payment_local_agents.find({}, {"_id": 0}).sort("created_at", -1).to_list(500)
    return [local_agent_dto(row) for row in rows]


async def create_local_agent(payload: Mapping[str, Any], actor_id: str) -> dict[str, Any]:
    require_admin_feature()
    agent_type = str(payload.get("agent_type") or payload.get("agentType") or "").strip().upper()
    if agent_type not in LOCAL_AGENT_TYPES:
        raise GatewayError("PAYMENT_LOCAL_AGENT_INVALID", "Agent type is invalid.")
    agent_name = str(payload.get("agent_name") or payload.get("agentName") or "").strip()
    if not 2 <= len(agent_name) <= 120:
        raise GatewayError("PAYMENT_LOCAL_AGENT_INVALID", "Agent name is required.")
    country_code = str(payload.get("country_code") or payload.get("countryCode") or "").strip().upper()
    if not _COUNTRY_CODE.fullmatch(country_code):
        raise GatewayError("PAYMENT_LOCAL_AGENT_INVALID", "Country code must be a 2-letter ISO code.")
    row = {
        "id": str(uuid.uuid4()),
        "agent_type": agent_type,
        "agent_name": agent_name[:120],
        "country_code": country_code,
        "deposit_enabled": bool(payload.get("deposit_enabled", payload.get("depositEnabled", False))),
        "withdrawal_enabled": bool(payload.get("withdrawal_enabled", payload.get("withdrawalEnabled", False))),
        "show_details": bool(payload.get("show_details", payload.get("showDetails", False))),
        "details": str(payload.get("details", ""))[:2000],
        "created_by_admin_id": actor_id,
        "created_at": utcnow(),
    }
    await db.payment_local_agents.insert_one(row)
    await audit(
        actor_id, "PAYMENT_LOCAL_AGENT_CREATED",
        "PAYMENT_LOCAL_AGENT", row["id"], after=local_agent_dto(row),
    )
    return local_agent_dto(row)


async def delete_local_agent(agent_id: str, actor_id: str) -> dict[str, Any]:
    require_admin_feature()
    row = await db.payment_local_agents.find_one({"id": agent_id})
    if not row:
        raise GatewayError("PAYMENT_LOCAL_AGENT_NOT_FOUND", "Local deposit agent was not found.", status_code=404)
    await db.payment_local_agents.delete_one({"id": agent_id})
    await audit(
        actor_id, "PAYMENT_LOCAL_AGENT_DELETED",
        "PAYMENT_LOCAL_AGENT", agent_id, before=local_agent_dto(row),
    )
    return {"id": agent_id, "deleted": True}


async def store_credentials(gateway_id: str, values: Mapping[str, str], actor_id: str) -> dict[str, Any]:
    require_admin_feature()
    gateway = await db.payment_gateways.find_one({"id": gateway_id})
    if not gateway:
        raise GatewayError("GATEWAY_NOT_FOUND", "Gateway was not found.", status_code=404)
    if gateway.get("status") == "ACTIVE" or gateway.get("is_enabled") is True:
        raise GatewayError(
            "GATEWAY_ACTIVE_CREDENTIALS_LOCKED",
            "Disable the gateway before rotating credentials, then test and approve it again.",
            status_code=409,
        )
    if not values or any(not re.fullmatch(r"[a-z][a-z0-9_]{1,63}", str(name)) or not isinstance(value, str) or not value for name, value in values.items()):
        raise GatewayError("GATEWAY_SECRET_INVALID", "Credential names or values are invalid.")
    now = utcnow()
    hints = dict(gateway.get("credential_hints", {}))
    expected_version = int(gateway.get("version", 1))
    expected_epoch = _credential_epoch(gateway)
    rotation_id = str(uuid.uuid4())
    locked = await db.payment_gateways.find_one_and_update(
        {
            "id": gateway_id,
            "version": expected_version,
            "status": {"$ne": "ACTIVE"},
            "is_enabled": {"$ne": True},
            "credential_rotation_id": {"$exists": False},
            **_epoch_filter(expected_epoch),
        },
        {
            "$set": {
                "credential_rotation_id": rotation_id,
                "credential_rotation_status": "IN_PROGRESS",
                "credential_rotation_started_at": now,
                "health_status": HealthStatus.UNKNOWN.value,
                "consecutive_failure_count": 0,
                "last_error_code": None,
                "last_error_summary": None,
                "updated_at": now,
                "updated_by_admin_id": actor_id,
            },
            "$unset": {
                "health_checked_version": "",
                "health_checked_credential_epoch": "",
                "health_checked_config_hash": "",
                "last_health_check_at": "",
                "last_success_at": "",
                "last_failure_at": "",
            },
        },
        return_document=ReturnDocument.AFTER,
    )
    if not locked:
        raise GatewayError(
            "GATEWAY_VERSION_CONFLICT",
            "Gateway changed; refresh and retry credential rotation.",
            status_code=409,
        )
    await _expire_activation_approvals(gateway_id, actor_id, "GATEWAY_CREDENTIALS_CHANGED")
    try:
        for name, value in values.items():
            encrypted = _encrypt(gateway_id, name, value)
            hint = f"••••{value[-4:]}" if len(value) >= 4 else "••••"
            await db.payment_gateway_secrets.insert_one({
                "id": str(uuid.uuid4()), "gateway_id": gateway_id,
                "secret_key_name": name, "credential_rotation_id": rotation_id,
                **encrypted, "masked_hint": hint, "created_at": now,
                "rotated_at": None, "created_by_admin_id": actor_id,
                "status": "STAGED",
            })
            hints[name] = hint

        names = list(values)
        await db.payment_gateway_secrets.update_many(
            {
                "gateway_id": gateway_id,
                "secret_key_name": {"$in": names},
                "status": "ACTIVE",
            },
            {"$set": {"status": "ROTATED", "rotated_at": now}},
        )
        activated = await db.payment_gateway_secrets.update_many(
            {
                "gateway_id": gateway_id,
                "credential_rotation_id": rotation_id,
                "status": "STAGED",
            },
            {"$set": {"status": "ACTIVE", "activated_at": utcnow()}},
        )
        if activated.modified_count != len(values):
            raise GatewayError(
                "GATEWAY_CREDENTIAL_ROTATION_INCOMPLETE",
                "Credential rotation did not publish one complete secret set.",
                status_code=409,
            )

        changed = await db.payment_gateways.find_one_and_update(
            {
                "id": gateway_id,
                "version": expected_version,
                "credential_rotation_id": rotation_id,
                "status": {"$ne": "ACTIVE"},
                "is_enabled": {"$ne": True},
                **_epoch_filter(expected_epoch),
            },
            {
                "$set": {
                    "credential_hints": hints,
                    "credential_epoch": expected_epoch + 1,
                    "updated_at": utcnow(),
                    "updated_by_admin_id": actor_id,
                },
                "$unset": {
                    "credential_rotation_id": "",
                    "credential_rotation_status": "",
                    "credential_rotation_started_at": "",
                },
                "$inc": {"version": 1},
            },
            return_document=ReturnDocument.AFTER,
        )
        if not changed:
            raise GatewayError(
                "GATEWAY_CREDENTIAL_ROTATION_INCOMPLETE",
                "Gateway changed while credentials were being rotated; it remains locked.",
                status_code=409,
            )
    except Exception as exc:
        await db.payment_gateways.update_one(
            {"id": gateway_id, "credential_rotation_id": rotation_id},
            {"$set": {
                "credential_rotation_status": "FAILED",
                "last_error_code": "GATEWAY_CREDENTIAL_ROTATION_INCOMPLETE",
                "last_error_summary": "Credential rotation is incomplete and requires operator recovery.",
            }},
        )
        if isinstance(exc, GatewayError):
            raise
        raise GatewayError(
            "GATEWAY_CREDENTIAL_ROTATION_INCOMPLETE",
            "Credential rotation failed closed and requires operator recovery.",
            status_code=409,
        ) from exc
    await audit(actor_id, "GATEWAY_CREDENTIALS_ROTATED", "PAYMENT_GATEWAY", gateway_id, metadata={"credential_names": sorted(values)})
    return {
        "gateway_id": gateway_id,
        "credential_hints": hints,
        "credential_epoch": expected_epoch + 1,
    }


async def _credentials(gateway_id: str) -> dict[str, str]:
    gateway = await db.payment_gateways.find_one({"id": gateway_id})
    if gateway and gateway.get("credential_rotation_id"):
        raise GatewayError(
            "GATEWAY_CREDENTIAL_ROTATION_IN_PROGRESS",
            "Credential rotation must finish before the gateway can be used or tested.",
            status_code=409,
        )
    expected_version = int(gateway.get("version", 1)) if gateway else None
    rows = await db.payment_gateway_secrets.find({"gateway_id": gateway_id, "status": "ACTIVE"}).to_list(100)
    current = await db.payment_gateways.find_one({"id": gateway_id})
    if (
        not current or current.get("credential_rotation_id")
        or int(current.get("version", 1)) != expected_version
    ):
        raise GatewayError(
            "GATEWAY_CREDENTIAL_VERSION_CONFLICT",
            "Gateway credentials changed while they were being loaded; retry after review.",
            status_code=409,
        )
    return {row["secret_key_name"]: _decrypt(row) for row in rows}


def _allowed_domains() -> set[str]:
    return {item.strip().lower() for item in os.environ.get("PAYMENT_PROVIDER_ALLOWED_DOMAINS", "").split(",") if item.strip()}


async def adapter_for(gateway: Mapping[str, Any], *, inbound_callback: bool = False):
    if (
        gateway.get("environment") == "LIVE"
        and not enabled("PAYMENT_LIVE_MODE_ALLOWED")
        and not inbound_callback
    ):
        raise GatewayError(
            "PAYMENT_LIVE_MODE_DISABLED",
            "Live gateway testing and traffic are disabled.",
            status_code=403,
        )
    config = _non_secret_config(gateway.get("non_secret_config", {}))
    if gateway.get("base_url"):
        config["base_url"] = gateway["base_url"]
    config.setdefault("capabilities", gateway.get("capabilities", []))
    return registry.create(gateway["adapter_type"], config, await _credentials(gateway["id"]), _allowed_domains())


async def test_gateway(gateway_id: str, actor_id: str) -> dict[str, Any]:
    gateway = await db.payment_gateways.find_one({"id": gateway_id})
    if not gateway:
        raise GatewayError("GATEWAY_NOT_FOUND", "Gateway was not found.", status_code=404)
    if gateway.get("credential_rotation_id"):
        raise GatewayError(
            "GATEWAY_CREDENTIAL_ROTATION_IN_PROGRESS",
            "Credential rotation must finish before testing.",
            status_code=409,
        )
    started = utcnow()
    tested_version = int(gateway.get("version", 1))
    tested_credential_epoch = _credential_epoch(gateway)
    tested_config_hash = _gateway_config_hash(gateway)
    binding_filter = {
        "id": gateway_id,
        "version": tested_version,
        "credential_rotation_id": {"$exists": False},
        **_epoch_filter(tested_credential_epoch),
    }
    try:
        result = dict(await (await adapter_for(gateway)).health_check({"gateway_id": gateway_id}))
        checked_at = utcnow()
        update = {
            "health_status": HealthStatus.HEALTHY.value,
            "health_checked_version": tested_version,
            "health_checked_credential_epoch": tested_credential_epoch,
            "health_checked_config_hash": tested_config_hash,
            "last_health_check_at": checked_at,
            "last_success_at": checked_at,
            "consecutive_failure_count": 0,
            "last_error_code": None,
            "last_error_summary": None,
        }
    except Exception as exc:  # noqa: BLE001
        normalized = exc if isinstance(exc, GatewayError) else GatewayError("GATEWAY_HEALTH_FAILED", "Gateway health check failed.", retryable=True)
        update = {"health_status": HealthStatus.DOWN.value, "last_health_check_at": utcnow(), "last_failure_at": utcnow(), "last_error_code": normalized.code, "last_error_summary": normalized.message}
        changed = await db.payment_gateways.update_one(
            binding_filter,
            {
                "$set": update,
                "$unset": {
                    "health_checked_version": "",
                    "health_checked_credential_epoch": "",
                    "health_checked_config_hash": "",
                },
                "$inc": {"consecutive_failure_count": 1},
            },
        )
        if changed.modified_count != 1:
            raise GatewayError(
                "GATEWAY_VERSION_CONFLICT",
                "Gateway changed while the health test was running; test it again.",
                status_code=409,
            ) from exc
        await audit(actor_id, "GATEWAY_TEST_FAILED", "PAYMENT_GATEWAY", gateway_id, metadata={"code": normalized.code})
        raise normalized
    changed = await db.payment_gateways.update_one(binding_filter, {"$set": update})
    if changed.modified_count != 1:
        raise GatewayError(
            "GATEWAY_VERSION_CONFLICT",
            "Gateway changed while the health test was running; test it again.",
            status_code=409,
        )
    result.update({
        "tested_at": started,
        "gateway_id": gateway_id,
        "tested_version": tested_version,
        "tested_credential_epoch": tested_credential_epoch,
        "tested_config_hash": tested_config_hash,
    })
    await audit(actor_id, "GATEWAY_TESTED", "PAYMENT_GATEWAY", gateway_id, metadata=result)
    return result


async def request_approval(action_type: str, target_type: str, target_id: str, actor_id: str, reason: str) -> dict[str, Any]:
    if action_type in {"GATEWAY_ACTIVATION", "PAYMENT_ROUTE_ACTIVATION"}:
        require_payments_v2_activation()
    now = utcnow()
    binding: dict[str, Any] = {}
    if action_type == "GATEWAY_ACTIVATION" and target_type == "PAYMENT_GATEWAY":
        gateway = await db.payment_gateways.find_one({"id": target_id})
        if not gateway:
            raise GatewayError("GATEWAY_NOT_FOUND", "Gateway was not found.", status_code=404)
        if gateway.get("credential_rotation_id"):
            raise GatewayError(
                "GATEWAY_CREDENTIAL_ROTATION_IN_PROGRESS",
                "Credential rotation must finish before requesting activation.",
                status_code=409,
            )
        binding = _gateway_binding(gateway)
    existing = await db.approval_requests.find_one({"action_type": action_type, "target_type": target_type, "target_id": target_id, "status": "PENDING"})
    if existing:
        if not binding or all(existing.get(key) == value for key, value in binding.items()):
            return existing
        await db.approval_requests.update_one(
            {"id": existing["id"], "status": "PENDING"},
            {"$set": {
                "status": "EXPIRED",
                "expired_at": now,
                "expiration_reason": "GATEWAY_BINDING_CHANGED",
            }},
        )
    row = {
        "id": str(uuid.uuid4()), "action_type": action_type,
        "target_type": target_type, "target_id": target_id,
        "requested_by": actor_id, "requested_at": now, "status": "PENDING",
        "required_approval_count": 1, "approved_by": [], "rejected_by": [],
        "reason": reason, "expires_at": now + timedelta(hours=24),
        "executed_at": None, "execution_reference": None,
        **binding,
    }
    await db.approval_requests.insert_one(row)
    await audit(actor_id, "APPROVAL_REQUESTED", target_type, target_id, metadata={"action_type": action_type, "reason": reason})
    return row


async def approve_activation(gateway_id: str, approval_id: str, actor_id: str) -> dict[str, Any]:
    require_payments_v2_activation()
    approval = await db.approval_requests.find_one({"id": approval_id, "target_id": gateway_id, "action_type": "GATEWAY_ACTIVATION", "status": "PENDING"})
    expires_at = approval.get("expires_at") if approval else None
    if expires_at is not None and expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=utcnow().tzinfo)
    if not approval or not expires_at or expires_at < utcnow():
        raise GatewayError("APPROVAL_NOT_AVAILABLE", "Approval request is unavailable.", status_code=409)
    if approval["requested_by"] == actor_id:
        raise GatewayError("MAKER_CHECKER_REQUIRED", "The requester cannot approve this action.", status_code=403)
    gateway = await db.payment_gateways.find_one({"id": gateway_id})
    if not gateway:
        raise GatewayError("GATEWAY_NOT_FOUND", "Gateway was not found.", status_code=404)
    if gateway.get("credential_rotation_id"):
        raise GatewayError(
            "GATEWAY_CREDENTIAL_ROTATION_IN_PROGRESS",
            "Credential rotation must finish before activation.",
            status_code=409,
        )
    if gateway.get("environment") == "LIVE" and not enabled("PAYMENT_LIVE_MODE_ALLOWED"):
        raise GatewayError("PAYMENT_LIVE_MODE_DISABLED", "Live gateway activation is disabled.", status_code=403)
    binding = _gateway_binding(gateway)
    if any(approval.get(key) != value for key, value in binding.items()):
        await db.approval_requests.update_one(
            {"id": approval_id, "status": "PENDING"},
            {"$set": {
                "status": "EXPIRED",
                "expired_at": utcnow(),
                "expiration_reason": "GATEWAY_BINDING_CHANGED",
            }},
        )
        raise GatewayError(
            "GATEWAY_APPROVAL_STALE",
            "Gateway configuration or credentials changed; request a new approval.",
            status_code=409,
        )
    if (
        gateway.get("health_status") != HealthStatus.HEALTHY.value
        or gateway.get("health_checked_version") != binding["target_version"]
        or gateway.get("health_checked_credential_epoch") != binding["target_credential_epoch"]
        or gateway.get("health_checked_config_hash") != binding["target_config_hash"]
    ):
        raise GatewayError("GATEWAY_NOT_HEALTHY", "Gateway must pass its health test before activation.", status_code=409)
    now = utcnow()
    claimed = await db.approval_requests.find_one_and_update(
        {"id": approval_id, "status": "PENDING"},
        {"$set": {"status": "EXECUTING", "execution_claimed_by": actor_id, "execution_claimed_at": now}},
        return_document=ReturnDocument.AFTER,
    )
    if not claimed:
        raise GatewayError("APPROVAL_ALREADY_DECIDED", "Approval was already decided.", status_code=409)
    changed = await db.payment_gateways.update_one(
        {
            "id": gateway_id,
            "status": {"$ne": "ACTIVE"},
            "version": binding["target_version"],
            "health_status": HealthStatus.HEALTHY.value,
            "health_checked_version": binding["target_version"],
            "health_checked_credential_epoch": binding["target_credential_epoch"],
            "health_checked_config_hash": binding["target_config_hash"],
            "credential_rotation_id": {"$exists": False},
            **_epoch_filter(binding["target_credential_epoch"]),
        },
        {
            "$set": {
                "status": "ACTIVE", "is_enabled": True,
                "updated_at": now, "updated_by_admin_id": actor_id,
            },
            "$inc": {"version": 1},
        },
    )
    if changed.modified_count != 1:
        await db.approval_requests.update_one(
            {"id": approval_id, "status": "EXECUTING", "execution_claimed_by": actor_id},
            {
                "$set": {
                    "status": "EXPIRED", "expired_at": utcnow(),
                    "expiration_reason": "GATEWAY_BINDING_CHANGED",
                },
                "$unset": {"execution_claimed_by": "", "execution_claimed_at": ""},
            },
        )
        raise GatewayError("GATEWAY_VERSION_CONFLICT", "Gateway changed; refresh and retry.", status_code=409)
    await db.approval_requests.update_one(
        {"id": approval_id, "status": "EXECUTING", "execution_claimed_by": actor_id},
        {"$set": {"status": "APPROVED", "approved_by": [actor_id], "executed_at": now, "execution_reference": gateway_id}, "$unset": {"execution_claimed_by": "", "execution_claimed_at": ""}},
    )
    await audit(actor_id, "GATEWAY_ACTIVATED", "PAYMENT_GATEWAY", gateway_id, metadata={"approval_id": approval_id})
    return await db.payment_gateways.find_one({"id": gateway_id})


async def disable_gateway(gateway_id: str, actor_id: str, reason: str) -> dict[str, Any]:
    row = await db.payment_gateways.find_one_and_update({"id": gateway_id}, {"$set": {"status": "DISABLED", "is_enabled": False, "health_status": HealthStatus.DISABLED.value, "updated_at": utcnow(), "updated_by_admin_id": actor_id}, "$inc": {"version": 1}}, return_document=ReturnDocument.AFTER)
    if not row:
        raise GatewayError("GATEWAY_NOT_FOUND", "Gateway was not found.", status_code=404)
    await audit(actor_id, "GATEWAY_DISABLED", "PAYMENT_GATEWAY", gateway_id, metadata={"reason": reason})
    return row


async def create_route(payload: Mapping[str, Any], actor_id: str) -> dict[str, Any]:
    gateway = await db.payment_gateways.find_one({"id": payload.get("gateway_id")})
    if not gateway:
        raise GatewayError("GATEWAY_NOT_FOUND", "Gateway was not found.", status_code=404)
    minimum = int(payload.get("min_amount_minor", 1))
    maximum = int(payload.get("max_amount_minor", 10**15))
    if minimum < 1 or maximum < minimum:
        raise GatewayError("PAYMENT_ROUTE_INVALID", "Route amount range is invalid.")
    row = {"id": str(uuid.uuid4()), "name": str(payload.get("name", "Route"))[:100], "direction": Direction(str(payload.get("direction", "PAYIN")).upper()).value, "payment_method": str(payload.get("payment_method", "ALL")).upper(), "currency": str(payload.get("currency", "INR")).upper(), "country_code": str(payload.get("country_code", "ALL")).upper(), "min_amount_minor": minimum, "max_amount_minor": maximum, "subject_type": str(payload.get("subject_type", "ALL")).upper(), "gateway_id": gateway["id"], "priority": max(0, int(payload.get("priority", 100))), "weight": max(1, min(10000, int(payload.get("weight", 100)))), "fallback_gateway_id": payload.get("fallback_gateway_id"), "is_enabled": False, "effective_from": payload.get("effective_from"), "effective_until": payload.get("effective_until"), "created_by_admin_id": actor_id, "approved_by_admin_id": None, "created_at": utcnow(), "updated_at": utcnow(), "version": 1}
    await db.payment_routes.insert_one(row)
    await audit(actor_id, "PAYMENT_ROUTE_CREATED", "PAYMENT_ROUTE", row["id"], after=row)
    return row


async def approve_route_activation(route_id: str, approval_id: str, actor_id: str) -> dict[str, Any]:
    require_payments_v2_activation()
    approval = await db.approval_requests.find_one({
        "id": approval_id,
        "target_id": route_id,
        "target_type": "PAYMENT_ROUTE",
        "action_type": "PAYMENT_ROUTE_ACTIVATION",
        "status": "PENDING",
    })
    expires_at = approval.get("expires_at") if approval else None
    if expires_at is not None and expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=utcnow().tzinfo)
    if not approval or not expires_at or expires_at < utcnow():
        raise GatewayError("APPROVAL_NOT_AVAILABLE", "Approval request is unavailable.", status_code=409)
    if approval["requested_by"] == actor_id:
        raise GatewayError("MAKER_CHECKER_REQUIRED", "The requester cannot approve this action.", status_code=403)
    route = await db.payment_routes.find_one({"id": route_id})
    if not route:
        raise GatewayError("PAYMENT_ROUTE_NOT_FOUND", "Payment route was not found.", status_code=404)
    gateway = await db.payment_gateways.find_one({"id": route["gateway_id"]})
    if not gateway or not gateway.get("is_enabled") or gateway.get("status") != "ACTIVE":
        raise GatewayError("GATEWAY_NOT_ACTIVE", "The route gateway must be active before this route can be enabled.", status_code=409)
    now = utcnow()
    claimed = await db.approval_requests.find_one_and_update(
        {"id": approval_id, "status": "PENDING"},
        {"$set": {"status": "EXECUTING", "execution_claimed_by": actor_id, "execution_claimed_at": now}},
        return_document=ReturnDocument.AFTER,
    )
    if not claimed:
        raise GatewayError("APPROVAL_ALREADY_DECIDED", "Approval was already decided.", status_code=409)
    activated = await db.payment_routes.find_one_and_update(
        {"id": route_id, "version": route.get("version", 1)},
        {"$set": {"is_enabled": True, "approved_by_admin_id": actor_id, "updated_at": now}, "$inc": {"version": 1}},
        return_document=ReturnDocument.AFTER,
    )
    if not activated:
        await db.approval_requests.update_one({"id": approval_id, "status": "EXECUTING", "execution_claimed_by": actor_id}, {"$set": {"status": "PENDING"}, "$unset": {"execution_claimed_by": "", "execution_claimed_at": ""}})
        raise GatewayError("PAYMENT_ROUTE_VERSION_CONFLICT", "Payment route changed; refresh and retry.", status_code=409)
    await db.approval_requests.update_one(
        {"id": approval_id, "status": "EXECUTING", "execution_claimed_by": actor_id},
        {"$set": {"status": "APPROVED", "approved_by": [actor_id], "executed_at": now, "execution_reference": route_id}, "$unset": {"execution_claimed_by": "", "execution_claimed_at": ""}},
    )
    await audit(actor_id, "PAYMENT_ROUTE_ACTIVATED", "PAYMENT_ROUTE", route_id, before=route, after=activated, metadata={"approval_id": approval_id})
    return activated


async def choose_gateway(request: Mapping[str, Any], correlation_id: str) -> dict[str, Any]:
    amount, currency = require_money(request.get("amount_minor"), request.get("currency"))
    direction = Direction(str(request.get("direction", "PAYIN")).upper()).value
    method = str(request.get("payment_method", "ALL")).upper()
    subject_type = str(request.get("subject_type", "USER")).upper()
    now = utcnow()
    routes = await db.payment_routes.find({"direction": direction, "currency": currency, "is_enabled": True, "min_amount_minor": {"$lte": amount}, "max_amount_minor": {"$gte": amount}, "payment_method": {"$in": [method, "ALL"]}, "subject_type": {"$in": [subject_type, "ALL"]}, "$and": [{"$or": [{"effective_from": None}, {"effective_from": {"$lte": now}}]}, {"$or": [{"effective_until": None}, {"effective_until": {"$gt": now}}]}]}).sort([("priority", 1), ("id", 1)]).to_list(200)
    eligible, excluded = [], []
    for route in routes:
        gateway = await db.payment_gateways.find_one({"id": route["gateway_id"]})
        live_blocked = (
            gateway and gateway.get("environment") == "LIVE"
            and not enabled("PAYMENT_LIVE_MODE_ALLOWED")
        )
        if not gateway or live_blocked or not gateway.get("is_enabled") or gateway.get("health_status") not in {HealthStatus.HEALTHY.value, HealthStatus.DEGRADED.value}:
            excluded.append({"route_id": route["id"], "gateway_id": route["gateway_id"], "reason": "GATEWAY_UNAVAILABLE"})
        else:
            eligible.append((route, gateway))
    if not eligible:
        raise GatewayError("PAYMENT_ROUTE_NOT_FOUND", "No eligible payment route is available.", status_code=503)
    best_priority = eligible[0][0]["priority"]
    pool = [(route, gateway) for route, gateway in eligible if route["priority"] == best_priority]
    total = sum(route["weight"] for route, _ in pool)
    pick = int(hashlib.sha256(correlation_id.encode()).hexdigest(), 16) % total
    selected = pool[-1]
    cursor = 0
    for item in pool:
        cursor += item[0]["weight"]
        if pick < cursor:
            selected = item
            break
    decision = {"id": str(uuid.uuid4()), "eligible_gateways": [gateway["id"] for _, gateway in eligible], "excluded_gateways": excluded, "selected_gateway_id": selected[1]["id"], "applied_route_id": selected[0]["id"], "fallback_gateway_id": selected[0].get("fallback_gateway_id"), "timestamp": now, "correlation_id": correlation_id}
    await db.payment_routing_decisions.insert_one(decision)
    return decision


async def process_webhook(gateway_code: str, headers: Mapping[str, str], raw_body: bytes) -> dict[str, Any]:
    gateway = await db.payment_gateways.find_one({"code": gateway_code.upper()})
    if not gateway or gateway.get("status") not in {"ACTIVE", "DISABLED"}:
        raise GatewayError("GATEWAY_NOT_FOUND", "Gateway was not found.", status_code=404)
    adapter = await adapter_for(gateway, inbound_callback=True)
    parsed = adapter.parse_webhook(headers, raw_body)
    order_lookup = {"gateway_id": gateway["id"], "provider_payment_id": parsed.object_id}
    order = await db.payment_orders_v2.find_one(order_lookup)
    traffic_disabled = (
        not gateway.get("is_enabled")
        or (
            gateway.get("environment") == "LIVE"
            and not enabled("PAYMENT_LIVE_MODE_ALLOWED")
        )
    )
    if traffic_disabled and not order:
        raise GatewayError(
            "PAYMENT_NOT_FOUND",
            "No existing payment order is bound to this callback.",
            status_code=404,
        )

    body_hash = hashlib.sha256(raw_body).hexdigest()
    canonical_payload = {
        "event_id": str(parsed.event_id),
        "event_type": str(parsed.event_type),
        "direction": str(parsed.direction),
        "object_id": str(parsed.object_id),
        "status": str(parsed.status),
        "amount_minor": parsed.amount_minor,
        "currency": parsed.currency,
        "provider_reference": parsed.provider_reference,
    }
    event = {
        "id": str(uuid.uuid4()),
        "gateway_id": gateway["id"],
        "provider_event_id": parsed.event_id,
        "provider_event_type": parsed.event_type,
        "body_hash": body_hash,
        "signature_valid": True,
        "normalized_event_type": parsed.event_type,
        "processing_status": WebhookStatus.RECEIVED.value,
        "payment_order_id": None,
        "received_at": utcnow(),
        "processed_at": None,
        "processing_started_at": None,
        "processing_claim_id": None,
        "processing_attempts": 0,
        "next_retry_at": None,
        "last_error_code": None,
        "last_error_summary": None,
        "correlation_id": str(uuid.uuid4()),
        "sanitized_payload": canonical_payload,
    }
    try:
        await db.webhook_events_v2.insert_one(event)
    except DuplicateKeyError:
        existing = await db.webhook_events_v2.find_one({"gateway_id": gateway["id"], "provider_event_id": parsed.event_id})
        if not existing:
            raise GatewayError(
                "WEBHOOK_EVENT_BUSY",
                "Webhook event is being registered; retry safely.",
                retryable=True,
                status_code=503,
            )
        if existing.get("body_hash") != body_hash:
            raise GatewayError("WEBHOOK_EVENT_CONFLICT", "Webhook event identity was reused with different content.", status_code=409)
        if existing.get("processing_status") in {
            WebhookStatus.PROCESSED.value,
            WebhookStatus.DEAD_LETTER.value,
            WebhookStatus.IGNORED.value,
            WebhookStatus.DUPLICATE.value,
            WebhookStatus.SIGNATURE_INVALID.value,
        }:
            return {
                "duplicate": True,
                "event_id": existing["id"],
                "processing_status": existing.get("processing_status"),
            }

    claim_started_at = utcnow()
    claim_id = str(uuid.uuid4())
    stale_before = claim_started_at - timedelta(seconds=WEBHOOK_PROCESSING_LEASE_SECONDS)
    event = await db.webhook_events_v2.find_one_and_update(
        {
            "gateway_id": gateway["id"],
            "provider_event_id": parsed.event_id,
            "body_hash": body_hash,
            "$or": [
                {"processing_status": WebhookStatus.RECEIVED.value},
                {
                    "processing_status": WebhookStatus.RETRY_PENDING.value,
                    "$or": [
                        {"next_retry_at": {"$lte": claim_started_at}},
                        {"next_retry_at": None},
                        {"next_retry_at": {"$exists": False}},
                    ],
                },
                {
                    "processing_status": WebhookStatus.PROCESSING.value,
                    "processing_started_at": {"$lte": stale_before},
                },
                {
                    "processing_status": WebhookStatus.PROCESSING.value,
                    "processing_started_at": None,
                },
            ],
        },
        {
            "$set": {
                "processing_status": WebhookStatus.PROCESSING.value,
                "processing_started_at": claim_started_at,
                "processing_claim_id": claim_id,
                "next_retry_at": None,
                "last_error_code": None,
                "last_error_summary": None,
            },
            "$inc": {"processing_attempts": 1},
        },
        return_document=ReturnDocument.AFTER,
    )
    if not event:
        existing = await db.webhook_events_v2.find_one({
            "gateway_id": gateway["id"], "provider_event_id": parsed.event_id,
        })
        if existing and existing.get("processing_status") in {
            WebhookStatus.PROCESSED.value,
            WebhookStatus.DEAD_LETTER.value,
            WebhookStatus.IGNORED.value,
            WebhookStatus.DUPLICATE.value,
            WebhookStatus.SIGNATURE_INVALID.value,
        }:
            return {
                "duplicate": True,
                "event_id": existing["id"],
                "processing_status": existing.get("processing_status"),
            }
        raise GatewayError(
            "WEBHOOK_EVENT_BUSY",
            "Webhook event is already being processed; retry safely.",
            retryable=True,
            status_code=503,
        )

    claim_filter = {
        "id": event["id"],
        "processing_status": WebhookStatus.PROCESSING.value,
        "processing_claim_id": claim_id,
    }

    async def finish_event(status: WebhookStatus, *, code: str | None = None, summary: str | None = None, retry_after: int | None = None) -> None:
        update: dict[str, Any] = {
            "processing_status": status.value,
            "processing_started_at": None,
            "processing_claim_id": None,
            "last_error_code": code,
            "last_error_summary": summary,
        }
        if status in {WebhookStatus.PROCESSED, WebhookStatus.DEAD_LETTER, WebhookStatus.IGNORED}:
            update["processed_at"] = utcnow()
            update["next_retry_at"] = None
        elif status == WebhookStatus.RETRY_PENDING:
            update["next_retry_at"] = utcnow() + timedelta(seconds=retry_after or 30)
        await db.webhook_events_v2.update_one(
            claim_filter,
            {"$set": update},
        )

    if not order:
        order = await db.payment_orders_v2.find_one(order_lookup)
    if not order:
        await finish_event(WebhookStatus.RETRY_PENDING, code="PAYMENT_NOT_FOUND", summary="Payment order was not found.")
        raise GatewayError("PAYMENT_NOT_FOUND", "Payment order was not found.", retryable=True, status_code=503)

    try:
        callback_direction = Direction(str(parsed.direction).upper())
        order_direction = Direction(str(order.get("direction", "")).upper())
    except ValueError:
        await finish_event(
            WebhookStatus.DEAD_LETTER,
            code="PAYMENT_DIRECTION_INVALID",
            summary="The callback or stored order has no valid direction.",
        )
        raise GatewayError("PAYMENT_DIRECTION_INVALID", "The payment direction is invalid.", status_code=409)
    if callback_direction != order_direction:
        await finish_event(
            WebhookStatus.DEAD_LETTER,
            code="PAYMENT_DIRECTION_MISMATCH",
            summary="Webhook direction does not match the order.",
        )
        raise GatewayError("PAYMENT_DIRECTION_MISMATCH", "Webhook direction does not match the order.", status_code=409)
    if not str(parsed.event_type).upper().startswith(f"{callback_direction.value}."):
        await finish_event(
            WebhookStatus.DEAD_LETTER,
            code="WEBHOOK_EVENT_DIRECTION_MISMATCH",
            summary="Webhook event type does not match its direction.",
        )
        raise GatewayError(
            "WEBHOOK_EVENT_DIRECTION_MISMATCH",
            "Webhook event type does not match its direction.",
            status_code=409,
        )
    if parsed.amount_minor is None or parsed.currency is None or not parsed.provider_reference:
        await finish_event(
            WebhookStatus.DEAD_LETTER,
            code="WEBHOOK_BINDING_INCOMPLETE",
            summary="Webhook omitted authoritative binding fields.",
        )
        raise GatewayError("WEBHOOK_BINDING_INCOMPLETE", "Webhook binding fields are incomplete.", status_code=409)
    bound_reference = str(order.get("provider_reference") or "").strip()
    if bound_reference and bound_reference != str(parsed.provider_reference):
        await finish_event(
            WebhookStatus.DEAD_LETTER,
            code="PAYMENT_PROVIDER_REFERENCE_MISMATCH",
            summary="Webhook provider reference does not match the order.",
        )
        raise GatewayError(
            "PAYMENT_PROVIDER_REFERENCE_MISMATCH",
            "Webhook provider reference does not match the order.",
            status_code=409,
        )
    if int(parsed.amount_minor) != int(order["amount_minor"]):
        await finish_event(WebhookStatus.DEAD_LETTER, code="PAYMENT_AMOUNT_MISMATCH", summary="Webhook amount does not match the order.")
        raise GatewayError("PAYMENT_AMOUNT_MISMATCH", "Webhook amount does not match the order.", status_code=409)
    if str(parsed.currency).upper() != order["currency"]:
        await finish_event(WebhookStatus.DEAD_LETTER, code="PAYMENT_CURRENCY_MISMATCH", summary="Webhook currency does not match the order.")
        raise GatewayError("PAYMENT_CURRENCY_MISMATCH", "Webhook currency does not match the order.", status_code=409)
    try:
        require_transition(order_direction, order["normalized_status"], parsed.status)
    except GatewayError as exc:
        await finish_event(WebhookStatus.DEAD_LETTER, code=exc.code, summary=exc.message)
        raise
    order_filter: dict[str, Any] = {
        "id": order["id"],
        "row_version": order["row_version"],
        "direction": order_direction.value,
        "provider_payment_id": parsed.object_id,
    }
    if bound_reference:
        order_filter["provider_reference"] = bound_reference
    else:
        order_filter["$or"] = [
            {"provider_reference": None},
            {"provider_reference": {"$exists": False}},
        ]
    changed = await db.payment_orders_v2.update_one(
        order_filter,
        {
            "$set": {
                "normalized_status": parsed.status,
                "provider_reference": parsed.provider_reference,
                "updated_at": utcnow(),
            },
            "$inc": {"row_version": 1},
        },
    )
    if changed.modified_count != 1:
        current = await db.payment_orders_v2.find_one({"id": order["id"]})
        if not current or any((
            current.get("normalized_status") != parsed.status,
            current.get("direction") != order_direction.value,
            current.get("provider_payment_id") != parsed.object_id,
            current.get("provider_reference") != parsed.provider_reference,
        )):
            await finish_event(WebhookStatus.RETRY_PENDING, code="PAYMENT_VERSION_CONFLICT", summary="Payment changed while the webhook was processed.", retry_after=5)
            raise GatewayError("PAYMENT_VERSION_CONFLICT", "Payment changed while the webhook was processed.", retryable=True, status_code=409)
    completed = await db.webhook_events_v2.update_one(
        claim_filter,
        {"$set": {
            "processing_status": WebhookStatus.PROCESSED.value,
            "processing_started_at": None,
            "processing_claim_id": None,
            "payment_order_id": order["id"],
            "processed_at": utcnow(),
            "next_retry_at": None,
            "last_error_code": None,
            "last_error_summary": None,
        }},
    )
    if completed.modified_count != 1:
        raise GatewayError(
            "WEBHOOK_EVENT_BUSY",
            "Webhook event processing lease was superseded; retry safely.",
            retryable=True,
            status_code=503,
        )
    return {"duplicate": False, "event_id": event["id"], "payment_order_id": order["id"], "status": parsed.status}


async def import_settlement(gateway_id: str, filename: str, content: bytes, actor_id: str) -> dict[str, Any]:
    if len(content) > 10 * 1024 * 1024:
        raise GatewayError("SETTLEMENT_FILE_TOO_LARGE", "Settlement file is too large.", status_code=413)
    checksum = hashlib.sha256(content).hexdigest()
    existing = await db.settlement_imports.find_one({"gateway_id": gateway_id, "source_file_checksum": checksum})
    if existing:
        return {**existing, "duplicate": True}
    if not filename.lower().endswith(".csv"):
        raise GatewayError("SETTLEMENT_FILE_INVALID", "Only mapped CSV settlement files are accepted.")
    row = {"id": str(uuid.uuid4()), "gateway_id": gateway_id, "source_file_checksum": checksum, "filename": filename[:200], "status": "PREVIEWED", "created_by": actor_id, "created_at": utcnow(), "line_count": max(0, content.count(b"\n") - 1)}
    try:
        await db.settlement_imports.insert_one(row)
    except DuplicateKeyError:
        return {**(await db.settlement_imports.find_one({"gateway_id": gateway_id, "source_file_checksum": checksum})), "duplicate": True}
    await audit(actor_id, "SETTLEMENT_PREVIEWED", "SETTLEMENT_IMPORT", row["id"], metadata={"filename": filename, "checksum": checksum, "line_count": row["line_count"]})
    return {**row, "duplicate": False}
