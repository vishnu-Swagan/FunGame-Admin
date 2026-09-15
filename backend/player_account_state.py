"""Account closure guards for new activity, independent of retained settlements."""
from datetime import datetime, timezone

from fastapi import HTTPException
from pymongo import ReturnDocument


def account_is_deleted(user) -> bool:
    return bool(user and (
        str(user.get("status") or "").upper() == "DELETED"
        or user.get("deleted_at")
    ))


def _require_available(user):
    if not user:
        raise HTTPException(status_code=404, detail={
            "code": "PLAYER_NOT_FOUND", "message": "The player account was not found.",
        })
    if account_is_deleted(user):
        raise HTTPException(status_code=403, detail={
            "code": "ACCOUNT_DELETED", "message": "This player account has been deleted.",
        })
    return user


async def require_available_account(database, user_id, *, session=None):
    kwargs = {"session": session} if session is not None else {}
    return _require_available(await database.users.find_one({"id": user_id}, **kwargs))


async def lock_account_for_new_activity(database, user_id, *, session=None):
    """Serialize a new stake/payment with deletion using the same user row.

    Production callers hold this write in their activity transaction. If
    deletion wins, Mongo retries the activity with a fresh snapshot and this
    predicate refuses it. Settlement/refund paths intentionally never call it.
    """
    kwargs = {"session": session} if session is not None else {}
    user = await database.users.find_one_and_update(
        {"id": user_id, "status": {"$ne": "DELETED"}, "deleted_at": None},
        {"$inc": {"account_activity_serial": 1}},
        return_document=ReturnDocument.AFTER, **kwargs,
    )
    if not user:
        _require_available(await database.users.find_one({"id": user_id}, **kwargs))
        raise HTTPException(status_code=409, detail={
            "code": "ACCOUNT_STATE_CHANGED", "message": "The player account changed. Please retry.",
        })
    return _require_available(user)


def _utc(value):
    try:
        stamp = value if isinstance(value, datetime) else datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return stamp.replace(tzinfo=timezone.utc) if stamp.tzinfo is None else stamp.astimezone(timezone.utc)
    except (TypeError, ValueError):
        return None


def retained_deposit_eligibility_user(user, order):
    """Restore only the historical status for an already-issued paid order.

    The caller still verifies the provider amount/reference and all current
    compliance restrictions. This projection must never authorize checkout.
    """
    if not account_is_deleted(user):
        return user
    created, deleted = _utc(order.get("created_at")), _utc(user.get("deleted_at"))
    if (created and deleted and created <= deleted and order.get("provider_order_id")
            and user.get("deletion_previous_status") == "ACTIVE"):
        return {**user, "status": "ACTIVE", "deleted_at": None}
    return user
