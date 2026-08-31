from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import uuid
from datetime import timedelta
from typing import Any, Mapping

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from pymongo import ASCENDING, DESCENDING, ReturnDocument
from pymongo.errors import DuplicateKeyError

from db import db
from .domain import (
    Capability, Direction, GatewayError, HealthStatus, PayinStatus,
    ReconciliationStatus, WebhookStatus, public_reference, redact,
    require_money, require_transition, utcnow,
)
from .registry import registry


GATEWAY_CODE = re.compile(r"^[A-Z][A-Z0-9_]{2,39}$")
TERMINAL_PAYIN = {item.value for item in (PayinStatus.SUCCEEDED, PayinStatus.FAILED, PayinStatus.CANCELLED, PayinStatus.EXPIRED, PayinStatus.REFUNDED, PayinStatus.REVERSED)}


def enabled(name: str) -> bool:
    return str(os.environ.get(name, "false")).strip().lower() in {"1", "true", "yes", "on"}


def feature_status() -> dict[str, Any]:
    return {
        "payments_v2": enabled("PAYMENTS_V2_ENABLED"),
        "admin": enabled("PAYMENT_GATEWAY_ADMIN_ENABLED"),
        "live_allowed": enabled("PAYMENT_LIVE_MODE_ALLOWED"),
        "installed_adapters": registry.codes(),
    }


def require_admin_feature() -> None:
    if not enabled("PAYMENT_GATEWAY_ADMIN_ENABLED"):
        raise GatewayError("PAYMENT_GATEWAY_ADMIN_DISABLED", "Payment gateway administration is disabled.", status_code=404)


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


def gateway_dto(row: Mapping[str, Any]) -> dict[str, Any]:
    allowed = {
        "id", "code", "display_name", "adapter_type", "environment", "status",
        "merchant_reference_masked", "base_url", "capabilities", "non_secret_config",
        "health_status", "last_health_check_at", "last_success_at", "last_failure_at",
        "consecutive_failure_count", "last_error_code", "last_error_summary", "is_enabled",
        "created_at", "updated_at", "version", "credential_hints",
    }
    return redact({key: value for key, value in row.items() if key in allowed})


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


async def create_gateway(payload: Mapping[str, Any], actor_id: str) -> dict[str, Any]:
    require_admin_feature()
    code = str(payload.get("code", "")).strip().upper()
    adapter_type = str(payload.get("adapter_type", "")).strip().upper()
    environment = str(payload.get("environment", "SANDBOX")).strip().upper()
    if not GATEWAY_CODE.fullmatch(code) or adapter_type not in registry.codes() or environment not in {"SANDBOX", "LIVE"}:
        raise GatewayError("GATEWAY_CONFIG_INVALID", "Gateway identity or adapter is invalid.")
    if environment == "LIVE" and not enabled("PAYMENT_LIVE_MODE_ALLOWED"):
        raise GatewayError("PAYMENT_LIVE_MODE_DISABLED", "Live gateway configuration is disabled.", status_code=403)
    capabilities = sorted({Capability(item).value for item in payload.get("capabilities", [])})
    now = utcnow()
    row = {
        "id": str(uuid.uuid4()), "code": code,
        "display_name": str(payload.get("display_name", code)).strip()[:100],
        "adapter_type": adapter_type, "environment": environment, "status": "DRAFT",
        "merchant_reference_masked": str(payload.get("merchant_reference_masked", ""))[:80],
        "base_url": str(payload.get("base_url", ""))[:500], "capabilities": capabilities,
        "non_secret_config": redact(dict(payload.get("non_secret_config", {}))),
        "health_status": HealthStatus.UNKNOWN.value, "consecutive_failure_count": 0,
        "is_enabled": False, "created_by_admin_id": actor_id, "updated_by_admin_id": actor_id,
        "created_at": now, "updated_at": now, "version": 1, "credential_hints": {},
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
        updates["non_secret_config"] = redact(dict(updates["non_secret_config"]))
    updates.update({"updated_by_admin_id": actor_id, "updated_at": utcnow()})
    changed = await db.payment_gateways.find_one_and_update(
        {"id": gateway_id, "version": expected_version},
        {"$set": updates, "$inc": {"version": 1}}, return_document=ReturnDocument.AFTER,
    )
    if not changed:
        raise GatewayError("GATEWAY_VERSION_CONFLICT", "Gateway changed; refresh and retry.", status_code=409)
    await audit(actor_id, "GATEWAY_UPDATED", "PAYMENT_GATEWAY", gateway_id, before=gateway_dto(current), after=gateway_dto(changed))
    return changed


async def store_credentials(gateway_id: str, values: Mapping[str, str], actor_id: str) -> dict[str, Any]:
    require_admin_feature()
    gateway = await db.payment_gateways.find_one({"id": gateway_id})
    if not gateway:
        raise GatewayError("GATEWAY_NOT_FOUND", "Gateway was not found.", status_code=404)
    if not values or any(not re.fullmatch(r"[a-z][a-z0-9_]{1,63}", str(name)) or not isinstance(value, str) or not value for name, value in values.items()):
        raise GatewayError("GATEWAY_SECRET_INVALID", "Credential names or values are invalid.")
    now = utcnow()
    hints = dict(gateway.get("credential_hints", {}))
    for name, value in values.items():
        encrypted = _encrypt(gateway_id, name, value)
        await db.payment_gateway_secrets.update_many({"gateway_id": gateway_id, "secret_key_name": name, "status": "ACTIVE"}, {"$set": {"status": "ROTATED", "rotated_at": now}})
        await db.payment_gateway_secrets.insert_one({
            "id": str(uuid.uuid4()), "gateway_id": gateway_id, "secret_key_name": name,
            **encrypted, "masked_hint": f"••••{value[-4:]}" if len(value) >= 4 else "••••",
            "created_at": now, "rotated_at": None, "created_by_admin_id": actor_id, "status": "ACTIVE",
        })
        hints[name] = f"••••{value[-4:]}" if len(value) >= 4 else "••••"
    await db.payment_gateways.update_one({"id": gateway_id}, {"$set": {"credential_hints": hints, "updated_at": now, "updated_by_admin_id": actor_id}, "$inc": {"version": 1}})
    await audit(actor_id, "GATEWAY_CREDENTIALS_ROTATED", "PAYMENT_GATEWAY", gateway_id, metadata={"credential_names": sorted(values)})
    return {"gateway_id": gateway_id, "credential_hints": hints}


async def _credentials(gateway_id: str) -> dict[str, str]:
    rows = await db.payment_gateway_secrets.find({"gateway_id": gateway_id, "status": "ACTIVE"}).to_list(100)
    return {row["secret_key_name"]: _decrypt(row) for row in rows}


def _allowed_domains() -> set[str]:
    return {item.strip().lower() for item in os.environ.get("PAYMENT_PROVIDER_ALLOWED_DOMAINS", "").split(",") if item.strip()}


async def adapter_for(gateway: Mapping[str, Any]):
    config = dict(gateway.get("non_secret_config", {}))
    if gateway.get("base_url"):
        config["base_url"] = gateway["base_url"]
    config.setdefault("capabilities", gateway.get("capabilities", []))
    return registry.create(gateway["adapter_type"], config, await _credentials(gateway["id"]), _allowed_domains())


async def test_gateway(gateway_id: str, actor_id: str) -> dict[str, Any]:
    gateway = await db.payment_gateways.find_one({"id": gateway_id})
    if not gateway:
        raise GatewayError("GATEWAY_NOT_FOUND", "Gateway was not found.", status_code=404)
    started = utcnow()
    try:
        result = dict(await (await adapter_for(gateway)).health_check({"gateway_id": gateway_id}))
        update = {"health_status": HealthStatus.HEALTHY.value, "last_health_check_at": utcnow(), "last_success_at": utcnow(), "consecutive_failure_count": 0, "last_error_code": None, "last_error_summary": None}
    except Exception as exc:  # noqa: BLE001
        normalized = exc if isinstance(exc, GatewayError) else GatewayError("GATEWAY_HEALTH_FAILED", "Gateway health check failed.", retryable=True)
        update = {"health_status": HealthStatus.DOWN.value, "last_health_check_at": utcnow(), "last_failure_at": utcnow(), "last_error_code": normalized.code, "last_error_summary": normalized.message}
        await db.payment_gateways.update_one({"id": gateway_id}, {"$set": update, "$inc": {"consecutive_failure_count": 1}})
        await audit(actor_id, "GATEWAY_TEST_FAILED", "PAYMENT_GATEWAY", gateway_id, metadata={"code": normalized.code})
        raise normalized
    await db.payment_gateways.update_one({"id": gateway_id}, {"$set": update})
    result.update({"tested_at": started, "gateway_id": gateway_id})
    await audit(actor_id, "GATEWAY_TESTED", "PAYMENT_GATEWAY", gateway_id, metadata=result)
    return result


async def request_approval(action_type: str, target_type: str, target_id: str, actor_id: str, reason: str) -> dict[str, Any]:
    now = utcnow()
    existing = await db.approval_requests.find_one({"action_type": action_type, "target_type": target_type, "target_id": target_id, "status": "PENDING"})
    if existing:
        return existing
    row = {"id": str(uuid.uuid4()), "action_type": action_type, "target_type": target_type, "target_id": target_id, "requested_by": actor_id, "requested_at": now, "status": "PENDING", "required_approval_count": 1, "approved_by": [], "rejected_by": [], "reason": reason, "expires_at": now + timedelta(hours=24), "executed_at": None, "execution_reference": None}
    await db.approval_requests.insert_one(row)
    await audit(actor_id, "APPROVAL_REQUESTED", target_type, target_id, metadata={"action_type": action_type, "reason": reason})
    return row


async def approve_activation(gateway_id: str, approval_id: str, actor_id: str) -> dict[str, Any]:
    approval = await db.approval_requests.find_one({"id": approval_id, "target_id": gateway_id, "action_type": "GATEWAY_ACTIVATION", "status": "PENDING"})
    expires_at = approval.get("expires_at") if approval else None
    if expires_at is not None and expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=utcnow().tzinfo)
    if not approval or not expires_at or expires_at < utcnow():
        raise GatewayError("APPROVAL_NOT_AVAILABLE", "Approval request is unavailable.", status_code=409)
    if approval["requested_by"] == actor_id:
        raise GatewayError("MAKER_CHECKER_REQUIRED", "The requester cannot approve this action.", status_code=403)
    gateway = await db.payment_gateways.find_one({"id": gateway_id})
    if not gateway or gateway.get("health_status") != HealthStatus.HEALTHY.value:
        raise GatewayError("GATEWAY_NOT_HEALTHY", "Gateway must pass its health test before activation.", status_code=409)
    if gateway.get("environment") == "LIVE" and not enabled("PAYMENT_LIVE_MODE_ALLOWED"):
        raise GatewayError("PAYMENT_LIVE_MODE_DISABLED", "Live gateway activation is disabled.", status_code=403)
    now = utcnow()
    claimed = await db.approval_requests.find_one_and_update(
        {"id": approval_id, "status": "PENDING"},
        {"$set": {"status": "EXECUTING", "execution_claimed_by": actor_id, "execution_claimed_at": now}},
        return_document=ReturnDocument.AFTER,
    )
    if not claimed:
        raise GatewayError("APPROVAL_ALREADY_DECIDED", "Approval was already decided.", status_code=409)
    changed = await db.payment_gateways.update_one({"id": gateway_id, "status": {"$ne": "ACTIVE"}}, {"$set": {"status": "ACTIVE", "is_enabled": True, "updated_at": now, "updated_by_admin_id": actor_id}, "$inc": {"version": 1}})
    if changed.modified_count != 1:
        await db.approval_requests.update_one({"id": approval_id, "status": "EXECUTING", "execution_claimed_by": actor_id}, {"$set": {"status": "PENDING"}, "$unset": {"execution_claimed_by": "", "execution_claimed_at": ""}})
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
        if not gateway or not gateway.get("is_enabled") or gateway.get("health_status") not in {HealthStatus.HEALTHY.value, HealthStatus.DEGRADED.value}:
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


async def create_sandbox_payin(gateway_id: str, payload: Mapping[str, Any], actor_id: str, idempotency_key: str) -> dict[str, Any]:
    gateway = await db.payment_gateways.find_one({"id": gateway_id, "environment": "SANDBOX"})
    if not gateway:
        raise GatewayError("SANDBOX_GATEWAY_REQUIRED", "A sandbox gateway is required.", status_code=409)
    amount, currency = require_money(payload.get("amount_minor"), payload.get("currency"))
    operation_scope = f"SANDBOX_PAYIN:{gateway_id}:{actor_id}"
    existing = await db.payment_orders_v2.find_one({"operation_scope": operation_scope, "idempotency_key": idempotency_key})
    if existing:
        return existing
    order = {"id": str(uuid.uuid4()), "public_reference": public_reference("PAY"), "direction": Direction.PAYIN.value, "subject_type": "ADMIN_SANDBOX", "subject_id": actor_id, "gateway_id": gateway_id, "method": str(payload.get("method", "HOSTED_CHECKOUT")).upper(), "currency": currency, "amount_minor": amount, "fee_minor": 0, "tax_minor": 0, "net_amount_minor": amount, "normalized_status": PayinStatus.CREATED.value, "idempotency_key": idempotency_key, "operation_scope": operation_scope, "correlation_id": str(uuid.uuid4()), "metadata": {"sandbox": True}, "row_version": 1, "created_at": utcnow(), "updated_at": utcnow()}
    try:
        await db.payment_orders_v2.insert_one(order)
    except DuplicateKeyError:
        return await db.payment_orders_v2.find_one({"operation_scope": operation_scope, "idempotency_key": idempotency_key})
    adapter = await adapter_for(gateway)
    result = await adapter.create_payin({"amount_minor": amount, "currency": currency, "reference": order["public_reference"]}, idempotency_key)
    require_transition(Direction.PAYIN, order["normalized_status"], result.status)
    await db.payment_orders_v2.update_one({"id": order["id"], "normalized_status": PayinStatus.CREATED.value}, {"$set": {"normalized_status": result.status, "provider_payment_id": result.provider_id, "checkout_url": result.checkout_url, "provider_customer_reference": None, "updated_at": utcnow()}, "$inc": {"row_version": 1}})
    await audit(actor_id, "SANDBOX_PAYMENT_CREATED", "PAYMENT_ORDER", order["id"], metadata={"gateway_id": gateway_id, "amount_minor": amount, "currency": currency})
    return await db.payment_orders_v2.find_one({"id": order["id"]})


async def process_webhook(gateway_code: str, headers: Mapping[str, str], raw_body: bytes) -> dict[str, Any]:
    gateway = await db.payment_gateways.find_one({"code": gateway_code.upper(), "is_enabled": True})
    if not gateway:
        raise GatewayError("GATEWAY_NOT_FOUND", "Gateway was not found.", status_code=404)
    adapter = await adapter_for(gateway)
    parsed = adapter.parse_webhook(headers, raw_body)
    body_hash = hashlib.sha256(raw_body).hexdigest()
    event = {"id": str(uuid.uuid4()), "gateway_id": gateway["id"], "provider_event_id": parsed.event_id, "provider_event_type": parsed.event_type, "body_hash": body_hash, "signature_valid": True, "normalized_event_type": parsed.event_type, "processing_status": WebhookStatus.RECEIVED.value, "payment_order_id": None, "received_at": utcnow(), "processed_at": None, "processing_attempts": 0, "next_retry_at": None, "last_error_code": None, "last_error_summary": None, "correlation_id": str(uuid.uuid4()), "sanitized_payload": parsed.sanitized_payload}
    try:
        await db.webhook_events_v2.insert_one(event)
    except DuplicateKeyError:
        existing = await db.webhook_events_v2.find_one({"gateway_id": gateway["id"], "provider_event_id": parsed.event_id})
        if existing and existing.get("body_hash") != body_hash:
            raise GatewayError("WEBHOOK_EVENT_CONFLICT", "Webhook event identity was reused with different content.", status_code=409)
        return {"duplicate": True, "event_id": existing["id"]}
    order = await db.payment_orders_v2.find_one({"gateway_id": gateway["id"], "provider_payment_id": parsed.object_id})
    if not order:
        await db.webhook_events_v2.update_one({"id": event["id"]}, {"$set": {"processing_status": WebhookStatus.RETRY_PENDING.value, "last_error_code": "PAYMENT_NOT_FOUND", "next_retry_at": utcnow() + timedelta(seconds=30)}, "$inc": {"processing_attempts": 1}})
        raise GatewayError("PAYMENT_NOT_FOUND", "Payment order was not found.", retryable=True, status_code=503)
    if parsed.amount_minor is not None and int(parsed.amount_minor) != int(order["amount_minor"]):
        await db.webhook_events_v2.update_one({"id": event["id"]}, {"$set": {"processing_status": WebhookStatus.DEAD_LETTER.value, "last_error_code": "PAYMENT_AMOUNT_MISMATCH", "last_error_summary": "Webhook amount does not match the order.", "processed_at": utcnow()}, "$inc": {"processing_attempts": 1}})
        raise GatewayError("PAYMENT_AMOUNT_MISMATCH", "Webhook amount does not match the order.", status_code=409)
    if parsed.currency is not None and str(parsed.currency).upper() != order["currency"]:
        await db.webhook_events_v2.update_one({"id": event["id"]}, {"$set": {"processing_status": WebhookStatus.DEAD_LETTER.value, "last_error_code": "PAYMENT_CURRENCY_MISMATCH", "last_error_summary": "Webhook currency does not match the order.", "processed_at": utcnow()}, "$inc": {"processing_attempts": 1}})
        raise GatewayError("PAYMENT_CURRENCY_MISMATCH", "Webhook currency does not match the order.", status_code=409)
    try:
        require_transition(Direction.PAYIN, order["normalized_status"], parsed.status)
    except GatewayError as exc:
        await db.webhook_events_v2.update_one({"id": event["id"]}, {"$set": {"processing_status": WebhookStatus.DEAD_LETTER.value, "last_error_code": exc.code, "last_error_summary": exc.message, "processed_at": utcnow()}, "$inc": {"processing_attempts": 1}})
        raise
    changed = await db.payment_orders_v2.update_one({"id": order["id"], "row_version": order["row_version"]}, {"$set": {"normalized_status": parsed.status, "provider_reference": parsed.provider_reference, "updated_at": utcnow()}, "$inc": {"row_version": 1}})
    if changed.modified_count != 1:
        current = await db.payment_orders_v2.find_one({"id": order["id"]})
        if not current or current.get("normalized_status") != parsed.status:
            await db.webhook_events_v2.update_one({"id": event["id"]}, {"$set": {"processing_status": WebhookStatus.RETRY_PENDING.value, "last_error_code": "PAYMENT_VERSION_CONFLICT", "last_error_summary": "Payment changed while the webhook was processed.", "next_retry_at": utcnow() + timedelta(seconds=5)}, "$inc": {"processing_attempts": 1}})
            raise GatewayError("PAYMENT_VERSION_CONFLICT", "Payment changed while the webhook was processed.", retryable=True, status_code=409)
    await db.webhook_events_v2.update_one({"id": event["id"]}, {"$set": {"processing_status": WebhookStatus.PROCESSED.value, "payment_order_id": order["id"], "processed_at": utcnow()}, "$inc": {"processing_attempts": 1}})
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
