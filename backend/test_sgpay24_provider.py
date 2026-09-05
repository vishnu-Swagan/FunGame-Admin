"""SgPay24 hosted-UPI contract, trust-boundary, and idempotency tests.

All provider HTTP is mocked.  These tests deliberately treat the callback as
an unsigned notification and prove that only the authenticated status endpoint
can drive an operator-rail purchase to a terminal state or credit chips.
"""
from __future__ import annotations

import asyncio
import uuid
import json
import re
import os
import sys
import unittest
from datetime import datetime, timezone
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from mongomock_motor import AsyncMongoMockClient
from pydantic import ValidationError


HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("MONGO_URL", "mongodb://127.0.0.1:27017")
os.environ.setdefault("DB_NAME", "sgpay24_provider_import")
os.environ["APP_ENV"] = "test"

import operator_rail  # noqa: E402
import routes_payments as routes  # noqa: E402
from payment_providers import (  # noqa: E402
    DepositSession,
    DepositStatus,
    PayoutSubmission,
    ProviderConfigurationError,
    ProviderRequestError,
    SgPay24PaymentProvider,
    load_payment_provider,
)


PROVIDER_ENV = {
    "PAYMENT_PROVIDER": "sgpay24",
    "SGPAY24_MERCHANT_ID": "MERTEST123",
    "SGPAY24_API_TOKEN": "test-only-api-token-1234567890",
    "SGPAY24_CUSTOMER_EMAIL_FALLBACK": "payments@example.com",
    "SGPAY24_TIMEOUT_SECONDS": "7",
    "PAYMENT_RETURN_URL": "https://play.example.com/chips/deposit/return",
    "UPI_CHIPS_PER_INR": "1",
    "UPI_MAX_DAILY_DEPOSIT_PAISE": "10000000",  # ignored; buy cap is hardcoded ₹2L
}


def provider(overrides: dict[str, str] | None = None) -> SgPay24PaymentProvider:
    environ = dict(PROVIDER_ENV)
    environ.update(overrides or {})
    return SgPay24PaymentProvider(environ)


class SgPay24ProviderContractTests(unittest.IsolatedAsyncioTestCase):
    def test_load_and_configuration_validation_fail_closed(self):
        loaded = load_payment_provider(PROVIDER_ENV)
        self.assertIsInstance(loaded, SgPay24PaymentProvider)
        self.assertEqual(loaded.name, "sgpay24")
        self.assertEqual(loaded.checkout_allowed_hosts, ("root.sgpay24.com",))
        self.assertTrue(loaded.webhook_requires_status_lookup)

        invalid_cases = (
            ({"SGPAY24_MERCHANT_ID": "merchant-123"}, "MERCHANT_ID"),
            ({"SGPAY24_API_TOKEN": "too-short"}, "API_TOKEN"),
            ({"SGPAY24_TIMEOUT_SECONDS": "2"}, "TIMEOUT_SECONDS"),
            ({"SGPAY24_TIMEOUT_SECONDS": "not-an-int"}, "TIMEOUT_SECONDS"),
            ({"PAYMENT_RETURN_URL": "http://play.example.com/return"}, "RETURN_URL"),
            ({"PAYMENT_RETURN_URL": "https://user:pass@play.example.com/return"}, "RETURN_URL"),
            ({"SGPAY24_CUSTOMER_EMAIL_FALLBACK": "fallback.invalid"}, "EMAIL_FALLBACK"),
        )
        for overrides, field in invalid_cases:
            with self.subTest(field=field, overrides=overrides):
                with self.assertRaises(ProviderConfigurationError) as caught:
                    provider(overrides)
                self.assertIn(field, str(caught.exception))

    def test_hosted_rail_requires_explicit_rate_and_hardcodes_daily_limit(self):
        valid = {**PROVIDER_ENV, "UPI_CHIP_PURCHASES_ENABLED": "true"}
        self.assertEqual(operator_rail.hosted_upi_chips_per_inr(valid), 1)
        self.assertEqual(
            operator_rail.hosted_upi_daily_limit_paise(valid), 20_000_000,
        )
        self.assertEqual(
            operator_rail.hosted_upi_daily_limit_paise({"UPI_MAX_DAILY_DEPOSIT_PAISE": "50000"}),
            20_000_000,
        )
        self.assertEqual(operator_rail.hosted_upi_daily_limit_paise({}), 20_000_000)
        limits = operator_rail.operator_status()["limits"]
        self.assertEqual(limits["max_deposit_paise"], 20_000_000)
        self.assertEqual(limits["max_daily_deposit_paise"], 20_000_000)
        self.assertEqual(limits["min_deposit_paise"], 10_000)

        invalid_cases = (
            ("UPI_CHIPS_PER_INR", None),
            ("UPI_CHIPS_PER_INR", "0"),
            ("UPI_CHIPS_PER_INR", "1.5"),
        )
        for field, value in invalid_cases:
            with self.subTest(field=field, value=value):
                environ = dict(valid)
                if value is None:
                    environ.pop(field, None)
                else:
                    environ[field] = value
                with self.assertRaises(ProviderConfigurationError) as caught:
                    operator_rail.hosted_upi_provider(environ)
                self.assertIn(field, str(caught.exception))

        # A missing or lower env daily cap must not fail provider boot or keep 1L.
        for value in (None, "10000000", "not-an-int"):
            environ = dict(valid)
            if value is None:
                environ.pop("UPI_MAX_DAILY_DEPOSIT_PAISE", None)
            else:
                environ["UPI_MAX_DAILY_DEPOSIT_PAISE"] = value
            loaded = operator_rail.hosted_upi_provider(environ)
            self.assertEqual(loaded.name, "sgpay24")

    async def test_create_payload_uses_merchant_token_and_validates_checkout(self):
        gateway = provider()
        request_json = AsyncMock(return_value={
            "data": {
                "order_id": "order-12345678",
                "amount": "500.00",
                "transaction_id": 918273,
                "checkout_url": "https://root.sgpay24.com/api/pay/order-12345678?mode=upi",
                "status": 0,
                "type": "submitted",
            },
        })
        with patch.object(gateway, "_request_json", new=request_json):
            checkout = await gateway.create_deposit_order(
                deposit_id="order-12345678",
                amount_paise=50_000,
                currency="inr",
                idempotency_key="purchase-idempotency-123",
                return_url=(
                    "https://play.example.com/chips/deposit/return"
                    "?deposit_id=order-12345678"
                ),
                customer={
                    "full_name": "Test Player",
                    "email": "unverified@example.net",
                    "email_verified": False,
                    "phone": "+91 98765 43210",
                },
            )

        self.assertEqual(checkout, DepositSession(
            "order-12345678",
            "https://root.sgpay24.com/api/pay/order-12345678?mode=upi",
            "PENDING",
        ))
        request_json.assert_awaited_once()
        path, payload = request_json.await_args.args
        self.assertEqual(path, "/api/createPayingRequest")
        self.assertEqual(payload, {
            "merchant_id": PROVIDER_ENV["SGPAY24_MERCHANT_ID"],
            "order_id": "order-12345678",
            "amount": 500,
            "name": "Test Player",
            "email": PROVIDER_ENV["SGPAY24_CUSTOMER_EMAIL_FALLBACK"],
            "phone": "9876543210",
            "redirect_url": (
                "https://play.example.com/chips/deposit/return"
                "?deposit_id=order-12345678"
            ),
            "callback_url": "https://api.chakri.casino/api/payments/webhooks/sgpay24",
            "notify_url": "https://api.chakri.casino/api/payments/webhooks/sgpay24",
            "api_token": PROVIDER_ENV["SGPAY24_API_TOKEN"],
            "remark": "Chakri chips order-12345678",
        })

    async def test_create_rejects_provider_order_amount_and_checkout_substitution(self):
        cases = (
            ({
                "order_id": "other-order-1234", "amount": 500,
                "transaction_id": 11,
                "checkout_url": "https://root.sgpay24.com/api/pay/order-12345678",
                "status": 0,
            }, "requested order"),
            ({
                "order_id": "order-12345678", "amount": 501,
                "transaction_id": 11,
                "checkout_url": "https://root.sgpay24.com/api/pay/order-12345678",
                "status": 0,
            }, "requested order"),
            ({
                "order_id": "order-12345678", "amount": 500,
                "transaction_id": 11,
                "checkout_url": "https://attacker.example/api/pay/order-12345678",
                "status": 0,
            }, "unsafe"),
            ({
                "order_id": "order-12345678", "amount": 500,
                "transaction_id": True,
                "checkout_url": "https://root.sgpay24.com/api/pay/order-12345678",
                "status": 0,
            }, "transaction reference"),
        )
        for returned, message in cases:
            with self.subTest(returned=returned):
                gateway = provider()
                with patch.object(
                    gateway, "_request_json", new=AsyncMock(return_value={"data": returned}),
                ):
                    with self.assertRaises(ProviderRequestError) as caught:
                        await gateway.create_deposit_order(
                            deposit_id="order-12345678",
                            amount_paise=50_000,
                            currency="INR",
                            idempotency_key="purchase-idempotency-123",
                            return_url="https://play.example.com/chips/deposit/return",
                            customer={"full_name": "Test Player", "phone": "9876543210"},
                        )
                self.assertIn(message, str(caught.exception))

    async def test_status_maps_paid_pending_and_failed_using_authenticated_payload(self):
        cases = (
            ({
                "order_id": "order-12345678", "merchant_id": "MERTEST123",
                "amount": "500.00", "status": 1, "utr": "UTR12345678",
            }, DepositStatus("PAID", 50_000, "INR", "UTR12345678")),
            ({
                "order_id": "order-12345678", "merchant_id": "MERTEST123",
                "status": 0,
            }, DepositStatus("PENDING", 50_000, "INR", None)),
            ({
                "order_id": "order-12345678", "merchant_id": "MERTEST123",
                "amount": 500, "status": 2,
            }, DepositStatus(
                "FAILED", 50_000, "INR", "sgpay24:order-12345678:failed",
            )),
            ({
                "order_id": "order-12345678", "merchant_id": "MERTEST123",
                "amount": 500, "status": "Complete", "utr": "UTR12345678",
            }, DepositStatus("PAID", 50_000, "INR", "UTR12345678")),
            ({
                "order_id": "order-12345678", "merchant_id": "MERTEST123",
                "amount": 500, "status": "Completed", "utr": "UTR12345678",
            }, DepositStatus("PAID", 50_000, "INR", "UTR12345678")),
            ({
                "order_id": "order-12345678", "merchant_id": "MERTEST123",
                "amount": 500, "status": "Success", "utr": "UTR12345678",
            }, DepositStatus("PAID", 50_000, "INR", "UTR12345678")),
            ({
                "order_id": "order-12345678", "merchant_id": "MERTEST123",
                "amount": 500, "status": "Paid", "utr": "UTR12345678",
            }, DepositStatus("PAID", 50_000, "INR", "UTR12345678")),
            ({
                "order_id": "order-12345678", "merchant_id": "MERTEST123",
                "amount": 500, "status": "Failed",
            }, DepositStatus(
                "FAILED", 50_000, "INR", "sgpay24:order-12345678:failed",
            )),
            ({
                "order_id": "order-12345678", "merchant_id": "MERTEST123",
                "status": "Pending",
            }, DepositStatus("PENDING", 50_000, "INR", None)),
            ({
                "order_id": "order-12345678", "merchant_id": "MERTEST123",
                "status": "Processing",
            }, DepositStatus("PENDING", 50_000, "INR", None)),
            ({
                "order_id": "order-12345678", "merchant_id": "MERTEST123",
                "amount": 500, "status": "Complete", "utr": "",
            }, DepositStatus("PAID", 50_000, "INR", None)),
            ({
                "order_id": "order-12345678", "merchant_id": "MERTEST123",
                "amount": 500, "status": 1,
            }, DepositStatus("PAID", 50_000, "INR", None)),
        )
        for response, expected in cases:
            with self.subTest(response=response):
                gateway = provider()
                request_json = AsyncMock(return_value=response)
                with patch.object(gateway, "_request_json", new=request_json):
                    actual = await gateway.get_payment_status(
                        "order-12345678", expected_amount_paise=50_000,
                    )
                self.assertEqual(actual, expected)
                request_json.assert_awaited_once_with("/api/check-status", {
                    "merchant_id": PROVIDER_ENV["SGPAY24_MERCHANT_ID"],
                    "order_id": "order-12345678",
                    "api_token": PROVIDER_ENV["SGPAY24_API_TOKEN"],
                })

    async def test_status_parses_naive_ist_date_as_utc_occurred_at(self):
        gateway = provider()
        request_json = AsyncMock(return_value={
            "order_id": "order-12345678", "merchant_id": "MERTEST123",
            "amount": 500, "status": 1, "utr": "UTR12345678",
            "date": "2026-09-02 16:47:00",
        })
        with patch.object(gateway, "_request_json", new=request_json):
            actual = await gateway.get_payment_status(
                "order-12345678", expected_amount_paise=50_000,
            )
        self.assertEqual(actual.status, "PAID")
        self.assertEqual(
            actual.occurred_at,
            datetime(2026, 9, 2, 11, 17, tzinfo=timezone.utc),
        )

    async def test_status_prefers_paid_at_over_created_at(self):
        gateway = provider()
        request_json = AsyncMock(return_value={
            "order_id": "order-12345678", "merchant_id": "MERTEST123",
            "amount": 500, "status": 1, "utr": "UTR12345678",
            "created_at": "2026-09-02 12:02:05",
            "paid_at": "2026-09-02T16:47:00+05:30",
        })
        with patch.object(gateway, "_request_json", new=request_json):
            actual = await gateway.get_payment_status(
                "order-12345678", expected_amount_paise=50_000,
            )
        self.assertEqual(
            actual.occurred_at,
            datetime(2026, 9, 2, 11, 17, tzinfo=timezone.utc),
        )

    async def test_status_without_date_leaves_occurred_at_none(self):
        gateway = provider()
        request_json = AsyncMock(return_value={
            "order_id": "order-12345678", "merchant_id": "MERTEST123",
            "amount": "500.00", "status": 1, "utr": "UTR12345678",
        })
        with patch.object(gateway, "_request_json", new=request_json):
            actual = await gateway.get_payment_status(
                "order-12345678", expected_amount_paise=50_000,
            )
        self.assertIsNone(actual.occurred_at)

    def test_webhook_parses_updated_at_when_present(self):
        gateway = provider()
        raw = json.dumps({
            "order_id": "order-12345678",
            "amount": 500,
            "status": 1,
            "transaction_id": 918273,
            "utr": "CALLBACK-CLAIMED-UTR",
            "updated_at": "2026-09-02T16:47:00+05:30",
        }).encode()
        event = gateway.verify_webhook(raw, {})
        self.assertEqual(event.occurred_at, "2026-09-02T11:17:00.000Z")

    def test_webhook_without_date_leaves_occurred_at_none(self):
        gateway = provider()
        raw = json.dumps({
            "order_id": "order-12345678",
            "amount": 500,
            "status": 1,
            "transaction_id": 918273,
            "utr": "CALLBACK-CLAIMED-UTR",
        }).encode()
        event = gateway.verify_webhook(raw, {})
        self.assertIsNone(event.occurred_at)

    async def test_status_rejects_wrong_order_merchant_and_amount(self):
        responses = (
            {
                "order_id": "other-order-1234", "merchant_id": "MERTEST123",
                "amount": 500, "status": 0,
            },
            {
                "order_id": "order-12345678", "merchant_id": "MEROTHER99",
                "amount": 500, "status": 0,
            },
            {
                "order_id": "order-12345678", "merchant_id": "MERTEST123",
                "amount": 499, "status": 0,
            },
        )
        for response in responses:
            with self.subTest(response=response):
                gateway = provider()
                with patch.object(
                    gateway, "_request_json", new=AsyncMock(return_value=response),
                ):
                    with self.assertRaises(ProviderRequestError):
                        await gateway.get_payment_status(
                            "order-12345678", expected_amount_paise=50_000,
                        )

    async def test_status_requires_numeric_payment_status_even_when_type_says_success(self):
        responses = (
            {
                "order_id": "order-12345678", "merchant_id": "MERTEST123",
                "amount": 500, "type": "success", "utr": "UTR12345678",
            },
            {
                "order_id": "order-12345678", "merchant_id": "MERTEST123",
                "amount": 500, "status": True, "type": "success",
                "utr": "UTR12345678",
            },
            {
                "order_id": "order-12345678", "merchant_id": "MERTEST123",
                "amount": 500, "status": 1.0, "type": "success",
                "utr": "UTR12345678",
            },
            {
                "order_id": "order-12345678", "merchant_id": "MERTEST123",
                "amount": 500, "status": 3, "type": "success",
                "utr": "UTR12345678",
            },
        )
        for response in responses:
            with self.subTest(response=response):
                gateway = provider()
                with patch.object(
                    gateway, "_request_json", new=AsyncMock(return_value=response),
                ):
                    with self.assertRaises(ProviderRequestError):
                        await gateway.get_payment_status(
                            "order-12345678", expected_amount_paise=50_000,
                        )

    def test_unsigned_webhook_is_only_a_notice_requiring_authenticated_lookup(self):
        gateway = provider()
        raw = json.dumps({
            "order_id": "order-12345678",
            "amount": "999.99",
            "status": 1,
            "transaction_id": 918273,
            "utr": "CALLBACK-CLAIMED-UTR",
        }).encode()

        event = gateway.verify_webhook(raw, {})

        self.assertEqual(event.object_id, "order-12345678")
        self.assertEqual(event.amount_paise, 99_999)
        self.assertEqual(event.provider_reference, "CALLBACK-CLAIMED-UTR")
        self.assertTrue(event.data["requires_authenticated_status_lookup"])
        self.assertEqual(event.data["transaction_id"], 918273)


class RecordingSgPay24Gateway:
    """Protocol fake used only for operator-rail persistence tests."""

    name = "sgpay24"
    checkout_allowed_hosts = ("root.sgpay24.com",)

    def __init__(self):
        self.create_calls: list[dict] = []
        self.status_calls: list[tuple[str, int | None]] = []
        self.status = DepositStatus("PENDING", 50_000, "INR", None)

    async def create_deposit_order(self, **kwargs):
        self.create_calls.append(dict(kwargs))
        order_id = str(kwargs["deposit_id"])
        return DepositSession(
            order_id,
            f"https://root.sgpay24.com/api/pay/{order_id}",
            "PENDING",
        )

    async def get_payment_status(self, provider_order_id, *, expected_amount_paise=None):
        self.status_calls.append((provider_order_id, expected_amount_paise))
        return self.status


class StreamingRequest:
    def __init__(self, body: bytes):
        self.body = body
        self.headers: dict[str, str] = {}

    async def stream(self):
        yield self.body


class HostedUpiOperatorRailTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.saved_env = {
            key: os.environ.get(key)
            for key in (
                *PROVIDER_ENV, "UPI_CHIP_PURCHASES_ENABLED", "APP_ENV",
                "FINANCIAL_ALLOWED_COUNTRIES",
            )
        }
        os.environ.update(PROVIDER_ENV)
        os.environ["UPI_CHIP_PURCHASES_ENABLED"] = "true"
        os.environ["APP_ENV"] = "test"
        os.environ["FINANCIAL_ALLOWED_COUNTRIES"] = "IN"

        self.client = AsyncMongoMockClient()
        self.db = self.client["sgpay24_operator_rail_test"]
        self.original_operator_db = operator_rail.db
        self.original_ledger_db = operator_rail.ledger.db
        self.original_finance_db = operator_rail.finance.db
        self.original_compliance_db = operator_rail.compliance.db
        self.original_routes_db = routes.db
        import wager
        import free_cash
        self.original_wager_db = wager.db
        self.original_free_cash_db = free_cash.db
        operator_rail.db = self.db
        operator_rail.ledger.db = self.db
        operator_rail.finance.db = self.db
        operator_rail.compliance.db = self.db
        routes.db = self.db
        wager.db = self.db
        free_cash.db = self.db
        self.user = {
            "id": "player-sgpay24",
            "role": "PLAYER",
            "status": "ACTIVE",
            "full_name": "UPI Test Player",
            "email": "player@example.com",
            "email_verified": True,
            "phone": "+91 98765 43210",
            "phone_verified": True,
            "age_verified": True,
            "kyc_status": "VERIFIED",
            "financial_status": "ACTIVE",
            "country": "IN",
            "chip_balance": 100,
        }
        await self.db.users.insert_one(dict(self.user))
        self.gateway = RecordingSgPay24Gateway()

    async def asyncTearDown(self):
        operator_rail.db = self.original_operator_db
        operator_rail.ledger.db = self.original_ledger_db
        operator_rail.finance.db = self.original_finance_db
        operator_rail.compliance.db = self.original_compliance_db
        routes.db = self.original_routes_db
        import wager
        import free_cash
        wager.db = self.original_wager_db
        free_cash.db = self.original_free_cash_db
        for key, value in self.saved_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        self.client.close()

    async def test_purchase_creation_is_idempotent_and_reuses_one_checkout(self):
        first, first_url = await operator_rail.create_hosted_deposit(
            self.user, 50_000, "buy-chips-request-0001", self.gateway,
        )
        second, second_url = await operator_rail.create_hosted_deposit(
            self.user, 50_000, "buy-chips-request-0001", self.gateway,
        )

        self.assertEqual(first["id"], second["id"])
        self.assertEqual(first_url, second_url)
        self.assertEqual(len(self.gateway.create_calls), 1)
        self.assertEqual(
            await self.db[operator_rail.COLLECTION].count_documents({}), 1,
        )
        created = self.gateway.create_calls[0]
        self.assertEqual(created["amount_paise"], 50_000)
        self.assertEqual(created["currency"], "INR")
        self.assertEqual(created["customer"]["phone"], "9876543210")
        self.assertTrue(created["return_url"].endswith(f"deposit_id={first['id']}"))

        with self.assertRaises(HTTPException) as conflict:
            await operator_rail.create_hosted_deposit(
                self.user, 60_000, "buy-chips-request-0001", self.gateway,
            )
        self.assertEqual(conflict.exception.status_code, 409)
        self.assertEqual(conflict.exception.detail["code"], "IDEMPOTENCY_CONFLICT")
        self.assertEqual(len(self.gateway.create_calls), 1)

    async def test_audited_manual_contact_approval_reaches_hosted_checkout(self):
        reviewed = {
            **self.user,
            "phone_verified": False,
            "email_verified": False,
            "registration_source": "SELF_SERVICE",
            "activation_mode": "ADMIN_REVIEW",
            "manual_contact_reviewed": True,
            "contact_verification_status": "ADMIN_APPROVED",
            "accepted_terms": True,
            "submitted_at": operator_rail.utcnow(),
            "email_normalized": self.user["email"],
            "phone": "+919876543210",
            "phone_normalized": "+919876543210",
            "primary_identity": "+919876543210",
            "primary_identity_channel": "PHONE",
            "approved_at": operator_rail.utcnow(),
            "manual_contact_reviewed_by": "registration-admin",
        }
        reviewed["manual_contact_reviewed_at"] = reviewed["approved_at"]
        reviewed["approved_by"] = reviewed["manual_contact_reviewed_by"]
        await self.db.users.replace_one({"id": reviewed["id"]}, reviewed)

        purchase, checkout = await operator_rail.create_hosted_deposit(
            reviewed, 10_000, "manual-review-purchase-0001", self.gateway,
        )

        self.assertEqual(purchase["status"], "PENDING")
        self.assertTrue(checkout.startswith("https://root.sgpay24.com/api/pay/"))
        self.assertEqual(self.gateway.create_calls[0]["customer"]["phone"], "9876543210")
        self.assertTrue(self.gateway.create_calls[0]["customer"]["phone_verified"])
        self.assertEqual(
            await self.db[operator_rail.COLLECTION].count_documents({}), 1,
        )

    async def test_hosted_retry_and_credit_recheck_fresh_eligibility(self):
        purchase, checkout = await operator_rail.create_hosted_deposit(
            self.user, 10_000, "fresh-eligibility-recheck-0001", self.gateway,
        )
        self.assertTrue(checkout)

        await self.db.users.update_one(
            {"id": self.user["id"]}, {"$set": {"age_verified": False}},
        )
        with self.assertRaises(HTTPException) as revoked:
            await operator_rail.create_hosted_deposit(
                self.user, 10_000, "fresh-eligibility-recheck-0001", self.gateway,
            )
        self.assertEqual(revoked.exception.detail["code"], "AGE_NOT_VERIFIED")

        await self.db.users.update_one(
            {"id": self.user["id"]},
            {"$set": {"age_verified": True, "financial_status": "BLOCKED"}},
        )
        await self.db[operator_rail.COLLECTION].update_one(
            {"id": purchase["id"]},
            {"$set": {"status": "PENDING", "utr_claim": "RESTRICTED-UTR-1"}},
        )
        self.gateway.status = DepositStatus("PAID", 10_000, "INR", "RESTRICTED-UTR-1")
        result = await operator_rail.reconcile_hosted_deposit(purchase["id"], self.gateway)

        self.assertEqual(result["status"], "RECONCILIATION_REQUIRED")
        player = await self.db.users.find_one({"id": self.user["id"]})
        self.assertEqual(player["chip_balance"], 100)

    async def test_minimum_buy_is_one_hundred_rupees(self):
        purchase, _ = await operator_rail.create_hosted_deposit(
            self.user, 10_000, "minimum-buy-one-hundred", self.gateway,
        )
        self.assertEqual(purchase["amount_paise"], 10_000)
        self.assertEqual(purchase["chips"], 100)
        with self.assertRaises(HTTPException) as below_minimum:
            await operator_rail.create_hosted_deposit(
                self.user, 9_999, "below-minimum-buy-value", self.gateway,
            )
        self.assertEqual(below_minimum.exception.status_code, 400)
        self.assertEqual(below_minimum.exception.detail["code"], "OPERATOR_AMOUNT_INVALID")
        self.assertEqual(
            await self.db[operator_rail.COLLECTION].count_documents({}), 1,
        )

    async def test_concurrent_hosted_purchases_reserve_daily_cap_atomically(self):
        with patch.dict(
            os.environ, {"UPI_MAX_DAILY_DEPOSIT_PAISE": "50000"}, clear=False,
        ):
            results = await asyncio.gather(
                operator_rail.create_hosted_deposit(
                    self.user, 20_000_000, "daily-cap-concurrent-a", self.gateway,
                ),
                operator_rail.create_hosted_deposit(
                    self.user, 20_000_000, "daily-cap-concurrent-b", self.gateway,
                ),
                return_exceptions=True,
            )

        successes = [item for item in results if not isinstance(item, Exception)]
        failures = [item for item in results if isinstance(item, HTTPException)]
        self.assertEqual((len(successes), len(failures)), (1, 1))
        self.assertEqual(failures[0].status_code, 409)
        self.assertEqual(failures[0].detail["code"], "UPI_DAILY_LIMIT")
        self.assertEqual(
            await self.db[operator_rail.COLLECTION].count_documents({}), 1,
        )
        stored = await self.db[operator_rail.COLLECTION].find_one({})
        self.assertEqual(stored["reservation_gaming_day"], operator_rail.buy_chips_ist_day())
        self.assertEqual(
            await self.db[operator_rail.DAILY_GUARD_COLLECTION].count_documents({}), 1,
        )

    async def test_player_limits_deposit_rows_do_not_block_hosted_buy(self):
        await self.db.player_limits.insert_one({
            "user_id": self.user["id"],
            "kind": operator_rail.finance.compliance.DEPOSIT,
            "period": "DAY",
            "amount": 500,
        })
        first, _ = await operator_rail.create_hosted_deposit(
            self.user, 50_000, "player-limit-a", self.gateway,
        )
        second, _ = await operator_rail.create_hosted_deposit(
            self.user, 50_000, "player-limit-b", self.gateway,
        )
        self.assertEqual(first["amount_paise"], 50_000)
        self.assertEqual(second["amount_paise"], 50_000)
        self.assertEqual(
            await self.db[operator_rail.COLLECTION].count_documents({}), 2,
        )

    async def test_two_lakh_exact_buy_allowed_and_overflow_rejected(self):
        exact, _ = await operator_rail.create_hosted_deposit(
            self.user, 20_000_000, "exact-two-lakh", self.gateway,
        )
        self.assertEqual(exact["amount_paise"], 20_000_000)
        with self.assertRaises(HTTPException) as overflow:
            await operator_rail.create_hosted_deposit(
                self.user, 10_000, "after-exact-two-lakh", self.gateway,
            )
        self.assertEqual(overflow.exception.status_code, 409)
        self.assertEqual(overflow.exception.detail["code"], "UPI_DAILY_LIMIT")

    async def test_two_lakh_minus_one_hundred_plus_two_hundred_is_rejected(self):
        first, _ = await operator_rail.create_hosted_deposit(
            self.user, 19_990_000, "two-lakh-minus-100", self.gateway,
        )
        self.assertEqual(first["amount_paise"], 19_990_000)
        with self.assertRaises(HTTPException) as overflow:
            await operator_rail.create_hosted_deposit(
                self.user, 20_000, "plus-200", self.gateway,
            )
        self.assertEqual(overflow.exception.status_code, 409)
        self.assertEqual(overflow.exception.detail["code"], "UPI_DAILY_LIMIT")
        leftover, _ = await operator_rail.create_hosted_deposit(
            self.user, 10_000, "remaining-one-hundred", self.gateway,
        )
        self.assertEqual(leftover["amount_paise"], 10_000)

    async def test_daily_buy_cap_uses_asia_kolkata_calendar_day_not_london(self):
        late_ist = datetime(2026, 9, 3, 18, 29, tzinfo=timezone.utc)
        next_ist = datetime(2026, 9, 3, 18, 30, tzinfo=timezone.utc)
        with patch.object(operator_rail, "utcnow", return_value=late_ist):
            await operator_rail.create_hosted_deposit(
                self.user, 20_000_000, "ist-day-full", self.gateway,
            )
            with self.assertRaises(HTTPException) as same_day:
                await operator_rail.create_hosted_deposit(
                    self.user, 10_000, "ist-day-over", self.gateway,
                )
            self.assertEqual(same_day.exception.detail["code"], "UPI_DAILY_LIMIT")
        with patch.object(operator_rail, "utcnow", return_value=next_ist):
            nxt, _ = await operator_rail.create_hosted_deposit(
                self.user, 20_000_000, "next-ist-day", self.gateway,
            )
        self.assertEqual(nxt["amount_paise"], 20_000_000)
        self.assertEqual(nxt["reservation_gaming_day"], "2026-09-04")

    async def test_admin_review_and_hosted_upi_share_one_ist_daily_cap(self):
        admin = await operator_rail.create_request(
            self.user, kind="DEPOSIT", amount_paise=19_990_000,
        )
        self.assertEqual(admin["source"], "ADMIN_REVIEW")
        with self.assertRaises(HTTPException) as overflow:
            await operator_rail.create_hosted_deposit(
                self.user, 20_000, "shared-cap-over", self.gateway,
            )
        self.assertEqual(overflow.exception.detail["code"], "UPI_DAILY_LIMIT")

    async def test_lower_env_cannot_keep_one_lakh_transaction_cap(self):
        with patch.dict(
            os.environ, {"UPI_MAX_DAILY_DEPOSIT_PAISE": "10000000"}, clear=False,
        ):
            purchase, _ = await operator_rail.create_hosted_deposit(
                self.user, 15_000_000, "above-old-one-lakh", self.gateway,
            )
        self.assertEqual(purchase["amount_paise"], 15_000_000)

    async def test_terminal_idempotency_reuse_never_returns_checkout_redirect(self):
        purchase, checkout_url = await operator_rail.create_hosted_deposit(
            self.user, 50_000, "terminal-idempotency-key", self.gateway,
        )
        self.assertTrue(checkout_url)
        await operator_rail.settle_hosted_deposit(
            purchase["id"],
            DepositStatus("FAILED", 50_000, "INR", "sgpay24:failed"),
            actor="test-failure",
        )

        terminal, retry_url = await operator_rail.create_hosted_deposit(
            self.user, 50_000, "terminal-idempotency-key", self.gateway,
        )

        self.assertEqual(terminal["status"], "FAILED")
        self.assertEqual(retry_url, "")
        self.assertEqual(len(self.gateway.create_calls), 1)

    async def test_admin_cannot_approve_or_credit_a_hosted_upi_purchase(self):
        purchase, _ = await operator_rail.create_hosted_deposit(
            self.user, 50_000, "admin-resolve-hosted-upi", self.gateway,
        )
        with self.assertRaises(HTTPException) as rejected:
            await operator_rail.resolve_request(
                purchase["id"], {"id": "admin-1"}, approve=True,
            )
        self.assertEqual(rejected.exception.status_code, 409)
        self.assertEqual(
            rejected.exception.detail["code"],
            "UPI_PROVIDER_VERIFICATION_REQUIRED",
        )
        self.assertEqual((await self.db.users.find_one({"id": self.user["id"]}))["chip_balance"], 100)
        self.assertEqual(await self.db.chip_transactions.count_documents({}), 0)

    async def test_settle_persists_provider_occurred_at_and_does_not_overwrite(self):
        purchase, _ = await operator_rail.create_hosted_deposit(
            self.user, 50_000, "buy-chips-timestamp-0001", self.gateway,
        )
        captured = datetime(2026, 9, 2, 11, 17, tzinfo=timezone.utc)
        later = datetime(2026, 9, 2, 11, 47, tzinfo=timezone.utc)
        credited = await operator_rail.settle_hosted_deposit(
            purchase["id"],
            DepositStatus("PAID", 50_000, "INR", "UTR-CAPTURE-TIME", captured),
            actor="test-status-check",
        )
        self.assertEqual(credited["status"], "CREDITED")
        stored = await self.db[operator_rail.COLLECTION].find_one({"id": purchase["id"]})
        self.assertEqual(operator_rail.isoformat_utc(stored["provider_occurred_at"]), "2026-09-02T11:17:00.000Z")
        dto = operator_rail.as_player_deposit(stored)
        self.assertEqual(dto["paid_at"], "2026-09-02T11:17:00.000Z")
        self.assertNotEqual(dto["paid_at"], dto["created_at"])

        await operator_rail.settle_hosted_deposit(
            purchase["id"],
            DepositStatus("PAID", 50_000, "INR", "UTR-CAPTURE-TIME", later),
            actor="late-reconcile",
        )
        stored = await self.db[operator_rail.COLLECTION].find_one({"id": purchase["id"]})
        self.assertEqual(operator_rail.isoformat_utc(stored["provider_occurred_at"]), "2026-09-02T11:17:00.000Z")

    async def test_player_dto_falls_back_to_resolved_at_when_provider_date_missing(self):
        purchase, _ = await operator_rail.create_hosted_deposit(
            self.user, 50_000, "buy-chips-timestamp-fallback", self.gateway,
        )
        credited = await operator_rail.settle_hosted_deposit(
            purchase["id"],
            DepositStatus("PAID", 50_000, "INR", "UTR-NO-DATE"),
            actor="test-status-check",
        )
        self.assertEqual(credited["status"], "CREDITED")
        stored = await self.db[operator_rail.COLLECTION].find_one({"id": purchase["id"]})
        self.assertIsNone(stored.get("provider_occurred_at"))
        dto = operator_rail.as_player_deposit(stored)
        self.assertEqual(dto["paid_at"], dto["resolved_at"])
        self.assertNotEqual(dto["paid_at"], dto["created_at"])

    async def test_reconciliation_passes_expected_amount_and_credits_exactly_once(self):
        purchase, _ = await operator_rail.create_hosted_deposit(
            self.user, 50_000, "buy-chips-request-0002", self.gateway,
        )
        order_id = purchase["provider_order_id"]

        pending = await operator_rail.reconcile_hosted_deposit(
            purchase["id"], self.gateway,
        )
        self.assertEqual(pending["status"], "PENDING")
        self.assertEqual(self.gateway.status_calls, [(order_id, 50_000)])
        self.assertEqual((await self.db.users.find_one({"id": self.user["id"]}))["chip_balance"], 100)

        self.gateway.status = DepositStatus("PAID", 50_000, "INR", "UTR-EXACTLY-ONCE")
        await self.db[operator_rail.COLLECTION].update_one(
            {"id": purchase["id"]},
            {"$set": {"utr_claim": "UTR-EXACTLY-ONCE"}},
        )
        credited = await operator_rail.reconcile_hosted_deposit(
            purchase["id"], self.gateway, actor="test-status-check",
        )
        duplicate = await operator_rail.settle_hosted_deposit(
            purchase["id"], self.gateway.status, actor="duplicate-callback",
        )

        self.assertEqual(credited["status"], "CREDITED")
        self.assertFalse(credited["duplicate"])
        self.assertTrue(duplicate["duplicate"])
        player = await self.db.users.find_one({"id": self.user["id"]})
        self.assertEqual(player["chip_balance"], 600)
        self.assertEqual(await self.db.chip_transactions.count_documents({
            "user_id": self.user["id"],
            "kind": operator_rail.ledger.DEPOSIT,
            "ref": f"upi-chip:{purchase['id']}",
        }), 1)
        stored = await self.db[operator_rail.COLLECTION].find_one({"id": purchase["id"]})
        self.assertEqual(stored["status"], "CREDITED")
        self.assertEqual(stored["provider_reference"], "UTR-EXACTLY-ONCE")

    async def test_verified_failure_and_amount_mismatch_never_credit_chips(self):
        failed, _ = await operator_rail.create_hosted_deposit(
            self.user, 50_000, "buy-chips-request-failed", self.gateway,
        )
        self.gateway.status = DepositStatus(
            "FAILED", 50_000, "INR", f"sgpay24:{failed['provider_order_id']}:failed",
        )
        result = await operator_rail.reconcile_hosted_deposit(failed["id"], self.gateway)
        self.assertEqual(result["status"], "FAILED")

        mismatch, _ = await operator_rail.create_hosted_deposit(
            self.user, 60_000, "buy-chips-request-mismatch", self.gateway,
        )
        self.gateway.status = DepositStatus("PAID", 50_000, "INR", "UTR-MISMATCH")
        result = await operator_rail.reconcile_hosted_deposit(mismatch["id"], self.gateway)
        self.assertEqual(result["status"], "RECONCILIATION_REQUIRED")
        player = await self.db.users.find_one({"id": self.user["id"]})
        self.assertEqual(player["chip_balance"], 100)
        self.assertEqual(await self.db.chip_transactions.count_documents({}), 0)

    async def test_unsigned_route_callback_uses_authenticated_status_not_claimed_values(self):
        purchase, _ = await operator_rail.create_hosted_deposit(
            self.user, 50_000, "buy-chips-request-webhook", self.gateway,
        )
        gateway = provider()
        request_json = AsyncMock(return_value={
            "order_id": purchase["provider_order_id"],
            "merchant_id": PROVIDER_ENV["SGPAY24_MERCHANT_ID"],
            "status": 0,
            # Deliberately omitted: the adapter must bind this to the stored
            # expected amount supplied by the route.
        })
        raw = json.dumps({
            "order_id": purchase["provider_order_id"],
            "amount": 999.99,
            "status": 1,
            "transaction_id": 456789,
            "utr": "UNTRUSTED-CALLBACK-UTR",
        }).encode()

        with (
            patch.object(gateway, "_request_json", new=request_json),
            patch.object(routes, "_provider", return_value=gateway),
            patch.object(
                routes.finance, "financial_status",
                return_value={"ready": False, "features": {"real_money": False}},
            ),
        ):
            pending = await routes.provider_webhook("sgpay24", StreamingRequest(raw))

            self.assertEqual(pending["status"], "PENDING")
            self.assertEqual((await self.db.users.find_one({"id": self.user["id"]}))["chip_balance"], 100)
            _, status_payload = request_json.await_args.args
            self.assertEqual(status_payload["api_token"], PROVIDER_ENV["SGPAY24_API_TOKEN"])

            request_json.return_value = {
                "order_id": purchase["provider_order_id"],
                "merchant_id": PROVIDER_ENV["SGPAY24_MERCHANT_ID"],
                "amount": 500,
                "status": 1,
                "utr": "AUTHENTICATED-UTR-123",
            }
            await self.db[operator_rail.COLLECTION].update_one(
                {"id": purchase["id"]},
                {"$set": {"utr_claim": "AUTHENTICATED-UTR-123"}},
            )
            credited = await routes.provider_webhook("sgpay24", StreamingRequest(raw))
            duplicate = await routes.provider_webhook("sgpay24", StreamingRequest(raw))

        self.assertEqual(credited["status"], "CREDITED")
        self.assertFalse(credited["duplicate"])
        self.assertTrue(duplicate["duplicate"])
        self.assertEqual(request_json.await_count, 3)
        player = await self.db.users.find_one({"id": self.user["id"]})
        self.assertEqual(player["chip_balance"], 600)
        self.assertEqual(await self.db.chip_transactions.count_documents({
            "ref": f"upi-chip:{purchase['id']}",
        }), 1)
        stored = await self.db[operator_rail.COLLECTION].find_one({"id": purchase["id"]})
        self.assertEqual(stored["provider_reference"], "AUTHENTICATED-UTR-123")
        self.assertNotEqual(stored["provider_reference"], "UNTRUSTED-CALLBACK-UTR")

    async def test_utr_endpoint_rejects_wrong_claim_then_credits_correct_claim_once(self):
        purchase, _ = await operator_rail.create_hosted_deposit(
            self.user, 50_000, "buy-chips-request-utr", self.gateway,
        )
        self.gateway.status = DepositStatus(
            "PAID", 50_000, "INR", "AUTHENTICATED-UTR-9001",
        )
        rate_limit = AsyncMock()
        with (
            patch.object(
                operator_rail, "hosted_upi_reconciliation_provider",
                return_value=self.gateway,
            ),
            patch.object(routes, "_financial_rate_limit", new=rate_limit),
        ):
            with self.assertRaises(HTTPException) as rejected:
                await routes.submit_deposit_utr(
                    purchase["id"], routes.UtrSubmission(utr="wrong-utr-9001"), self.user,
                )
            self.assertEqual(rejected.exception.status_code, 409)
            self.assertEqual(rejected.exception.detail["code"], "UPI_UTR_NOT_CONFIRMED")
            self.assertNotIn("WRONG-UTR-9001", json.dumps(rejected.exception.detail).upper())
            self.assertEqual(
                (await self.db.users.find_one({"id": self.user["id"]}))["chip_balance"],
                100,
            )

            accepted = await routes.submit_deposit_utr(
                purchase["id"],
                routes.UtrSubmission(utr="authenticated-utr-9001"),
                self.user,
            )
            repeated = await routes.submit_deposit_utr(
                purchase["id"],
                routes.UtrSubmission(utr="AUTHENTICATED-UTR-9001"),
                self.user,
            )

        self.assertEqual(accepted["deposit"]["status"], "CREDITED")
        self.assertEqual(repeated["deposit"]["status"], "CREDITED")
        self.assertNotIn("utr_claim", accepted["deposit"])
        self.assertNotIn("provider_reference", accepted["deposit"])
        self.assertNotIn(
            "AUTHENTICATED-UTR-9001", json.dumps(accepted, default=str).upper(),
        )
        self.assertNotIn(
            "AUTHENTICATED-UTR-9001", json.dumps(repeated, default=str).upper(),
        )
        self.assertEqual(self.gateway.status_calls, [
            (purchase["provider_order_id"], 50_000),
            (purchase["provider_order_id"], 50_000),
        ])
        self.assertEqual(rate_limit.await_count, 3)
        stored = await self.db[operator_rail.COLLECTION].find_one({"id": purchase["id"]})
        self.assertEqual(stored["utr_claim"], "AUTHENTICATED-UTR-9001")
        self.assertEqual(stored["provider_reference"], "AUTHENTICATED-UTR-9001")
        self.assertEqual((await self.db.users.find_one({"id": self.user["id"]}))["chip_balance"], 600)
        self.assertEqual(await self.db.chip_transactions.count_documents({
            "ref": f"upi-chip:{purchase['id']}",
        }), 1)

    async def test_malformed_and_other_user_utr_are_rejected_without_mutation(self):
        purchase, _ = await operator_rail.create_hosted_deposit(
            self.user, 50_000, "buy-chips-utr-access-control", self.gateway,
        )
        with self.assertRaises(ValidationError):
            routes.UtrSubmission(utr="bad utr!")
        with self.assertRaises(HTTPException) as malformed:
            await operator_rail.submit_hosted_utr(
                purchase["id"], self.user["id"], "bad utr!", self.gateway,
            )
        self.assertEqual(malformed.exception.status_code, 400)
        self.assertEqual(malformed.exception.detail["code"], "UPI_UTR_INVALID")

        with self.assertRaises(HTTPException) as other_user:
            await operator_rail.submit_hosted_utr(
                purchase["id"], "another-player", "VALID-UTR-123", self.gateway,
            )
        self.assertEqual(other_user.exception.status_code, 404)
        self.assertEqual(other_user.exception.detail["code"], "UPI_PURCHASE_NOT_FOUND")
        stored = await self.db[operator_rail.COLLECTION].find_one({"id": purchase["id"]})
        self.assertNotIn("utr_claim", stored)
        self.assertEqual((await self.db.users.find_one({"id": self.user["id"]}))["chip_balance"], 100)

    async def test_paid_status_without_utr_claim_credits_provider_utr(self):
        purchase, _ = await operator_rail.create_hosted_deposit(
            self.user, 50_000, "paid-without-user-utr", self.gateway,
        )
        result = await operator_rail.settle_hosted_deposit(
            purchase["id"],
            DepositStatus("PAID", 50_000, "INR", "PROVIDER-UTR-NO-CLAIM"),
            actor="authenticated-status",
        )

        self.assertEqual(result["status"], "CREDITED")
        stored = await self.db[operator_rail.COLLECTION].find_one({"id": purchase["id"]})
        self.assertEqual(stored["provider_reference"], "PROVIDER-UTR-NO-CLAIM")
        self.assertEqual((await self.db.users.find_one({"id": self.user["id"]}))["chip_balance"], 600)
        self.assertEqual(await self.db.chip_transactions.count_documents({
            "ref": f"upi-chip:{purchase['id']}",
        }), 1)

        duplicate = await operator_rail.settle_hosted_deposit(
            purchase["id"],
            DepositStatus("PAID", 50_000, "INR", "PROVIDER-UTR-NO-CLAIM"),
            actor="duplicate-callback",
        )
        self.assertTrue(duplicate["duplicate"])
        self.assertEqual((await self.db.users.find_one({"id": self.user["id"]}))["chip_balance"], 600)

    async def test_mismatched_player_utr_stays_pending(self):
        purchase, _ = await operator_rail.create_hosted_deposit(
            self.user, 50_000, "paid-with-wrong-user-utr", self.gateway,
        )
        await self.db[operator_rail.COLLECTION].update_one(
            {"id": purchase["id"]},
            {"$set": {"utr_claim": "PLAYER-PASTED-OTHER"}},
        )
        result = await operator_rail.settle_hosted_deposit(
            purchase["id"],
            DepositStatus("PAID", 50_000, "INR", "PROVIDER-UTR-REAL"),
            actor="authenticated-status",
        )
        self.assertEqual(result["status"], "PENDING")
        self.assertTrue(result["utr_mismatch"])
        stored = await self.db[operator_rail.COLLECTION].find_one({"id": purchase["id"]})
        self.assertEqual(stored["last_error"], "UTR_MISMATCH")
        self.assertEqual((await self.db.users.find_one({"id": self.user["id"]}))["chip_balance"], 100)
        self.assertEqual(await self.db.chip_transactions.count_documents({}), 0)

    async def test_paid_without_provider_utr_credits_synthetic_reference(self):
        purchase, _ = await operator_rail.create_hosted_deposit(
            self.user, 50_000, "paid-without-provider-utr", self.gateway,
        )
        result = await operator_rail.settle_hosted_deposit(
            purchase["id"],
            DepositStatus("PAID", 50_000, "INR", None),
            actor="authenticated-status",
        )
        self.assertEqual(result["status"], "CREDITED")
        stored = await self.db[operator_rail.COLLECTION].find_one({"id": purchase["id"]})
        seed = re.sub(
            r"[^A-Z0-9]", "",
            str(stored.get("provider_order_id") or stored["id"]).upper(),
        )
        self.assertEqual(stored["provider_reference"], f"SGPAY-{seed[:74]}")
        self.assertFalse(stored.get("utr_claim"))
        self.assertEqual((await self.db.users.find_one({"id": self.user["id"]}))["chip_balance"], 600)
        self.assertEqual(await self.db.chip_transactions.count_documents({
            "ref": f"upi-chip:{purchase['id']}",
        }), 1)

        duplicate = await operator_rail.settle_hosted_deposit(
            purchase["id"],
            DepositStatus("PAID", 50_000, "INR", ""),
            actor="duplicate-callback",
        )
        self.assertTrue(duplicate["duplicate"])
        stored = await self.db[operator_rail.COLLECTION].find_one({"id": purchase["id"]})
        self.assertEqual(stored["provider_reference"], f"SGPAY-{seed[:74]}")
        self.assertEqual((await self.db.users.find_one({"id": self.user["id"]}))["chip_balance"], 600)
        self.assertEqual(await self.db.chip_transactions.count_documents({
            "ref": f"upi-chip:{purchase['id']}",
        }), 1)

    async def test_paid_without_provider_utr_credits_even_if_player_pasted_claim(self):
        purchase, _ = await operator_rail.create_hosted_deposit(
            self.user, 50_000, "paid-missing-utr-with-player-claim", self.gateway,
        )
        await self.db[operator_rail.COLLECTION].update_one(
            {"id": purchase["id"]},
            {"$set": {"utr_claim": "PLAYER-PASTED-UTR"}},
        )
        result = await operator_rail.settle_hosted_deposit(
            purchase["id"],
            DepositStatus("PAID", 50_000, "INR", None),
            actor="authenticated-status",
        )
        self.assertEqual(result["status"], "CREDITED")
        self.assertFalse(result.get("utr_mismatch"))
        stored = await self.db[operator_rail.COLLECTION].find_one({"id": purchase["id"]})
        seed = re.sub(
            r"[^A-Z0-9]", "",
            str(stored.get("provider_order_id") or stored["id"]).upper(),
        )
        self.assertEqual(stored["provider_reference"], f"SGPAY-{seed[:74]}")
        self.assertEqual(stored["utr_claim"], "PLAYER-PASTED-UTR")
        self.assertEqual((await self.db.users.find_one({"id": self.user["id"]}))["chip_balance"], 600)

    async def test_reconcile_missing_provider_order_id_looks_up_by_request_id(self):
        purchase, _ = await operator_rail.create_hosted_deposit(
            self.user, 50_000, "missing-provider-order", self.gateway,
        )
        await self.db[operator_rail.COLLECTION].update_one(
            {"id": purchase["id"]},
            {"$set": {"provider_order_id": None, "checkout_url": None}},
        )
        self.gateway.status = DepositStatus("PAID", 50_000, "INR", "661158806148")
        result = await operator_rail.reconcile_hosted_deposit(purchase["id"], self.gateway)
        self.assertEqual(result["status"], "CREDITED")
        self.assertEqual(self.gateway.status_calls[-1], (purchase["id"], 50_000))
        self.assertEqual(len(self.gateway.create_calls), 1)
        stored = await self.db[operator_rail.COLLECTION].find_one({"id": purchase["id"]})
        self.assertEqual(stored["provider_reference"], "661158806148")

    async def test_pending_and_unavailable_status_keep_claim_for_safe_retry(self):
        pending_purchase, _ = await operator_rail.create_hosted_deposit(
            self.user, 50_000, "utr-pending-status", self.gateway,
        )
        self.gateway.status = DepositStatus("PENDING", 50_000, "INR", None)
        pending = await operator_rail.submit_hosted_utr(
            pending_purchase["id"], self.user["id"], "PENDING-UTR-123", self.gateway,
        )
        self.assertEqual(pending["status"], "PENDING")
        stored = await self.db[operator_rail.COLLECTION].find_one({"id": pending_purchase["id"]})
        self.assertEqual(stored["utr_claim"], "PENDING-UTR-123")

        unavailable_purchase, _ = await operator_rail.create_hosted_deposit(
            self.user, 50_000, "utr-unavailable-status", self.gateway,
        )
        unavailable_lookup = AsyncMock(
            side_effect=ProviderRequestError("authenticated lookup unavailable"),
        )
        with patch.object(
            self.gateway, "get_payment_status", new=unavailable_lookup,
        ):
            with self.assertRaises(HTTPException) as unavailable:
                await operator_rail.submit_hosted_utr(
                    unavailable_purchase["id"], self.user["id"],
                    "RETRY-UTR-456", self.gateway,
                )
        self.assertEqual(unavailable.exception.status_code, 503)
        self.assertEqual(unavailable.exception.detail["code"], "UPI_STATUS_UNAVAILABLE")
        unavailable_lookup.assert_awaited_once_with(
            unavailable_purchase["provider_order_id"], expected_amount_paise=50_000,
        )
        stored = await self.db[operator_rail.COLLECTION].find_one({"id": unavailable_purchase["id"]})
        self.assertEqual(stored["utr_claim"], "RETRY-UTR-456")
        self.assertEqual(stored["last_error"], "ProviderRequestError")
        self.assertEqual((await self.db.users.find_one({"id": self.user["id"]}))["chip_balance"], 100)

    async def test_raw_utr_claim_never_leaks_from_player_or_admin_dtos(self):
        purchase, _ = await operator_rail.create_hosted_deposit(
            self.user, 50_000, "utr-dto-redaction", self.gateway,
        )
        self.gateway.status = DepositStatus("PENDING", 50_000, "INR", None)
        stored = await operator_rail.submit_hosted_utr(
            purchase["id"], self.user["id"], "SECRET-UTR-9988", self.gateway,
        )

        public_values = (
            operator_rail.request_dto(stored),
            operator_rail.as_player_deposit(stored),
            operator_rail.as_admin_deposit(stored),
        )
        for value in public_values:
            with self.subTest(dto=value):
                serialized = json.dumps(value, default=str).upper()
                self.assertNotIn("UTR_CLAIM", serialized)
                self.assertNotIn("SECRET-UTR-9988", serialized)
        self.assertTrue(public_values[0]["utr_submitted"])

    async def test_intake_off_still_reconciles_existing_open_purchase(self):
        purchase, _ = await operator_rail.create_hosted_deposit(
            self.user, 50_000, "intake-off-reconciliation", self.gateway,
        )
        await self.db[operator_rail.COLLECTION].update_one(
            {"id": purchase["id"]},
            {"$set": {
                "utr_claim": "INTAKE-OFF-UTR-1",
                "next_reconcile_at": operator_rail.utcnow(),
            }},
        )
        self.gateway.status = DepositStatus(
            "PAID", 50_000, "INR", "INTAKE-OFF-UTR-1",
        )
        with patch.dict(
            os.environ, {"UPI_CHIP_PURCHASES_ENABLED": "false"}, clear=False,
        ):
            self.assertTrue(await operator_rail.hosted_upi_reconciliation_needed())
            result = await operator_rail.reconcile_hosted_batch(self.gateway)

        self.assertEqual(result, {"checked": 1, "updated": 1, "errors": 0})
        stored = await self.db[operator_rail.COLLECTION].find_one({"id": purchase["id"]})
        self.assertEqual(stored["status"], "CREDITED")
        self.assertEqual((await self.db.users.find_one({"id": self.user["id"]}))["chip_balance"], 600)

    async def test_duplicate_provider_utr_is_quarantined_without_second_credit(self):
        first, _ = await operator_rail.create_hosted_deposit(
            self.user, 50_000, "buy-chips-first-duplicate-utr", self.gateway,
        )
        self.gateway.status = DepositStatus("PAID", 50_000, "INR", "DUPLICATE-UTR-77")
        first_result = await operator_rail.submit_hosted_utr(
            first["id"], self.user["id"], "duplicate-utr-77", self.gateway,
        )
        self.assertEqual(first_result["status"], "CREDITED")

        second, _ = await operator_rail.create_hosted_deposit(
            self.user, 50_000, "buy-chips-second-duplicate-utr", self.gateway,
        )
        second_result = await operator_rail.submit_hosted_utr(
            second["id"], self.user["id"], "DUPLICATE-UTR-77", self.gateway,
        )

        self.assertEqual(second_result["status"], "RECONCILIATION_REQUIRED")
        stored = await self.db[operator_rail.COLLECTION].find_one({"id": second["id"]})
        self.assertEqual(stored["last_error"], "DUPLICATE_UTR")
        self.assertIsNone(stored["provider_reference"])
        self.assertEqual((await self.db.users.find_one({"id": self.user["id"]}))["chip_balance"], 600)
        self.assertEqual(await self.db.chip_transactions.count_documents({
            "kind": operator_rail.ledger.DEPOSIT,
        }), 1)



    async def test_admin_review_paid_utr_credits_like_admin_approve(self):
        deposit = await operator_rail.create_request(
            self.user, kind="DEPOSIT", amount_paise=10_000,
        )
        self.assertEqual(deposit["source"], "ADMIN_REVIEW")
        self.assertTrue(operator_rail._is_uuid_id(deposit["id"]))
        self.gateway.status = DepositStatus("PAID", 10_000, "INR", "661158806148")

        with patch.dict(os.environ, {"UPI_CHIP_PURCHASES_ENABLED": "false"}, clear=False):
            self.assertTrue(await operator_rail.hosted_upi_reconciliation_needed())
            result = await operator_rail.reconcile_hosted_deposit(deposit["id"], self.gateway)

        self.assertEqual(result["status"], "APPROVED")
        self.assertFalse(result.get("duplicate"))
        self.assertEqual(self.gateway.status_calls[-1], (deposit["id"], 10_000))
        self.assertEqual(len(self.gateway.create_calls), 0)
        stored = await self.db[operator_rail.COLLECTION].find_one({"id": deposit["id"]})
        self.assertEqual(stored["status"], "APPROVED")
        self.assertEqual(stored["source"], "ADMIN_REVIEW")
        self.assertEqual(stored["provider_reference"], "661158806148")
        self.assertEqual((await self.db.users.find_one({"id": self.user["id"]}))["chip_balance"], 200)
        self.assertEqual(await self.db.chip_transactions.count_documents({
            "user_id": self.user["id"],
            "kind": operator_rail.ledger.DEPOSIT,
            "ref": f"operator-deposit:{deposit['id']}",
        }), 1)

    async def test_admin_review_paid_empty_utr_credits_like_admin_approve(self):
        deposit = await operator_rail.create_request(
            self.user, kind="DEPOSIT", amount_paise=10_000,
        )
        self.assertEqual(deposit["source"], "ADMIN_REVIEW")
        self.gateway.status = DepositStatus("PAID", 10_000, "INR", None)

        with patch.dict(os.environ, {"UPI_CHIP_PURCHASES_ENABLED": "false"}, clear=False):
            result = await operator_rail.reconcile_hosted_deposit(deposit["id"], self.gateway)

        self.assertEqual(result["status"], "APPROVED")
        self.assertFalse(result.get("duplicate"))
        stored = await self.db[operator_rail.COLLECTION].find_one({"id": deposit["id"]})
        seed = re.sub(r"[^A-Z0-9]", "", str(deposit["id"]).upper())
        self.assertEqual(stored["status"], "APPROVED")
        self.assertEqual(stored["provider_reference"], f"SGPAY-{seed[:74]}")
        self.assertFalse(stored.get("utr_claim"))
        self.assertEqual((await self.db.users.find_one({"id": self.user["id"]}))["chip_balance"], 200)
        self.assertEqual(await self.db.chip_transactions.count_documents({
            "user_id": self.user["id"],
            "kind": operator_rail.ledger.DEPOSIT,
            "ref": f"operator-deposit:{deposit['id']}",
        }), 1)

    async def test_admin_review_already_credited_does_not_double(self):
        deposit = await operator_rail.create_request(
            self.user, kind="DEPOSIT", amount_paise=10_000,
        )
        self.gateway.status = DepositStatus("PAID", 10_000, "INR", "661158806148")
        first = await operator_rail.reconcile_hosted_deposit(deposit["id"], self.gateway)
        self.assertEqual(first["status"], "APPROVED")

        second = await operator_rail.reconcile_hosted_deposit(deposit["id"], self.gateway)
        self.assertTrue(second.get("duplicate") or second.get("terminal"))
        self.assertEqual((await self.db.users.find_one({"id": self.user["id"]}))["chip_balance"], 200)
        self.assertEqual(await self.db.chip_transactions.count_documents({
            "ref": f"operator-deposit:{deposit['id']}",
        }), 1)

        other = await operator_rail.create_request(
            self.user, kind="DEPOSIT", amount_paise=10_000,
        )
        await self.db[operator_rail.COLLECTION].update_one(
            {"id": other["id"]},
            {"$set": {"status": "CREDITED", "provider_reference": "ALREADY-CREDITED-UTR"}},
        )
        credited = await operator_rail.reconcile_hosted_deposit(other["id"], self.gateway)
        self.assertEqual(credited["status"], "CREDITED")
        self.assertTrue(credited.get("duplicate") or credited.get("terminal"))
        self.assertEqual((await self.db.users.find_one({"id": self.user["id"]}))["chip_balance"], 200)
        self.assertEqual(await self.db.chip_transactions.count_documents({
            "kind": operator_rail.ledger.DEPOSIT,
        }), 1)

    async def test_admin_review_failed_does_not_credit(self):
        deposit = await operator_rail.create_request(
            self.user, kind="DEPOSIT", amount_paise=10_000,
        )
        self.gateway.status = DepositStatus(
            "FAILED", 10_000, "INR", f"sgpay24:{deposit['id']}:failed",
        )
        result = await operator_rail.reconcile_hosted_deposit(deposit["id"], self.gateway)
        self.assertEqual(result["status"], "FAILED")
        stored = await self.db[operator_rail.COLLECTION].find_one({"id": deposit["id"]})
        self.assertEqual(stored["status"], "PENDING")
        self.assertEqual((await self.db.users.find_one({"id": self.user["id"]}))["chip_balance"], 100)
        self.assertEqual(await self.db.chip_transactions.count_documents({}), 0)

    async def test_admin_review_batch_credits_paid_and_skips_withdrawals(self):
        deposit = await operator_rail.create_request(
            self.user, kind="DEPOSIT", amount_paise=10_000,
        )
        withdrawal_id = str(uuid.uuid4())
        await self.db[operator_rail.COLLECTION].insert_one({
            "id": withdrawal_id,
            "user_id": self.user["id"],
            "kind": "WITHDRAWAL",
            "status": "PENDING",
            "source": "ADMIN_REVIEW",
            "amount_paise": 100_000,
            "chips": 1_000,
            "created_at": operator_rail.utcnow(),
        })
        self.gateway.status = DepositStatus("PAID", 10_000, "INR", "661158806148")
        with patch.dict(os.environ, {"UPI_CHIP_PURCHASES_ENABLED": "false"}, clear=False):
            result = await operator_rail.reconcile_hosted_batch(self.gateway)

        self.assertEqual(result["checked"], 1)
        self.assertEqual(result["updated"], 1)
        stored = await self.db[operator_rail.COLLECTION].find_one({"id": deposit["id"]})
        self.assertEqual(stored["status"], "APPROVED")
        withdrawn = await self.db[operator_rail.COLLECTION].find_one({"id": withdrawal_id})
        self.assertEqual(withdrawn["status"], "PENDING")
        self.assertEqual((await self.db.users.find_one({"id": self.user["id"]}))["chip_balance"], 200)

    def test_webhook_accepts_string_complete_as_paid_notice(self):

        gateway = provider()
        raw = json.dumps({
            "order_id": "order-12345678",
            "amount": 500,
            "status": "Complete",
            "transaction_id": 918273,
            "utr": "CALLBACK-CLAIMED-UTR",
        }).encode()
        event = gateway.verify_webhook(raw, {})
        self.assertEqual(event.object_id, "order-12345678")
        self.assertEqual(event.event_type, "deposit.paid")
        self.assertTrue(event.data["requires_authenticated_status_lookup"])
        self.assertEqual(event.data["notice_kind"], "collection")


class SgPay24PayoutContractTests(unittest.IsolatedAsyncioTestCase):
    def _payout_kwargs(self, **overrides):
        payload = {
            "withdrawal_id": "wd-12345678",
            "provider_beneficiary_id": "bank-1",
            "amount_paise": 100_000,
            "currency": "INR",
            "idempotency_key": "op-wd-wd-12345678",
            "account_holder_name": "Test Player",
            "account_number": "12345678901",
            "ifsc_code": "HDFC0000001",
            "bank_name": "HDFC Bank",
            "payout_identifier": "",
            "phone": "+919876543210",
            "email": "player@example.com",
        }
        payload.update(overrides)
        return payload

    async def test_create_payout_sends_merchant_docs_field_names(self):
        gateway = provider()
        request_json = AsyncMock(return_value={
            "status": 0,
            "data": {"payout_id": "po-1", "order_id": "wd-12345678", "status": 0},
        })
        with patch.object(gateway, "_request_json", new=request_json):
            result = await gateway.submit_payout(**self._payout_kwargs())

        self.assertEqual(result, PayoutSubmission("po-1", "PROCESSING"))
        path, payload = request_json.await_args.args
        self.assertEqual(path, "/api/createPayoutRequest")
        self.assertEqual(request_json.await_args.kwargs.get("as_query"), True)
        self.assertEqual(payload["mid"], PROVIDER_ENV["SGPAY24_MERCHANT_ID"])
        self.assertEqual(payload["merchant_id"], PROVIDER_ENV["SGPAY24_MERCHANT_ID"])
        self.assertEqual(payload["api_token"], PROVIDER_ENV["SGPAY24_API_TOKEN"])
        self.assertEqual(payload["order_id"], "wd-12345678")
        self.assertEqual(payload["amount"], 1000)
        self.assertEqual(payload["account"], "12345678901")
        self.assertEqual(payload["ifsc_no"], "HDFC0000001")
        self.assertEqual(payload["bank_name"], "HDFC Bank")
        self.assertEqual(payload["benifeciryname"], "Test Player")
        self.assertEqual(payload["email"], "player@example.com")
        self.assertEqual(payload["phone"], "9876543210")
        self.assertEqual(payload["redirect_url"], PROVIDER_ENV["PAYMENT_RETURN_URL"])
        self.assertEqual(payload["remark"], "Chakri payout wd-12345678")
        for legacy in (
            "account_number", "ifsc", "ifsc_code", "name", "beneficiary_name",
            "callback_url", "notify_url",
        ):
            self.assertNotIn(legacy, payload)

    async def test_create_payout_requires_bank_name_when_account_present(self):
        gateway = provider()
        with patch.object(gateway, "_request_json", new=AsyncMock()) as request_json:
            with self.assertRaises(ProviderRequestError) as caught:
                await gateway.submit_payout(**self._payout_kwargs(bank_name=""))
        self.assertIn("bank name", str(caught.exception).lower())
        request_json.assert_not_awaited()

    async def test_create_payout_maps_numeric_status_codes(self):
        cases = (
            (0, "PROCESSING"),
            (1, "PAID"),
            (2, "FAILED"),
            ("0", "PROCESSING"),
            ("1", "PAID"),
            ("2", "FAILED"),
            ("Complete", "PAID"),
            ("Rejected", "FAILED"),
        )
        for raw, expected in cases:
            with self.subTest(raw=raw, expected=expected):
                gateway = provider()
                request_json = AsyncMock(return_value={
                    "data": {"payout_id": "po-status", "order_id": "wd-12345678", "status": raw},
                })
                with patch.object(gateway, "_request_json", new=request_json):
                    result = await gateway.submit_payout(**self._payout_kwargs())
                self.assertEqual(result.status, expected)

    async def test_create_payout_uses_dedicated_redirect_when_configured(self):
        dedicated = "https://play.example.com/chips/withdraw"
        gateway = provider({"SGPAY24_PAYOUT_REDIRECT_URL": dedicated})
        request_json = AsyncMock(return_value={
            "data": {"payout_id": "po-1", "order_id": "wd-12345678", "status": 0},
        })
        with patch.object(gateway, "_request_json", new=request_json):
            await gateway.submit_payout(**self._payout_kwargs())
        self.assertEqual(request_json.await_args.args[1]["redirect_url"], dedicated)

    def test_invalid_payout_redirect_url_fails_closed(self):
        with self.assertRaises(ProviderConfigurationError) as caught:
            provider({"SGPAY24_PAYOUT_REDIRECT_URL": "http://chakri.casino/chips/withdraw"})
        self.assertIn("SGPAY24_PAYOUT_REDIRECT_URL", str(caught.exception))

    async def test_create_payout_rejects_unapproved_redirect(self):
        gateway = provider()
        with patch.object(gateway, "_request_json", new=AsyncMock()) as request_json:
            with self.assertRaises(ProviderRequestError) as caught:
                await gateway.submit_payout(
                    **self._payout_kwargs(return_url="https://evil.example/steal"),
                )
        self.assertIn("return", str(caught.exception).lower())
        request_json.assert_not_awaited()

    async def test_get_payout_status_keeps_merchant_id_and_maps_codes(self):
        gateway = provider()
        request_json = AsyncMock(return_value={
            "order_id": "wd-12345678",
            "merchant_id": PROVIDER_ENV["SGPAY24_MERCHANT_ID"],
            "amount": 1000,
            "status": 1,
            "utr": "HDFCR12345",
        })
        with patch.object(gateway, "_request_json", new=request_json):
            actual = await gateway.get_payout_status("wd-12345678")
        self.assertEqual(actual.status, "PAID")
        self.assertEqual(actual.amount_paise, 100_000)
        self.assertEqual(actual.provider_reference, "HDFCR12345")
        path, payload = request_json.await_args.args
        self.assertEqual(path, "/api/check-payout-status")
        self.assertEqual(payload, {
            "merchant_id": PROVIDER_ENV["SGPAY24_MERCHANT_ID"],
            "order_id": "wd-12345678",
            "api_token": PROVIDER_ENV["SGPAY24_API_TOKEN"],
        })
        self.assertNotIn("mid", payload)

    def test_webhook_accepts_docs_payout_payload(self):
        gateway = provider()
        raw = json.dumps({
            "merchant_id": PROVIDER_ENV["SGPAY24_MERCHANT_ID"],
            "payout_id": "payout-12345678",
            "order_id": "wd-12345678",
            "amount": 1000,
            "status": 1,
            "utr": "HDFCR12345",
        }).encode()
        event = gateway.verify_webhook(raw, {})
        self.assertEqual(event.object_id, "wd-12345678")
        self.assertEqual(event.event_type, "payout.paid")
        self.assertEqual(event.amount_paise, 100_000)
        self.assertEqual(event.provider_reference, "HDFCR12345")
        self.assertEqual(event.data["notice_kind"], "payout")
        self.assertTrue(event.data["requires_authenticated_status_lookup"])

    def test_webhook_payout_status_two_is_rejected(self):
        gateway = provider()
        raw = json.dumps({
            "merchant_id": PROVIDER_ENV["SGPAY24_MERCHANT_ID"],
            "payout_id": "payout-12345678",
            "order_id": "wd-12345678",
            "amount": 1000,
            "status": 2,
            "utr": "REJECTEDUTR1",
        }).encode()
        event = gateway.verify_webhook(raw, {})
        self.assertEqual(event.event_type, "payout.failed")
        self.assertEqual(event.data["notice_kind"], "payout")


class SgPayPayoutToastTests(unittest.IsolatedAsyncioTestCase):
    async def test_payout_502_message_includes_provider_error(self):
        import sgpay_payout
        request = {
            "id": "wd-toast-1", "user_id": "player-1", "chips": 1000,
            "payout_status": "FAILED",
        }
        fake = AsyncMongoMockClient()["payout_toast"]
        await fake.operator_payment_requests.insert_one(request)
        await fake.users.insert_one({
            "id": "player-1", "phone": "9876543210", "email": "player@example.com",
        })

        class FakeProvider:
            async def submit_payout(self, **kwargs):
                raise ProviderRequestError("SgPay payout failed (500): Internal server error")

        with (
            patch.object(sgpay_payout, "db", fake),
            patch.object(sgpay_payout, "load_payout_method", new=AsyncMock(return_value={"id": "m1"})),
            patch.object(sgpay_payout, "_decrypt_method", new=AsyncMock(return_value={
                "account_holder_name": "Player",
                "account_number": "1234567890",
                "ifsc_code": "HDFC0001234",
                "payout_identifier": "",
                "bank_name": "HDFC",
            })),
            patch("payment_providers.load_payment_provider", return_value=FakeProvider()),
        ):
            with self.assertRaises(HTTPException) as caught:
                await sgpay_payout.send_operator_payout(request, actor="admin", retry=True)
        self.assertEqual(caught.exception.status_code, 502)
        detail = caught.exception.detail
        self.assertEqual(detail["code"], "SGPAY_PAYOUT_FAILED")
        self.assertEqual(
            detail["message"],
            "SgPay did not accept the payout: SgPay payout failed (500): Internal server error. Funds remain reserved; retry from Admin.",
        )
        self.assertIn("Internal server error", detail["error"])
        stored = await fake.operator_payment_requests.find_one({"id": "wd-toast-1"})
        self.assertIn("Internal server error", stored["payout_error"])
        self.assertNotIn("SGPAY24_API_TOKEN", json.dumps(detail))
        self.assertNotIn("api_token", json.dumps(detail).lower())


if __name__ == "__main__":
    unittest.main()
