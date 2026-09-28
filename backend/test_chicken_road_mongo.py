"""Opt-in integration checks against a disposable, loopback Mongo replica set.

Run with CHICKEN_ROAD_LOCAL_MONGO_TESTS=1 and CHICKEN_ROAD_TEST_MONGO_URI set to
mongodb://127.0.0.1:<port>/?replicaSet=chicken-road-test-<unique-suffix>.
The URI must have no credentials/database/other options. The server must report
exactly that one loopback member. Each test owns and drops a new random database.
Without both opt-ins this module skips before importing any application module.

Routes, HMAC outcomes, ledger, source wallet, compliance, and the production
transaction runner are real. Only the local release configuration, deterministic
seed/clock fixtures, and a transactional observer are installed. Timing barriers
do not serialize mutations or replace Mongo sessions. No HTTP server, background
worker, notification sender, or payment provider is started.
"""
from __future__ import annotations

import asyncio
import copy
from datetime import datetime, timedelta, timezone
import hashlib
import os
import re
import sys
import types
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit
import uuid

import pytest


_URI = os.environ.get("CHICKEN_ROAD_TEST_MONGO_URI", "")
if os.environ.get("CHICKEN_ROAD_LOCAL_MONGO_TESTS") != "1" or not _URI:
    pytest.skip("Local replica-set tests require explicit opt-in and a test URI", allow_module_level=True)


def _validate_local_uri(uri):
    parsed = urlsplit(uri)
    options = parse_qs(parsed.query, strict_parsing=True)
    if (parsed.scheme != "mongodb" or not re.fullmatch(r"127\.0\.0\.1:[0-9]+", parsed.netloc)
            or parsed.path not in {"", "/"} or parsed.fragment
            or set(options) != {"replicaSet"} or len(options["replicaSet"]) != 1
            or not re.fullmatch(r"chicken-road-test-[A-Za-z0-9_-]+", options["replicaSet"][0])
            or not 1024 <= parsed.port <= 65535):
        raise ValueError("Only a credential-free disposable loopback replica-set URI is allowed")
    return parsed.netloc, options["replicaSet"][0]


_HOST, _REPLICA_SET = _validate_local_uri(_URI)

from fastapi import HTTPException  # noqa: E402
from motor.motor_asyncio import AsyncIOMotorClient  # noqa: E402

# Never import db.py: it loads a .env file and could construct a real client.
_ORIGINAL_DB_MODULE = sys.modules.get("db")
sys.modules["db"] = types.SimpleNamespace(db=None, client=None, serialize_doc=lambda value: value)
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


class ChickenRoadMongoTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.client = AsyncIOMotorClient(
            _URI, serverSelectionTimeoutMS=5000, connectTimeoutMS=5000,
            socketTimeoutMS=15000, appname="chicken-road-local-integration-test",
        )
        self.addCleanup(self.client.close)
        hello = await self.client.admin.command("hello")
        self.assertEqual(hello.get("setName"), _REPLICA_SET)
        self.assertEqual(hello.get("hosts"), [_HOST])
        self.assertTrue(hello.get("isWritablePrimary"))
        self.assertFalse(hello.get("passives") or hello.get("arbiters"))
        self.database_name = f"chicken_road_mongo_test_{uuid.uuid4().hex}"
        self.db = self.client[self.database_name]
        self.addAsyncCleanup(self._drop_owned_database)
        self.clock = datetime(2026, 9, 28, 12, tzinfo=timezone.utc)
        self._patch(patch.dict(os.environ, {
            "APP_ENV": "test", "CHICKEN_ROAD_LIVE_ENABLED": "true",
            "CHICKEN_ROAD_EXPOSURE_LIMIT": "194620",
            "FINANCIAL_ALLOW_NON_TRANSACTIONAL_TESTS": "false",
            "REAL_MONEY_ENABLED": "false", "DEPOSITS_ENABLED": "false",
            "WITHDRAWALS_ENABLED": "false", "AUTO_WITHDRAWALS_ENABLED": "false",
            "CHAKRI_BONUS_POLICY_ENABLED": "true", "OTP_EMAIL_ADAPTER": "disabled",
            "OTP_SMS_ADAPTER": "disabled", "EMAIL_PROVIDER": "disabled",
        }, clear=True))
        for module in (route, ledger, auth_utils, compliance, finance, game_wallet, bonus_policy, game_access):
            self._patch(patch.object(module, "db", self.db))
        self._patch(patch.object(route, "client", self.client))
        self._patch(patch.object(route, "RULES_APPROVED", True))
        self._patch(patch.object(route, "_STORAGE_READY", False))
        self._patch(patch.object(route, "run_game_transaction", transactions.run_game_transaction))
        self._patch(patch.object(route, "_now", side_effect=lambda: self.clock))
        self._patch(patch.object(game_access, "PLAYABLE_GAME_SLUGS", game_access.PLAYABLE_GAME_SLUGS | {route.SLUG}))
        self._patch(patch.object(ledger, "_source_wallet_adapter", game_wallet.ADAPTER))
        self._patch(patch.object(ledger, "_stake_guards", [compliance._stake_guard]))
        self._patch(patch.object(ledger, "_ledger_observers", [self._observe]))
        self._patch(patch.object(bonus_policy, "_READY", False))
        # These are the real index/preparation functions, against this test DB.
        await finance.ensure_financial_indexes()
        await bonus_policy.prepare()
        await route.prepare_chicken_road_storage()
        await self.db.users.create_index("id", unique=True)
        await self.db.games.insert_one({"slug": route.SLUG, "name": "Chicken Road", "status": "ENABLED"})
        # Pre-create collections that otherwise first appear inside transactions.
        for name in ("chicken_road_players", "game_rounds", "test_observed_events"):
            if name not in await self.db.list_collection_names():
                await self.db.create_collection(name)
        self.user = await self._player("player-1")
        self.assertTrue(game_wallet.integration_enabled())
        self.assertFalse(game_wallet.legacy_integration_enabled())

    def _patch(self, patcher):
        value = patcher.start()
        self.addCleanup(patcher.stop)
        return value

    async def _drop_owned_database(self):
        if not re.fullmatch(r"chicken_road_mongo_test_[0-9a-f]{32}", self.database_name):
            raise RuntimeError("Refusing to drop a database not created by this test")
        await self.client.drop_database(self.database_name)

    async def _player(self, user_id):
        user = {
            "id": user_id, "role": "PLAYER", "status": "ACTIVE",
            "active_session_id": f"session-{user_id}", "chip_balance": 100000,
            "accepted_terms": True, "age_verified": True, "kyc_status": "VERIFIED",
            "country": "IN", "financial_status": "ACTIVE", "deleted_at": None,
            "bonus_policy_version": bonus_policy.POLICY_VERSION,
        }
        await self.db.users.insert_one(copy.deepcopy(user))
        await self.db.wallet_accounts.insert_one({
            "id": f"wallet-{user_id}", "user_id": user_id,
            "available_cash_chips": 99900, "available_bonus_chips": 100,
            "held_cash_chips": 0, "version": 1,
        })
        # Exercise the real restricted-bonus provenance migration in a transaction.
        async def initialize(session):
            await finance._ensure_wallet_account(user_id, session=session)
        await transactions.run_game_transaction(self.client, initialize)
        return user

    async def _observe(self, event, session=None):
        self.assertIsNotNone(session)
        self.assertTrue(session.in_transaction)
        await self.db.test_observed_events.insert_one({"_id": event["id"], "event": copy.deepcopy(event)}, session=session)

    @staticmethod
    def _key():
        return str(uuid.uuid4())

    async def _play_body(self, *, user=None, difficulty="medium", amount=300, outcomes=(True, True)):
        user = user or self.user
        nonce = self._key()
        client_seed = "f" * 64
        # Select reproducible fixtures without mocking the actual HMAC engine.
        for attempt in range(100000):
            server_seed = hashlib.sha256(f"local-fixture:{nonce}:{attempt}".encode()).hexdigest()
            if all(engine.lane_survives(server_seed, client_seed, nonce, difficulty, lane) == survives
                   for lane, survives in enumerate(outcomes, 1)):
                break
        else:
            self.fail("Could not construct a deterministic local outcome fixture")
        with patch.object(route, "uuid", types.SimpleNamespace(uuid4=lambda: nonce)), \
                patch.object(route.secrets, "token_hex", return_value=server_seed):
            prepared = await route.prepare_round(route.OperationRequest(operation_id=self._key()), user)
        return route.PlayRequest(
            operation_id=self._key(), commitment_id=prepared["commitment_id"], client_seed=client_seed,
            difficulty=difficulty, amount=amount, rules_version=engine.RULES_VERSION,
        )

    async def _start(self, **kwargs):
        body = await self._play_body(**kwargs)
        return body, await route.play(body, kwargs.get("user") or self.user)

    def _action(self, played):
        return route.RoundRequest(operation_id=self._key(), round_id=played["round"]["id"], expected_version=played["round"]["version"])

    def _rendezvous(self, method, participants=2):
        """Make real sessions overlap once; retrying transactions never wait again."""
        original = getattr(route, method)
        arrived = set()
        release = asyncio.Event()

        async def synchronized(*args, **kwargs):
            result = await original(*args, **kwargs) if method == "_receipt" else None
            task = asyncio.current_task()
            if task not in arrived and len(arrived) < participants:
                arrived.add(task)
                if len(arrived) == participants:
                    release.set()
                await asyncio.wait_for(release.wait(), timeout=10)
            return result if method == "_receipt" else await original(*args, **kwargs)

        return patch.object(route, method, synchronized)

    async def _race(self, *calls):
        return await asyncio.wait_for(asyncio.gather(*calls, return_exceptions=True), timeout=40)

    async def _assert_wallet(self, user=None):
        user = user or self.user
        stored = await self.db.users.find_one({"id": user["id"]})
        wallet = await self.db.wallet_accounts.find_one({"user_id": user["id"]})
        self.assertEqual(stored["chip_balance"], wallet["available_cash_chips"] + wallet["available_bonus_chips"])
        lots = await self.db.wallet_bonus_lots.find({"user_id": user["id"]}).to_list(None)
        self.assertEqual(wallet["available_bonus_chips"], sum(row["remaining_chips"] for row in lots))
        entries = await self.db.wallet_entries.find({}).to_list(None)
        for operation in {row["operation_id"] for row in entries}:
            self.assertEqual(sum(row["delta_chips"] for row in entries if row["operation_id"] == operation), 0)
        return stored, wallet

    async def _assert_terminal(self, round_id, *, user=None):
        user = user or self.user
        current = await self.db.chicken_road_rounds.find_one({"_id": round_id})
        self.assertIn(current["status"], {"CASHED", "CRASHED"})
        self.assertEqual(await self.db.chip_transactions.count_documents({"ref": round_id, "kind": ledger.STAKE}), 1)
        self.assertEqual(await self.db.chip_transactions.count_documents({"ref": round_id, "kind": ledger.SETTLEMENT}), 1)
        self.assertEqual(await self.db.chip_transactions.count_documents({"ref": round_id, "kind": ledger.PAYOUT}), int(current["payout"] > 0))
        self.assertEqual(await self.db.game_rounds.count_documents({"id": round_id}), 1)
        self.assertEqual(await self.db.wallet_source_consumptions.count_documents({"stake_ref": round_id}), int(current["payout"] > 0))
        stake = await self.db.chip_transactions.find_one({"ref": round_id, "kind": ledger.STAKE})
        if current["payout"]:
            payout = await self.db.chip_transactions.find_one({"ref": round_id, "kind": ledger.PAYOUT})
            expected_cash = current["payout"] * stake["funding_allocation"]["cash_chips"] // current["amount"]
            self.assertEqual(payout["funding_allocation"]["cash_chips"], expected_cash)
            self.assertEqual(payout["funding_allocation"]["bonus_chips"], current["payout"] - expected_cash)
        self.assertIsNone((await self.db.chicken_road_players.find_one({"_id": user["id"]}))["active_round_id"])
        self.assertEqual((await self.db.chicken_road_exposure.find_one({"_id": route.SLUG}))["outstanding_chips"], 0)
        events = await self.db.chip_transactions.find({"ref": round_id}).to_list(None)
        self.assertEqual(await self.db.test_observed_events.count_documents({"event.ref": round_id}), len(events))
        stored, _ = await self._assert_wallet(user)
        self.assertEqual(stored["chip_balance"], 100000 - current["amount"] + current["payout"])
        self.assertEqual(await self.db.financial_outbox.count_documents({}), 0)
        return current

    async def _snapshot(self):
        return {name: await self.db[name].find({}).sort("_id", 1).to_list(None)
                for name in sorted(await self.db.list_collection_names())}

    async def test_concurrent_identical_play_debits_once_and_replays_receipt(self):
        body = await self._play_body()
        with self._rendezvous("_receipt"):
            results = await self._race(route.play(body, self.user), route.play(body, self.user))
        self.assertTrue(all(isinstance(result, dict) for result in results), results)
        self.assertEqual(results[0], results[1])
        self.assertEqual(await self.db.chicken_road_rounds.count_documents({}), 1)
        self.assertEqual(await self.db.chip_transactions.count_documents({"kind": ledger.STAKE}), 1)
        self.assertEqual(await self.db.wallet_operations.count_documents({"kind": "GAME_STAKE"}), 1)
        receipt = await route.operation_receipt(body.operation_id, self.user)
        self.assertEqual(receipt, {"found": True, **results[0]})
        stake = await self.db.chip_transactions.find_one({"kind": ledger.STAKE})
        self.assertEqual((stake["funding_allocation"]["cash_chips"], stake["funding_allocation"]["bonus_chips"]), (200, 100))
        await route.cashout(self._action(results[0]), self.user)
        await self._assert_terminal(results[0]["round"]["id"])

    async def test_go_and_cashout_compete_for_one_version(self):
        _, played = await self._start()
        go, cashout = self._action(played), self._action(played)
        with self._rendezvous("_receipt"):
            results = await self._race(route.go(go, self.user), route.cashout(cashout, self.user))
        accepted = [row for row in results if isinstance(row, dict)]
        errors = [row for row in results if isinstance(row, HTTPException)]
        self.assertEqual((len(accepted), len(errors)), (1, 1), results)
        self.assertIn(errors[0].detail["code"], {"ROUND_VERSION_CONFLICT", "ROUND_FINISHED"})
        current = accepted[0]
        if current["round"]["status"] == "PLAYING":
            current = await route.cashout(self._action(current), self.user)
        terminal = await self._assert_terminal(played["round"]["id"])
        self.assertIn(terminal["payout"], {336, 384})

    async def test_expiry_and_go_settle_exactly_once(self):
        _, played = await self._start()
        self.clock += timedelta(seconds=engine.EXPIRY_SECONDS + 1)
        with self._rendezvous("_transition"):
            results = await self._race(route.settle_expired_chicken_rounds(), route.go(self._action(played), self.user))
        for result in results:
            if isinstance(result, BaseException):
                self.assertIsInstance(result, HTTPException)
                self.assertIn(result.detail["code"], {"ROUND_VERSION_CONFLICT", "ROUND_FINISHED"})
        terminal = await self._assert_terminal(played["round"]["id"])
        self.assertEqual((terminal["reason"], terminal["lane"], terminal["payout"]), ("INACTIVITY", 1, 336))
        self.assertEqual(await route.settle_expired_chicken_rounds(), 0)

    async def test_two_players_cannot_oversubscribe_194620_exposure(self):
        other = await self._player("player-2")
        first = await self._play_body(difficulty="hardcore", amount=1000)
        second = await self._play_body(user=other, difficulty="hardcore", amount=1000)
        with self._rendezvous("_receipt"):
            results = await self._race(route.play(first, self.user), route.play(second, other))
        accepted = [(index, row) for index, row in enumerate(results) if isinstance(row, dict)]
        errors = [row for row in results if isinstance(row, HTTPException)]
        self.assertEqual((len(accepted), len(errors)), (1, 1), results)
        self.assertEqual(errors[0].detail["code"], "EXPOSURE_LIMIT")
        self.assertEqual((await self.db.chicken_road_exposure.find_one({"_id": route.SLUG}))["outstanding_chips"], 194620)
        self.assertEqual(await self.db.chip_transactions.count_documents({"kind": ledger.STAKE}), 1)
        index, played = accepted[0]
        winner = (self.user, other)[index]
        loser = (other, self.user)[index]
        loser_body = (second, first)[index]
        self.assertEqual((await route.operation_receipt(loser_body.operation_id, loser))["error"]["code"], "EXPOSURE_LIMIT")
        self.assertEqual((await self._assert_wallet(loser))[0]["chip_balance"], 100000)
        await route.cashout(self._action(played), winner)
        await self._assert_terminal(played["round"]["id"], user=winner)

    async def test_collision_records_loss_and_releases_exposure(self):
        body, played = await self._start(outcomes=(True, False))
        crashed = await route.go(self._action(played), self.user)
        self.assertEqual(crashed["result"], "crashed")
        terminal = await self._assert_terminal(crashed["round"]["id"])
        self.assertEqual((terminal["reason"], terminal["payout"]), ("COLLISION", 0))
        self.assertEqual(await route.play(body, self.user), played)

    async def test_failure_after_real_debit_rolls_back_every_collection(self):
        body = await self._play_body()
        before = await self._snapshot()
        debit = ledger.debit_chips

        async def fail_after_debit(*args, **kwargs):
            await debit(*args, **kwargs)
            raise RuntimeError("injected after real stake debit")

        with patch.object(ledger, "debit_chips", fail_after_debit):
            with self.assertRaisesRegex(RuntimeError, "after real stake"):
                await route.play(body, self.user)
        self.assertEqual(await self._snapshot(), before)
        self.assertFalse((await route.operation_receipt(body.operation_id, self.user))["found"])
        played = await route.play(body, self.user)
        await route.cashout(self._action(played), self.user)
        await self._assert_terminal(played["round"]["id"])

    async def test_failure_after_terminal_mutation_rolls_back_payout_and_observers(self):
        _, played = await self._start()
        action = self._action(played)
        before = await self._snapshot()
        finish = route._finish

        async def fail_after_finish(*args, **kwargs):
            await finish(*args, **kwargs)
            raise RuntimeError("injected after terminal mutation")

        with patch.object(route, "_finish", fail_after_finish):
            with self.assertRaisesRegex(RuntimeError, "after terminal mutation"):
                await route.cashout(action, self.user)
        self.assertEqual(await self._snapshot(), before)
        self.assertFalse((await route.operation_receipt(action.operation_id, self.user))["found"])
        await route.cashout(action, self.user)
        await self._assert_terminal(played["round"]["id"])

    async def test_failure_after_receipt_insert_rolls_back_entire_settlement(self):
        _, played = await self._start()
        action = self._action(played)
        before = await self._snapshot()
        store = route._store_receipt

        async def fail_after_receipt(*args, **kwargs):
            await store(*args, **kwargs)
            raise RuntimeError("injected after receipt insert")

        with patch.object(route, "_store_receipt", fail_after_receipt):
            with self.assertRaisesRegex(RuntimeError, "after receipt insert"):
                await route.cashout(action, self.user)
        self.assertEqual(await self._snapshot(), before)
        self.assertFalse((await route.operation_receipt(action.operation_id, self.user))["found"])
        cashed = await route.cashout(action, self.user)
        self.assertEqual(await route.cashout(action, self.user), cashed)
        await self._assert_terminal(played["round"]["id"])


if __name__ == "__main__":
    unittest.main()
