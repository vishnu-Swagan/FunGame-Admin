"""Focused fault/concurrency checks for balance-coupled live game mutations.

Run as a script so the mock ``db`` module is installed before route imports.
No network, production database, or real payment provider is used.
"""
from __future__ import annotations

import asyncio
import copy
import os
import sys
import types
import unittest

from fastapi import HTTPException
from mongomock_motor import AsyncMongoMockClient
from pymongo.errors import ConfigurationError, DuplicateKeyError, OperationFailure


HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

mock_client = AsyncMongoMockClient()
database = mock_client["game_transaction_test"]
sys.modules["db"] = types.SimpleNamespace(
    db=database,
    client=mock_client,
    serialize_doc=lambda value: value,
)

import ledger  # noqa: E402
import routes_games as roulette  # noqa: E402
import routes_live as live  # noqa: E402
import transactions  # noqa: E402


MUTATED_COLLECTIONS = (
    "users",
    "chip_transactions",
    "live_bets",
    "live_outcomes",
    "roulette_bets",
    "roulette_rounds",
    "game_rounds",
)


async def _allow_game(slug):
    return {"slug": slug, "name": slug}


class SnapshotTransactionRunner:
    """Serialize callbacks and restore the mock database when one raises.

    mongomock deliberately has no Mongo session implementation. This small
    test double models the two properties these tests need to assert at the
    route boundary: rollback on failure and serialization of concurrent
    settlement attempts.
    """

    def __init__(self, test_db):
        self.db = test_db
        self.lock = asyncio.Lock()

    async def __call__(self, _client, callback):
        async with self.lock:
            snapshots = {}
            for name in MUTATED_COLLECTIONS:
                snapshots[name] = copy.deepcopy(
                    await self.db[name].find({}).to_list(length=None)
                )
            try:
                return await callback(None)
            except BaseException:
                for name, documents in snapshots.items():
                    collection = self.db[name]
                    await collection.delete_many({})
                    if documents:
                        await collection.insert_many(copy.deepcopy(documents))
                raise


class FailLedgerWriteOnce:
    """Fail after the balance update but before its ledger row is inserted."""

    def __init__(self, original):
        self.original = original
        self.failed = False

    async def __call__(self, *args, **kwargs):
        if not self.failed:
            self.failed = True
            raise RuntimeError("injected ledger write failure")
        return await self.original(*args, **kwargs)


class GameTransactionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        for name in MUTATED_COLLECTIONS:
            await database[name].delete_many({})
        live._OUTCOME_CACHE.clear()

        self.runner = SnapshotTransactionRunner(database)
        self.original_live_runner = live.run_game_transaction
        self.original_roulette_runner = roulette.run_game_transaction
        self.original_live_access = live.require_playable_game
        self.original_roulette_access = roulette.require_playable_game
        self.original_live_guard = live._require_live_betting
        self.original_roulette_guard = roulette._require_roulette_betting
        self.original_ledger_write = ledger._write
        self.original_stake_guards = list(ledger._stake_guards)
        ledger._stake_guards.clear()

        live.db = database
        live.client = mock_client
        roulette.db = database
        roulette.client = mock_client
        ledger.db = database
        live.run_game_transaction = self.runner
        roulette.run_game_transaction = self.runner
        live.require_playable_game = _allow_game
        roulette.require_playable_game = _allow_game
        live._require_live_betting = (
            lambda slug, expected_round=None, message=None: (42, 20.0)
        )
        roulette._require_roulette_betting = (
            lambda expected_round=None, message=None: (42, 20.0)
        )
        await database.users.insert_one({"id": "player", "chip_balance": 10_000_000})

    async def asyncTearDown(self):
        live.run_game_transaction = self.original_live_runner
        roulette.run_game_transaction = self.original_roulette_runner
        live.require_playable_game = self.original_live_access
        roulette.require_playable_game = self.original_roulette_access
        live._require_live_betting = self.original_live_guard
        roulette._require_roulette_betting = self.original_roulette_guard
        ledger._write = self.original_ledger_write
        ledger._stake_guards[:] = self.original_stake_guards

    async def _balance(self):
        user = await database.users.find_one({"id": "player"})
        return user["chip_balance"]

    async def test_live_place_rolls_back_then_retry_debits_exactly_once(self):
        ledger._write = FailLedgerWriteOnce(self.original_ledger_write)
        body = live.LiveBet(amount=10, selection="down")

        with self.assertRaisesRegex(RuntimeError, "injected"):
            await live.live_place_bet("seven-up-down", body, {"id": "player"})
        self.assertEqual(await self._balance(), 10_000_000)
        self.assertEqual(await database.live_bets.count_documents({}), 0)
        self.assertEqual(await database.chip_transactions.count_documents({}), 0)

        result = await live.live_place_bet("seven-up-down", body, {"id": "player"})
        self.assertEqual(result["balance"], 9_999_990)
        self.assertEqual(await database.live_bets.count_documents({"status": "OPEN"}), 1)
        self.assertEqual(
            await database.chip_transactions.count_documents({"kind": ledger.STAKE}), 1
        )

    async def test_live_clear_rolls_back_then_refunds_every_open_bet(self):
        await database.users.update_one(
            {"id": "player"}, {"$set": {"chip_balance": 9_997_950}}
        )
        await database.live_bets.insert_many([
            {
                "id": f"live-{index}", "user_id": "player", "slug": "seven-up-down",
                "round_number": 42, "selection": "down", "amount": 10,
                "status": "OPEN", "created_at": f"2026-01-01T00:00:{index:03d}Z",
            }
            for index in range(205)
        ])
        ledger._write = FailLedgerWriteOnce(self.original_ledger_write)

        with self.assertRaisesRegex(RuntimeError, "injected"):
            await live.live_clear_bets("seven-up-down", {"id": "player"})
        self.assertEqual(await self._balance(), 9_997_950)
        self.assertEqual(await database.live_bets.count_documents({"status": "OPEN"}), 205)

        result = await live.live_clear_bets("seven-up-down", {"id": "player"})
        self.assertEqual(result["refunded"], 2050)
        self.assertEqual(await self._balance(), 10_000_000)
        self.assertEqual(await database.live_bets.count_documents({"status": "REFUNDED"}), 205)
        refunds = await database.chip_transactions.find({"kind": ledger.REFUND}).to_list(None)
        self.assertEqual([row["amount"] for row in refunds], [2050])

    async def test_live_settlement_failure_rolls_back_and_retry_is_idempotent(self):
        await database.users.update_one(
            {"id": "player"}, {"$set": {"chip_balance": 0}}
        )
        await database.live_bets.insert_many([
            {
                "id": f"settle-{index}", "user_id": "player", "slug": "seven-up-down",
                "round_number": 41, "selection": "down", "amount": 10,
                "status": "OPEN", "created_at": "2026-01-01T00:00:00Z",
            }
            for index in range(3)
        ])
        outcome = {"dice": [1, 1], "total": 2, "winner": "down"}
        await database.live_outcomes.insert_one({
            "slug": "seven-up-down", "round_number": 41, "outcome": outcome
        })
        ledger._write = FailLedgerWriteOnce(self.original_ledger_write)

        with self.assertRaisesRegex(RuntimeError, "injected"):
            await live._live_settle_user("player", "seven-up-down", 42, "BETTING")
        self.assertEqual(await self._balance(), 0)
        self.assertEqual(await database.live_bets.count_documents({"status": "OPEN"}), 3)
        self.assertEqual(await database.game_rounds.count_documents({}), 0)

        first = await live._live_settle_user("player", "seven-up-down", 42, "BETTING")
        second = await live._live_settle_user("player", "seven-up-down", 42, "BETTING")
        self.assertEqual(first["payout"], 60)
        self.assertIsNone(second)
        self.assertEqual(await self._balance(), 60)
        self.assertEqual(await database.game_rounds.count_documents({}), 1)
        self.assertEqual(
            await database.chip_transactions.count_documents({"kind": ledger.PAYOUT}), 3
        )

    async def test_live_concurrent_settlement_includes_more_than_200_bets_once(self):
        await database.users.update_one(
            {"id": "player"}, {"$set": {"chip_balance": 0}}
        )
        await database.live_bets.insert_many([
            {
                "id": f"many-live-{index}", "user_id": "player",
                "slug": "seven-up-down", "round_number": 41,
                "selection": "down", "amount": 10, "status": "OPEN",
                "created_at": "2026-01-01T00:00:00Z",
            }
            for index in range(205)
        ])
        await database.live_outcomes.insert_one({
            "slug": "seven-up-down", "round_number": 41,
            "outcome": {"dice": [1, 1], "total": 2, "winner": "down"},
        })

        await asyncio.gather(
            live._live_settle_user("player", "seven-up-down", 42, "BETTING"),
            live._live_settle_user("player", "seven-up-down", 42, "BETTING"),
        )
        self.assertEqual(await database.live_bets.count_documents({"status": "SETTLED"}), 205)
        self.assertEqual(await self._balance(), 4100)
        history = await database.game_rounds.find({}).to_list(None)
        self.assertEqual(len(history), 1)
        self.assertEqual((history[0]["bet"], history[0]["payout"]), (2050, 4100))
        self.assertEqual(
            await database.chip_transactions.count_documents({"kind": ledger.PAYOUT}), 205
        )

    async def test_roulette_place_rolls_back_then_retry_debits_exactly_once(self):
        ledger._write = FailLedgerWriteOnce(self.original_ledger_write)
        body = roulette.RouletteBet(bet_type="color", value="red", amount=10)

        with self.assertRaisesRegex(RuntimeError, "injected"):
            await roulette.roulette_place_bet(body, {"id": "player"})
        self.assertEqual(await self._balance(), 10_000_000)
        self.assertEqual(await database.roulette_bets.count_documents({}), 0)

        result = await roulette.roulette_place_bet(body, {"id": "player"})
        self.assertEqual(result["balance"], 9_999_990)
        self.assertEqual(await database.roulette_bets.count_documents({"status": "OPEN"}), 1)
        self.assertEqual(
            await database.chip_transactions.count_documents({"kind": ledger.STAKE}), 1
        )

    async def test_roulette_position_cap_cannot_be_bypassed_by_reordering(self):
        first = roulette.RouletteBet(
            bet_type="corner", value="1-2-4-5", amount=roulette.POSITION_MAX
        )
        alias = roulette.RouletteBet(
            bet_type="corner", value="5-4-2-1", amount=roulette.MIN_BET
        )

        await roulette.roulette_place_bet(first, {"id": "player"})
        with self.assertRaises(HTTPException) as caught:
            await roulette.roulette_place_bet(alias, {"id": "player"})

        self.assertEqual(caught.exception.status_code, 400)
        self.assertEqual(caught.exception.detail["code"], "TABLE_LIMIT")
        self.assertEqual(await self._balance(), 10_000_000 - roulette.POSITION_MAX)
        self.assertEqual(await database.roulette_bets.count_documents({}), 1)

    async def test_roulette_settlement_failure_rolls_back_then_retries_once(self):
        await database.users.update_one(
            {"id": "player"}, {"$set": {"chip_balance": 0}}
        )
        await database.roulette_bets.insert_many([
            {
                "id": f"roulette-settle-{index}", "user_id": "player",
                "slug": "fun-roulette-bet", "round_number": 41,
                "bet_type": "straight", "value": "7", "amount": 10,
                "status": "OPEN", "created_at": "2026-01-01T00:00:00Z",
            }
            for index in range(3)
        ])
        await database.roulette_rounds.insert_one({
            "round_number": 41, "winning_number": "7", "color": "red"
        })
        ledger._write = FailLedgerWriteOnce(self.original_ledger_write)

        with self.assertRaisesRegex(RuntimeError, "injected"):
            await roulette._roulette_settle_user("player", 42, "BETTING")
        self.assertEqual(await self._balance(), 0)
        self.assertEqual(
            await database.roulette_bets.count_documents({"status": "OPEN"}), 3
        )
        self.assertEqual(await database.game_rounds.count_documents({}), 0)

        first = await roulette._roulette_settle_user("player", 42, "BETTING")
        second = await roulette._roulette_settle_user("player", 42, "BETTING")
        self.assertEqual(first["payout"], 1080)
        self.assertIsNone(second)
        self.assertEqual(await self._balance(), 1080)
        self.assertEqual(await database.game_rounds.count_documents({}), 1)
        self.assertEqual(
            await database.chip_transactions.count_documents({"kind": ledger.PAYOUT}), 3
        )

    async def test_roulette_concurrent_settlement_includes_more_than_200_bets_once(self):
        await database.users.update_one(
            {"id": "player"}, {"$set": {"chip_balance": 0}}
        )
        await database.roulette_bets.insert_many([
            {
                "id": f"many-roulette-{index}", "user_id": "player",
                "slug": "fun-roulette-bet", "round_number": 41,
                "bet_type": "straight", "value": 7, "amount": 10,
                "status": "OPEN", "created_at": "2026-01-01T00:00:00Z",
            }
            for index in range(205)
        ])
        await database.roulette_rounds.insert_one({
            "round_number": 41, "winning_number": "7", "color": "red"
        })

        await asyncio.gather(
            roulette._roulette_settle_user("player", 42, "BETTING"),
            roulette._roulette_settle_user("player", 42, "BETTING"),
        )
        self.assertEqual(
            await database.roulette_bets.count_documents({"status": "SETTLED"}), 205
        )
        self.assertEqual(await self._balance(), 73_800)
        history = await database.game_rounds.find({}).to_list(None)
        self.assertEqual(len(history), 1)
        self.assertEqual((history[0]["bet"], history[0]["payout"]), (2050, 73_800))
        self.assertEqual(
            await database.chip_transactions.count_documents({"kind": ledger.PAYOUT}), 205
        )

    async def test_live_payout_references_only_the_winning_stake(self):
        await database.users.update_one({"id": "player"}, {"$set": {"chip_balance": 0}})
        await database.live_bets.insert_many([
            {
                "id": "live-winning-source", "user_id": "player",
                "slug": "seven-up-down", "round_number": 41,
                "selection": "down", "amount": 10, "status": "OPEN",
                "created_at": "2026-01-01T00:00:00Z",
            },
            {
                "id": "live-losing-source", "user_id": "player",
                "slug": "seven-up-down", "round_number": 41,
                "selection": "up", "amount": 10, "status": "OPEN",
                "created_at": "2026-01-01T00:00:00Z",
            },
        ])
        await database.live_outcomes.insert_one({
            "slug": "seven-up-down", "round_number": 41,
            "outcome": {"dice": [1, 1], "total": 2, "winner": "down"},
        })
        await live._live_settle_user("player", "seven-up-down", 42, "BETTING")
        payout = await database.chip_transactions.find_one({"kind": ledger.PAYOUT})
        self.assertEqual(payout["source_refs"], ["live-winning-source"])

    async def test_roulette_payout_references_only_the_winning_stake(self):
        await database.users.update_one({"id": "player"}, {"$set": {"chip_balance": 0}})
        await database.roulette_bets.insert_many([
            {
                "id": "roulette-winning-source", "user_id": "player",
                "slug": "fun-roulette-bet", "round_number": 41,
                "bet_type": "straight", "value": "7", "amount": 10,
                "status": "OPEN", "created_at": "2026-01-01T00:00:00Z",
            },
            {
                "id": "roulette-losing-source", "user_id": "player",
                "slug": "fun-roulette-bet", "round_number": 41,
                "bet_type": "straight", "value": "8", "amount": 10,
                "status": "OPEN", "created_at": "2026-01-01T00:00:00Z",
            },
        ])
        await database.roulette_rounds.insert_one({
            "round_number": 41, "winning_number": "7", "color": "red",
        })
        await roulette._roulette_settle_user("player", 42, "BETTING")
        payout = await database.chip_transactions.find_one({"kind": ledger.PAYOUT})
        self.assertEqual(payout["source_refs"], ["roulette-winning-source"])

    async def test_outcome_creation_does_not_swallow_storage_errors(self):
        live_collection = database.live_outcomes
        original_live_insert = live_collection.insert_one

        async def fail_live_insert(*_args, **_kwargs):
            raise RuntimeError("live outcome storage unavailable")

        live_collection.insert_one = fail_live_insert
        live.db = types.SimpleNamespace(live_outcomes=live_collection)
        try:
            with self.assertRaisesRegex(RuntimeError, "storage unavailable"):
                await live._live_outcome("seven-up-down", 9001)
        finally:
            live.db = database
            live_collection.insert_one = original_live_insert
        self.assertNotIn(("seven-up-down", 9001), live._OUTCOME_CACHE)

        roulette_collection = database.roulette_rounds
        original_roulette_insert = roulette_collection.insert_one

        async def fail_roulette_insert(*_args, **_kwargs):
            raise RuntimeError("roulette outcome storage unavailable")

        roulette_collection.insert_one = fail_roulette_insert
        roulette.db = types.SimpleNamespace(roulette_rounds=roulette_collection)
        try:
            with self.assertRaisesRegex(RuntimeError, "storage unavailable"):
                await roulette._roulette_round_result(9001)
        finally:
            roulette.db = database
            roulette_collection.insert_one = original_roulette_insert

    async def test_duplicate_outcome_race_returns_only_the_persisted_result(self):
        live_collection = database.live_outcomes
        original_live_insert = live_collection.insert_one

        competing_live_outcome = {
            "dice": [6, 6], "total": 12, "winner": "up"
        }

        async def race_live_insert(document, *args, **kwargs):
            persisted = copy.deepcopy(document)
            persisted["outcome"] = competing_live_outcome
            await original_live_insert(persisted, *args, **kwargs)
            raise DuplicateKeyError("simulated race")

        live_collection.insert_one = race_live_insert
        live.db = types.SimpleNamespace(live_outcomes=live_collection)
        try:
            generated = await live._live_outcome("seven-up-down", 9002)
        finally:
            live.db = database
            live_collection.insert_one = original_live_insert
        persisted = await live_collection.find_one({
            "slug": "seven-up-down", "round_number": 9002
        })
        self.assertEqual(generated, persisted["outcome"])
        self.assertEqual(generated, competing_live_outcome)

        roulette_collection = database.roulette_rounds
        original_roulette_insert = roulette_collection.insert_one

        async def race_roulette_insert(document, *args, **kwargs):
            persisted = copy.deepcopy(document)
            persisted["winning_number"] = "00"
            persisted["color"] = "green"
            await original_roulette_insert(persisted, *args, **kwargs)
            raise DuplicateKeyError("simulated race")

        roulette_collection.insert_one = race_roulette_insert
        roulette.db = types.SimpleNamespace(roulette_rounds=roulette_collection)
        try:
            generated_number = await roulette._roulette_round_result(9002)
        finally:
            roulette.db = database
            roulette_collection.insert_one = original_roulette_insert
        persisted_round = await roulette_collection.find_one({"round_number": 9002})
        self.assertEqual(generated_number, persisted_round["winning_number"])
        self.assertEqual(generated_number, "00")


class TransactionRunnerAvailabilityTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.original_app_env = os.environ.get("APP_ENV")
        self.original_test_fallback = os.environ.get(
            "FINANCIAL_ALLOW_NON_TRANSACTIONAL_TESTS"
        )

    def tearDown(self):
        for key, value in (
            ("APP_ENV", self.original_app_env),
            ("FINANCIAL_ALLOW_NON_TRANSACTIONAL_TESTS", self.original_test_fallback),
        ):
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    async def test_production_fails_before_callback_without_sessions(self):
        os.environ["APP_ENV"] = "production"
        os.environ.pop("FINANCIAL_ALLOW_NON_TRANSACTIONAL_TESTS", None)
        callback_called = False

        class NoSessionClient:
            async def start_session(self):
                raise NotImplementedError

        async def callback(_session):
            nonlocal callback_called
            callback_called = True

        with self.assertRaises(HTTPException) as caught:
            await transactions.run_game_transaction(NoSessionClient(), callback)
        self.assertEqual(caught.exception.status_code, 503)
        self.assertFalse(callback_called)

    async def test_explicit_test_mode_is_the_only_nontransactional_fallback(self):
        os.environ["APP_ENV"] = "test"
        os.environ["FINANCIAL_ALLOW_NON_TRANSACTIONAL_TESTS"] = "true"

        class NoSessionClient:
            async def start_session(self):
                raise NotImplementedError

        async def callback(session):
            self.assertIsNone(session)
            return "test-only"

        self.assertEqual(
            await transactions.run_game_transaction(NoSessionClient(), callback),
            "test-only",
        )

    async def test_standalone_transaction_rejection_is_a_safe_503(self):
        os.environ["APP_ENV"] = "production"
        os.environ.pop("FINANCIAL_ALLOW_NON_TRANSACTIONAL_TESTS", None)

        class UnsupportedSession:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                return False

            async def with_transaction(self, _callback):
                raise OperationFailure(
                    "Transaction numbers are only allowed on a replica set member or mongos",
                    code=20,
                )

        class StandaloneClient:
            async def start_session(self):
                return UnsupportedSession()

        with self.assertRaises(HTTPException) as caught:
            await transactions.run_game_transaction(StandaloneClient(), lambda _s: None)
        self.assertEqual(caught.exception.status_code, 503)

    async def test_session_configuration_failure_is_a_safe_503(self):
        os.environ["APP_ENV"] = "production"
        os.environ.pop("FINANCIAL_ALLOW_NON_TRANSACTIONAL_TESTS", None)
        callback_called = False

        class MisconfiguredClient:
            async def start_session(self):
                raise ConfigurationError("sessions are unavailable")

        async def callback(_session):
            nonlocal callback_called
            callback_called = True

        with self.assertRaises(HTTPException) as caught:
            await transactions.run_game_transaction(MisconfiguredClient(), callback)
        self.assertEqual(caught.exception.status_code, 503)
        self.assertFalse(callback_called)

    async def test_post_session_failure_never_replays_without_transaction(self):
        os.environ["APP_ENV"] = "test"
        os.environ["FINANCIAL_ALLOW_NON_TRANSACTIONAL_TESTS"] = "true"
        callback_calls = 0

        class BrokenSession:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                return False

            async def with_transaction(self, callback):
                nonlocal callback_calls
                callback_calls += 1
                await callback(self)
                raise NotImplementedError("transaction support disappeared")

        class BrokenClient:
            async def start_session(self):
                return BrokenSession()

        async def callback(_session):
            return "attempted"

        with self.assertRaises(HTTPException) as caught:
            await transactions.run_game_transaction(BrokenClient(), callback)
        self.assertEqual(caught.exception.status_code, 503)
        self.assertEqual(callback_calls, 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
