"""Five-seat, server-authoritative Indian Rummy API.

The browser receives one private hand: its own.  Rooms, turns, shuffle proof,
actions, chip stakes and settlement are persisted in MongoDB and all
balance-coupled mutations run in one transaction.
"""
from __future__ import annotations

import asyncio
import copy
import re
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator
from pymongo.errors import DuplicateKeyError

from auth_utils import require_active_player, require_admin
from db import client, db, serialize_doc
from game_access import require_playable_game
from ledger import InsufficientChips, credit_chips, debit_chips
import ledger
import rummy
from transactions import run_game_transaction


router = APIRouter(tags=["rummy"])
RUMMY_STATES = frozenset({
    "LOBBY", "MATCHMAKING", "WAITING_FOR_PLAYERS", "SEATING",
    "ROUND_STARTING", "SHUFFLING", "DEALING", "TURN_ACTIVE",
    "DECLARATION_PENDING", "DECLARATION_VALIDATING", "ROUND_SETTLING",
    "ROUND_SETTLED", "RECONNECTING", "CANCELLED",
})
ACTIVE_SEAT_STATES = ("ACTIVE", "RECONNECTING")
BOT_NAMES = ("Mira", "Arjun", "Leela", "Kabir")
MAX_AUTOMATED_TURNS_PER_REQUEST = 12
MAX_ROUND_TURNS = 100
DEFAULT_RUMMY_SKILL_RATING = 500
PRESENCE_STALE_SECONDS = 6
CATEGORY_SNAPSHOT_FIELDS = (
    "id", "displayName", "entryChips", "pointsValue", "minChipBalance",
    "maxChipBalance", "turnDurationSeconds", "skillRatingMin",
    "skillRatingMax", "reconnectAllowanceSeconds", "practiceBotDifficulty",
    "firstDropPoints", "middleDropPoints", "invalidDeclarationPoints",
    "maxPlayers", "enabled", "displayOrder", "accent",
)


def _now_iso():
    return datetime.now(timezone.utc).isoformat()


def _epoch():
    return time.time()


def _kwargs(session):
    return {"session": session} if session is not None else {}


def _fail(status: int, code: str, message: str):
    raise HTTPException(status_code=status, detail={"code": code, "message": message})


class JoinRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    categoryId: str = Field(default="LV1", pattern=r"^LV[1-5]$")
    mode: Literal["LIVE", "PRACTICE"] = "LIVE"


class RummyAction(BaseModel):
    model_config = ConfigDict(extra="forbid")

    roomId: str = Field(min_length=8, max_length=64)
    roundId: Optional[str] = Field(default=None, max_length=64)
    actionId: str = Field(min_length=8, max_length=96)
    expectedVersion: int = Field(ge=0)
    actionType: str = Field(min_length=2, max_length=32)
    actionPayload: dict = Field(default_factory=dict)
    clientTimestamp: float

    @field_validator("actionType")
    @classmethod
    def canonical_action(cls, value):
        canonical = value.strip().upper()
        allowed = {
            "READY", "HEARTBEAT", "DRAW_CLOSED", "DRAW_DISCARD", "DISCARD",
            "SORT", "GROUP", "UNGROUP", "DECLARE", "DROP", "RECONNECT", "LEAVE",
        }
        if canonical not in allowed:
            raise ValueError("unsupported Rummy action")
        return canonical


class RummyChatCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    body: str = Field(min_length=1, max_length=180)

    @field_validator("body")
    @classmethod
    def clean_body(cls, value):
        cleaned = re.sub(r"\s+", " ", re.sub(r"[\x00-\x1f\x7f]", " ", value)).strip()
        if not cleaned:
            raise ValueError("message cannot be empty")
        return cleaned


class CategoryPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    displayName: Optional[str] = Field(default=None, min_length=2, max_length=30)
    entryChips: Optional[int] = Field(default=None, ge=1, le=10_000_000)
    pointsValue: Optional[int] = Field(default=None, ge=1, le=10_000)
    minChipBalance: Optional[int] = Field(default=None, ge=0, le=100_000_000)
    maxChipBalance: Optional[int] = Field(default=None, ge=1, le=100_000_000)
    turnDurationSeconds: Optional[int] = Field(default=None, ge=10, le=90)
    skillRatingMin: Optional[int] = Field(default=None, ge=0, le=100_000)
    skillRatingMax: Optional[int] = Field(default=None, ge=1, le=100_000)
    reconnectAllowanceSeconds: Optional[int] = Field(default=None, ge=5, le=120)
    practiceBotDifficulty: Optional[str] = Field(default=None, min_length=2, max_length=24)
    firstDropPoints: Optional[int] = Field(default=None, ge=0, le=80)
    middleDropPoints: Optional[int] = Field(default=None, ge=0, le=80)
    invalidDeclarationPoints: Optional[int] = Field(default=None, ge=0, le=80)
    enabled: Optional[bool] = None
    displayOrder: Optional[int] = Field(default=None, ge=1, le=5)


async def ensure_rummy_core():
    """Create Rummy indexes and the five idempotent centrally managed categories."""
    await db.rummy_rooms.create_index("id", unique=True)
    await db.rummy_rooms.create_index([("category_id", 1), ("mode", 1), ("state", 1), ("seat_count", 1)])
    await db.rummy_seats.create_index([("room_id", 1), ("seat_index", 1)], unique=True)
    await db.rummy_seats.create_index(
        [("room_id", 1), ("user_id", 1)], unique=True,
        partialFilterExpression={"user_id": {"$type": "string"}},
    )
    # One sparse lock per real player prevents simultaneous seats in different
    # rooms.  Settlement/cancellation removes the key; bots never receive it.
    await db.rummy_seats.create_index("active_user_key", unique=True, sparse=True)
    await db.rummy_hands.create_index([("room_id", 1), ("round_id", 1), ("user_id", 1)], unique=True)
    await db.rummy_actions.create_index([("room_id", 1), ("user_id", 1), ("action_id", 1)], unique=True)
    await db.rummy_chat.create_index("id", unique=True)
    await db.rummy_chat.create_index([("room_id", 1), ("created_at", -1)])
    await db.rummy_chat.create_index("created_at", expireAfterSeconds=86_400, name="rummy_chat_24h")
    await db.rummy_categories.create_index("id", unique=True)
    await db.game_rounds.create_index(
        [("slug", 1), ("round_id", 1), ("user_id", 1)],
        unique=True,
        partialFilterExpression={"slug": "rummy", "round_id": {"$type": "string"}},
        name="rummy_settlement_once",
    )
    for category in rummy.RUMMY_CATEGORIES:
        await db.rummy_categories.update_one(
            {"id": category["id"]},
            {"$setOnInsert": {**copy.deepcopy(category), "created_at": _now_iso()}},
            upsert=True,
        )
        # Backfill newly centralised rule fields without overwriting a later
        # operator choice on an already-seeded category.
        for field in ("firstDropPoints", "middleDropPoints", "invalidDeclarationPoints"):
            await db.rummy_categories.update_one(
                {"id": category["id"], field: {"$exists": False}},
                {"$set": {field: int(category[field])}},
            )


async def _categories(session=None):
    rows = await db.rummy_categories.find(
        {}, {"_id": 0}, **_kwargs(session),
    ).sort("displayOrder", 1).to_list(10)
    if not rows:
        return [copy.deepcopy(row) for row in rummy.RUMMY_CATEGORIES]
    return rows


async def _category(category_id: str, session=None, *, require_enabled: bool = True):
    row = await db.rummy_categories.find_one({"id": category_id}, {"_id": 0}, **_kwargs(session))
    if not row:
        row = rummy.category_map().get(category_id)
    if not row or (require_enabled and not row.get("enabled", True)):
        _fail(409, "RUMMY_CATEGORY_UNAVAILABLE", "That Rummy table is not available.")
    if int(row.get("maxPlayers", 0)) != rummy.MAX_PLAYERS:
        _fail(503, "RUMMY_CATEGORY_INVALID", "The table configuration is unavailable.")
    return row


def _freeze_category(category: dict) -> dict:
    """Copy every rule that may affect an already-created room.

    Admin category edits are intentionally prospective.  A room never reads
    mutable entry, timing, reconnect, scoring or skill rules after creation.
    """
    snapshot = {
        field: copy.deepcopy(category[field])
        for field in CATEGORY_SNAPSHOT_FIELDS
        if field in category
    }
    if not snapshot.get("id") or int(snapshot.get("maxPlayers", 0)) != rummy.MAX_PLAYERS:
        _fail(503, "RUMMY_CATEGORY_INVALID", "The table configuration is unavailable.")
    if int(snapshot.get("entryChips", 0)) <= 0:
        _fail(503, "RUMMY_CATEGORY_INVALID", "The table entry configuration is unavailable.")
    return snapshot


async def _room_category(room: dict, session=None) -> dict:
    """Return the immutable room rules, including when its category is disabled.

    The fallback keeps pre-snapshot rooms readable during a rolling deployment;
    every newly-created room always stores ``category_snapshot``.
    """
    snapshot = room.get("category_snapshot")
    if snapshot:
        return _freeze_category(snapshot)
    category = await _category(room["category_id"], session, require_enabled=False)
    return _freeze_category(category)


def _player_skill_rating(user: dict) -> int:
    try:
        return max(0, int(user.get("rummy_skill_rating", DEFAULT_RUMMY_SKILL_RATING)))
    except (TypeError, ValueError):
        return DEFAULT_RUMMY_SKILL_RATING


def _assert_live_skill_eligible(user: dict, category: dict):
    rating = _player_skill_rating(user)
    minimum = int(category.get("skillRatingMin", 0))
    maximum = int(category.get("skillRatingMax", 100_000))
    if rating < minimum or rating > maximum:
        _fail(
            409,
            "RUMMY_SKILL_RATING_OUT_OF_RANGE",
            f"This live table accepts Rummy ratings from {minimum} to {maximum}.",
        )


def _iso_to_epoch(value) -> float:
    if isinstance(value, (int, float)):
        return float(value)
    if not value:
        return 0.0
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except (TypeError, ValueError):
        return 0.0


def _presence_transition(seat: dict, category: dict, now: float) -> dict | None:
    """Return the next persisted presence state, or ``None`` when unchanged."""
    if seat.get("is_bot") or seat.get("status") not in ACTIVE_SEAT_STATES:
        return None
    if seat.get("status") == "ACTIVE":
        last_seen = float(seat.get("last_seen_epoch") or _iso_to_epoch(seat.get("last_seen_at")))
        if last_seen and now - last_seen < PRESENCE_STALE_SECONDS:
            return None
        allowance = int(category.get("reconnectAllowanceSeconds", 20))
        return {
            "status": "RECONNECTING",
            "reconnect_started_epoch": now,
            "reconnect_deadline": now + allowance,
            "reconnecting_at": _now_iso(),
        }
    deadline = float(seat.get("reconnect_deadline") or 0)
    if deadline and now < deadline:
        return None
    points = int(
        category.get("firstDropPoints", 20)
        if int(seat.get("turns_taken", 0)) == 0
        else category.get("middleDropPoints", 40)
    )
    return {
        "status": "DROPPED", "drop_points": points,
        "disconnect_expired_at": _now_iso(),
    }


def _turn_deadline_expired(room: dict, now: float | None = None) -> bool:
    deadline = room.get("turn_deadline")
    return bool(deadline is not None and float(deadline) <= (now if now is not None else _epoch()))


async def _best_arrangement(cards: list[dict], wild_rank: int) -> dict:
    return await asyncio.to_thread(rummy.best_arrangement, cards, wild_rank)


async def _choose_bot_discard(cards: list[dict], wild_rank: int) -> dict:
    return await asyncio.to_thread(rummy.choose_bot_discard, cards, wild_rank)


def _choose_indicator(deck: list[dict]):
    parked = []
    while deck:
        card = deck.pop()
        if not card.get("printedJoker"):
            deck[:0] = parked
            return card
        parked.append(card)
    raise RuntimeError("Rummy deck did not contain a wild-joker indicator")


async def _start_round(room: dict, category: dict, session):
    category = _freeze_category(room.get("category_snapshot") or category)
    kwargs = _kwargs(session)
    seats = await db.rummy_seats.find(
        {
            "room_id": room["id"],
            "status": {"$in": list(ACTIVE_SEAT_STATES)},
            "user_id": {"$type": "string"},
        },
        {"_id": 0}, **kwargs,
    ).sort("seat_index", 1).to_list(rummy.MAX_PLAYERS)
    if len(seats) != rummy.MAX_PLAYERS:
        _fail(409, "RUMMY_TABLE_NOT_FULL", "Five seats are required to start a round.")

    deck, proof = rummy.secure_shuffle(rummy.new_deck())
    round_id = str(uuid.uuid4())
    hands = {seat["user_id"]: [] for seat in seats}
    for _ in range(rummy.HAND_SIZE):
        for seat in seats:
            hands[seat["user_id"]].append(deck.pop())
    indicator = _choose_indicator(deck)
    first_discard = deck.pop()
    now = _now_iso()
    await db.rummy_hands.insert_many([
        {
            "room_id": room["id"], "round_id": round_id,
            "user_id": seat["user_id"], "seat_index": seat["seat_index"],
            "cards": hands[seat["user_id"]], "groups": [], "drawn": False,
            "draw_source": None, "updated_at": now,
        }
        for seat in seats
    ], **kwargs)
    room.update({
        "state": "TURN_ACTIVE", "round_id": round_id,
        "version": int(room.get("version", 0)) + 1,
        "current_seat": 0, "turn_deadline": _epoch() + int(category["turnDurationSeconds"]),
        "turn_count": 0, "closed_deck": deck, "discard_pile": [first_discard],
        "wild_joker": indicator, "wild_rank": int(indicator["rank"]),
        "shuffle_seed": proof.pop("seed"), "shuffle_proof": proof,
        "started_at": now, "updated_at": now,
    })
    await db.rummy_rooms.replace_one({"id": room["id"]}, room, **kwargs)
    return room


async def _public_state(room: dict, requester_id: str, session=None):
    kwargs = _kwargs(session)
    seats = await db.rummy_seats.find(
        {"room_id": room["id"]}, {"_id": 0, "room_id": 0, "round_id": 0}, **kwargs,
    ).sort("seat_index", 1).to_list(rummy.MAX_PLAYERS)
    hands = await db.rummy_hands.find(
        {"room_id": room["id"], "round_id": room.get("round_id")},
        {"_id": 0}, **kwargs,
    ).to_list(rummy.MAX_PLAYERS) if room.get("round_id") else []
    hand_by_user = {hand["user_id"]: hand for hand in hands if hand.get("user_id")}
    request_hand = hand_by_user.get(requester_id)
    requester_seat = next((seat for seat in seats if seat.get("user_id") == requester_id), None)
    category = await _room_category(room, session)
    user = await db.users.find_one({"id": requester_id}, {"_id": 0, "chip_balance": 1}, **kwargs)
    chat_rows = await db.rummy_chat.find(
        {"room_id": room["id"]}, {"_id": 0}, **kwargs,
    ).sort("created_at", -1).to_list(40)
    chat_rows.reverse()
    public_chat_rows = [
        {
            key: value for key, value in row.items()
            if key not in {"user_id", "room_id", "round_id"}
        }
        for row in chat_rows
    ]
    remaining = None
    if room.get("state") == "TURN_ACTIVE" and room.get("turn_deadline"):
        remaining = max(0.0, round(float(room["turn_deadline"]) - _epoch(), 3))

    seat_rows = []
    for seat_index in range(rummy.MAX_PLAYERS):
        seat = next((item for item in seats if item.get("seat_index") == seat_index and item.get("user_id")), None)
        if not seat:
            seat_rows.append({"seatIndex": seat_index, "status": "EMPTY", "cardCount": 0})
            continue
        hand = hand_by_user.get(seat["user_id"])
        seat_rows.append({
            "seatIndex": seat_index,
            "playerId": rummy.masked_player_id(seat["user_id"]),
            "displayName": seat.get("display_name") or ("Practice Bot" if seat.get("is_bot") else "Player"),
            "avatar": seat.get("avatar") or "crown",
            "isBot": bool(seat.get("is_bot")),
            "status": seat.get("status", "ACTIVE"),
            "cardCount": len(hand.get("cards", [])) if hand else 0,
            "active": room.get("state") == "TURN_ACTIVE" and room.get("current_seat") == seat_index,
            "droppedPoints": seat.get("drop_points"),
        })

    private = None
    if request_hand:
        arrangement = await _best_arrangement(request_hand["cards"], int(room["wild_rank"]))
        owns_live_turn = (
            room.get("state") == "TURN_ACTIVE"
            and room.get("current_seat") == request_hand["seat_index"]
            and (requester_seat or {}).get("status") == "ACTIVE"
            and not _turn_deadline_expired(room)
        )
        private = {
            "seatIndex": request_hand["seat_index"],
            "cards": request_hand["cards"],
            "groups": request_hand.get("groups", []),
            "drawn": bool(request_hand.get("drawn")),
            "drawnCardId": request_hand.get("drawn_card_id"),
            "suggestedGroups": arrangement["groups"],
            "ungroupedCardIds": arrangement["ungroupedCardIds"],
            "points": arrangement["score"],
            "canDraw": (
                owns_live_turn and not request_hand.get("drawn")
            ),
            "canDiscard": (
                owns_live_turn and bool(request_hand.get("drawn"))
            ),
            "canDeclare": bool(owns_live_turn and arrangement["valid"] and not request_hand.get("drawn")),
        }

    top_discard = room.get("discard_pile", [])[-1] if room.get("discard_pile") else None
    proof = copy.deepcopy(room.get("shuffle_proof", {}))
    if room.get("state") in ("ROUND_SETTLED", "CANCELLED"):
        proof["seedReveal"] = room.get("shuffle_seed")
    return {
        "roomId": room["id"], "roundId": room.get("round_id"),
        "mode": room["mode"], "state": room["state"], "version": room["version"],
        "serverTimestamp": _epoch(), "category": category,
        "maxPlayers": rummy.MAX_PLAYERS, "seats": seat_rows,
        "currentSeat": room.get("current_seat"), "turnEndsIn": remaining,
        "closedDeckCount": len(room.get("closed_deck", [])),
        "openDiscard": top_discard, "wildJoker": room.get("wild_joker"),
        "privateState": private, "result": room.get("result"),
        "chat": serialize_doc(public_chat_rows),
        "shuffleProof": proof, "balance": int((user or {}).get("chip_balance", 0)),
    }


async def _latest_membership(user_id: str, session=None):
    seat = await db.rummy_seats.find_one(
        {"user_id": user_id, "status": {"$in": ["ACTIVE", "RECONNECTING", "DROPPED", "WON", "LOST"]}},
        {"_id": 0}, sort=[("joined_at", -1)], **_kwargs(session),
    )
    if not seat:
        return None, None
    room = await db.rummy_rooms.find_one({"id": seat["room_id"]}, {"_id": 0}, **_kwargs(session))
    if not room or room.get("state") in ("CANCELLED",) and not room.get("round_id"):
        return None, None
    return seat, room


@router.get("/games/rummy/categories")
async def rummy_categories(user: dict = Depends(require_active_player)):
    await require_playable_game("rummy")
    rows = await _categories()
    return {"categories": serialize_doc(rows), "maxPlayers": rummy.MAX_PLAYERS, "currency": None, "unit": "chips"}


@router.post("/games/rummy/join")
async def rummy_join(body: JoinRequest, user: dict = Depends(require_active_player)):
    await require_playable_game("rummy")

    async def join_transaction(session):
        kwargs = _kwargs(session)
        existing_seat, existing_room = await _latest_membership(user["id"], session)
        if existing_seat and existing_room and existing_room.get("state") not in ("ROUND_SETTLED", "CANCELLED"):
            if existing_room.get("mode") == body.mode:
                if body.mode == "PRACTICE" and existing_room.get("state") == "WAITING_FOR_PLAYERS":
                    real_seats = await db.rummy_seats.find({
                        "room_id": existing_room["id"],
                        "is_bot": {"$ne": True},
                        "user_id": {"$type": "string"},
                    }, {"_id": 0}, **kwargs).to_list(rummy.MAX_PLAYERS)
                    if len(real_seats) == 1 and real_seats[0].get("user_id") == user["id"]:
                        category = await _room_category(existing_room, session)
                        await db.rummy_seats.delete_many({
                            "room_id": existing_room["id"],
                            "$or": [{"is_bot": True}, {"user_id": {"$exists": False}}],
                        }, **kwargs)
                        occupied = {int(real_seats[0]["seat_index"])}
                        free = [index for index in range(rummy.MAX_PLAYERS) if index not in occupied]
                        now_epoch = _epoch()
                        await db.rummy_seats.insert_many([
                            {
                                "room_id": existing_room["id"],
                                "user_id": f"BOT:{existing_room['id']}:{bot_number}",
                                "seat_index": seat_index,
                                "display_name": BOT_NAMES[bot_number - 1],
                                "avatar": ("sun", "moon", "gem", "spade")[bot_number - 1],
                                "is_bot": True, "status": "ACTIVE",
                                "entry_chips": int(category["entryChips"]),
                                "wallet_stake_chips": 0,
                                "turns_taken": 0, "missed_turns": 0,
                                "joined_at": _now_iso(), "last_seen_at": _now_iso(),
                                "last_seen_epoch": now_epoch,
                            }
                            for bot_number, seat_index in enumerate(free, start=1)
                        ], **kwargs)
                        existing_room["seat_count"] = rummy.MAX_PLAYERS
                        existing_room = await _start_round(existing_room, category, session)
                return await _public_state(existing_room, user["id"], session)
            if existing_room.get("state") != "WAITING_FOR_PLAYERS":
                _fail(409, "RUMMY_MODE_SWITCH_BLOCKED", "Finish or leave the current Rummy round before changing mode.")
            refund_amount = _waiting_refund_amount(existing_seat)
            released = await db.rummy_seats.delete_one({
                "room_id": existing_room["id"],
                "user_id": user["id"],
                "status": {"$in": list(ACTIVE_SEAT_STATES)},
            }, **kwargs)
            if released.deleted_count != 1:
                _fail(409, "RUMMY_SEAT_INACTIVE", "The previous Rummy seat could not be released.")
            if refund_amount:
                await credit_chips(
                    user["id"], refund_amount, "Rummy mode changed during matchmaking",
                    ref=f"{existing_seat.get('stake_ref') or existing_room['id']}:refund",
                    kind=ledger.REFUND, game="rummy", session=session,
                )
            existing_room.update({
                "seat_count": max(0, int(existing_room.get("seat_count", 1)) - 1),
                "version": int(existing_room.get("version", 0)) + 1,
                "updated_at": _now_iso(),
            })
            await db.rummy_rooms.replace_one({"id": existing_room["id"]}, existing_room, **kwargs)

        current_category = await _category(body.categoryId, session)

        room = None
        if body.mode == "LIVE":
            room = await db.rummy_rooms.find_one(
                {
                    "category_id": body.categoryId, "mode": "LIVE",
                    "state": "WAITING_FOR_PLAYERS", "seat_count": {"$lt": rummy.MAX_PLAYERS},
                }, {"_id": 0}, sort=[("created_at", 1)], **kwargs,
            )
        if not room:
            room = {
                "id": str(uuid.uuid4()), "category_id": body.categoryId,
                "category_snapshot": _freeze_category(current_category),
                "mode": body.mode, "state": "WAITING_FOR_PLAYERS", "version": 0,
                "seat_count": 0, "max_players": rummy.MAX_PLAYERS,
                "created_at": _now_iso(), "updated_at": _now_iso(),
            }
            await db.rummy_rooms.insert_one(copy.deepcopy(room), **kwargs)

        # The current category controls whether new joins are open.  Once a
        # room exists, its frozen snapshot controls every economic/game rule.
        category = await _room_category(room, session)
        current_user = await db.users.find_one({"id": user["id"]}, {"_id": 0}, **kwargs)
        if not current_user:
            _fail(404, "RUMMY_PLAYER_NOT_FOUND", "The player account could not be restored.")
        balance = int(current_user.get("chip_balance", 0))
        if body.mode == "LIVE":
            _assert_live_skill_eligible(current_user, category)
            min_balance = max(int(category["minChipBalance"]), int(category["entryChips"]))
            if balance < min_balance:
                _fail(409, "RUMMY_BALANCE_TOO_LOW", f"This table requires at least {min_balance} chips.")
            maximum = category.get("maxChipBalance")
            if maximum is not None and balance > int(maximum):
                _fail(409, "RUMMY_BALANCE_TOO_HIGH", "Choose a higher Rummy category for this balance.")

        occupied = await db.rummy_seats.distinct("seat_index", {"room_id": room["id"]}, **kwargs)
        free = [index for index in range(rummy.MAX_PLAYERS) if index not in occupied]
        if not free:
            _fail(409, "RUMMY_TABLE_FULL", "That table filled before you joined. Try again.")
        seat_index = free[0]
        stake_ref = f"rummy-seat:{room['id']}:{user['id']}"
        wallet_stake = 0
        if body.mode == "LIVE":
            wallet_stake = int(category["entryChips"])
            try:
                await debit_chips(
                    user["id"], wallet_stake,
                    f"Rummy {body.categoryId} table entry", ref=stake_ref,
                    kind=ledger.STAKE, game="rummy", session=session,
                )
            except InsufficientChips:
                _fail(409, "INSUFFICIENT_CHIPS", "Not enough chips for this Rummy table.")

        now_epoch = _epoch()
        seat = {
            "room_id": room["id"], "user_id": user["id"], "seat_index": seat_index,
            "active_user_key": user["id"],
            "display_name": user.get("display_name") or "Player", "avatar": user.get("avatar") or "crown",
            "is_bot": False, "status": "ACTIVE", "entry_chips": int(category["entryChips"]),
            "wallet_stake_chips": wallet_stake,
            "turns_taken": 0, "missed_turns": 0, "stake_ref": stake_ref if wallet_stake else None,
            "joined_at": _now_iso(), "last_seen_at": _now_iso(), "last_seen_epoch": now_epoch,
        }
        await db.rummy_seats.insert_one(seat, **kwargs)
        room["seat_count"] = int(room.get("seat_count", 0)) + 1

        if body.mode == "PRACTICE":
            bots = []
            for index, name in enumerate(BOT_NAMES, start=1):
                bots.append({
                    "room_id": room["id"], "user_id": f"BOT:{room['id']}:{index}",
                    "seat_index": index, "display_name": name, "avatar": ("sun", "moon", "gem", "spade")[index - 1],
                    "is_bot": True, "status": "ACTIVE", "entry_chips": int(category["entryChips"]),
                    "wallet_stake_chips": 0,
                    "turns_taken": 0, "missed_turns": 0,
                    "joined_at": _now_iso(), "last_seen_at": _now_iso(), "last_seen_epoch": now_epoch,
                })
            await db.rummy_seats.insert_many(bots, **kwargs)
            room["seat_count"] = rummy.MAX_PLAYERS

        if room["seat_count"] == rummy.MAX_PLAYERS:
            room = await _start_round(room, category, session)
        else:
            room["version"] = int(room.get("version", 0)) + 1
            room["updated_at"] = _now_iso()
            await db.rummy_rooms.replace_one({"id": room["id"]}, room, **kwargs)
        return await _public_state(room, user["id"], session)

    try:
        return await run_game_transaction(client, join_transaction)
    except DuplicateKeyError:
        # A concurrent join may have won the unique active-player lock. Return
        # that authoritative membership instead of creating a second seat.
        existing_seat, existing_room = await _latest_membership(user["id"])
        if existing_seat and existing_room:
            return await _public_state(existing_room, user["id"])
        _fail(409, "RUMMY_ALREADY_SEATED", "This player already occupies a Rummy seat.")


async def _load_membership(room_id: str, user_id: str, session=None):
    kwargs = _kwargs(session)
    room = await db.rummy_rooms.find_one({"id": room_id}, {"_id": 0}, **kwargs)
    if not room:
        _fail(404, "RUMMY_ROOM_NOT_FOUND", "That Rummy table no longer exists.")
    seat = await db.rummy_seats.find_one(
        {"room_id": room_id, "user_id": user_id}, {"_id": 0}, **kwargs,
    )
    if not seat:
        _fail(403, "RUMMY_NOT_A_MEMBER", "You do not occupy a seat at this table.")
    return room, seat


def _waiting_refund_amount(seat: dict) -> int:
    """Return the immutable stake for one still-active waiting seat.

    A different action id must never turn an already-left seat into another
    refund. The database mutation below also claims the seat conditionally,
    but this guard gives legacy inactive rows a stable rejection.
    """
    if seat.get("status") not in ACTIVE_SEAT_STATES:
        _fail(409, "RUMMY_SEAT_INACTIVE", "This Rummy seat is no longer active.")
    amount = _seat_wallet_stake_chips(seat)
    if amount < 0:
        _fail(409, "RUMMY_STAKE_INVALID", "The original Rummy stake could not be restored.")
    return amount


async def _replace_room_cas(room: dict, expected_version: int, session=None):
    result = await db.rummy_rooms.replace_one(
        {"id": room["id"], "version": expected_version}, room, **_kwargs(session),
    )
    if result.modified_count != 1:
        _fail(409, "RUMMY_STALE_VERSION", "The table changed. Your latest state is being restored.")


async def _active_seats(room_id: str, session=None):
    return await db.rummy_seats.find(
        {"room_id": room_id, "status": {"$in": list(ACTIVE_SEAT_STATES)}},
        {"_id": 0}, **_kwargs(session),
    ).sort("seat_index", 1).to_list(rummy.MAX_PLAYERS)


async def _next_active_seat(room_id: str, current: int, session=None):
    seats = await _active_seats(room_id, session)
    indexes = sorted(seat["seat_index"] for seat in seats)
    if not indexes:
        return None
    return next((index for index in indexes if index > current), indexes[0])


async def _replenish_closed_deck(room: dict):
    """Reuse covered discards with a new committed shuffle when necessary."""
    if room.get("closed_deck"):
        return True
    discard = room.get("discard_pile", [])
    if len(discard) <= 1:
        return False
    top = discard[-1]
    shuffled, proof = rummy.secure_shuffle(discard[:-1])
    seed = proof.pop("seed")
    room["closed_deck"] = shuffled
    room["discard_pile"] = [top]
    room.setdefault("reshuffle_proofs", []).append({**proof, "seed": seed})
    return True


async def _cancel_room(room: dict, reason: str, session):
    if room.get("state") == "CANCELLED":
        return
    await _room_category(room, session)
    seats = await db.rummy_seats.find(
        {"room_id": room["id"], "is_bot": False}, {"_id": 0}, **_kwargs(session),
    ).to_list(rummy.MAX_PLAYERS)
    for seat in seats:
        refund = _seat_wallet_stake_chips(seat)
        if refund:
            await credit_chips(
                seat["user_id"], refund,
                f"Rummy round cancelled: {reason}",
                ref=f"{seat.get('stake_ref') or room.get('round_id') or room['id']}:refund",
                kind=ledger.REFUND, game="rummy", session=session,
            )
    await db.rummy_seats.update_many(
        {"room_id": room["id"]},
        {"$set": {"status": "CANCELLED"}, "$unset": {"active_user_key": ""}},
        **_kwargs(session),
    )
    room.update({
        "state": "CANCELLED", "current_seat": None, "turn_deadline": None,
        "cancel_reason": reason, "settled_at": _now_iso(),
        "version": int(room["version"]) + 1, "updated_at": _now_iso(),
    })


async def _settle_room(room: dict, winner_user_id: str, reason: str, session):
    if room.get("state") == "ROUND_SETTLED":
        return
    kwargs = _kwargs(session)
    category = await _room_category(room, session)
    seats = await db.rummy_seats.find(
        {"room_id": room["id"]}, {"_id": 0}, **kwargs,
    ).sort("seat_index", 1).to_list(rummy.MAX_PLAYERS)
    hands = await db.rummy_hands.find(
        {"room_id": room["id"], "round_id": room["round_id"]}, {"_id": 0}, **kwargs,
    ).to_list(rummy.MAX_PLAYERS)
    by_user = {hand["user_id"]: hand for hand in hands}
    winner_seat = next((seat for seat in seats if seat["user_id"] == winner_user_id), None)
    if not winner_seat:
        raise RuntimeError("Rummy winner is not seated")

    human_winner = not winner_seat.get("is_bot")
    amounts = _settlement_amounts(
        seats, winner_is_bot=not human_winner, mode=room.get("mode"),
    )
    pot = amounts["pot"]
    winner_payout = amounts["humanPayout"]
    if winner_payout:
        await credit_chips(
            winner_user_id, winner_payout, f"Rummy {category['id']} round win",
            ref=room["round_id"], kind=ledger.PAYOUT, game="rummy", session=session,
        )

    arrangements = await asyncio.gather(*[
        _best_arrangement(
            by_user.get(seat["user_id"], {"cards": []}).get("cards", []),
            int(room["wild_rank"]),
        )
        for seat in seats
    ])
    rows = []
    for seat, arrangement in zip(seats, arrangements):
        hand = by_user.get(seat["user_id"], {"cards": []})
        entry = _seat_entry_chips(seat)
        wallet_entry = _seat_wallet_stake_chips(seat)
        won = seat["user_id"] == winner_user_id
        points = 0 if won else int(seat.get("drop_points", arrangement["score"]))
        rows.append({
            "seatIndex": seat["seat_index"],
            "playerId": rummy.masked_player_id(seat["user_id"]),
            "displayName": seat.get("display_name") or "Player",
            "status": "WON" if won else ("DROPPED" if seat.get("status") == "DROPPED" else "LOST"),
            "points": points, "chipDelta": (winner_payout if won else 0) - wallet_entry,
            "virtualEntryChips": entry,
            "groups": arrangement["groups"], "cards": hand.get("cards", []),
        })
        await db.rummy_seats.update_one(
            {"room_id": room["id"], "user_id": seat["user_id"]},
            {
                "$set": {"status": "WON" if won else "LOST", "result_points": points},
                "$unset": {"active_user_key": ""},
            },
            **kwargs,
        )
        if not seat.get("is_bot"):
            await db.game_rounds.insert_one({
                "id": str(uuid.uuid4()), "round_id": room["round_id"],
                "user_id": seat["user_id"], "slug": "rummy", "game_name": "Rummy",
                "bet": wallet_entry, "payout": winner_payout if won else 0,
                "status": "SETTLED", "outcome": {
                    "category_id": category["id"], "mode": room["mode"],
                    "winner": rummy.masked_player_id(winner_user_id),
                    "won": won, "points": points, "reason": reason,
                    "deck_hash": room.get("shuffle_proof", {}).get("deckHash"),
                    "shuffle_version": room.get("shuffle_proof", {}).get("shuffleVersion"),
                },
                "created_at": room.get("started_at") or _now_iso(), "settled_at": _now_iso(),
            }, **kwargs)

    room.update({
        "state": "ROUND_SETTLED", "current_seat": None, "turn_deadline": None,
        "result": {
            "winnerSeat": winner_seat["seat_index"],
            "winnerId": rummy.masked_player_id(winner_user_id),
            "winnerName": winner_seat.get("display_name") or "Player",
            "payoutChips": winner_payout, "virtualPotChips": pot,
            "reason": reason, "rows": rows,
            "settledAt": _now_iso(),
        },
        "settled_at": _now_iso(), "version": int(room["version"]) + 1,
        "updated_at": _now_iso(),
    })


async def _lowest_score_player(room: dict, session=None):
    seats = await _active_seats(room["id"], session)
    hands = await db.rummy_hands.find(
        {"room_id": room["id"], "round_id": room["round_id"]}, {"_id": 0}, **_kwargs(session),
    ).to_list(rummy.MAX_PLAYERS)
    by_user = {hand["user_id"]: hand for hand in hands}
    arrangements = await asyncio.gather(*[
        _best_arrangement(
            by_user.get(seat["user_id"], {}).get("cards", []),
            int(room["wild_rank"]),
        )
        for seat in seats
    ])
    ranked = []
    for seat, arrangement in zip(seats, arrangements):
        score = arrangement["score"]
        ranked.append((score, seat["seat_index"], seat["user_id"]))
    return min(ranked)[2] if ranked else None


async def _sweep_presence(room: dict, session) -> bool:
    """Persist one reconnect/drop presence transition batch transactionally."""
    kwargs = _kwargs(session)
    category = await _room_category(room, session)
    now = _epoch()
    seats = await db.rummy_seats.find(
        {
            "room_id": room["id"], "is_bot": False,
            "status": {"$in": list(ACTIVE_SEAT_STATES)},
        },
        {"_id": 0}, **kwargs,
    ).to_list(rummy.MAX_PLAYERS)
    transitions = []
    for seat in seats:
        updates = _presence_transition(seat, category, now)
        if updates:
            result = await db.rummy_seats.update_one(
                {
                    "room_id": room["id"], "user_id": seat["user_id"],
                    "status": seat["status"],
                },
                {"$set": updates}, **kwargs,
            )
            if result.modified_count == 1:
                transitions.append((seat, updates))
    if not transitions:
        return False

    expired_indexes = {
        int(seat["seat_index"])
        for seat, updates in transitions
        if updates.get("status") == "DROPPED"
    }
    if expired_indexes:
        active = await _active_seats(room["id"], session)
        if room.get("round_id") and len(active) <= 1:
            winner = active[0]["user_id"] if active else None
            if winner:
                await _settle_room(room, winner, "RECONNECT_EXPIRED", session)
            else:
                await _cancel_room(room, "All players disconnected", session)
            return True
        if int(room.get("current_seat", -1)) in expired_indexes:
            next_index = await _next_active_seat(room["id"], int(room["current_seat"]), session)
            room.update({
                "current_seat": next_index,
                "turn_deadline": now + int(category["turnDurationSeconds"]),
            })
    room.update({
        "version": int(room["version"]) + 1,
        "updated_at": _now_iso(),
    })
    return True


async def _advance_one_automatic(room_id: str, requester_id: str):
    async def mutate(session):
        kwargs = _kwargs(session)
        membership = await db.rummy_seats.find_one(
            {"room_id": room_id, "user_id": requester_id}, {"_id": 0, "user_id": 1}, **kwargs,
        )
        if not membership:
            _fail(403, "RUMMY_NOT_A_MEMBER", "You do not occupy a seat at this table.")
        room = await db.rummy_rooms.find_one({"id": room_id}, {"_id": 0}, **kwargs)
        if not room or room.get("state") != "TURN_ACTIVE":
            return False
        original_version = int(room["version"])
        if await _sweep_presence(room, session):
            await _replace_room_cas(room, original_version, session)
            return True
        seat = await db.rummy_seats.find_one(
            {"room_id": room_id, "seat_index": room["current_seat"]}, {"_id": 0}, **kwargs,
        )
        if not seat or seat.get("status") not in ACTIVE_SEAT_STATES:
            next_index = await _next_active_seat(room_id, int(room["current_seat"]), session)
            if next_index is None:
                await _cancel_room(room, "No active players remain", session)
            else:
                room.update({
                    "current_seat": next_index,
                    "turn_deadline": _epoch() + int((await _room_category(room, session))["turnDurationSeconds"]),
                    "version": original_version + 1, "updated_at": _now_iso(),
                })
            await _replace_room_cas(room, original_version, session)
            return True

        timed_out = not seat.get("is_bot") and float(room.get("turn_deadline") or 0) <= _epoch()
        if not seat.get("is_bot") and not timed_out:
            return False
        hand = await db.rummy_hands.find_one(
            {"room_id": room_id, "round_id": room["round_id"], "user_id": seat["user_id"]},
            {"_id": 0}, **kwargs,
        )
        if not hand:
            await _cancel_room(room, "A private hand could not be restored", session)
            await _replace_room_cas(room, original_version, session)
            return True

        if timed_out:
            missed = int(seat.get("missed_turns", 0)) + 1
            await db.rummy_seats.update_one(
                {"room_id": room_id, "user_id": seat["user_id"]},
                {"$set": {"missed_turns": missed, "last_timeout_at": _now_iso()}}, **kwargs,
            )
            if missed >= 3:
                category = await _room_category(room, session)
                points = int(
                    category.get("firstDropPoints", 20)
                    if int(seat.get("turns_taken", 0)) == 0
                    else category.get("middleDropPoints", 40)
                )
                await db.rummy_seats.update_one(
                    {"room_id": room_id, "user_id": seat["user_id"]},
                    {"$set": {"status": "DROPPED", "drop_points": points}}, **kwargs,
                )
                active = await _active_seats(room_id, session)
                if len(active) <= 1:
                    winner = active[0]["user_id"] if active else None
                    if winner:
                        await _settle_room(room, winner, "LAST_PLAYER_STANDING", session)
                    else:
                        await _cancel_room(room, "All players dropped", session)
                else:
                    next_index = await _next_active_seat(room_id, int(room["current_seat"]), session)
                    room.update({
                        "current_seat": next_index,
                        "turn_deadline": _epoch() + int(category["turnDurationSeconds"]),
                        "version": original_version + 1, "updated_at": _now_iso(),
                    })
                await _replace_room_cas(room, original_version, session)
                return True

        if not hand.get("drawn"):
            if not await _replenish_closed_deck(room):
                await _cancel_room(room, "The draw pile could not continue", session)
                await _replace_room_cas(room, original_version, session)
                return True
            drawn = room["closed_deck"].pop()
            hand["cards"].append(drawn)
            hand.update({"drawn": True, "drawn_card_id": drawn["id"], "draw_source": "CLOSED"})

        discard = await _choose_bot_discard(hand["cards"], int(room["wild_rank"]))
        hand["cards"] = [card for card in hand["cards"] if card["id"] != discard["id"]]
        hand.update({"drawn": False, "drawn_card_id": None, "draw_source": None, "updated_at": _now_iso()})
        room.setdefault("discard_pile", []).append(discard)
        await db.rummy_hands.replace_one(
            {"room_id": room_id, "round_id": room["round_id"], "user_id": seat["user_id"]},
            hand, **kwargs,
        )
        await db.rummy_seats.update_one(
            {"room_id": room_id, "user_id": seat["user_id"]},
            {"$inc": {"turns_taken": 1}, "$set": {"last_action_at": _now_iso()}}, **kwargs,
        )
        arrangement = await _best_arrangement(hand["cards"], int(room["wild_rank"]))
        if arrangement["valid"]:
            await _settle_room(room, seat["user_id"], "VALID_DECLARATION", session)
        elif int(room.get("turn_count", 0)) + 1 >= MAX_ROUND_TURNS:
            winner = await _lowest_score_player(room, session)
            await _settle_room(room, winner, "TURN_LIMIT_LOWEST_SCORE", session)
        else:
            next_index = await _next_active_seat(room_id, int(room["current_seat"]), session)
            category = await _room_category(room, session)
            room.update({
                "current_seat": next_index, "turn_count": int(room.get("turn_count", 0)) + 1,
                "turn_deadline": _epoch() + int(category["turnDurationSeconds"]),
                "version": original_version + 1, "updated_at": _now_iso(),
            })
        await _replace_room_cas(room, original_version, session)
        await db.rummy_actions.insert_one({
            "room_id": room_id, "round_id": room.get("round_id"),
            "user_id": seat["user_id"], "action_id": f"AUTO:{original_version}",
            "action_type": "BOT_TURN" if seat.get("is_bot") else "TIMEOUT_TURN",
            "accepted": True, "version": room["version"], "created_at": _now_iso(),
        }, **kwargs)
        return True

    return await run_game_transaction(client, mutate)


async def _advance_automated(room_id: str, requester_id: str):
    for _ in range(MAX_AUTOMATED_TURNS_PER_REQUEST):
        changed = await _advance_one_automatic(room_id, requester_id)
        if not changed:
            break


def _action_response(state: dict, code: str):
    public = {key: value for key, value in state.items() if key not in ("privateState", "balance")}
    return {
        "accepted": True, "code": code,
        "authoritativeVersion": state["version"], "publicState": public,
        "privateState": state.get("privateState"), "serverTimestamp": state["serverTimestamp"],
        "state": state,
    }


def _apply_private_groups(hand: dict, groups: list[list[str]]):
    """Persist presentation metadata without advancing the public room clock.

    The returned hand has its own monotonic metadata version.  Another seat can
    therefore complete an authoritative draw/discard against the unchanged
    room version while this player rearranges cards locally.
    """
    updated = copy.deepcopy(hand)
    updated["groups"] = copy.deepcopy(groups)
    updated["hand_version"] = int(updated.get("hand_version", 0)) + 1
    updated["updated_at"] = _now_iso()
    return updated


def _seat_entry_chips(seat: dict) -> int:
    """Read the one immutable debit/virtual-entry amount stored on a seat."""
    amount = int(seat.get("entry_chips") or 0)
    if amount <= 0:
        _fail(409, "RUMMY_STAKE_INVALID", "A frozen Rummy seat stake is invalid.")
    return amount


def _seat_wallet_stake_chips(seat: dict) -> int:
    """Return the amount actually debited from a wallet for this seat.

    Legacy seats predate the explicit field and were always debited their
    entry, so they safely fall back to ``entry_chips`` during a rolling deploy.
    """
    raw = seat.get("wallet_stake_chips")
    amount = _seat_entry_chips(seat) if raw is None else int(raw)
    if amount < 0:
        _fail(409, "RUMMY_STAKE_INVALID", "A frozen Rummy wallet stake is invalid.")
    return amount


def _settlement_amounts(seats: list[dict], winner_is_bot: bool, mode: str | None = None):
    """Build display and wallet pots only from immutable seat entries.

    In LIVE mode every seat belongs to a debited human, so the payout is
    exactly the sum previously debited. Practice entries remain visible table
    values but all wallet stakes and payouts are zero, so practice cannot mint
    or consume usable chips.
    """
    if len(seats) != rummy.MAX_PLAYERS:
        _fail(409, "RUMMY_STAKE_INVALID", "A complete five-seat pot is required.")
    stakes = [_seat_entry_chips(seat) for seat in seats]
    wallet_stakes = [_seat_wallet_stake_chips(seat) for seat in seats]
    pot = sum(stakes)
    real_stake_total = sum(wallet_stakes)
    if mode == "LIVE" and real_stake_total != pot:
        _fail(409, "RUMMY_STAKE_INVALID", "The live Rummy pot does not match its wallet debits.")
    return {
        "pot": pot,
        "humanPayout": 0 if winner_is_bot else real_stake_total,
        "seatStakeTotal": pot,
        "realStakeTotal": real_stake_total,
    }


@router.get("/games/rummy/rooms/{room_id}/state")
async def rummy_room_state(room_id: str, user: dict = Depends(require_active_player)):
    await require_playable_game("rummy")
    room, seat = await _load_membership(room_id, user["id"])
    await _advance_automated(room_id, user["id"])
    room, seat = await _load_membership(room_id, user["id"])
    # A GET proves transport health, but deliberately does not bypass the
    # explicit RECONNECT action once the seat entered its grace state.
    if seat.get("status") == "ACTIVE":
        await db.rummy_seats.update_one(
            {"room_id": room_id, "user_id": user["id"], "status": "ACTIVE"},
            {"$set": {"last_seen_at": _now_iso(), "last_seen_epoch": _epoch()}},
        )
    return await _public_state(room, user["id"])


@router.post("/games/rummy/rooms/{room_id}/chat")
async def rummy_room_chat(room_id: str, body: RummyChatCreate, user: dict = Depends(require_active_player)):
    """Post one short, room-scoped message retained for no more than 24 hours."""
    await require_playable_game("rummy")
    room, seat = await _load_membership(room_id, user["id"])
    if room.get("state") == "CANCELLED":
        _fail(409, "RUMMY_CHAT_CLOSED", "Chat is closed for this table.")
    now = datetime.now(timezone.utc)
    recent = await db.rummy_chat.count_documents({
        "room_id": room_id,
        "user_id": user["id"],
        "created_at": {"$gte": now - timedelta(minutes=1)},
    })
    if recent >= 8:
        _fail(429, "RUMMY_CHAT_RATE_LIMIT", "Please wait before sending another message.")
    item = {
        "id": str(uuid.uuid4()),
        "room_id": room_id,
        "round_id": room.get("round_id"),
        "user_id": user["id"],
        "seatIndex": int(seat["seat_index"]),
        "displayName": seat.get("display_name") or "Player",
        "avatar": seat.get("avatar") or "crown",
        "body": body.body,
        "created_at": now,
    }
    await db.rummy_chat.insert_one(copy.deepcopy(item))
    public_item = {key: value for key, value in item.items() if key not in {"user_id", "room_id", "round_id"}}
    return {"item": serialize_doc(public_item)}


@router.post("/games/rummy/rooms/{room_id}/actions")
async def rummy_action(room_id: str, body: RummyAction, user: dict = Depends(require_active_player)):
    await require_playable_game("rummy")
    if body.roomId != room_id:
        _fail(400, "RUMMY_ROOM_MISMATCH", "The action room does not match the route.")

    async def mutate(session):
        kwargs = _kwargs(session)
        prior = await db.rummy_actions.find_one(
            {"room_id": room_id, "user_id": user["id"], "action_id": body.actionId},
            {"_id": 0, "response": 1}, **kwargs,
        )
        if prior and prior.get("response"):
            return prior["response"]

        room, seat = await _load_membership(room_id, user["id"], session)
        if seat.get("status") not in ACTIVE_SEAT_STATES:
            _fail(409, "RUMMY_SEAT_INACTIVE", "This Rummy seat is no longer active.")
        original_version = int(room["version"])
        if body.expectedVersion != original_version:
            _fail(409, "RUMMY_STALE_VERSION", "The table changed. Refresh before acting again.")
        if body.roundId and room.get("round_id") != body.roundId:
            _fail(409, "RUMMY_STALE_ROUND", "That action belongs to an earlier Rummy round.")
        action = body.actionType
        changed = False
        private_changed = False
        code = f"{action}_ACCEPTED"

        if seat.get("status") == "RECONNECTING" and action != "RECONNECT":
            _fail(409, "RUMMY_RECONNECT_REQUIRED", "Reconnect this seat before acting.")

        if action == "RECONNECT":
            if seat.get("status") == "RECONNECTING":
                reconnect_now = _epoch()
                deadline = float(seat.get("reconnect_deadline") or 0)
                if not deadline or deadline <= reconnect_now:
                    _fail(409, "RUMMY_RECONNECT_EXPIRED", "The reconnect allowance has expired.")
                reconnected = await db.rummy_seats.update_one(
                    {
                        "room_id": room_id, "user_id": user["id"],
                        "status": "RECONNECTING", "reconnect_deadline": {"$gt": reconnect_now},
                    },
                    {
                        "$set": {
                            "status": "ACTIVE", "last_seen_at": _now_iso(),
                            "last_seen_epoch": _epoch(), "reconnected_at": _now_iso(),
                        },
                        "$unset": {
                            "reconnect_started_epoch": "", "reconnect_deadline": "",
                            "reconnecting_at": "",
                        },
                    },
                    **kwargs,
                )
                if reconnected.modified_count != 1:
                    _fail(409, "RUMMY_RECONNECT_EXPIRED", "The reconnect allowance has expired.")
                room.update({"version": original_version + 1, "updated_at": _now_iso()})
                changed = True
                code = "PLAYER_RECONNECTED"
            else:
                await db.rummy_seats.update_one(
                    {"room_id": room_id, "user_id": user["id"], "status": "ACTIVE"},
                    {"$set": {"last_seen_at": _now_iso(), "last_seen_epoch": _epoch()}},
                    **kwargs,
                )
                code = "RECONNECT_NOT_REQUIRED"
        elif action in ("HEARTBEAT", "READY"):
            await db.rummy_seats.update_one(
                {"room_id": room_id, "user_id": user["id"], "status": "ACTIVE"},
                {"$set": {"last_seen_at": _now_iso(), "last_seen_epoch": _epoch()}}, **kwargs,
            )
        elif room.get("state") == "WAITING_FOR_PLAYERS" and action in ("DROP", "LEAVE"):
            refund_amount = _waiting_refund_amount(seat)
            # Delete the ephemeral membership so its unique seat index becomes
            # available again. The conditional status is a second line of
            # defence against concurrent or new-action-id refund replays; the
            # action and ledger records retain the immutable audit trail.
            claimed = await db.rummy_seats.delete_one(
                {
                    "room_id": room_id,
                    "user_id": user["id"],
                    "status": {"$in": list(ACTIVE_SEAT_STATES)},
                },
                **kwargs,
            )
            if claimed.deleted_count != 1:
                _fail(409, "RUMMY_SEAT_INACTIVE", "This Rummy seat is no longer active.")
            if refund_amount:
                await credit_chips(
                    user["id"], refund_amount, "Rummy matchmaking cancelled",
                    ref=f"{seat.get('stake_ref') or room_id}:refund",
                    kind=ledger.REFUND, game="rummy", session=session,
                )
            room.update({
                "seat_count": max(0, int(room.get("seat_count", 1)) - 1),
                "version": original_version + 1, "updated_at": _now_iso(),
            })
            changed = True
            code = "MATCHMAKING_LEFT"
        else:
            if room.get("state") != "TURN_ACTIVE":
                _fail(409, "RUMMY_ACTIONS_CLOSED", "This round is not accepting actions.")
            hand = await db.rummy_hands.find_one(
                {"room_id": room_id, "round_id": room["round_id"], "user_id": user["id"]},
                {"_id": 0}, **kwargs,
            )
            if not hand:
                _fail(409, "RUMMY_HAND_UNAVAILABLE", "Your private hand could not be restored.")
            owns_turn = int(room.get("current_seat", -1)) == int(seat["seat_index"])
            turn_actions = {"DRAW_CLOSED", "DRAW_DISCARD", "DISCARD", "DECLARE"}
            if action in turn_actions and _turn_deadline_expired(room):
                _fail(409, "RUMMY_TURN_EXPIRED", "That turn deadline has passed. Refresh the table.")
            if action in turn_actions and not owns_turn:
                _fail(409, "RUMMY_NOT_YOUR_TURN", "Wait for your active-player ring.")

            await db.rummy_seats.update_one(
                {"room_id": room_id, "user_id": user["id"], "status": "ACTIVE"},
                {"$set": {"last_seen_at": _now_iso(), "last_seen_epoch": _epoch()}}, **kwargs,
            )

            if action in ("DRAW_CLOSED", "DRAW_DISCARD"):
                if hand.get("drawn"):
                    _fail(409, "RUMMY_ALREADY_DREW", "Discard before drawing another card.")
                if action == "DRAW_CLOSED":
                    if not await _replenish_closed_deck(room):
                        await _cancel_room(room, "The draw pile could not continue", session)
                        changed = True
                    else:
                        card = room["closed_deck"].pop()
                else:
                    if not room.get("discard_pile"):
                        _fail(409, "RUMMY_DISCARD_EMPTY", "The open discard pile is empty.")
                    card = room["discard_pile"].pop()
                if room.get("state") != "CANCELLED":
                    hand["cards"].append(card)
                    hand.update({
                        "drawn": True, "drawn_card_id": card["id"],
                        "draw_source": "CLOSED" if action == "DRAW_CLOSED" else "DISCARD",
                        "updated_at": _now_iso(),
                    })
                    room.update({"version": original_version + 1, "updated_at": _now_iso()})
                    changed = True
            elif action == "DISCARD":
                if not hand.get("drawn"):
                    _fail(409, "RUMMY_DRAW_REQUIRED", "Draw one card before discarding.")
                card_id = str(body.actionPayload.get("cardId") or "")
                card = next((item for item in hand["cards"] if item["id"] == card_id), None)
                if not card:
                    _fail(409, "RUMMY_CARD_NOT_OWNED", "That card is not in your hand.")
                if hand.get("draw_source") == "DISCARD" and hand.get("drawn_card_id") == card_id:
                    _fail(409, "RUMMY_PICK_DISCARD_LOOP", "A picked open card cannot be returned immediately.")
                hand["cards"] = [item for item in hand["cards"] if item["id"] != card_id]
                hand["groups"] = [
                    [grouped for grouped in group if grouped != card_id]
                    for group in hand.get("groups", [])
                    if any(grouped != card_id for grouped in group)
                ]
                hand.update({
                    "drawn": False, "drawn_card_id": None, "draw_source": None,
                    "updated_at": _now_iso(),
                })
                room.setdefault("discard_pile", []).append(card)
                next_index = await _next_active_seat(room_id, int(room["current_seat"]), session)
                category = await _room_category(room, session)
                room.update({
                    "current_seat": next_index, "turn_count": int(room.get("turn_count", 0)) + 1,
                    "turn_deadline": _epoch() + int(category["turnDurationSeconds"]),
                    "version": original_version + 1, "updated_at": _now_iso(),
                })
                await db.rummy_seats.update_one(
                    {"room_id": room_id, "user_id": user["id"]},
                    {"$inc": {"turns_taken": 1}, "$set": {"last_action_at": _now_iso()}}, **kwargs,
                )
                changed = True
            elif action in ("GROUP", "UNGROUP"):
                groups = body.actionPayload.get("groups", []) if action == "GROUP" else []
                if not isinstance(groups, list) or any(not isinstance(group, list) for group in groups):
                    _fail(422, "RUMMY_GROUP_FORMAT", "Groups must be lists of card ids.")
                owned = {card["id"] for card in hand["cards"]}
                flat = [str(card_id) for group in groups for card_id in group]
                if len(flat) != len(set(flat)) or not set(flat).issubset(owned):
                    _fail(409, "RUMMY_GROUP_OWNERSHIP", "Groups can contain each owned card at most once.")
                hand = _apply_private_groups(hand, groups)
                private_changed = True
            elif action == "SORT":
                # Auto Sort is deliberately a client presentation operation.
                # The acknowledgement is idempotent but authoritative cards and
                # the room version remain unchanged.
                code = "SORT_LOCAL_ONLY"
            elif action == "DECLARE":
                if hand.get("drawn") or len(hand.get("cards", [])) != rummy.HAND_SIZE:
                    _fail(409, "RUMMY_DISCARD_BEFORE_DECLARE", "Discard to thirteen cards before declaring.")
                groups = body.actionPayload.get("groups") or hand.get("groups", [])
                validation = rummy.validate_declaration(hand["cards"], groups, int(room["wild_rank"]))
                if validation["valid"]:
                    hand["groups"] = groups
                    await _settle_room(room, user["id"], "VALID_DECLARATION", session)
                    code = "VALID_DECLARATION"
                else:
                    category = await _room_category(room, session)
                    await db.rummy_seats.update_one(
                        {"room_id": room_id, "user_id": user["id"]},
                        {"$set": {
                            "status": "DROPPED",
                            "drop_points": int(category.get("invalidDeclarationPoints", 80)),
                            "invalid_declaration": validation["code"],
                        }},
                        **kwargs,
                    )
                    active = await _active_seats(room_id, session)
                    if len(active) <= 1:
                        winner = active[0]["user_id"] if active else await _lowest_score_player(room, session)
                        await _settle_room(room, winner, "INVALID_DECLARATION", session)
                    else:
                        next_index = await _next_active_seat(room_id, int(room["current_seat"]), session)
                        room.update({
                            "current_seat": next_index,
                            "turn_deadline": _epoch() + int(category["turnDurationSeconds"]),
                            "version": original_version + 1, "updated_at": _now_iso(),
                            "last_declaration": {"seatIndex": seat["seat_index"], "valid": False, "code": validation["code"]},
                        })
                    code = validation["code"]
                changed = True
            elif action in ("DROP", "LEAVE"):
                category = await _room_category(room, session)
                points = int(
                    category.get("firstDropPoints", 20)
                    if int(seat.get("turns_taken", 0)) == 0
                    else category.get("middleDropPoints", 40)
                )
                await db.rummy_seats.update_one(
                    {"room_id": room_id, "user_id": user["id"]},
                    {"$set": {"status": "DROPPED", "drop_points": points, "dropped_at": _now_iso()}}, **kwargs,
                )
                active = await _active_seats(room_id, session)
                if len(active) <= 1:
                    winner = active[0]["user_id"] if active else await _lowest_score_player(room, session)
                    await _settle_room(room, winner, "LAST_PLAYER_STANDING", session)
                else:
                    next_index = room["current_seat"]
                    if owns_turn:
                        next_index = await _next_active_seat(room_id, int(room["current_seat"]), session)
                    room.update({
                        "current_seat": next_index,
                        "turn_deadline": _epoch() + int(category["turnDurationSeconds"]),
                        "version": original_version + 1, "updated_at": _now_iso(),
                    })
                code = "PLAYER_DROPPED"
                changed = True

            if changed or private_changed:
                await db.rummy_hands.replace_one(
                    {"room_id": room_id, "round_id": room["round_id"], "user_id": user["id"]},
                    hand, **kwargs,
                )

        if changed:
            await _replace_room_cas(room, original_version, session)
        state = await _public_state(room, user["id"], session)
        response = _action_response(state, code)
        await db.rummy_actions.insert_one({
            "room_id": room_id, "round_id": room.get("round_id"),
            "user_id": user["id"], "action_id": body.actionId,
            "action_type": action, "client_timestamp": body.clientTimestamp,
            "expected_version": body.expectedVersion, "accepted": True,
            "version": room["version"], "response": response, "created_at": _now_iso(),
        }, **kwargs)
        return response

    try:
        response = await run_game_transaction(client, mutate)
    except DuplicateKeyError:
        prior = await db.rummy_actions.find_one(
            {"room_id": room_id, "user_id": user["id"], "action_id": body.actionId},
            {"_id": 0, "response": 1},
        )
        if prior and prior.get("response"):
            return prior["response"]
        raise
    return response


@router.get("/admin/rummy/categories")
async def admin_rummy_categories(admin: dict = Depends(require_admin)):
    return {"categories": serialize_doc(await _categories()), "maxPlayers": rummy.MAX_PLAYERS}


@router.patch("/admin/rummy/categories/{category_id}")
async def admin_rummy_category_update(
    category_id: str, body: CategoryPatch, admin: dict = Depends(require_admin),
):
    if category_id not in rummy.category_map():
        _fail(404, "RUMMY_CATEGORY_NOT_FOUND", "Rummy category not found.")
    updates = body.model_dump(exclude_none=True)
    current = await _category(category_id, require_enabled=False)
    merged_skill_min = int(updates.get("skillRatingMin", current.get("skillRatingMin", 0)))
    merged_skill_max = int(updates.get("skillRatingMax", current.get("skillRatingMax", 100_000)))
    if merged_skill_min > merged_skill_max:
        _fail(422, "RUMMY_SKILL_RANGE_INVALID", "Minimum rating cannot exceed maximum rating.")
    updates.update({"maxPlayers": rummy.MAX_PLAYERS, "updated_at": _now_iso(), "updated_by": admin["id"]})
    await db.rummy_categories.update_one({"id": category_id}, {"$set": updates}, upsert=True)
    updated = await _category(category_id, require_enabled=False)
    return {"message": "Rummy category updated", "category": serialize_doc(updated)}
