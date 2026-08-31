from __future__ import annotations

import os
import uuid
from typing import Any, Mapping

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile
from pydantic import BaseModel, Field

from auth_utils import get_current_user, require_recent_admin_step_up
from db import db, serialize_doc
from payment_hub import service
from payment_hub.domain import GatewayError, redact, utcnow


router = APIRouter(tags=["payment-hub"])
admin_router = APIRouter(prefix="/admin", tags=["admin-payment-hub"])


PERMISSION_ALIASES = {
    "gateway.view": {"GATEWAY_VIEW", "PAYMENTS_VIEW"},
    "gateway.create": {"GATEWAY_CREATE", "PAYMENT_SETTINGS_WRITE"},
    "gateway.update_non_secret_config": {"GATEWAY_UPDATE_NON_SECRET_CONFIG", "PAYMENT_SETTINGS_WRITE"},
    "gateway.rotate_credentials": {"GATEWAY_ROTATE_CREDENTIALS", "PAYMENT_SETTINGS_WRITE"},
    "gateway.test": {"GATEWAY_TEST", "PAYMENT_SETTINGS_WRITE"},
    "gateway.activate": {"GATEWAY_ACTIVATE", "PAYMENT_SETTINGS_WRITE"},
    "gateway.disable": {"GATEWAY_DISABLE", "PAYMENT_SETTINGS_WRITE"},
    "gateway.manage_routes": {"GATEWAY_MANAGE_ROUTES", "PAYMENT_SETTINGS_WRITE"},
    "payment.view": {"PAYMENT_VIEW", "PAYMENTS_VIEW"},
    "payout.view": {"PAYOUT_VIEW", "PAYMENTS_VIEW"},
    "webhook.view": {"WEBHOOK_VIEW", "PAYMENTS_VIEW"},
    "webhook.replay": {"WEBHOOK_REPLAY", "PAYMENTS_RECONCILE"},
    "settlement.view": {"SETTLEMENT_VIEW", "PAYMENTS_VIEW"},
    "settlement.import": {"SETTLEMENT_IMPORT", "PAYMENTS_RECONCILE"},
    "reconciliation.resolve": {"RECONCILIATION_RESOLVE", "PAYMENTS_RECONCILE"},
    "activity.view": {"ACTIVITY_VIEW", "AUDIT_VIEW"},
    "audit.view": {"AUDIT_VIEW"},
}


def _permissions(user: Mapping[str, Any]) -> set[str]:
    values = user.get("admin_permissions") if "admin_permissions" in user else user.get("permissions", [])
    return {str(value).strip().upper() for value in (values or [])}


def require_permission(permission: str, *, step_up: bool = False, super_admin: bool = False, feature: bool = True):
    async def dependency(user: dict = Depends(get_current_user)):
        if user.get("role") != "ADMIN" or user.get("status") != "ACTIVE":
            raise HTTPException(status_code=403, detail={"code": "ADMIN_REQUIRED", "message": "Administrator access is required."})
        is_super = str(user.get("admin_role", "")).upper() == "SUPER_ADMIN"
        if super_admin and not is_super:
            raise HTTPException(status_code=403, detail={"code": "SUPER_ADMIN_REQUIRED", "message": "A designated Super Admin is required."})
        if not is_super and not (_permissions(user) & PERMISSION_ALIASES[permission]):
            raise HTTPException(status_code=403, detail={"code": "ADMIN_PERMISSION_REQUIRED", "message": "This payment permission is required."})
        if step_up:
            require_recent_admin_step_up(user)
        if feature:
            try:
                service.require_admin_feature()
            except GatewayError as exc:
                raise_gateway(exc)
        return user
    return dependency


def envelope(data: Any = None, error: Any = None, request_id: str | None = None):
    return {"data": serialize_doc(data), "meta": {"request_id": request_id or str(uuid.uuid4()), "timestamp": utcnow().isoformat()}, "error": error}


def _masked_email(value: Any) -> str | None:
    text = str(value or "")
    if "@" not in text:
        return None
    local, domain = text.split("@", 1)
    return f"{local[:1]}{'•' * max(2, len(local) - 1)}@{domain}"


def _masked_phone(value: Any) -> str | None:
    text = str(value or "")
    return f"{'•' * max(4, len(text) - 4)}{text[-4:]}" if text else None


def raise_gateway(exc: GatewayError):
    raise HTTPException(status_code=exc.status_code, detail=envelope(error={"code": exc.code, "message": exc.message, "field_errors": {}, "retryable": exc.retryable})["error"]) from exc


class GatewayCreate(BaseModel):
    code: str = Field(min_length=3, max_length=40)
    display_name: str = Field(min_length=2, max_length=100)
    adapter_type: str
    environment: str = "SANDBOX"
    merchant_reference_masked: str = Field(default="", max_length=80)
    base_url: str = Field(default="", max_length=500)
    capabilities: list[str] = Field(default_factory=list)
    non_secret_config: dict[str, Any] = Field(default_factory=dict)


class GatewayUpdate(BaseModel):
    display_name: str | None = Field(default=None, min_length=2, max_length=100)
    merchant_reference_masked: str | None = Field(default=None, max_length=80)
    base_url: str | None = Field(default=None, max_length=500)
    capabilities: list[str] | None = None
    non_secret_config: dict[str, Any] | None = None
    version: int = Field(ge=1)


class CredentialsWrite(BaseModel):
    credentials: dict[str, str]


class Reason(BaseModel):
    reason: str = Field(min_length=5, max_length=500)


class Approval(BaseModel):
    approval_id: str = Field(min_length=8, max_length=80)


class RouteCreate(BaseModel):
    name: str = Field(min_length=2, max_length=100)
    direction: str
    payment_method: str = "ALL"
    currency: str = "INR"
    country_code: str = "ALL"
    min_amount_minor: int = Field(default=1, ge=1)
    max_amount_minor: int = Field(default=10**12, ge=1)
    subject_type: str = "ALL"
    gateway_id: str
    priority: int = Field(default=100, ge=0, le=10000)
    weight: int = Field(default=100, ge=1, le=10000)
    fallback_gateway_id: str | None = None


class RouteSimulation(BaseModel):
    direction: str
    payment_method: str
    currency: str
    amount_minor: int
    subject_type: str = "USER"
    correlation_id: str | None = None


@admin_router.get("/payment-hub/status")
async def hub_status(admin=Depends(require_permission("gateway.view", feature=False))):
    return envelope(service.feature_status())


@admin_router.get("/payment-gateways")
async def gateways(admin=Depends(require_permission("gateway.view"))):
    try:
        service.require_admin_feature()
        rows = await db.payment_gateways.find({}, {"_id": 0}).sort("created_at", -1).to_list(500)
        return envelope({"items": [service.gateway_dto(row) for row in rows], "count": len(rows)})
    except GatewayError as exc:
        raise_gateway(exc)


@admin_router.post("/payment-gateways", status_code=201)
async def gateway_create(body: GatewayCreate, admin=Depends(require_permission("gateway.create", step_up=True, super_admin=True))):
    try:
        return envelope({"gateway": service.gateway_dto(await service.create_gateway(body.model_dump(), admin["id"]))})
    except (GatewayError, ValueError) as exc:
        raise_gateway(exc if isinstance(exc, GatewayError) else GatewayError("GATEWAY_CONFIG_INVALID", "Gateway capabilities are invalid."))


@admin_router.get("/payment-gateways/{gateway_id}")
async def gateway_detail(gateway_id: str, admin=Depends(require_permission("gateway.view"))):
    row = await db.payment_gateways.find_one({"id": gateway_id})
    if not row:
        raise_gateway(GatewayError("GATEWAY_NOT_FOUND", "Gateway was not found.", status_code=404))
    return envelope({"gateway": service.gateway_dto(row)})


@admin_router.patch("/payment-gateways/{gateway_id}")
async def gateway_update(gateway_id: str, body: GatewayUpdate, admin=Depends(require_permission("gateway.update_non_secret_config", step_up=True, super_admin=True))):
    try:
        values = body.model_dump(exclude_none=True)
        version = values.pop("version")
        row = await service.update_gateway(gateway_id, values, admin["id"], version)
        return envelope({"gateway": service.gateway_dto(row)})
    except (GatewayError, ValueError) as exc:
        raise_gateway(exc if isinstance(exc, GatewayError) else GatewayError("GATEWAY_CONFIG_INVALID", "Gateway configuration is invalid."))


@admin_router.post("/payment-gateways/{gateway_id}/credentials")
@admin_router.post("/payment-gateways/{gateway_id}/rotate-credentials")
async def gateway_credentials(gateway_id: str, body: CredentialsWrite, admin=Depends(require_permission("gateway.rotate_credentials", step_up=True, super_admin=True))):
    try:
        return envelope(await service.store_credentials(gateway_id, body.credentials, admin["id"]))
    except GatewayError as exc:
        raise_gateway(exc)


@admin_router.post("/payment-gateways/{gateway_id}/test")
async def gateway_test(gateway_id: str, admin=Depends(require_permission("gateway.test", step_up=True))):
    try:
        return envelope(await service.test_gateway(gateway_id, admin["id"]))
    except GatewayError as exc:
        raise_gateway(exc)


@admin_router.post("/payment-gateways/{gateway_id}/request-activation")
async def gateway_request_activation(gateway_id: str, body: Reason, admin=Depends(require_permission("gateway.activate", step_up=True, super_admin=True))):
    try:
        service.require_payments_v2_activation()
        gateway = await db.payment_gateways.find_one({"id": gateway_id})
        if not gateway:
            raise GatewayError("GATEWAY_NOT_FOUND", "Gateway was not found.", status_code=404)
        return envelope({"approval": await service.request_approval("GATEWAY_ACTIVATION", "PAYMENT_GATEWAY", gateway_id, admin["id"], body.reason)})
    except GatewayError as exc:
        raise_gateway(exc)


@admin_router.post("/payment-gateways/{gateway_id}/approve-activation")
async def gateway_approve_activation(gateway_id: str, body: Approval, admin=Depends(require_permission("gateway.activate", step_up=True, super_admin=True))):
    try:
        service.require_payments_v2_activation()
        return envelope({"gateway": service.gateway_dto(await service.approve_activation(gateway_id, body.approval_id, admin["id"]))})
    except GatewayError as exc:
        raise_gateway(exc)


@admin_router.post("/payment-gateways/{gateway_id}/disable")
async def gateway_disable(gateway_id: str, body: Reason, admin=Depends(require_permission("gateway.disable", step_up=True, super_admin=True))):
    try:
        return envelope({"gateway": service.gateway_dto(await service.disable_gateway(gateway_id, admin["id"], body.reason))})
    except GatewayError as exc:
        raise_gateway(exc)


@admin_router.get("/payment-routes")
async def routes(admin=Depends(require_permission("gateway.view"))):
    rows = await db.payment_routes.find({}, {"_id": 0}).sort([("priority", 1), ("created_at", -1)]).to_list(500)
    return envelope({"items": rows, "count": len(rows)})


@admin_router.post("/payment-routes", status_code=201)
async def route_create(body: RouteCreate, admin=Depends(require_permission("gateway.manage_routes", step_up=True, super_admin=True))):
    try:
        return envelope({"route": await service.create_route(body.model_dump(), admin["id"])})
    except (GatewayError, ValueError) as exc:
        raise_gateway(exc if isinstance(exc, GatewayError) else GatewayError("PAYMENT_ROUTE_INVALID", "Payment route is invalid."))


@admin_router.post("/payment-routes/{route_id}/request-activation")
async def route_request_activation(route_id: str, body: Reason, admin=Depends(require_permission("gateway.manage_routes", step_up=True, super_admin=True))):
    try:
        service.require_payments_v2_activation()
        route = await db.payment_routes.find_one({"id": route_id})
        if not route:
            raise GatewayError("PAYMENT_ROUTE_NOT_FOUND", "Payment route was not found.", status_code=404)
        approval = await service.request_approval(
            "PAYMENT_ROUTE_ACTIVATION", "PAYMENT_ROUTE", route_id, admin["id"], body.reason,
        )
        return envelope({"approval": approval})
    except GatewayError as exc:
        raise_gateway(exc)


@admin_router.post("/payment-routes/{route_id}/approve-activation")
async def route_approve_activation(route_id: str, body: Approval, admin=Depends(require_permission("gateway.manage_routes", step_up=True, super_admin=True))):
    try:
        service.require_payments_v2_activation()
        return envelope({"route": await service.approve_route_activation(route_id, body.approval_id, admin["id"])})
    except GatewayError as exc:
        raise_gateway(exc)


@admin_router.get("/payment-approvals")
async def payment_approvals(status: str = Query(default="PENDING"), admin=Depends(require_permission("gateway.view"))):
    normalized = status.strip().upper()
    if normalized not in {"PENDING", "APPROVED", "REJECTED", "EXPIRED"}:
        raise_gateway(GatewayError("APPROVAL_STATUS_INVALID", "Approval status is invalid."))
    rows = await db.approval_requests.find(
        {"status": normalized, "target_type": {"$in": ["PAYMENT_GATEWAY", "PAYMENT_ROUTE"]}},
        {"_id": 0},
    ).sort("requested_at", -1).to_list(500)
    return envelope({"items": [redact(row) for row in rows], "count": len(rows)})


@admin_router.post("/payment-routes/simulate")
async def route_simulate(body: RouteSimulation, admin=Depends(require_permission("gateway.view"))):
    try:
        payload = body.model_dump(exclude={"correlation_id"})
        return envelope({"decision": await service.choose_gateway(payload, body.correlation_id or str(uuid.uuid4()))})
    except (GatewayError, ValueError) as exc:
        raise_gateway(exc if isinstance(exc, GatewayError) else GatewayError("PAYMENT_ROUTE_INVALID", "Payment route is invalid."))


@admin_router.get("/payments")
async def payment_list(status: str | None = None, gateway_id: str | None = None, limit: int = Query(default=100, ge=1, le=500), admin=Depends(require_permission("payment.view"))):
    query: dict[str, Any] = {}
    if status:
        query["normalized_status"] = status.upper()
    if gateway_id:
        query["gateway_id"] = gateway_id
    rows = await db.payment_orders_v2.find(query, {"_id": 0, "metadata": 0}).sort("created_at", -1).to_list(limit)
    return envelope({"items": [redact(row) for row in rows], "count": len(rows)})


@admin_router.get("/payments/{payment_id}")
async def payment_detail(payment_id: str, admin=Depends(require_permission("payment.view"))):
    row = await db.payment_orders_v2.find_one({"id": payment_id}, {"_id": 0})
    if not row:
        raise_gateway(GatewayError("PAYMENT_NOT_FOUND", "Payment was not found.", status_code=404))
    events = await db.webhook_events_v2.find({"payment_order_id": payment_id}, {"_id": 0}).sort("received_at", 1).to_list(200)
    return envelope({"payment": redact(row), "webhook_events": [redact(item) for item in events]})


@admin_router.get("/webhook-events")
async def webhook_events(status: str | None = None, limit: int = Query(default=100, ge=1, le=500), admin=Depends(require_permission("webhook.view"))):
    query = {"processing_status": status.upper()} if status else {}
    rows = await db.webhook_events_v2.find(query, {"_id": 0}).sort("received_at", -1).to_list(limit)
    return envelope({"items": [redact(row) for row in rows], "count": len(rows)})


@admin_router.get("/webhook-events/{event_id}")
async def webhook_event_detail(event_id: str, admin=Depends(require_permission("webhook.view"))):
    row = await db.webhook_events_v2.find_one({"id": event_id}, {"_id": 0})
    if not row:
        raise_gateway(GatewayError("WEBHOOK_EVENT_NOT_FOUND", "Webhook event was not found.", status_code=404))
    return envelope({"event": redact(row)})


@admin_router.get("/settlements")
async def settlements(admin=Depends(require_permission("settlement.view"))):
    rows = await db.settlement_imports.find({}, {"_id": 0}).sort("created_at", -1).to_list(500)
    return envelope({"items": rows, "count": len(rows)})


@admin_router.post("/settlements/import")
async def settlement_import(gateway_id: str, file: UploadFile = File(...), admin=Depends(require_permission("settlement.import", step_up=True))):
    try:
        content = await file.read(10 * 1024 * 1024 + 1)
        return envelope({"import": await service.import_settlement(gateway_id, file.filename or "settlement.csv", content, admin["id"])})
    except GatewayError as exc:
        raise_gateway(exc)


@admin_router.get("/reconciliation")
async def reconciliation(status: str | None = None, admin=Depends(require_permission("settlement.view"))):
    query = {"status": status.upper()} if status else {}
    rows = await db.reconciliation_cases.find(query, {"_id": 0}).sort("created_at", -1).to_list(500)
    return envelope({"items": [redact(row) for row in rows], "count": len(rows)})


@admin_router.get("/activity")
async def activity(event_type: str | None = None, limit: int = Query(default=100, ge=1, le=500), admin=Depends(require_permission("activity.view"))):
    query = {"event_type": event_type.upper()} if event_type else {}
    rows = await db.activity_events.find(query, {"_id": 0}).sort("occurred_at", -1).to_list(limit)
    return envelope({"items": [redact(row) for row in rows], "count": len(rows)})


@admin_router.get("/users/{user_id}/financial-overview")
async def user_financial_overview(user_id: str, admin=Depends(require_permission("payment.view"))):
    user = await db.users.find_one({"id": user_id}, {"_id": 0, "id": 1, "name": 1, "username": 1, "email": 1, "phone": 1, "status": 1, "role": 1})
    if not user:
        raise_gateway(GatewayError("USER_NOT_FOUND", "User was not found.", status_code=404))
    wallet = await db.wallet_accounts.find_one({"user_id": user_id}, {"_id": 0}) or {}
    deposits = await db.deposit_orders.aggregate([{"$match": {"user_id": user_id}}, {"$group": {"_id": None, "amount_minor": {"$sum": "$amount_paise"}, "count": {"$sum": 1}}}]).to_list(1)
    withdrawals = await db.withdrawal_requests.aggregate([{"$match": {"user_id": user_id}}, {"$group": {"_id": None, "amount_minor": {"$sum": "$amount_paise"}, "count": {"$sum": 1}}}]).to_list(1)
    identity = {key: user.get(key) for key in ("id", "name", "username", "status", "role")}
    identity.update({"email_masked": _masked_email(user.get("email")), "phone_masked": _masked_phone(user.get("phone"))})
    return envelope({"user": identity, "wallet": redact(wallet), "lifetime_deposits": serialize_doc(deposits[0]) if deposits else {"amount_minor": 0, "count": 0}, "lifetime_withdrawals": serialize_doc(withdrawals[0]) if withdrawals else {"amount_minor": 0, "count": 0}})


@admin_router.get("/distributors/{distributor_id}/financial-overview")
async def distributor_financial_overview(distributor_id: str, admin=Depends(require_permission("payment.view"))):
    distributor = await db.distributors.find_one({"id": distributor_id}, {"_id": 0, "id": 1, "code": 1, "name": 1, "status": 1, "is_house": 1})
    if not distributor:
        raise_gateway(GatewayError("DISTRIBUTOR_NOT_FOUND", "Distributor was not found.", status_code=404))
    commission = await db.commission_ledger.aggregate([{"$match": {"distributor_id": distributor_id, "status": {"$in": ["ACCRUED", "QUEUED"]}}}, {"$group": {"_id": None, "accrued_chips": {"$sum": "$commission"}, "count": {"$sum": 1}}}]).to_list(1)
    return envelope({"distributor": redact(distributor), "commission": serialize_doc(commission[0]) if commission else {"accrued_chips": 0, "count": 0}})


@router.post("/webhooks/payments/{gateway_code}")
async def payment_webhook(gateway_code: str, request: Request):
    if not service.enabled("PAYMENTS_V2_ENABLED"):
        raise HTTPException(status_code=404, detail="Not found")
    max_bytes = min(4 * 1024 * 1024, max(1024, int(os.environ.get("PAYMENT_HTTP_MAX_RESPONSE_BYTES", "1048576"))))
    chunks, size = [], 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > max_bytes:
            raise_gateway(GatewayError("WEBHOOK_TOO_LARGE", "Webhook body is too large.", status_code=413))
        chunks.append(chunk)
    try:
        return envelope(await service.process_webhook(gateway_code, request.headers, b"".join(chunks)))
    except GatewayError as exc:
        raise_gateway(exc)
