"""Executable coverage for the always-on signup/referral wallet policy."""
import asyncio
import os
import unittest

from mongomock_motor import AsyncMongoMockClient

os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
os.environ.setdefault("DB_NAME", "bonus_policy_import_test")

import bonus_policy
import financial_wallet as finance
import game_wallet
import ledger
import wager


class BonusPolicyTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.saved_env = {
            key: os.environ.get(key)
            for key in (
                "APP_ENV", "CHAKRI_BONUS_POLICY_ENABLED",
                "FINANCIAL_ALLOW_NON_TRANSACTIONAL_TESTS",
                "PROMOTIONS_PUBLIC_APP_ORIGIN",
            )
        }
        os.environ.update({
            "APP_ENV": "test",
            "CHAKRI_BONUS_POLICY_ENABLED": "true",
            "FINANCIAL_ALLOW_NON_TRANSACTIONAL_TESTS": "true",
            "PROMOTIONS_PUBLIC_APP_ORIGIN": "https://chakri.casino",
        })
        self.client = AsyncMongoMockClient()
        self.db = self.client["bonus_policy_test"]
        self.original = {
            "bonus": bonus_policy.db,
            "finance": finance.db,
            "game": game_wallet.db,
            "ledger": ledger.db,
            "wager": wager.db,
            "ready": bonus_policy._READY,
            "stake_guards": list(ledger._stake_guards),
            "observers": list(ledger._ledger_observers),
            "source_adapter": ledger._source_wallet_adapter,
        }
        bonus_policy.db = self.db
        finance.db = self.db
        game_wallet.db = self.db
        ledger.db = self.db
        wager.db = self.db
        ledger._stake_guards = []
        ledger._ledger_observers = []
        ledger._source_wallet_adapter = None
        game_wallet.install()
        bonus_policy.install_ledger_observer()
        await bonus_policy.prepare()

    async def asyncTearDown(self):
        bonus_policy.db = self.original["bonus"]
        finance.db = self.original["finance"]
        game_wallet.db = self.original["game"]
        ledger.db = self.original["ledger"]
        wager.db = self.original["wager"]
        bonus_policy._READY = self.original["ready"]
        ledger._stake_guards = self.original["stake_guards"]
        ledger._ledger_observers = self.original["observers"]
        ledger._source_wallet_adapter = self.original["source_adapter"]
        for key, value in self.saved_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        self.client.close()

    async def _player(self, user_id: str, *, participant: bool = True) -> dict:
        row = {
            "id": user_id, "role": "PLAYER", "status": "ACTIVE",
            "chip_balance": 0, "country": "IN",
        }
        if participant:
            row.update(bonus_policy.signup_user_fields())
        await self.db.users.insert_one(row)
        return row

    async def test_signup_grant_is_exactly_once_and_restricted(self):
        await self._player("new-player")

        first = await bonus_policy.grant_signup_bonus(
            "new-player", source="SELF_SERVICE_PHONE_OTP",
        )
        duplicate = await bonus_policy.grant_signup_bonus(
            "new-player", source="SELF_SERVICE_PHONE_OTP",
        )

        self.assertFalse(first["duplicate"])
        self.assertTrue(duplicate["duplicate"])
        user = await self.db.users.find_one({"id": "new-player"})
        wallet = await finance.wallet_public("new-player")
        self.assertEqual(user["chip_balance"], 1_000)
        self.assertEqual(wallet["cash_chips"], 0)
        self.assertEqual(wallet["bonus_chips"], 1_000)
        self.assertEqual(wallet["withdrawable_chips"], 0)
        self.assertEqual(await self.db.chip_transactions.count_documents({
            "user_id": "new-player", "ref": "signup-bonus:new-player",
        }), 1)

    async def test_concurrent_signup_grants_cannot_double_credit(self):
        await self._player("concurrent-player")

        results = await asyncio.gather(*[
            bonus_policy.grant_signup_bonus(
                "concurrent-player", source="SELF_SERVICE_PHONE_OTP",
            ) for _ in range(8)
        ])

        self.assertEqual(sum(not row["duplicate"] for row in results), 1)
        user = await self.db.users.find_one({"id": "concurrent-player"})
        wallet = await finance.wallet_public("concurrent-player")
        self.assertEqual(user["chip_balance"], 1_000)
        self.assertEqual(wallet["bonus_chips"], 1_000)

    async def test_settled_bonus_play_progressively_unlocks_real_chips(self):
        await self._player("playing-player")
        await bonus_policy.grant_signup_bonus(
            "playing-player", source="SELF_SERVICE_PHONE_OTP",
        )

        await ledger.debit_chips(
            "playing-player", 100, "Aviator stake", ref="bet-1",
            kind=ledger.STAKE, game="aviator",
        )
        await ledger.credit_chips(
            "playing-player", 150, "Aviator payout", ref="win-1",
            kind=ledger.PAYOUT, game="aviator", source_refs=["bet-1"],
        )
        await ledger.record_settlement(
            "playing-player", ["bet-1"], "aviator", settlement_ref="round-1",
        )

        wallet = await finance.wallet_public("playing-player")
        self.assertEqual(wallet["available_chips"], 1_050)
        self.assertEqual(wallet["cash_chips"], 100)
        self.assertEqual(wallet["bonus_chips"], 950)
        conversion = await self.db.bonus_wager_conversions.find_one({
            "user_id": "playing-player",
        })
        self.assertEqual(conversion["settled_bonus_stake_chips"], 100)
        self.assertEqual(conversion["converted_real_chips"], 100)

    async def test_inr_deposit_match_and_two_level_referrals_credit_once(self):
        await self._player("grandparent", participant=False)
        await self._player("direct", participant=False)
        await self._player("depositor")
        grandparent_profile = await bonus_policy.get_or_create_referral_profile("grandparent")
        await bonus_policy.attach_referral(
            "direct", grandparent_profile["invite_code"],
            jurisdiction="IN", consented_at=bonus_policy.now(),
        )
        direct_profile = await bonus_policy.get_or_create_referral_profile("direct")
        await bonus_policy.attach_referral(
            "depositor", direct_profile["invite_code"],
            jurisdiction="IN", consented_at=bonus_policy.now(),
        )

        await ledger.credit_chips(
            "depositor", 100, "Verified deposit", ref="deposit-cash:one",
            kind=ledger.DEPOSIT,
        )
        result = await bonus_policy.on_deposit_credited(
            "depositor", "deposit-one", amount_paise=10_000, chips=100,
        )
        duplicate = await bonus_policy.on_deposit_credited(
            "depositor", "deposit-one", amount_paise=10_000, chips=100,
        )

        self.assertEqual(result["deposit_bonus"]["bonus_chips"], 100)
        self.assertIsNone(duplicate["deposit_bonus"])
        depositor_wallet = await finance.wallet_public("depositor")
        direct_wallet = await finance.wallet_public("direct")
        grandparent_wallet = await finance.wallet_public("grandparent")
        self.assertEqual(depositor_wallet["cash_chips"], 100)
        self.assertEqual(depositor_wallet["bonus_chips"], 100)
        self.assertEqual(direct_wallet["cash_chips"], 10)
        self.assertEqual(grandparent_wallet["cash_chips"], 5)
        self.assertEqual(await self.db.bonus_referral_rewards.count_documents({}), 2)

    async def test_deposit_match_waits_until_playing_chips_are_finished(self):
        await self._player("waiting-player")
        await bonus_policy.grant_signup_bonus(
            "waiting-player", source="SELF_SERVICE_PHONE_OTP",
        )
        await ledger.credit_chips(
            "waiting-player", 100, "Verified deposit", ref="deposit-cash:early",
            kind=ledger.DEPOSIT,
        )

        result = await bonus_policy.on_deposit_credited(
            "waiting-player", "deposit-early", amount_paise=10_000, chips=100,
        )

        self.assertIsNone(result["deposit_bonus"])
        self.assertEqual(
            await self.db.first_deposit_bonus_claims.count_documents({}), 0,
        )

    async def test_deposit_match_is_one_for_one_through_five_thousand_only(self):
        await self._player("boundary-player")
        await ledger.credit_chips(
            "boundary-player", 5_000, "Verified deposit",
            ref="upi-chip:boundary", kind=ledger.DEPOSIT,
        )
        result = await bonus_policy.on_deposit_credited(
            "boundary-player", "deposit-boundary",
            amount_paise=500_000, chips=5_000,
        )
        self.assertEqual(result["deposit_bonus"]["bonus_chips"], 5_000)

        await self._player("above-boundary-player")
        await ledger.credit_chips(
            "above-boundary-player", 5_001, "Verified deposit",
            ref="upi-chip:above-boundary", kind=ledger.DEPOSIT,
        )
        above = await bonus_policy.on_deposit_credited(
            "above-boundary-player", "deposit-above-boundary",
            amount_paise=500_100, chips=5_001,
        )
        self.assertIsNone(above["deposit_bonus"])

    async def test_daily_withdrawal_requests_share_one_five_hundred_rupee_cap(self):
        await self._player("withdraw-player")

        first = await bonus_policy.reserve_daily_withdrawal(
            "withdraw-player", "withdraw-one", 30_000,
        )
        second = await bonus_policy.reserve_daily_withdrawal(
            "withdraw-player", "withdraw-two", 20_000,
        )
        duplicate = await bonus_policy.reserve_daily_withdrawal(
            "withdraw-player", "withdraw-two", 20_000,
        )

        self.assertEqual(first["remaining_paise"], 20_000)
        self.assertEqual(second["remaining_paise"], 0)
        self.assertTrue(duplicate["duplicate"])
        with self.assertRaises(bonus_policy.BonusPolicyError) as blocked:
            await bonus_policy.reserve_daily_withdrawal(
                "withdraw-player", "withdraw-three", 100,
            )
        self.assertEqual(blocked.exception.code, "DAILY_WITHDRAWAL_LIMIT")
        self.assertTrue(await bonus_policy.release_daily_withdrawal(
            "withdraw-player", "withdraw-one", 30_000,
        ))
        state = await bonus_policy.daily_withdrawal_state("withdraw-player")
        self.assertEqual(state["used_paise"], 20_000)
        self.assertEqual(state["remaining_paise"], 30_000)


if __name__ == "__main__":
    unittest.main()
