"""Focused, network-free checks for the disabled-by-default Supabase game bridge.

Run with ``python backend/test_trusted_game_settlement.py`` from a Python
environment containing the normal backend requirements and ``mongomock-motor``.
The test deliberately uses a fake HTTP transport: no Supabase project, service
key, game balance, or external route is contacted.
"""

import asyncio
import hashlib
import hmac
import json
import os
import sys
import time
import types

from fastapi import HTTPException
from mongomock_motor import AsyncMongoMockClient
from pydantic import ValidationError
from starlette.requests import Request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

client = AsyncMongoMockClient()
db = client["trusted_game_settlement_test"]
sys.modules["db"] = types.SimpleNamespace(db=db)

import routes_game_settlement as route
from live_engines import LIVE_GAMES
from trusted_game_settlement import (
    GameSettlement,
    HttpResult,
    REVIEWED_GAME_SLUGS,
    SettlementConfigurationError,
    SettlementReceipt,
    SupabaseGameSettlementBridge,
    apply_if_enabled,
    load_bridge_settings,
)


PASS = FAIL = 0
PLAYER_ID = "7f78c0b1-225b-4cab-9ee8-45a0d649c6d3"
LEDGER_ID = "b7ef03a3-61e2-41a3-8c82-907f70a2af09"
HMAC_SECRET = "game-settlement-fixture-secret-32-chars"


def check(name, condition):
    global PASS, FAIL
    print(("  PASS  " if condition else "  FAIL  ") + name)
    if condition:
        PASS += 1
    else:
        FAIL += 1


def enabled_environment(**overrides):
    values = {
        "SUPABASE_GAME_SETTLEMENT_ENABLED": "true",
        "SUPABASE_GAME_SETTLEMENT_URL": "https://otlhseyofakjiridxthb.supabase.co",
        "SUPABASE_GAME_SETTLEMENT_SERVICE_ROLE_KEY": "s" * 48,
        "SUPABASE_GAME_SETTLEMENT_ALLOWED_SLUGS": "seven-up-down,fun-roulette",
        "SUPABASE_GAME_SETTLEMENT_TIMEOUT_SECONDS": "3",
    }
    values.update(overrides)
    return values


class FakeTransport:
    def __init__(self, result=None):
        self.calls = []
        self.result = result or HttpResult(
            200,
            json.dumps([{
                "ledger_id": LEDGER_ID,
                "balance_after": 975,
                "duplicate": False,
            }]).encode("utf-8"),
        )

    def post_json(self, url, headers, payload, timeout_seconds):
        self.calls.append({
            "url": url,
            "headers": dict(headers),
            "payload": dict(payload),
            "timeout_seconds": timeout_seconds,
        })
        return self.result


def make_request(path, headers, body):
    async def receive():
        return {"type": "http.request", "body": body, "more_body": False}

    raw_headers = [(key.lower().encode("ascii"), value.encode("utf-8")) for key, value in headers.items()]
    raw_headers += [(b"host", b"test"), (b"content-type", b"application/json")]
    return Request({
        "type": "http",
        "method": "POST",
        "scheme": "https",
        "server": ("test", 443),
        "path": path,
        "raw_path": path.encode("utf-8"),
        "query_string": b"",
        "headers": raw_headers,
        "client": ("127.0.0.1", 12345),
    }, receive=receive)


def signed_headers(path, body, *, nonce="testing_nonce_value_1234"):
    timestamp = str(int(time.time()))
    digest = hashlib.sha256(body).hexdigest()
    payload = f"POST\n{path}\n{timestamp}\n{nonce}\n{digest}".encode("utf-8")
    signature = hmac.new(HMAC_SECRET.encode("utf-8"), payload, hashlib.sha256).hexdigest()
    return {
        "X-Game-Settlement-Timestamp": timestamp,
        "X-Game-Settlement-Nonce": nonce,
        "X-Game-Settlement-Signature": signature,
    }


async def http_status(coro):
    try:
        await coro
        return 200
    except HTTPException as exc:
        return exc.status_code


async def main():
    original_env = {key: os.environ.get(key) for key in (
        "SUPABASE_GAME_SETTLEMENT_ENABLED",
        "SUPABASE_GAME_SETTLEMENT_URL",
        "SUPABASE_GAME_SETTLEMENT_SERVICE_ROLE_KEY",
        "SUPABASE_GAME_SETTLEMENT_ALLOWED_SLUGS",
        "SUPABASE_GAME_SETTLEMENT_TIMEOUT_SECONDS",
        "GAME_SETTLEMENT_INTERNAL_HMAC_SECRET",
    )}
    original_bridge = route.SupabaseGameSettlementBridge
    try:
        for key in original_env:
            os.environ.pop(key, None)
        route._nonce_index_ready = False

        # No flag means no network call and no nonce index/collection mutation.
        disabled_transport = FakeTransport()
        disabled = await apply_if_enabled(
            GameSettlement.stake(PLAYER_ID, "seven-up-down", "live:seven-up-down:42", "bet:1", 25),
            transport=disabled_transport,
        )
        check("bridge has no side effect while disabled", disabled is None and not disabled_transport.calls)
        check("disabled internal route is hidden", await http_status(route.require_internal_authorization(
            make_request("/api/internal/game-settlements", {}, b"{}")
        )) == 404)
        check("disabled bridge startup creates no index", await route.ensure_indexes() is False)
        check("every non-roulette launch cabinet already has a FastAPI live-rule table",
              REVIEWED_GAME_SLUGS - {"fun-roulette"} <= set(LIVE_GAMES))

        # An enabled bridge must have direct TLS Supabase URL, a service-role
        # secret, and an explicit reviewed-game allowlist.
        malformed = enabled_environment(SUPABASE_GAME_SETTLEMENT_ALLOWED_SLUGS="aviator")
        failed_config = False
        try:
            load_bridge_settings(malformed)
        except SettlementConfigurationError:
            failed_config = True
        check("unreviewed games cannot be enabled by configuration", failed_config)

        invalid_url = False
        try:
            load_bridge_settings(enabled_environment(
                SUPABASE_GAME_SETTLEMENT_URL="http://otlhseyofakjiridxthb.supabase.co:8443"
            ))
        except SettlementConfigurationError:
            invalid_url = True
        check("bridge refuses non-TLS or nonstandard Supabase destinations", invalid_url)

        settings = load_bridge_settings(enabled_environment())
        transport = FakeTransport()
        settlement = GameSettlement.stake(
            PLAYER_ID, "seven-up-down", "live:seven-up-down:42", "bet:31", 25, "Server accepted bet"
        )
        receipt = await SupabaseGameSettlementBridge(settings, transport).apply(settlement)
        call = transport.calls[0]
        check("bridge calls only the fixed Supabase game RPC",
              call["url"].endswith("/rest/v1/rpc/apply_game_play_points"))
        check("stake direction is server-derived and negative",
              call["payload"]["p_kind"] == "STAKE" and call["payload"]["p_delta"] == -25)
        check("idempotency key is built from trusted game identifiers",
              call["payload"]["p_idempotency_key"] == "game-v1:seven-up-down:live:seven-up-down:42:bet:31:stake")
        check("adapter parses a strict receipt", receipt.ledger_id == LEDGER_ID and receipt.balance_after == 975 and not receipt.duplicate)
        check("service key remains an outbound header, not a returned value",
              "s" * 48 == call["headers"]["apikey"] and "service_role_key" not in receipt.__dict__)

        bad_slug = False
        try:
            await SupabaseGameSettlementBridge(settings, transport).apply(
                GameSettlement.prize(PLAYER_ID, "aviator", "live:aviator:1", "bet:2", 50)
            )
        except ValueError:
            bad_slug = True
        check("adapter rejects a non-allowlisted game before transport", bad_slug and len(transport.calls) == 1)

        bad_uuid = False
        try:
            GameSettlement.prize("not-a-profile", "seven-up-down", "live:seven-up-down:42", "bet:32", 25).validate(
                settings.allowed_game_slugs
            )
        except ValueError:
            bad_uuid = True
        check("adapter rejects non-Supabase player identifiers", bad_uuid)

        arbitrary_delta_rejected = False
        try:
            route.SettlementActionRequest(
                player_profile_id=PLAYER_ID,
                game_slug="seven-up-down",
                round_id="live:seven-up-down:42",
                event_id="bet:32",
                action="PRIZE",
                amount=25,
                delta=999999,
            )
        except ValidationError:
            arbitrary_delta_rejected = True
        check("private route refuses a caller-supplied balance delta", arbitrary_delta_rejected)

        # The private resolver route is HMAC-only, rejects replay, and has no
        # way to send an arbitrary signed delta.
        for key, value in enabled_environment().items():
            os.environ[key] = value
        os.environ["GAME_SETTLEMENT_INTERNAL_HMAC_SECRET"] = HMAC_SECRET
        route._nonce_index_ready = False
        captured = []

        class FakeBridge:
            def __init__(self, received_settings):
                self.settings = received_settings

            async def apply(self, command):
                captured.append(command)
                return SettlementReceipt(LEDGER_ID, 1_025, False)

        route.SupabaseGameSettlementBridge = FakeBridge
        payload = json.dumps({
            "player_profile_id": PLAYER_ID,
            "game_slug": "seven-up-down",
            "round_id": "live:seven-up-down:42",
            "event_id": "bet:33",
            "action": "PRIZE",
            "amount": 50,
            "note": "Server resolved winning bet",
        }, separators=(",", ":")).encode("utf-8")
        path = "/api/internal/game-settlements"
        headers = signed_headers(path, payload)
        request = make_request(path, headers, payload)
        signed_settings = await route.require_internal_authorization(request)
        response = await route.apply_game_settlement(route.SettlementActionRequest(**json.loads(payload)), signed_settings)
        response_body = json.loads(response.body)
        check("internal resolver contract converts PRIZE to a positive movement",
              captured and captured[0].kind == "PRIZE" and captured[0].delta == 50)
        check("internal response is no-store and returns only a receipt",
              response.headers["cache-control"].startswith("no-store") and response_body == {
                  "ledger_id": LEDGER_ID, "balance_after": 1025, "duplicate": False
              })
        replay = await http_status(route.require_internal_authorization(
            make_request(path, headers, payload)
        ))
        check("one HMAC nonce cannot replay a point movement", replay == 401)

        bad_headers = dict(headers)
        bad_headers["X-Game-Settlement-Signature"] = "0" * 64
        check("bad HMAC is rejected before any resolver call", await http_status(route.require_internal_authorization(
            make_request(path, bad_headers, payload)
        )) == 401 and len(captured) == 1)
    finally:
        route.SupabaseGameSettlementBridge = original_bridge
        route._nonce_index_ready = False
        for key, value in original_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    print(f"\n  {PASS} passed, {FAIL} failed")
    return FAIL


sys.exit(asyncio.run(main()))
