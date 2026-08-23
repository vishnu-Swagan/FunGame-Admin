"""Five-seat, server-authoritative Indian Rummy API.

The browser receives one private hand: its own.  Rooms, turns, shuffle proof,
actions, chip stakes and settlement are persisted in MongoDB and all
balance-coupled mutations run in one transaction.
"""
from __future__ import annotations

import asyncio
import copy
import hashlib
import re
import secrets
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError

from auth_utils import require_active_player, require_admin
from avatar_service import uploaded_avatar_path
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
BOT_TABLE_MODE = "BOT_TABLE"
LIVE_MATCHMAKING_CYCLE_SECONDS = 180
# Kept as a compatibility alias for older clients that render
# ``fallbackStartsIn``.  New tables always use the scheduled cycle boundary.
LIVE_BOT_FALLBACK_SECONDS = float(LIVE_MATCHMAKING_CYCLE_SECONDS)
MAX_AUTOMATED_TURNS_PER_REQUEST = 12
MAX_ROUND_TURNS = 100
PRESENCE_STALE_SECONDS = 6
MAX_GROUP_CARD_ID_LENGTH = 64
CHAT_RECENT_LIMIT = 30
CHAT_TEXT_MAX_LENGTH = 160
CHAT_REQUEST_MAX_LENGTH = 240
CHAT_RATE_WINDOW_SECONDS = 10
CHAT_RATE_MAX_EVENTS = 5
SUPPORT_RATE_WINDOW_SECONDS = 60
BOT_LOGIC_VERSION = "fair-private-public-v3"
PLAYER_EMOJI_REACTIONS = frozenset({
    "smile", "laugh", "clap", "wow", "good-game", "thinking",
})
PLAYER_GIF_REACTIONS = frozenset({
    "royal-clap", "crown-bounce", "card-dance", "victory-spark",
})
BOT_PROFILES = (
    {
        "id": "mira-orbit", "name": "Mira", "avatar": "avatar-26",
        "personality": "warm strategist", "playStyle": "patient sequence builder",
        "chatStyle": "encouraging", "signatureEmoji": "clap",
    },
    {
        "id": "arjun-crest", "name": "Arjun", "avatar": "avatar-37",
        "personality": "calm tactician", "playStyle": "balanced discard reader",
        "chatStyle": "dry humour", "signatureEmoji": "thinking",
    },
    {
        "id": "leela-gem", "name": "Leela", "avatar": "avatar-48",
        "personality": "bold optimist", "playStyle": "tempo-conscious set hunter",
        "chatStyle": "playful", "signatureEmoji": "laugh",
    },
    {
        "id": "kabir-spade", "name": "Kabir", "avatar": "avatar-59",
        "personality": "quiet closer", "playStyle": "low-point risk controller",
        "chatStyle": "respectful", "signatureEmoji": "good-game",
    },
)
BOT_SOCIAL_BEATS = (
    {"eventType": "TEXT", "message": "Good luck, royals. Let us play a clean hand 👑"},
    {"eventType": "EMOJI", "reactionId": "thinking"},
    {"eventType": "GIF", "reactionId": "royal-clap"},
    {"eventType": "TEXT", "message": "That card made the table interesting 😄"},
    {
        "eventType": "MUSIC_REQUEST", "reactionId": "palace-focus",
        "message": "AUTO atmosphere suggestion: Palace Focus instrumental.",
    },
    {"eventType": "EMOJI", "reactionId": "good-game"},
)
CATEGORY_SNAPSHOT_FIELDS = (
    "id", "displayName", "entryChips", "pointsValue", "minChipBalance",
    "maxChipBalance", "turnDurationSeconds", "skillRatingMin",
    "skillRatingMax", "reconnectAllowanceSeconds", "practiceBotDifficulty",
    "firstDropPoints", "middleDropPoints", "invalidDeclarationPoints",
    "maxPlayers", "enabled", "displayOrder", "accent",
)

# Unique seats, action ids, private hands and settlement rows are correctness
# requirements, not optional optimisations.  The general application bootstrap
# continues after an isolated startup failure, so Rummy also owns a fail-closed
# in-process gate.  It opens only after every core index/category is prepared.
_RUMMY_CORE_READY = False
_RUMMY_CORE_ERROR = None
_RUMMY_CORE_RETRY_AFTER = 0.0
_RUMMY_CORE_LOCK = asyncio.Lock()
RUMMY_CORE_RETRY_COOLDOWN_SECONDS = 3.0


def _now_iso():
    return datetime.now(timezone.utc).isoformat()


def _epoch():
    return time.time()


def _kwargs(session):
    return {"session": session} if session is not None else {}


def _fail(status: int, code: str, message: str):
    raise HTTPException(status_code=status, detail={"code": code, "message": message})


_PUBLIC_BOT_WORD = re.compile(r"\bbots?\b", re.IGNORECASE)


def _public_automated_text(value, fallback: str = "AUTO") -> str:
    """Keep legacy automation metadata explicit without exposing old BOT copy."""
    normalized = " ".join(str(value or fallback).split())
    return _PUBLIC_BOT_WORD.sub("AUTO", normalized)


def _public_result(result):
    """Project persisted results through the current public automation labels."""
    if not isinstance(result, dict):
        return result
    projected = copy.deepcopy(result)
    rows = projected.get("rows") if isinstance(projected.get("rows"), list) else []
    for row in rows:
        if isinstance(row, dict) and row.get("isBot"):
            row["displayName"] = _public_automated_text(row.get("displayName"), "Automated Player")
            row["botLabel"] = _public_automated_text(row.get("botLabel"), "AUTO")
    winner_seat = projected.get("winnerSeat")
    winner = next((row for row in rows if row.get("seatIndex") == winner_seat), None)
    if winner and winner.get("isBot"):
        projected["winnerName"] = _public_automated_text(
            projected.get("winnerName"), "Automated Player",
        )
    return projected


def _public_uploaded_avatar_url(profile: dict) -> str | None:
    """Resolve only API-owned, same-origin uploaded-avatar paths.

    A public Rummy seat never echoes an arbitrary URL from a profile or seat
    document. The opaque upload id is validated by ``uploaded_avatar_path``;
    an optional content-hash version is retained only when it has the exact
    shape written by the avatar upload endpoint.
    """
    if profile.get("avatar_source") != "UPLOAD":
        return None
    upload_id = str(profile.get("avatar_upload_id") or "")
    try:
        base_path = uploaded_avatar_path(upload_id)
    except ValueError:
        return None
    stored_url = str(profile.get("avatar_url") or "")
    version = re.fullmatch(
        rf"{re.escape(base_path)}\?v=([a-f0-9]{{12}})", stored_url,
    )
    return f"{base_path}?v={version.group(1)}" if version else base_path


def reset_rummy_core_readiness():
    """Close the readiness gate, including between deterministic tests."""
    global _RUMMY_CORE_READY, _RUMMY_CORE_ERROR, _RUMMY_CORE_RETRY_AFTER
    _RUMMY_CORE_READY = False
    _RUMMY_CORE_ERROR = None
    _RUMMY_CORE_RETRY_AFTER = 0.0


def _mark_rummy_core_ready_for_tests():
    """Open the gate without touching MongoDB in a focused unit test."""
    global _RUMMY_CORE_READY, _RUMMY_CORE_ERROR, _RUMMY_CORE_RETRY_AFTER
    _RUMMY_CORE_READY = True
    _RUMMY_CORE_ERROR = None
    _RUMMY_CORE_RETRY_AFTER = 0.0


async def _require_rummy_core_ready():
    """Fail closed, but recover from a transient startup preparation failure.

    Only one request retries the idempotent index/category preparation at a
    time.  A short cooldown prevents a database outage from turning every
    incoming request into another preparation attempt.
    """
    global _RUMMY_CORE_RETRY_AFTER
    if _RUMMY_CORE_READY:
        return
    if time.monotonic() < _RUMMY_CORE_RETRY_AFTER:
        _fail(
            503,
            "RUMMY_CORE_UNAVAILABLE",
            "Rummy is temporarily unavailable while its secure table state is prepared.",
        )
    async with _RUMMY_CORE_LOCK:
        if _RUMMY_CORE_READY:
            return
        if time.monotonic() < _RUMMY_CORE_RETRY_AFTER:
            _fail(
                503,
                "RUMMY_CORE_UNAVAILABLE",
                "Rummy is temporarily unavailable while its secure table state is prepared.",
            )
        try:
            await ensure_rummy_core()
        except Exception:
            _RUMMY_CORE_RETRY_AFTER = time.monotonic() + RUMMY_CORE_RETRY_COOLDOWN_SECONDS
            _fail(
                503,
                "RUMMY_CORE_UNAVAILABLE",
                "Rummy is temporarily unavailable while its secure table state is prepared.",
            )


class JoinRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    categoryId: str = Field(default="LV1", pattern=r"^LV[1-5]$")
    mode: Literal["LIVE", "PRACTICE", "BOT_TABLE"] = "LIVE"


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
            "SORT", "GROUP", "UNGROUP", "DECLARE", "DISCARD_AND_DECLARE",
            "DROP", "RECONNECT", "LEAVE",
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
    practiceBotDifficulty: Optional[
        Literal["guided", "standard", "strong", "expert", "royal"]
    ] = None
    firstDropPoints: Optional[int] = Field(default=None, ge=0, le=80)
    middleDropPoints: Optional[int] = Field(default=None, ge=0, le=80)
    invalidDeclarationPoints: Optional[int] = Field(default=None, ge=0, le=80)
    enabled: Optional[bool] = None
    displayOrder: Optional[int] = Field(default=None, ge=1, le=5)


class RummyChatRequest(BaseModel):
    """One bounded, idempotent table message or support request."""

    model_config = ConfigDict(extra="forbid")

    requestId: str = Field(min_length=8, max_length=96, pattern=r"^[A-Za-z0-9:_-]+$")
    eventType: Literal["TEXT", "EMOJI", "GIF", "HELP_DESK", "MUSIC_REQUEST"] = "TEXT"
    message: Optional[str] = Field(default=None, max_length=CHAT_REQUEST_MAX_LENGTH)
    reactionId: Optional[str] = Field(default=None, min_length=2, max_length=40)

    @field_validator("message")
    @classmethod
    def normalize_message(cls, value):
        if value is None:
            return None
        # Persist plain text only. Whitespace normalization also removes line
        # breaks/control spacing that could be abused to imitate table chrome.
        normalized = " ".join(str(value).split())
        if any(ord(character) < 32 for character in normalized):
            raise ValueError("message contains unsupported control characters")
        if "<" in normalized or ">" in normalized:
            raise ValueError("message must be plain text without markup")
        return normalized

    @field_validator("reactionId")
    @classmethod
    def normalize_reaction(cls, value):
        return value.strip().lower() if value is not None else None

    @model_validator(mode="after")
    def validate_event_payload(self):
        if self.eventType == "TEXT":
            if not self.message:
                raise ValueError("text messages cannot be empty")
            if len(self.message) > CHAT_TEXT_MAX_LENGTH:
                raise ValueError(f"text messages are limited to {CHAT_TEXT_MAX_LENGTH} characters")
            if self.reactionId is not None:
                raise ValueError("text messages do not accept a reaction id")
        elif self.eventType == "EMOJI":
            if self.reactionId not in PLAYER_EMOJI_REACTIONS:
                raise ValueError("unsupported table emoji")
            if self.message:
                raise ValueError("emoji reactions do not accept message text")
        elif self.eventType == "GIF":
            if self.reactionId not in PLAYER_GIF_REACTIONS:
                raise ValueError("unsupported table GIF")
            if self.message:
                raise ValueError("GIF reactions do not accept message text")
        elif self.eventType == "HELP_DESK":
            if not self.message or len(self.message) < 3:
                raise ValueError("describe the help you need")
            if self.reactionId is not None:
                raise ValueError("help requests do not accept a reaction id")
        elif self.eventType == "MUSIC_REQUEST":
            if not self.message or not 2 <= len(self.message) <= 120:
                raise ValueError("music requests must contain 2 to 120 characters")
            if self.reactionId is not None:
                raise ValueError("music requests do not accept a reaction id")
        return self


async def _ensure_rummy_core_unchecked():
    """Create Rummy indexes and the five idempotent centrally managed categories."""
    await db.rummy_rooms.create_index("id", unique=True)
    await db.rummy_rooms.create_index([("category_id", 1), ("mode", 1), ("state", 1), ("seat_count", 1)])
    await db.rummy_rooms.create_index([
        ("mode", 1), ("state", 1), ("scheduled_start_at_epoch", 1),
    ])
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
    await db.rummy_bot_profiles.create_index("id", unique=True)
    await db.rummy_chat_events.create_index("id", unique=True)
    await db.rummy_chat_events.create_index([
        ("room_id", 1), ("sender_user_id", 1), ("client_request_id", 1),
    ], unique=True, partialFilterExpression={"client_request_id": {"$type": "string"}})
    await db.rummy_chat_events.create_index([("room_id", 1), ("created_epoch", -1)])
    await db.rummy_chat_rate_limits.create_index("expires_at", expireAfterSeconds=0)
    await db.rummy_support_requests.create_index("id", unique=True)
    await db.rummy_support_requests.create_index([
        ("user_id", 1), ("status", 1), ("created_epoch", -1),
    ])
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
    for profile in BOT_PROFILES:
        await db.rummy_bot_profiles.update_one(
            {"id": profile["id"]},
            {
                "$set": {
                    **copy.deepcopy(profile),
                    "is_bot": True,
                    "public_label": "AUTO",
                    "logic_version": BOT_LOGIC_VERSION,
                    "updated_at": _now_iso(),
                },
                "$setOnInsert": {
                    "rounds_completed": 0,
                    "wins": 0,
                    "turns_completed": 0,
                    "created_at": _now_iso(),
                },
            },
            upsert=True,
        )


async def ensure_rummy_core():
    """Prepare every Rummy invariant, opening its public routes only on success."""
    global _RUMMY_CORE_READY, _RUMMY_CORE_ERROR
    reset_rummy_core_readiness()
    try:
        await _ensure_rummy_core_unchecked()
    except Exception as exc:
        _RUMMY_CORE_ERROR = f"{type(exc).__name__}: {exc}"
        raise
    _RUMMY_CORE_READY = True
    _RUMMY_CORE_ERROR = None


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


def _iso_to_epoch(value) -> float:
    if isinstance(value, (int, float)):
        return float(value)
    if not value:
        return 0.0
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except (TypeError, ValueError):
        return 0.0


def _next_live_start_epoch(now: float | None = None) -> float:
    """Return the next shared three-minute matchmaking boundary.

    The schedule depends only on server time. Category/room/player data cannot
    move a boundary, which makes countdowns consistent across workers and
    devices and gives every level a fresh opportunity every 180 seconds.
    """
    current = _epoch() if now is None else float(now)
    cycle = LIVE_MATCHMAKING_CYCLE_SECONDS
    return float(((int(current) // cycle) + 1) * cycle)


def _scheduled_room_start_epoch(room: dict) -> float:
    """Read the persisted boundary, with a safe rolling-deploy fallback."""
    persisted = room.get("scheduled_start_at_epoch")
    if persisted is not None:
        return float(persisted)
    legacy = room.get("fallback_at_epoch")
    if legacy is not None:
        return float(legacy)
    created = _iso_to_epoch(room.get("created_at"))
    return created + LIVE_MATCHMAKING_CYCLE_SECONDS if created else _next_live_start_epoch()


def _live_cycle_metadata(category_id: str, start_epoch: float) -> dict:
    start = float(start_epoch)
    return {
        "matchmaking_cycle_seconds": LIVE_MATCHMAKING_CYCLE_SECONDS,
        "matchmaking_cycle_id": f"{category_id}:{int(start)}",
        "scheduled_start_at_epoch": start,
        "scheduled_start_at": datetime.fromtimestamp(start, tz=timezone.utc).isoformat(),
    }


def _public_matchmaking(room: dict, seat_count: int | None = None) -> dict:
    origin_mode = room.get("requested_mode") or (
        "LIVE" if room.get("fallback_from_live") else room.get("mode")
    )
    if origin_mode != "LIVE":
        return {
            "cycleSeconds": LIVE_MATCHMAKING_CYCLE_SECONDS,
            "cycleId": None,
            "scheduledStartAtEpoch": None,
            "scheduledStartAt": None,
            "startsIn": 0.0,
            "missingSeats": 0,
            "originMode": origin_mode,
            "fallbackPolicy": None,
        }
    scheduled = _scheduled_room_start_epoch(room)
    waiting = room.get("state") == "WAITING_FOR_PLAYERS"
    count = int(room.get("seat_count", 0) if seat_count is None else seat_count)
    return {
        "cycleSeconds": int(room.get("matchmaking_cycle_seconds") or LIVE_MATCHMAKING_CYCLE_SECONDS),
        "cycleId": room.get("matchmaking_cycle_id") or f"{room.get('category_id', 'LV')}:{int(scheduled)}",
        "scheduledStartAtEpoch": scheduled,
        "scheduledStartAt": room.get("scheduled_start_at")
        or datetime.fromtimestamp(scheduled, tz=timezone.utc).isoformat(),
        "startsIn": max(0.0, round(scheduled - _epoch(), 3)) if waiting else 0.0,
        "missingSeats": max(0, rummy.MAX_PLAYERS - count) if waiting else 0,
        "originMode": origin_mode,
        "fallbackPolicy": (
            "MISSING_SEATS_USE_LABELLED_AUTOMATED_PLAYERS_AND_LIVE_STAKES_ARE_REFUNDED"
        ),
    }


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


async def _choose_bot_discard(
    cards: list[dict], wild_rank: int, difficulty: str = "expert",
    forbidden_card_id: str | None = None,
) -> dict:
    return await asyncio.to_thread(
        rummy.choose_bot_discard, cards, wild_rank, difficulty, forbidden_card_id,
    )


async def _choose_bot_draw_source(
    cards: list[dict], open_discard: dict | None, wild_rank: int,
    difficulty: str,
) -> str:
    return await asyncio.to_thread(
        rummy.choose_bot_draw_source, cards, open_discard, wild_rank, difficulty,
    )


def _bot_think_delay_seconds(difficulty: str, entropy: int | None = None) -> float:
    """Human-scale server delay; entropy affects timing only, never cards."""
    bounds = {
        "guided": (2.8, 5.0), "standard": (2.5, 4.5),
        "strong": (2.1, 3.9), "expert": (1.8, 3.4), "royal": (1.6, 3.0),
    }
    low, high = bounds[rummy.bot_difficulty(difficulty)]
    tick = secrets.randbelow(1001) if entropy is None else max(0, min(1000, int(entropy)))
    return round(low + ((high - low) * tick / 1000), 3)


def _bot_discard_delay_seconds(difficulty: str, entropy: int | None = None) -> float:
    bounds = {
        "guided": (1.2, 2.2), "standard": (1.1, 2.0),
        "strong": (1.0, 1.8), "expert": (0.9, 1.6), "royal": (0.8, 1.5),
    }
    low, high = bounds[rummy.bot_difficulty(difficulty)]
    tick = secrets.randbelow(1001) if entropy is None else max(0, min(1000, int(entropy)))
    return round(low + ((high - low) * tick / 1000), 3)


def _bot_profile_snapshot(category: dict, bot_number: int) -> dict:
    """Freeze a transparent personality/experience contract onto one seat."""
    profile = BOT_PROFILES[(max(1, int(bot_number)) - 1) % len(BOT_PROFILES)]
    difficulty = rummy.bot_difficulty(category.get("practiceBotDifficulty"))
    rating_by_level = {
        "guided": 650, "standard": 1200, "strong": 1900,
        "expert": 2600, "royal": 3400,
    }
    experience_by_level = {
        "guided": "APPRENTICE", "standard": "SEASONED", "strong": "VETERAN",
        "expert": "MASTER", "royal": "ROYAL_MASTER",
    }
    return {
        **copy.deepcopy(profile),
        "difficulty": difficulty,
        "experienceBand": experience_by_level[difficulty],
        "skillRating": rating_by_level[difficulty],
        "logicVersion": BOT_LOGIC_VERSION,
        "usesPrivateHandOnly": True,
        "usesPublicDiscardOnly": True,
        "outcomeControl": False,
    }


def _public_chat_event(event: dict) -> dict:
    is_bot = bool(event.get("is_bot"))
    return {
        "id": event["id"],
        "eventType": event["event_type"],
        "message": (
            _public_automated_text(event.get("message"), "Automated table activity")
            if is_bot and event.get("message") else event.get("message")
        ),
        "reactionId": event.get("reaction_id"),
        "sender": {
            "seatIndex": event.get("sender_seat_index"),
            "playerId": event.get("masked_sender_id"),
            "displayName": (
                _public_automated_text(event.get("sender_name"), "Automated Player")
                if is_bot else event.get("sender_name") or "Player"
            ),
            "isBot": is_bot,
            "label": "AUTO" if is_bot else "PLAYER",
            "botLabel": (
                _public_automated_text(event.get("bot_label"), "AUTO")
                if is_bot else None
            ),
        },
        "requestStatus": event.get("request_status"),
        "visibility": event.get("visibility") or "TABLE",
        "generatedAt": event.get("generated_at") or event.get("created_at"),
        "createdAt": event.get("created_at"),
        "createdEpoch": float(event.get("created_epoch") or 0),
    }


async def _recent_chat_events(room_id: str, session=None, limit: int = CHAT_RECENT_LIMIT):
    collection = getattr(db, "rummy_chat_events", None)
    if collection is None:
        return []
    rows = await collection.find(
        {
            "room_id": room_id,
            "$or": [
                {"visibility": "TABLE"},
                {
                    "visibility": {"$exists": False},
                    "event_type": {"$nin": ["HELP_DESK", "MUSIC_REQUEST"]},
                },
            ],
        },
        {"_id": 0}, **_kwargs(session),
    ).sort("created_epoch", -1).to_list(max(1, min(CHAT_RECENT_LIMIT, int(limit))))
    return [_public_chat_event(row) for row in reversed(rows)]


def _bot_social_beat(room: dict, seat: dict, phase: str) -> dict:
    """Select social flavour from metadata only, never from cards/deck/outcome."""
    key = (
        f"{room.get('round_id')}:{room.get('turn_count', 0)}:"
        f"{seat.get('seat_index')}:{phase}"
    ).encode()
    index = int(hashlib.sha256(key).hexdigest()[:8], 16) % len(BOT_SOCIAL_BEATS)
    return copy.deepcopy(BOT_SOCIAL_BEATS[index])


async def _emit_bot_chat_event(room: dict, seat: dict, phase: str, session=None):
    """Persist one idempotent, explicitly-labelled automated table event."""
    if not seat.get("is_bot"):
        return None
    beat = _bot_social_beat(room, seat, phase)
    event_id = (
        f"BOT_CHAT:{room.get('round_id') or room['id']}:"
        f"{int(room.get('turn_count', 0))}:{int(seat['seat_index'])}:{phase}"
    )
    now_iso = _now_iso()
    event = {
        "id": event_id,
        "room_id": room["id"],
        "round_id": room.get("round_id"),
        "event_type": beat["eventType"],
        "message": beat.get("message"),
        "reaction_id": beat.get("reactionId"),
        "sender_user_id": seat["user_id"],
        "masked_sender_id": rummy.masked_player_id(seat["user_id"]),
        "sender_seat_index": int(seat["seat_index"]),
        "sender_name": seat.get("display_name") or "AUTO",
        "is_bot": True,
        "bot_label": seat.get("bot_label") or "AUTO",
        "visibility": "TABLE",
        "request_status": (
            "AUTOMATED_ATMOSPHERE_SUGGESTION"
            if beat["eventType"] == "MUSIC_REQUEST" else None
        ),
        "generated_at": now_iso,
        "created_at": now_iso,
        "created_epoch": _epoch(),
    }
    try:
        await db.rummy_chat_events.insert_one(copy.deepcopy(event), **_kwargs(session))
    except DuplicateKeyError:
        return None
    return event


async def _emit_round_opening_bot_chat(room: dict, seats: list[dict], session=None):
    bot = next((seat for seat in seats if seat.get("is_bot")), None)
    if bot:
        return await _emit_bot_chat_event(room, bot, "ROUND_OPENING", session)
    return None


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
            "seat_index": {"$in": list(range(rummy.MAX_PLAYERS))},
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
        "started_at": now, "started_at_epoch": _epoch(),
        "scheduled_started_at": now, "updated_at": now,
    })
    await db.rummy_rooms.replace_one({"id": room["id"]}, room, **kwargs)
    await _emit_round_opening_bot_chat(room, seats, session)
    return room


def _validated_groups(raw_groups, owned_card_ids, *, require_full: bool = False):
    """Return a bounded exact card-id grouping or one stable client error.

    ``actionPayload`` is intentionally an otherwise-open JSON object, so all
    group-bearing actions share this validator before rules code sees the value.
    That prevents malformed nesting/unhashable objects from escaping as a 500.
    """
    owned = set(owned_card_ids)
    maximum_cards = max(rummy.HAND_SIZE, len(owned))
    if not isinstance(raw_groups, list) or len(raw_groups) > maximum_cards:
        _fail(422, "RUMMY_GROUP_FORMAT", "Groups must be a bounded list of card-id lists.")
    normalized = []
    flat = []
    for group in raw_groups:
        if not isinstance(group, list) or not group or len(group) > maximum_cards:
            _fail(422, "RUMMY_GROUP_FORMAT", "Every group must be a non-empty bounded card-id list.")
        normalized_group = []
        for card_id in group:
            if (
                not isinstance(card_id, str)
                or not card_id
                or len(card_id) > MAX_GROUP_CARD_ID_LENGTH
                or card_id != card_id.strip()
            ):
                _fail(422, "RUMMY_GROUP_FORMAT", "Every grouped card id must be a bounded string.")
            normalized_group.append(card_id)
            flat.append(card_id)
        normalized.append(normalized_group)
    if len(flat) > maximum_cards:
        _fail(422, "RUMMY_GROUP_FORMAT", "A grouping contains too many cards.")
    if len(flat) != len(set(flat)) or not set(flat).issubset(owned):
        _fail(409, "RUMMY_GROUP_OWNERSHIP", "Groups can contain each owned card at most once.")
    if require_full and (len(flat) != len(owned) or set(flat) != owned):
        _fail(409, "RUMMY_GROUPS_INCOMPLETE", "Group every remaining card exactly once before declaring.")
    return normalized


def _persisted_group_state(hand: dict, wild_rank: int):
    """Describe only the player's persisted arrangement, never a suggested one."""
    cards = hand.get("cards", [])
    owned_ids = {card["id"] for card in cards}
    raw_groups = hand.get("groups", [])
    try:
        groups = _validated_groups(raw_groups, owned_ids)
    except HTTPException as exc:
        detail = exc.detail if isinstance(exc.detail, dict) else {}
        return {
            "groups": [], "labels": [], "declarableDiscardCardIds": [],
            "validation": {
                "valid": False,
                "code": detail.get("code", "RUMMY_GROUP_FORMAT"),
                "groups": [],
            },
        }

    indexed = {card["id"]: card for card in cards}
    labels = [
        rummy.classify_group([indexed[card_id] for card_id in group], wild_rank)
        for group in groups
    ]
    if len(cards) == rummy.HAND_SIZE:
        validation = rummy.validate_declaration(cards, groups, wild_rank)
        validation["groups"] = labels
    else:
        validation = {"valid": False, "code": "DISCARD_REQUIRED", "groups": labels}

    declarable = []
    if len(cards) == rummy.HAND_SIZE + 1 and hand.get("drawn"):
        for candidate in cards:
            candidate_id = candidate["id"]
            if hand.get("draw_source") == "DISCARD" and hand.get("drawn_card_id") == candidate_id:
                continue
            remaining = [card for card in cards if card["id"] != candidate_id]
            remaining_ids = {card["id"] for card in remaining}
            candidate_groups = [
                [card_id for card_id in group if card_id != candidate_id]
                for group in groups
            ]
            candidate_groups = [group for group in candidate_groups if group]
            try:
                candidate_groups = _validated_groups(candidate_groups, remaining_ids, require_full=True)
            except HTTPException:
                continue
            if rummy.validate_declaration(remaining, candidate_groups, wild_rank)["valid"]:
                declarable.append(candidate_id)
    return {
        "groups": groups, "labels": labels,
        "declarableDiscardCardIds": declarable,
        "validation": validation,
    }


async def _public_state(room: dict, requester_id: str, session=None):
    kwargs = _kwargs(session)
    seats = await db.rummy_seats.find(
        {
            "room_id": room["id"],
            "user_id": {"$type": "string"},
            "seat_index": {"$in": list(range(rummy.MAX_PLAYERS))},
        },
        {"_id": 0}, **kwargs,
    ).sort("seat_index", 1).to_list(rummy.MAX_PLAYERS)
    valid_seat_pairs = [
        {"user_id": seat["user_id"], "seat_index": seat["seat_index"]}
        for seat in seats
    ]
    hands = await db.rummy_hands.find(
        {
            "room_id": room["id"], "round_id": room.get("round_id"),
            "$or": valid_seat_pairs,
        },
        {"_id": 0}, **kwargs,
    ).to_list(len(valid_seat_pairs)) if room.get("round_id") and valid_seat_pairs else []
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
        seat = next((
            item for item in seats
            if item.get("seat_index") == seat_index and item.get("user_id")
        ), None)
        if not seat:
            seat_rows.append({"seatIndex": seat_index, "status": "EMPTY", "cardCount": 0})
            continue
        hand = hand_by_user.get(seat["user_id"])
        avatar_url = _public_uploaded_avatar_url(seat)
        seat_rows.append({
            "seatIndex": seat_index,
            "playerId": rummy.masked_player_id(seat["user_id"]),
            "displayName": (
                _public_automated_text(seat.get("display_name"), "Automated Player")
                if seat.get("is_bot") else seat.get("display_name") or "Player"
            ),
            "avatar": seat.get("avatar") or "crown",
            "avatarUrl": avatar_url,
            "isBot": bool(seat.get("is_bot")),
            "botDifficulty": seat.get("bot_difficulty") if seat.get("is_bot") else None,
            "botLabel": (
                _public_automated_text(seat.get("bot_label"), "AUTO")
                if seat.get("is_bot") else None
            ),
            "botProfile": copy.deepcopy(seat.get("bot_profile")) if seat.get("is_bot") else None,
            "status": seat.get("status", "ACTIVE"),
            "cardCount": len(hand.get("cards", [])) if hand else 0,
            "active": room.get("state") == "TURN_ACTIVE" and room.get("current_seat") == seat_index,
            "droppedPoints": seat.get("drop_points"),
        })

    private = None
    if request_hand:
        arrangement = await _best_arrangement(request_hand["cards"], int(room["wild_rank"]))
        exact_groups = _persisted_group_state(request_hand, int(room["wild_rank"]))
        owns_live_turn = (
            room.get("state") == "TURN_ACTIVE"
            and room.get("current_seat") == request_hand["seat_index"]
            and (requester_seat or {}).get("status") == "ACTIVE"
            and not _turn_deadline_expired(room)
        )
        private = {
            "seatIndex": request_hand["seat_index"],
            "cards": request_hand["cards"],
            "groups": exact_groups["groups"],
            "groupLabels": exact_groups["labels"],
            "groupValidation": exact_groups["validation"],
            "declarableDiscardCardIds": exact_groups["declarableDiscardCardIds"],
            "drawn": bool(request_hand.get("drawn")),
            "drawnCardId": request_hand.get("drawn_card_id"),
            "suggestedGroups": arrangement["groups"],
            "ungroupedCardIds": arrangement["ungroupedCardIds"],
            "points": arrangement["score"],
            "dropPenaltyPoints": int(
                category.get("firstDropPoints", 20)
                if int((requester_seat or {}).get("turns_taken", 0)) == 0
                else category.get("middleDropPoints", 40)
            ),
            "canDraw": (
                owns_live_turn and not request_hand.get("drawn")
            ),
            "canDiscard": (
                owns_live_turn and bool(request_hand.get("drawn"))
            ),
            "canDeclare": bool(
                owns_live_turn
                and not request_hand.get("drawn")
                and exact_groups["validation"]["valid"]
            ),
        }

    top_discard = room.get("discard_pile", [])[-1] if room.get("discard_pile") else None
    proof = copy.deepcopy(room.get("shuffle_proof", {}))
    if room.get("state") in ("ROUND_SETTLED", "CANCELLED"):
        proof["seedReveal"] = room.get("shuffle_seed")
    fallback_remaining = None
    if room.get("mode") == "LIVE" and room.get("state") == "WAITING_FOR_PLAYERS":
        fallback_at = _scheduled_room_start_epoch(room)
        fallback_remaining = max(0.0, round(fallback_at - _epoch(), 3))
    bot_action = None
    if room.get("bot_action_seat") is not None:
        bot_action = {
            "seatIndex": int(room["bot_action_seat"]),
            "phase": room.get("bot_action_phase") or "THINKING",
            "readyIn": max(0.0, round(float(room.get("bot_action_ready_at") or 0) - _epoch(), 3)),
        }
    matchmaking = _public_matchmaking(room, len(seats))
    chat_events = await _recent_chat_events(room["id"], session)
    return {
        "roomId": room["id"], "roundId": room.get("round_id"),
        "mode": room["mode"], "state": room["state"], "version": room["version"],
        "serverTimestamp": _epoch(), "category": category,
        "maxPlayers": rummy.MAX_PLAYERS, "seats": seat_rows,
        "currentSeat": room.get("current_seat"), "turnEndsIn": remaining,
        "closedDeckCount": len(room.get("closed_deck", [])),
        "openDiscard": top_discard, "wildJoker": room.get("wild_joker"),
        "privateState": private, "result": _public_result(room.get("result")),
        "chat": serialize_doc(public_chat_rows),
        "walletNeutral": bool(room.get("wallet_neutral") or room.get("mode") in ("PRACTICE", BOT_TABLE_MODE)),
        "fallbackStartsIn": fallback_remaining,
        "scheduledStartAtEpoch": matchmaking["scheduledStartAtEpoch"],
        "scheduledStartIn": matchmaking["startsIn"],
        "matchmaking": matchmaking,
        "botTableNotice": (
            _public_automated_text(room.get("bot_table_notice"), "Automated players are clearly disclosed")
            if room.get("bot_table_notice") else None
        ),
        "botAction": bot_action,
        "chatEvents": chat_events,
        "shuffleProof": proof, "balance": int((user or {}).get("chip_balance", 0)),
    }


async def _latest_membership(user_id: str, session=None):
    seat = await db.rummy_seats.find_one(
        {"user_id": user_id, "status": {"$in": list(ACTIVE_SEAT_STATES)}},
        {"_id": 0}, sort=[("joined_at", -1)], **_kwargs(session),
    )
    if not seat:
        return None, None
    room = await db.rummy_rooms.find_one({"id": seat["room_id"]}, {"_id": 0}, **_kwargs(session))
    if not room or room.get("state") in ("CANCELLED",) and not room.get("round_id"):
        return None, None
    return seat, room


async def _retire_wallet_neutral_membership_for_live(
    room: dict, seat: dict, session=None,
) -> None:
    """Release one abandoned Practice/AUTO seat before a new Live join.

    Practice and scheduled AUTO fallback tables are wallet-neutral by contract,
    so recovering one of their stale memberships cannot forfeit a live stake.
    A defensive refund still restores any legacy non-zero reservation exactly
    inside the surrounding transaction. Funded LIVE rooms never enter here.

    A solo Practice room is cancelled so its automated seats cannot become an
    orphaned background game. A shared AUTO fallback keeps running for its other
    human members; only the switching player's seat is dropped.
    """
    if room.get("mode") not in ("PRACTICE", BOT_TABLE_MODE):
        _fail(
            409,
            "RUMMY_MODE_SWITCH_BLOCKED",
            "Finish or leave the current funded Rummy round before changing mode.",
        )
    if seat.get("status") not in ACTIVE_SEAT_STATES:
        _fail(409, "RUMMY_SEAT_INACTIVE", "The previous Rummy seat is no longer active.")

    kwargs = _kwargs(session)
    original_version = int(room.get("version", 0))
    category = await _room_category(room, session)
    legacy_refund = _seat_wallet_stake_chips(seat)
    if legacy_refund:
        await credit_chips(
            seat["user_id"], legacy_refund,
            "Rummy wallet-neutral table reservation restored before Live join",
            ref=f"{seat.get('stake_ref') or room['id']}:wallet-neutral-switch-refund",
            kind=ledger.REFUND, game="rummy", session=session,
        )

    points = int(
        category.get("firstDropPoints", 20)
        if int(seat.get("turns_taken", 0)) == 0
        else category.get("middleDropPoints", 40)
    )
    released = await db.rummy_seats.update_one(
        {
            "room_id": room["id"], "user_id": seat["user_id"],
            "status": {"$in": list(ACTIVE_SEAT_STATES)},
        },
        {
            "$set": {
                "status": "DROPPED", "drop_points": points,
                "wallet_stake_chips": 0,
                "switched_to_live_at": _now_iso(),
            },
            "$unset": {"active_user_key": ""},
        },
        **kwargs,
    )
    if released.modified_count != 1:
        _fail(409, "RUMMY_SEAT_INACTIVE", "The previous Rummy seat could not be released.")

    remaining_humans = await db.rummy_seats.count_documents(
        {
            "room_id": room["id"], "is_bot": {"$ne": True},
            "status": {"$in": list(ACTIVE_SEAT_STATES)},
        },
        **kwargs,
    )
    if remaining_humans == 0:
        await _cancel_room(room, "Player moved from a wallet-neutral table to Live", session)
    else:
        next_seat = room.get("current_seat")
        if (
            room.get("state") == "TURN_ACTIVE"
            and int(room.get("current_seat", -1)) == int(seat.get("seat_index", -2))
        ):
            next_seat = await _next_active_seat(room["id"], int(seat["seat_index"]), session)
        room.update({
            "current_seat": next_seat,
            "turn_deadline": (
                _epoch() + int(category["turnDurationSeconds"])
                if room.get("state") == "TURN_ACTIVE" and next_seat is not None
                else room.get("turn_deadline")
            ),
            "version": original_version + 1,
            "updated_at": _now_iso(),
        })
    await _replace_room_cas(room, original_version, session)


def _new_bot_seat(
    room: dict, category: dict, seat_index: int, bot_number: int,
    now_epoch: float | None = None,
) -> dict:
    """Build a complete, visibly labelled wallet-neutral bot seat."""
    profile = _bot_profile_snapshot(category, bot_number)
    difficulty = profile["difficulty"]
    return {
        "room_id": room["id"],
        "user_id": f"BOT:{room['id']}:{seat_index}",
        "seat_index": int(seat_index),
        "display_name": profile["name"],
        "avatar": profile["avatar"],
        "is_bot": True,
        "bot_difficulty": difficulty,
        "bot_label": f"AUTO · {difficulty.title()}",
        "bot_profile_id": profile["id"],
        "bot_profile": profile,
        "bot_logic_version": BOT_LOGIC_VERSION,
        "status": "ACTIVE",
        "entry_chips": int(category["entryChips"]),
        "wallet_stake_chips": 0,
        "turns_taken": 0,
        "missed_turns": 0,
        "joined_at": _now_iso(),
        "last_seen_at": _now_iso(),
        "last_seen_epoch": _epoch() if now_epoch is None else float(now_epoch),
    }


@router.get("/games/rummy/categories")
async def rummy_categories(user: dict = Depends(require_active_player)):
    await _require_rummy_core_ready()
    await require_playable_game("rummy")
    rows = await _categories()
    next_start = _next_live_start_epoch()
    schedule = {
        "cycleSeconds": LIVE_MATCHMAKING_CYCLE_SECONDS,
        "nextScheduledStartAtEpoch": next_start,
        "nextScheduledStartAt": datetime.fromtimestamp(next_start, tz=timezone.utc).isoformat(),
        "startsIn": max(0.0, round(next_start - _epoch(), 3)),
    }
    return {
        "categories": serialize_doc([
            {
                **row,
                "liveMatchmaking": {
                    **schedule,
                    "cycleId": f"{row['id']}:{int(next_start)}",
                },
            }
            for row in rows
        ]),
        "liveMatchmaking": schedule,
        "maxPlayers": rummy.MAX_PLAYERS,
        "currency": None,
        "unit": "chips",
    }


@router.post("/games/rummy/join")
async def rummy_join(body: JoinRequest, user: dict = Depends(require_active_player)):
    await _require_rummy_core_ready()
    await require_playable_game("rummy")

    async def join_transaction(session):
        kwargs = _kwargs(session)
        # Older rounds kept this sparse lock after a player had already
        # dropped. Retire those stale locks before matchmaking so leaving a
        # Practice table can never block an immediate Live join (or vice versa).
        await db.rummy_seats.update_many(
            {
                "user_id": user["id"],
                "status": {"$in": ["DROPPED", "LEFT", "CANCELLED", "WON", "LOST"]},
            },
            {"$unset": {"active_user_key": ""}},
            **kwargs,
        )
        existing_seat, existing_room = await _latest_membership(user["id"], session)
        if existing_seat and existing_room and existing_room.get("state") not in ("ROUND_SETTLED", "CANCELLED"):
            if existing_room.get("mode") == body.mode:
                if body.mode == "PRACTICE" and existing_room.get("state") == "WAITING_FOR_PLAYERS":
                    real_seats = await db.rummy_seats.find({
                        "room_id": existing_room["id"],
                        "is_bot": {"$ne": True},
                        "user_id": {"$type": "string"},
                        "seat_index": {"$in": list(range(rummy.MAX_PLAYERS))},
                    }, {"_id": 0}, **kwargs).to_list(rummy.MAX_PLAYERS)
                    if len(real_seats) == 1 and real_seats[0].get("user_id") == user["id"]:
                        category = await _room_category(existing_room, session)
                        real_seat_index = int(real_seats[0]["seat_index"])
                        await db.rummy_seats.delete_many({
                            "room_id": existing_room["id"],
                            "$or": [
                                {"user_id": {"$ne": user["id"]}},
                                {"seat_index": {"$ne": real_seat_index}},
                            ],
                        }, **kwargs)
                        free = [
                            index for index in range(rummy.MAX_PLAYERS)
                            if index != real_seat_index
                        ]
                        now_epoch = _epoch()
                        await db.rummy_seats.insert_many([
                            _new_bot_seat(
                                existing_room, category, seat_index, bot_number, now_epoch,
                            )
                            for bot_number, seat_index in enumerate(free, start=1)
                        ], **kwargs)
                        existing_room["seat_count"] = rummy.MAX_PLAYERS
                        existing_room = await _start_round(existing_room, category, session)
                return await _public_state(existing_room, user["id"], session)
            if (
                body.mode == "LIVE"
                and existing_room.get("mode") in ("PRACTICE", BOT_TABLE_MODE)
            ):
                await _retire_wallet_neutral_membership_for_live(
                    existing_room, existing_seat, session,
                )
                existing_seat = None
                existing_room = None
            elif existing_room.get("state") != "WAITING_FOR_PLAYERS":
                _fail(
                    409,
                    "RUMMY_MODE_SWITCH_BLOCKED",
                    "Finish or leave the current funded Rummy round before changing mode.",
                )
            else:
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
        scheduled_start = _next_live_start_epoch() if body.mode == "LIVE" else None
        if body.mode == "LIVE":
            room = await db.rummy_rooms.find_one(
                {
                    "category_id": body.categoryId, "mode": "LIVE",
                    "state": "WAITING_FOR_PLAYERS", "seat_count": {"$lt": rummy.MAX_PLAYERS},
                    "scheduled_start_at_epoch": scheduled_start,
                }, {"_id": 0}, sort=[("created_at", 1)], **kwargs,
            )
        if not room:
            created_epoch = _epoch()
            schedule_metadata = (
                _live_cycle_metadata(body.categoryId, scheduled_start)
                if scheduled_start is not None else {}
            )
            room = {
                "id": str(uuid.uuid4()), "category_id": body.categoryId,
                "category_snapshot": _freeze_category(current_category),
                "mode": body.mode, "state": "WAITING_FOR_PLAYERS", "version": 0,
                "seat_count": 0, "max_players": rummy.MAX_PLAYERS,
                "requested_mode": body.mode,
                **schedule_metadata,
                "fallback_at_epoch": (
                    scheduled_start
                    if body.mode == "LIVE" else None
                ),
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
            "display_name": current_user.get("display_name") or "Player",
            "avatar": current_user.get("avatar") or "crown",
            "avatar_source": current_user.get("avatar_source") or "PRESET",
            "avatar_upload_id": current_user.get("avatar_upload_id"),
            "avatar_url": _public_uploaded_avatar_url(current_user),
            "is_bot": False, "status": "ACTIVE", "entry_chips": int(category["entryChips"]),
            "wallet_stake_chips": wallet_stake,
            "turns_taken": 0, "missed_turns": 0, "stake_ref": stake_ref if wallet_stake else None,
            "joined_at": _now_iso(), "last_seen_at": _now_iso(), "last_seen_epoch": now_epoch,
        }
        await db.rummy_seats.insert_one(seat, **kwargs)
        room["seat_count"] = int(room.get("seat_count", 0)) + 1

        if body.mode in ("PRACTICE", BOT_TABLE_MODE):
            bots = [
                _new_bot_seat(room, category, index, index, now_epoch)
                for index in range(1, rummy.MAX_PLAYERS)
            ]
            await db.rummy_seats.insert_many(bots, **kwargs)
            room["seat_count"] = rummy.MAX_PLAYERS
            room["wallet_neutral"] = True
            if body.mode == BOT_TABLE_MODE:
                room["bot_table_notice"] = "Practice table · AUTO players clearly disclosed · no wallet stake or payout"

        live_waits_for_schedule = (
            body.mode == "LIVE" and _epoch() < _scheduled_room_start_epoch(room)
        )
        if room["seat_count"] == rummy.MAX_PLAYERS and not live_waits_for_schedule:
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


async def _activate_scheduled_room(room_id: str) -> bool:
    """Start one due room, filling missing seats without economic ambiguity.

    A complete five-human room remains LIVE and settles its fully funded pot.
    An incomplete room first refunds *every* human reservation, then changes to
    a visibly labelled wallet-neutral BOT_TABLE before bot seats or cards are
    created. Thus no zero-stake bot can win a funded pot and no human can lose a
    live stake to automation. Shuffle/deal remain the same secure random path.
    """
    async def mutate(session):
        kwargs = _kwargs(session)
        room = await db.rummy_rooms.find_one({"id": room_id}, {"_id": 0}, **kwargs)
        if not room or room.get("mode") != "LIVE" or room.get("state") != "WAITING_FOR_PLAYERS":
            return False
        scheduled_start = _scheduled_room_start_epoch(room)
        if _epoch() < scheduled_start:
            return False

        category = await _room_category(room, session)
        humans = await db.rummy_seats.find(
            {
                "room_id": room_id,
                "is_bot": {"$ne": True},
                "status": {"$in": list(ACTIVE_SEAT_STATES)},
            },
            {"_id": 0}, **kwargs,
        ).sort("seat_index", 1).to_list(rummy.MAX_PLAYERS)
        if not humans:
            room.update({
                "state": "CANCELLED",
                "cancel_reason": "Scheduled matchmaking contained no active players",
                "current_seat": None,
                "turn_deadline": None,
                "settled_at": _now_iso(),
                "version": int(room.get("version", 0)) + 1,
                "updated_at": _now_iso(),
            })
            await db.rummy_rooms.replace_one({"id": room_id}, room, **kwargs)
            return True
        if len(humans) >= rummy.MAX_PLAYERS:
            room.update({
                "scheduled_started_at": _now_iso(),
                "scheduled_start_at_epoch": scheduled_start,
            })
            await _start_round(room, category, session)
            return True

        refunded_total = 0
        for seat in humans:
            refund = _seat_wallet_stake_chips(seat)
            if refund:
                stake_ref = seat.get("stake_ref") or f"rummy-seat:{room_id}:{seat['user_id']}"
                refund_ref = f"{stake_ref}:bot-fallback-refund"
                await credit_chips(
                    seat["user_id"], refund,
                    "Rummy live matchmaking moved to a wallet-neutral practice table",
                    ref=refund_ref, kind=ledger.REFUND, game="rummy", session=session,
                )
                refunded_total += refund
                zeroed = await db.rummy_seats.update_one(
                    {"room_id": room_id, "user_id": seat["user_id"], "wallet_stake_chips": refund},
                    {"$set": {
                        "wallet_stake_chips": 0,
                        "fallback_refunded_chips": refund,
                        "fallback_refund_ref": refund_ref,
                        "fallback_refunded_at": _now_iso(),
                    }},
                    **kwargs,
                )
                if zeroed.modified_count != 1:
                    _fail(409, "RUMMY_STAKE_CHANGED", "The reserved stake changed before practice fallback.")

        occupied = {int(seat["seat_index"]) for seat in humans}
        free = [index for index in range(rummy.MAX_PLAYERS) if index not in occupied]
        bots = [
            _new_bot_seat(room, category, seat_index, bot_number)
            for bot_number, seat_index in enumerate(free, start=1)
        ]
        if bots:
            await db.rummy_seats.insert_many(bots, **kwargs)
        room.update({
            "mode": BOT_TABLE_MODE,
            "requested_mode": "LIVE",
            "seat_count": rummy.MAX_PLAYERS,
            "wallet_neutral": True,
            "economic_mode": "WALLET_NEUTRAL",
            "fallback_from_live": True,
            "fallback_activated_at": _now_iso(),
            "fallback_refunded_chips": refunded_total,
            "matchmaking_filled_by_bots": len(bots),
            "bot_table_notice": (
                "Scheduled match · fair AUTO players clearly disclosed · "
                "live stakes refunded · no wallet payout"
            ),
        })
        await _start_round(room, category, session)
        return True

    return await run_game_transaction(client, mutate)


async def _activate_live_bot_fallback(room_id: str, requester_id: str) -> bool:
    """Member-authorized compatibility wrapper for request-driven polling."""
    membership = await db.rummy_seats.find_one(
        {"room_id": room_id, "user_id": requester_id}, {"_id": 0, "user_id": 1},
    )
    if not membership:
        _fail(403, "RUMMY_NOT_A_MEMBER", "You do not occupy a seat at this table.")
    return await _activate_scheduled_room(room_id)


async def advance_due_rummy_matchmaking(limit: int = 50) -> dict:
    """Background-safe sweep for due three-minute Rummy table starts."""
    if not _RUMMY_CORE_READY:
        return {"checked": 0, "started": 0}
    now = _epoch()
    rows = await db.rummy_rooms.find(
        {
            "mode": "LIVE",
            "state": "WAITING_FOR_PLAYERS",
            "$or": [
                {"scheduled_start_at_epoch": {"$lte": now}},
                {
                    "scheduled_start_at_epoch": {"$exists": False},
                    "fallback_at_epoch": {"$lte": now},
                },
            ],
        },
        {"_id": 0, "id": 1},
    ).sort("scheduled_start_at_epoch", 1).to_list(max(1, min(100, int(limit))))
    started = 0
    for row in rows:
        if await _activate_scheduled_room(row["id"]):
            started += 1
    return {"checked": len(rows), "started": started}


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
            "displayName": (
                _public_automated_text(seat.get("display_name"), "Automated Player")
                if seat.get("is_bot") else seat.get("display_name") or "Player"
            ),
            "isBot": bool(seat.get("is_bot")),
            "botLabel": (
                _public_automated_text(seat.get("bot_label"), "AUTO")
                if seat.get("is_bot") else None
            ),
            "botProfile": copy.deepcopy(seat.get("bot_profile")) if seat.get("is_bot") else None,
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
        if seat.get("is_bot") and seat.get("bot_profile_id"):
            await db.rummy_bot_profiles.update_one(
                {"id": seat["bot_profile_id"]},
                {
                    "$inc": {
                        "rounds_completed": 1,
                        "wins": 1 if won else 0,
                        "turns_completed": int(seat.get("turns_taken", 0)),
                    },
                    "$set": {
                        "is_bot": True,
                        "public_label": "AUTO",
                        "logic_version": BOT_LOGIC_VERSION,
                        "last_played_at": _now_iso(),
                    },
                    "$setOnInsert": {
                        "name": seat.get("display_name") or "AUTO",
                        "created_at": _now_iso(),
                    },
                },
                upsert=True,
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
            "winnerName": (
                _public_automated_text(winner_seat.get("display_name"), "Automated Player")
                if winner_seat.get("is_bot") else winner_seat.get("display_name") or "Player"
            ),
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
                {
                    "$set": updates,
                    **({"$unset": {"active_user_key": ""}} if updates.get("status") == "DROPPED" else {}),
                }, **kwargs,
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
        difficulty = (
            rummy.bot_difficulty(seat.get("bot_difficulty"))
            if seat.get("is_bot") else "expert"
        )
        if seat.get("is_bot"):
            current_phase = (
                room.get("bot_action_phase")
                if int(room.get("bot_action_seat", -1)) == int(seat["seat_index"])
                else None
            )
            if current_phase not in ("DRAWING", "DISCARDING"):
                room.update({
                    "bot_action_seat": int(seat["seat_index"]),
                    "bot_action_phase": "DRAWING",
                    "bot_action_ready_at": _epoch() + _bot_think_delay_seconds(difficulty),
                    "version": original_version + 1,
                    "updated_at": _now_iso(),
                })
                await _replace_room_cas(room, original_version, session)
                await db.rummy_actions.insert_one({
                    "room_id": room_id, "round_id": room.get("round_id"),
                    "user_id": seat["user_id"], "action_id": f"BOT_THINK:{original_version}",
                    "action_type": "BOT_THINK", "accepted": True,
                    "version": room["version"], "created_at": _now_iso(),
                }, **kwargs)
                # Social timing is table metadata only. It never receives a
                # hand, covered deck, opponent private state or settlement.
                if (
                    int(room.get("turn_count", 0)) + int(seat["seat_index"])
                ) % 3 == 0:
                    await _emit_bot_chat_event(room, seat, "TURN_THINKING", session)
                return True
            if float(room.get("bot_action_ready_at") or 0) > _epoch():
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
                    {
                        "$set": {"status": "DROPPED", "drop_points": points},
                        "$unset": {"active_user_key": ""},
                    }, **kwargs,
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
            draw_source = "CLOSED"
            if seat.get("is_bot"):
                open_discard = room.get("discard_pile", [])[-1] if room.get("discard_pile") else None
                draw_source = await _choose_bot_draw_source(
                    hand["cards"], open_discard, int(room["wild_rank"]), difficulty,
                )
            if draw_source == "DISCARD" and room.get("discard_pile"):
                drawn = room["discard_pile"].pop()
            else:
                draw_source = "CLOSED"
                if not await _replenish_closed_deck(room):
                    await _cancel_room(room, "The draw pile could not continue", session)
                    await _replace_room_cas(room, original_version, session)
                    return True
                drawn = room["closed_deck"].pop()
            hand["cards"].append(drawn)
            hand.update({
                "drawn": True, "drawn_card_id": drawn["id"],
                "draw_source": draw_source, "updated_at": _now_iso(),
            })
            if seat.get("is_bot"):
                await db.rummy_hands.replace_one(
                    {"room_id": room_id, "round_id": room["round_id"], "user_id": seat["user_id"]},
                    hand, **kwargs,
                )
                room.update({
                    "bot_action_phase": "DISCARDING",
                    "bot_action_ready_at": _epoch() + _bot_discard_delay_seconds(difficulty),
                    "version": original_version + 1,
                    "updated_at": _now_iso(),
                })
                await _replace_room_cas(room, original_version, session)
                await db.rummy_actions.insert_one({
                    "room_id": room_id, "round_id": room.get("round_id"),
                    "user_id": seat["user_id"], "action_id": f"BOT_DRAW:{original_version}",
                    "action_type": f"BOT_DRAW_{draw_source}", "accepted": True,
                    "version": room["version"], "created_at": _now_iso(),
                }, **kwargs)
                return True

        forbidden = hand.get("drawn_card_id") if hand.get("draw_source") == "DISCARD" else None
        discard = await _choose_bot_discard(
            hand["cards"], int(room["wild_rank"]), difficulty, forbidden,
        )
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
        room.pop("bot_action_seat", None)
        room.pop("bot_action_phase", None)
        room.pop("bot_action_ready_at", None)
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
            "action_type": "BOT_DISCARD" if seat.get("is_bot") else "TIMEOUT_TURN",
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
    exactly the sum previously debited. Practice and fallback bot-table entries
    remain visible table values but every wallet stake and payout must be zero,
    so a bot table cannot mint or consume usable chips.
    """
    if len(seats) != rummy.MAX_PLAYERS:
        _fail(409, "RUMMY_STAKE_INVALID", "A complete five-seat pot is required.")
    stakes = [_seat_entry_chips(seat) for seat in seats]
    wallet_stakes = [_seat_wallet_stake_chips(seat) for seat in seats]
    pot = sum(stakes)
    real_stake_total = sum(wallet_stakes)
    if mode == "LIVE":
        if real_stake_total != pot:
            _fail(409, "RUMMY_STAKE_INVALID", "The live Rummy pot does not match its wallet debits.")
        human_payout = 0 if winner_is_bot else real_stake_total
    elif mode in ("PRACTICE", BOT_TABLE_MODE):
        if real_stake_total != 0:
            _fail(409, "RUMMY_STAKE_INVALID", "A wallet-neutral Rummy table contains a wallet stake.")
        human_payout = 0
    else:
        _fail(409, "RUMMY_MODE_INVALID", "The Rummy table mode cannot be settled.")
    return {
        "pot": pot,
        "humanPayout": human_payout,
        "seatStakeTotal": pot,
        "realStakeTotal": real_stake_total,
    }


async def _apply_invalid_declaration(room, seat, validation, category, session):
    """Apply the one configured invalid-declaration penalty and advance/settle."""
    kwargs = _kwargs(session)
    await db.rummy_seats.update_one(
        {"room_id": room["id"], "user_id": seat["user_id"]},
        {
            "$set": {
                "status": "DROPPED",
                "drop_points": int(category.get("invalidDeclarationPoints", 80)),
                "invalid_declaration": validation["code"],
            },
            "$unset": {"active_user_key": ""},
        },
        **kwargs,
    )
    room["last_declaration"] = {
        "seatIndex": seat["seat_index"], "valid": False, "code": validation["code"],
    }
    active = await _active_seats(room["id"], session)
    if len(active) <= 1:
        winner = active[0]["user_id"] if active else None
        if winner:
            await _settle_room(room, winner, "INVALID_DECLARATION", session)
        else:
            await _cancel_room(room, "No player remained after an invalid declaration", session)
        return
    next_index = await _next_active_seat(room["id"], int(room["current_seat"]), session)
    room.update({
        "current_seat": next_index,
        "turn_count": int(room.get("turn_count", 0)) + 1,
        "turn_deadline": _epoch() + int(category["turnDurationSeconds"]),
        "version": int(room["version"]) + 1,
        "updated_at": _now_iso(),
    })


def _chat_rate_policy(event_type: str) -> tuple[str, int, int]:
    if event_type == "HELP_DESK":
        return "HELP_DESK", SUPPORT_RATE_WINDOW_SECONDS, 1
    if event_type == "MUSIC_REQUEST":
        return "MUSIC_REQUEST", SUPPORT_RATE_WINDOW_SECONDS, 1
    return "TABLE_CHAT", CHAT_RATE_WINDOW_SECONDS, CHAT_RATE_MAX_EVENTS


async def _claim_chat_rate_token(room_id: str, user_id: str, event_type: str):
    """Atomically claim a fixed-window token outside gameplay transactions."""
    scope, window, maximum = _chat_rate_policy(event_type)
    now = _epoch()
    bucket = int(now // window)
    # Help/music requests enter one shared CRM inbox, so their abuse limit is
    # global per account rather than bypassable by changing table/room ids.
    limiter_room = "GLOBAL" if scope in ("HELP_DESK", "MUSIC_REQUEST") else room_id
    limiter_id = f"{limiter_room}:{user_id}:{scope}:{bucket}"
    expires_epoch = (bucket + 2) * window
    try:
        row = await db.rummy_chat_rate_limits.find_one_and_update(
            {"_id": limiter_id},
            {
                "$setOnInsert": {
                    "room_id": None if limiter_room == "GLOBAL" else room_id,
                    "limiter_room": limiter_room,
                    "user_id": user_id,
                    "scope": scope,
                    "bucket": bucket,
                    "created_at": _now_iso(),
                    "expires_at": datetime.fromtimestamp(expires_epoch, tz=timezone.utc),
                },
                "$inc": {"count": 1},
            },
            upsert=True,
            return_document=ReturnDocument.AFTER,
        )
    except DuplicateKeyError:
        row = await db.rummy_chat_rate_limits.find_one_and_update(
            {"_id": limiter_id},
            {"$inc": {"count": 1}},
            return_document=ReturnDocument.AFTER,
        )
    if int((row or {}).get("count", maximum + 1)) > maximum:
        retry_after = max(1, int(((bucket + 1) * window) - now) + 1)
        raise HTTPException(
            status_code=429,
            detail={
                "code": "RUMMY_CHAT_RATE_LIMITED",
                "message": "Please wait before sending another table request.",
                "retryAfterSeconds": retry_after,
            },
        )


async def _prior_player_chat(room_id: str, user_id: str, request_id: str):
    return await db.rummy_chat_events.find_one(
        {
            "room_id": room_id,
            "sender_user_id": user_id,
            "client_request_id": request_id,
        },
        {"_id": 0},
    )


@router.get("/games/rummy/rooms/{room_id}/chat")
async def rummy_table_chat(
    room_id: str,
    afterEpoch: float = Query(default=0.0, ge=0.0),
    limit: int = Query(default=50, ge=1, le=100),
    user: dict = Depends(require_active_player),
):
    await _require_rummy_core_ready()
    await require_playable_game("rummy")
    await _load_membership(room_id, user["id"])
    rows = await db.rummy_chat_events.find(
        {
            "room_id": room_id,
            "created_epoch": {"$gt": float(afterEpoch)},
            "$or": [
                {"visibility": "TABLE"},
                {
                    "visibility": {"$exists": False},
                    "event_type": {"$nin": ["HELP_DESK", "MUSIC_REQUEST"]},
                },
            ],
        },
        {"_id": 0},
    ).sort("created_epoch", 1).to_list(limit)
    return {
        "events": [_public_chat_event(row) for row in rows],
        "serverTimestamp": _epoch(),
    }


@router.post("/games/rummy/rooms/{room_id}/chat")
async def rummy_table_chat_send(
    room_id: str,
    body: RummyChatRequest,
    user: dict = Depends(require_active_player),
):
    await _require_rummy_core_ready()
    await require_playable_game("rummy")
    room, seat = await _load_membership(room_id, user["id"])
    if body.eventType != "HELP_DESK" and (
        seat.get("status") not in ACTIVE_SEAT_STATES
        or room.get("state") not in ("WAITING_FOR_PLAYERS", "TURN_ACTIVE")
    ):
        _fail(409, "RUMMY_CHAT_CLOSED", "Table chat is closed for this completed seat.")
    prior = await _prior_player_chat(room_id, user["id"], body.requestId)
    if prior:
        return {
            "accepted": True,
            "event": _public_chat_event(prior),
            "requestStatus": prior.get("request_status"),
        }

    await _claim_chat_rate_token(room_id, user["id"], body.eventType)
    fresh_user = await db.users.find_one(
        {"id": user["id"]}, {"_id": 0, "email": 1, "display_name": 1},
    )
    user_email = (fresh_user or {}).get("email") or user.get("email")
    user_display_name = (
        (fresh_user or {}).get("display_name")
        or user.get("display_name")
        or seat.get("display_name")
        or ((user_email or "Player").split("@")[0])
    )
    now_iso = _now_iso()
    event = {
        "id": str(uuid.uuid4()),
        "room_id": room_id,
        "round_id": room.get("round_id"),
        "client_request_id": body.requestId,
        "event_type": body.eventType,
        "message": body.message,
        "reaction_id": body.reactionId,
        "sender_user_id": user["id"],
        "masked_sender_id": rummy.masked_player_id(user["id"]),
        "sender_seat_index": int(seat["seat_index"]),
        "sender_name": seat.get("display_name") or "Player",
        "is_bot": False,
        "bot_label": None,
        "visibility": (
            "PRIVATE_REQUEST"
            if body.eventType in ("HELP_DESK", "MUSIC_REQUEST") else "TABLE"
        ),
        "request_status": (
            "SUBMITTED" if body.eventType in ("HELP_DESK", "MUSIC_REQUEST") else None
        ),
        "generated_at": now_iso,
        "created_at": now_iso,
        "created_epoch": _epoch(),
    }
    async def persist_chat(session):
        kwargs = _kwargs(session)
        await db.rummy_chat_events.insert_one(copy.deepcopy(event), **kwargs)
        if body.eventType in ("HELP_DESK", "MUSIC_REQUEST"):
            support_request = {
                "id": event["id"],
                "request_type": body.eventType,
                "source": "RUMMY_TABLE",
                "room_id": room_id,
                "round_id": room.get("round_id"),
                "user_id": user["id"],
                "masked_user_id": rummy.masked_player_id(user["id"]),
                "message": body.message,
                "status": "SUBMITTED",
                "automated_reply_created": False,
                "created_at": now_iso,
                "created_epoch": event["created_epoch"],
            }
            await db.rummy_support_requests.insert_one(support_request, **kwargs)
            request_label = (
                "Help Desk" if body.eventType == "HELP_DESK" else "Music Request"
            )
            await db.support_messages.insert_one({
                "id": f"rummy-support:{event['id']}",
                "user_id": user["id"],
                "user_email": user_email,
                "user_display_name": user_display_name,
                "sender": "USER",
                "body": (
                    f"[Rummy · {request_label} · {room.get('category_id')} · "
                    f"room {room_id}] {body.message}"
                ),
                "read_admin": False,
                "read_user": True,
                "source": "RUMMY_TABLE",
                "request_type": body.eventType,
                "rummy_room_id": room_id,
                "rummy_round_id": room.get("round_id"),
                "rummy_event_id": event["id"],
                "created_at": now_iso,
            }, **kwargs)

    try:
        await run_game_transaction(client, persist_chat)
    except DuplicateKeyError:
        prior = await _prior_player_chat(room_id, user["id"], body.requestId)
        if prior:
            return {
                "accepted": True,
                "event": _public_chat_event(prior),
                "requestStatus": prior.get("request_status"),
            }
        raise

    return {
        "accepted": True,
        "event": _public_chat_event(event),
        "requestStatus": event.get("request_status"),
    }


@router.get("/games/rummy/rooms/{room_id}/state")
async def rummy_room_state(room_id: str, user: dict = Depends(require_active_player)):
    await _require_rummy_core_ready()
    await require_playable_game("rummy")
    room, seat = await _load_membership(room_id, user["id"])
    await _activate_live_bot_fallback(room_id, user["id"])
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


@router.post("/games/rummy/rooms/{room_id}/legacy-chat", include_in_schema=False)
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
    await _require_rummy_core_ready()
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
            turn_actions = {
                "DRAW_CLOSED", "DRAW_DISCARD", "DISCARD", "DECLARE",
                "DISCARD_AND_DECLARE",
            }
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
                owned = {card["id"] for card in hand["cards"]}
                groups = _validated_groups(groups, owned)
                hand = _apply_private_groups(hand, groups)
                private_changed = True
            elif action == "SORT":
                # Auto Sort is deliberately a client presentation operation.
                # The acknowledgement is idempotent but authoritative cards and
                # the room version remain unchanged.
                code = "SORT_LOCAL_ONLY"
            elif action == "DISCARD_AND_DECLARE":
                if not hand.get("drawn") or len(hand.get("cards", [])) != rummy.HAND_SIZE + 1:
                    _fail(409, "RUMMY_DRAW_REQUIRED", "Draw one card before discarding and declaring.")
                card_id = body.actionPayload.get("cardId")
                if not isinstance(card_id, str) or not card_id:
                    _fail(422, "RUMMY_CARD_FORMAT", "Choose one owned card to discard.")
                card = next((item for item in hand["cards"] if item["id"] == card_id), None)
                if not card:
                    _fail(409, "RUMMY_CARD_NOT_OWNED", "That card is not in your hand.")
                if hand.get("draw_source") == "DISCARD" and hand.get("drawn_card_id") == card_id:
                    _fail(409, "RUMMY_PICK_DISCARD_LOOP", "A picked open card cannot be returned immediately.")
                remaining = [item for item in hand["cards"] if item["id"] != card_id]
                groups = _validated_groups(
                    body.actionPayload.get("groups"),
                    {item["id"] for item in remaining},
                )
                validation = rummy.validate_declaration(remaining, groups, int(room["wild_rank"]))
                hand.update({
                    "cards": remaining, "groups": groups, "drawn": False,
                    "drawn_card_id": None, "draw_source": None, "updated_at": _now_iso(),
                })
                room.setdefault("discard_pile", []).append(card)
                await db.rummy_hands.replace_one(
                    {"room_id": room_id, "round_id": room["round_id"], "user_id": user["id"]},
                    hand, **kwargs,
                )
                await db.rummy_seats.update_one(
                    {"room_id": room_id, "user_id": user["id"]},
                    {"$inc": {"turns_taken": 1}, "$set": {"last_action_at": _now_iso()}},
                    **kwargs,
                )
                if validation["valid"]:
                    await _settle_room(room, user["id"], "VALID_DECLARATION", session)
                    code = "VALID_DECLARATION"
                else:
                    category = await _room_category(room, session)
                    await _apply_invalid_declaration(room, seat, validation, category, session)
                    code = validation["code"]
                changed = True
            elif action == "DECLARE":
                if hand.get("drawn") or len(hand.get("cards", [])) != rummy.HAND_SIZE:
                    _fail(409, "RUMMY_DISCARD_BEFORE_DECLARE", "Discard to thirteen cards before declaring.")
                groups = _validated_groups(
                    body.actionPayload.get("groups", hand.get("groups", [])),
                    {item["id"] for item in hand["cards"]},
                )
                validation = rummy.validate_declaration(hand["cards"], groups, int(room["wild_rank"]))
                if validation["valid"]:
                    hand["groups"] = groups
                    await _settle_room(room, user["id"], "VALID_DECLARATION", session)
                    code = "VALID_DECLARATION"
                else:
                    category = await _room_category(room, session)
                    await _apply_invalid_declaration(room, seat, validation, category, session)
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
                    {
                        "$set": {"status": "DROPPED", "drop_points": points, "dropped_at": _now_iso()},
                        "$unset": {"active_user_key": ""},
                    }, **kwargs,
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
