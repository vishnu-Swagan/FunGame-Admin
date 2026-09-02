"""Chicken Road hop-round lifecycle, wallet and catalogue-wiring checks.

Run as a script so the mock ``db`` module is installed before route imports.
No network, production database, or real payment provider is used.
"""
from __future__ import annotations

import os
import sys
import types
import unittest
from unittest.mock import patch

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
import game_engines  # noqa: E402


MUTATED_COLLECTIONS = (
    "users",
    "chip_transactions",
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

    async def test_play_debits_chips_and_hops_onto_first_lane_when_safe(self):
        # Force crash_lane past lane 1 so Play lands on 1.01x.
        with patch.object(cr, "chicken_road_crash_lane", return_value=9):
            result = await cr.chicken_road_play(
                cr.PlayBody(amount=100, difficulty="easy"), {"id": "player"},
            )
        self.assertEqual(result["result"], "hopped")
        self.assertEqual(result["balance"], 9_900)
        self.assertEqual(await self._balance(), 9_900)
        rnd = result["round"]
        self.assertEqual(rnd["status"], "PLAYING")
        self.assertEqual(rnd["current_lane"], 1)
        self.assertEqual(rnd["current_multiplier"], 1.01)
        self.assertEqual(rnd["cashout_amount"], 101)
        self.assertNotIn("crash_lane", rnd)
        self.assertEqual(
            await database.chip_transactions.count_documents({"kind": ledger.STAKE}), 1
        )

    async def test_play_crashes_on_lane_one_without_credit(self):
        with patch.object(cr, "chicken_road_crash_lane", return_value=1):
            result = await cr.chicken_road_play(
                cr.PlayBody(amount=100, difficulty="easy"), {"id": "player"},
            )
        self.assertEqual(result["result"], "crashed")
        self.assertEqual(await self._balance(), 9_900)  # stake taken, never returned
        rnd = result["round"]
        self.assertEqual(rnd["status"], "CRASHED")
        self.assertEqual(rnd["payout"], 0)
        self.assertEqual(rnd["crash_lane"], 1)
        self.assertEqual(
            await database.chip_transactions.count_documents({"kind": ledger.PAYOUT}), 0
        )
        history = await database.game_rounds.find_one({"user_id": "player"})
        self.assertEqual(history["payout"], 0)
        self.assertEqual(history["outcome"]["result"], "crashed")

    async def test_go_then_cashout_credits_lane_multiplier(self):
        with patch.object(cr, "chicken_road_crash_lane", return_value=9):
            played = await cr.chicken_road_play(
                cr.PlayBody(amount=100, difficulty="easy"), {"id": "player"},
            )
        round_id = played["round"]["id"]
        hopped = await cr.chicken_road_go(cr.RoundRef(round_id=round_id), {"id": "player"})
        self.assertEqual(hopped["result"], "hopped")
        self.assertEqual(hopped["round"]["current_lane"], 2)
        self.assertEqual(hopped["round"]["current_multiplier"], 1.03)
        cashed = await cr.chicken_road_cashout(cr.RoundRef(round_id=round_id), {"id": "player"})
        self.assertEqual(cashed["result"], "cashed_out")
        self.assertEqual(cashed["payout"], 103)  # 100 * 1.03
        self.assertEqual(await self._balance(), 10_003)
        settled = await database.chicken_road_rounds.find_one({"id": round_id})
        self.assertEqual(settled["status"], "CASHED")
        self.assertEqual(
            await database.chip_transactions.count_documents({"kind": ledger.PAYOUT}), 1
        )

    async def test_go_onto_crash_lane_does_not_credit(self):
        with patch.object(cr, "chicken_road_crash_lane", return_value=2):
            played = await cr.chicken_road_play(
                cr.PlayBody(amount=100, difficulty="easy"), {"id": "player"},
            )
        round_id = played["round"]["id"]
        self.assertEqual(played["round"]["current_lane"], 1)
        crashed = await cr.chicken_road_go(cr.RoundRef(round_id=round_id), {"id": "player"})
        self.assertEqual(crashed["result"], "crashed")
        self.assertEqual(await self._balance(), 9_900)
        lost = await database.chicken_road_rounds.find_one({"id": round_id})
        self.assertEqual(lost["status"], "CRASHED")
        self.assertEqual(lost["payout"], 0)
        self.assertEqual(
            await database.chip_transactions.count_documents({"kind": ledger.PAYOUT}), 0
        )

    async def test_second_play_while_active_is_conflict(self):
        with patch.object(cr, "chicken_road_crash_lane", return_value=9):
            await cr.chicken_road_play(
                cr.PlayBody(amount=100, difficulty="easy"), {"id": "player"},
            )
            with self.assertRaises(cr.HTTPException) as raised:
                await cr.chicken_road_play(
                    cr.PlayBody(amount=50, difficulty="easy"), {"id": "player"},
                )
        self.assertEqual(raised.exception.status_code, 409)
        self.assertEqual(await self._balance(), 9_900)

    async def test_cashout_is_idempotent(self):
        with patch.object(cr, "chicken_road_crash_lane", return_value=9):
            played = await cr.chicken_road_play(
                cr.PlayBody(amount=100, difficulty="easy"), {"id": "player"},
            )
        round_id = played["round"]["id"]
        first = await cr.chicken_road_cashout(cr.RoundRef(round_id=round_id), {"id": "player"})
        self.assertEqual(first["payout"], 101)
        with self.assertRaises(cr.HTTPException) as raised:
            await cr.chicken_road_cashout(cr.RoundRef(round_id=round_id), {"id": "player"})
        self.assertEqual(raised.exception.status_code, 400)
        self.assertEqual(await self._balance(), 10_001)
        self.assertEqual(await database.game_rounds.count_documents({}), 1)

    async def test_state_hides_crash_lane_while_playing(self):
        with patch.object(cr, "chicken_road_crash_lane", return_value=9):
            await cr.chicken_road_play(
                cr.PlayBody(amount=100, difficulty="easy"), {"id": "player"},
            )
        state = await cr.chicken_road_state({"id": "player"})
        self.assertEqual(state["active"]["status"], "PLAYING")
        self.assertNotIn("crash_lane", state["active"])
        self.assertIn("easy", state["difficulties"])
        self.assertEqual(state["difficulties"]["easy"]["multipliers"][0], 1.01)
        self.assertEqual(state["chip_presets"], [20, 50, 100, 500])
        self.assertGreaterEqual(state["online"], 1)

    async def test_legacy_bets_endpoint_is_gone(self):
        with self.assertRaises(cr.HTTPException) as raised:
            await cr.chicken_road_place_bet_gone(cr._Gone(amount=100), {"id": "player"})
        self.assertEqual(raised.exception.status_code, 410)


class ChickenRoadCatalogueTests(unittest.TestCase):
    def test_slug_is_in_the_reviewed_playable_set(self):
        import game_access
        self.assertIn("chicken-road", game_access.PLAYABLE_GAME_SLUGS)

    def test_catalogue_seed_registers_chicken_road_hop_table(self):
        import seed
        entry = next((g for g in seed.GAMES if g["slug"] == "chicken-road"), None)
        self.assertIsNotNone(entry)
        self.assertEqual(entry["name"], "Chicken Road")
        self.assertEqual(entry["category"], "Crash")
        self.assertNotIn("night", (entry.get("description") or "").lower())
        self.assertNotIn("IN OUT", (entry.get("description") or ""))

    def test_table_limits_are_defined(self):
        from live_engines import limits_for
        low, high = limits_for("chicken-road")
        self.assertGreaterEqual(low, 1)
        self.assertGreater(high, low)


if __name__ == "__main__":
    unittest.main(verbosity=2)
