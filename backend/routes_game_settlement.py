"""Private, feature-gated ingress for a trusted game-resolution worker.

The Unity client must never call this router.  It exists for the case where the
server-authoritative game engine is split from the FastAPI web process: that
trusted engine can submit a completed *server-calculated* action over a
timestamped HMAC channel, and only this FastAPI service holds the Supabase
service-role credential used by :mod:`trusted_game_settlement`.

The route is indistinguishable from a missing path until both the bridge flag
and a sufficiently strong HMAC secret are configured.  It is deliberately
hidden from OpenAPI and has no browser CORS use case.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import os
import re
import time
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from pymongo.errors import DuplicateKeyError

from db import db
from trusted_game_settlement import (
    MAX_SETTLEMENT_POINTS,
    BridgeSettings,
    GameSettlement,
    SettlementConfigurationError,
    SettlementTransportError,
    SupabaseGameSettlementBridge,
    bridge_enabled,
    load_bridge_settings,
)


router = APIRouter(prefix="/internal/game-settlements", tags=["internal-game-settlement"])

_NONCE_RE = re.compile(r"^[A-Za-z0-9_-]{16,128}$")
_SIGNATURE_RE = re.compile(r"^[0-9a-f]{64}$")
_REPLAY_WINDOW_SECONDS = 90
_HMAC_SECRET_ENV = "GAME_SETTLEMENT_INTERNAL_HMAC_SECRET"
_nonce_index_lock = asyncio.Lock()
_nonce_index_ready = False


class SettlementActionRequest(BaseModel):
    """Signed contract accepted from a trusted game resolver only.

    There is no ``delta`` field: the three permitted actions determine the
    direction.  A user-facing client does not receive the HMAC secret and must
    use ordinary game action routes instead.
    """

    model_config = ConfigDict(extra="forbid")

    player_profile_id: str = Field(min_length=36, max_length=36)
    game_slug: str = Field(min_length=1, max_length=64)
    round_id: str = Field(min_length=1, max_length=160)
    event_id: str = Field(min_length=1, max_length=160)
    action: str = Field(pattern=r"^(STAKE|PRIZE|REFUND)$")
    amount: int = Field(ge=1, le=MAX_SETTLEMENT_POINTS, strict=True)
    note: str | None = Field(default=None, max_length=500)


def _not_found() -> None:
    # Do not let an unauthenticated caller distinguish a disabled bridge from a
    # valid but intentionally hidden private endpoint.
    raise HTTPException(status_code=404, detail="Not found")


def _unauthorized() -> None:
    raise HTTPException(
        status_code=401,
        detail="Unauthorized",
        headers={"WWW-Authenticate": "Game-Resolver-HMAC"},
    )


def _target(request: Request) -> str:
    query = request.url.query
    return f"{request.url.path}?{query}" if query else request.url.path


def signed_payload(request: Request, timestamp: str, nonce: str, body: bytes) -> bytes:
    """Return the exact canonical byte string an internal resolver signs."""

    body_digest = hashlib.sha256(body).hexdigest()
    return "\n".join((request.method.upper(), _target(request), timestamp, nonce, body_digest)).encode("utf-8")


def _load_enabled_settings() -> BridgeSettings:
    try:
        settings = load_bridge_settings()
    except SettlementConfigurationError as exc:
        # The operator needs to correct Render secrets, not expose configuration
        # details through a public response.
        raise HTTPException(status_code=503, detail="Game settlement service unavailable") from exc
    if settings is None:
        _not_found()
    return settings


def _hmac_secret_or_not_found() -> bytes:
    secret = os.environ.get(_HMAC_SECRET_ENV, "")
    # A short, memorable phrase is not acceptable authorization for point
    # movement.  Require at least 32 characters from a generated secret.
    if len(secret) < 32:
        _not_found()
    return secret.encode("utf-8")


async def ensure_indexes() -> bool:
    """Create a short-lived nonce cache only when this bridge is enabled.

    The application calls this at startup.  With the default disabled setting,
    it performs no database operation, which keeps existing production behavior
    unchanged.
    """

    global _nonce_index_ready
    if _nonce_index_ready:
        return True
    if not bridge_enabled():
        return False
    # Validate the configuration first.  An enabled-but-broken bridge must not
    # receive requests without replay protection.
    _load_enabled_settings()
    _hmac_secret_or_not_found()
    async with _nonce_index_lock:
        if not _nonce_index_ready:
            await db.game_settlement_nonces.create_index("expires_at", expireAfterSeconds=0)
            _nonce_index_ready = True
    return True


async def _consume_nonce(nonce: str) -> None:
    """Persist a nonce before Supabase is called, making replays fail closed."""

    try:
        if not await ensure_indexes():
            _not_found()
    except HTTPException:
        raise
    except Exception as exc:
        # A failed index setup is equivalent to an unavailable replay cache.
        # Do not let the resolver continue with an unverifiable nonce.
        raise HTTPException(status_code=503, detail="Game settlement service unavailable") from exc
    nonce_id = hashlib.sha256(nonce.encode("utf-8")).hexdigest()
    try:
        await db.game_settlement_nonces.insert_one({
            "_id": nonce_id,
            "expires_at": datetime.now(timezone.utc) + timedelta(seconds=_REPLAY_WINDOW_SECONDS),
        })
    except DuplicateKeyError:
        _unauthorized()
    except Exception as exc:
        # If the replay cache is unavailable, do not risk applying a credit
        # twice merely because a resolver retries after a timeout.
        raise HTTPException(status_code=503, detail="Game settlement service unavailable") from exc


async def require_internal_authorization(request: Request) -> BridgeSettings:
    """Validate a one-use HMAC before parsing or applying a settlement action."""

    settings = _load_enabled_settings()
    secret = _hmac_secret_or_not_found()
    timestamp = request.headers.get("x-game-settlement-timestamp", "")
    nonce = request.headers.get("x-game-settlement-nonce", "")
    signature = request.headers.get("x-game-settlement-signature", "")
    if not timestamp.isdecimal() or not _NONCE_RE.fullmatch(nonce) or not _SIGNATURE_RE.fullmatch(signature):
        _unauthorized()
    try:
        timestamp_int = int(timestamp)
    except ValueError:
        _unauthorized()
    if abs(time.time() - timestamp_int) > _REPLAY_WINDOW_SECONDS:
        _unauthorized()

    body = await request.body()
    if not body or len(body) > 32 * 1024:
        _unauthorized()
    expected = hmac.new(secret, signed_payload(request, timestamp, nonce, body), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, signature):
        _unauthorized()
    await _consume_nonce(nonce)
    return settings


def _to_settlement(body: SettlementActionRequest) -> GameSettlement:
    if body.action == "STAKE":
        return GameSettlement.stake(
            body.player_profile_id, body.game_slug, body.round_id, body.event_id, body.amount, body.note
        )
    if body.action == "PRIZE":
        return GameSettlement.prize(
            body.player_profile_id, body.game_slug, body.round_id, body.event_id, body.amount, body.note
        )
    return GameSettlement.refund(
        body.player_profile_id, body.game_slug, body.round_id, body.event_id, body.amount, body.note
    )


@router.post("", include_in_schema=False)
async def apply_game_settlement(
    body: SettlementActionRequest,
    settings: BridgeSettings = Depends(require_internal_authorization),
) -> JSONResponse:
    """Apply one HMAC-authorized, server-calculated point movement.

    This does not accept a client balance, an arbitrary delta, a service key,
    or an administrator action.  The Supabase SQL RPC independently validates
    player status, signs, amount, and idempotency before changing its immutable
    ledger.
    """

    try:
        settlement = _to_settlement(body)
        receipt = await SupabaseGameSettlementBridge(settings).apply(settlement)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="Invalid game settlement") from exc
    except SettlementTransportError as exc:
        raise HTTPException(status_code=503, detail="Game settlement service unavailable") from exc
    return JSONResponse(
        {
            "ledger_id": receipt.ledger_id,
            "balance_after": receipt.balance_after,
            "duplicate": receipt.duplicate,
        },
        headers={"Cache-Control": "no-store, max-age=0", "Pragma": "no-cache"},
    )
