"""Player and administrator routes for dormant promotion capabilities."""
from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from pydantic import BaseModel, Field

import compliance
from auth_utils import get_current_user, require_recent_admin_step_up
import promotions


logger = logging.getLogger(__name__)


router = APIRouter(prefix="/promotions", tags=["promotions"])
admin_router = APIRouter(prefix="/admin/promotions", tags=["admin-promotions"])


class OfferAccept(BaseModel):
    campaign_version: Optional[int] = Field(default=None, ge=1)
    jurisdiction: str = Field(min_length=2, max_length=2)
    terms_accepted: bool
    deposit_amount_paise: int = Field(ge=1, le=1_000_000_000)
    quote_token: str = Field(min_length=8, max_length=80)


class MissionForfeit(BaseModel):
    reason: str = Field(min_length=3, max_length=500)


class CampaignCreate(BaseModel):
    campaign_id: str = Field(min_length=3, max_length=64)
    campaign_type: str
    spec: dict[str, Any]


class CampaignVersionCreate(BaseModel):
    expected_version: int = Field(ge=1)
    spec: dict[str, Any]


class AdminReason(BaseModel):
    reason: str = Field(min_length=5, max_length=500)


class ReferralTaskReview(AdminReason):
    approve: bool


class ReferralFraudReview(AdminReason):
    decision: str = Field(pattern=r"^(CLEAR|REJECT)$")
    reason_code: str = Field(min_length=3, max_length=64, pattern=r"^[A-Z][A-Z0-9_]+$")


class ReferralAppeal(BaseModel):
    reason: str = Field(min_length=10, max_length=1000)


class MissionReconcile(AdminReason):
    repair: bool = False


def _promotion_http(exc: promotions.PromotionError):
    detail: dict[str, Any] = {"code": exc.code, "message": exc.message}
    if exc.meta:
        detail["meta"] = exc.meta
    raise HTTPException(status_code=exc.status_code, detail=detail) from exc


async def require_promotion_reader(user: dict = Depends(get_current_user)) -> dict:
    if user.get("role") != "PLAYER" or user.get("status") != "ACTIVE":
        raise HTTPException(status_code=403, detail={
            "code": "ACTIVE_PLAYER_REQUIRED", "message": "An active player account is required.",
        })
    return user


async def require_new_bonus_participant(
    user: dict = Depends(require_promotion_reader),
) -> dict:
    # Viewing and claiming already-earned rewards remain possible during an
    # exclusion, but accepting a new incentive does not.
    try:
        await compliance.assert_playable(user)
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception(
            "Promotion eligibility evaluation failed for player %s", user.get("id"),
        )
        raise HTTPException(status_code=503, detail={
            "code": "PROMOTION_ELIGIBILITY_UNAVAILABLE",
            "message": "Promotion eligibility is temporarily unavailable. Please try again later.",
        }) from exc
    return user


def _permissions(user: dict) -> set[str]:
    values = user.get("admin_permissions", user.get("permissions", [])) or []
    return {str(value).strip().upper() for value in values if str(value).strip()}


def _is_super_admin(user: dict) -> bool:
    return (
        user.get("role") == "ADMIN"
        and str(user.get("admin_role") or "").strip().upper() == "SUPER_ADMIN"
    )


def _admin_dependency(
    permission: str, *, super_only: bool = False, step_up: bool = False,
):
    permission = permission.upper()

    async def dependency(user: dict = Depends(get_current_user)) -> dict:
        if user.get("role") != "ADMIN" or user.get("status") != "ACTIVE":
            raise HTTPException(status_code=403, detail={
                "code": "ADMIN_REQUIRED", "message": "Administrator access is required.",
            })
        is_super = _is_super_admin(user)
        if super_only and not is_super:
            raise HTTPException(status_code=403, detail={
                "code": "SUPER_ADMIN_REQUIRED", "message": "A designated Super Admin is required.",
            })
        if not is_super and permission not in _permissions(user):
            raise HTTPException(status_code=403, detail={
                "code": "ADMIN_PERMISSION_REQUIRED", "message": f"Missing permission: {permission}.",
            })
        if step_up:
            require_recent_admin_step_up(user)
        return user

    return dependency


promotions_view = _admin_dependency("PROMOTIONS_VIEW")
promotions_manage = _admin_dependency("PROMOTIONS_MANAGE", step_up=True)
promotions_activate = _admin_dependency(
    "PROMOTIONS_ACTIVATE", super_only=True, step_up=True,
)
promotion_audit_view = _admin_dependency("PROMOTION_AUDIT_VIEW")


@router.get("/offers")
async def offers(
    deposit_amount_paise: Optional[int] = Query(default=None, ge=1, le=1_000_000_000),
    user: dict = Depends(require_new_bonus_participant),
):
    jurisdiction = compliance.normalise_country(user.get("country"))
    if not jurisdiction:
        raise HTTPException(status_code=403, detail={
            "code": "PROMOTION_MARKET_UNKNOWN",
            "message": "A verified account jurisdiction is required.",
        })
    try:
        return {
            "offers": await promotions.list_offers(
                jurisdiction, deposit_amount_paise=deposit_amount_paise,
                user_id=user["id"],
            ),
        }
    except promotions.PromotionError as exc:
        _promotion_http(exc)


@router.post("/offers/{campaign_id}/accept")
async def accept_offer(
    campaign_id: str, body: OfferAccept,
    idempotency_key: str = Header(default="", alias="Idempotency-Key"),
    user: dict = Depends(require_new_bonus_participant),
):
    registered = compliance.normalise_country(user.get("country"))
    requested = compliance.normalise_country(body.jurisdiction)
    if not registered or registered != requested:
        raise HTTPException(status_code=403, detail={
            "code": "PROMOTION_MARKET_MISMATCH",
            "message": "The offer jurisdiction must match the registered account jurisdiction.",
        })
    try:
        consent = await promotions.accept_offer(
            user["id"], campaign_id, jurisdiction=registered,
            terms_accepted=body.terms_accepted,
            idempotency_key=idempotency_key,
            deposit_amount_paise=body.deposit_amount_paise,
            quote_token=body.quote_token,
            campaign_version=body.campaign_version,
        )
        return {"consent": consent}
    except promotions.PromotionError as exc:
        _promotion_http(exc)


@router.get("/missions/active")
async def active_mission(user: dict = Depends(require_promotion_reader)):
    try:
        return {"mission": await promotions.get_active_mission(user["id"])}
    except promotions.PromotionError as exc:
        _promotion_http(exc)


@router.get("/missions/{mission_id}")
async def mission_detail(
    mission_id: str,
    event_limit: int = Query(default=100, ge=1, le=250),
    user: dict = Depends(require_promotion_reader),
):
    try:
        return {
            "mission": await promotions.get_mission(user["id"], mission_id),
            "events": await promotions.list_mission_events(user["id"], mission_id, event_limit),
        }
    except promotions.PromotionError as exc:
        _promotion_http(exc)


@router.post("/missions/{mission_id}/claim")
async def claim_mission(
    mission_id: str,
    idempotency_key: str = Header(default="", alias="Idempotency-Key"),
    user: dict = Depends(require_promotion_reader),
):
    try:
        return await promotions.claim_mission(user["id"], mission_id, idempotency_key)
    except promotions.PromotionError as exc:
        _promotion_http(exc)
    except Exception as exc:
        if hasattr(exc, "code") and hasattr(exc, "status_code"):
            detail = {"code": exc.code, "message": getattr(exc, "message", str(exc))}
            raise HTTPException(status_code=exc.status_code, detail=detail) from exc
        raise


@router.post("/missions/{mission_id}/forfeit")
async def forfeit_mission(
    mission_id: str, body: MissionForfeit,
    idempotency_key: str = Header(default="", alias="Idempotency-Key"),
    user: dict = Depends(require_promotion_reader),
):
    try:
        return {"mission": await promotions.forfeit_mission(
            user["id"], mission_id, body.reason, idempotency_key,
        )}
    except promotions.PromotionError as exc:
        _promotion_http(exc)


@router.get("/referrals/me")
async def my_referrals(user: dict = Depends(require_promotion_reader)):
    try:
        return await promotions.referral_summary(user["id"])
    except promotions.PromotionError as exc:
        _promotion_http(exc)


@router.get("/referrals/tasks")
async def my_referral_tasks(user: dict = Depends(require_promotion_reader)):
    try:
        summary = await promotions.referral_summary(user["id"])
        return {"tasks": summary["tasks"], "rewards": summary["rewards"]}
    except promotions.PromotionError as exc:
        _promotion_http(exc)


@router.post("/referrals/claim")
async def claim_referrals(
    idempotency_key: str = Header(default="", alias="Idempotency-Key"),
    user: dict = Depends(require_promotion_reader),
):
    try:
        return await promotions.claim_referral_rewards(user["id"], idempotency_key)
    except promotions.PromotionError as exc:
        _promotion_http(exc)
    except Exception as exc:
        if hasattr(exc, "code") and hasattr(exc, "status_code"):
            detail = {"code": exc.code, "message": getattr(exc, "message", str(exc))}
            raise HTTPException(status_code=exc.status_code, detail=detail) from exc
        raise


@router.post("/referrals/{referral_id}/appeal")
async def appeal_referral_review(
    referral_id: str, body: ReferralAppeal,
    user: dict = Depends(require_promotion_reader),
):
    try:
        return {
            "fraud_review": await promotions.request_referral_appeal(
                user["id"], referral_id, body.reason,
            ),
        }
    except promotions.PromotionError as exc:
        _promotion_http(exc)


@admin_router.get("/readiness")
async def promotion_readiness(admin: dict = Depends(promotions_view)):
    del admin
    return {
        "core": promotions.promotion_core_status(),
        "wager": promotions.feature_status(promotions.WAGER),
        "referral": promotions.feature_status(promotions.REFERRAL),
        "randomized_rewards_approved": promotions.randomized_rewards_enabled(),
    }


@admin_router.get("/audit")
async def promotion_audit_history(
    entity_type: Optional[str] = Query(default=None, max_length=80),
    entity_id: Optional[str] = Query(default=None, max_length=160),
    action: Optional[str] = Query(default=None, max_length=120),
    page: int = Query(default=1, ge=1, le=10_000),
    limit: int = Query(default=100, ge=1, le=250),
    admin: dict = Depends(promotion_audit_view),
):
    del admin
    return await promotions.list_promotion_audit(
        entity_type=entity_type, entity_id=entity_id, action=action,
        page=page, limit=limit,
    )


@admin_router.get("/campaigns")
async def campaigns(
    campaign_type: Optional[str] = Query(default=None),
    admin: dict = Depends(promotions_view),
):
    del admin
    return {"campaigns": await promotions.list_campaigns(campaign_type)}


@admin_router.post("/campaigns")
async def create_campaign(body: CampaignCreate, admin: dict = Depends(promotions_manage)):
    try:
        return await promotions.create_campaign(
            body.campaign_id, body.campaign_type, body.spec, admin["id"],
        )
    except promotions.PromotionError as exc:
        _promotion_http(exc)


@admin_router.get("/campaigns/{campaign_id}")
async def campaign_detail(campaign_id: str, admin: dict = Depends(promotions_view)):
    del admin
    try:
        return await promotions.campaign_detail(campaign_id)
    except promotions.PromotionError as exc:
        _promotion_http(exc)


@admin_router.post("/campaigns/{campaign_id}/versions")
async def create_campaign_version(
    campaign_id: str, body: CampaignVersionCreate,
    admin: dict = Depends(promotions_manage),
):
    try:
        version = await promotions.create_campaign_version(
            campaign_id, body.spec, admin["id"], expected_version=body.expected_version,
        )
        return {"version": version}
    except promotions.PromotionError as exc:
        _promotion_http(exc)


@admin_router.post("/campaigns/{campaign_id}/versions/{version}/approve")
async def approve_campaign(
    campaign_id: str, version: int, body: AdminReason,
    admin: dict = Depends(promotions_manage),
):
    try:
        row = await promotions.approve_campaign_version(
            campaign_id, version, admin["id"], body.reason,
        )
        return {"version": row}
    except promotions.PromotionError as exc:
        _promotion_http(exc)


@admin_router.post("/campaigns/{campaign_id}/versions/{version}/activate")
async def activate_campaign(
    campaign_id: str, version: int, body: AdminReason,
    admin: dict = Depends(promotions_activate),
):
    try:
        row = await promotions.activate_campaign_version(
            campaign_id, version, admin["id"], body.reason,
        )
        return {"version": row}
    except promotions.PromotionError as exc:
        _promotion_http(exc)


@admin_router.get("/missions/{mission_id}")
async def admin_mission_detail(
    mission_id: str, admin: dict = Depends(promotion_audit_view),
):
    del admin
    try:
        return await promotions.admin_mission_detail(mission_id)
    except promotions.PromotionError as exc:
        _promotion_http(exc)


@admin_router.post("/missions/{mission_id}/reconcile")
async def reconcile_mission(
    mission_id: str, body: MissionReconcile,
    admin: dict = Depends(promotions_manage),
):
    try:
        return await promotions.reconcile_mission(
            mission_id, admin["id"], repair=body.repair, reason=body.reason,
        )
    except promotions.PromotionError as exc:
        _promotion_http(exc)


@admin_router.get("/referral-tasks")
async def referral_tasks(
    status: Optional[str] = Query(default=None),
    limit: int = Query(default=100, ge=1, le=500),
    admin: dict = Depends(promotions_view),
):
    del admin
    return {
        "tasks": await promotions.list_admin_referral_tasks(
            status=status, limit=limit,
        ),
    }


@admin_router.post("/referral-tasks/{task_id}/review")
async def review_referral_task(
    task_id: str, body: ReferralTaskReview,
    admin: dict = Depends(promotions_manage),
):
    try:
        task = await promotions.review_referral_task(
            task_id, admin["id"], approve=body.approve, reason=body.reason,
        )
        return {"task": promotions.admin_referral_task_dto(task)}
    except promotions.PromotionError as exc:
        _promotion_http(exc)


@admin_router.get("/referrals/{referral_id}")
async def admin_referral_detail(
    referral_id: str, admin: dict = Depends(promotion_audit_view),
):
    del admin
    try:
        return await promotions.admin_referral_detail(referral_id)
    except promotions.PromotionError as exc:
        _promotion_http(exc)


@admin_router.post("/referrals/{referral_id}/fraud-review")
async def review_referral_fraud(
    referral_id: str, body: ReferralFraudReview,
    admin: dict = Depends(promotions_manage),
):
    try:
        return {
            "fraud_review": await promotions.review_referral_fraud(
                referral_id, admin["id"], decision=body.decision,
                reason_code=body.reason_code, reason=body.reason,
            ),
        }
    except promotions.PromotionError as exc:
        _promotion_http(exc)
