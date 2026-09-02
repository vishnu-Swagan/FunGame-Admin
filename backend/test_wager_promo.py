"""Deposit wager lock, Free Cash new-device rule, and SgPay payout adapter."""
from __future__ import annotations

import os
import sys
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

from mongomock_motor import AsyncMongoMockClient

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("MONGO_URL", "mongodb://127.0.0.1:27017")
os.environ.setdefault("DB_NAME", "wager_promo_test")
os.environ["APP_ENV"] = "test"

import wager  # noqa: E402
import free_cash  # noqa: E402
from payment_providers import PayoutSubmission, SgPay24PaymentProvider  # noqa: E402


PROVIDER_ENV = {
    "PAYMENT_PROVIDER": "sgpay24",
    "SGPAY24_MERCHANT_ID": "MERTEST123",
    "SGPAY24_API_TOKEN": "test-only-api-token-1234567890",
    "SGPAY24_CUSTOMER_EMAIL_FALLBACK": "payments@example.com",
    "SGPAY24_TIMEOUT_SECONDS": "7",
    "PAYMENT_RETURN_URL": "https://play.example.com/chips/deposit/return",
}


class WagerPromoTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.client = AsyncMongoMockClient()
        self.db = self.client["wager_promo_test"]
        self._orig = {
            "wager": wager.db,
            "free": free_cash.db,
        }
        wager.db = self.db
        free_cash.db = self.db

    async def asyncTearDown(self):
        wager.db = self._orig["wager"]
        free_cash.db = self._orig["free"]

    async def test_deposit_bucket_consumed_by_stakes_then_withdraw_clears(self):
        await wager.open_deposit_bucket("u1", 1000, "dep-1")
        self.assertEqual(await wager.remaining_deposit_wager("u1"), 1000)
        with self.assertRaises(wager.WagerBlocked):
            await wager.require_clear_for_withdrawal("u1")
        await wager.consume_stake("u1", 400)
        self.assertEqual(await wager.remaining_deposit_wager("u1"), 600)
        await wager.consume_stake("u1", 600)
        self.assertEqual(await wager.remaining_deposit_wager("u1"), 0)
        await wager.require_clear_for_withdrawal("u1")

    async def test_bonus_campaign_counts_same_stakes(self):
        await wager.save_settings({
            "bonus_on": "every_deposit",
            "bonus_amount_inr": 500,
            "bonus_wager_multiplier": 2,
            "bonus_duration_hours": 84,
            "deposit_wager_multiplier": 1,
        }, "test")
        with patch.object(wager, "chips_per_inr", return_value=1):
            await wager.open_deposit_bucket("u2", 10, "dep-2")
            state = await wager.public_state("u2")
            self.assertTrue(state["overlay"]["show_fullscreen"])
            self.assertIn("to wager", state["bonus"]["copy"])
            await wager.consume_stake("u2", 1000)
            later = await wager.public_state("u2")
            self.assertIsNone(later["bonus"])

    async def test_free_cash_new_device_only(self):
        await free_cash._wallet("inviter")
        inv = await self.db.free_cash_wallets.find_one({"user_id": "inviter"})
        code = inv["invite_code"]
        await free_cash.on_player_registered(
            {"id": "friend-a", "referral_code": code}, "device-aaaa-1111",
        )
        first = await free_cash.public_state("inviter")
        self.assertGreater(first["balance_paise"], 0)
        await free_cash.on_player_registered(
            {"id": "friend-b", "referral_code": code}, "device-aaaa-1111",
        )
        second = await free_cash.public_state("inviter")
        self.assertEqual(second["balance_paise"], first["balance_paise"])

    async def test_sgpay24_submit_payout_no_longer_disabled(self):
        adapter = SgPay24PaymentProvider(PROVIDER_ENV)
        adapter._request_json = AsyncMock(return_value={
            "status": "SUCCESS",
            "data": {"payout_id": "po-1", "order_id": "wd-12345678", "status": "PROCESSING"},
        })
        result = await adapter.submit_payout(
            withdrawal_id="wd-12345678",
            provider_beneficiary_id="bank-1",
            amount_paise=100000,
            currency="INR",
            idempotency_key="op-wd-wd-12345678",
            account_holder_name="Test Player",
            account_number="12345678901",
            ifsc_code="HDFC0000001",
            payout_identifier="",
        )
        self.assertIsInstance(result, PayoutSubmission)
        self.assertEqual(result.provider_payout_id, "po-1")
        adapter._request_json.assert_awaited()


if __name__ == "__main__":
    unittest.main()
