"""Player and admin promo APIs: wager state, Free Cash, overlay."""
from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from auth_utils import require_active_player, require_admin
import free_cash
import wager

router = APIRouter(tags=["promo"])


@router.get("/promo/state")
async def promo_state(user=Depends(require_active_player)):
    return {
        "wager": await wager.public_state(user["id"]),
        "free_cash": await free_cash.public_state(user["id"]),
    }


@router.post("/promo/free-cash/claim")
async def claim_free_cash(user=Depends(require_active_player)):
    return await free_cash.claim(user["id"])


@router.get("/admin/promo/settings")
async def admin_promo_settings(_admin=Depends(require_admin)):
    settings = await wager.get_settings()
    settings.update(await free_cash.get_settings())
    return settings


@router.patch("/admin/promo/settings")
async def admin_patch_promo(request: Request, admin=Depends(require_admin)):
    body = await request.json()
    actor = admin.get("email") or admin.get("id") or "admin"
    saved = await wager.save_settings(body, actor)
    extra = {k: body[k] for k in (
        "free_cash_claim_inr", "free_cash_register_min", "free_cash_register_max",
        "free_cash_deposit_min", "free_cash_deposit_max",
    ) if k in body}
    if extra:
        from db import db
        from datetime import datetime, timezone
        extra["updated_at"] = datetime.now(timezone.utc)
        extra["updated_by"] = actor
        await db.promo_settings.update_one({"id": wager.SETTINGS_ID}, {"$set": extra}, upsert=True)
        saved.update(await free_cash.get_settings())
    return saved
