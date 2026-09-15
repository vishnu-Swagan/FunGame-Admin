"""Provider diagnostics contain fixed categories, never response/credential text."""
import json
import unittest
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
import test_sgpay24_provider as fixtures
from payment_providers import ProviderRequestError, SgPay24PaymentProvider
import operator_rail
import routes_payments
from payment_hub import service


class CheckoutDiagnosticsTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        await fixtures.HostedUpiOperatorRailTests.asyncSetUp(self)

    async def asyncTearDown(self):
        await fixtures.HostedUpiOperatorRailTests.asyncTearDown(self)

    def test_error_categories_never_echo_provider_secrets(self):
        secret = "secret-token-and-private-beneficiary@example.com"
        cases = (
            (401, secret, "PROVIDER_AUTH_REJECTED"),
            (429, secret, "PROVIDER_RATE_LIMITED"),
            (500, secret, "PROVIDER_UNAVAILABLE"),
            (422, f"Invalid amount; minimum limit {secret}", "PROVIDER_AMOUNT_REJECTED"),
            (400, f"No available bank {secret}", "PROVIDER_PAYMENT_ROUTE_UNAVAILABLE"),
            (400, secret, "PROVIDER_REJECTED"),
            (200, "Invalid api token", "PROVIDER_AUTH_REJECTED"),
            (200, secret, "PROVIDER_INVALID_RESPONSE"),
        )
        for status, message, expected in cases:
            with self.subTest(status=status, expected=expected):
                raw = json.dumps({"message": message}).encode()
                self.assertEqual(SgPay24PaymentProvider._provider_error_code(status, raw), expected)
                self.assertNotIn(secret, SgPay24PaymentProvider._provider_error_message(status, raw))
        self.assertEqual(SgPay24PaymentProvider._provider_error_code(400, b"not JSON"), "PROVIDER_REJECTED")
        unsafe = ProviderRequestError(secret, diagnostic_code=secret, http_status=True)
        self.assertEqual(unsafe.diagnostic_code, "PROVIDER_REJECTED")
        self.assertIsNone(unsafe.http_status)

    async def test_failed_checkout_records_only_safe_diagnostics_without_credit(self):
        error = ProviderRequestError(
            "untrusted-secret-response", diagnostic_code="PROVIDER_AMOUNT_REJECTED", http_status=422,
        )
        with patch.object(self.gateway, "create_deposit_order", AsyncMock(side_effect=error)) as create:
            with self.assertRaises(HTTPException) as caught:
                await operator_rail.create_hosted_deposit(self.user, 10000, "diagnostic-checkout-test", self.gateway)
        self.assertEqual(caught.exception.status_code, 503)
        self.assertEqual(create.await_count, 1)
        self.assertNotIn("untrusted-secret", str(caught.exception.detail))
        row = await self.db[operator_rail.COLLECTION].find_one({})
        expected = {"code": "PROVIDER_AMOUNT_REJECTED", "http_status": 422}
        self.assertEqual(row["checkout_diagnostics"], expected)
        self.assertEqual(operator_rail.as_admin_deposit(row)["checkout_diagnostics"], expected)
        listing = await routes_payments.admin_deposits(status=None, admin={})
        self.assertEqual(listing["deposits"][0]["checkout_diagnostics"], expected)
        self.assertNotIn("checkout_diagnostics", operator_rail.as_player_deposit(row))
        self.assertNotIn("untrusted-secret", str(row))
        self.assertEqual(row["status"], "CREATED")
        self.assertEqual((await self.db.users.find_one({"id": self.user["id"]}))["chip_balance"], 100)

    async def test_success_clears_stale_diagnostic(self):
        error = ProviderRequestError("rejected", http_status=503)
        with patch.object(self.gateway, "create_deposit_order", AsyncMock(side_effect=error)):
            with self.assertRaises(HTTPException):
                await operator_rail.create_hosted_deposit(self.user, 10000, "diagnostic-clear-test", self.gateway)
        row, _ = await operator_rail.create_hosted_deposit(self.user, 10000, "diagnostic-clear-test", self.gateway)
        self.assertIsNone(row["checkout_diagnostics"])
        self.assertIsNone(row["last_error"])

    def test_admin_diagnostic_dto_rejects_arbitrary_data(self):
        for raw in ({"code": "secret", "http_status": 422}, "secret"):
            self.assertIsNone(operator_rail.as_admin_deposit({"checkout_diagnostics": raw})["checkout_diagnostics"])

    async def test_http_200_rejection_is_categorized_without_raw_body(self):
        gateway = fixtures.provider()
        with patch.object(gateway, "_request_json", AsyncMock(return_value={
            "message": "No active bank for private@example.com",
        })):
            with self.assertRaises(ProviderRequestError) as caught:
                await gateway.create_deposit_order(
                    deposit_id="diagnostic-order-123", amount_paise=10000, currency="INR",
                    idempotency_key="diagnostic-order-key", return_url=fixtures.PROVIDER_ENV["PAYMENT_RETURN_URL"],
                    customer=self.user,
                )
        self.assertEqual(caught.exception.diagnostic_code, "PROVIDER_PAYMENT_ROUTE_UNAVAILABLE")
        self.assertEqual(caught.exception.http_status, 200)
        self.assertNotIn("private@", str(caught.exception))

    def test_hosted_payout_metadata_matches_both_runtime_switches(self):
        operator = {"hosted_checkout": True, "deposits_enabled": True, "withdrawals_enabled": True}
        with patch("operator_rail.operator_status", return_value=operator):
            with patch("sgpay_payout.payouts_enabled", return_value=True):
                hosted = service.feature_status()["hosted_provider"]
                self.assertTrue(hosted["withdrawals_enabled"])
                self.assertEqual(hosted["withdrawal_mode"], "ADMIN_REVIEW")
            with patch("sgpay_payout.payouts_enabled", return_value=False):
                self.assertFalse(service.feature_status()["hosted_provider"]["withdrawals_enabled"])
            operator["withdrawals_enabled"] = False
            with patch("sgpay_payout.payouts_enabled", return_value=True):
                self.assertFalse(service.feature_status()["hosted_provider"]["withdrawals_enabled"])
