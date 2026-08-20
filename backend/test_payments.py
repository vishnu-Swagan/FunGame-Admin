"""Focused financial-core safety and idempotency tests (no network or real money)."""
from __future__ import annotations

import asyncio
import base64
import json
import os
import sys
import time
import types
import unittest
from datetime import timedelta

from fastapi import HTTPException
from mongomock_motor import AsyncMongoMockClient


HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

os.environ.update({
    "APP_ENV": "test",
    "REAL_MONEY_ENABLED": "true",
    "DEPOSITS_ENABLED": "true",
    "WITHDRAWALS_ENABLED": "true",
    "AUTO_WITHDRAWALS_ENABLED": "true",
    "FINANCIAL_GAME_WALLET_INTEGRATED": "true",
    "FINANCIAL_ALLOW_NON_TRANSACTIONAL_TESTS": "true",
    "FINANCIAL_ALLOWED_COUNTRIES": "IN",
    "PAYMENT_PROVIDER": "mock",
    "PAYMENT_WEBHOOK_SECRET": "payment-test-secret-32-characters-minimum",
    "PAYMENT_WEBHOOK_TOLERANCE_SECONDS": "300",
    "PAYOUT_DATA_ACTIVE_KEY_VERSION": "v1",
    "PAYOUT_DATA_KEY_V1": base64.urlsafe_b64encode(b"a" * 32).decode("ascii"),
    "PAYOUT_DATA_FINGERPRINT_KEY": base64.urlsafe_b64encode(b"b" * 32).decode("ascii"),
    "CHIPS_PER_INR": "1",
    "CHIP_RATE_VERSION": "test-v1",
    "MIN_DEPOSIT_PAISE": "10000",
    "MAX_DEPOSIT_PAISE": "1000000",
    "MIN_WITHDRAWAL_CHIPS": "10",
    "MAX_WITHDRAWAL_CHIPS": "1000000",
})

client = AsyncMongoMockClient()
db = client["financial_core_test"]
sys.modules["db"] = types.SimpleNamespace(db=db, client=client)

import financial_wallet as finance  # noqa: E402
import routes_payments as routes  # noqa: E402
from payment_providers import (  # noqa: E402
    DepositStatus,
    MockPaymentProvider,
    PayoutStatus,
    ProviderConfigurationError,
    WebhookVerificationError,
    load_payment_provider,
)


class ControllableProvider(MockPaymentProvider):
    def __init__(self):
        super().__init__(os.environ["PAYMENT_WEBHOOK_SECRET"])
        self.deposit_calls = 0
        self.deposit_failures = 0
        self.submit_calls = 0
        self.submit_failures = 0
        self.payment_status = "PENDING"
        self.payout_status = "PROCESSING"
        self.payment_amount_override = None
        self.payment_currency_override = None
        self.payment_reference_override = None

    async def create_deposit_order(self, **kwargs):
        self.deposit_calls += 1
        if self.deposit_failures:
            self.deposit_failures -= 1
            raise RuntimeError("sandbox unavailable")
        return await super().create_deposit_order(**kwargs)

    async def submit_payout(self, **kwargs):
        self.submit_calls += 1
        if self.submit_failures:
            self.submit_failures -= 1
            # Model the dangerous timeout case: the provider accepted the
            # idempotent instruction but its response was lost.
            await super().submit_payout(**kwargs)
            raise TimeoutError("unknown sandbox outcome")
        return await super().submit_payout(**kwargs)

    async def get_payment_status(self, provider_order_id):
        authoritative = await super().get_payment_status(provider_order_id)
        return DepositStatus(
            status=self.payment_status,
            amount_paise=(
                self.payment_amount_override
                if self.payment_amount_override is not None
                else authoritative.amount_paise
            ),
            currency=(
                self.payment_currency_override
                if self.payment_currency_override is not None
                else authoritative.currency
            ),
            provider_reference=(
                self.payment_reference_override
                if self.payment_reference_override is not None
                else authoritative.provider_reference
            ),
        )

    async def get_payout_status(self, provider_payout_id):
        authoritative = await super().get_payout_status(provider_payout_id)
        return PayoutStatus(
            status=self.payout_status,
            amount_paise=authoritative.amount_paise,
            currency=authoritative.currency,
            withdrawal_id=authoritative.withdrawal_id,
            idempotency_key=authoritative.idempotency_key,
            provider_beneficiary_id=authoritative.provider_beneficiary_id,
            provider_reference=authoritative.provider_reference,
        )


def signed_event(provider, payload):
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return provider.verify_webhook(raw, provider.sign_webhook(raw)), raw


async def seed_cash(user_id: str, amount: int):
    return await finance.apply_wallet_movement(
        user_id=user_id, kind="TEST_CASH_CREDIT",
        source_key=f"test-cash:{user_id}:{amount}",
        idempotency_key=f"test-cash:{user_id}:{amount}",
        deltas={"available_cash_chips": amount}, mirror_user_delta=amount,
    )


class FinancialCoreTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        for name in await db.list_collection_names():
            await db[name].delete_many({})
        # Tests exercise the isolated wallet domain. Production builds retain
        # the module's immutable default False until gameplay is certified.
        finance.GAME_WALLET_INTEGRATION_READY = True
        status = await finance.prepare_financial_core()
        self.assertTrue(status["ready"], status)
        self.provider = ControllableProvider()
        self.user = {
            "id": "player-1", "role": "PLAYER", "status": "ACTIVE",
            "chip_balance": 1000, "email_verified": True, "phone_verified": False,
            "contact_verified": True,
            "age_verified": True, "kyc_status": "VERIFIED", "country": "IN",
            "financial_status": "ACTIVE",
        }
        await db.users.insert_one(dict(self.user))

    async def test_wallet_read_is_non_mutating_and_legacy_is_never_cash(self):
        wallet = await finance.wallet_public(self.user["id"])
        self.assertEqual(wallet["bonus_chips"], 1000)
        self.assertEqual(wallet["cash_chips"], 0)
        self.assertEqual(wallet["withdrawable_chips"], 0)
        self.assertEqual(await db.wallet_accounts.count_documents({}), 0)

    async def test_deposit_retries_provider_gap_and_webhook_credits_exactly_once(self):
        self.provider.deposit_failures = 1
        with self.assertRaises(finance.FinancialError) as failed:
            await finance.create_deposit("player-1", 10000, "deposit-idem-0001", self.provider)
        self.assertEqual(failed.exception.code, "PAYMENT_PROVIDER_UNAVAILABLE")
        order, checkout = await finance.create_deposit(
            "player-1", 10000, "deposit-idem-0001", self.provider,
        )
        self.assertEqual(order["status"], "PENDING")
        self.assertTrue(checkout.startswith("https://mock-payments.invalid/"))
        self.assertEqual(await db.deposit_orders.count_documents({}), 1)
        self.assertEqual((await db.users.find_one({"id": "player-1"}))["chip_balance"], 1000)

        event, raw = signed_event(self.provider, {
            "id": "evt-deposit-paid-1", "type": "deposit.paid",
            "object_id": order["provider_order_id"], "amount_paise": 10000,
            "currency": "INR", "provider_reference": "provider-payment-1",
        })
        first = await finance.process_provider_event(self.provider, event, raw)
        second = await finance.process_provider_event(self.provider, event, raw)
        self.assertEqual(first["status"], "CREDITED")
        self.assertTrue(second["duplicate"])
        wallet = await finance.wallet_public("player-1")
        self.assertEqual((wallet["cash_chips"], wallet["bonus_chips"]), (100, 1000))
        self.assertEqual((await db.users.find_one({"id": "player-1"}))["chip_balance"], 1100)
        self.assertEqual(await db.wallet_operations.count_documents({"kind": "DEPOSIT_CREDIT"}), 1)
        self.assertEqual(await db.chip_transactions.count_documents({"kind": "DEPOSIT"}), 1)

        mismatch, mismatch_raw = signed_event(self.provider, {
            "id": "evt-deposit-paid-mismatch", "type": "deposit.paid",
            "object_id": order["provider_order_id"], "amount_paise": 10100,
            "currency": "INR", "provider_reference": "provider-payment-wrong",
        })
        with self.assertRaises(finance.FinancialError) as wrong:
            await finance.process_provider_event(self.provider, mismatch, mismatch_raw)
        self.assertEqual(wrong.exception.code, "PAYMENT_MISMATCH")
        stored = await db.deposit_orders.find_one({"id": order["id"]})
        self.assertEqual(stored["status"], "CREDITED")
        failed_event = await db.provider_webhook_events.find_one({"event_id": mismatch.event_id})
        self.assertEqual(failed_event["status"], "REVIEW_REQUIRED")

    async def test_retryable_and_stale_webhook_can_be_reprocessed_hash_safely(self):
        order, _ = await finance.create_deposit(
            "player-1", 10000, "deposit-idem-retry", self.provider,
        )
        saved = await db.deposit_orders.find_one({"id": order["id"]}, {"_id": 0})
        await db.deposit_orders.delete_one({"id": order["id"]})
        event, raw = signed_event(self.provider, {
            "id": "evt-retryable", "type": "deposit.paid",
            "object_id": order["provider_order_id"], "amount_paise": 10000,
            "currency": "INR", "provider_reference": "provider-payment-retry",
        })
        with self.assertRaises(finance.FinancialError):
            await finance.process_provider_event(self.provider, event, raw)
        await db.deposit_orders.insert_one(saved)
        await db.provider_webhook_events.update_one(
            {"event_id": event.event_id},
            {"$set": {"status": "PROCESSING", "lease_until": finance.now() - timedelta(seconds=1)}},
        )
        repaired = await finance.process_provider_event(self.provider, event, raw)
        self.assertEqual(repaired["status"], "CREDITED")

        conflict_payload = json.loads(raw)
        conflict_payload["provider_reference"] = "different-body"
        conflict_raw = json.dumps(conflict_payload, sort_keys=True, separators=(",", ":")).encode()
        conflict = self.provider.verify_webhook(conflict_raw, self.provider.sign_webhook(conflict_raw))
        with self.assertRaises(finance.FinancialError) as duplicate_conflict:
            await finance.process_provider_event(self.provider, conflict, conflict_raw)
        self.assertEqual(duplicate_conflict.exception.code, "WEBHOOK_EVENT_CONFLICT")

    async def test_refund_before_paid_is_terminal_and_never_credits(self):
        order, _ = await finance.create_deposit(
            "player-1", 10000, "deposit-idem-refund", self.provider,
        )
        refunded, refund_raw = signed_event(self.provider, {
            "id": "evt-refund-first", "type": "deposit.refunded",
            "object_id": order["provider_order_id"], "amount_paise": 10000,
            "currency": "INR", "provider_reference": "refund-first",
        })
        await finance.process_provider_event(self.provider, refunded, refund_raw)
        paid, paid_raw = signed_event(self.provider, {
            "id": "evt-paid-late", "type": "deposit.paid",
            "object_id": order["provider_order_id"], "amount_paise": 10000,
            "currency": "INR", "provider_reference": "paid-too-late",
        })
        with self.assertRaises(finance.FinancialError) as late:
            await finance.process_provider_event(self.provider, paid, paid_raw)
        self.assertEqual(late.exception.code, "DEPOSIT_ALREADY_REFUNDED")
        self.assertEqual((await finance.wallet_public("player-1"))["cash_chips"], 0)

    async def test_reconciliation_repairs_a_missed_deposit_webhook(self):
        order, _ = await finance.create_deposit(
            "player-1", 10000, "deposit-idem-reconcile", self.provider,
        )
        self.provider.payment_status = "PAID"
        result = await finance.reconcile_deposit(order["id"], self.provider, actor="admin-1")
        self.assertEqual(result["status"], "CREDITED")
        self.assertEqual((await finance.wallet_public("player-1"))["cash_chips"], 100)
        again = await finance.reconcile_deposit(order["id"], self.provider, actor="admin-1")
        self.assertTrue(again["duplicate"])
        self.assertEqual(await db.wallet_operations.count_documents({"kind": "DEPOSIT_CREDIT"}), 1)

    async def test_missed_post_credit_refund_is_reconciled_within_bounded_window(self):
        order, _ = await finance.create_deposit(
            "player-1", 10000, "deposit-late-refund-poll", self.provider,
        )
        paid, raw = signed_event(self.provider, {
            "id": "evt-late-refund-original-payment", "type": "deposit.paid",
            "object_id": order["provider_order_id"], "amount_paise": 10000,
            "currency": "INR", "provider_reference": "late-refund-payment-ref",
        })
        await finance.process_provider_event(self.provider, paid, raw)
        credited = await db.deposit_orders.find_one({"id": order["id"]})
        self.assertGreater(
            finance._parse_optional_datetime(credited["refund_reconcile_until"]), finance.now(),
        )
        await db.deposit_orders.update_one(
            {"id": order["id"]}, {"$set": {"next_reconcile_at": finance.now()}},
        )
        self.provider.payment_status = "REFUNDED"
        self.provider.payment_reference_override = "late-provider-refund-ref"
        result = await finance.reconcile_financial_records(self.provider, limit=1)
        self.assertEqual(result["checked_deposits"], 1)
        self.assertEqual((await finance.wallet_public("player-1"))["cash_chips"], 0)
        self.assertEqual(
            (await db.deposit_orders.find_one({"id": order["id"]}))["status"], "REFUNDED",
        )

    async def test_bank_details_are_encrypted_masked_and_soft_deactivated(self):
        method = await finance.create_payout_method(
            "player-1", account_holder_name="Test Player", bank_name="Test Bank",
            account_number="123456789012", ifsc_code="ABCD0123456",
            payout_identifier="player@bank",
        )
        stored = await db.payout_methods.find_one({"id": method["id"]}, {"_id": 0})
        serialized = json.dumps(stored, default=str)
        self.assertNotIn("123456789012", serialized)
        self.assertNotIn("player@bank", serialized)
        self.assertEqual(finance.decrypt_payout_details(stored)["account_number"], "123456789012")
        dto = finance.payout_method_dto(stored)
        self.assertEqual(dto["account_number_masked"], "•••• 9012")

        await seed_cash("player-1", 1000)
        withdrawal = await finance.create_withdrawal(
            "player-1", 500, method["id"], "withdraw-idem-bank", self.provider,
        )
        with self.assertRaises(finance.FinancialError) as in_use:
            await finance.deactivate_payout_method("player-1", method["id"])
        self.assertEqual(in_use.exception.code, "BANK_DETAILS_IN_USE")
        await finance.reject_withdrawal(withdrawal["id"], "admin-1", "Manual review rejected")
        await db.payout_methods.update_one(
            {"id": method["id"]}, {"$set": {"provider_beneficiary_id": "stale-beneficiary"}},
        )
        inactive = await finance.deactivate_payout_method("player-1", method["id"])
        self.assertEqual(inactive["status"], "INACTIVE")
        with self.assertRaises(finance.FinancialError) as inactive_method:
            await finance.create_withdrawal(
                "player-1", 100, method["id"], "withdraw-inactive-bank", self.provider,
            )
        self.assertEqual(inactive_method.exception.code, "BANK_DETAILS_NOT_FOUND")
        reactivated = await finance.create_payout_method(
            "player-1", account_holder_name="Corrected Player", bank_name="Test Bank",
            account_number="123456789012", ifsc_code="ABCD0123456",
            payout_identifier="player@bank",
        )
        self.assertEqual((reactivated["id"], reactivated["status"]), (method["id"], "ACTIVE"))
        self.assertIsNone(reactivated["provider_beneficiary_id"])
        self.assertEqual(
            finance.decrypt_payout_details(reactivated)["account_holder_name"], "Corrected Player",
        )
        self.assertEqual(await db.financial_audit.count_documents({
            "action": "PAYOUT_METHOD_REACTIVATED",
        }), 1)

    async def test_manual_withdrawal_never_calls_provider_and_finalizes_once(self):
        await seed_cash("player-1", 1000)
        method = await finance.create_payout_method(
            "player-1", account_holder_name="Test Player", bank_name="Test Bank",
            account_number="123456789012", ifsc_code="ABCD0123456",
        )
        withdrawal = await finance.create_withdrawal(
            "player-1", 500, method["id"], "withdraw-idem-manual", self.provider,
        )
        self.assertEqual(withdrawal["status"], "PENDING_ADMIN")
        approved = await finance.approve_withdrawal(withdrawal["id"], "admin-1")
        self.assertEqual(approved["withdrawal_mode"], "MANUAL")
        self.assertEqual(await db.financial_outbox.count_documents({}), 0)
        self.assertEqual(self.provider.submit_calls, 0)
        submitted = await finance.mark_withdrawal_submitted(
            withdrawal["id"], "admin-1", "manual-provider-ref-1",
        )
        self.assertEqual(submitted["provider_payout_id"], "manual-provider-ref-1")
        await finance.mark_withdrawal_paid(
            withdrawal["id"], "admin-1", "manual-provider-ref-1", manual_only=True,
        )
        await finance.mark_withdrawal_paid(
            withdrawal["id"], "admin-1", "manual-provider-ref-1", manual_only=True,
        )
        wallet = await finance.wallet_public("player-1")
        self.assertEqual((wallet["cash_chips"], wallet["held_chips"]), (500, 0))
        self.assertEqual(await db.wallet_operations.count_documents({"kind": "WITHDRAWAL_PAID"}), 1)
        self.assertEqual(await db.financial_audit.count_documents({
            "action": "WITHDRAWAL_MARKED_PAID",
        }), 1)

    async def test_automatic_mode_requires_risk_and_pause_stops_submission(self):
        await seed_cash("player-1", 2000)
        method = await finance.create_payout_method(
            "player-1", account_holder_name="Test Player", bank_name="Test Bank",
            account_number="123456789012", ifsc_code="ABCD0123456",
        )
        await finance.set_withdrawal_mode("AUTOMATIC", "super-1", "Enable tested provider", self.provider)
        held_for_review = await finance.create_withdrawal(
            "player-1", 500, method["id"], "withdraw-risk-review", self.provider,
        )
        self.assertEqual(held_for_review["status"], "PENDING_ADMIN")
        self.assertEqual(held_for_review["withdrawal_mode"], "MANUAL")
        await finance.reject_withdrawal(held_for_review["id"], "admin-1", "Risk not assessed")

        await db.users.update_one(
            {"id": "player-1"}, {"$set": {"financial_risk_status": "ELIGIBLE"}},
        )
        automatic = await finance.create_withdrawal(
            "player-1", 500, method["id"], "withdraw-auto-safe", self.provider,
        )
        self.assertEqual((automatic["status"], automatic["withdrawal_mode"]), ("APPROVED", "AUTOMATIC"))
        with self.assertRaises(finance.FinancialError) as manual_race:
            await finance.mark_withdrawal_submitted(
                automatic["id"], "admin-1", "must-not-submit-manually",
            )
        self.assertEqual(manual_race.exception.code, "AUTOMATIC_WITHDRAWAL")
        await finance.set_withdrawal_mode("MANUAL", "super-1", "Pause automatic payouts")
        paused = await finance.process_outbox_batch(self.provider)
        self.assertEqual((paused["processed"], self.provider.submit_calls), (0, 0))
        self.assertEqual((await db.financial_outbox.find_one({"aggregate_id": automatic["id"]}))["status"], "PAUSED")
        await finance.set_withdrawal_mode("AUTOMATIC", "super-1", "Resume tested provider", self.provider)
        processed = await finance.process_outbox_batch(self.provider)
        self.assertEqual((processed["processed"], self.provider.submit_calls), (1, 1))
        await finance.process_outbox_batch(self.provider)
        self.assertEqual(self.provider.submit_calls, 1)
        self.provider.payout_status = "PAID"
        reconciled = await finance.reconcile_withdrawal(
            automatic["id"], self.provider, actor="admin-1",
        )
        self.assertEqual(reconciled["status"], "PAID")
        self.assertEqual((await finance.wallet_public("player-1"))["held_chips"], 0)

    async def test_stale_outbox_lease_is_reclaimed_idempotently(self):
        await seed_cash("player-1", 1000)
        await db.users.update_one(
            {"id": "player-1"}, {"$set": {"financial_risk_status": "ELIGIBLE"}},
        )
        method = await finance.create_payout_method(
            "player-1", account_holder_name="Test Player", bank_name="Test Bank",
            account_number="123456789012", ifsc_code="ABCD0123456",
        )
        await finance.set_withdrawal_mode("AUTOMATIC", "super-1", "Enable tested provider", self.provider)
        withdrawal = await finance.create_withdrawal(
            "player-1", 500, method["id"], "withdraw-stale-outbox", self.provider,
        )
        await db.financial_outbox.update_one(
            {"aggregate_id": withdrawal["id"]},
            {"$set": {
                "status": "PROCESSING", "lease_until": finance.now() - timedelta(seconds=1),
            }},
        )
        result = await finance.process_outbox_batch(self.provider)
        self.assertEqual((result["processed"], self.provider.submit_calls), (1, 1))
        await finance.process_outbox_batch(self.provider)
        self.assertEqual(self.provider.submit_calls, 1)

    async def test_uncertain_automatic_payout_reference_can_be_recovered_and_reconciled(self):
        await seed_cash("player-1", 1000)
        await db.users.update_one(
            {"id": "player-1"}, {"$set": {"financial_risk_status": "ELIGIBLE"}},
        )
        method = await finance.create_payout_method(
            "player-1", account_holder_name="Test Player", bank_name="Test Bank",
            account_number="123456789012", ifsc_code="ABCD0123456",
        )
        await finance.set_withdrawal_mode("AUTOMATIC", "super-1", "Enable tested provider", self.provider)
        withdrawal = await finance.create_withdrawal(
            "player-1", 500, method["id"], "withdraw-unknown-result", self.provider,
        )
        self.provider.submit_failures = 1
        result = await finance.process_outbox_batch(self.provider)
        self.assertEqual(result["retry_scheduled"], 1)
        uncertain = await db.withdrawal_requests.find_one({"id": withdrawal["id"]})
        self.assertEqual(uncertain["status"], "SUBMISSION_UNKNOWN")
        outbox = await db.financial_outbox.find_one({"aggregate_id": withdrawal["id"]})
        await db.financial_outbox.update_one(
            {"id": outbox["id"]}, {"$set": {"next_attempt_at": finance.now()}},
        )
        retried = await finance.process_outbox_batch(self.provider)
        self.assertEqual(retried["processed"], 1)
        recovered = await db.withdrawal_requests.find_one({"id": withdrawal["id"]})
        self.assertTrue(recovered["provider_payout_id"].startswith("mock_payout_"))
        self.assertEqual(self.provider.submit_calls, 2)
        self.provider.payout_status = "PAID"
        paid = await finance.reconcile_withdrawal(withdrawal["id"], self.provider, actor="admin-1")
        self.assertEqual(paid["status"], "PAID")

    async def test_concurrent_idempotent_requests_do_not_double_move_balance(self):
        deposits = await asyncio.gather(*[
            finance.create_deposit(
                "player-1", 10000, "deposit-idem-concurrent", self.provider,
            ) for _ in range(8)
        ])
        self.assertEqual(await db.deposit_orders.count_documents({}), 1)
        self.assertEqual(len({row[0]["id"] for row in deposits}), 1)

        await seed_cash("player-1", 1000)
        method = await finance.create_payout_method(
            "player-1", account_holder_name="Test Player", bank_name="Test Bank",
            account_number="123456789012", ifsc_code="ABCD0123456",
        )
        withdrawals = await asyncio.gather(*[
            finance.create_withdrawal(
                "player-1", 500, method["id"], "withdraw-idem-concurrent", self.provider,
            ) for _ in range(8)
        ])
        self.assertEqual(await db.withdrawal_requests.count_documents({}), 1)
        self.assertEqual(len({row["id"] for row in withdrawals}), 1)
        wallet = await finance.wallet_public("player-1")
        self.assertEqual((wallet["cash_chips"], wallet["held_chips"]), (500, 500))

    async def test_pending_deposits_reserve_limits_atomically_and_release_on_failure(self):
        await db.player_limits.insert_one({
            "user_id": "player-1", "kind": "DEPOSIT", "period": "DAY", "amount": 150,
        })
        results = await asyncio.gather(
            finance.create_deposit(
                "player-1", 10000, "deposit-limit-reserve-a", self.provider,
            ),
            finance.create_deposit(
                "player-1", 10000, "deposit-limit-reserve-b", self.provider,
            ),
            return_exceptions=True,
        )
        successes = [row for row in results if not isinstance(row, Exception)]
        failures = [row for row in results if isinstance(row, finance.FinancialError)]
        self.assertEqual((len(successes), len(failures)), (1, 1))
        self.assertEqual(failures[0].code, "DEPOSIT_LIMIT")
        held = await db.deposit_orders.find_one({"limit_reservation_status": "HELD"})
        failed, raw = signed_event(self.provider, {
            "id": "evt-reservation-release", "type": "deposit.failed",
            "object_id": held["provider_order_id"],
        })
        await finance.process_provider_event(self.provider, failed, raw)
        self.assertEqual(
            (await db.deposit_orders.find_one({"id": held["id"]}))["limit_reservation_status"],
            "RELEASED",
        )
        replacement, _ = await finance.create_deposit(
            "player-1", 10000, "deposit-limit-replacement", self.provider,
        )
        self.assertEqual(replacement["limit_reservation_status"], "HELD")

    async def test_reconciliation_rejects_underpayment_and_partial_refund(self):
        order, _ = await finance.create_deposit(
            "player-1", 10000, "deposit-authoritative-status", self.provider,
        )
        self.provider.payment_status = "PAID"
        self.provider.payment_amount_override = 9900
        with self.assertRaises(finance.FinancialError) as underpaid:
            await finance.reconcile_deposit(order["id"], self.provider)
        self.assertEqual(underpaid.exception.code, "PAYMENT_MISMATCH")
        self.assertEqual((await finance.wallet_public("player-1"))["cash_chips"], 0)
        self.assertEqual(
            (await db.deposit_orders.find_one({"id": order["id"]}))["status"],
            "RECONCILIATION_REQUIRED",
        )

        self.provider.payment_amount_override = None
        await finance.reconcile_deposit(order["id"], self.provider)
        refund, raw = signed_event(self.provider, {
            "id": "evt-partial-refund", "type": "deposit.refunded",
            "object_id": order["provider_order_id"], "amount_paise": 5000,
            "currency": "INR", "provider_reference": "partial-refund-ref",
        })
        with self.assertRaises(finance.FinancialError) as partial:
            await finance.process_provider_event(self.provider, refund, raw)
        self.assertEqual(partial.exception.code, "REFUND_MISMATCH")
        self.assertEqual((await finance.wallet_public("player-1"))["cash_chips"], 100)
        self.assertEqual(
            (await db.users.find_one({"id": "player-1"}))["financial_status"],
            "REVIEW_REQUIRED",
        )

    async def test_refund_reference_cannot_reverse_two_deposits(self):
        orders = []
        for index in range(2):
            order, _ = await finance.create_deposit(
                "player-1", 10000, f"deposit-refund-reference-{index}", self.provider,
            )
            paid, raw = signed_event(self.provider, {
                "id": f"evt-payment-for-refund-{index}", "type": "deposit.paid",
                "object_id": order["provider_order_id"], "amount_paise": 10000,
                "currency": "INR", "provider_reference": f"payment-reference-{index}",
            })
            await finance.process_provider_event(self.provider, paid, raw)
            orders.append(order)
        for index, order in enumerate(orders):
            refunded, raw = signed_event(self.provider, {
                "id": f"evt-shared-refund-{index}", "type": "deposit.refunded",
                "object_id": order["provider_order_id"], "amount_paise": 10000,
                "currency": "INR", "provider_reference": "shared-refund-reference",
            })
            if index == 0:
                await finance.process_provider_event(self.provider, refunded, raw)
            else:
                with self.assertRaises(finance.FinancialError) as reused:
                    await finance.process_provider_event(self.provider, refunded, raw)
                self.assertEqual(reused.exception.code, "REFUND_REFERENCE_CONFLICT")
        self.assertEqual((await finance.wallet_public("player-1"))["cash_chips"], 100)

    async def test_idempotent_replay_uses_original_conversion_snapshot(self):
        deposit, _ = await finance.create_deposit(
            "player-1", 10000, "deposit-rate-snapshot", self.provider,
        )
        original_rate = os.environ["CHIPS_PER_INR"]
        os.environ["CHIPS_PER_INR"] = "2"
        try:
            replay, _ = await finance.create_deposit(
                "player-1", 10000, "deposit-rate-snapshot", self.provider,
            )
            self.assertEqual((replay["id"], replay["chips"]), (deposit["id"], 100))

            await seed_cash("player-1", 1000)
            method = await finance.create_payout_method(
                "player-1", account_holder_name="Test Player", bank_name="Test Bank",
                account_number="123456789012", ifsc_code="ABCD0123456",
            )
            withdrawal = await finance.create_withdrawal(
                "player-1", 500, method["id"], "withdraw-rate-snapshot", self.provider,
            )
            os.environ["CHIPS_PER_INR"] = "3"
            replay_withdrawal = await finance.create_withdrawal(
                "player-1", 500, method["id"], "withdraw-rate-snapshot", self.provider,
            )
            self.assertEqual(
                (replay_withdrawal["id"], replay_withdrawal["amount_paise"]),
                (withdrawal["id"], withdrawal["amount_paise"]),
            )
        finally:
            os.environ["CHIPS_PER_INR"] = original_rate

    async def test_mode_pause_between_claim_and_provider_call_blocks_submission(self):
        await seed_cash("player-1", 1000)
        await db.users.update_one(
            {"id": "player-1"}, {"$set": {"financial_risk_status": "ELIGIBLE"}},
        )
        method = await finance.create_payout_method(
            "player-1", account_holder_name="Test Player", bank_name="Test Bank",
            account_number="123456789012", ifsc_code="ABCD0123456",
        )
        await finance.set_withdrawal_mode("AUTOMATIC", "super-1", "Enable provider", self.provider)
        withdrawal = await finance.create_withdrawal(
            "player-1", 500, method["id"], "withdraw-pause-race", self.provider,
        )
        original_create_beneficiary = self.provider.create_beneficiary

        async def pause_during_preparation(**kwargs):
            beneficiary = await original_create_beneficiary(**kwargs)
            await finance.set_withdrawal_mode(
                "MANUAL", "super-1", "Pause during payout preparation",
            )
            return beneficiary

        self.provider.create_beneficiary = pause_during_preparation
        result = await finance.process_outbox_batch(self.provider)
        self.assertEqual((result["paused"], self.provider.submit_calls), (1, 0))
        stored = await db.withdrawal_requests.find_one({"id": withdrawal["id"]})
        self.assertEqual(stored["status"], "APPROVED")
        self.assertIsNone(stored.get("provider_payout_id"))

    async def test_reconciliation_queues_cannot_starve_each_other(self):
        for index in range(3):
            await finance.create_deposit(
                "player-1", 10000, f"deposit-starvation-{index}", self.provider,
            )
        await seed_cash("player-1", 1000)
        await db.users.update_one(
            {"id": "player-1"}, {"$set": {"financial_risk_status": "ELIGIBLE"}},
        )
        method = await finance.create_payout_method(
            "player-1", account_holder_name="Test Player", bank_name="Test Bank",
            account_number="123456789012", ifsc_code="ABCD0123456",
        )
        await finance.set_withdrawal_mode("AUTOMATIC", "super-1", "Enable provider", self.provider)
        await finance.create_withdrawal(
            "player-1", 500, method["id"], "withdraw-starvation", self.provider,
        )
        await finance.process_outbox_batch(self.provider)
        result = await finance.reconcile_financial_records(self.provider, limit=1)
        self.assertEqual((result["checked_deposits"], result["checked_withdrawals"]), (1, 1))

    async def test_recovered_foreign_payout_id_cannot_finalize_hold(self):
        await seed_cash("player-1", 1000)
        await db.users.update_one(
            {"id": "player-1"}, {"$set": {"financial_risk_status": "ELIGIBLE"}},
        )
        method = await finance.create_payout_method(
            "player-1", account_holder_name="Test Player", bank_name="Test Bank",
            account_number="123456789012", ifsc_code="ABCD0123456",
        )
        await finance.set_withdrawal_mode("AUTOMATIC", "super-1", "Enable provider", self.provider)
        withdrawal = await finance.create_withdrawal(
            "player-1", 500, method["id"], "withdraw-foreign-ref", self.provider,
        )
        self.provider.submit_failures = 1
        await finance.process_outbox_batch(self.provider)
        self.provider._payouts["foreign-paid-id"] = {
            "amount_paise": 50000, "currency": "INR",
            "withdrawal_id": "some-other-withdrawal",
            "idempotency_key": "withdrawal:some-other-withdrawal",
            "provider_beneficiary_id": "some-other-beneficiary",
        }
        await finance.attach_unknown_payout_reference(
            withdrawal["id"], "admin-1", "foreign-paid-id",
            "Recovered reference from provider dashboard",
        )
        self.provider.payout_status = "PAID"
        with self.assertRaises(finance.FinancialError) as mismatch:
            await finance.reconcile_withdrawal(withdrawal["id"], self.provider, actor="admin-1")
        self.assertEqual(mismatch.exception.code, "PAYOUT_BINDING_MISMATCH")
        self.assertEqual((await finance.wallet_public("player-1"))["held_chips"], 500)

    async def test_stale_precheckout_reservation_expires_and_releases(self):
        await db.player_limits.insert_one({
            "user_id": "player-1", "kind": "DEPOSIT", "period": "DAY", "amount": 100,
        })
        self.provider.deposit_failures = 1
        with self.assertRaises(finance.FinancialError):
            await finance.create_deposit(
                "player-1", 10000, "deposit-stale-reservation", self.provider,
            )
        stale = await db.deposit_orders.find_one({"idempotency_key": "deposit-stale-reservation"})
        await db.deposit_orders.update_one(
            {"id": stale["id"]},
            {"$set": {"created_at": finance.now() - timedelta(hours=1)}},
        )
        result = await finance.reconcile_deposit(stale["id"], self.provider)
        self.assertEqual(result["status"], "EXPIRED")
        replacement, _ = await finance.create_deposit(
            "player-1", 10000, "deposit-after-expiry", self.provider,
        )
        self.assertEqual(replacement["limit_reservation_status"], "HELD")

    async def test_permission_fallback_and_streaming_webhook_cap_fail_closed(self):
        explicit_empty = {
            "id": "admin-1", "role": "ADMIN", "status": "ACTIVE",
            "admin_role": "OPERATIONS", "admin_permissions": [],
            "permissions": ["PAYMENTS_RECONCILE", "WITHDRAWALS_MARK_PAID"],
            "mfa_enabled": True, "mfa_verified_at": finance.now(),
            "reauthenticated_at": finance.now(),
        }
        with self.assertRaises(HTTPException) as denied:
            await routes.payments_reconcile_and_pay(user=explicit_empty)
        self.assertEqual(denied.exception.detail["code"], "ADMIN_PERMISSION_REQUIRED")

        legacy = dict(explicit_empty)
        legacy.pop("admin_permissions")
        allowed = await routes.payments_reconcile_and_pay(user=legacy)
        self.assertEqual(allowed["id"], "admin-1")

        class OversizedRequest:
            headers = {}

            async def stream(self):
                yield b"x" * routes.MAX_WEBHOOK_BODY_BYTES
                yield b"x"

        with self.assertRaises(HTTPException) as too_large:
            await routes.provider_webhook("mock", OversizedRequest())
        self.assertEqual(too_large.exception.status_code, 413)

    async def test_security_gates_and_configuration_fail_closed(self):
        with self.assertRaises(WebhookVerificationError):
            self.provider.verify_webhook(b"{}", {
                "X-Chakri-Timestamp": str(int(time.time()) - 301),
                "X-Chakri-Signature": "sha256=" + "0" * 64,
            })
        with self.assertRaises(ProviderConfigurationError):
            load_payment_provider({
                "APP_ENV": "production", "PAYMENT_PROVIDER": "mock",
                "PAYMENT_WEBHOOK_SECRET": "x" * 40,
            })

        finance.GAME_WALLET_INTEGRATION_READY = False
        uncertified = await finance.prepare_financial_core(dict(os.environ))
        self.assertFalse(uncertified["ready"])
        self.assertTrue(any("not certified" in error for error in uncertified["errors"]))
        finance.GAME_WALLET_INTEGRATION_READY = True
        self.assertTrue((await finance.prepare_financial_core())["ready"])

        no_kyc = {**self.user, "kyc_status": "UNVERIFIED", "identity_verified": True}
        with self.assertRaises(HTTPException) as blocked:
            await routes._require_player("deposits", no_kyc)
        self.assertEqual(blocked.exception.detail["code"], "KYC_REQUIRED")
        with self.assertRaises(HTTPException) as no_mfa:
            routes._require_recent_step_up({"role": "ADMIN", "admin_role": "SUPER_ADMIN"})
        self.assertEqual(no_mfa.exception.detail["code"], "ADMIN_MFA_REQUIRED")
        kyc_admin = {
            "id": "kyc-admin", "role": "ADMIN", "status": "ACTIVE",
            "admin_permissions": ["KYC_REVIEW"],
        }
        with self.assertRaises(HTTPException) as kyc_without_step_up:
            await routes.kyc_review(user=kyc_admin)
        self.assertEqual(
            kyc_without_step_up.exception.detail["code"], "ADMIN_MFA_REQUIRED",
        )
        kyc_admin.update({
            "mfa_enabled": True, "mfa_verified_at": finance.now(),
            "reauthenticated_at": finance.now(),
        })
        self.assertEqual((await routes.kyc_review(user=kyc_admin))["id"], "kyc-admin")

        reviewed = await finance.review_player_kyc(
            "player-1", "REJECTED", "kyc-admin", "Identity evidence did not match",
        )
        self.assertEqual(reviewed["kyc_status"], "REJECTED")
        self.assertEqual(await db.financial_audit.count_documents({"action": "KYC_REJECTED"}), 1)
        await finance.set_withdrawal_mode(
            "AUTOMATIC", "super-1", "Expose audited before and after", self.provider,
        )
        audit_response = await routes.admin_financial_audit(admin={"id": "audit-admin"})
        self.assertIn("audit", audit_response)
        self.assertNotIn("events", audit_response)
        mode_audit = next(
            row for row in audit_response["audit"]
            if row["action"] == "WITHDRAWAL_MODE_CHANGED"
        )
        self.assertEqual(mode_audit["before"], {"withdrawal_mode": "MANUAL"})
        self.assertEqual(mode_audit["after"], {"withdrawal_mode": "AUTOMATIC"})

        malformed = dict(os.environ)
        malformed["PAYMENT_WEBHOOK_TOLERANCE_SECONDS"] = "not-a-number"
        status = await finance.prepare_financial_core(malformed)
        self.assertFalse(status["ready"])
        self.assertTrue(status["errors"])

        for setting, invalid in (
            ("DEPOSIT_REFUND_RECONCILIATION_DAYS", "0"),
            ("DEPOSIT_REFUND_RECONCILIATION_DAYS", "366"),
            ("DEPOSIT_REFUND_RECONCILE_SECONDS", "3599"),
            ("DEPOSIT_REFUND_RECONCILE_SECONDS", "not-a-number"),
        ):
            malformed = dict(os.environ)
            malformed[setting] = invalid
            status = await finance.prepare_financial_core(malformed)
            self.assertFalse(status["ready"], (setting, invalid, status))
            self.assertTrue(
                any(setting in error for error in status["errors"]),
                (setting, invalid, status),
            )


if __name__ == "__main__":
    unittest.main(verbosity=2)
