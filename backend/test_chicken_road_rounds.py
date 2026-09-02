"""Chicken Road live crash-round lifecycle, wallet and catalogue-wiring checks.

Run as a script so the mock ``db`` module is installed before route imports.
No network, production database, or real payment provider is used.
"""
from __future__ import annotations

import asyncio
import os
import sys
import time
import types
import unittest

from mongomock_motor import AsyncMongoMockClient


HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

mock_client = AsyncMongoMockClient()
database = mock_client["chicken_road_test"]
sys.modules["db"] = types.SimpleNamespace(
    db=database,
    client=mock_client,
    serialize_doc=lambda value: value,
)

import ledger  # noqa: E402
import routes_chicken_road as cr  # noqa: E402


MUTATED_COLLECTIONS = (
    "users",
    "chip_transactions",
    "chicken_road_bets",
    "chicken_road_rounds",
    "game_rounds",
)


async def _allow_game(slug):
    return {"slug": slug, "name": slug, "status": "ENABLED"}


async def _direct_runner(_client, callback):
    """Run the settlement/bet callback without a Mongo session (mock has none)."""
    return await callback(None)


class ChickenRoadRoundTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        for name in MUTATED_COLLECTIONS:
            await database[name].delete_many({})
        self.original_runner = cr.run_game_transaction
        self.original_access = cr.require_playable_game
        cr.db = database
        cr.client = mock_client
        ledger.db = database
        cr.run_game_transaction = _direct_runner
        cr.require_playable_game = _allow_game
        await database.users.insert_one({"id": "player", "chip_balance": 10_000})

    async def asyncTearDown(self):
        cr.run_game_transaction = self.original_runner
        cr.require_playable_game = self.original_access

    async def _balance(self):
        user = await database.users.find_one({"id": "player"})
        return user["chip_balance"]

    async def _insert_round(self, *, phase, round_number=1, crash_point=5.0):
        """Insert a round positioned in the requested phase relative to now."""
        now = time.time()
        if phase == "BETTING":
            betting_start, run_start = now, now + cr.CR_BETTING
        elif phase == "RUNNING":
            betting_start, run_start = now - cr.CR_BETTING, now - 0.05
        else:  # CRASHED
            betting_start, run_start = now - 30, now - 25
        crash_at = run_start + (0.5 if phase == "RUNNING" else -1.0 if phase == "CRASHED" else 10.0)
        if phase == "RUNNING":
            crash_at = now + 5.0
        doc = {
            "round_number": round_number, "betting_start": betting_start,
            "run_start": run_start, "crash_point": crash_point,
            "crash_at": crash_at, "ends_at": crash_at + cr.CR_RESULT,
            "status": "OPEN", "created_at": cr._now_iso(),
            "server_seed": "seed", "server_seed_hash": "hash",
            "verification_factor": 0.97, "fairness_version": 1,
        }
        await database.chicken_road_rounds.insert_one(dict(doc))
        return doc

    # ---- lifecycle -------------------------------------------------------
    async def test_place_bet_debits_chips_and_opens_bet(self):
        await self._insert_round(phase="BETTING")
        body = cr.ChickenRoadBet(amount=100, panel=1)
        result = await cr.chicken_road_place_bet(body, {"id": "player"})
        self.assertEqual(result["balance"], 9_900)
        self.assertEqual(await self._balance(), 9_900)
        self.assertEqual(
            await database.chicken_road_bets.count_documents({"status": "OPEN"}), 1
        )
        self.assertEqual(
            await database.chip_transactions.count_documents({"kind": ledger.STAKE}), 1
        )

    async def test_cashout_before_crash_credits_chips(self):
        r = await self._insert_round(phase="RUNNING", crash_point=50.0)
        bet = {
            "id": "b1", "user_id": "player", "round_number": r["round_number"],
            "panel": 1, "amount": 100, "auto_cashout": None, "status": "OPEN",
            "active": True, "payout": 0, "multiplier": None, "created_at": cr._now_iso(),
        }
        await database.chicken_road_bets.insert_one(dict(bet))
        result = await cr.chicken_road_cashout(cr.BetRef(bet_id="b1"), {"id": "player"})
        self.assertEqual(result["result"], "cashed_out")
        self.assertGreater(result["payout"], 0)
        self.assertGreaterEqual(result["multiplier"], 1.0)
        self.assertEqual(await self._balance(), 10_000 + result["payout"])
        settled = await database.chicken_road_bets.find_one({"id": "b1"})
        self.assertEqual(settled["status"], "CASHED")
        self.assertEqual(
            await database.chip_transactions.count_documents({"kind": ledger.PAYOUT}), 1
        )

    async def test_crash_after_no_cashout_does_not_credit(self):
        r = await self._insert_round(phase="CRASHED", crash_point=3.0)
        bet = {
            "id": "b2", "user_id": "player", "round_number": r["round_number"],
            "panel": 1, "amount": 100, "auto_cashout": None, "status": "OPEN",
            "active": True, "payout": 0, "multiplier": None, "created_at": cr._now_iso(),
        }
        await database.chicken_road_bets.insert_one(dict(bet))
        start_balance = await self._balance()
        await cr._cr_settle_round(r)
        self.assertEqual(await self._balance(), start_balance)  # never credited
        lost = await database.chicken_road_bets.find_one({"id": "b2"})
        self.assertEqual(lost["status"], "LOST")
        self.assertEqual(lost["payout"], 0)
        self.assertEqual(
            await database.chip_transactions.count_documents({"kind": ledger.PAYOUT}), 0
        )
        history = await database.game_rounds.find_one({"user_id": "player"})
        self.assertEqual(history["payout"], 0)
        self.assertEqual(history["outcome"]["result"], "crashed")

    async def test_auto_cashout_pays_when_target_below_crash_and_loses_above(self):
        r = await self._insert_round(phase="CRASHED", crash_point=5.0)
        await database.chicken_road_bets.insert_many([
            {
                "id": "win", "user_id": "player", "round_number": r["round_number"],
                "panel": 1, "amount": 100, "auto_cashout": 2.0, "status": "OPEN",
                "active": True, "payout": 0, "multiplier": None, "created_at": cr._now_iso(),
            },
            {
                "id": "lose", "user_id": "player", "round_number": r["round_number"],
                "panel": 2, "amount": 100, "auto_cashout": 10.0, "status": "OPEN",
                "active": True, "payout": 0, "multiplier": None, "created_at": cr._now_iso(),
            },
        ])
        await cr._cr_settle_round(r)
        won = await database.chicken_road_bets.find_one({"id": "win"})
        lost = await database.chicken_road_bets.find_one({"id": "lose"})
        self.assertEqual(won["status"], "CASHED")
        self.assertEqual(won["payout"], 200)  # 100 * 2.0
        self.assertEqual(lost["status"], "LOST")
        self.assertEqual(lost["payout"], 0)
        # Only the auto-win credited the wallet.
        self.assertEqual(await self._balance(), 10_200)

    async def test_settle_round_is_idempotent(self):
        r = await self._insert_round(phase="CRASHED", crash_point=2.0)
        await database.chicken_road_bets.insert_one({
            "id": "b3", "user_id": "player", "round_number": r["round_number"],
            "panel": 1, "amount": 100, "auto_cashout": None, "status": "OPEN",
            "active": True, "payout": 0, "multiplier": None, "created_at": cr._now_iso(),
        })
        await cr._cr_settle_round(r)
        await cr._cr_settle_round(r)  # second pass must not double-write history
        self.assertEqual(await database.game_rounds.count_documents({}), 1)
        self.assertEqual(
            await database.chicken_road_rounds.count_documents({"status": "SETTLED"}), 1
        )

    async def test_state_reports_running_multiplier_locked_to_elapsed(self):
        await self._insert_round(phase="RUNNING", crash_point=100.0)
        state = await cr.chicken_road_state({"id": "player"})
        self.assertEqual(state["phase"], "RUNNING")
        self.assertIn("multiplier", state)
        self.assertGreaterEqual(state["multiplier"], 1.0)
        # The reported multiplier must equal the shared curve at the reported elapsed.
        self.assertEqual(
            state["multiplier"], cr.chicken_road_multiplier(state["run_elapsed"])
        )


class ChickenRoadCatalogueTests(unittest.TestCase):
    def test_slug_is_in_the_reviewed_playable_set(self):
        import game_access
        self.assertIn("chicken-road", game_access.PLAYABLE_GAME_SLUGS)

    def test_catalogue_seed_registers_chicken_road_crash_table(self):
        import seed
        entry = next((g for g in seed.GAMES if g["slug"] == "chicken-road"), None)
        self.assertIsNotNone(entry)
        self.assertEqual(entry["name"], "Chicken Road")
        self.assertEqual(entry["category"], "Crash")

    def test_table_limits_are_defined(self):
        from live_engines import limits_for
        low, high = limits_for("chicken-road")
        self.assertGreaterEqual(low, 1)
        self.assertGreater(high, low)


if __name__ == "__main__":
    unittest.main(verbosity=2)