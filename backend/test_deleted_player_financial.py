"""Deleted accounts reject new value movements but retain existing obligations."""
from datetime import timedelta
import unittest
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException

import test_payments as core
import test_sgpay24_provider as upi
import ledger
from player_account_state import retained_deposit_eligibility_user


class DeletedAccountMoneyTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        await core.FinancialCoreTests.asyncSetUp(self)
        self.previous_adapter = ledger._source_wallet_adapter
        ledger._source_wallet_adapter = None

    async def asyncTearDown(self):
        ledger._source_wallet_adapter = self.previous_adapter

    async def delete(self):
        await core.db.users.update_one({"id": self.user["id"]}, {"$set": {
            "status": "DELETED", "deleted_at": core.finance.now(),
            "deletion_previous_status": "ACTIVE",
        }})

    async def bank(self):
        return await core.finance.create_payout_method(
            self.user["id"], account_holder_name="Test Player", bank_name="Test Bank",
            account_number="123456789012", ifsc_code="ABCD0123456",
        )

    async def test_deleted_markers_block_new_requests_before_balance_changes(self):
        adapter = AsyncMock()
        with patch.object(ledger, "_source_wallet_adapter", adapter):
            for marker in ({"status": "DELETED", "deleted_at": None},
                           {"status": "ACTIVE", "deleted_at": core.finance.now()}):
                await core.db.users.update_one({"id": self.user["id"]}, {"$set": marker})
                actions = (
                    lambda: core.finance.create_deposit(self.user["id"], 10000, "deleted-deposit", self.provider),
                    lambda: core.finance.create_withdrawal(self.user["id"], 100, "bank", "deleted-withdrawal", self.provider),
                    lambda: ledger.debit_chips(self.user["id"], 100, "closed stake", kind=ledger.STAKE),
                    lambda: upi.operator_rail.create_request(self.user, kind="DEPOSIT", amount_paise=10000),
                    lambda: upi.operator_rail.create_request(self.user, kind="WITHDRAWAL", amount_paise=10000),
                )
                for action in actions:
                    with self.assertRaises(HTTPException) as blocked:
                        await action()
                    self.assertEqual(blocked.exception.detail["code"], "ACCOUNT_DELETED")
        adapter.debit.assert_not_awaited()
        stored = await core.db.users.find_one({"id": self.user["id"]})
        self.assertEqual(stored["chip_balance"], 1000)
        for collection in ("deposit_orders", "withdrawal_requests", "operator_payment_requests", "chip_transactions"):
            self.assertEqual(await core.db[collection].count_documents({}), 0)

    async def test_deletion_wins_race_before_deposit_transaction(self):
        async def deleted_before_commit(callback):
            await self.delete()
            return await callback(None)

        with patch.object(core.finance, "_run_transaction", deleted_before_commit):
            with self.assertRaises(HTTPException) as blocked:
                await core.finance.create_deposit(self.user["id"], 10000, "raced-deposit", self.provider)
        self.assertEqual(blocked.exception.detail["code"], "ACCOUNT_DELETED")
        self.assertEqual(await core.db.deposit_orders.count_documents({}), 0)
        self.assertEqual(self.provider.deposit_calls, 0)

    async def test_deletion_wins_race_before_withdrawal_transaction(self):
        await core.seed_cash(self.user["id"], 500)
        bank = await self.bank()

        async def deleted_before_commit(callback):
            await self.delete()
            return await callback(None)

        with patch.object(core.finance, "_run_transaction", deleted_before_commit):
            with self.assertRaises(HTTPException) as blocked:
                await core.finance.create_withdrawal(
                    self.user["id"], 100, bank["id"], "raced-withdrawal", self.provider,
                )
        self.assertEqual(blocked.exception.detail["code"], "ACCOUNT_DELETED")
        self.assertEqual(await core.db.withdrawal_requests.count_documents({}), 0)
        wallet = await core.finance.wallet_public(self.user["id"])
        self.assertEqual(wallet["cash_chips"], 500)
        self.assertEqual(wallet["held_chips"], 0)

    async def test_deletion_between_reservation_and_checkout_stops_provider_call(self):
        calls = 0

        async def delete_before_checkout(callback):
            nonlocal calls
            calls += 1
            if calls == 2:
                await self.delete()
            return await callback(None)

        with patch.object(core.finance, "_run_transaction", delete_before_checkout):
            with self.assertRaises(HTTPException) as blocked:
                await core.finance.create_deposit(self.user["id"], 10000, "raced-checkout", self.provider)
        self.assertEqual(blocked.exception.detail["code"], "ACCOUNT_DELETED")
        order = await core.db.deposit_orders.find_one({"user_id": self.user["id"]})
        self.assertEqual(order["status"], "CREATED")
        self.assertIsNone(order["provider_order_id"])
        self.assertEqual(self.provider.deposit_calls, 0)
        result = await core.finance.reconcile_deposit(order["id"], self.provider)
        self.assertEqual(result["status"], "FAILED")
        closed = await core.db.deposit_orders.find_one({"id": order["id"]})
        self.assertEqual(closed["limit_reservation_status"], "RELEASED")
        self.assertEqual(closed["last_error"], "ACCOUNT_DELETED_BEFORE_CHECKOUT")
        self.assertEqual(self.provider.deposit_calls, 0)

    async def test_deleted_sgpay_deposit_recovers_lost_provider_id_without_new_checkout(self):
        gateway = upi.RecordingSgPay24Gateway()
        create_at_provider = gateway.create_deposit_order

        async def accepted_but_response_lost(**kwargs):
            await create_at_provider(**kwargs)
            raise TimeoutError("accepted response lost")

        with patch.object(gateway, "create_deposit_order", side_effect=accepted_but_response_lost):
            with self.assertRaises(core.finance.FinancialError):
                await core.finance.create_deposit(self.user["id"], 10000, "lost-provider-response", gateway)
        order = await core.db.deposit_orders.find_one({"idempotency_key": "lost-provider-response"})
        self.assertIsNone(order["provider_order_id"])
        self.assertIsNotNone(order["checkout_authorized_at"])
        await core.db.deposit_orders.update_one(
            {"id": order["id"]}, {"$set": {"created_at": core.finance.now() - timedelta(hours=2)}},
        )
        await self.delete()
        gateway.status = upi.DepositStatus("PAID", 10000, "INR", "RECOVEREDSGPAY12345")
        checkout = AsyncMock(side_effect=AssertionError("deleted account must not submit checkout"))
        with patch.object(gateway, "create_deposit_order", checkout):
            first = await core.finance.reconcile_deposit(order["id"], gateway)
            again = await core.finance.reconcile_deposit(order["id"], gateway)
            for key in ("lost-provider-response", "new-deleted-intake"):
                with self.assertRaises(HTTPException) as blocked:
                    await core.finance.create_deposit(self.user["id"], 10000, key, gateway)
                self.assertEqual(blocked.exception.detail["code"], "ACCOUNT_DELETED")
        self.assertEqual(first["status"], "CREDITED")
        self.assertTrue(again["duplicate"])
        checkout.assert_not_awaited()
        self.assertEqual(len(gateway.create_calls), 1)
        self.assertEqual(gateway.status_calls[0], (order["id"], 10000))
        stored = await core.db.deposit_orders.find_one({"id": order["id"]})
        self.assertEqual(stored["provider_order_id"], order["id"])
        self.assertIsNone(stored["checkout_url"])
        user = await core.db.users.find_one({"id": self.user["id"]})
        self.assertEqual((user["status"], user["chip_balance"]), ("DELETED", 1100))
        self.assertEqual(await core.db.wallet_operations.count_documents({"kind": "DEPOSIT_CREDIT"}), 1)

    async def test_deleted_generic_missing_id_is_retained_and_later_batch_progresses(self):
        missing, _ = await core.finance.create_deposit(
            self.user["id"], 10000, "generic-unknown-provider-id", self.provider,
        )
        later, _ = await core.finance.create_deposit(
            self.user["id"], 10000, "generic-later-issued-deposit", self.provider,
        )
        stamp = core.finance.now()
        await core.db.deposit_orders.update_one({"id": missing["id"]}, {"$set": {
            "status": "CREATED", "provider_order_id": None, "checkout_url": None,
            "created_at": stamp - timedelta(hours=2), "next_reconcile_at": stamp - timedelta(hours=1),
        }})
        await core.db.deposit_orders.update_one(
            {"id": later["id"]}, {"$set": {"next_reconcile_at": stamp}},
        )
        await self.delete()
        self.provider.payment_status = "PAID"
        checkout = AsyncMock(side_effect=AssertionError("uncertain order must not be recreated"))
        with patch.object(self.provider, "create_deposit_order", checkout):
            first = await core.finance.reconcile_financial_records(self.provider, limit=1)
            second = await core.finance.reconcile_financial_records(self.provider, limit=1)
        self.assertEqual((first["checked"], first["review_required"]), (1, 1))
        self.assertEqual((second["checked"], second["repaired"]), (1, 1))
        checkout.assert_not_awaited()
        retained = await core.db.deposit_orders.find_one({"id": missing["id"]})
        self.assertEqual((retained["status"], retained["limit_reservation_status"]), ("CREATED", "HELD"))
        self.assertEqual(retained["reconciliation_error_code"], "DEPOSIT_REFERENCE_RECOVERY_REQUIRED")
        self.assertIsNone(retained["provider_order_id"])
        self.assertGreater(core.finance._parse_optional_datetime(retained["next_reconcile_at"]), stamp)

    async def test_deletion_during_checkout_recovery_does_not_abort_batch(self):
        missing, _ = await core.finance.create_deposit(
            self.user["id"], 10000, "deletion-mid-recovery", self.provider,
        )
        later, _ = await core.finance.create_deposit(
            self.user["id"], 10000, "issued-after-missing", self.provider,
        )
        await core.db.deposit_orders.update_one({"id": missing["id"]}, {"$set": {
            "status": "CREATED", "provider_order_id": None, "checkout_url": None,
        }})
        recover_checkout = core.finance._ensure_deposit_checkout

        async def delete_before_recovery(order, provider):
            await self.delete()
            return await recover_checkout(order, provider)

        self.provider.payment_status = "PAID"
        with patch.object(core.finance, "_ensure_deposit_checkout", side_effect=delete_before_recovery):
            batch = await core.finance.reconcile_financial_records(self.provider, limit=2)
        self.assertEqual((batch["checked"], batch["review_required"], batch["repaired"]), (2, 1, 1))
        retained = await core.db.deposit_orders.find_one({"id": missing["id"]})
        self.assertEqual(retained["reconciliation_error_code"], "ACCOUNT_DELETED")
        self.assertEqual(retained["status"], "CREATED")
        self.assertEqual((await core.db.deposit_orders.find_one({"id": later["id"]}))["status"], "CREDITED")
        self.assertEqual(self.provider.deposit_calls, 2)

    async def test_preexisting_paid_deposit_still_credits_once_after_deletion(self):
        order, _ = await core.finance.create_deposit(self.user["id"], 10000, "before-delete-deposit", self.provider)
        await self.delete()
        event, raw = core.signed_event(self.provider, {
            "id": "deleted-player-paid", "type": "deposit.paid",
            "object_id": order["provider_order_id"], "amount_paise": 10000,
            "currency": "INR", "provider_reference": "deleted-player-paid-reference",
        })
        first = await core.finance.process_provider_event(self.provider, event, raw)
        second = await core.finance.process_provider_event(self.provider, event, raw)
        self.assertEqual(first["status"], "CREDITED")
        self.assertTrue(second["duplicate"])
        stored = await core.db.users.find_one({"id": self.user["id"]})
        self.assertEqual((stored["status"], stored["chip_balance"]), ("DELETED", 1100))
        self.assertEqual(await core.db.wallet_operations.count_documents({"kind": "DEPOSIT_CREDIT"}), 1)

    async def test_existing_withdrawals_can_pay_or_release_after_deletion(self):
        await core.seed_cash(self.user["id"], 500)
        bank = await self.bank()
        paid = await core.finance.create_withdrawal(self.user["id"], 100, bank["id"], "pending-to-pay", self.provider)
        rejected = await core.finance.create_withdrawal(self.user["id"], 100, bank["id"], "pending-to-release", self.provider)
        await self.delete()
        await core.finance.approve_withdrawal(paid["id"], "admin")
        await core.finance.mark_withdrawal_submitted(paid["id"], "admin", "retained-payout-ref")
        result = await core.finance.mark_withdrawal_paid(paid["id"], "admin", "retained-payout-ref")
        self.assertEqual(result["status"], "PAID")
        result = await core.finance.reject_withdrawal(rejected["id"], "admin", "Existing request declined")
        self.assertEqual(result["status"], "REJECTED")
        wallet = await core.finance.wallet_public(self.user["id"])
        self.assertEqual((wallet["cash_chips"], wallet["held_chips"]), (400, 0))

    async def test_payout_and_refund_credits_do_not_reactivate_account(self):
        await self.delete()
        await ledger.credit_chips(self.user["id"], 30, "old win", kind=ledger.PAYOUT)
        await ledger.credit_chips(self.user["id"], 20, "old refund", kind=ledger.REFUND)
        stored = await core.db.users.find_one({"id": self.user["id"]})
        self.assertEqual((stored["status"], stored["chip_balance"]), ("DELETED", 1050))


class DeletedHostedPaymentTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        await upi.HostedUpiOperatorRailTests.asyncSetUp(self)

    async def asyncTearDown(self):
        await upi.HostedUpiOperatorRailTests.asyncTearDown(self)

    async def delete(self):
        await self.db.users.update_one({"id": self.user["id"]}, {"$set": {
            "status": "DELETED", "deleted_at": upi.operator_rail.utcnow(),
            "deletion_previous_status": "ACTIVE",
        }})

    async def test_existing_hosted_payment_credits_after_delete_but_new_checkout_is_denied(self):
        order, _ = await upi.operator_rail.create_hosted_deposit(self.user, 10000, "retained-upi-order", self.gateway)
        await self.delete()
        for key in ("retained-upi-order", "new-upi-order"):
            with self.assertRaises(HTTPException) as blocked:
                await upi.operator_rail.create_hosted_deposit(self.user, 10000, key, self.gateway)
            self.assertEqual(blocked.exception.detail["code"], "ACCOUNT_DELETED")
        stored = await self.db[upi.operator_rail.COLLECTION].find_one({"id": order["id"]})
        self.assertEqual(stored["status"], "PENDING")
        paid = upi.DepositStatus("PAID", 10000, "INR", "RETAINEDUTR12345")
        first = await upi.operator_rail.settle_hosted_deposit(order["id"], paid, actor="test-provider")
        second = await upi.operator_rail.settle_hosted_deposit(order["id"], paid, actor="test-provider")
        self.assertEqual(first["status"], "CREDITED")
        self.assertTrue(second["duplicate"])
        user = await self.db.users.find_one({"id": self.user["id"]})
        self.assertEqual((user["status"], user["chip_balance"]), ("DELETED", 200))
        self.assertEqual(len(self.gateway.create_calls), 1)

    async def test_hosted_creation_race_refuses_deleted_player(self):
        async def deleted_before_commit(callback):
            await self.delete()
            return await callback(None)
        with patch.object(upi.operator_rail, "_run_hosted_transaction", deleted_before_commit):
            with self.assertRaises(HTTPException) as blocked:
                await upi.operator_rail.create_hosted_deposit(self.user, 10000, "raced-upi-order", self.gateway)
        self.assertEqual(blocked.exception.detail["code"], "ACCOUNT_DELETED")
        self.assertEqual(await self.db[upi.operator_rail.COLLECTION].count_documents({}), 0)
        self.assertEqual(self.gateway.create_calls, [])

    async def test_hosted_checkout_race_stops_provider_call_after_reservation(self):
        calls = 0

        async def delete_before_checkout(callback):
            nonlocal calls
            calls += 1
            if calls == 2:
                await self.delete()
            return await callback(None)

        with patch.object(upi.operator_rail, "_run_hosted_transaction", delete_before_checkout):
            with self.assertRaises(HTTPException) as blocked:
                await upi.operator_rail.create_hosted_deposit(self.user, 10000, "raced-upi-checkout", self.gateway)
        self.assertEqual(blocked.exception.detail["code"], "ACCOUNT_DELETED")
        order = await self.db[upi.operator_rail.COLLECTION].find_one({"user_id": self.user["id"]})
        self.assertEqual(order["status"], "CREATED")
        self.assertIsNone(order["provider_order_id"])
        self.assertEqual(self.gateway.create_calls, [])
        self.assertTrue(order["checkout_authorization_required"])
        unavailable = AsyncMock(side_effect=upi.ProviderRequestError("not issued"))
        with patch.object(self.gateway, "get_payment_status", unavailable):
            result = await upi.operator_rail.reconcile_hosted_deposit(order["id"], self.gateway)
        self.assertEqual(result["status"], "FAILED")
        unavailable.assert_not_awaited()
        stored = await self.db[upi.operator_rail.COLLECTION].find_one({"id": order["id"]})
        self.assertEqual(stored["last_error"], "ACCOUNT_DELETED_BEFORE_CHECKOUT")

    async def test_never_authorized_deleted_orders_do_not_starve_later_batch(self):
        paid, _ = await upi.operator_rail.create_hosted_deposit(
            self.user, 10000, "newer-paid-order", self.gateway,
        )
        stamp = upi.operator_rail.utcnow()
        for index in range(25):
            await self.db[upi.operator_rail.COLLECTION].insert_one({
                **paid, "id": f"never-issued-{index}", "status": "CREATED",
                "provider_order_id": None, "checkout_url": None,
                "checkout_authorized_at": None,
                "created_at": stamp - timedelta(days=1),
                "next_reconcile_at": stamp - timedelta(days=1),
            })
        await self.db[upi.operator_rail.COLLECTION].update_one(
            {"id": paid["id"]}, {"$set": {"next_reconcile_at": stamp}},
        )
        await self.delete()
        self.gateway.status = upi.DepositStatus("PAID", 10000, "INR", "BATCHPAID12345")
        first = await upi.operator_rail.reconcile_hosted_batch(self.gateway)
        second = await upi.operator_rail.reconcile_hosted_batch(self.gateway)
        self.assertEqual(first, {"checked": 25, "updated": 25, "errors": 0})
        self.assertEqual(second, {"checked": 1, "updated": 1, "errors": 0})
        self.assertEqual(self.gateway.status_calls, [(paid["id"], 10000)])
        self.assertEqual(len(self.gateway.create_calls), 1)
        self.assertEqual(await self.db[upi.operator_rail.COLLECTION].count_documents({
            "status": "FAILED", "last_error": "ACCOUNT_DELETED_BEFORE_CHECKOUT",
        }), 25)

    async def test_uncertain_deleted_orders_defer_without_starving_later_settlements(self):
        paid, _ = await upi.operator_rail.create_hosted_deposit(
            self.user, 10000, "newer-paid-after-uncertain", self.gateway,
        )
        stamp = upi.operator_rail.utcnow()
        for index in range(25):
            row = {
                **paid, "id": f"uncertain-{index}", "status": "CREATED",
                "provider_order_id": None, "checkout_url": None,
                "created_at": stamp - timedelta(days=1),
                "next_reconcile_at": stamp - timedelta(days=1),
            }
            if index % 3 == 1:  # Legacy submission with no reliable authorization marker.
                row.pop("checkout_authorization_required")
                row.pop("checkout_authorized_at")
            elif index % 3 == 2:  # Issued order, including a persisted provider id.
                row.update(status="PENDING", provider_order_id=row["id"])
            await self.db[upi.operator_rail.COLLECTION].insert_one(row)
        await self.db[upi.operator_rail.COLLECTION].update_one(
            {"id": paid["id"]}, {"$set": {"next_reconcile_at": stamp}},
        )
        await self.delete()
        clock = [stamp]

        async def slow_status(order_id, *, expected_amount_paise):
            if order_id == paid["id"]:
                return upi.DepositStatus("PAID", 10000, "INR", "FAIRBATCH12345")
            clock[0] += timedelta(seconds=2)
            raise upi.ProviderRequestError("status temporarily unavailable")

        with patch.object(upi.operator_rail, "utcnow", side_effect=lambda: clock[0]), \
             patch.object(self.gateway, "get_payment_status", side_effect=slow_status):
            first = await upi.operator_rail.reconcile_hosted_batch(self.gateway)
            # Some retries are already due after a slow batch; the untouched
            # newer order must nevertheless be checked before those retries.
            second = await upi.operator_rail.reconcile_hosted_batch(self.gateway, limit=1)
        self.assertEqual(first, {"checked": 25, "updated": 0, "errors": 25})
        self.assertEqual(second, {"checked": 1, "updated": 1, "errors": 0})
        self.assertEqual(len(self.gateway.create_calls), 1)
        uncertain = await self.db[upi.operator_rail.COLLECTION].find_one({"id": "uncertain-0"})
        self.assertEqual(uncertain["status"], "CREATED")
        self.assertEqual(uncertain["reconcile_attempts"], 1)
        self.assertEqual(uncertain["last_error"], "ProviderRequestError")
        self.assertIsNotNone(uncertain["next_reconcile_at"])
        self.gateway.status = upi.DepositStatus("PAID", 10000, "INR", "RECOVERED12345")
        recovered = await upi.operator_rail.reconcile_hosted_deposit("uncertain-0", self.gateway)
        self.assertEqual(recovered["status"], "CREDITED")

    async def test_retained_order_projection_requires_predeletion_issued_order(self):
        stamp = upi.operator_rail.utcnow()
        user = {**self.user, "status": "DELETED", "deleted_at": stamp, "deletion_previous_status": "ACTIVE"}
        valid = {"created_at": stamp - timedelta(seconds=1), "provider_order_id": "issued-order"}
        self.assertEqual(retained_deposit_eligibility_user(user, valid)["status"], "ACTIVE")
        for order in ({**valid, "created_at": stamp + timedelta(seconds=1)},
                      {**valid, "provider_order_id": None}, {**valid, "created_at": None}):
            self.assertEqual(retained_deposit_eligibility_user(user, order)["status"], "DELETED")
        frozen = {**user, "financial_status": "FROZEN"}
        with self.assertRaises(HTTPException):
            await upi.operator_rail.require_hosted_deposit_eligible(retained_deposit_eligibility_user(frozen, valid))


if __name__ == "__main__":
    unittest.main(verbosity=2)
