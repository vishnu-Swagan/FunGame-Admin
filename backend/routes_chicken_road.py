"""Dormant, server-authoritative Chicken Road proposal; default approval is false.

Both the reviewed-game gate and explicit rules approval must precede activation.
The aggregate exposure counter is an operator liability limit, not proof of
funding. This module never creates funds or bypasses the shared wallet adapter.
"""
from __future__ import annotations

import copy
import hashlib
import json
import logging
import os
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Path
from pydantic import BaseModel, ConfigDict, Field
from pymongo.errors import DuplicateKeyError

import auth_utils
import bonus_policy
import chicken_road_engine as engine
import compliance
import financial_wallet
import game_wallet
import ledger
from db import client, db
from game_access import require_playable_game
from player_account_state import lock_account_for_new_activity
from transactions import run_game_transaction

SLUG = "chicken-road"
RULES_APPROVED = False
COMMITMENT_SECONDS = 300
EXPIRY_RETRY_SECONDS = 60
router = APIRouter(prefix="/live/chicken-road", tags=["chicken-road"])
logger = logging.getLogger("chicken-road")


class OperationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    operation_id: str = Field(min_length=8, max_length=128, pattern=r"^[A-Za-z0-9_:-]+$")


class PlayRequest(OperationRequest):
    commitment_id: str = Field(min_length=1, max_length=128)
    client_seed: str = Field(pattern=r"^[0-9a-f]{64}$")
    difficulty: Literal["easy", "medium", "hard", "hardcore"]
    amount: int = Field(ge=engine.MIN_STAKE, le=engine.MAX_STAKE, multiple_of=engine.STAKE_STEP)
    rules_version: str = Field(min_length=1, max_length=80)


class RoundRequest(OperationRequest):
    round_id: str = Field(min_length=1, max_length=128)
    expected_version: int = Field(ge=1, le=engine.MAX_LANES)


def _error(status, code, message):
    return HTTPException(status_code=status, detail={"code": code, "message": message})


def _now():
    return datetime.now(timezone.utc)


def _stamp(value=None):
    return (value or _now()).isoformat()


def _live_enabled():
    return os.environ.get("CHICKEN_ROAD_LIVE_ENABLED", "false").strip().lower() == "true"


def _exposure_limit():
    raw = os.environ.get("CHICKEN_ROAD_EXPOSURE_LIMIT", "")
    if not raw.isascii() or not raw.isdecimal() or not 1 <= int(raw) <= 9_000_000_000_000_000:
        raise _error(503, "CHICKEN_ROAD_EXPOSURE_UNAVAILABLE", "The operator liability limit is not configured.")
    return int(raw)


async def _require_release(*, new_activity=False):
    if not RULES_APPROVED:
        raise _error(503, "CHICKEN_ROAD_DISABLED", "Chicken Road live rules are not approved.")
    if new_activity:
        if not _live_enabled():
            raise _error(409, "CHICKEN_ROAD_PAUSED", "Chicken Road is paused for new play. Existing stakes can still be cashed out.")
        await require_playable_game(SLUG)
        _exposure_limit()


async def _require_wallet_user(user_id, session=None):
    if (ledger._source_wallet_adapter is not game_wallet.ADAPTER
            or not game_wallet.integration_enabled()
            or not (game_wallet.legacy_integration_enabled()
                    or await bonus_policy.user_participates(user_id, session=session))):
        raise _error(503, "CHICKEN_ROAD_WALLET_UNAVAILABLE", "The shared source-aware gameplay wallet is unavailable.")


async def _require_actor(user, session, *, new_activity=False):
    fresh = await db.users.find_one({"id": user["id"]}, session=session)
    if not fresh or fresh.get("deleted_at") or fresh.get("status") == "DELETED":
        raise _error(403, "ACCOUNT_UNAVAILABLE", "The player account is unavailable.")
    if fresh.get("role") != "PLAYER":
        raise _error(403, "NOT_A_PLAYER", "Only player accounts can use this game.")
    if fresh.get("active_session_id") != user.get("active_session_id"):
        raise _error(401, "SESSION_REPLACED", "The player session changed. Sign in again.")
    await auth_utils.require_active_player(fresh)
    await compliance.assert_not_excluded(user["id"], session=session)
    await _require_wallet_user(user["id"], session)
    if new_activity:
        await lock_account_for_new_activity(db, user["id"], session=session)
    return fresh


async def prepare_chicken_road_storage():
    """Explicit deployment preparation only; never invoked at import/request time."""
    await db.chicken_road_rounds.create_index([("status", 1), ("expires_at", 1)])
    await db.chicken_road_rounds.create_index([("user_id", 1), ("created_at", -1)])
    await db.chicken_road_commitments.create_index([("user_id", 1), ("expires_at", 1)])
    await db.chicken_road_operations.create_index([("user_id", 1), ("created_at", 1)])
    # Mongo's intrinsic _id indexes enforce round, per-user active guard,
    # operation receipt, and commitment uniqueness without optional migrations.
    await db.chicken_road_exposure.update_one(
        {"_id": SLUG}, {"$setOnInsert": {"outstanding_chips": 0}}, upsert=True,
    )


def _operation_key(user_id, operation_id):
    return hashlib.sha256(json.dumps([user_id, operation_id], separators=(",", ":")).encode()).hexdigest()


def _fingerprint(action, body):
    return hashlib.sha256(json.dumps([action, body], sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _receipt_result(receipt):
    response = copy.deepcopy(receipt["response"])
    if response.get("status") == "REJECTED":
        error = response["error"]
        raise _error(error["status_code"], error["code"], error["message"])
    return response


async def _receipt(user_id, operation_id, fingerprint, session):
    found = await db.chicken_road_operations.find_one(
        {"_id": _operation_key(user_id, operation_id)}, session=session,
    )
    if found and found["fingerprint"] != fingerprint:
        raise _error(409, "IDEMPOTENCY_CONFLICT", "This operation ID belongs to a different request.")
    return found


async def _store_receipt(user_id, operation_id, fingerprint, response, session):
    receipt = {
        "_id": _operation_key(user_id, operation_id), "user_id": user_id,
        "operation_id": operation_id, "fingerprint": fingerprint,
        "response": copy.deepcopy(response), "created_at": _stamp(),
    }
    await db.chicken_road_operations.insert_one(receipt, session=session)
    return receipt


async def _transaction(callback):
    # A concurrent first insert can produce DuplicateKey rather than Mongo's
    # transient-transaction label. The entire failed transaction is aborted;
    # bounded retries re-read the durable receipt/guard, never replay a debit alone.
    for attempt in range(3):
        try:
            return await run_game_transaction(client, callback)
        except DuplicateKeyError:
            if attempt == 2:
                raise _error(409, "CHICKEN_ROAD_CONFLICT", "Concurrent game activity changed the state. Check the operation receipt.")


async def _operation(user, body, action, callback):
    values = body.model_dump()
    key = body.operation_id
    fingerprint = _fingerprint(action, values)

    async def execute(session):
        old = await _receipt(user["id"], key, fingerprint, session)
        if old:
            return old
        response = await callback(session)
        response["operation_id"] = key
        return await _store_receipt(user["id"], key, fingerprint, response, session)

    try:
        receipt = await _transaction(execute)
    except ledger.InsufficientChips:
        error = _error(409, "INSUFFICIENT_CHIPS", "There are not enough chips for this stake.")
    except financial_wallet.FinancialError as exc:
        error = _error(exc.status_code, exc.code, exc.message)
    except HTTPException as exc:
        error = exc
    else:
        return _receipt_result(receipt)
    if error.status_code >= 500 or error.status_code in {401, 403}:
        raise error
    if isinstance(error.detail, dict) and error.detail.get("code") == "IDEMPOTENCY_CONFLICT":
        raise error

    # The financial transaction has rolled back. Persist a final rejection in
    # a separate transaction; a same-key accepted receipt wins any race here.
    detail = error.detail if isinstance(error.detail, dict) else {"message": str(error.detail)}
    response = {"operation_id": key, "status": "REJECTED", "error": {
        "status_code": error.status_code, "code": detail.get("code", "CHICKEN_ROAD_REJECTED"),
        "message": detail.get("message", "The operation was rejected."),
    }}

    async def reject(session):
        old = await _receipt(user["id"], key, fingerprint, session)
        return old or await _store_receipt(user["id"], key, fingerprint, response, session)

    return _receipt_result(await _transaction(reject))


def _public_round(round_doc):
    if not round_doc:
        return None
    keys = (
        "id", "status", "version", "amount", "difficulty", "lane", "multiplier_hundredths",
        "payout", "rules_version", "fairness_version", "multipliers_hundredths",
        "server_seed_hash", "client_seed", "nonce", "expires_at", "created_at", "settled_at", "reason",
    )
    result = {key: copy.deepcopy(round_doc.get(key)) for key in keys}
    result["cashout_amount"] = _payout(round_doc) if round_doc["status"] == "PLAYING" else 0
    return result


def _assert_rules(round_doc):
    try:
        engine.validate_locked_rules(
            round_doc.get("rules_version"), round_doc.get("fairness_version"),
            round_doc.get("difficulty"), round_doc.get("multipliers_hundredths"),
        )
        engine.validate_stake(round_doc.get("amount"))
    except ValueError as exc:
        raise _error(503, "CHICKEN_ROAD_RULES_UNAVAILABLE", "The locked round rules require reconciliation.") from exc


def _payout(round_doc):
    _assert_rules(round_doc)
    lane = round_doc["lane"]
    if type(lane) is not int or not 1 <= lane <= len(round_doc["multipliers_hundredths"]):
        raise _error(503, "CHICKEN_ROAD_ROUND_INVALID", "The authoritative round requires reconciliation.")
    return round_doc["amount"] * round_doc["multipliers_hundredths"][lane - 1] // 100


async def _balance(user_id, session):
    user = await db.users.find_one({"id": user_id}, {"chip_balance": 1}, session=session)
    if not user:
        raise _error(503, "CHICKEN_ROAD_ACCOUNT_MISSING", "The settlement account requires reconciliation.")
    return int(user["chip_balance"])


async def _claim_active(user_id, round_id, session):
    guard = await db.chicken_road_players.find_one({"_id": user_id}, session=session)
    if guard and guard.get("active_round_id"):
        raise _error(409, "ROUND_ACTIVE", "Finish the existing round before placing another stake.")
    if guard is None:
        await db.chicken_road_players.insert_one({
            "_id": user_id, "active_round_id": round_id, "latest_round_id": None, "version": 1,
        }, session=session)
    else:
        changed = await db.chicken_road_players.update_one(
            {"_id": user_id, "active_round_id": None, "version": guard["version"]},
            {"$set": {"active_round_id": round_id}, "$inc": {"version": 1}}, session=session,
        )
        if changed.modified_count != 1:
            raise _error(409, "ROUND_ACTIVE", "Concurrent activity started another round.")


async def _reserve_exposure(amount, session):
    limit = _exposure_limit()
    changed = await db.chicken_road_exposure.update_one(
        {"_id": SLUG, "outstanding_chips": {"$gte": 0, "$lte": limit - amount}},
        {"$inc": {"outstanding_chips": amount}}, session=session,
    )
    if changed.modified_count != 1:
        raise _error(409, "EXPOSURE_LIMIT", "The operator liability limit cannot accept this round.")


async def _finish(round_doc, session):
    stake = await db.chip_transactions.find_one({
        "user_id": round_doc["user_id"], "kind": ledger.STAKE, "game": SLUG, "ref": round_doc["id"],
    }, session=session)
    if not stake or stake.get("amount") != round_doc["amount"]:
        raise _error(503, "CHICKEN_ROAD_LEDGER_INTEGRITY", "The originating stake requires reconciliation.")
    if round_doc["payout"]:
        await ledger.credit_chips(
            round_doc["user_id"], round_doc["payout"], "Chicken Road cash-out", ref=round_doc["id"],
            kind=ledger.PAYOUT, game=SLUG, source_refs=[round_doc["id"]],
            settlement_ref=round_doc["id"], session=session,
        )
    await ledger.record_settlement(
        round_doc["user_id"], [round_doc["id"]], SLUG, status="SETTLED",
        settlement_ref=round_doc["id"], session=session,
    )
    await db.game_rounds.insert_one({
        "_id": f"chicken-road:{round_doc['id']}", "id": round_doc["id"],
        "user_id": round_doc["user_id"], "slug": SLUG, "game_name": "Chicken Road",
        "bet": round_doc["amount"], "payout": round_doc["payout"], "status": "SETTLED",
        "outcome": {"result": round_doc["status"], "lane": round_doc["lane"],
                    "multiplier_hundredths": round_doc["multiplier_hundredths"], "reason": round_doc["reason"]},
        "created_at": round_doc["created_at"], "settled_at": round_doc["settled_at"],
    }, session=session)
    released = await db.chicken_road_players.update_one(
        {"_id": round_doc["user_id"], "active_round_id": round_doc["id"]},
        {"$set": {"active_round_id": None, "latest_round_id": round_doc["id"]}, "$inc": {"version": 1}},
        session=session,
    )
    exposure = await db.chicken_road_exposure.update_one(
        {"_id": SLUG, "outstanding_chips": {"$gte": round_doc["reserved_exposure"]}},
        {"$inc": {"outstanding_chips": -round_doc["reserved_exposure"]}}, session=session,
    )
    if released.modified_count != 1 or exposure.modified_count != 1:
        raise _error(503, "CHICKEN_ROAD_RESERVATION_INTEGRITY", "The round reservation requires reconciliation.")


async def _transition(current, *, lane, status, reason, session):
    _assert_rules(current)
    stamp = _stamp()
    updated = {**current, "lane": lane, "version": current["version"] + 1, "status": status,
               "multiplier_hundredths": current["multipliers_hundredths"][lane - 1] if status != "CRASHED" else 0,
               "reason": reason, "payout": 0,
               "expires_at": _stamp(_now() + timedelta(seconds=engine.EXPIRY_SECONDS)), "settled_at": None}
    if status != "PLAYING":
        updated["settled_at"] = stamp
        updated["expires_at"] = None
        if status == "CASHED":
            updated["payout"] = _payout(updated)
    changed = await db.chicken_road_rounds.update_one(
        {"_id": current["id"], "user_id": current["user_id"], "status": "PLAYING", "version": current["version"]},
        {"$set": {key: updated[key] for key in (
            "lane", "version", "status", "multiplier_hundredths", "reason", "payout", "expires_at", "settled_at",
        )}}, session=session,
    )
    if changed.modified_count != 1:
        raise _error(409, "ROUND_VERSION_CONFLICT", "The round changed. Reload its authoritative state.")
    if status != "PLAYING":
        await _finish(updated, session)
    return updated


async def _hop(current, session):
    lane = current["lane"] + 1
    _assert_rules(current)
    survived = engine.lane_survives(
        current["server_seed"], current["client_seed"], current["nonce"], current["difficulty"], lane,
        rules_version=current["rules_version"],
    )
    status = "CRASHED" if not survived else "CASHED" if lane == engine.MAX_LANES else "PLAYING"
    return await _transition(current, lane=lane, status=status,
                             reason="COLLISION" if not survived else "FINAL_LANE" if status == "CASHED" else None,
                             session=session)


async def _expire_current(user_id, session, *, expected_round_id=None):
    guard = await db.chicken_road_players.find_one({"_id": user_id}, session=session)
    if not guard or not guard.get("active_round_id"):
        if expected_round_id is not None:
            raise _error(503, "CHICKEN_ROAD_RESERVATION_INTEGRITY", "The expired round has no active reservation.")
        return None
    if expected_round_id is not None and guard["active_round_id"] != expected_round_id:
        raise _error(503, "CHICKEN_ROAD_RESERVATION_INTEGRITY", "The expired round reservation does not match.")
    current = await db.chicken_road_rounds.find_one({"_id": guard["active_round_id"], "user_id": user_id}, session=session)
    if not current or current["status"] != "PLAYING":
        raise _error(503, "CHICKEN_ROAD_RESERVATION_INTEGRITY", "The active round reservation requires reconciliation.")
    if current and current["status"] == "PLAYING" and current["expires_at"] <= _stamp():
        return await _transition(current, lane=current["lane"], status="CASHED", reason="INACTIVITY", session=session)
    return None


async def _mutation_response(round_doc, session):
    return {"result": {"PLAYING": "hopped", "CRASHED": "crashed", "CASHED": "cashed_out"}[round_doc["status"]],
            "balance": await _balance(round_doc["user_id"], session), "round": _public_round(round_doc)}


@router.post("/prepare")
async def prepare_round(body: OperationRequest, user: dict = Depends(auth_utils.require_active_player)):
    await _require_release()
    commitment_id, server_seed = str(uuid.uuid4()), secrets.token_hex(32)
    expires = _stamp(_now() + timedelta(seconds=COMMITMENT_SECONDS))

    async def prepare(session):
        await _require_release(new_activity=True)
        await _require_actor(user, session, new_activity=True)
        doc = {"_id": commitment_id, "user_id": user["id"], "status": "PREPARED", "server_seed": server_seed,
               "server_seed_hash": engine.seed_commitment(server_seed, commitment_id),
               "rules_version": engine.RULES_VERSION, "fairness_version": engine.FAIRNESS_VERSION,
               "expires_at": expires, "created_at": _stamp()}
        await db.chicken_road_commitments.insert_one(doc, session=session)
        return {"commitment_id": commitment_id, "server_seed_hash": doc["server_seed_hash"],
                "rules_version": engine.RULES_VERSION, "fairness_version": engine.FAIRNESS_VERSION,
                "nonce": commitment_id, "expires_at": expires}

    return await _operation(user, body, "PREPARE", prepare)


@router.post("/play")
async def play(body: PlayRequest, user: dict = Depends(auth_utils.require_active_player)):
    await _require_release()
    round_id = str(uuid.uuid4())

    async def accept(session):
        await _require_release(new_activity=True)
        await _require_actor(user, session, new_activity=True)
        if body.rules_version != engine.RULES_VERSION:
            raise _error(409, "RULES_CHANGED", "Refresh and accept the current game rules.")
        commitment = await db.chicken_road_commitments.find_one({"_id": body.commitment_id, "user_id": user["id"]}, session=session)
        if not commitment:
            raise _error(409, "COMMITMENT_UNKNOWN", "Prepare a seed commitment before placing a stake.")
        if commitment["status"] != "PREPARED":
            raise _error(409, "COMMITMENT_USED", "This commitment was already used. Check the existing operation.")
        if commitment["expires_at"] <= _stamp():
            raise _error(409, "COMMITMENT_EXPIRED", "This commitment expired without a stake. Prepare a new one.")
        if (commitment["rules_version"] != body.rules_version
                or commitment.get("fairness_version") != engine.FAIRNESS_VERSION):
            raise _error(409, "RULES_CHANGED", "The prepared rules changed. Prepare a new commitment.")
        await _claim_active(user["id"], round_id, session)
        reserve = engine.payout_chips(body.amount, body.difficulty, engine.MAX_LANES)
        await _reserve_exposure(reserve, session)
        claimed = await db.chicken_road_commitments.update_one(
            {"_id": body.commitment_id, "user_id": user["id"], "status": "PREPARED"},
            {"$set": {"status": "USED", "round_id": round_id}}, session=session,
        )
        if claimed.modified_count != 1:
            raise _error(409, "COMMITMENT_USED", "The commitment was claimed by another request.")
        await ledger.debit_chips(user["id"], body.amount, "Chicken Road stake", ref=round_id,
                                 kind=ledger.STAKE, game=SLUG, settlement_ref=round_id, session=session)
        doc = {"_id": round_id, "id": round_id, "user_id": user["id"], "status": "PLAYING", "version": 0,
               "amount": body.amount, "difficulty": body.difficulty, "lane": 0, "payout": 0,
               "rules_version": engine.RULES_VERSION, "fairness_version": engine.FAIRNESS_VERSION,
               "multipliers_hundredths": list(engine.LADDER_HUNDREDTHS[body.difficulty]),
               "server_seed": commitment["server_seed"], "server_seed_hash": commitment["server_seed_hash"],
               "client_seed": body.client_seed, "nonce": commitment["_id"], "created_at": _stamp(),
               "reserved_exposure": reserve}
        await db.chicken_road_rounds.insert_one(doc, session=session)
        return await _mutation_response(await _hop(doc, session), session)

    return await _operation(user, body, "PLAY", accept)


async def _round_action(body, user, action):
    await _require_release()

    async def execute(session):
        await _require_release(new_activity=action == "GO")
        await _require_actor(user, session, new_activity=action == "GO")
        current = await db.chicken_road_rounds.find_one({"_id": body.round_id, "user_id": user["id"]}, session=session)
        if not current:
            raise _error(404, "ROUND_NOT_FOUND", "This round does not belong to the player.")
        if current["status"] != "PLAYING":
            raise _error(409, "ROUND_FINISHED", "The round already has a terminal result.")
        if current["version"] != body.expected_version:
            raise _error(409, "ROUND_VERSION_CONFLICT", "The round changed. Reload its authoritative state.")
        guard = await db.chicken_road_players.find_one({"_id": user["id"], "active_round_id": current["id"]}, session=session)
        if not guard:
            raise _error(503, "CHICKEN_ROAD_RESERVATION_INTEGRITY", "The active round reservation requires reconciliation.")
        if current["expires_at"] <= _stamp():
            updated = await _transition(current, lane=current["lane"], status="CASHED", reason="INACTIVITY", session=session)
        elif action == "GO":
            updated = await _hop(current, session)
        else:
            updated = await _transition(current, lane=current["lane"], status="CASHED", reason="PLAYER_CASHOUT", session=session)
        return await _mutation_response(updated, session)

    return await _operation(user, body, action, execute)


@router.post("/go")
async def go(body: RoundRequest, user: dict = Depends(auth_utils.require_active_player)):
    return await _round_action(body, user, "GO")


@router.post("/cashout")
async def cashout(body: RoundRequest, user: dict = Depends(auth_utils.require_active_player)):
    return await _round_action(body, user, "CASHOUT")


@router.get("/state")
async def state(user: dict = Depends(auth_utils.require_active_player)):
    await _require_release()

    async def snapshot(session):
        await _require_actor(user, session)
        await _expire_current(user["id"], session)
        guard = await db.chicken_road_players.find_one({"_id": user["id"]}, session=session) or {}
        async def load(key):
            return await db.chicken_road_rounds.find_one({"_id": guard.get(key), "user_id": user["id"]}, session=session) if guard.get(key) else None
        enabled = _live_enabled()
        if enabled:
            try:
                await require_playable_game(SLUG)
            except HTTPException as exc:
                if exc.status_code != 409:
                    raise
                enabled = False
        rules = {**engine.rules_payload(), "approval": "APPROVED" if RULES_APPROVED else "UNAPPROVED"}
        return {"mode": "live", "enabled": enabled, "rules": rules,
                "balance": await _balance(user["id"], session),
                "active_round": _public_round(await load("active_round_id")),
                "latest_round": _public_round(await load("latest_round_id"))}

    return await _transaction(snapshot)


@router.get("/operations/{operation_id}")
async def operation_receipt(
    operation_id: str = Path(min_length=8, max_length=128, pattern=r"^[A-Za-z0-9_:-]+$"),
    user: dict = Depends(auth_utils.require_active_player),
):
    await _require_release()
    found = await db.chicken_road_operations.find_one({"_id": _operation_key(user["id"], operation_id), "user_id": user["id"]})
    return {"found": True, **copy.deepcopy(found["response"])} if found else {"found": False, "operation_id": operation_id}


@router.get("/rounds/{round_id}/fairness")
async def fairness(round_id: str, user: dict = Depends(auth_utils.require_active_player)):
    await _require_release()
    current = await db.chicken_road_rounds.find_one({"_id": round_id, "user_id": user["id"]})
    if not current:
        raise _error(404, "ROUND_NOT_FOUND", "This round does not belong to the player.")
    if current["status"] == "PLAYING":
        raise _error(409, "FAIRNESS_NOT_REVEALED", "The seed is revealed only after the round is settled.")
    if current["status"] not in {"CASHED", "CRASHED"} or not current.get("settled_at"):
        raise _error(503, "CHICKEN_ROAD_ROUND_INVALID", "The authoritative round requires reconciliation.")
    # Historical proof is immutable evidence, not a request to execute today's
    # engine. Preserve its original versions even after a later rules release.
    return {"round_id": current["id"], **{key: current[key] for key in (
        "server_seed", "server_seed_hash", "client_seed", "nonce", "difficulty", "rules_version", "fairness_version", "multipliers_hundredths",
    )}}


async def settle_expired_chicken_rounds(limit=100):
    """Call from a reviewed server worker after activation; no client is required.

    Settlements continue while new play is paused, including for subsequently
    restricted accounts. They never authorize a new stake or a new crossing.
    """
    await _require_release()
    now = _stamp()
    candidates = await db.chicken_road_rounds.find({
        "status": "PLAYING", "expires_at": {"$lte": now},
        "$or": [{"expiry_retry_after": {"$exists": False}}, {"expiry_retry_after": {"$lte": now}}],
    }).sort([("expires_at", 1), ("_id", 1)]).limit(max(1, min(int(limit), 100))).to_list(None)
    settled = 0
    for candidate in candidates:
        async def expire(session):
            # A queued candidate may already have settled or renewed. Otherwise
            # a missing/mismatched active guard is an integrity failure, not a
            # successful skip that could silently starve following batches.
            current = await db.chicken_road_rounds.find_one({
                "_id": candidate["id"], "user_id": candidate["user_id"],
                "status": "PLAYING", "expires_at": {"$lte": _stamp()},
            }, session=session)
            if not current:
                return False
            await _require_wallet_user(candidate["user_id"], session)
            result = await _expire_current(candidate["user_id"], session, expected_round_id=candidate["id"])
            return result is not None
        try:
            settled += bool(await _transaction(expire))
        except Exception:
            # One inconsistent account must not prevent other retained stakes
            # from settling, including when it fills the entire batch. Delay
            # its next attempt without touching its financial reservation.
            logger.exception("Chicken Road expiry requires reconciliation for round %s", candidate["id"])
            try:
                await db.chicken_road_rounds.update_one(
                    {"_id": candidate["id"], "status": "PLAYING", "version": candidate["version"]},
                    {"$set": {"expiry_retry_after": _stamp(_now() + timedelta(seconds=EXPIRY_RETRY_SECONDS))}},
                )
            except Exception:
                logger.exception("Could not schedule Chicken Road reconciliation retry for round %s", candidate["id"])
    return settled
