"""Focused source-allocation checks for the dormant gameplay wallet bridge."""
from __future__ import annotations

import os
import sys
import types
import unittest
from unittest.mock import patch

from mongomock_motor import AsyncMongoMockClient

_IMPORT_CLIENT = AsyncMongoMockClient()
_IMPORT_DB = _IMPORT_CLIENT["game_wallet_source_import"]
sys.modules["db"] = types.SimpleNamespace(
    db=_IMPORT_DB,
    client=_IMPORT_CLIENT,
    serialize_doc=lambda value: value,
)

import financial_wallet as finance
import game_wallet
import ledger


class GameWalletSourceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.original_stake_guards = list(ledger._stake_guards)
        ledger._stake_guards.clear()
        self.client = AsyncMongoMockClient()
        self.database = self.client["game_wallet_source_test"]
        self.patches = [
            patch.object(finance, "db", self.database),
            patch.object(game_wallet, "db", self.database),
            patch.object(ledger, "db", self.database),
            patch.object(finance, "GAME_WALLET_INTEGRATION_READY", True),
            patch.object(finance, "_READY", True),
            patch.dict(os.environ, {
                "APP_ENV": "test",
                "REAL_MONEY_ENABLED": "true",
                "FINANCIAL_GAME_WALLET_INTEGRATED": "true",
                "FINANCIAL_ALLOW_NON_TRANSACTIONAL_TESTS": "true",
            }),
        ]
        for active_patch in self.patches:
            active_patch.start()
        game_wallet.install()
        await self.database.users.insert_one({"id": "player-1", "chip_balance": 140})
        await self.database.wallet_accounts.insert_one({
            "id": "wallet-1", "user_id": "player-1",
            "available_cash_chips": 100, "available_bonus_chips": 40,
            "held_cash_chips": 0, "version": 1,
        })

    async def asyncTearDown(self):
        for active_patch in reversed(self.patches):
            active_patch.stop()
        ledger._stake_guards[:] = self.original_stake_guards

    async def assert_conserved(self):
        user = await self.database.users.find_one({"id": "player-1"})
        wallet = await self.database.wallet_accounts.find_one({"user_id": "player-1"})
        self.assertEqual(
            int(user["chip_balance"]),
            int(wallet["available_cash_chips"])
            + int(wallet["available_bonus_chips"])
            + int(wallet["held_cash_chips"]),
        )

    async def test_bonus_first_mixed_stake_and_proportional_payout(self):
        await ledger.debit_chips(
            "player-1", 70, "mixed stake", ref="bet-mixed", kind=ledger.STAKE,
            game="aviator", session=None,
        )
        stake = await self.database.chip_transactions.find_one({
            "user_id": "player-1", "kind": ledger.STAKE, "ref": "bet-mixed",
        })
        self.assertEqual(stake["funding_allocation"]["bonus_chips"], 40)
        self.assertEqual(stake["funding_allocation"]["cash_chips"], 30)
        await self.assert_conserved()

        await ledger.credit_chips(
            "player-1", 101, "mixed payout", ref="bet-mixed",
            source_refs=["bet-mixed"], kind=ledger.PAYOUT, game="aviator",
            session=None,
        )
        payout = await self.database.chip_transactions.find_one({
            "user_id": "player-1", "kind": ledger.PAYOUT, "ref": "bet-mixed",
        })
        # floor(101 * 30 / 70) goes to cash; the indivisible remainder remains
        # restricted bonus, as declared by game-wallet-source-v1.
        self.assertEqual(payout["funding_allocation"]["cash_chips"], 43)
        self.assertEqual(payout["funding_allocation"]["bonus_chips"], 58)
        await self.assert_conserved()

    async def test_refund_restores_exact_original_buckets(self):
        await ledger.debit_chips(
            "player-1", 70, "mixed stake", ref="bet-refund", kind=ledger.STAKE,
            game="fun-roulette", session=None,
        )
        await ledger.credit_chips(
            "player-1", 70, "void refund", ref="refund-1",
            source_refs=["bet-refund"], kind=ledger.REFUND,
            game="fun-roulette", session=None,
        )
        wallet = await self.database.wallet_accounts.find_one({"user_id": "player-1"})
        self.assertEqual(wallet["available_cash_chips"], 100)
        self.assertEqual(wallet["available_bonus_chips"], 40)
        marker = await self.database.chip_transactions.find_one({
            "kind": ledger.SETTLEMENT, "source_refs": "bet-refund",
        })
        self.assertEqual(marker["settlement_status"], "VOID")
        self.assertEqual(marker["funding_allocation"]["cash_chips"], 30)
        self.assertEqual(marker["funding_allocation"]["bonus_chips"], 40)
        await self.assert_conserved()

    async def test_refund_amount_cannot_drift_from_selected_sources(self):
        await ledger.debit_chips(
            "player-1", 25, "stake", ref="bet-exact", kind=ledger.STAKE,
            game="aviator", session=None,
        )
        with self.assertRaisesRegex(finance.FinancialError, "exact selected stake"):
            await ledger.credit_chips(
                "player-1", 24, "bad refund", ref="refund-bad",
                source_refs=["bet-exact"], kind=ledger.REFUND,
                game="aviator", session=None,
            )
        await self.assert_conserved()

    async def test_cash_stake_cannot_be_refunded_twice(self):
        await self.database.users.update_one(
            {"id": "player-1"}, {"$set": {"chip_balance": 100}},
        )
        await self.database.wallet_accounts.update_one(
            {"user_id": "player-1"},
            {"$set": {"available_cash_chips": 100, "available_bonus_chips": 0}},
        )
        await ledger.debit_chips(
            "player-1", 10, "cash stake", ref="cash-refund-stake",
            kind=ledger.STAKE, game="aviator", session=None,
        )
        await ledger.credit_chips(
            "player-1", 10, "first refund", ref="cash-refund-one",
            source_refs=["cash-refund-stake"], kind=ledger.REFUND,
            game="aviator", session=None,
        )
        with self.assertRaisesRegex(
            finance.FinancialError, "already has a monetary outcome",
        ):
            await ledger.credit_chips(
                "player-1", 10, "duplicate refund", ref="cash-refund-two",
                source_refs=["cash-refund-stake"], kind=ledger.REFUND,
                game="aviator", session=None,
            )
        await self.assert_conserved()
        user = await self.database.users.find_one({"id": "player-1"})
        self.assertEqual(user["chip_balance"], 100)

    async def test_cash_stake_cannot_receive_two_payouts(self):
        await self.database.users.update_one(
            {"id": "player-1"}, {"$set": {"chip_balance": 100}},
        )
        await self.database.wallet_accounts.update_one(
            {"user_id": "player-1"},
            {"$set": {"available_cash_chips": 100, "available_bonus_chips": 0}},
        )
        await ledger.debit_chips(
            "player-1", 10, "cash stake", ref="cash-payout-stake",
            kind=ledger.STAKE, game="aviator", session=None,
        )
        await ledger.credit_chips(
            "player-1", 20, "first payout", ref="cash-payout-one",
            source_refs=["cash-payout-stake"], kind=ledger.PAYOUT,
            game="aviator", session=None,
        )
        with self.assertRaisesRegex(
            finance.FinancialError, "already has a monetary outcome",
        ):
            await ledger.credit_chips(
                "player-1", 20, "duplicate payout", ref="cash-payout-two",
                source_refs=["cash-payout-stake"], kind=ledger.PAYOUT,
                game="aviator", session=None,
            )
        await self.assert_conserved()
        user = await self.database.users.find_one({"id": "player-1"})
        self.assertEqual(user["chip_balance"], 110)

    async def test_losing_stake_has_idempotent_authoritative_settlement(self):
        await ledger.debit_chips(
            "player-1", 10, "losing stake", ref="bet-lost", kind=ledger.STAKE,
            game="aviator", session=None,
        )
        first = await ledger.record_settlement(
            "player-1", ["bet-lost"], "aviator", status="SETTLED", session=None,
        )
        second = await ledger.record_settlement(
            "player-1", ["bet-lost"], "aviator", status="SETTLED", session=None,
        )
        self.assertEqual(len(first), 1)
        self.assertEqual(second, [])
        self.assertEqual(await self.database.chip_transactions.count_documents({
            "kind": ledger.SETTLEMENT, "ref": "bet-lost",
        }), 1)
        await self.assert_conserved()

    async def test_mirror_drift_fails_before_source_wallet_mutation(self):
        await self.database.users.update_one(
            {"id": "player-1"}, {"$set": {"chip_balance": 139}},
        )
        with self.assertRaisesRegex(
            finance.FinancialError, "require reconciliation",
        ):
            await ledger.debit_chips(
                "player-1", 10, "must fail", ref="drift-bet",
                kind=ledger.STAKE, game="aviator", session=None,
            )
        wallet = await self.database.wallet_accounts.find_one({"user_id": "player-1"})
        self.assertEqual(wallet["available_cash_chips"], 100)
        self.assertEqual(wallet["available_bonus_chips"], 40)
        self.assertEqual(await self.database.chip_transactions.count_documents({}), 0)

    async def test_rummy_pot_payout_preserves_cash_sources_across_players(self):
        await self.database.users.update_one(
            {"id": "player-1"}, {"$set": {"chip_balance": 100}},
        )
        await self.database.wallet_accounts.update_one(
            {"user_id": "player-1"},
            {"$set": {"available_cash_chips": 100, "available_bonus_chips": 0}},
        )
        await self.database.users.insert_one({"id": "player-2", "chip_balance": 60})
        await self.database.wallet_accounts.insert_one({
            "id": "wallet-2", "user_id": "player-2",
            "available_cash_chips": 60, "available_bonus_chips": 0,
            "held_cash_chips": 0, "version": 1,
        })
        await ledger.debit_chips(
            "player-1", 40, "Rummy seat", ref="seat-cash",
            kind=ledger.STAKE, game="rummy", session=None,
        )
        await ledger.debit_chips(
            "player-2", 60, "Rummy seat", ref="seat-bonus",
            kind=ledger.STAKE, game="rummy", session=None,
        )
        await ledger.credit_chips(
            "player-1", 100, "Rummy pot", ref="round-1",
            source_refs=["seat-cash", "seat-bonus"],
            kind=ledger.PAYOUT, game="rummy", session=None,
        )
        payout = await self.database.chip_transactions.find_one({
            "kind": ledger.PAYOUT, "ref": "round-1",
        })
        self.assertEqual(payout["funding_allocation"]["cash_chips"], 100)
        self.assertEqual(payout["funding_allocation"]["bonus_chips"], 0)
        winner_wallet = await self.database.wallet_accounts.find_one({"user_id": "player-1"})
        self.assertEqual(winner_wallet["available_cash_chips"], 160)
        self.assertEqual(winner_wallet["available_bonus_chips"], 0)
        total_mirrors = sum(
            int(row["chip_balance"])
            for row in await self.database.users.find({}, {"chip_balance": 1}).to_list(length=None)
        )
        total_wallet = sum(
            int(row["available_cash_chips"]) + int(row["available_bonus_chips"])
            for row in await self.database.wallet_accounts.find({}).to_list(length=None)
        )
        self.assertEqual(total_mirrors, total_wallet)

    async def test_restricted_bonus_cannot_fund_peer_to_peer_rummy(self):
        with self.assertRaisesRegex(
            finance.FinancialError, "cannot fund peer-to-peer Rummy",
        ):
            await ledger.debit_chips(
                "player-1", 10, "Rummy bonus attempt", ref="rummy-bonus",
                kind=ledger.STAKE, game="rummy", session=None,
            )
        await self.assert_conserved()

    async def test_bonus_lots_preserve_two_grant_origins_through_spend_and_refund(self):
        await self.database.users.insert_one({"id": "player-lots", "chip_balance": 0})
        await self.database.wallet_accounts.insert_one({
            "id": "wallet-lots", "user_id": "player-lots",
            "available_cash_chips": 0, "available_bonus_chips": 0,
            "held_cash_chips": 0, "version": 1,
        })
        await self.database.wager_missions.insert_one({
            "id": "mission-lot-1", "user_id": "player-lots", "status": "CLAIMED",
            "campaign_id": "campaign-lot", "campaign_version": 3,
            "progress_percent": 100, "remaining_chips": 0,
            "forfeit_allowed": False,
        })
        await finance.apply_wallet_movement(
            user_id="player-lots", kind="PROMOTION_REWARD",
            source_key="mission-claim:mission-lot-1",
            idempotency_key="mission-claim:mission-lot-1",
            deltas={"available_bonus_chips": 60}, mirror_user_delta=60,
            metadata={
                "mission_id": "mission-lot-1", "campaign_id": "campaign-lot",
                "campaign_version": 3, "terms_version": "terms-v3",
                "restriction_reason": "Mission bonus remains non-withdrawable.",
            }, session=None,
        )
        await finance.apply_wallet_movement(
            user_id="player-lots", kind="REFERRAL_REWARD",
            source_key="referral-task-set:referral-lot-1",
            idempotency_key="referral-task-set:referral-lot-1",
            deltas={"available_bonus_chips": 40}, mirror_user_delta=40,
            metadata={
                "referral_claim_id": "referral-claim-1",
                "restriction_reason": "Referral bonus remains non-withdrawable.",
            }, session=None,
        )

        await ledger.debit_chips(
            "player-lots", 30, "partial bonus spend", ref="lot-bet-1",
            kind=ledger.STAKE, game="aviator", session=None,
        )
        stake = await self.database.chip_transactions.find_one({
            "user_id": "player-lots", "kind": ledger.STAKE, "ref": "lot-bet-1",
        })
        self.assertEqual(stake["funding_allocation"]["bonus_chips"], 30)
        self.assertEqual(sum(
            int(item["chips"]) for item in stake["funding_allocation"]["bonus_lots"]
        ), 30)

        error = await finance.withdrawal_exceeded_error("player-lots", 1)
        sources = error.details["restricted_bonus_sources"]
        self.assertEqual(sum(int(item["remaining_chips"]) for item in sources), 70)
        self.assertEqual(
            {item.get("mission_id") for item in sources if item.get("mission_id")},
            {"mission-lot-1"},
        )
        self.assertEqual(
            {item.get("referral_claim_id") for item in sources if item.get("referral_claim_id")},
            {"referral-claim-1"},
        )
        self.assertEqual(error.details["active_mission"]["id"], "mission-lot-1")

        await ledger.credit_chips(
            "player-lots", 30, "exact source refund", ref="lot-refund-1",
            source_refs=["lot-bet-1"], kind=ledger.REFUND,
            game="aviator", session=None,
        )
        restored = await finance.bonus_lots_public("player-lots")
        self.assertEqual(sum(int(item["remaining_chips"]) for item in restored), 100)
        mission_lot = next(item for item in restored if item.get("mission_id") == "mission-lot-1")
        referral_lot = next(
            item for item in restored if item.get("referral_claim_id") == "referral-claim-1"
        )
        self.assertEqual(mission_lot["remaining_chips"], 60)
        self.assertEqual(referral_lot["remaining_chips"], 40)


if __name__ == "__main__":
    unittest.main()
