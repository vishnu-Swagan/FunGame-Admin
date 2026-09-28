"""Isolated route/ledger contracts for approved, default-paused Chicken Road.

SnapshotTransactionRunner is an explicit test double: a process-local lock and
collection snapshots model serialization/rollback. It does not prove MongoDB
replica-set transactions, write-conflict handling, or deployment readiness.
No live database, server startup, or external network service is used here.
"""
from __future__ import annotations

import ast
import asyncio
import copy
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import json
import os
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import AsyncMock, patch

from fastapi import APIRouter, FastAPI, HTTPException
from httpx import ASGITransport, AsyncClient
from mongomock_motor import AsyncMongoMockClient
from pydantic import ValidationError
from pymongo.errors import DuplicateKeyError, OperationFailure
from starlette.routing import Match


# Install an isolated db module before importing any financial dependencies;
# restore the process's original module entry immediately after those imports.
_IMPORT_CLIENT = AsyncMongoMockClient()
_ORIGINAL_DB_MODULE = sys.modules.get("db")
sys.modules["db"] = types.SimpleNamespace(
    db=_IMPORT_CLIENT["chicken_road_import_only"], client=_IMPORT_CLIENT,
    serialize_doc=lambda value: value,
)
try:
    import auth_utils
    import bonus_policy
    import chicken_road_engine as engine
    import compliance
    import financial_wallet as finance
    import game_access
    import game_wallet
    import ledger
    import routes_chicken_road as route
    import transactions
finally:
    if _ORIGINAL_DB_MODULE is None:
        sys.modules.pop("db", None)
    else:
        sys.modules["db"] = _ORIGINAL_DB_MODULE

_REAL_REQUIRE_WALLET_USER = route._require_wallet_user
_REAL_TRANSACTION_RUNNER = transactions.run_game_transaction
_REAL_LANE_SURVIVES = engine.lane_survives
_INITIAL_RULES_APPROVED = route.RULES_APPROVED
_LEGACY_RULES_VERSION = "chicken-road-proposal-v1"
_CURRENT_RULES_VERSION = "chicken-road-proposal-v2"
_LEGACY_MEDIUM_LADDER = [112, 128, 147, 170, 198, 233, 276, 332, 403, 496, 620, 691, 890]
_LEGACY_SERVER_SEED = "0" * 62 + "2e"


def _independent_legacy_draw(proof, lane):
    """Reproduce the archived wire protocol without calling engine helpers."""
    upper_bound = _LEGACY_MEDIUM_LADDER[lane - 1]
    uint256_range = 1 << 256
    limit = uint256_range - uint256_range % upper_bound
    counter = 0
    while True:
        message = json.dumps([
            "chicken-road:lane", _LEGACY_RULES_VERSION, "chicken-road-hmac-v1",
            "medium", lane, proof["nonce"], counter, proof["client_seed"],
        ], ensure_ascii=True, separators=(",", ":")).encode("utf-8")
        sample = int.from_bytes(hmac.new(bytes.fromhex(proof["server_seed"]), message, hashlib.sha256).digest(), "big")
        if sample < limit:
            return sample % upper_bound
        counter += 1


class _SessionCollection:
    """Retain session evidence while removing unsupported mongomock sessions."""

    def __init__(self, database, name):
        self.database = database
        self.name = name

    def __getattr__(self, method):
        target = getattr(self.database.raw[self.name], method)
        if not callable(target):
            return target

        def invoke(*args, **kwargs):
            session = kwargs.pop("session", None)
            self.database.calls.append((self.name, method, session))
            failure = self.database.failure
            if failure and failure[:2] == (self.name, method):
                self.database.failure = None
                raise failure[2]
            return target(*args, **kwargs)

        return invoke


class _SessionDatabase:
    def __init__(self, raw):
        self.raw = raw
        self.collections = {}
        self.calls = []
        self.failure = None

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        return self.collections.setdefault(name, _SessionCollection(self, name))

    def fail_once(self, collection, method, error=None):
        self.failure = (collection, method, error or RuntimeError(f"injected {collection}.{method}"))

    async def snapshot(self):
        snapshot = {}
        for name in await self.raw.list_collection_names():
            rows = await self.raw[name].find({}).to_list(None)
            if rows:
                snapshot[name] = copy.deepcopy(rows)
        return snapshot

    async def restore(self, snapshot):
        names = set(await self.raw.list_collection_names()) | set(snapshot)
        for name in names:
            await self.raw[name].delete_many({})
            if snapshot.get(name):
                await self.raw[name].insert_many(copy.deepcopy(snapshot[name]))


class SnapshotTransactionRunner:
    """Serial callback execution and rollback, not a real Mongo transaction."""

    def __init__(self, database):
        self.database = database
        self.lock = asyncio.Lock()
        self.sessions = []
        self.callback_retries = 0

    async def __call__(self, client, callback):
        async with self.lock:
            snapshot = await self.database.snapshot()
            session = object()
            self.sessions.append(session)
            try:
                result = await callback(session)
                if self.callback_retries:
                    self.callback_retries -= 1
                    await self.database.restore(snapshot)
                    result = await callback(session)
                return result
            except BaseException:
                await self.database.restore(snapshot)
                raise


class ChickenRoadRouteTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.client = AsyncMongoMockClient()
        self.db = _SessionDatabase(self.client["chicken_road_route_test"])
        self.runner = SnapshotTransactionRunner(self.db)
        self.clock = datetime(2026, 9, 23, 12, tzinfo=timezone.utc)
        self.serial = 0
        self.hook_sessions = []
        self.user = {
            "id": "player-1", "role": "PLAYER", "status": "ACTIVE",
            "active_session_id": "session-1", "chip_balance": 100000,
            "accepted_terms": True, "age_verified": True, "kyc_status": "VERIFIED",
            "country": "IN", "financial_status": "ACTIVE", "deleted_at": None,
        }
        # These patchers restore global module references and hooks even after
        # a failed setup/test, so neighboring suites retain their own fixtures.
        for module in (route, ledger, auth_utils, compliance, finance, game_wallet, bonus_policy, game_access):
            self._patch(patch.object(module, "db", self.db))
        self._patch(patch.object(route, "client", self.client))
        self._patch(patch.object(route, "run_game_transaction", self.runner))
        self._patch(patch.object(route, "RULES_APPROVED", True))
        self._patch(patch.object(route, "_STORAGE_READY", False))
        self._patch(patch.object(route, "_now", side_effect=lambda: self.clock))
        self.playable = self._patch(patch.object(route, "require_playable_game", new_callable=AsyncMock))
        self.wallet_ready = self._patch(patch.object(route, "_require_wallet_user", new_callable=AsyncMock))
        self.survival = self._patch(patch.object(engine, "lane_survives", return_value=True))
        self._patch(patch.object(ledger, "_source_wallet_adapter", None))
        self._patch(patch.object(ledger, "_stake_guards", [compliance._stake_guard]))
        self._patch(patch.object(ledger, "_ledger_observers", [self._observe]))
        self._patch(patch.dict(os.environ, {
            "APP_ENV": "test", "CHICKEN_ROAD_LIVE_ENABLED": "true",
            "CHICKEN_ROAD_EXPOSURE_LIMIT": "2000000", "REAL_MONEY_ENABLED": "true",
            "FINANCIAL_ALLOWED_COUNTRIES": "IN", "FINANCIAL_GAME_WALLET_INTEGRATED": "true",
            "FINANCIAL_ALLOW_NON_TRANSACTIONAL_TESTS": "false",
            "JWT_SECRET": "chicken-road-isolated-tests-secret-never-use-in-production",
        }))
        await self.db.users.insert_one(copy.deepcopy(self.user))
        await self.db.chip_transactions.create_index("id", unique=True)
        await route.prepare_chicken_road_storage()

    def _patch(self, patcher):
        value = patcher.start()
        self.addCleanup(patcher.stop)
        return value

    def key(self, prefix="operation"):
        self.serial += 1
        return f"{prefix}-{self.serial:04d}"

    async def _observe(self, event, session=None):
        self.assertIsNotNone(session)
        self.hook_sessions.append(session)
        await self.db.test_observed_events.insert_one({"_id": event["id"], "event": copy.deepcopy(event)}, session=session)

    async def prepare(self, user=None, key=None):
        return await route.prepare_round(route.OperationRequest(operation_id=key or self.key("prepare")), user or self.user)

    async def play_body(self, *, user=None, difficulty="medium", amount=300, commitment=None, key=None):
        commitment = commitment or await self.prepare(user)
        return route.PlayRequest(
            operation_id=key or self.key("play"), commitment_id=commitment["commitment_id"],
            client_seed="f" * 64, difficulty=difficulty, amount=amount, rules_version=engine.RULES_VERSION,
        )

    async def start(self, **kwargs):
        user = kwargs.get("user") or self.user
        body = await self.play_body(**kwargs)
        return body, await route.play(body, user)

    async def start_legacy_fixture(self):
        # Accept the round through the real v1 prepare/play path before the
        # process switches to v2. The fixture has v1 draws 42, 28, 130: two
        # survivors then a collision. V2 lane 2 would instead collide (121).
        self.survival.side_effect = _REAL_LANE_SURVIVES
        identities = iter(("legacy-commitment", "legacy-round"))
        prepare_key = self.key("legacy-prepare")
        with patch.object(engine, "RULES_VERSION", _LEGACY_RULES_VERSION), \
                patch.object(route, "uuid", types.SimpleNamespace(uuid4=lambda: next(identities))), \
                patch.object(route.secrets, "token_hex", return_value=_LEGACY_SERVER_SEED):
            prepared = await self.prepare(key=prepare_key)
            body, played = await self.start(commitment=prepared)
        self.assertEqual(played["round"]["status"], "PLAYING")
        self.assertEqual(played["round"]["rules_version"], _LEGACY_RULES_VERSION)
        return prepare_key, prepared, body, played

    def action_body(self, response, *, key=None, version=None):
        current = response["round"]
        return route.RoundRequest(operation_id=key or self.key("action"), round_id=current["id"],
                                  expected_version=current["version"] if version is None else version)

    async def assert_error(self, awaitable, code, status=409):
        with self.assertRaises(HTTPException) as caught:
            await awaitable
        self.assertEqual(caught.exception.status_code, status)
        self.assertEqual(caught.exception.detail["code"], code)
        return caught.exception

    async def balance(self, user=None):
        return (await self.db.users.find_one({"id": (user or self.user)["id"]}))["chip_balance"]

    async def events(self, kind=None, user=None):
        query = {"user_id": (user or self.user)["id"]}
        if kind:
            query["kind"] = kind
        return await self.db.chip_transactions.find(query).to_list(None)

    async def exposure(self):
        return (await self.db.chicken_road_exposure.find_one({"_id": route.SLUG}))["outstanding_chips"]

    async def assert_terminal_once(self, response, *, user=None):
        user = user or self.user
        current = response["round"]
        query = {"user_id": user["id"], "ref": current["id"]}
        self.assertEqual(await self.db.chip_transactions.count_documents({**query, "kind": ledger.STAKE}), 1)
        self.assertEqual(await self.db.chip_transactions.count_documents({**query, "kind": ledger.SETTLEMENT}), 1)
        self.assertEqual(await self.db.chip_transactions.count_documents({**query, "kind": ledger.PAYOUT}), int(current["payout"] > 0))
        self.assertEqual(await self.db.game_rounds.count_documents({"id": current["id"]}), 1)
        marker = await self.db.chip_transactions.find_one({**query, "kind": ledger.SETTLEMENT})
        stake = await self.db.chip_transactions.find_one({**query, "kind": ledger.STAKE})
        self.assertEqual(marker["source_transaction_id"], stake["id"])
        self.assertEqual(marker["source_refs"], [current["id"]])
        self.assertEqual(marker["settlement_ref"], current["id"])
        self.assertEqual(marker["settlement_status"], "SETTLED")
        self.assertEqual(await self.db.test_observed_events.count_documents({"event.ref": current["id"]}), 2 + int(current["payout"] > 0))
        guard = await self.db.chicken_road_players.find_one({"_id": user["id"]})
        self.assertIsNone(guard["active_round_id"])
        self.assertEqual(guard["latest_round_id"], current["id"])

    async def test_full_lifecycle_every_difficulty_uses_real_ledger_and_safe_first_hop(self):
        for difficulty, ladder in engine.LADDER_HUNDREDTHS.items():
            with self.subTest(difficulty=difficulty):
                before = await self.balance()
                body, played = await self.start(difficulty=difficulty)
                current = played["round"]
                self.assertEqual((played["result"], current["lane"], current["version"]), ("hopped", 1, 1))
                self.assertEqual(current["status"], "PLAYING")
                self.assertEqual(current["cashout_amount"], 3 * ladder[0])
                self.assertEqual(played["balance"], before - 300)
                self.assertEqual(await self.exposure(), 3 * ladder[-1])
                self.assertEqual(self.survival.call_args.args[-2:], (difficulty, 1))
                self.assertEqual(self.survival.call_args.kwargs, {"rules_version": engine.RULES_VERSION})
                stepped = await route.go(self.action_body(played), self.user)
                self.assertEqual((stepped["round"]["lane"], stepped["round"]["version"]), (2, 2))
                cashed = await route.cashout(self.action_body(stepped), self.user)
                self.assertEqual(cashed["round"]["payout"], 3 * ladder[1])
                self.assertEqual(await self.balance(), before - body.amount + 3 * ladder[1])
                await self.assert_terminal_once(cashed)
                self.assertEqual(await self.exposure(), 0)
        self.assertTrue(self.hook_sessions)
        self.assertTrue(all(session in self.runner.sessions for session in self.hook_sessions))

    async def test_lane_thirteen_auto_cashout_each_difficulty(self):
        for difficulty, ladder in engine.LADDER_HUNDREDTHS.items():
            _, current = await self.start(difficulty=difficulty, amount=1000)
            for lane in range(2, 14):
                current = await route.go(self.action_body(current), self.user)
                self.assertEqual(current["round"]["lane"], lane)
            self.assertEqual(current["round"]["status"], "CASHED")
            self.assertEqual(current["round"]["version"], 13)
            self.assertEqual(current["round"]["reason"], "FINAL_LANE")
            self.assertEqual(current["round"]["payout"], 10 * ladder[-1])
            self.assertIsNone(current["round"]["expires_at"])
            await self.assert_terminal_once(current)
            await self.assert_error(route.cashout(self.action_body(current), self.user), "ROUND_FINISHED")

    async def test_first_lane_collision_retries_never_start_or_debit_another_round(self):
        self.survival.return_value = False
        body, crashed = await self.start()
        self.assertEqual((crashed["result"], crashed["round"]["lane"], crashed["round"]["payout"]), ("crashed", 1, 0))
        self.assertEqual(await self.balance(), 99700)
        self.assertEqual(await self.exposure(), 0)
        self.assertEqual(await route.play(body, self.user), crashed)
        self.assertEqual(await self.db.chicken_road_rounds.count_documents({}), 1)
        self.assertEqual(self.survival.call_count, 1)
        await self.assert_terminal_once(crashed)

    async def test_later_collision_has_one_stake_and_one_nonmonetary_settlement(self):
        _, played = await self.start()
        self.survival.return_value = False
        request = self.action_body(played)
        crashed = await route.go(request, self.user)
        self.assertEqual((crashed["round"]["status"], crashed["round"]["lane"], crashed["round"]["multiplier_hundredths"]), ("CRASHED", 2, 0))
        self.assertEqual(await route.go(request, self.user), crashed)
        self.assertEqual(await self.balance(), 99700)
        await self.assert_terminal_once(crashed)

    async def test_prepare_play_go_and_cashout_identical_keys_return_exact_receipts(self):
        prepare_key = self.key("prepare")
        commitment = await self.prepare(key=prepare_key)
        self.assertEqual(await self.prepare(key=prepare_key), commitment)
        body, played = await self.start(commitment=commitment)
        self.assertEqual(await route.play(body, self.user), played)
        go_body = self.action_body(played)
        stepped = await route.go(go_body, self.user)
        self.assertEqual(await route.go(go_body, self.user), stepped)
        cash_body = self.action_body(stepped)
        cashed = await route.cashout(cash_body, self.user)
        snapshot = await self.db.snapshot()
        self.assertEqual(await route.cashout(cash_body, self.user), cashed)
        self.assertEqual(await route.play(body, self.user), played)
        self.assertEqual(await route.go(go_body, self.user), stepped)
        self.assertEqual(await self.db.snapshot(), snapshot)
        self.assertEqual(await self.db.chicken_road_operations.count_documents({}), 4)
        self.assertEqual(await self.db.chicken_road_commitments.count_documents({}), 1)
        await self.assert_terminal_once(cashed)

    async def test_changed_request_or_action_cannot_reuse_an_operation_key(self):
        body, played = await self.start()
        for change in ({"amount": 400}, {"difficulty": "easy"}, {"client_seed": "e" * 64}):
            await self.assert_error(route.play(body.model_copy(update=change), self.user), "IDEMPOTENCY_CONFLICT")
        go_body = self.action_body(played)
        stepped = await route.go(go_body, self.user)
        await self.assert_error(route.go(go_body.model_copy(update={"expected_version": 2}), self.user), "IDEMPOTENCY_CONFLICT")
        await self.assert_error(route.cashout(go_body, self.user), "IDEMPOTENCY_CONFLICT")
        self.assertEqual((await route.state(self.user))["active_round"]["version"], stepped["round"]["version"])
        self.assertEqual(len(await self.events(ledger.STAKE)), 1)

    async def test_lost_response_receipt_lookup_is_read_only_and_user_scoped(self):
        body, played = await self.start()
        before = await self.db.snapshot()
        receipt = await route.operation_receipt(body.operation_id, self.user)
        self.assertEqual(receipt, {"found": True, **played})
        self.assertEqual(await route.operation_receipt("never-sent", self.user), {"found": False, "operation_id": "never-sent"})
        other = {**self.user, "id": "player-2", "active_session_id": "session-2"}
        await self.db.users.insert_one(copy.deepcopy(other))
        self.assertFalse((await route.operation_receipt(body.operation_id, other))["found"])
        after = await self.db.snapshot()
        after["users"] = [row for row in after["users"] if row["id"] != "player-2"]
        self.assertEqual(after, before)

    async def test_insufficient_funds_persists_rejection_and_same_key_cannot_turn_into_a_stake(self):
        await self.db.users.update_one({"id": self.user["id"]}, {"$set": {"chip_balance": 200}})
        body = await self.play_body(amount=300)
        await self.assert_error(route.play(body, self.user), "INSUFFICIENT_CHIPS")
        rejected = await route.operation_receipt(body.operation_id, self.user)
        self.assertTrue(rejected["found"])
        self.assertEqual(rejected["status"], "REJECTED")
        self.assertEqual(rejected["error"]["code"], "INSUFFICIENT_CHIPS")
        await self.db.users.update_one({"id": self.user["id"]}, {"$set": {"chip_balance": 1000}})
        await self.assert_error(route.play(body, self.user), "INSUFFICIENT_CHIPS")
        self.assertEqual(await self.balance(), 1000)
        self.assertEqual(await self.events(), [])
        self.assertEqual(await self.exposure(), 0)
        self.assertEqual(await self.db.chicken_road_rounds.count_documents({}), 0)
        self.assertEqual((await self.db.chicken_road_commitments.find_one({"_id": body.commitment_id}))["status"], "PREPARED")

    async def test_stale_version_and_wrong_owner_do_not_cross_or_cash_out(self):
        _, played = await self.start()
        stepped = await route.go(self.action_body(played), self.user)
        await self.assert_error(route.go(self.action_body(played), self.user), "ROUND_VERSION_CONFLICT")
        await self.assert_error(route.cashout(self.action_body(played), self.user), "ROUND_VERSION_CONFLICT")
        other = {**self.user, "id": "player-2"}
        await self.db.users.insert_one(copy.deepcopy(other))
        await self.assert_error(route.go(self.action_body(stepped), other), "ROUND_NOT_FOUND", 404)
        self.assertEqual(self.survival.call_count, 2)
        self.assertEqual(await self.balance(), 99700)

    async def test_concurrent_go_at_same_version_accepts_only_one_lane(self):
        _, played = await self.start()
        results = await asyncio.gather(
            route.go(self.action_body(played), self.user), route.go(self.action_body(played), self.user),
            return_exceptions=True,
        )
        self.assertEqual(sum(isinstance(result, dict) for result in results), 1)
        rejected = next(result for result in results if isinstance(result, HTTPException))
        self.assertEqual(rejected.detail["code"], "ROUND_VERSION_CONFLICT")
        self.assertEqual((await route.state(self.user))["active_round"]["lane"], 2)
        self.assertEqual(self.survival.call_count, 2)
        self.assertEqual(len(await self.events(ledger.STAKE)), 1)

    async def test_go_vs_cashout_same_version_has_one_winner_in_both_orders(self):
        for cash_first in (False, True):
            _, played = await self.start()
            go_action = route.go(self.action_body(played), self.user)
            cash_action = route.cashout(self.action_body(played), self.user)
            actions = (cash_action, go_action) if cash_first else (go_action, cash_action)
            results = await asyncio.gather(*actions, return_exceptions=True)
            accepted = [result for result in results if isinstance(result, dict)]
            self.assertEqual(len(accepted), 1)
            self.assertEqual(sum(isinstance(result, HTTPException) for result in results), 1)
            result = accepted[0]
            if result["round"]["status"] == "PLAYING":
                result = await route.cashout(self.action_body(result), self.user)
            await self.assert_terminal_once(result)

    async def test_collision_vs_cashout_cannot_pay_an_uncommitted_losing_lane(self):
        for cash_first in (False, True):
            self.survival.return_value = True
            _, played = await self.start()
            self.survival.return_value = False
            go_action = route.go(self.action_body(played), self.user)
            cash_action = route.cashout(self.action_body(played), self.user)
            actions = (cash_action, go_action) if cash_first else (go_action, cash_action)
            results = await asyncio.gather(*actions, return_exceptions=True)
            accepted = [result for result in results if isinstance(result, dict)]
            self.assertEqual(len(accepted), 1)
            current = accepted[0]
            self.assertEqual(current["round"]["status"], "CASHED" if cash_first else "CRASHED")
            self.assertEqual(current["round"]["payout"], 336 if cash_first else 0)
            await self.assert_terminal_once(current)

    async def test_simultaneous_distinct_plays_only_create_one_active_round(self):
        first, second = await self.play_body(), await self.play_body()
        results = await asyncio.gather(route.play(first, self.user), route.play(second, self.user), return_exceptions=True)
        self.assertEqual(sum(isinstance(result, dict) for result in results), 1)
        rejected = next(result for result in results if isinstance(result, HTTPException))
        self.assertEqual(rejected.detail["code"], "ROUND_ACTIVE")
        self.assertEqual(await self.db.chicken_road_rounds.count_documents({}), 1)
        self.assertEqual(len(await self.events(ledger.STAKE)), 1)
        self.assertEqual(await self.balance(), 99700)
        self.assertEqual(await self.exposure(), 2670)

    async def test_simultaneous_identical_play_returns_one_durable_result(self):
        body = await self.play_body()
        first, second = await asyncio.gather(route.play(body, self.user), route.play(body, self.user))
        self.assertEqual(first, second)
        self.assertEqual(len(await self.events(ledger.STAKE)), 1)
        self.assertEqual(self.survival.call_count, 1)

    async def test_play_write_failures_roll_back_stake_round_commitment_exposure_and_observers(self):
        for collection in ("chip_transactions", "chicken_road_rounds", "chicken_road_operations", "test_observed_events"):
            body = await self.play_body()
            snapshot = await self.db.snapshot()
            self.db.fail_once(collection, "insert_one")
            with self.assertRaisesRegex(RuntimeError, "injected"):
                await route.play(body, self.user)
            self.assertEqual(await self.db.snapshot(), snapshot)
            played = await route.play(body, self.user)
            self.assertEqual(await route.play(body, self.user), played)
            await route.cashout(self.action_body(played), self.user)

    async def test_settlement_write_failures_roll_back_payout_history_receipt_and_exposure(self):
        failures = (("chip_transactions", "insert_one"), ("chip_transactions", "update_one"),
                    ("game_rounds", "insert_one"), ("chicken_road_operations", "insert_one"),
                    ("test_observed_events", "insert_one"))
        for collection, method in failures:
            _, played = await self.start()
            body = self.action_body(played)
            snapshot = await self.db.snapshot()
            self.db.fail_once(collection, method)
            with self.assertRaisesRegex(RuntimeError, "injected"):
                await route.cashout(body, self.user)
            self.assertEqual(await self.db.snapshot(), snapshot)
            cashed = await route.cashout(body, self.user)
            self.assertEqual(await route.cashout(body, self.user), cashed)
            await self.assert_terminal_once(cashed)

    async def test_driver_callback_retry_aborts_first_copy_and_records_one_stake(self):
        body = await self.play_body()
        self.runner.callback_retries = 1
        played = await route.play(body, self.user)
        self.assertEqual(await self.balance(), 99700)
        self.assertEqual(len(await self.events(ledger.STAKE)), 1)
        self.assertEqual(await self.db.chicken_road_rounds.count_documents({}), 1)
        self.assertEqual(await route.play(body, self.user), played)

    async def test_duplicate_key_retries_entire_transaction_and_has_bounded_failure(self):
        body = await self.play_body()
        self.db.fail_once("chicken_road_rounds", "insert_one", DuplicateKeyError("injected unique race"))
        played = await route.play(body, self.user)
        self.assertEqual(len(await self.events(ledger.STAKE)), 1)
        self.assertEqual(await self.balance(), 99700)
        await route.cashout(self.action_body(played), self.user)
        runner = AsyncMock(side_effect=DuplicateKeyError("persistent race"))
        with patch.object(route, "run_game_transaction", runner):
            await self.assert_error(route._transaction(AsyncMock()), "CHICKEN_ROAD_CONFLICT")
        self.assertEqual(runner.await_count, 3)

    async def test_exposure_cap_is_reserved_before_debit_and_released_on_settlement(self):
        body = await self.play_body(difficulty="hardcore", amount=1000)
        with patch.dict(os.environ, {"CHICKEN_ROAD_EXPOSURE_LIMIT": "194619"}):
            await self.assert_error(route.play(body, self.user), "EXPOSURE_LIMIT")
        self.assertEqual(await self.events(), [])
        self.assertEqual(await self.exposure(), 0)
        with patch.dict(os.environ, {"CHICKEN_ROAD_EXPOSURE_LIMIT": "194620"}):
            body = body.model_copy(update={"operation_id": self.key("retry-new")})
            played = await route.play(body, self.user)
            self.assertEqual(await self.exposure(), 194620)
            await route.cashout(self.action_body(played), self.user)
        self.assertEqual(await self.exposure(), 0)

    async def test_concurrent_users_cannot_oversubscribe_shared_exposure(self):
        other = {**self.user, "id": "player-2", "active_session_id": "session-2"}
        await self.db.users.insert_one(copy.deepcopy(other))
        first = await self.play_body(difficulty="hardcore", amount=1000)
        second = await self.play_body(user=other, difficulty="hardcore", amount=1000)
        with patch.dict(os.environ, {"CHICKEN_ROAD_EXPOSURE_LIMIT": "194620"}):
            results = await asyncio.gather(route.play(first, self.user), route.play(second, other), return_exceptions=True)
        self.assertEqual(sum(isinstance(result, dict) for result in results), 1)
        self.assertEqual(next(result for result in results if isinstance(result, HTTPException)).detail["code"], "EXPOSURE_LIMIT")
        self.assertEqual(await self.exposure(), 194620)
        self.assertEqual(await self.db.chip_transactions.count_documents({"kind": ledger.STAKE}), 1)
        self.assertEqual((await self.balance()) + (await self.balance(other)), 199000)

    async def test_commitment_expiry_reuse_owner_and_rules_are_validated_before_staking(self):
        old = await self.prepare()
        old_body = await self.play_body(commitment=old)
        self.clock += timedelta(seconds=route.COMMITMENT_SECONDS)
        await self.assert_error(route.play(old_body, self.user), "COMMITMENT_EXPIRED")
        fresh = await self.prepare()
        foreign = {**self.user, "id": "player-2"}
        await self.db.users.insert_one(copy.deepcopy(foreign))
        await self.assert_error(route.play(await self.play_body(user=foreign, commitment=fresh), foreign), "COMMITMENT_UNKNOWN")
        changed = await self.play_body(commitment=fresh)
        await self.assert_error(route.play(changed.model_copy(update={"rules_version": "old-rules"}), self.user), "RULES_CHANGED")
        await self.db.chicken_road_commitments.update_one({"_id": fresh["commitment_id"]}, {"$set": {"rules_version": "old-rules"}})
        await self.assert_error(route.play(changed.model_copy(update={"operation_id": self.key("prepared-rules")}), self.user), "RULES_CHANGED")
        self.assertEqual(await self.events(), [])
        body, played = await self.start()
        await route.cashout(self.action_body(played), self.user)
        await self.assert_error(route.play(body.model_copy(update={"operation_id": self.key("reused")}), self.user), "COMMITMENT_USED")
        self.assertEqual(len(await self.events(ledger.STAKE)), 1)

    async def test_private_seed_is_hidden_until_terminal_fairness_and_proof_verifies(self):
        prepared = await self.prepare()
        body, played = await self.start(commitment=prepared)
        for response in (prepared, played, await route.state(self.user), await route.operation_receipt(body.operation_id, self.user)):
            self.assertNotIn('"server_seed":', json.dumps(response))
        await self.assert_error(route.fairness(played["round"]["id"], self.user), "FAIRNESS_NOT_REVEALED")
        cashed = await route.cashout(self.action_body(played), self.user)
        proof = await route.fairness(played["round"]["id"], self.user)
        self.assertEqual(engine.seed_commitment(proof["server_seed"], prepared["commitment_id"]), proof["server_seed_hash"])
        self.assertEqual(proof["nonce"], prepared["commitment_id"])
        self.assertEqual(proof["client_seed"], body.client_seed)
        self.assertEqual(proof["fairness_version"], engine.FAIRNESS_VERSION)
        self.assertNotIn("server_seed", cashed["round"])
        other = {**self.user, "id": "player-2"}
        await self.db.users.insert_one(copy.deepcopy(other))
        await self.assert_error(route.fairness(played["round"]["id"], other), "ROUND_NOT_FOUND", 404)

    async def test_fairness_version_change_after_prepare_rejects_before_debit(self):
        commitment = await self.prepare()
        stored = await self.db.chicken_road_commitments.find_one({"_id": commitment["commitment_id"]})
        self.assertEqual(stored["fairness_version"], engine.FAIRNESS_VERSION)
        body = await self.play_body(commitment=commitment)
        with patch.object(engine, "FAIRNESS_VERSION", "chicken-road-hmac-v2"):
            await self.assert_error(route.play(body, self.user), "RULES_CHANGED")
        self.assertEqual(await self.balance(), 100000)
        self.assertEqual(await self.events(), [])
        self.assertEqual(await self.exposure(), 0)
        self.assertEqual(await self.db.chicken_road_rounds.count_documents({}), 0)
        self.assertEqual((await self.db.chicken_road_commitments.find_one({"_id": commitment["commitment_id"]}))["status"], "PREPARED")
        self.survival.assert_not_called()

    async def test_new_rounds_publish_and_bind_only_current_ninety_percent_rules(self):
        self.assertEqual(engine.RULES_VERSION, _CURRENT_RULES_VERSION)
        prepared = await self.prepare()
        body, played = await self.start(commitment=prepared)
        state = await route.state(self.user)
        self.assertEqual(state["rules"]["version"], _CURRENT_RULES_VERSION)
        self.assertEqual(state["rules"]["rtp_bps"], 9000)
        for item in (prepared, body.model_dump(), played["round"]):
            self.assertEqual(item["rules_version"], _CURRENT_RULES_VERSION)
        stored = await self.db.chicken_road_rounds.find_one({"_id": played["round"]["id"]})
        self.assertEqual(stored["server_seed_hash"], engine.seed_commitment(
            stored["server_seed"], stored["nonce"], rules_version=_CURRENT_RULES_VERSION,
        ))
        self.assertNotEqual(stored["server_seed_hash"], engine.seed_commitment(
            stored["server_seed"], stored["nonce"], rules_version=_LEGACY_RULES_VERSION,
        ))
        self.assertEqual(self.survival.call_args.kwargs, {"rules_version": _CURRENT_RULES_VERSION})

    async def test_legacy_active_go_cashout_and_terminal_proof_preserve_v1_rules(self):
        _, prepared, _, played = await self.start_legacy_fixture()
        self.assertEqual(engine.RULES_VERSION, _CURRENT_RULES_VERSION)
        current = await route.state(self.user)
        self.assertEqual(current["rules"]["rtp_bps"], 9000)
        self.assertEqual(current["active_round"]["rules_version"], _LEGACY_RULES_VERSION)
        self.assertEqual(current["active_round"]["multipliers_hundredths"], _LEGACY_MEDIUM_LADDER)
        # This fixture would crash if GO accidentally used the current engine.
        self.assertFalse(_REAL_LANE_SURVIVES(
            _LEGACY_SERVER_SEED, "f" * 64, "legacy-commitment", "medium", 2,
            rules_version=_CURRENT_RULES_VERSION,
        ))
        stepped = await route.go(self.action_body(played), self.user)
        self.assertEqual((stepped["round"]["status"], stepped["round"]["lane"]), ("PLAYING", 2))
        self.assertEqual(self.survival.call_args.kwargs, {"rules_version": _LEGACY_RULES_VERSION})
        cashed = await route.cashout(self.action_body(stepped), self.user)
        self.assertEqual(cashed["round"]["payout"], 384)
        self.assertEqual(cashed["round"]["rules_version"], _LEGACY_RULES_VERSION)
        self.assertEqual(await self.balance(), 100084)
        self.assertEqual(await self.exposure(), 0)
        await self.assert_terminal_once(cashed)
        proof = await route.fairness(played["round"]["id"], self.user)
        self.assertEqual(proof["rules_version"], _LEGACY_RULES_VERSION)
        self.assertEqual(proof["multipliers_hundredths"], _LEGACY_MEDIUM_LADDER)
        commitment_bytes = json.dumps([
            "chicken-road:seed-commitment", _LEGACY_RULES_VERSION, "chicken-road-hmac-v1",
            proof["nonce"], proof["server_seed"],
        ], ensure_ascii=True, separators=(",", ":")).encode("utf-8")
        self.assertEqual(hashlib.sha256(commitment_bytes).hexdigest(), prepared["server_seed_hash"])
        self.assertEqual(proof["server_seed_hash"], prepared["server_seed_hash"])
        self.assertEqual([_independent_legacy_draw(proof, lane) for lane in (1, 2, 3)], [42, 28, 130])
        for lane in (1, 2):
            self.assertTrue(_REAL_LANE_SURVIVES(
                proof["server_seed"], proof["client_seed"], proof["nonce"], proof["difficulty"], lane,
                rules_version=proof["rules_version"],
            ))

    async def test_legacy_collision_uses_v1_stream_and_settles_stake_once(self):
        _, _, _, played = await self.start_legacy_fixture()
        stepped = await route.go(self.action_body(played), self.user)
        request = self.action_body(stepped)
        crashed = await route.go(request, self.user)
        self.assertEqual((crashed["round"]["status"], crashed["round"]["lane"], crashed["round"]["payout"]), ("CRASHED", 3, 0))
        self.assertEqual(crashed["round"]["rules_version"], _LEGACY_RULES_VERSION)
        self.assertEqual(await route.go(request, self.user), crashed)
        self.assertEqual(await self.balance(), 99700)
        self.assertEqual(await self.exposure(), 0)
        await self.assert_terminal_once(crashed)
        proof = await route.fairness(played["round"]["id"], self.user)
        self.assertGreaterEqual(_independent_legacy_draw(proof, 3), _LEGACY_MEDIUM_LADDER[1])

    async def _assert_legacy_expiry_after_upgrade(self, *, worker):
        _, _, _, played = await self.start_legacy_fixture()
        stepped = await route.go(self.action_body(played), self.user)
        self.clock += timedelta(seconds=engine.EXPIRY_SECONDS)
        with patch.dict(os.environ, {"CHICKEN_ROAD_LIVE_ENABLED": "false"}):
            if worker:
                await self.db.users.update_one({"id": self.user["id"]}, {"$set": {"status": "SUSPENDED"}})
                self.assertEqual(await route.settle_expired_chicken_rounds(), 1)
                self.assertEqual(await route.settle_expired_chicken_rounds(), 0)
                terminal = await self.db.chicken_road_rounds.find_one({"_id": stepped["round"]["id"]})
            else:
                state = await route.state(self.user)
                self.assertEqual(await route.state(self.user), state)
                self.assertFalse(state["enabled"])
                self.assertIsNone(state["active_round"])
                terminal = state["latest_round"]
        self.assertEqual((terminal["status"], terminal["lane"], terminal["payout"]), ("CASHED", 2, 384))
        self.assertEqual(terminal["reason"], "INACTIVITY")
        self.assertEqual(terminal["rules_version"], _LEGACY_RULES_VERSION)
        self.assertEqual(terminal["multipliers_hundredths"], _LEGACY_MEDIUM_LADDER)
        self.assertEqual(await self.balance(), 100084)
        self.assertEqual(await self.exposure(), 0)
        self.assertEqual(self.survival.call_count, 2)
        await self.assert_terminal_once({"round": terminal})

    async def test_legacy_state_expiry_survives_upgrade_and_intake_pause(self):
        await self._assert_legacy_expiry_after_upgrade(worker=False)

    async def test_legacy_worker_expiry_survives_upgrade_pause_and_restriction(self):
        await self._assert_legacy_expiry_after_upgrade(worker=True)

    async def test_all_legacy_receipts_replay_unchanged_after_rules_upgrade(self):
        with patch.object(engine, "RULES_VERSION", _LEGACY_RULES_VERSION):
            prepare_key, prepared, play_body, played = await self.start_legacy_fixture()
            go_body = self.action_body(played)
            stepped = await route.go(go_body, self.user)
            cash_body = self.action_body(stepped)
            cashed = await route.cashout(cash_body, self.user)
        before = await self.db.snapshot()
        draws_before = self.survival.call_count
        self.assertEqual(await self.prepare(key=prepare_key), prepared)
        self.assertEqual(await route.play(play_body, self.user), played)
        self.assertEqual(await route.go(go_body, self.user), stepped)
        self.assertEqual(await route.cashout(cash_body, self.user), cashed)
        for key, receipt in ((prepare_key, prepared), (play_body.operation_id, played),
                             (go_body.operation_id, stepped), (cash_body.operation_id, cashed)):
            self.assertEqual(await route.operation_receipt(key, self.user), {"found": True, **receipt})
        self.assertEqual(await self.db.snapshot(), before)
        self.assertEqual(self.survival.call_count, draws_before)
        await self.assert_terminal_once(cashed)

    async def test_unused_v1_commitment_cannot_accept_a_new_stake_after_upgrade(self):
        with patch.object(engine, "RULES_VERSION", _LEGACY_RULES_VERSION):
            prepared = await self.prepare()
            old_body = await self.play_body(commitment=prepared)
        self.assertEqual(engine.RULES_VERSION, _CURRENT_RULES_VERSION)
        await self.assert_error(route.play(old_body, self.user), "RULES_CHANGED")
        # Merely relabelling the Play request must not upgrade its commitment.
        changed_body = old_body.model_copy(update={
            "operation_id": self.key("relabelled-play"), "rules_version": _CURRENT_RULES_VERSION,
        })
        await self.assert_error(route.play(changed_body, self.user), "RULES_CHANGED")
        for body in (old_body, changed_body):
            rejected = await route.operation_receipt(body.operation_id, self.user)
            self.assertEqual((rejected["status"], rejected["error"]["code"]), ("REJECTED", "RULES_CHANGED"))
        self.assertEqual(await self.balance(), 100000)
        self.assertEqual(await self.events(), [])
        self.assertEqual(await self.exposure(), 0)
        self.assertEqual(await self.db.chicken_road_rounds.count_documents({}), 0)
        self.assertEqual(await self.db.chicken_road_players.count_documents({}), 0)
        self.assertEqual((await self.db.chicken_road_commitments.find_one({"_id": prepared["commitment_id"]}))["status"], "PREPARED")
        self.survival.assert_not_called()

    async def test_settled_fairness_proof_survives_rules_and_fairness_version_upgrades(self):
        _, played = await self.start()
        await route.cashout(self.action_body(played), self.user)
        round_id = played["round"]["id"]
        original = await route.fairness(round_id, self.user)
        snapshot = await self.db.snapshot()
        with patch.object(engine, "RULES_VERSION", "chicken-road-rules-v2"), patch.object(engine, "FAIRNESS_VERSION", "chicken-road-hmac-v2"):
            self.assertEqual(await route.fairness(round_id, self.user), original)
        self.assertEqual(await self.db.snapshot(), snapshot)
        self.assertEqual(original["rules_version"], _CURRENT_RULES_VERSION)
        self.assertEqual(original["fairness_version"], "chicken-road-hmac-v1")

    async def test_malformed_terminal_or_unknown_status_never_reveals_a_private_seed(self):
        _, played = await self.start()
        round_id = played["round"]["id"]
        original = await self.db.chicken_road_rounds.find_one({"_id": round_id})
        for changes in ({"status": "PENDING", "settled_at": None},
                        {"status": "UNKNOWN", "settled_at": self.clock.isoformat()},
                        {"status": "CASHED", "settled_at": None},
                        {"status": "CRASHED", "settled_at": None}):
            await self.db.chicken_road_rounds.update_one({"_id": round_id}, {"$set": changes})
            snapshot = await self.db.snapshot()
            error = await self.assert_error(route.fairness(round_id, self.user), "CHICKEN_ROAD_ROUND_INVALID", 503)
            self.assertNotIn(original["server_seed"], json.dumps(error.detail))
            self.assertEqual(await self.db.snapshot(), snapshot)

    async def test_corrupted_locked_rules_fail_before_financial_transition(self):
        for version in (_LEGACY_RULES_VERSION, _CURRENT_RULES_VERSION):
            with patch.object(engine, "RULES_VERSION", version):
                _, played = await self.start()
            for changes in ({"rules_version": "future-rules"}, {"rules_version": None},
                            {"fairness_version": "future-fairness"}, {"multipliers_hundredths": [112] * 13},
                            {"multipliers_hundredths": [float(value) for value in _LEGACY_MEDIUM_LADDER]},
                            {"amount": True}):
                with self.subTest(version=version, changes=changes):
                    original = await self.db.chicken_road_rounds.find_one({"_id": played["round"]["id"]})
                    await self.db.chicken_road_rounds.update_one({"_id": original["id"]}, {"$set": changes})
                    snapshot = await self.db.snapshot()
                    draws_before = self.survival.call_count
                    await self.assert_error(route.cashout(self.action_body(played), self.user), "CHICKEN_ROAD_RULES_UNAVAILABLE", 503)
                    await self.assert_error(route.go(self.action_body(played), self.user), "CHICKEN_ROAD_RULES_UNAVAILABLE", 503)
                    self.assertEqual(await self.db.snapshot(), snapshot)
                    self.assertEqual(self.survival.call_count, draws_before)
                    await self.db.chicken_road_rounds.replace_one({"_id": original["id"]}, original)
            await route.cashout(self.action_body(played), self.user)

    async def test_state_expiry_settles_at_last_safe_lane_once_even_while_paused(self):
        _, played = await self.start()
        self.clock += timedelta(seconds=engine.EXPIRY_SECONDS)
        with patch.dict(os.environ, {"CHICKEN_ROAD_LIVE_ENABLED": "false"}):
            current = await route.state(self.user)
            repeated = await route.state(self.user)
        self.assertEqual(current, repeated)
        self.assertFalse(current["enabled"])
        self.assertIsNone(current["active_round"])
        self.assertEqual(current["latest_round"]["reason"], "INACTIVITY")
        self.assertEqual(current["latest_round"]["payout"], 336)
        await self.assert_terminal_once({"round": current["latest_round"]})
        self.assertEqual(self.survival.call_count, 1)

    async def test_expired_go_cashout_and_worker_race_settles_once_without_another_draw(self):
        _, played = await self.start()
        self.clock += timedelta(seconds=engine.EXPIRY_SECONDS)
        results = await asyncio.gather(route.go(self.action_body(played), self.user), route.settle_expired_chicken_rounds(), return_exceptions=True)
        state = await route.state(self.user)
        self.assertEqual(state["latest_round"]["reason"], "INACTIVITY")
        self.assertEqual(state["latest_round"]["lane"], 1)
        self.assertEqual(self.survival.call_count, 1)
        self.assertEqual(await route.settle_expired_chicken_rounds(), 0)
        await self.assert_terminal_once({"round": state["latest_round"]})
        self.assertFalse(any(isinstance(result, RuntimeError) for result in results))

    async def test_worker_expiry_continues_after_pause_and_account_restriction(self):
        _, played = await self.start()
        self.clock += timedelta(seconds=engine.EXPIRY_SECONDS)
        await self.db.users.update_one({"id": self.user["id"]}, {"$set": {"status": "SUSPENDED"}})
        with patch.dict(os.environ, {"CHICKEN_ROAD_LIVE_ENABLED": "false"}):
            self.assertEqual(await route.settle_expired_chicken_rounds(), 1)
            self.assertEqual(await route.settle_expired_chicken_rounds(), 0)
        current = await self.db.chicken_road_rounds.find_one({"_id": played["round"]["id"]})
        self.assertEqual((current["status"], current["reason"], current["payout"]), ("CASHED", "INACTIVITY", 336))
        self.assertEqual(await self.balance(), 100036)
        await self.assert_terminal_once({"round": current})

    async def test_bad_expired_round_keeps_reservation_and_does_not_starve_other_players(self):
        _, bad = await self.start()
        self.clock += timedelta(seconds=1)
        other = {**self.user, "id": "player-2", "active_session_id": "session-2"}
        await self.db.users.insert_one(copy.deepcopy(other))
        _, good = await self.start(user=other)
        await self.db.chicken_road_rounds.update_one({"_id": bad["round"]["id"]}, {"$set": {"rules_version": "unavailable-rules"}})
        self.clock += timedelta(seconds=engine.EXPIRY_SECONDS)
        # limit=1 reproduces the starvation edge: the broken first candidate
        # must be backed off so the next batch can reach the healthy player.
        with self.assertLogs(route.logger, level="ERROR"):
            self.assertEqual(await route.settle_expired_chicken_rounds(limit=1), 0)
        broken = await self.db.chicken_road_rounds.find_one({"_id": bad["round"]["id"]})
        self.assertEqual(broken["expiry_retry_after"], (self.clock + timedelta(seconds=60)).isoformat())
        self.assertEqual(await route.settle_expired_chicken_rounds(limit=1), 1)
        self.assertEqual((await self.db.chicken_road_rounds.find_one({"_id": bad["round"]["id"]}))["status"], "PLAYING")
        settled = await self.db.chicken_road_rounds.find_one({"_id": good["round"]["id"]})
        self.assertEqual((settled["status"], settled["reason"]), ("CASHED", "INACTIVITY"))
        await self.assert_terminal_once({"round": settled}, user=other)
        self.assertEqual(await self.exposure(), 2670)
        self.assertEqual(await self.balance(), 99700)
        self.assertEqual(await self.balance(other), 100036)
        self.assertEqual(await route.settle_expired_chicken_rounds(), 0)
        await self.db.chicken_road_rounds.update_one({"_id": bad["round"]["id"]}, {"$set": {"rules_version": engine.RULES_VERSION}})
        self.assertEqual(await route.settle_expired_chicken_rounds(), 0)
        self.clock += timedelta(seconds=60)
        self.assertEqual(await route.settle_expired_chicken_rounds(), 1)
        self.assertEqual(await self.exposure(), 0)

    async def _assert_broken_active_guard_does_not_starve_worker(self, *, missing):
        _, broken = await self.start()
        guard = await self.db.chicken_road_players.find_one({"_id": self.user["id"]})
        if missing:
            await self.db.chicken_road_players.delete_one({"_id": self.user["id"]})
        else:
            await self.db.chicken_road_players.update_one({"_id": self.user["id"]}, {"$set": {"active_round_id": "unrelated-round"}})
        self.clock += timedelta(seconds=1)
        other = {**self.user, "id": "player-2", "active_session_id": "session-2"}
        await self.db.users.insert_one(copy.deepcopy(other))
        _, healthy = await self.start(user=other)
        self.clock += timedelta(seconds=engine.EXPIRY_SECONDS)
        with self.assertLogs(route.logger, level="ERROR"):
            self.assertEqual(await route.settle_expired_chicken_rounds(limit=1), 0)
        pending = await self.db.chicken_road_rounds.find_one({"_id": broken["round"]["id"]})
        self.assertEqual(pending["status"], "PLAYING")
        self.assertEqual(pending["expiry_retry_after"], (self.clock + timedelta(seconds=60)).isoformat())
        self.assertEqual(await route.settle_expired_chicken_rounds(limit=1), 1)
        settled = await self.db.chicken_road_rounds.find_one({"_id": healthy["round"]["id"]})
        await self.assert_terminal_once({"round": settled}, user=other)
        self.assertEqual(await self.exposure(), 2670)
        self.assertEqual(await self.balance(), 99700)
        self.assertEqual(len(await self.events(ledger.SETTLEMENT)), 0)
        self.assertEqual(await route.settle_expired_chicken_rounds(limit=1), 0)
        await self.db.chicken_road_players.replace_one({"_id": self.user["id"]}, guard, upsert=True)
        self.clock += timedelta(seconds=60)
        self.assertEqual(await route.settle_expired_chicken_rounds(limit=1), 1)
        repaired = await self.db.chicken_road_rounds.find_one({"_id": broken["round"]["id"]})
        await self.assert_terminal_once({"round": repaired})
        self.assertEqual(await self.exposure(), 0)

    async def test_orphaned_round_without_active_guard_does_not_starve_worker(self):
        await self._assert_broken_active_guard_does_not_starve_worker(missing=True)

    async def test_round_with_mismatched_active_guard_does_not_starve_worker(self):
        await self._assert_broken_active_guard_does_not_starve_worker(missing=False)

    async def test_pause_blocks_prepare_play_go_but_preserves_cashout_and_receipts(self):
        body, played = await self.start()
        with patch.dict(os.environ, {"CHICKEN_ROAD_LIVE_ENABLED": "false"}):
            await self.assert_error(self.prepare(), "CHICKEN_ROAD_PAUSED")
            await self.assert_error(route.go(self.action_body(played), self.user), "CHICKEN_ROAD_PAUSED")
            await self.assert_error(route.play(body.model_copy(update={"operation_id": self.key("paused-play")}), self.user), "CHICKEN_ROAD_PAUSED")
            self.assertTrue((await route.operation_receipt(body.operation_id, self.user))["found"])
            cashed = await route.cashout(self.action_body(played), self.user)
        await self.assert_terminal_once(cashed)

    async def test_pause_replays_accepted_receipts_and_durably_rejects_new_operation_keys(self):
        prepare_key = self.key("accepted-prepare")
        prepared = await self.prepare(key=prepare_key)
        play_body, played = await self.start(commitment=prepared)
        go_body = self.action_body(played)
        stepped = await route.go(go_body, self.user)
        rejected_go = self.action_body(stepped)
        rejected_play = play_body.model_copy(update={"operation_id": self.key("paused-play")})
        rejected_prepare = route.OperationRequest(operation_id=self.key("paused-prepare"))
        with patch.dict(os.environ, {"CHICKEN_ROAD_LIVE_ENABLED": "false"}):
            self.assertEqual(await self.prepare(key=prepare_key), prepared)
            self.assertEqual(await route.play(play_body, self.user), played)
            self.assertEqual(await route.go(go_body, self.user), stepped)
            await self.assert_error(route.go(rejected_go, self.user), "CHICKEN_ROAD_PAUSED")
            await self.assert_error(route.play(rejected_play, self.user), "CHICKEN_ROAD_PAUSED")
            await self.assert_error(route.prepare_round(rejected_prepare, self.user), "CHICKEN_ROAD_PAUSED")
            for body in (rejected_go, rejected_play, rejected_prepare):
                receipt = await route.operation_receipt(body.operation_id, self.user)
                self.assertEqual((receipt["found"], receipt["status"], receipt["error"]["code"]), (True, "REJECTED", "CHICKEN_ROAD_PAUSED"))
        # Re-enabling intake cannot reinterpret an already final rejection.
        await self.assert_error(route.go(rejected_go, self.user), "CHICKEN_ROAD_PAUSED")
        await self.assert_error(route.play(rejected_play, self.user), "CHICKEN_ROAD_PAUSED")
        await self.assert_error(route.prepare_round(rejected_prepare, self.user), "CHICKEN_ROAD_PAUSED")
        self.assertEqual(self.survival.call_count, 2)
        self.assertEqual((await route.state(self.user))["active_round"]["version"], 2)
        self.assertEqual(len(await self.events(ledger.STAKE)), 1)
        fresh_go = await route.go(self.action_body(stepped), self.user)
        self.assertEqual(fresh_go["round"]["lane"], 3)

    async def test_restricted_deleted_admin_and_replaced_sessions_block_new_activity(self):
        cases = (
            ({"status": "SUSPENDED"}, "SUSPENDED", 403),
            ({"status": "DELETED"}, "ACCOUNT_UNAVAILABLE", 403),
            ({"deleted_at": "2026-09-23T11:00:00+00:00"}, "ACCOUNT_UNAVAILABLE", 403),
            ({"role": "ADMIN"}, "NOT_A_PLAYER", 403),
            ({"role": "DISTRIBUTOR"}, "NOT_A_PLAYER", 403),
            ({"active_session_id": "new-session"}, "SESSION_REPLACED", 401),
            ({"financial_status": "BLOCKED"}, "FINANCIAL_ACCOUNT_RESTRICTED", 403),
            ({"password_change_required": True}, "PASSWORD_CHANGE_REQUIRED", 403),
        )
        for changes, code, status in cases:
            await self.db.users.replace_one({"id": self.user["id"]}, copy.deepcopy(self.user))
            body = await self.play_body()
            await self.db.users.update_one({"id": self.user["id"]}, {"$set": changes})
            await self.assert_error(route.play(body, self.user), code, status)
            await self.assert_error(self.prepare(), code, status)
            self.assertEqual(await self.events(), [])
            self.assertEqual(await self.exposure(), 0)

    async def test_actual_compliance_exclusion_and_stake_guard_are_not_bypassed(self):
        body = await self.play_body()
        await self.db.exclusions.insert_one({"id": "exclusion-1", "user_id": self.user["id"], "status": "ACTIVE", "kind": "SELF_EXCLUSION", "ends_at": None})
        await self.assert_error(route.play(body, self.user), "SELF_EXCLUDED", 403)
        self.assertEqual(await self.events(), [])
        await self.db.exclusions.delete_many({})
        guard = AsyncMock(side_effect=HTTPException(403, {"code": "LOSS_LIMIT", "message": "Limit reached"}))
        with patch.object(ledger, "_stake_guards", [guard]):
            await self.assert_error(route.play(body, self.user), "LOSS_LIMIT", 403)
        self.assertEqual(guard.await_count, 1)
        self.assertIsNotNone(guard.call_args.kwargs["session"])
        self.assertEqual(await self.balance(), 100000)
        self.assertEqual(await self.exposure(), 0)

    async def test_missing_account_refuses_new_activity_without_writes(self):
        body = await self.play_body()
        await self.db.users.delete_one({"id": self.user["id"]})
        snapshot = await self.db.snapshot()
        await self.assert_error(route.play(body, self.user), "ACCOUNT_UNAVAILABLE", 403)
        self.assertEqual(await self.db.snapshot(), snapshot)

    def http_client(self, *, token=None):
        app = FastAPI()
        app.include_router(route.router, prefix="/api")
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        return AsyncClient(transport=ASGITransport(app=app), base_url="http://isolated.test", headers=headers)

    async def test_http_auth_blocks_restricted_deleted_and_replaced_sessions_on_reads_and_replays(self):
        body, played = await self.start()
        await route.cashout(self.action_body(played), self.user)
        token = auth_utils.create_access_token(self.user["id"], "PLAYER", session_id=self.user["active_session_id"])
        paths = (f"/api/live/chicken-road/operations/{body.operation_id}",
                 f"/api/live/chicken-road/rounds/{played['round']['id']}/fairness")
        async with self.http_client(token=token) as client:
            for changes, expected in (({"status": "SUSPENDED"}, 403), ({"status": "DELETED"}, 401),
                                      ({"financial_status": "FROZEN"}, 403),
                                      ({"password_change_required": True}, 403),
                                      ({"active_session_id": "replaced-session"}, 401)):
                original = await self.db.users.find_one({"id": self.user["id"]})
                await self.db.users.update_one({"id": self.user["id"]}, {"$set": changes})
                with self.subTest(changes=changes):
                    for path in paths:
                        response = await client.get(path)
                        self.assertEqual(response.status_code, expected)
                    response = await client.post("/api/live/chicken-road/play", json=body.model_dump())
                    self.assertEqual(response.status_code, expected)
                await self.db.users.replace_one({"id": self.user["id"]}, original)
        self.assertEqual(len(await self.events(ledger.STAKE)), 1)
        self.assertEqual(len(await self.events(ledger.PAYOUT)), 1)

    async def test_http_requires_auth_and_refuses_admin_mutations(self):
        async with self.http_client() as client:
            self.assertEqual((await client.get("/api/live/chicken-road/state")).status_code, 401)
            self.assertEqual((await client.post("/api/live/chicken-road/prepare", json={"operation_id": self.key()})).status_code, 401)
        await self.db.users.update_one({"id": self.user["id"]}, {"$set": {"role": "ADMIN"}})
        token = auth_utils.create_access_token(self.user["id"], "ADMIN", session_id=self.user["active_session_id"])
        async with self.http_client(token=token) as client:
            response = await client.post("/api/live/chicken-road/prepare", json={"operation_id": self.key()})
            self.assertEqual(response.status_code, 403)
            self.assertEqual(response.json()["detail"]["code"], "NOT_A_PLAYER")
        self.assertEqual(await self.db.chicken_road_commitments.count_documents({}), 0)

    async def test_http_strict_body_and_operation_path_validation_returns_422_without_stakes(self):
        body = await self.play_body()
        token = auth_utils.create_access_token(self.user["id"], "PLAYER", session_id=self.user["active_session_id"])
        async with self.http_client(token=token) as client:
            for changes in ({"amount": True}, {"amount": "300"}, {"amount": 300.0}, {"payout": 9999}, {"client_seed": "A" * 64}):
                response = await client.post("/api/live/chicken-road/play", json={**body.model_dump(), **changes})
                self.assertEqual(response.status_code, 422)
            for key in ("short", "invalid%20space", "a" * 129):
                self.assertEqual((await client.get(f"/api/live/chicken-road/operations/{key}")).status_code, 422)
        self.assertEqual(await self.events(), [])

    async def test_disabled_rule_approval_is_fail_closed_for_every_handler(self):
        with patch.object(route, "RULES_APPROVED", False):
            await self.assert_error(self.prepare(), "CHICKEN_ROAD_DISABLED", 503)
            await self.assert_error(route.state(self.user), "CHICKEN_ROAD_DISABLED", 503)
            await self.assert_error(route.operation_receipt("operation-1", self.user), "CHICKEN_ROAD_DISABLED", 503)
            await self.assert_error(route.fairness("round-1", self.user), "CHICKEN_ROAD_DISABLED", 503)
            await self.assert_error(route.settle_expired_chicken_rounds(), "CHICKEN_ROAD_DISABLED", 503)
        self.assertEqual(await self.db.chicken_road_commitments.count_documents({}), 0)
        self.assertEqual(await self.events(), [])

    async def test_exposure_configuration_and_reviewed_catalogue_gate_fail_closed(self):
        for value in ("", "0", "-1", "1.5", "true", "９００", "9000000000000001"):
            with patch.dict(os.environ, {"CHICKEN_ROAD_EXPOSURE_LIMIT": value}):
                await self.assert_error(self.prepare(), "CHICKEN_ROAD_EXPOSURE_UNAVAILABLE")
        with patch.object(route, "require_playable_game", game_access.require_playable_game):
            await self.assert_error(self.prepare(), "GAME_COMING_SOON")
        self.assertEqual(await self.db.chicken_road_commitments.count_documents({}), 0)

    async def test_state_and_status_report_all_intake_requirements_without_writes(self):
        before = await self.db.snapshot()
        ready = await route.chicken_road_status()
        self.assertEqual(ready, {
            "ready": True, "intake_requested": True, "catalogue_enabled": True, "enabled": True,
            "requirements": {"rules_approved": True, "storage_prepared": True,
                             "exposure_configured": True, "exposure_counter_valid": True},
        })
        state = await route.state(self.user)
        self.assertTrue(state["enabled"])
        self.assertEqual(state["rules"]["approval"], "APPROVED")
        self.assertEqual(state["readiness"], ready)
        self.assertEqual(await self.db.snapshot(), before)
        with patch.dict(os.environ, {"CHICKEN_ROAD_LIVE_ENABLED": "false"}):
            status = await route.chicken_road_status()
            self.assertTrue(status["ready"])
            self.assertFalse(status["enabled"])
            self.assertFalse(status["intake_requested"])
        self.playable.side_effect = game_access.coming_soon_error(route.SLUG)
        status = await route.chicken_road_status()
        self.assertTrue(status["ready"])
        self.assertFalse(status["catalogue_enabled"])
        self.assertFalse(status["enabled"])

    async def test_failed_bootstrap_blocks_new_mutations_but_cashout_and_receipts_survive(self):
        body, played = await self.start()
        exposure = await self.exposure()
        self.db.fail_once("chicken_road_rounds", "create_index")
        with self.assertRaisesRegex(RuntimeError, "injected"):
            await route.prepare_chicken_road_storage()
        self.assertFalse(route._STORAGE_READY)
        self.assertEqual(await self.exposure(), exposure)
        current = await route.state(self.user)
        self.assertFalse(current["enabled"])
        self.assertFalse(current["readiness"]["requirements"]["storage_prepared"])
        self.assertEqual(current["active_round"]["cashout_amount"], 336)
        rejected_go = self.action_body(played)
        await self.assert_error(route.go(rejected_go, self.user), "CHICKEN_ROAD_STORAGE_UNAVAILABLE")
        await self.assert_error(self.prepare(), "CHICKEN_ROAD_STORAGE_UNAVAILABLE")
        await self.assert_error(route.play(body.model_copy(update={"operation_id": self.key("not-ready")}), self.user),
                                "CHICKEN_ROAD_STORAGE_UNAVAILABLE")
        self.assertEqual((await route.operation_receipt(rejected_go.operation_id, self.user))["status"], "REJECTED")
        self.assertEqual(await route.play(body, self.user), played)
        self.assertEqual(len(await self.events(ledger.STAKE)), 1)
        cashed = await route.cashout(self.action_body(played), self.user)
        await self.assert_terminal_once(cashed)
        self.assertEqual(await self.exposure(), 0)
        await route.prepare_chicken_road_storage()
        self.assertTrue(route._STORAGE_READY)
        self.assertTrue((await route.state(self.user))["enabled"])
        await self.assert_error(route.go(rejected_go, self.user), "CHICKEN_ROAD_STORAGE_UNAVAILABLE")

    async def test_missing_exposure_configuration_durably_rejects_go_and_allows_cashout(self):
        _, played = await self.start()
        rejected_go = self.action_body(played)
        with patch.dict(os.environ, {"CHICKEN_ROAD_EXPOSURE_LIMIT": ""}):
            state = await route.state(self.user)
            self.assertFalse(state["enabled"])
            self.assertFalse(state["readiness"]["requirements"]["exposure_configured"])
            await self.assert_error(route.go(rejected_go, self.user), "CHICKEN_ROAD_EXPOSURE_UNAVAILABLE")
            self.assertEqual((await route.operation_receipt(rejected_go.operation_id, self.user))["status"], "REJECTED")
            cashed = await route.cashout(self.action_body(played), self.user)
        await self.assert_terminal_once(cashed)
        self.assertEqual(await self.exposure(), 0)
        await self.assert_error(route.go(rejected_go, self.user), "CHICKEN_ROAD_EXPOSURE_UNAVAILABLE")

    async def test_expiry_survives_failed_bootstrap_and_missing_exposure_configuration(self):
        _, played = await self.start()
        self.clock += timedelta(seconds=engine.EXPIRY_SECONDS)
        with patch.object(route, "_STORAGE_READY", False), patch.dict(os.environ, {"CHICKEN_ROAD_EXPOSURE_LIMIT": ""}):
            self.assertEqual(await route.settle_expired_chicken_rounds(), 1)
            state = await route.state(self.user)
        self.assertFalse(state["enabled"])
        self.assertIsNone(state["active_round"])
        self.assertEqual(state["latest_round"]["payout"], 336)
        self.assertEqual(state["latest_round"]["id"], played["round"]["id"])
        await self.assert_terminal_once({"round": state["latest_round"]})

    async def test_missing_or_invalid_counter_never_advertises_or_accepts_new_play(self):
        body = await self.play_body()
        for invalid in (None, True, 0.0, "0", -1, 9_000_000_000_000_001):
            await self.db.chicken_road_exposure.delete_many({})
            if invalid is not None:
                await self.db.chicken_road_exposure.insert_one({"_id": route.SLUG, "outstanding_chips": invalid})
            with self.subTest(counter=invalid):
                state = await route.state(self.user)
                self.assertFalse(state["enabled"])
                self.assertFalse(state["readiness"]["requirements"]["exposure_counter_valid"])
                await self.assert_error(self.prepare(), "CHICKEN_ROAD_EXPOSURE_UNAVAILABLE")
                await self.assert_error(route.play(body.model_copy(update={"operation_id": self.key("counter-play")}), self.user),
                                        "CHICKEN_ROAD_EXPOSURE_UNAVAILABLE")
                self.assertEqual(await self.events(), [])
                self.assertEqual(await self.balance(), 100000)

    async def test_preparation_preserves_reserved_liability_and_rejects_corrupt_counter(self):
        _, played = await self.start()
        exposure = await self.exposure()
        await route.prepare_chicken_road_storage()
        self.assertEqual(await self.exposure(), exposure)
        with patch.dict(os.environ, {"CHICKEN_ROAD_EXPOSURE_LIMIT": str(exposure)}):
            # Full budget is not a technical outage and cannot disable GO or
            # cash-out for a round whose full liability is already reserved.
            self.assertTrue((await route.chicken_road_status())["ready"])
            stepped = await route.go(self.action_body(played), self.user)
            await route.cashout(self.action_body(stepped), self.user)
        await self.db.chicken_road_exposure.update_one({"_id": route.SLUG}, {"$set": {"outstanding_chips": -1}})
        with self.assertRaisesRegex(RuntimeError, "reconciliation"):
            await route.prepare_chicken_road_storage()
        self.assertFalse(route._STORAGE_READY)
        self.assertEqual(await self.exposure(), -1)

    async def test_missing_counter_with_retained_round_is_not_reinitialized_to_zero(self):
        _, played = await self.start()
        await self.db.chicken_road_exposure.delete_many({})
        # The round alone must protect its liability even if its guard is
        # separately missing and already needs reconciliation.
        await self.db.chicken_road_players.delete_many({})
        before = await self.db.snapshot()
        with self.assertRaisesRegex(RuntimeError, "retained rounds"):
            await route.prepare_chicken_road_storage()
        self.assertFalse(route._STORAGE_READY)
        self.assertEqual(await self.db.snapshot(), before)
        self.assertIsNone(await self.db.chicken_road_exposure.find_one({"_id": route.SLUG}))
        self.assertEqual((await self.db.chicken_road_rounds.find_one({"_id": played["round"]["id"]}))["status"], "PLAYING")

    async def test_missing_counter_with_orphaned_active_guard_is_not_reinitialized_to_zero(self):
        await self.db.chicken_road_exposure.delete_many({})
        await self.db.chicken_road_players.insert_one({"_id": self.user["id"], "active_round_id": "missing-round"})
        before = await self.db.snapshot()
        with self.assertRaisesRegex(RuntimeError, "retained rounds"):
            await route.prepare_chicken_road_storage()
        self.assertFalse(route._STORAGE_READY)
        self.assertEqual(await self.db.snapshot(), before)
        self.assertIsNone(await self.db.chicken_road_exposure.find_one({"_id": route.SLUG}))

    async def test_real_wallet_readiness_guard_fails_without_installed_adapter(self):
        with patch.object(route, "_require_wallet_user", _REAL_REQUIRE_WALLET_USER):
            await self.assert_error(self.prepare(), "CHICKEN_ROAD_WALLET_UNAVAILABLE", 503)
        self.assertEqual(await self.db.chicken_road_commitments.count_documents({}), 0)

    async def test_wallet_runtime_failure_remains_service_unavailable_not_account_reconciliation(self):
        with patch.object(route, "_require_wallet_user", _REAL_REQUIRE_WALLET_USER), \
                patch.object(ledger, "_source_wallet_adapter", game_wallet.ADAPTER), \
                patch.object(finance, "_READY", False), \
                patch.object(bonus_policy, "_READY", False):
            before = await self.db.snapshot()
            await self.assert_error(route.state(self.user), "CHICKEN_ROAD_WALLET_UNAVAILABLE", 503)
            self.assertEqual(await self.db.snapshot(), before)

    async def test_legacy_account_reports_wallet_reconciliation_without_reclassifying_chips(self):
        with patch.object(route, "_require_wallet_user", _REAL_REQUIRE_WALLET_USER), \
                patch.object(ledger, "_source_wallet_adapter", game_wallet.ADAPTER), \
                patch.object(finance, "_READY", False), \
                patch.object(bonus_policy, "_READY", True), \
                patch.dict(os.environ, {"CHAKRI_BONUS_POLICY_ENABLED": "true", "REAL_MONEY_ENABLED": "false"}):
            before = await self.db.snapshot()
            await self.assert_error(route.state(self.user), "CHICKEN_ROAD_WALLET_RECONCILIATION_REQUIRED")
            self.assertEqual(await self.db.snapshot(), before)
            body = route.OperationRequest(operation_id=self.key("legacy-prepare"))
            await self.assert_error(route.prepare_round(body, self.user), "CHICKEN_ROAD_WALLET_RECONCILIATION_REQUIRED")
            receipt = await route.operation_receipt(body.operation_id, self.user)
            self.assertEqual(receipt["status"], "REJECTED")
            self.assertEqual(receipt["error"]["code"], "CHICKEN_ROAD_WALLET_RECONCILIATION_REQUIRED")
            self.assertEqual(await self.balance(), before["users"][0]["chip_balance"])
            self.assertEqual(await self.events(), [])
            self.assertEqual(await self.db.wallet_accounts.count_documents({}), 0)
            self.assertEqual(await self.db.chicken_road_commitments.count_documents({}), 0)

    async def install_source_wallet(self, *, bonus=100):
        self._patch(patch.object(route, "_require_wallet_user", _REAL_REQUIRE_WALLET_USER))
        self._patch(patch.object(ledger, "_source_wallet_adapter", game_wallet.ADAPTER))
        self._patch(patch.object(finance, "GAME_WALLET_INTEGRATION_READY", True))
        self._patch(patch.object(finance, "_READY", True))
        await self.db.wallet_accounts.insert_one({
            "id": "wallet-1", "user_id": self.user["id"], "available_cash_chips": 100000 - bonus,
            "available_bonus_chips": bonus, "held_cash_chips": 0, "version": 1,
        })

    async def test_policy_wallet_can_open_and_settle_without_broad_financial_flags(self):
        # The production operator-rail cohort has its own reviewed readiness
        # path. The unrelated payments-v2 flags must not be needed for play.
        await self.install_source_wallet(bonus=0)
        await self.db.users.update_one({"id": self.user["id"]}, {"$set": {
            "bonus_policy_version": bonus_policy.POLICY_VERSION,
        }})
        with patch.object(finance, "_READY", False), \
                patch.object(bonus_policy, "_READY", True), \
                patch.dict(os.environ, {"CHAKRI_BONUS_POLICY_ENABLED": "true", "REAL_MONEY_ENABLED": "false",
                                        "FINANCIAL_GAME_WALLET_INTEGRATED": "false"}):
            self.assertFalse(game_wallet.legacy_integration_enabled())
            before = await self.db.snapshot()
            snapshot = await route.state(self.user)
            self.assertEqual(snapshot["mode"], "live")
            self.assertEqual(snapshot["balance"], 100000)
            self.assertTrue(snapshot["enabled"])
            self.assertEqual(await self.db.snapshot(), before)
            _, played = await self.start(amount=300)
            allocation = (await self.events(ledger.STAKE))[0]["funding_allocation"]
            self.assertEqual((allocation["cash_chips"], allocation["bonus_chips"]), (300, 0))
            cashed = await route.cashout(self.action_body(played), self.user)
            await self.assert_terminal_once(cashed)
            account = await self.db.wallet_accounts.find_one({"user_id": self.user["id"]})
            self.assertEqual(account["available_cash_chips"], await self.balance())
            self.assertEqual(account["available_bonus_chips"], 0)

    async def test_existing_legacy_wallet_reports_temporary_integration_outage(self):
        await self.install_source_wallet(bonus=0)
        with patch.object(bonus_policy, "_READY", True), \
                patch.dict(os.environ, {"CHAKRI_BONUS_POLICY_ENABLED": "true", "REAL_MONEY_ENABLED": "false"}):
            self.assertTrue(game_wallet.integration_enabled())
            self.assertFalse(game_wallet.legacy_integration_enabled())
            self.assertFalse(await bonus_policy.user_participates(self.user["id"]))
            before = await self.db.snapshot()
            await self.assert_error(route.state(self.user), "CHICKEN_ROAD_WALLET_UNAVAILABLE", 503)
            self.assertEqual(await self.db.snapshot(), before)

    async def test_legacy_wallet_cashout_retry_recovers_after_integration_outage(self):
        await self.install_source_wallet(bonus=0)
        _, played = await self.start(amount=300)
        body = self.action_body(played)
        with patch.object(bonus_policy, "_READY", True), \
                patch.dict(os.environ, {"CHAKRI_BONUS_POLICY_ENABLED": "true", "REAL_MONEY_ENABLED": "false"}):
            before = await self.db.snapshot()
            await self.assert_error(route.cashout(body, self.user), "CHICKEN_ROAD_WALLET_UNAVAILABLE", 503)
            self.assertEqual(await self.db.snapshot(), before)
            self.assertFalse((await route.operation_receipt(body.operation_id, self.user))["found"])
        self.assertTrue(game_wallet.legacy_integration_enabled())
        cashed = await route.cashout(body, self.user)
        self.assertEqual(await route.cashout(body, self.user), cashed)
        await self.assert_terminal_once(cashed)
        self.assertEqual(len(await self.events(ledger.PAYOUT)), 1)
        account = await self.db.wallet_accounts.find_one({"user_id": self.user["id"]})
        self.assertEqual(account["available_cash_chips"], await self.balance())
        self.assertEqual(account["available_bonus_chips"], 0)

    async def test_real_source_wallet_preserves_cash_bonus_provenance_and_single_observer_delivery(self):
        await self.install_source_wallet(bonus=100)
        _, played = await self.start(amount=300)
        stake = (await self.events(ledger.STAKE))[0]
        self.assertEqual(stake["funding_allocation"]["cash_chips"], 200)
        self.assertEqual(stake["funding_allocation"]["bonus_chips"], 100)
        self.assertEqual(sum(lot["chips"] for lot in stake["funding_allocation"]["bonus_lots"]), 100)
        body = self.action_body(played)
        cashed = await route.cashout(body, self.user)
        self.assertEqual(await route.cashout(body, self.user), cashed)
        payout = (await self.events(ledger.PAYOUT))[0]
        self.assertEqual(payout["source_refs"], [played["round"]["id"]])
        self.assertEqual(payout["funding_allocation"]["cash_chips"], 224)
        self.assertEqual(payout["funding_allocation"]["bonus_chips"], 112)
        wallet = await self.db.wallet_accounts.find_one({"user_id": self.user["id"]})
        self.assertEqual((wallet["available_cash_chips"], wallet["available_bonus_chips"]), (99924, 112))
        self.assertEqual(wallet["available_cash_chips"] + wallet["available_bonus_chips"], await self.balance())
        self.assertEqual(await self.db.wallet_source_consumptions.count_documents({}), 1)
        await self.assert_terminal_once(cashed)

    async def test_source_wallet_changes_also_roll_back_if_terminal_receipt_fails(self):
        await self.install_source_wallet(bonus=100)
        _, played = await self.start()
        body = self.action_body(played)
        before = await self.db.snapshot()
        self.db.fail_once("chicken_road_operations", "insert_one")
        with self.assertRaisesRegex(RuntimeError, "injected"):
            await route.cashout(body, self.user)
        self.assertEqual(await self.db.snapshot(), before)
        cashed = await route.cashout(body, self.user)
        await self.assert_terminal_once(cashed)
        self.assertEqual(await self.db.wallet_source_consumptions.count_documents({}), 1)


class RequestAndPublicationTests(unittest.TestCase):
    def test_server_registration_order_matches_specific_state_before_generic(self):
        """Exercise actual registration order without importing server/lifespan.

        The generic endpoint is a nonexecuted sentinel at its source-declared
        path. The Chicken Road router is real. Starlette's ordered matcher
        therefore reproduces the production overlap without any handler, auth,
        database, or startup side effects.
        """
        server_tree = ast.parse(Path(__file__).with_name("server.py").read_text())
        live_tree = ast.parse(Path(__file__).with_name("routes_live.py").read_text())
        state_node = next(node for node in live_tree.body if isinstance(node, ast.AsyncFunctionDef) and node.name == "live_state")
        state_path = next(ast.literal_eval(decorator.args[0]) for decorator in state_node.decorator_list
                          if isinstance(decorator, ast.Call) and ast.unparse(decorator.func) == "router.get")
        live_router_assignment = next(node for node in live_tree.body if isinstance(node, ast.Assign)
                                      and any(isinstance(target, ast.Name) and target.id == "router" for target in node.targets))
        live_namespace = {"APIRouter": APIRouter}
        exec(compile(ast.Module(body=[live_router_assignment], type_ignores=[]), "routes_live.py:router", "exec"), live_namespace)

        async def generic_live_state(slug: str):
            raise AssertionError("Routing regression must not execute handlers")

        generic_router = live_namespace["router"]
        generic_router.add_api_route(state_path, generic_live_state, methods=["GET"])
        router_names = {"routes_auth.router", "routes_chicken_road.router", "routes_live.router"}

        def relevant_registrations(nodes):
            selected = []
            for node in nodes:
                if (isinstance(node, ast.Expr) and isinstance(node.value, ast.Call)
                        and ast.unparse(node.value.func) == "api_router.include_router"
                        and node.value.args and ast.unparse(node.value.args[0]) in router_names):
                    selected.append(copy.deepcopy(node))
                elif isinstance(node, ast.If):
                    body, otherwise = relevant_registrations(node.body), relevant_registrations(node.orelse)
                    if body or otherwise:
                        selected.append(ast.If(test=copy.deepcopy(node.test), body=body or [ast.Pass()], orelse=otherwise))
            return selected

        registrations = relevant_registrations(server_tree.body)
        self.assertEqual(sum(isinstance(node, ast.Call) for statement in registrations for node in ast.walk(statement)), 3)
        api_assignment = next(node for node in server_tree.body if isinstance(node, ast.Assign)
                              and any(isinstance(target, ast.Name) and target.id == "api_router" for target in node.targets))
        assembly = ast.fix_missing_locations(ast.Module(body=[copy.deepcopy(api_assignment), *registrations], type_ignores=[]))
        scope = {"type": "http", "path": "/api/live/chicken-road/state", "method": "GET", "root_path": ""}
        for approved in (False, True):
            with self.subTest(approved=approved):
                namespace = {"APIRouter": APIRouter,
                             "routes_auth": types.SimpleNamespace(router=APIRouter()),
                             "routes_live": types.SimpleNamespace(router=generic_router),
                             "routes_chicken_road": types.SimpleNamespace(RULES_APPROVED=approved, router=route.router)}
                exec(compile(assembly, "server.py:router-registration", "exec"), namespace)
                app = FastAPI()
                app.include_router(namespace["api_router"])
                matches = [entry for entry in app.routes if entry.matches(scope)[0] == Match.FULL]
                self.assertEqual(len(matches), 2 if approved else 1)
                self.assertIs(matches[0].endpoint, route.state if approved else generic_live_state)
                if approved:
                    self.assertIs(matches[1].endpoint, generic_live_state)
                else:
                    self.assertFalse(any(entry.endpoint is route.state for entry in app.routes))

    def test_request_models_enforce_strict_types_bounds_and_unknown_fields(self):
        valid = {
            "operation_id": "play-operation", "commitment_id": "commitment-1", "client_seed": "a" * 64,
            "difficulty": "medium", "amount": 300, "rules_version": engine.RULES_VERSION,
        }
        invalid = {
            "operation_id": ("", "short", "a" * 129, "contains space", 123),
            "commitment_id": ("", "a" * 129, 123),
            "client_seed": ("", "A" * 64, "f" * 63, "f" * 65, "g" * 64, "f" * 64 + "\n"),
            "difficulty": ("Medium", "expert", "", None),
            "amount": (True, False, "300", 300.0, 0, 99, 101, 1001, None),
            "rules_version": ("", "a" * 81, 123),
        }
        for name, values in invalid.items():
            for value in values:
                with self.subTest(name=name, value=value), self.assertRaises(ValidationError):
                    route.PlayRequest(**{**valid, name: value})
        with self.assertRaises(ValidationError):
            route.PlayRequest(**valid, payout=99999)
        for stake in range(100, 1001, 100):
            self.assertEqual(route.PlayRequest(**{**valid, "amount": stake}).amount, stake)
        for version in (True, 1.0, "1", 0, 14):
            with self.assertRaises(ValidationError):
                route.RoundRequest(operation_id="round-action", round_id="round-1", expected_version=version)

    def test_rules_and_catalogue_are_reviewed_but_intake_and_exposure_remain_explicit(self):
        self.assertTrue(_INITIAL_RULES_APPROVED)
        with patch.dict(os.environ, {}, clear=True):
            self.assertFalse(route._live_enabled())
            with self.assertRaises(HTTPException) as missing:
                route._exposure_limit()
            self.assertEqual(missing.exception.detail["code"], "CHICKEN_ROAD_EXPOSURE_UNAVAILABLE")
        self.assertTrue(game_access.is_reviewed_game(route.SLUG))
        self.assertEqual(game_access.project_catalogue_game({"slug": route.SLUG, "status": "ENABLED"})["status"], "ENABLED")
        self.assertEqual(game_access.project_catalogue_game({"slug": route.SLUG, "status": "COMING_SOON"})["status"], "COMING_SOON")
        self.assertIsNone(game_access.assert_admin_status_change_allowed(route.SLUG, "ENABLED"))
        tree = ast.parse(Path(__file__).with_name("server.py").read_text())
        parents = {child: parent for parent in ast.walk(tree) for child in ast.iter_child_nodes(parent)}

        def approval_test(node):
            return isinstance(node, ast.Attribute) and node.attr == "RULES_APPROVED" and isinstance(node.value, ast.Name) and node.value.id == "routes_chicken_road"

        protected_calls = []
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            name = ast.unparse(node.func)
            if (name == "routes_chicken_road.prepare_chicken_road_storage"
                    or name == "_chicken_road_settlement_worker"
                    or (name.endswith(".include_router") and node.args and ast.unparse(node.args[0]) == "routes_chicken_road.router")):
                protected_calls.append(node)
                child, parent = node, parents.get(node)
                guarded = False
                while parent is not None:
                    if isinstance(parent, ast.If) and approval_test(parent.test) and child in parent.body:
                        guarded = True
                    if isinstance(parent, ast.IfExp) and approval_test(parent.test) and child is parent.body:
                        guarded = True
                    child, parent = parent, parents.get(parent)
                self.assertTrue(guarded, f"Ungated Chicken Road activation: {name}")
        self.assertEqual(len(protected_calls), 3)


class RealTransactionBoundaryTests(unittest.IsolatedAsyncioTestCase):
    async def test_actual_runner_never_calls_callback_without_supported_transactions(self):
        for environment in ({"APP_ENV": "production", "FINANCIAL_ALLOW_NON_TRANSACTIONAL_TESTS": "true"},
                            {"APP_ENV": "test", "FINANCIAL_ALLOW_NON_TRANSACTIONAL_TESTS": "false"}):
            for failure in (NotImplementedError("no sessions"), OperationFailure("transaction numbers are only allowed", code=20)):
                client = types.SimpleNamespace(start_session=AsyncMock(side_effect=failure))
                callback = AsyncMock()
                with patch.dict(os.environ, environment), self.assertRaises(HTTPException) as caught:
                    await _REAL_TRANSACTION_RUNNER(client, callback)
                self.assertEqual(caught.exception.status_code, 503)
                self.assertEqual(caught.exception.detail["code"], "GAME_TRANSACTIONS_UNAVAILABLE")
                callback.assert_not_awaited()

    async def test_actual_runner_does_not_fall_back_after_transaction_callback_started(self):
        for failure in (NotImplementedError("late unsupported transaction"), OperationFailure("transactions are not supported", code=20)):
            class Session:
                async def __aenter__(self):
                    return self

                async def __aexit__(self, *args):
                    return False

                async def with_transaction(self, callback):
                    await callback(self)
                    raise failure

            session = Session()
            client = types.SimpleNamespace(start_session=AsyncMock(return_value=session))
            callback = AsyncMock()
            with patch.dict(os.environ, {"APP_ENV": "test", "FINANCIAL_ALLOW_NON_TRANSACTIONAL_TESTS": "true"}), self.assertRaises(HTTPException) as caught:
                await _REAL_TRANSACTION_RUNNER(client, callback)
            self.assertEqual(caught.exception.detail["code"], "GAME_TRANSACTIONS_UNAVAILABLE")
            callback.assert_awaited_once_with(session)


if __name__ == "__main__":
    unittest.main()
