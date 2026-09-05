"""Focused financial-core safety and idempotency tests (no network or real money)."""
from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import os
import sys
import time
import types
import unittest
from dataclasses import replace
from datetime import timedelta
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from mongomock_motor import AsyncMongoMockClient


HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

TEST_PROVIDER_CONFIG = {
    "provider_name": "contract_bridge",
    "base_url": "https://payments.example.test",
    "capabilities": {
        "deposit_idempotency": True,
        "payment_status_lookup": True,
        "payout_idempotency": True,
        "payout_status_lookup": True,
        "payout_cancellation": True,
        "refunds": True,
    },
    "endpoints": {
        name: {"method": "POST", "path": f"/v1/{name}"}
        for name in (
            "create_deposit_order", "create_checkout_session", "get_payment_status",
            "create_beneficiary", "submit_payout", "get_payout_status",
            "cancel_payout", "refund_payment",
        )
    },
    "request_mapping": {
        "create_deposit_order": {"deposit_id": "merchant_deposit_id", "amount_paise": "amount_minor", "currency": "currency", "return_url": "return_url"},
        "create_checkout_session": {"provider_order_id": "order_id", "return_url": "return_url"},
        "get_payment_status": {"provider_order_id": "order_id"},
        "create_beneficiary": {"bank_details": "beneficiary"},
        "submit_payout": {"withdrawal_id": "withdrawal_id", "provider_beneficiary_id": "beneficiary_id", "amount_paise": "amount_minor", "currency": "currency"},
        "get_payout_status": {"provider_payout_id": "payout_id"},
        "cancel_payout": {"provider_payout_id": "payout_id"},
        "refund_payment": {"provider_order_id": "order_id", "amount_paise": "amount_minor"},
    },
    "response_mapping": {
        "create_deposit_order": {"provider_order_id": "id", "checkout_url": "checkout_url", "status": "status"},
        "create_checkout_session": {"provider_order_id": "id", "checkout_url": "checkout_url", "status": "status"},
        "get_payment_status": {"status": "status", "amount_paise": "amount_minor", "currency": "currency", "provider_reference": "reference"},
        "create_beneficiary": {"provider_beneficiary_id": "id", "status": "status"},
        "submit_payout": {"provider_payout_id": "id", "status": "status"},
        "get_payout_status": {"status": "status", "amount_paise": "amount_minor", "currency": "currency", "withdrawal_id": "withdrawal_id", "idempotency_key": "idempotency_key", "provider_beneficiary_id": "beneficiary_id", "provider_reference": "reference"},
        "cancel_payout": {"status": "status"},
        "refund_payment": {"provider_reference": "reference"},
    },
    "status_mapping": {
        "deposit": {"PENDING": "PENDING", "PAID": "PAID", "REFUNDED": "REFUNDED", "FAILED": "FAILED"},
        "payout": {"CREATED": "CREATED", "PROCESSING": "PROCESSING", "PAID": "PAID", "FAILED": "FAILED", "CANCELLED": "CANCELLED"},
    },
    "auth": {"strategy": "bearer", "credential_env": "PAYMENT_PROVIDER_API_TOKEN"},
    "webhook": {
        "algorithm": "hmac-sha256", "timestamp_header": "X-Provider-Timestamp",
        "signature_header": "X-Provider-Signature", "secret_env": "PAYMENT_PROVIDER_WEBHOOK_SECRET",
        "replay_window_seconds": 300,
        "mapping": {"event_id": "id", "event_type": "type", "object_id": "object_id", "amount_paise": "amount_minor", "currency": "currency", "provider_reference": "reference", "occurred_at": "occurred_at"},
        "event_type_mapping": {"deposit.paid": "deposit.paid", "deposit.failed": "deposit.failed", "deposit.refunded": "deposit.refunded", "withdrawal.processing": "withdrawal.processing", "withdrawal.paid": "withdrawal.paid", "withdrawal.failed": "withdrawal.failed"},
    },
    "idempotency_header": "Idempotency-Key",
}

TEST_PROVIDER_ENV = {
    "PAYMENT_PROVIDER": "contract_bridge",
    "PAYMENT_PROVIDER_CONFIG_JSON": json.dumps(TEST_PROVIDER_CONFIG),
    "PAYMENT_PROVIDER_ALLOWED_DOMAINS": "payments.example.test",
    "PAYMENT_PROVIDER_CHECKOUT_ALLOWED_DOMAINS": "checkout.example.test",
    "PAYMENT_PROVIDER_API_TOKEN": "test-only-provider-token",
    "PAYMENT_PROVIDER_WEBHOOK_SECRET": "test-only-webhook-secret-at-least-32-characters",
}


os.environ.update({
    "APP_ENV": "test",
    "REAL_MONEY_ENABLED": "true",
    "DEPOSITS_ENABLED": "true",
    "WITHDRAWALS_ENABLED": "true",
    "AUTO_WITHDRAWALS_ENABLED": "true",
    "FINANCIAL_GAME_WALLET_INTEGRATED": "true",
    "FINANCIAL_ALLOW_NON_TRANSACTIONAL_TESTS": "true",
    "FINANCIAL_ALLOWED_COUNTRIES": "IN",
    **TEST_PROVIDER_ENV,
    "PAYOUT_DATA_ACTIVE_KEY_VERSION": "v1",
    "PAYOUT_DATA_KEY_V1": base64.urlsafe_b64encode(b"a" * 32).decode("ascii"),
    "PAYOUT_DATA_FINGERPRINT_KEY": base64.urlsafe_b64encode(b"b" * 32).decode("ascii"),
    "CHIPS_PER_INR": "1",
    "CHIP_RATE_VERSION": "test-v1",
    "MIN_DEPOSIT_PAISE": "10000",
    "MAX_DEPOSIT_PAISE": "1000000",
    "MIN_WITHDRAWAL_PAISE": "100000",
    "MIN_WITHDRAWAL_CHIPS": "10",
    "MAX_WITHDRAWAL_CHIPS": "1000000",
})

client = AsyncMongoMockClient()
db = client["financial_core_test"]
sys.modules["db"] = types.SimpleNamespace(db=db, client=client)

import financial_wallet as finance  # noqa: E402
import routes_payments as routes  # noqa: E402
from payment_providers import (  # noqa: E402
    _PinnedHTTPSConnection as ProviderPinnedHTTPSConnection,
    Beneficiary,
    DepositSession,
    DepositStatus,
    PayoutSubmission,
    PayoutStatus,
    ProviderCapabilities,
    ProviderConfigurationError,
    ProviderEvent,
    ProviderRequestError,
    WebhookVerificationError,
    load_payment_provider,
)


class DeterministicTestProvider:
    """In-memory protocol fake available only in this test module."""

    name = "deterministic_test_provider"
    capabilities = ProviderCapabilities(True, True, True, True, True, True)

    def __init__(self):
        self._secret = b"test-only-financial-webhook-secret-32-chars"
        self._deposit_orders = {}
        self._payouts = {}

    @staticmethod
    def _stable(prefix, value):
        return f"{prefix}_{hashlib.sha256(value.encode()).hexdigest()[:24]}"

    async def create_deposit_order(self, *, deposit_id, amount_paise, currency, idempotency_key, return_url):
        provider_id = self._stable("test_order", idempotency_key)
        self._deposit_orders[provider_id] = (int(amount_paise), str(currency))
        return DepositSession(provider_id, f"https://test-provider.example.invalid/checkout/{provider_id}")

    async def create_checkout_session(self, *, provider_order_id, return_url):
        return DepositSession(provider_order_id, f"https://test-provider.example.invalid/checkout/{provider_order_id}")

    async def get_payment_status(self, provider_order_id):
        details = self._deposit_orders.get(provider_order_id)
        return DepositStatus(
            "PENDING", details[0] if details else None, details[1] if details else None,
            self._stable("test_payment", provider_order_id) if details else None,
        )

    async def create_beneficiary(self, *, bank_details, idempotency_key):
        return Beneficiary(self._stable("test_beneficiary", idempotency_key))

    async def submit_payout(self, *, withdrawal_id, provider_beneficiary_id, amount_paise, currency, idempotency_key):
        provider_id = self._stable("test_payout", idempotency_key)
        self._payouts[provider_id] = {
            "amount_paise": int(amount_paise), "currency": str(currency),
            "withdrawal_id": str(withdrawal_id), "idempotency_key": str(idempotency_key),
            "provider_beneficiary_id": str(provider_beneficiary_id),
        }
        return PayoutSubmission(provider_id, "PROCESSING")

    async def get_payout_status(self, provider_payout_id):
        details = self._payouts.get(provider_payout_id) or {}
        return PayoutStatus(
            "PROCESSING", details.get("amount_paise"), details.get("currency"),
            details.get("withdrawal_id"), details.get("idempotency_key"),
            details.get("provider_beneficiary_id"), provider_payout_id if details else None,
        )

    async def cancel_payout(self, provider_payout_id):
        return "CANCELLED"

    async def refund_payment(self, provider_order_id, amount_paise):
        return self._stable("test_refund", f"{provider_order_id}:{amount_paise}")

    def sign_webhook(self, raw_body, timestamp=None):
        stamp = int(time.time() if timestamp is None else timestamp)
        digest = hmac.new(self._secret, f"{stamp}.".encode() + raw_body, hashlib.sha256).hexdigest()
        return {"X-Chakri-Timestamp": str(stamp), "X-Chakri-Signature": f"sha256={digest}"}

    def verify_webhook(self, raw_body, headers):
        lowered = {str(key).lower(): str(value) for key, value in headers.items()}
        try:
            stamp = int(lowered.get("x-chakri-timestamp", ""))
        except ValueError as exc:
            raise WebhookVerificationError("Webhook timestamp is invalid") from exc
        if abs(int(time.time()) - stamp) > 300:
            raise WebhookVerificationError("Webhook timestamp is outside the replay window")
        supplied = lowered.get("x-chakri-signature", "").removeprefix("sha256=")
        expected = hmac.new(self._secret, f"{stamp}.".encode() + raw_body, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(supplied, expected):
            raise WebhookVerificationError("Webhook signature is invalid")
        payload = json.loads(raw_body)
        return ProviderEvent(
            payload["id"], payload["type"], payload["object_id"], payload.get("amount_paise"),
            payload.get("currency"), payload.get("provider_reference"), payload.get("occurred_at"), {},
        )


class ControllableProvider(DeterministicTestProvider):
    def __init__(self):
        super().__init__()
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


def strict_withdrawal_hold(
    *, suffix: str, category: str = "AML",
    reason_code: str = "AML_SOURCE_OF_FUNDS_REVIEW",
    source_type: str = "AML_REVIEW",
) -> dict:
    return {
        "id": f"withdrawal-hold:test-{suffix}",
        "category": category,
        "reason_code": reason_code,
        "review_status": "UNDER_REVIEW",
        "recorded_at": finance.now(),
        "recorded_by": "compliance-admin",
        "support_path": "/support",
        "source": {
            "type": source_type,
            "id": f"compliance-case:{suffix}",
        },
    }


class FinancialCoreTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        os.environ.update(TEST_PROVIDER_ENV)
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

    async def test_withdrawal_gate_uses_only_documented_kyc_aml_fraud_sanctions_or_legal_holds(self):
        # Product/account eligibility can stop deposits and play, but cannot be
        # repurposed into a hold on otherwise-cleared cash.
        for label, changes in (
            ("inactive", {"status": "SELF_EXCLUDED"}),
            ("contact", {"contact_verified": False, "email_verified": False}),
            ("age", {"age_verified": False}),
            ("country", {"country": "ZZ"}),
            ("generic-review", {"financial_status": "REVIEW_REQUIRED"}),
        ):
            with self.subTest(non_hold_condition=label):
                candidate = {**self.user, **changes}
                allowed = await routes._require_player("withdrawals", candidate)
                self.assertEqual(allowed["id"], self.user["id"])

        no_kyc = {**self.user, "kyc_status": "UNVERIFIED"}
        with self.assertRaises(HTTPException) as kyc_block:
            await routes._require_player("withdrawals", no_kyc)
        self.assertEqual(kyc_block.exception.detail["code"], "KYC_WITHDRAWAL_HOLD")
        self.assertEqual(kyc_block.exception.detail["hold_category"], "KYC")
        self.assertEqual(kyc_block.exception.detail["hold_reason_code"], "KYC_NOT_VERIFIED")
        self.assertEqual(kyc_block.exception.detail["support_path"], "/support")

        for category in ("KYC", "AML", "FRAUD", "SANCTIONS", "LEGAL"):
            with self.subTest(documented_hold_category=category):
                candidate = {
                    **self.user,
                    "withdrawal_hold": {
                        "id": f"withdrawal-hold:test-{category.lower()}",
                        "category": category,
                        "reason_code": f"{category}_CASE_REVIEW",
                        "review_status": "UNDER_REVIEW",
                        "recorded_at": finance.now(),
                        "recorded_by": "compliance-admin",
                        "support_path": "/support",
                        "source": {
                            "type": "ADMIN_COMPLIANCE_CASE",
                            "id": f"compliance-case:{category.lower()}-001",
                        },
                    },
                }
                with self.assertRaises(HTTPException) as held:
                    await routes._require_player("withdrawals", candidate)
                expected_code = (
                    "KYC_WITHDRAWAL_HOLD" if category == "KYC"
                    else "LEGAL_OR_COMPLIANCE_WITHDRAWAL_HOLD"
                )
                self.assertEqual(held.exception.detail["code"], expected_code)
                self.assertEqual(held.exception.detail["hold_category"], category)
                self.assertEqual(
                    held.exception.detail["hold_reason_code"],
                    f"{category}_CASE_REVIEW",
                )

        # Missing evidence is an operator reconciliation issue, not permission
        # to invent a generic FINANCIAL_REVIEW hold against the player.
        malformed = {
            **self.user,
            "financial_status": "FROZEN",
            "withdrawal_hold": {
                "category": "UNSUPPORTED",
                "reason_code": "GENERIC_REVIEW",
                "review_status": "UNDER_REVIEW",
            },
        }
        self.assertEqual(
            (await routes._require_player("withdrawals", malformed))["id"],
            self.user["id"],
        )

    async def test_wallet_withdrawal_eligibility_uses_the_same_documented_hold_projection(self):
        await seed_cash("player-1", 100)
        generic_review = {**self.user, "financial_status": "REVIEW_REQUIRED"}
        available = await routes.payment_wallet(user=generic_review)
        self.assertEqual(available["wallet"]["withdrawable_chips"], 100)
        self.assertTrue(available["wallet"]["withdrawal_eligibility"]["eligible"])
        self.assertEqual(available["wallet"]["withdrawal_eligibility"]["reason_codes"], [])

        documented = {
            **self.user,
            "withdrawal_hold": {
                "id": "withdrawal-hold:test-aml-wallet",
                "category": "AML",
                "reason_code": "AML_SOURCE_OF_FUNDS_REVIEW",
                "review_status": "ACTIVE",
                "recorded_at": finance.now(),
                "recorded_by": "aml-admin",
                "support_path": "/support",
                "source": {
                    "type": "AML_REVIEW",
                    "id": "aml-review:wallet-001",
                },
            },
        }
        blocked = await routes.payment_wallet(user=documented)
        eligibility = blocked["wallet"]["withdrawal_eligibility"]
        self.assertFalse(eligibility["eligible"])
        self.assertEqual(eligibility["reason_codes"], ["AML_SOURCE_OF_FUNDS_REVIEW"])
        self.assertEqual(eligibility["hold"]["category"], "AML")
        self.assertEqual(eligibility["support_path"], "/support")
        self.assertEqual(blocked["wallet"]["restricted_bonus_chips"], 1000)

    async def test_provider_terminal_identity_conflict_blocks_then_audited_clearance_restores_withdrawal(self):
        await seed_cash("player-1", 2_000)
        method = await finance.create_payout_method(
            "player-1", account_holder_name="Test Player", bank_name="Test Bank",
            account_number="123456789012", ifsc_code="ABCD0123456",
        )
        withdrawal = await finance.create_withdrawal(
            "player-1", 1_000, method["id"],
            "withdraw-before-provider-identity-conflict", self.provider,
        )
        order, _ = await finance.create_deposit(
            "player-1", 10_000, "deposit-terminal-identity-conflict", self.provider,
        )
        paid, raw = signed_event(self.provider, {
            "id": "evt-terminal-identity-original", "type": "deposit.paid",
            "object_id": order["provider_order_id"], "amount_paise": 10_000,
            "currency": "INR", "provider_reference": "payment-identity-original",
        })
        await finance.process_provider_event(self.provider, paid, raw)
        wallet_before_conflict = await finance.wallet_public("player-1")
        operations_before_conflict = await db.wallet_operations.count_documents({})
        conflict, conflict_raw = signed_event(self.provider, {
            "id": "evt-terminal-identity-conflict", "type": "deposit.paid",
            "object_id": order["provider_order_id"], "amount_paise": 10_000,
            "currency": "INR", "provider_reference": "payment-identity-conflicting",
        })
        with self.assertRaises(finance.FinancialError) as identity_conflict:
            await finance.process_provider_event(self.provider, conflict, conflict_raw)
        self.assertEqual(identity_conflict.exception.code, "DEPOSIT_TERMINAL_CONFLICT")

        user = await db.users.find_one({"id": "player-1"}, {"_id": 0})
        hold, reconciliation = finance.documented_withdrawal_hold_projection(user)
        self.assertIsNone(reconciliation)
        self.assertEqual(hold["reason_code"], "DEPOSIT_TERMINAL_CONFLICT")
        self.assertEqual(hold["source"]["type"], "PROVIDER_TERMINAL_CONFLICT")
        stored_withdrawal = await db.withdrawal_requests.find_one(
            {"id": withdrawal["id"]}, {"_id": 0},
        )
        self.assertEqual(stored_withdrawal["status"], "PAUSED_FOR_HOLD")
        wallet_during_hold = await finance.wallet_public("player-1")
        self.assertEqual(wallet_during_hold["held_chips"], 1_000)
        self.assertEqual(wallet_during_hold, wallet_before_conflict)
        self.assertEqual(
            await db.wallet_operations.count_documents({}),
            operations_before_conflict,
        )
        with self.assertRaises(HTTPException) as route_blocked:
            await routes._require_player("withdrawals", user)
        self.assertEqual(
            route_blocked.exception.detail["code"],
            "LEGAL_OR_COMPLIANCE_WITHDRAWAL_HOLD",
        )
        with self.assertRaises(finance.FinancialError) as approval_blocked:
            await finance.approve_withdrawal(withdrawal["id"], "payments-admin")
        self.assertEqual(
            approval_blocked.exception.code,
            "LEGAL_OR_COMPLIANCE_WITHDRAWAL_HOLD",
        )

        cleared = await finance.clear_documented_withdrawal_hold(
            "player-1", hold_id=hold["id"], actor="compliance-admin",
            reason="Provider evidence was independently reconciled and cleared",
        )
        self.assertEqual(cleared["resumed_withdrawal_ids"], [withdrawal["id"]])
        resumed = await db.withdrawal_requests.find_one(
            {"id": withdrawal["id"]}, {"_id": 0},
        )
        self.assertEqual(resumed["status"], "PENDING_ADMIN")
        allowed_user = await db.users.find_one({"id": "player-1"}, {"_id": 0})
        self.assertEqual(
            (await routes._require_player("withdrawals", allowed_user))["id"],
            "player-1",
        )
        approved = await finance.approve_withdrawal(withdrawal["id"], "payments-admin")
        self.assertEqual(approved["status"], "APPROVED")

        # Simulate a hold committing after approval but before the operator
        # crosses the provider boundary. The submission seam must revalidate.
        submit_race_hold = strict_withdrawal_hold(
            suffix="manual-submit-race", category="LEGAL",
            reason_code="LEGAL_PAYOUT_REVIEW", source_type="LEGAL_ORDER",
        )
        await db.users.update_one(
            {"id": "player-1"}, {"$set": {"withdrawal_hold": submit_race_hold}},
        )
        with self.assertRaises(finance.FinancialError) as submit_blocked:
            await finance.mark_withdrawal_submitted(
                withdrawal["id"], "payments-admin", "must-not-cross-provider-boundary",
            )
        self.assertEqual(
            submit_blocked.exception.code,
            "LEGAL_OR_COMPLIANCE_WITHDRAWAL_HOLD",
        )
        unchanged = await db.withdrawal_requests.find_one(
            {"id": withdrawal["id"]}, {"_id": 0},
        )
        self.assertEqual(unchanged["status"], "APPROVED")
        self.assertIsNone(unchanged.get("provider_payout_id"))
        self.assertEqual(await db.financial_audit.count_documents({
            "action": "WITHDRAWAL_HOLD_SET",
        }), 1)
        self.assertEqual(await db.financial_audit.count_documents({
            "action": "WITHDRAWAL_HOLD_CLEARED",
        }), 1)

    async def test_generic_deposit_limit_review_never_creates_withdrawal_hold(self):
        order, _ = await finance.create_deposit(
            "player-1", 10_000, "deposit-before-late-limit-review", self.provider,
        )
        await db.player_limits.insert_one({
            "user_id": "player-1", "kind": "DEPOSIT", "period": "DAY", "amount": 50,
        })
        await db.deposit_orders.update_one(
            {"id": order["id"]}, {"$set": {"limit_reservation_status": "RELEASED"}},
        )
        paid, raw = signed_event(self.provider, {
            "id": "evt-generic-limit-review", "type": "deposit.paid",
            "object_id": order["provider_order_id"], "amount_paise": 10_000,
            "currency": "INR", "provider_reference": "generic-limit-payment",
        })
        await finance.process_provider_event(self.provider, paid, raw)
        user = await db.users.find_one({"id": "player-1"}, {"_id": 0})
        self.assertEqual(user["financial_status"], "REVIEW_REQUIRED")
        self.assertNotIn("withdrawal_hold", user)
        self.assertIsNone(finance.documented_withdrawal_hold_projection(user)[0])
        self.assertEqual(
            (await routes._require_player("withdrawals", user))["id"], "player-1",
        )

    async def test_hold_set_and_clear_preserve_unrelated_financial_status(self):
        await db.users.update_one(
            {"id": "player-1"}, {"$set": {"financial_status": "FROZEN"}},
        )
        result = await finance.set_documented_withdrawal_hold(
            "player-1", category="AML", reason_code="AML_SOURCE_OF_FUNDS_REVIEW",
            review_status="UNDER_REVIEW", support_path="/support",
            source_type="AML_REVIEW", source_id="aml-case:status-preservation",
            actor="compliance-admin", reason="Review requested by the AML case owner",
        )
        self.assertEqual(
            (await db.users.find_one({"id": "player-1"}))["financial_status"],
            "FROZEN",
        )
        await finance.clear_documented_withdrawal_hold(
            "player-1", hold_id=result["hold"]["id"], actor="compliance-admin",
            reason="AML case was independently resolved",
        )
        self.assertEqual(
            (await db.users.find_one({"id": "player-1"}))["financial_status"],
            "FROZEN",
        )

    async def test_withdrawal_authorization_and_eligibility_writers_share_one_lock(self):
        await finance.assert_withdrawal_not_held("player-1")
        first = await db.financial_player_locks.find_one({
            "_id": "withdrawal-eligibility:player-1",
        })
        self.assertEqual(first["serial"], 1)

        await finance.review_player_kyc(
            "player-1", "REJECTED", "kyc-admin",
            "Identity evidence requires a fresh review",
        )
        hold = await finance.set_documented_withdrawal_hold(
            "player-1", category="AML", reason_code="AML_SOURCE_OF_FUNDS_REVIEW",
            review_status="UNDER_REVIEW", support_path="/support",
            source_type="AML_REVIEW", source_id="aml-case:shared-lock",
            actor="compliance-admin", reason="AML evidence requires review",
        )
        await finance.clear_documented_withdrawal_hold(
            "player-1", hold_id=hold["hold"]["id"], actor="compliance-admin",
            reason="AML evidence was independently cleared",
        )
        final = await db.financial_player_locks.find_one({
            "_id": "withdrawal-eligibility:player-1",
        })
        self.assertEqual(final["serial"], 4)

    async def test_withdrawal_holds_require_audited_clearance_not_silent_expiry(self):
        with self.assertRaises(finance.FinancialError) as expiry:
            await finance.set_documented_withdrawal_hold(
                "player-1", category="LEGAL", reason_code="LEGAL_ORDER_REVIEW",
                review_status="UNDER_REVIEW", support_path="/support",
                source_type="LEGAL_ORDER", source_id="legal-order:expiry-rejected",
                actor="compliance-admin", reason="A legal order requires review",
                expires_at=finance.now() + timedelta(hours=1),
            )
        self.assertEqual(expiry.exception.code, "INVALID_WITHDRAWAL_HOLD")
        user = await db.users.find_one({"id": "player-1"}, {"_id": 0})
        self.assertNotIn("withdrawal_hold", user)
        self.assertEqual(await db.withdrawal_holds.count_documents({}), 0)

    async def test_unverified_kyc_does_not_hide_persisted_hold_from_admin_clearance(self):
        await db.users.update_one(
            {"id": "player-1"}, {"$set": {"kyc_status": "UNVERIFIED"}},
        )
        result = await finance.set_documented_withdrawal_hold(
            "player-1", category="LEGAL", reason_code="LEGAL_ORDER_REVIEW",
            review_status="UNDER_REVIEW", support_path="/support",
            source_type="LEGAL_ORDER", source_id="legal-order:unverified-kyc",
            actor="compliance-admin", reason="Court-order evidence requires review",
        )
        summary = await finance.get_documented_withdrawal_hold("player-1")
        self.assertEqual(summary["active_hold"]["id"], result["hold"]["id"])
        self.assertEqual(summary["eligibility_hold"]["reason_code"], "KYC_NOT_VERIFIED")
        cleared = await finance.clear_documented_withdrawal_hold(
            "player-1", hold_id=result["hold"]["id"], actor="compliance-admin",
            reason="Legal case was resolved; KYC remains independently required",
        )
        self.assertFalse(cleared["duplicate"])
        after = await finance.get_documented_withdrawal_hold("player-1")
        self.assertIsNone(after["active_hold"])
        self.assertEqual(after["eligibility_hold"]["reason_code"], "KYC_NOT_VERIFIED")

    async def test_automatic_submission_revalidates_hold_after_claim_before_provider_call(self):
        await seed_cash("player-1", 1_000)
        await db.users.update_one(
            {"id": "player-1"}, {"$set": {"financial_risk_status": "ELIGIBLE"}},
        )
        method = await finance.create_payout_method(
            "player-1", account_holder_name="Test Player", bank_name="Test Bank",
            account_number="123456789012", ifsc_code="ABCD0123456",
        )
        await finance.set_withdrawal_mode(
            "AUTOMATIC", "super-admin", "Enable certified provider flow", self.provider,
        )
        withdrawal = await finance.create_withdrawal(
            "player-1", 1_000, method["id"],
            "withdraw-hold-after-automatic-claim", self.provider,
        )
        claimed = await finance.claim_automatic_withdrawal(withdrawal["id"])
        self.assertEqual(claimed["status"], "SUBMITTING")
        await db.users.update_one(
            {"id": "player-1"}, {"$set": {"withdrawal_hold": strict_withdrawal_hold(
                suffix="automatic-authorization-race", category="SANCTIONS",
                reason_code="SANCTIONS_SCREENING_REVIEW",
                source_type="SANCTIONS_REVIEW",
            )}},
        )
        with self.assertRaises(finance.FinancialError) as blocked:
            await finance._authorize_automatic_submission(withdrawal["id"])
        self.assertEqual(
            blocked.exception.code,
            "LEGAL_OR_COMPLIANCE_WITHDRAWAL_HOLD",
        )
        stored = await db.withdrawal_requests.find_one(
            {"id": withdrawal["id"]}, {"_id": 0},
        )
        self.assertEqual(stored["status"], "SUBMITTING")
        self.assertIsNone(stored.get("submission_authorized_at"))
        self.assertIsNone(stored.get("provider_payout_id"))
        self.assertEqual(self.provider.submit_calls, 0)

    async def test_deposit_retries_provider_gap_and_webhook_credits_exactly_once(self):
        self.provider.deposit_failures = 1
        with self.assertRaises(finance.FinancialError) as failed:
            await finance.create_deposit("player-1", 10000, "deposit-idem-0001", self.provider)
        self.assertEqual(failed.exception.code, "PAYMENT_PROVIDER_UNAVAILABLE")
        order, checkout = await finance.create_deposit(
            "player-1", 10000, "deposit-idem-0001", self.provider,
        )
        self.assertEqual(order["status"], "PENDING")
        self.assertTrue(checkout.startswith("https://test-provider.example.invalid/"))
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

    async def test_verified_deposit_persists_only_privacy_safe_payment_cluster(self):
        order, _ = await finance.create_deposit(
            "player-1", 10000, "deposit-payment-risk-cluster", self.provider,
        )
        event, raw = signed_event(self.provider, {
            "id": "evt-payment-risk-cluster", "type": "deposit.paid",
            "object_id": order["provider_order_id"], "amount_paise": 10000,
            "currency": "INR", "provider_reference": "provider-payment-risk-cluster",
        })
        raw_provider_token = "provider-instrument-fingerprint-0001"
        event = replace(event, data={"payment_instrument_fingerprint": raw_provider_token})
        with patch.dict(os.environ, {
            "REFERRAL_RISK_PEPPER": "test-only-referral-risk-pepper-32-bytes-minimum",
        }):
            credited = await finance.process_provider_event(self.provider, event, raw)
        self.assertEqual(credited["status"], "CREDITED")
        stored = await db.deposit_orders.find_one({"id": order["id"]}, {"_id": 0})
        self.assertRegex(stored["payment_instrument_cluster"], r"^rr1:[0-9a-f]{64}$")
        self.assertNotIn(raw_provider_token, str(stored))

    async def test_referral_processing_failure_never_rolls_back_verified_deposit(self):
        import promotions

        order, _ = await finance.create_deposit(
            "player-1", 10000, "deposit-referral-outbox", self.provider,
        )
        event, raw = signed_event(self.provider, {
            "id": "evt-deposit-referral-outbox", "type": "deposit.paid",
            "object_id": order["provider_order_id"], "amount_paise": 10000,
            "currency": "INR", "provider_reference": "provider-referral-outbox",
        })
        with patch.object(promotions, "feature_enabled", return_value=True):
            credited = await finance.process_provider_event(self.provider, event, raw)

        self.assertEqual(credited["status"], "CREDITED")
        stored = await db.deposit_orders.find_one({"id": order["id"]})
        self.assertEqual(stored["status"], "CREDITED")
        wallet = await finance.wallet_public("player-1")
        self.assertEqual(wallet["cash_chips"], 100)
        outbox = await db.financial_outbox.find_one({
            "kind": "PROMOTION_REFERRAL_EVENT",
        })
        self.assertIsNotNone(outbox)

        failure = promotions.PromotionError(
            "PROMOTION_STORAGE_UNAVAILABLE", "injected promotion failure", 503,
        )
        with patch.object(
            promotions, "record_referral_event",
            new=AsyncMock(side_effect=failure),
        ):
            processed = await finance.process_outbox_batch(self.provider)
        self.assertEqual(processed["retry_scheduled"], 1)
        stored_after = await db.deposit_orders.find_one({"id": order["id"]})
        self.assertEqual(stored_after["status"], "CREDITED")
        wallet_after = await finance.wallet_public("player-1")
        self.assertEqual(wallet_after["cash_chips"], 100)

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

    async def test_expired_webhook_claim_cannot_overwrite_new_owner(self):
        order, _ = await finance.create_deposit(
            "player-1", 10000, "deposit-webhook-fencing", self.provider,
        )
        event, raw = signed_event(self.provider, {
            "id": "evt-webhook-fencing", "type": "deposit.paid",
            "object_id": order["provider_order_id"], "amount_paise": 10000,
            "currency": "INR", "provider_reference": "provider-payment-fencing",
        })
        first_started = asyncio.Event()
        release_first = asyncio.Event()
        observed_claims = []
        calls = 0

        async def controlled_credit(_order, _event, actor="provider-webhook"):
            nonlocal calls
            calls += 1
            current = await db.provider_webhook_events.find_one(
                {"event_id": event.event_id}, {"_id": 0},
            )
            observed_claims.append(current["claim_id"])
            if calls == 1:
                first_started.set()
                await release_first.wait()
                raise finance.FinancialError(
                    "STALE_WORKER_FAILURE", "The expired worker must not finalize.", 503,
                )
            return {"deposit_id": order["id"], "status": "CREDITED"}

        with patch.object(finance, "_credit_deposit", new=controlled_credit):
            first_task = asyncio.create_task(
                finance.process_provider_event(self.provider, event, raw),
            )
            await first_started.wait()
            await db.provider_webhook_events.update_one(
                {"event_id": event.event_id},
                {"$set": {"lease_until": finance.now() - timedelta(seconds=1)}},
            )
            second = await finance.process_provider_event(self.provider, event, raw)
            release_first.set()
            first_result = (await asyncio.gather(first_task, return_exceptions=True))[0]

        self.assertEqual(second["status"], "CREDITED")
        self.assertIsInstance(first_result, finance.FinancialError)
        self.assertEqual(first_result.code, "STALE_WORKER_FAILURE")
        self.assertEqual(len(set(observed_claims)), 2)
        stored = await db.provider_webhook_events.find_one(
            {"event_id": event.event_id}, {"_id": 0},
        )
        self.assertEqual(stored["status"], "PROCESSED")
        self.assertEqual(stored["result"]["status"], "CREDITED")
        self.assertIsNone(stored["claim_id"])
        self.assertIsNone(stored["lease_until"])

    async def test_failed_and_expired_deposit_events_require_exact_money_binding(self):
        mismatches = (
            ("deposit.failed", 9_999, "INR"),
            ("deposit.expired", 10_000, "USD"),
            ("deposit.failed", None, None),
        )
        for index, (event_type, amount_paise, currency) in enumerate(mismatches):
            with self.subTest(event_type=event_type, amount_paise=amount_paise, currency=currency):
                order, _ = await finance.create_deposit(
                    "player-1", 10000, f"deposit-terminal-mismatch-{index}", self.provider,
                )
                event, raw = signed_event(self.provider, {
                    "id": f"evt-terminal-mismatch-{index}", "type": event_type,
                    "object_id": order["provider_order_id"],
                    "amount_paise": amount_paise, "currency": currency,
                })
                with self.assertRaises(finance.FinancialError) as mismatch:
                    await finance.process_provider_event(self.provider, event, raw)
                self.assertEqual(mismatch.exception.code, "PAYMENT_MISMATCH")
                stored = await db.deposit_orders.find_one(
                    {"id": order["id"]}, {"_id": 0},
                )
                self.assertEqual(stored["status"], "RECONCILIATION_REQUIRED")
                self.assertEqual(stored["limit_reservation_status"], "HELD")
                self.assertEqual(stored["reconciliation_error_code"], "PAYMENT_MISMATCH")
                stored_event = await db.provider_webhook_events.find_one(
                    {"event_id": event.event_id}, {"_id": 0},
                )
                self.assertEqual(stored_event["status"], "REVIEW_REQUIRED")
                self.assertIsNone(stored_event["claim_id"])

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
            "player-1", 1000, method["id"], "withdraw-idem-bank", self.provider,
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
                "player-1", 1000, method["id"], "withdraw-inactive-bank", self.provider,
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

    async def test_withdrawal_currency_floor_is_one_thousand_inr_across_rates(self):
        await seed_cash("player-1", 600_000)
        method = await finance.create_payout_method(
            "player-1", account_holder_name="Test Player", bank_name="Test Bank",
            account_number="123456789012", ifsc_code="ABCD0123456",
        )
        original_rate = os.environ["CHIPS_PER_INR"]
        original_minimum = os.environ["MIN_WITHDRAWAL_PAISE"]
        os.environ["MIN_WITHDRAWAL_PAISE"] = "100000"
        try:
            for rate, below_chips, boundary_chips in (
                (100, 99_999, 100_000),
                (200, 199_998, 200_000),
            ):
                with self.subTest(chips_per_inr=rate):
                    os.environ["CHIPS_PER_INR"] = str(rate)
                    with self.assertRaises(finance.FinancialError) as below:
                        await finance.create_withdrawal(
                            "player-1", below_chips, method["id"],
                            f"withdraw-below-floor-{rate}", self.provider,
                        )
                    self.assertEqual(below.exception.code, "WITHDRAWAL_LIMIT")
                    self.assertIn("₹1,000", below.exception.message)

                    accepted = await finance.create_withdrawal(
                        "player-1", boundary_chips, method["id"],
                        f"withdraw-at-floor-{rate}", self.provider,
                    )
                    self.assertEqual(accepted["amount_paise"], 100_000)
                    self.assertEqual(accepted["status"], "PENDING_ADMIN")
        finally:
            os.environ["CHIPS_PER_INR"] = original_rate
            os.environ["MIN_WITHDRAWAL_PAISE"] = original_minimum

    async def test_wallet_exposes_safe_server_derived_money_config(self):
        names = (
            "CHIPS_PER_INR", "CHIP_RATE_VERSION", "MIN_DEPOSIT_PAISE",
            "MAX_DEPOSIT_PAISE", "MIN_WITHDRAWAL_PAISE",
            "MIN_WITHDRAWAL_CHIPS", "MAX_WITHDRAWAL_CHIPS",
        )
        original = {name: os.environ[name] for name in names}
        os.environ.update({
            "CHIPS_PER_INR": "250",
            "CHIP_RATE_VERSION": "public-config-test",
            "MIN_DEPOSIT_PAISE": "25000",
            "MAX_DEPOSIT_PAISE": "500000",
            "MIN_WITHDRAWAL_PAISE": "100000",
            "MIN_WITHDRAWAL_CHIPS": "100",
            "MAX_WITHDRAWAL_CHIPS": "750000",
        })
        try:
            response = await routes.payment_wallet(user=self.user)
        finally:
            os.environ.update(original)

        config = response["money_config"]
        self.assertEqual(config["currency"], "INR")
        self.assertEqual(config["rate"], {
            "version": "public-config-test",
            "chips_per_inr": 250,
            "paise_per_inr": 100,
        })
        self.assertEqual(config["checkout_hosts"], ["checkout.example.test"])
        self.assertEqual(config["deposits"], {
            "minimum_paise": 25_000,
            "maximum_paise": 500_000,
        })
        self.assertEqual(config["withdrawals"], {
            "minimum_paise": 100_000,
            "maximum_paise": 300_000,
            "minimum_chips": 250_000,
            "maximum_chips": 750_000,
            "exact_chip_conversion_required": True,
        })
        serialized = json.dumps(config, sort_keys=True)
        for forbidden in ("provider", "secret", "credential", "webhook", "routing"):
            self.assertNotIn(forbidden, serialized.lower())

    async def test_wallet_read_survives_invalid_public_money_config(self):
        original = os.environ["MIN_WITHDRAWAL_PAISE"]
        os.environ["MIN_WITHDRAWAL_PAISE"] = "not-an-integer"
        try:
            response = await routes.payment_wallet(user=self.user)
        finally:
            os.environ["MIN_WITHDRAWAL_PAISE"] = original

        self.assertEqual(response["wallet"]["bonus_chips"], 1000)
        self.assertIsNone(response["money_config"])
        self.assertFalse(response["financial"]["ready"])
        self.assertEqual(
            response["financial"]["availability_code"], "PAYMENTS_UNAVAILABLE",
        )
        self.assertTrue(all(
            available is False
            for available in response["financial"]["features"].values()
        ))

    def test_render_financial_rollout_stays_source_controlled_off(self):
        with open(os.path.join(HERE, "..", "render.yaml"), encoding="utf-8") as stream:
            blueprint = stream.read()
        for setting in (
            "REAL_MONEY_ENABLED", "DEPOSITS_ENABLED", "WITHDRAWALS_ENABLED",
            "AUTO_WITHDRAWALS_ENABLED", "PAYMENT_LIVE_MODE_ALLOWED",
            "FINANCIAL_GAME_WALLET_INTEGRATED",
        ):
            self.assertIn(
                f"- key: {setting}\n        value: \"false\"",
                blueprint,
            )
        self.assertIn(
            "- key: PAYMENT_PROVIDER_CHECKOUT_ALLOWED_DOMAINS\n        sync: false",
            blueprint,
        )

    async def test_public_limits_match_request_caps_and_fail_impossible_rates(self):
        env = dict(os.environ)
        env.update({
            "CHIPS_PER_INR": "2",
            "MIN_DEPOSIT_PAISE": "10000",
            "MAX_DEPOSIT_PAISE": "100000000000",
            "MIN_WITHDRAWAL_PAISE": "100000",
            "MIN_WITHDRAWAL_CHIPS": "500",
            "MAX_WITHDRAWAL_CHIPS": "1000000000",
        })
        config = finance.public_money_config(env)
        self.assertEqual(
            config["deposits"]["maximum_paise"],
            finance.DEPOSIT_REQUEST_MAX_PAISE,
        )
        self.assertEqual(
            config["withdrawals"]["maximum_chips"],
            finance.WITHDRAWAL_REQUEST_MAX_CHIPS,
        )

        one_chip = dict(env)
        one_chip.update({
            "CHIPS_PER_INR": "1",
            "MIN_DEPOSIT_PAISE": "1",
            "MAX_DEPOSIT_PAISE": "1000",
        })
        self.assertEqual(
            finance.public_money_config(one_chip)["deposits"]["minimum_paise"],
            100,
        )

        impossible = dict(env)
        impossible.update({
            "CHIPS_PER_INR": "2000",
            "MAX_WITHDRAWAL_CHIPS": "1000000",
        })
        with self.assertRaises(ProviderConfigurationError):
            finance.public_money_config(impossible)
        self.assertTrue(any(
            "do not allow any request" in error
            for error in finance._configuration_errors(impossible)
        ))

        deposit_only = dict(impossible)
        deposit_only.update({
            "DEPOSITS_ENABLED": "true",
            "WITHDRAWALS_ENABLED": "false",
            "AUTO_WITHDRAWALS_ENABLED": "false",
        })
        deposit_config = finance.public_money_config(deposit_only)
        self.assertIsNotNone(deposit_config["deposits"])
        self.assertIsNone(deposit_config["withdrawals"])
        self.assertFalse(any(
            "Withdrawal limits" in error
            for error in finance._configuration_errors(deposit_only)
        ))

        withdrawal_only = dict(env)
        withdrawal_only.update({
            "DEPOSITS_ENABLED": "false",
            "WITHDRAWALS_ENABLED": "true",
            "MIN_DEPOSIT_PAISE": "2000000000",
            "MAX_DEPOSIT_PAISE": "2000000000",
        })
        withdrawal_config = finance.public_money_config(withdrawal_only)
        self.assertIsNone(withdrawal_config["deposits"])
        self.assertIsNotNone(withdrawal_config["withdrawals"])
        self.assertFalse(any(
            "Deposit limits" in error
            for error in finance._configuration_errors(withdrawal_only)
        ))

        paused_deposits = dict(withdrawal_only)
        paused_deposits["DEPOSIT_REFUND_RECONCILE_SECONDS"] = "invalid"
        self.assertTrue(any(
            "DEPOSIT_REFUND_RECONCILE_SECONDS must be an integer" in error
            for error in finance._configuration_errors(paused_deposits)
        ))

    async def test_default_withdrawal_currency_floor_is_one_thousand_inr(self):
        env = dict(os.environ)
        env.pop("MIN_WITHDRAWAL_PAISE", None)
        config = finance.public_money_config(env)
        self.assertEqual(config["withdrawals"]["minimum_paise"], 100_000)

    async def test_withdrawal_currency_floor_cannot_be_lowered_by_configuration(self):
        env = dict(os.environ)
        env["MIN_WITHDRAWAL_PAISE"] = "99999"
        with self.assertRaises(ProviderConfigurationError):
            finance.public_money_config(env)
        self.assertTrue(any(
            "MIN_WITHDRAWAL_PAISE must be between 100000" in error
            for error in finance._configuration_errors(env)
        ))

        original = os.environ["MIN_WITHDRAWAL_PAISE"]
        os.environ["MIN_WITHDRAWAL_PAISE"] = "99999"
        try:
            with self.assertRaises(finance.FinancialError) as changed:
                await finance.create_withdrawal(
                    "player-1", 1000, "not-reached", "withdraw-floor-override", self.provider,
                )
            self.assertEqual(changed.exception.code, "FINANCIAL_CONFIGURATION_CHANGED")
        finally:
            os.environ["MIN_WITHDRAWAL_PAISE"] = original

    async def test_all_bank_detail_routes_use_operator_player_guard(self):
        bank_routes = [
            route for route in routes.router.routes
            if route.path.startswith("/payments/bank-details")
        ]
        self.assertEqual(len(bank_routes), 3)
        for route in bank_routes:
            self.assertTrue(route.dependant.dependencies)
            self.assertIs(
                route.dependant.dependencies[0].call,
                routes.require_operator_player,
            )

    async def test_manual_withdrawal_never_calls_provider_and_finalizes_once(self):
        await seed_cash("player-1", 1000)
        method = await finance.create_payout_method(
            "player-1", account_holder_name="Test Player", bank_name="Test Bank",
            account_number="123456789012", ifsc_code="ABCD0123456",
        )
        withdrawal = await finance.create_withdrawal(
            "player-1", 1000, method["id"], "withdraw-idem-manual", self.provider,
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
        self.assertEqual((wallet["cash_chips"], wallet["held_chips"]), (0, 0))
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
            "player-1", 1000, method["id"], "withdraw-risk-review", self.provider,
        )
        self.assertEqual(held_for_review["status"], "PENDING_ADMIN")
        self.assertEqual(held_for_review["withdrawal_mode"], "MANUAL")
        await finance.reject_withdrawal(held_for_review["id"], "admin-1", "Risk not assessed")

        await db.users.update_one(
            {"id": "player-1"}, {"$set": {"financial_risk_status": "ELIGIBLE"}},
        )
        automatic = await finance.create_withdrawal(
            "player-1", 1000, method["id"], "withdraw-auto-safe", self.provider,
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
            "player-1", 1000, method["id"], "withdraw-stale-outbox", self.provider,
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

    async def test_expired_outbox_claim_cannot_overwrite_new_owner(self):
        await db.financial_outbox.insert_one({
            "id": "outbox-fencing", "kind": "SUBMIT_PAYOUT",
            "aggregate_id": "withdrawal-fencing", "dedupe_key": "outbox-fencing",
            "payload": {"withdrawal_id": "withdrawal-fencing"},
            "status": "PENDING", "attempts": 0, "next_attempt_at": finance.now(),
            "lease_until": None, "claim_id": None,
            "created_at": finance.now(), "updated_at": finance.now(),
        })
        first_started = asyncio.Event()
        release_first = asyncio.Event()
        observed_claims = []
        calls = 0

        async def controlled_submission(_withdrawal_id, _provider):
            nonlocal calls
            calls += 1
            current = await db.financial_outbox.find_one(
                {"id": "outbox-fencing"}, {"_id": 0},
            )
            observed_claims.append(current["claim_id"])
            if calls == 1:
                first_started.set()
                await release_first.wait()

        with patch.object(finance, "submit_automatic_withdrawal", new=controlled_submission):
            first_task = asyncio.create_task(
                finance.process_outbox_batch(self.provider, limit=1),
            )
            await first_started.wait()
            await db.financial_outbox.update_one(
                {"id": "outbox-fencing"},
                {"$set": {"lease_until": finance.now() - timedelta(seconds=1)}},
            )
            second = await finance.process_outbox_batch(self.provider, limit=1)
            release_first.set()
            first = await first_task

        self.assertEqual(second["processed"], 1)
        self.assertEqual(first["processed"], 0)
        self.assertEqual(len(set(observed_claims)), 2)
        stored = await db.financial_outbox.find_one(
            {"id": "outbox-fencing"}, {"_id": 0},
        )
        self.assertEqual(stored["status"], "COMPLETED")
        self.assertIsNone(stored["claim_id"])
        self.assertIsNone(stored["lease_until"])

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
            "player-1", 1000, method["id"], "withdraw-unknown-result", self.provider,
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
        self.assertTrue(recovered["provider_payout_id"].startswith("test_payout_"))
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
                "player-1", 1000, method["id"], "withdraw-idem-concurrent", self.provider,
            ) for _ in range(8)
        ])
        self.assertEqual(await db.withdrawal_requests.count_documents({}), 1)
        self.assertEqual(len({row["id"] for row in withdrawals}), 1)
        wallet = await finance.wallet_public("player-1")
        self.assertEqual((wallet["cash_chips"], wallet["held_chips"]), (0, 1000))

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
            "object_id": held["provider_order_id"], "amount_paise": 10000,
            "currency": "INR",
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

            await seed_cash("player-1", 2000)
            method = await finance.create_payout_method(
                "player-1", account_holder_name="Test Player", bank_name="Test Bank",
                account_number="123456789012", ifsc_code="ABCD0123456",
            )
            withdrawal = await finance.create_withdrawal(
                "player-1", 2000, method["id"], "withdraw-rate-snapshot", self.provider,
            )
            os.environ["CHIPS_PER_INR"] = "3"
            replay_withdrawal = await finance.create_withdrawal(
                "player-1", 2000, method["id"], "withdraw-rate-snapshot", self.provider,
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
            "player-1", 1000, method["id"], "withdraw-pause-race", self.provider,
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
            "player-1", 1000, method["id"], "withdraw-starvation", self.provider,
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
            "player-1", 1000, method["id"], "withdraw-foreign-ref", self.provider,
        )
        self.provider.submit_failures = 1
        await finance.process_outbox_batch(self.provider)
        self.provider._payouts["foreign-paid-id"] = {
            "amount_paise": 100000, "currency": "INR",
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
        self.assertEqual((await finance.wallet_public("player-1"))["held_chips"], 1000)

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
            "active_session_id": "payment-admin-session",
            "admin_step_up_session_id": "payment-admin-session",
        }
        with self.assertRaises(HTTPException) as denied:
            await routes.payments_reconcile_and_pay(user=explicit_empty)
        self.assertEqual(denied.exception.detail["code"], "ADMIN_PERMISSION_REQUIRED")

        legacy = dict(explicit_empty)
        legacy.pop("admin_permissions")
        allowed = await routes.payments_reconcile_and_pay(user=legacy)
        self.assertEqual(allowed["id"], "admin-1")

        pre_rbac = {
            "id": "admin-legacy", "role": "ADMIN", "status": "ACTIVE",
            "admin_role": "OPERATIONS",
        }
        self.assertEqual((await routes.payments_view(user=pre_rbac))["id"], "admin-legacy")
        self.assertEqual((await routes.audit_view(user=pre_rbac))["id"], "admin-legacy")
        with self.assertRaises(HTTPException) as mutation_denied:
            await routes.withdrawals_approve(user=pre_rbac)
        self.assertEqual(mutation_denied.exception.detail["code"], "ADMIN_PERMISSION_REQUIRED")

        bootstrap = {
            "id": "admin-bootstrap", "role": "ADMIN", "status": "ACTIVE",
            "admin_permissions": [],
        }
        self.assertEqual((await routes.kyc_view(user=bootstrap))["id"], "admin-bootstrap")
        with self.assertRaises(HTTPException) as bootstrap_needs_step_up:
            await routes.kyc_review(user=bootstrap)
        self.assertEqual(
            bootstrap_needs_step_up.exception.detail["code"], "ADMIN_MFA_REQUIRED",
        )

        money_admin = {
            "id": "money-admin", "role": "ADMIN", "status": "ACTIVE",
            "admin_permissions": ["WITHDRAWALS_MARK_PAID", "PAYMENTS_RECONCILE"],
        }
        for dependency in (routes.withdrawals_pay, routes.payments_reconcile):
            with self.subTest(dependency=dependency):
                with self.assertRaises(HTTPException) as no_step_up:
                    await dependency(user=money_admin)
                self.assertEqual(
                    no_step_up.exception.detail["code"], "ADMIN_MFA_REQUIRED",
                )
        money_admin.update({
            "mfa_enabled": True, "mfa_verified_at": finance.now(),
            "reauthenticated_at": finance.now(),
            "active_session_id": "money-admin-session",
            "admin_step_up_session_id": "money-admin-session",
        })
        self.assertEqual((await routes.withdrawals_pay(user=money_admin))["id"], "money-admin")
        self.assertEqual((await routes.payments_reconcile(user=money_admin))["id"], "money-admin")

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
            })
        with self.assertRaises(ProviderConfigurationError):
            load_payment_provider({})

        mutation_operations = (
            "create_deposit_order", "create_checkout_session",
            "create_beneficiary", "submit_payout", "cancel_payout",
            "refund_payment",
        )
        for operation in mutation_operations:
            config = json.loads(json.dumps(TEST_PROVIDER_CONFIG))
            config["endpoints"][operation]["method"] = "GET"
            env = {**TEST_PROVIDER_ENV, "PAYMENT_PROVIDER_CONFIG_JSON": json.dumps(config)}
            with self.subTest(get_mutation=operation):
                with self.assertRaises(ProviderConfigurationError):
                    load_payment_provider(env)

        status_get = json.loads(json.dumps(TEST_PROVIDER_CONFIG))
        status_get["endpoints"]["get_payment_status"]["method"] = "GET"
        status_get["endpoints"]["get_payout_status"]["method"] = "GET"
        status_provider = load_payment_provider({
            **TEST_PROVIDER_ENV,
            "PAYMENT_PROVIDER_CONFIG_JSON": json.dumps(status_get),
        })
        self.assertTrue(status_provider.capabilities.payment_status_lookup)
        self.assertTrue(status_provider.capabilities.payout_status_lookup)

        payout_operations = {
            "create_beneficiary", "submit_payout", "get_payout_status", "cancel_payout",
        }
        deposit_only = json.loads(json.dumps(TEST_PROVIDER_CONFIG))
        deposit_only["capabilities"].update({
            "payout_idempotency": False,
            "payout_status_lookup": False,
            "payout_cancellation": False,
        })
        for section in ("endpoints", "request_mapping", "response_mapping"):
            for operation in payout_operations:
                deposit_only[section].pop(operation)
        deposit_only["status_mapping"].pop("payout")
        deposit_provider = load_payment_provider({
            **TEST_PROVIDER_ENV,
            "PAYMENT_PROVIDER_CONFIG_JSON": json.dumps(deposit_only),
        })
        self.assertTrue(deposit_provider.capabilities.deposit_idempotency)
        self.assertFalse(deposit_provider.capabilities.payout_idempotency)

        deposit_operations = {
            "create_deposit_order", "create_checkout_session", "get_payment_status", "refund_payment",
        }
        payout_only = json.loads(json.dumps(TEST_PROVIDER_CONFIG))
        payout_only["capabilities"].update({
            "deposit_idempotency": False,
            "payment_status_lookup": False,
            "refunds": False,
        })
        for section in ("endpoints", "request_mapping", "response_mapping"):
            for operation in deposit_operations:
                payout_only[section].pop(operation)
        payout_only["status_mapping"].pop("deposit")
        payout_env = {
            **TEST_PROVIDER_ENV,
            "PAYMENT_PROVIDER_CONFIG_JSON": json.dumps(payout_only),
        }
        payout_env.pop("PAYMENT_PROVIDER_CHECKOUT_ALLOWED_DOMAINS")
        payout_provider = load_payment_provider(payout_env)
        self.assertFalse(payout_provider.capabilities.deposit_idempotency)
        self.assertTrue(payout_provider.capabilities.payout_idempotency)

        missing_required_payout = json.loads(json.dumps(payout_only))
        missing_required_payout["endpoints"].pop("submit_payout")
        with self.assertRaises(ProviderConfigurationError):
            load_payment_provider({
                **payout_env,
                "PAYMENT_PROVIDER_CONFIG_JSON": json.dumps(missing_required_payout),
            })

        malformed_port = json.loads(json.dumps(TEST_PROVIDER_CONFIG))
        malformed_port["base_url"] = "https://payments.example.test:notaport"
        with self.assertRaises(ProviderConfigurationError):
            load_payment_provider({
                **TEST_PROVIDER_ENV,
                "PAYMENT_PROVIDER_CONFIG_JSON": json.dumps(malformed_port),
            })

        static_secret = json.loads(json.dumps(TEST_PROVIDER_CONFIG))
        static_secret["headers"] = {"X-API-Key": "plaintext-secret"}
        with self.assertRaises(ProviderConfigurationError):
            load_payment_provider({
                **TEST_PROVIDER_ENV,
                "PAYMENT_PROVIDER_CONFIG_JSON": json.dumps(static_secret),
            })

        bridge = load_payment_provider(dict(os.environ))
        self.assertEqual(bridge.checkout_allowed_hosts, ("checkout.example.test",))
        self.assertEqual(
            bridge._safe_checkout_url("https://checkout.example.test/session?order=one"),
            "https://checkout.example.test/session?order=one",
        )
        for unsafe_url in (
            "http://checkout.example.test/session",
            "https://user:password@checkout.example.test/session",
            "https://checkout.example.test/session#credential",
            "https://checkout.example.test:8443/session",
            "https://checkout.example.test:notaport/session",
            "https://nested.checkout.example.test/session",
            "https://phishing.invalid/session",
        ):
            with self.subTest(unsafe_checkout_url=unsafe_url):
                with self.assertRaises(ProviderRequestError):
                    bridge._safe_checkout_url(unsafe_url)

        missing_checkout_allowlist = dict(os.environ)
        missing_checkout_allowlist.pop("PAYMENT_PROVIDER_CHECKOUT_ALLOWED_DOMAINS")
        with self.assertRaises(ProviderConfigurationError):
            finance.public_money_config(missing_checkout_allowlist)

        async def unsafe_checkout(operation, values, idempotency_key=None):
            return {"id": "provider-order", "checkout_url": "https://phishing.invalid/session", "status": "PENDING"}

        bridge._request = unsafe_checkout
        with self.assertRaises(ProviderRequestError):
            await bridge.create_deposit_order(
                deposit_id="deposit-1", amount_paise=10_000, currency="INR",
                idempotency_key="deposit-idempotency", return_url="https://chakri.casino/wallet",
            )

        finance.GAME_WALLET_INTEGRATION_READY = False
        uncertified = await finance.prepare_financial_core(dict(os.environ))
        self.assertFalse(uncertified["ready"])
        self.assertTrue(any("not certified" in error for error in uncertified["errors"]))
        finance.GAME_WALLET_INTEGRATION_READY = True
        self.assertTrue((await finance.prepare_financial_core())["ready"])

        # KYC gates cash-out, not chip purchases: an un-KYC'd but otherwise
        # eligible player can deposit, while withdrawals stay fail-closed on KYC.
        no_kyc = {**self.user, "kyc_status": "UNVERIFIED", "identity_verified": True}
        self.assertIs(await routes._require_player("deposits", no_kyc), no_kyc)
        with self.assertRaises(HTTPException) as blocked:
            await routes._require_player("withdrawals", no_kyc)
        self.assertEqual(blocked.exception.detail["code"], "KYC_WITHDRAWAL_HOLD")
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
            "active_session_id": "kyc-admin-session",
            "admin_step_up_session_id": "kyc-admin-session",
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
        malformed["PAYMENT_PROVIDER_CONFIG_JSON"] = "not-json"
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

    async def test_pinned_provider_request_uses_logical_host_authority(self):
        for hostname, port, expected in (
            ("payments.example.test", 8443, b"Host: payments.example.test:8443"),
            ("2001:4860:4860::8888", 9443, b"Host: [2001:4860:4860::8888]:9443"),
        ):
            with self.subTest(hostname=hostname, port=port):
                connection = ProviderPinnedHTTPSConnection(
                    "93.184.216.34", hostname, port, timeout=1,
                )
                connection.putrequest("POST", "/v1/status")
                self.assertIn(expected, connection._buffer)

        config = json.loads(json.dumps(TEST_PROVIDER_CONFIG))
        config["base_url"] = "https://payments.example.test:8443"
        provider = load_payment_provider({
            **TEST_PROVIDER_ENV,
            "PAYMENT_PROVIDER_CONFIG_JSON": json.dumps(config),
        })
        captured = {}

        class Response:
            status = 200

            @staticmethod
            def read(_maximum):
                return b"{}"

        class RecordingConnection:
            def __init__(self, address, hostname, port, *, timeout):
                captured.update({
                    "address": address, "hostname": hostname,
                    "port": port, "timeout": timeout,
                })

            @staticmethod
            def request(method, path, body=None, headers=None):
                captured.update({
                    "method": method, "path": path,
                    "body": body, "headers": dict(headers or {}),
                })

            @staticmethod
            def getresponse():
                return Response()

            @staticmethod
            def close():
                return None

        with patch.object(
            provider, "_resolve_public_addresses", return_value=["93.184.216.34"],
        ), patch("payment_providers._PinnedHTTPSConnection", RecordingConnection):
            await provider._request(
                "get_payment_status", {"provider_order_id": "provider-order-1"},
            )
        self.assertEqual(
            (captured["hostname"], captured["port"]),
            ("payments.example.test", 8443),
        )
        self.assertNotIn("Host", captured["headers"])


class OperatorRailTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        for name in await db.list_collection_names():
            await db[name].delete_many({})
        finance.GAME_WALLET_INTEGRATION_READY = False
        # FinancialCoreTests prepares the module earlier in this script. Reset
        # its cached readiness so this class actually exercises the declared
        # operator-only, financial-core-closed state independent of test order.
        finance._READY = False
        self.user = {
            "id": "player-op-1", "role": "PLAYER", "status": "ACTIVE",
            "email": "player@example.test", "chip_balance": 5000,
        }
        await db.users.insert_one(dict(self.user))
        self.admin = {
            "id": "admin-1", "role": "ADMIN", "status": "ACTIVE",
            "admin_role": "SUPER_ADMIN",
        }

    async def test_wallet_publishes_operator_rail_while_financial_core_is_closed(self):
        response = await routes.payment_wallet(user=self.user)
        self.assertFalse(response["financial"]["ready"])
        self.assertEqual(response["financial"]["availability_code"], "PAYMENTS_UNAVAILABLE")
        self.assertTrue(response["financial"]["operator"]["enabled"])
        self.assertEqual(response["financial"]["operator"]["rail"], "ADMIN_REVIEW")
        self.assertEqual(response["financial"]["operator"]["limits"]["min_deposit_paise"], 10_000)

    async def test_operator_buy_and_withdraw_sync_to_admin_and_move_chips_on_approve(self):
        buy = await routes.create_operator_deposit(
            routes.OperatorDepositCreate(amount_paise=100_000),
            user=self.user,
        )
        self.assertEqual(buy["source"], "ADMIN_REVIEW")
        self.assertEqual(buy["deposit"]["status"], "PENDING")
        self.assertEqual(buy["deposit"]["chips"], 1000)

        listed = await routes.list_deposits(user=self.user)
        self.assertEqual(listed["deposits"][0]["id"], buy["deposit"]["id"])

        admin_listed = await routes.admin_deposits(status=None, admin=self.admin)
        self.assertEqual(admin_listed["deposits"][0]["source"], "ADMIN_REVIEW")
        self.assertEqual(admin_listed["deposits"][0]["user_email"], "player@example.test")

        approved = await routes.admin_approve_operator_request(
            buy["deposit"]["id"],
            routes.OperatorResolve(note="Cash received"),
            admin=self.admin,
        )
        self.assertEqual(approved["request"]["status"], "APPROVED")
        user = await db.users.find_one({"id": self.user["id"]})
        self.assertEqual(user["chip_balance"], 6000)

        method = await finance.create_payout_method(
            self.user["id"],
            account_holder_name="Test Player",
            bank_name="Operator Bank",
            account_number="123456789012",
            ifsc_code="ABCD0123456",
        )
        withdraw = await routes.create_operator_withdrawal(
            routes.OperatorWithdrawalCreate(amount_chips=1000, bank_detail_id=method["id"]),
            user=self.user,
        )
        self.assertEqual(withdraw["withdrawal"]["status"], "PENDING")

        admin_withdrawals = await routes.admin_withdrawals(status="PENDING", admin=self.admin)
        self.assertEqual(admin_withdrawals["withdrawals"][0]["source"], "ADMIN_REVIEW")
        self.assertEqual(admin_withdrawals["withdrawals"][0]["internal_status"], "PENDING")

        paid = await routes.admin_approve_operator_request(
            withdraw["withdrawal"]["id"],
            routes.OperatorResolve(note="Paid to bank"),
            admin=self.admin,
        )
        self.assertEqual(paid["request"]["status"], "APPROVED")
        user = await db.users.find_one({"id": self.user["id"]})
        self.assertEqual(user["chip_balance"], 5000)

    async def test_operator_reject_does_not_move_chips(self):
        buy = await routes.create_operator_deposit(
            routes.OperatorDepositCreate(amount_paise=50_000),
            user=self.user,
        )
        await routes.admin_reject_operator_request(
            buy["deposit"]["id"],
            routes.OperatorResolve(reason="Payment not received"),
            admin=self.admin,
        )
        user = await db.users.find_one({"id": self.user["id"]})
        self.assertEqual(user["chip_balance"], 5000)

    async def test_operator_withdrawal_requires_bank_and_balance(self):
        with self.assertRaises(HTTPException) as missing_bank:
            await routes.create_operator_withdrawal(
                routes.OperatorWithdrawalCreate(amount_chips=1000, bank_detail_id="missing-bank-id"),
                user=self.user,
            )
        self.assertEqual(missing_bank.exception.status_code, 400)

        method = await finance.create_payout_method(
            self.user["id"],
            account_holder_name="Test Player",
            bank_name="Operator Bank",
            account_number="123456789012",
            ifsc_code="ABCD0123456",
        )
        with self.assertRaises(HTTPException) as too_much:
            await routes.create_operator_withdrawal(
                routes.OperatorWithdrawalCreate(amount_chips=9000, bank_detail_id=method["id"]),
                user=self.user,
            )
        self.assertEqual(too_much.exception.status_code, 409)


if __name__ == "__main__":
    unittest.main(verbosity=2)
