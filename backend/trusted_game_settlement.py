"""Narrow, server-to-server bridge for Supabase virtual-point settlement.

This module is deliberately *not* an HTTP API for a game client.  A Unity APK
may authenticate and ask the existing FastAPI game routes to place a bet, but
it must never be able to submit a balance delta, a payout, or a Supabase
credential.  A trusted resolver creates :class:`GameSettlement` only after it
has applied the existing server-authoritative game rules, then this bridge
calls the Supabase ``apply_game_play_points`` RPC with a service-role key held
only by the FastAPI deployment.

The bridge is off unless ``SUPABASE_GAME_SETTLEMENT_ENABLED=true``.  Keeping
the default off is important while Mongo remains the live game's source of
truth: enabling a second ledger before the route-level cutover/outbox is in
place would create two independently mutable balances.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import uuid
from dataclasses import dataclass, field
from typing import Any, Iterable, Mapping, Optional, Protocol
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen


# These are the fifteen Unity cabinets requested for the MyDGP launch.  A
# deployment must opt in to a subset explicitly; this static list prevents a
# typo or a newly-added FastAPI game from becoming settlement-enabled without
# a review of its server-side rules.
REVIEWED_GAME_SLUGS = frozenset({
    "seven-up-down",
    "andar-bahar",
    "triple-fun",
    "fun-roulette",
    "fun-target",
    "bingo",
    "joker-bonus",
    "giant-jackpot",
    "super-golden-wheel",
    "keno",
    "checker",
    "lucky-8-line",
    "fever-joker-bonus",
    "no-hold",
    "champion-poker",
})

ACTION_TO_KIND_AND_SIGN = {
    "STAKE": ("STAKE", -1),
    "PRIZE": ("PRIZE", 1),
    "REFUND": ("REFUND", 1),
}

MAX_SETTLEMENT_POINTS = 1_000_000_000
_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
_REFERENCE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9:_.-]{0,159}$")
_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")
_MAX_RESPONSE_BYTES = 32 * 1024


class SettlementConfigurationError(RuntimeError):
    """The bridge was enabled without a safe, complete server configuration."""


class SettlementTransportError(RuntimeError):
    """The trusted caller could not obtain a valid Supabase RPC response."""


@dataclass(frozen=True)
class GameSettlement:
    """One immutable, server-created ledger movement for a resolved game.

    ``action`` is intentionally a closed set rather than accepting a caller
    supplied signed delta.  The amount and its direction are therefore checked
    twice: here and again by the Supabase RPC.  ``round_id`` identifies the
    server round while ``event_id`` identifies one exact bet/settlement event;
    together they make retries deterministic without turning a retry into a
    second award.
    """

    player_profile_id: str
    game_slug: str
    round_id: str
    event_id: str
    action: str
    amount: int
    note: Optional[str] = None

    @classmethod
    def stake(
        cls,
        player_profile_id: str,
        game_slug: str,
        round_id: str,
        event_id: str,
        amount: int,
        note: Optional[str] = None,
    ) -> "GameSettlement":
        return cls(player_profile_id, game_slug, round_id, event_id, "STAKE", amount, note)

    @classmethod
    def prize(
        cls,
        player_profile_id: str,
        game_slug: str,
        round_id: str,
        event_id: str,
        amount: int,
        note: Optional[str] = None,
    ) -> "GameSettlement":
        return cls(player_profile_id, game_slug, round_id, event_id, "PRIZE", amount, note)

    @classmethod
    def refund(
        cls,
        player_profile_id: str,
        game_slug: str,
        round_id: str,
        event_id: str,
        amount: int,
        note: Optional[str] = None,
    ) -> "GameSettlement":
        return cls(player_profile_id, game_slug, round_id, event_id, "REFUND", amount, note)

    def validate(self, allowed_game_slugs: Iterable[str]) -> None:
        try:
            canonical_player_id = str(uuid.UUID(self.player_profile_id))
        except (AttributeError, ValueError, TypeError) as exc:
            raise ValueError("player_profile_id must be a UUID") from exc
        if canonical_player_id.lower() != self.player_profile_id.lower():
            raise ValueError("player_profile_id must be a canonical UUID")
        if self.game_slug not in set(allowed_game_slugs) or not _SLUG_RE.fullmatch(self.game_slug):
            raise ValueError("game_slug is not enabled for trusted settlement")
        if self.action not in ACTION_TO_KIND_AND_SIGN:
            raise ValueError("action is not a permitted game settlement action")
        if isinstance(self.amount, bool) or not isinstance(self.amount, int):
            raise ValueError("amount must be an integer")
        if not 1 <= self.amount <= MAX_SETTLEMENT_POINTS:
            raise ValueError("amount is outside the permitted game settlement range")
        for field_name, value in (("round_id", self.round_id), ("event_id", self.event_id)):
            if not isinstance(value, str) or not _REFERENCE_RE.fullmatch(value):
                raise ValueError(f"{field_name} is invalid")
        if self.note is not None:
            if not isinstance(self.note, str) or not self.note.strip() or len(self.note) > 500:
                raise ValueError("note is invalid")
            if _CONTROL_RE.search(self.note):
                raise ValueError("note contains a control character")
        if len(self.idempotency_key) > 512:
            raise ValueError("generated idempotency key is too long")

    @property
    def kind(self) -> str:
        return ACTION_TO_KIND_AND_SIGN[self.action][0]

    @property
    def delta(self) -> int:
        return ACTION_TO_KIND_AND_SIGN[self.action][1] * self.amount

    @property
    def idempotency_key(self) -> str:
        # This is generated entirely from server-side identifiers.  Do not
        # accept an arbitrary idempotency key from an APK: that would let a
        # client choose which operation a retry aliases.
        return f"game-v1:{self.game_slug}:{self.round_id}:{self.event_id}:{self.action.lower()}"

    def rpc_payload(self) -> dict[str, Any]:
        return {
            "p_player_id": self.player_profile_id,
            "p_delta": self.delta,
            "p_kind": self.kind,
            "p_idempotency_key": self.idempotency_key,
            "p_game_slug": self.game_slug,
            "p_round_id": self.round_id,
            "p_note": self.note,
        }


@dataclass(frozen=True)
class SettlementReceipt:
    ledger_id: str
    balance_after: int
    duplicate: bool


@dataclass(frozen=True)
class BridgeSettings:
    rpc_url: str
    allowed_game_slugs: frozenset[str]
    timeout_seconds: float
    service_role_key: str = field(repr=False)


@dataclass(frozen=True)
class HttpResult:
    status_code: int
    body: bytes


class JsonTransport(Protocol):
    def post_json(
        self,
        url: str,
        headers: Mapping[str, str],
        payload: Mapping[str, Any],
        timeout_seconds: float,
    ) -> HttpResult:
        ...


class UrllibJsonTransport:
    """Minimal standard-library transport so production has no new HTTP dependency."""

    def post_json(
        self,
        url: str,
        headers: Mapping[str, str],
        payload: Mapping[str, Any],
        timeout_seconds: float,
    ) -> HttpResult:
        encoded = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        request = Request(url, data=encoded, headers=dict(headers), method="POST")
        try:
            with urlopen(request, timeout=timeout_seconds) as response:  # noqa: S310 - URL is config-validated
                body = response.read(_MAX_RESPONSE_BYTES + 1)
                if len(body) > _MAX_RESPONSE_BYTES:
                    raise SettlementTransportError("Supabase settlement response was too large")
                return HttpResult(status_code=int(response.status), body=body)
        except HTTPError as exc:
            # Do not propagate the response body.  It can contain implementation
            # details and must never cause a service role token to be logged with
            # a retried request.
            try:
                exc.close()
            except OSError:
                pass
            return HttpResult(status_code=exc.code, body=b"")
        except (URLError, OSError, TimeoutError) as exc:
            raise SettlementTransportError("Supabase settlement transport failed") from exc


def bridge_enabled(environ: Optional[Mapping[str, str]] = None) -> bool:
    environment = os.environ if environ is None else environ
    return environment.get("SUPABASE_GAME_SETTLEMENT_ENABLED", "").strip().lower() == "true"


def _parse_supabase_url(value: str) -> str:
    raw = value.strip().rstrip("/")
    parsed = urlparse(raw)
    try:
        port = parsed.port
    except ValueError as exc:
        raise SettlementConfigurationError("SUPABASE_GAME_SETTLEMENT_URL has an invalid port") from exc
    # This is deliberately a direct Supabase project URL.  It avoids making a
    # misconfigured bridge into a server-side request proxy and ensures TLS is
    # mandatory for the service-role credential.
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or parsed.path not in ("", "/")
        or port not in (None, 443)
        or not parsed.hostname.lower().endswith(".supabase.co")
    ):
        raise SettlementConfigurationError("SUPABASE_GAME_SETTLEMENT_URL must be an https Supabase project URL")
    return raw + "/rest/v1/rpc/apply_game_play_points"


def load_bridge_settings(environ: Optional[Mapping[str, str]] = None) -> Optional[BridgeSettings]:
    """Load bridge secrets only after a deliberate feature-flag opt-in.

    Returning ``None`` while disabled lets callers keep the route physically
    present in a deployment without creating a second ledger or any outbound
    request.  An enabled-but-incomplete configuration raises rather than
    silently falling back to Mongo.
    """

    environment = os.environ if environ is None else environ
    if not bridge_enabled(environment):
        return None

    service_role_key = environment.get("SUPABASE_GAME_SETTLEMENT_SERVICE_ROLE_KEY", "").strip()
    if len(service_role_key) < 40:
        raise SettlementConfigurationError("Supabase settlement service role key is missing")
    rpc_url = _parse_supabase_url(environment.get("SUPABASE_GAME_SETTLEMENT_URL", ""))

    raw_slugs = environment.get("SUPABASE_GAME_SETTLEMENT_ALLOWED_SLUGS", "")
    allowed_slugs = frozenset(item.strip() for item in raw_slugs.split(",") if item.strip())
    if not allowed_slugs or not allowed_slugs <= REVIEWED_GAME_SLUGS:
        raise SettlementConfigurationError("Settlement game allowlist is missing or contains an unreviewed game")

    timeout_value = environment.get("SUPABASE_GAME_SETTLEMENT_TIMEOUT_SECONDS", "5").strip()
    try:
        timeout_seconds = float(timeout_value)
    except ValueError as exc:
        raise SettlementConfigurationError("Supabase settlement timeout is invalid") from exc
    if not 1.0 <= timeout_seconds <= 15.0:
        raise SettlementConfigurationError("Supabase settlement timeout must be between 1 and 15 seconds")

    return BridgeSettings(
        rpc_url=rpc_url,
        service_role_key=service_role_key,
        allowed_game_slugs=allowed_slugs,
        timeout_seconds=timeout_seconds,
    )


class SupabaseGameSettlementBridge:
    """Apply a validated, server-created game movement to Supabase exactly once."""

    def __init__(self, settings: BridgeSettings, transport: Optional[JsonTransport] = None):
        self._settings = settings
        self._transport = transport or UrllibJsonTransport()

    async def apply(self, settlement: GameSettlement) -> SettlementReceipt:
        settlement.validate(self._settings.allowed_game_slugs)
        headers = {
            "apikey": self._settings.service_role_key,
            "Authorization": f"Bearer {self._settings.service_role_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
        try:
            response = await asyncio.to_thread(
                self._transport.post_json,
                self._settings.rpc_url,
                headers,
                settlement.rpc_payload(),
                self._settings.timeout_seconds,
            )
        except SettlementTransportError:
            raise
        except Exception as exc:  # A custom transport must never leak credentials through its error text.
            raise SettlementTransportError("Supabase settlement transport failed") from exc

        if not 200 <= response.status_code < 300:
            raise SettlementTransportError(f"Supabase settlement RPC returned HTTP {response.status_code}")
        return _parse_receipt(response.body)


def _parse_receipt(body: bytes) -> SettlementReceipt:
    if not body or len(body) > _MAX_RESPONSE_BYTES:
        raise SettlementTransportError("Supabase settlement RPC returned an invalid response")
    try:
        decoded = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise SettlementTransportError("Supabase settlement RPC returned an invalid response") from exc
    if not isinstance(decoded, list) or len(decoded) != 1 or not isinstance(decoded[0], dict):
        raise SettlementTransportError("Supabase settlement RPC returned an invalid response")
    row = decoded[0]
    ledger_id = row.get("ledger_id")
    balance_after = row.get("balance_after")
    duplicate = row.get("duplicate")
    try:
        canonical_ledger_id = str(uuid.UUID(ledger_id))
    except (AttributeError, ValueError, TypeError) as exc:
        raise SettlementTransportError("Supabase settlement RPC returned an invalid response") from exc
    if isinstance(balance_after, bool) or not isinstance(balance_after, int) or balance_after < 0:
        raise SettlementTransportError("Supabase settlement RPC returned an invalid response")
    if not isinstance(duplicate, bool):
        raise SettlementTransportError("Supabase settlement RPC returned an invalid response")
    return SettlementReceipt(canonical_ledger_id, balance_after, duplicate)


async def apply_if_enabled(
    settlement: GameSettlement,
    *,
    environ: Optional[Mapping[str, str]] = None,
    transport: Optional[JsonTransport] = None,
) -> Optional[SettlementReceipt]:
    """Convenience seam for a future FastAPI resolver/outbox worker.

    It has no side effects when the feature flag is absent or false.  Existing
    live routes intentionally do not call it yet; their Mongo debit/credit
    sequence needs a reviewed, one-source-of-truth cutover before this is
    wired in.
    """

    settings = load_bridge_settings(environ)
    if settings is None:
        return None
    return await SupabaseGameSettlementBridge(settings, transport).apply(settlement)
