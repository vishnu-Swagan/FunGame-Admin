"""Payout callback routing and operator-action authorization, without HTTP sends."""
from __future__ import annotations

import os
import sys
import unittest
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import FastAPI, HTTPException
from mongomock_motor import AsyncMongoMockClient

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("MONGO_URL", "mongodb://127.0.0.1:27017")
os.environ.setdefault("DB_NAME", "sgpay_payout_routes_test")
os.environ.setdefault("APP_ENV", "test")

import routes_payments as routes
import sgpay_payout
from payment_providers import MAX_WEBHOOK_BODY_BYTES, ProviderRequestError, SgPay24PaymentProvider


class SgPayPayoutRouteTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.db = AsyncMongoMockClient()["payout_routes"]
        self.db_patch = patch.object(routes, "db", self.db)
        self.db_patch.start()
        self.addCleanup(self.db_patch.stop)
        self.provider = SgPay24PaymentProvider({
            "PAYMENT_PROVIDER": "sgpay24",
            "SGPAY24_MERCHANT_ID": "MERTEST123",
            "SGPAY24_API_TOKEN": "test-only-api-token-1234567890",
            "PAYMENT_RETURN_URL": "https://play.example.com/wallet/deposit/return",
        })
        self.provider_patch = patch.object(routes, "_provider", return_value=self.provider)
        self.provider_patch.start()
        self.addCleanup(self.provider_patch.stop)
        self.reconcile = AsyncMock(return_value={
            "id": "withdrawal-local-123", "status": "APPROVED",
            "payout_status": "PROCESSING", "provider_reference": "PRIVATE-REFERENCE",
        })
        self.reconcile_patch = patch.object(sgpay_payout, "reconcile_operator_payout", self.reconcile)
        self.reconcile_patch.start()
        self.addCleanup(self.reconcile_patch.stop)
        app = FastAPI()
        app.include_router(routes.router, prefix="/api")
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")
        self.addAsyncCleanup(self.client.aclose)
        self.row = {
            "id": "withdrawal-local-123", "kind": "WITHDRAWAL", "status": "APPROVED",
            "payout_status": "PROCESSING", "payout_provider": "sgpay24",
            "payout_merchant_order_id": "merchant-order-123", "payout_ref": "provider-payout-456",
        }
        await self.db.operator_payment_requests.insert_one(dict(self.row))
        self.payload = {
            "merchant_id": "MERTEST123", "order_id": "merchant-order-123",
            "payout_id": "provider-payout-456", "amount": "100.00", "status": 1,
            "utr": "UNTRUSTED-NOTIFICATION-UTR",
        }

    async def post_notice(self, payload=None):
        return await self.client.post(
            "/api/payments/webhooks/sgpay24/payout",
            json=self.payload if payload is None else payload,
        )

    async def test_payout_notice_delegates_only_authenticated_reconciliation(self):
        # Claimed PAID must not win over the authoritative reconciler's state.
        with patch.dict(os.environ, {
            "UPI_CHIP_PURCHASES_ENABLED": "false", "SGPAY24_PAYOUTS_ENABLED": "false",
            "REAL_MONEY_ENABLED": "false",
        }):
            response = await self.post_notice()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {
            "status": "APPROVED", "payout_status": "PROCESSING", "duplicate": False,
        })
        self.reconcile.assert_awaited_once_with(
            self.row["id"], provider=self.provider, actor="sgpay24-payout-status-webhook",
        )
        stored = await self.db.operator_payment_requests.find_one({"id": self.row["id"]}, {"_id": 0})
        self.assertEqual(stored, self.row)

    async def test_legacy_withdrawal_uses_local_order_not_provider_payout_id(self):
        await self.db.operator_payment_requests.update_one(
            {"id": self.row["id"]}, {"$unset": {"payout_merchant_order_id": "", "payout_provider": ""}},
        )
        response = await self.post_notice({**self.payload, "order_id": self.row["id"]})
        self.assertEqual(response.status_code, 200)
        self.reconcile.assert_awaited_once()
        self.reconcile.reset_mock()
        response = await self.post_notice({**self.payload, "order_id": self.row["payout_ref"]})
        self.assertEqual(response.status_code, 404)
        self.reconcile.assert_not_awaited()

    async def test_current_binding_does_not_fall_back_to_old_local_id(self):
        response = await self.post_notice({**self.payload, "order_id": self.row["id"]})
        self.assertEqual(response.status_code, 404)
        self.reconcile.assert_not_awaited()

    async def test_unknown_order_never_creates_or_reconciles_a_withdrawal(self):
        response = await self.post_notice({**self.payload, "order_id": "unknown-order-123"})
        self.assertEqual(response.status_code, 404)
        self.reconcile.assert_not_awaited()
        self.assertEqual(await self.db.operator_payment_requests.count_documents({}), 1)

    async def test_deposit_or_other_provider_record_is_not_a_payout(self):
        for changed in ({"kind": "DEPOSIT"}, {"payout_provider": "other"}, {"provider": "other"}):
            with self.subTest(changed=changed):
                await self.db.operator_payment_requests.replace_one({"id": self.row["id"]}, {**self.row, **changed})
                response = await self.post_notice()
                self.assertEqual(response.status_code, 404)
                self.reconcile.assert_not_awaited()

    async def test_invalid_notice_shape_kind_merchant_or_provider_is_rejected(self):
        notices = [
            [],
            {key: value for key, value in self.payload.items() if key != "order_id"},
            {**self.payload, "order_id": 123},
            {**self.payload, "merchant_id": "MEROTHER123"},
            {**self.payload, "provider": "other"},
            {**self.payload, "provider": []},
            {**self.payload, "kind": "DEPOSIT"},
            {**self.payload, "status": "unknown"},
            {**{key: value for key, value in self.payload.items() if key != "payout_id"}, "transaction_id": 123},
        ]
        for payload in notices:
            with self.subTest(payload=payload):
                self.reconcile.reset_mock()
                response = await self.post_notice(payload)
                self.assertEqual(response.status_code, 401)
                self.reconcile.assert_not_awaited()

    async def test_body_limit_and_invalid_json_fail_before_reconciliation(self):
        for body, expected in ((b"{", 401), (b"x" * (MAX_WEBHOOK_BODY_BYTES + 1), 413)):
            response = await self.client.post("/api/payments/webhooks/sgpay24/payout", content=body)
            self.assertEqual(response.status_code, expected)
        self.reconcile.assert_not_awaited()

    async def test_optional_callback_merchant_may_be_omitted(self):
        response = await self.post_notice({key: value for key, value in self.payload.items() if key != "merchant_id"})
        self.assertEqual(response.status_code, 200)
        self.reconcile.assert_awaited_once()

    async def test_lookup_failure_returns_retryable_safe_response(self):
        self.reconcile.return_value = {"error": "private-provider-response", "payout_status": "PROCESSING"}
        response = await self.post_notice()
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["detail"]["code"], "PAYOUT_STATUS_UNAVAILABLE")
        self.assertNotIn("private-provider", response.text)

    async def test_duplicate_callback_acknowledges_existing_settlement(self):
        self.reconcile.return_value = {"status": "PAID", "payout_status": "PAID", "duplicate": True}
        response = await self.post_notice()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "PAID", "payout_status": "PAID", "duplicate": True})

    async def test_callback_uses_real_reconciler_with_authenticated_merchant_order_lookup(self):
        self.reconcile_patch.stop()
        merchant_order_id = self.row["id"]
        self.payload["order_id"] = merchant_order_id
        await self.db.operator_payment_requests.update_one(
            {"id": self.row["id"]}, {"$set": {
                "amount_paise": 10000, "chips": 100, "user_id": "player-test",
                "payout_merchant_order_id": merchant_order_id,
            }},
        )
        status_http = AsyncMock(return_value={
            "merchant_id": "MERTEST123", "order_id": merchant_order_id, "status": 1,
            "amount": "100.00", "payout_id": "provider-payout-456", "utr": "AUTHENTICATED-UTR-123",
        })
        with (
            patch.object(sgpay_payout, "db", self.db),
            patch.object(self.provider, "_request_json", status_http),
            patch.object(self.provider, "submit_payout", new_callable=AsyncMock) as send,
        ):
            response = await self.post_notice()
            duplicate = await self.post_notice()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["payout_status"], "PAID")
        self.assertEqual(duplicate.status_code, 200)
        self.assertTrue(duplicate.json()["duplicate"])
        status_http.assert_awaited_once()
        path, payload = status_http.await_args.args
        self.assertEqual(path, "/api/check-payout-status")
        self.assertEqual(payload["order_id"], merchant_order_id)
        send.assert_not_awaited()
        stored = await self.db.operator_payment_requests.find_one({"id": self.row["id"]})
        self.assertEqual(stored["provider_reference"], "AUTHENTICATED-UTR-123")
        self.assertEqual(await self.db.chip_transactions.count_documents({}), 0)

    async def test_callback_claimed_paid_cannot_override_authoritative_failure(self):
        self.reconcile_patch.stop()
        merchant_order_id = self.row["id"]
        self.payload["order_id"] = merchant_order_id
        await self.db.operator_payment_requests.update_one(
            {"id": self.row["id"]}, {"$set": {
                "amount_paise": 10000, "chips": 100, "user_id": "player-test",
                "payout_merchant_order_id": merchant_order_id,
            }},
        )
        with (
            patch.object(sgpay_payout, "db", self.db),
            patch.object(self.provider, "_request_json", AsyncMock(return_value={
                "merchant_id": "MERTEST123", "order_id": merchant_order_id, "status": 2,
                "amount": "100.00", "payout_id": "provider-payout-456",
            })),
            patch.object(self.provider, "submit_payout", new_callable=AsyncMock) as send,
        ):
            response = await self.post_notice()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["payout_status"], "FAILED")
        self.assertEqual(response.json()["status"], "APPROVED")
        send.assert_not_awaited()
        self.assertEqual(await self.db.chip_transactions.count_documents({}), 0)


class OperatorActionPermissionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.db = AsyncMongoMockClient()["operator_permissions"]
        self.patch_db = patch.object(routes, "db", self.db)
        self.patch_db.start()
        self.addCleanup(self.patch_db.stop)
        self.admin = {"id": "admin-test", "role": "ADMIN", "status": "ACTIVE", "admin_permissions": ["PAYMENTS_VIEW"]}
        self.step_up = patch.object(routes, "_require_recent_step_up")
        self.step_up_mock = self.step_up.start()
        self.addCleanup(self.step_up.stop)
        self.resolve = AsyncMock(side_effect=lambda request_id, *_args, **_kwargs: {
            "id": request_id, "kind": "DEPOSIT" if request_id == "deposit-123" else "WITHDRAWAL",
            "status": "APPROVED", "amount_paise": 10000, "chips": 100,
        })
        self.patch_resolve = patch.object(routes.operator_rail, "resolve_request", self.resolve)
        self.patch_resolve.start()
        self.addCleanup(self.patch_resolve.stop)
        self.send = AsyncMock(return_value={"payout_status": "PROCESSING"})
        self.sync = AsyncMock(return_value={"payout_status": "PROCESSING"})
        for name, mocked in (("send_operator_payout", self.send), ("reconcile_operator_payout", self.sync)):
            patcher = patch.object(sgpay_payout, name, mocked)
            patcher.start()
            self.addCleanup(patcher.stop)
        app = FastAPI()
        app.include_router(routes.admin_router, prefix="/api")
        async def current_admin():
            return self.admin
        app.dependency_overrides[routes.get_current_user] = current_admin
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")
        self.addAsyncCleanup(self.client.aclose)
        await self.db.operator_payment_requests.insert_many([
            {"id": "deposit-123", "kind": "DEPOSIT", "status": "PENDING"},
            {"id": "withdrawal-123", "kind": "WITHDRAWAL", "status": "APPROVED"},
        ])

    async def post_action(self, kind, action):
        return await self.client.post(
            f"/api/admin/payments/operator-requests/{kind}-123/{action}",
            json={"reason": "Reviewed test request"},
        )

    async def test_view_only_admin_cannot_mutate_any_operator_action(self):
        for kind, action in (
            ("deposit", "approve"), ("deposit", "reject"),
            ("withdrawal", "approve"), ("withdrawal", "reject"),
            ("withdrawal", "retry-payout"), ("withdrawal", "sync-payout"),
        ):
            with self.subTest(kind=kind, action=action):
                response = await self.post_action(kind, action)
                self.assertEqual(response.status_code, 403)
                self.assertEqual(response.json()["detail"]["code"], "ADMIN_PERMISSION_REQUIRED")
        self.resolve.assert_not_awaited()
        self.send.assert_not_awaited()
        self.sync.assert_not_awaited()

    async def test_deposit_resolution_requires_reconcile_and_step_up(self):
        self.admin["admin_permissions"] = ["PAYMENTS_RECONCILE"]
        for action in ("approve", "reject"):
            response = await self.post_action("deposit", action)
            self.assertEqual(response.status_code, 200)
        self.assertEqual(self.step_up_mock.call_count, 2)
        self.assertEqual(self.resolve.await_count, 2)

    async def test_withdrawal_approval_requires_both_approval_and_send_grants(self):
        for grants in (["WITHDRAWALS_APPROVE"], ["WITHDRAWALS_MARK_PAID"]):
            self.admin["admin_permissions"] = grants
            self.assertEqual((await self.post_action("withdrawal", "approve")).status_code, 403)
        self.resolve.assert_not_awaited()
        self.admin["admin_permissions"] = ["WITHDRAWALS_APPROVE", "WITHDRAWALS_MARK_PAID"]
        self.assertEqual((await self.post_action("withdrawal", "approve")).status_code, 200)
        self.step_up_mock.assert_called_once_with(self.admin)

    async def test_withdrawal_rejection_only_needs_approval_grant(self):
        self.admin["admin_permissions"] = ["WITHDRAWALS_APPROVE"]
        self.assertEqual((await self.post_action("withdrawal", "reject")).status_code, 200)
        self.step_up_mock.assert_not_called()

    async def test_retry_and_sync_have_separate_grants_and_step_up(self):
        self.admin["admin_permissions"] = ["WITHDRAWALS_MARK_PAID"]
        self.assertEqual((await self.post_action("withdrawal", "sync-payout")).status_code, 403)
        self.assertEqual((await self.post_action("withdrawal", "retry-payout")).status_code, 200)
        self.admin["admin_permissions"] = ["PAYMENTS_RECONCILE"]
        self.assertEqual((await self.post_action("withdrawal", "retry-payout")).status_code, 403)
        self.assertEqual((await self.post_action("withdrawal", "sync-payout")).status_code, 200)
        self.assertEqual(self.step_up_mock.call_count, 2)
        self.send.assert_awaited_once()
        self.sync.assert_awaited_once()

    async def test_stale_step_up_blocks_sensitive_actions_before_mutation(self):
        self.admin["admin_role"] = "SUPER_ADMIN"
        self.step_up_mock.side_effect = HTTPException(403, detail={"code": "ADMIN_STEP_UP_REQUIRED"})
        for kind, action in (("deposit", "approve"), ("deposit", "reject"), ("withdrawal", "approve"),
                             ("withdrawal", "retry-payout"), ("withdrawal", "sync-payout")):
            response = await self.post_action(kind, action)
            self.assertEqual(response.status_code, 403)
            self.assertEqual(response.json()["detail"]["code"], "ADMIN_STEP_UP_REQUIRED")
        self.resolve.assert_not_awaited()
        self.send.assert_not_awaited()
        self.sync.assert_not_awaited()

    async def test_sync_lookup_error_is_not_reported_as_success(self):
        self.admin["admin_permissions"] = ["PAYMENTS_RECONCILE"]
        self.sync.return_value = {"error": "private-provider-error", "payout_status": "PROCESSING"}
        for error in (None, ProviderRequestError("private-provider-error")):
            self.sync.side_effect = error
            response = await self.post_action("withdrawal", "sync-payout")
            self.assertEqual(response.status_code, 503)
            self.assertEqual(response.json()["detail"]["code"], "PAYOUT_STATUS_UNAVAILABLE")
            self.assertNotIn("private-provider", response.text)
        self.send.assert_not_awaited()

    async def test_non_admin_or_inactive_identity_is_denied(self):
        for identity in ({"role": "PLAYER", "status": "ACTIVE"}, {"role": "ADMIN", "status": "SUSPENDED"}):
            self.admin.update(identity, admin_role="SUPER_ADMIN")
            self.assertEqual((await self.post_action("deposit", "approve")).status_code, 403)
        self.resolve.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
