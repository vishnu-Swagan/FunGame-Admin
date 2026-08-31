"""Universal payment hub contract, security and idempotency tests."""
from __future__ import annotations

import base64
import asyncio
import hashlib
import hmac
import json
import os
import sys
import time
import unittest
from datetime import timedelta
from unittest.mock import patch

from mongomock_motor import AsyncMongoMockClient


HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.update({
    "APP_ENV": "test", "PAYMENTS_V2_ENABLED": "true",
    "PAYMENT_GATEWAY_ADMIN_ENABLED": "true", "PAYMENT_LIVE_MODE_ALLOWED": "false",
    "PAYMENT_CREDENTIALS_MASTER_KEY": base64.urlsafe_b64encode(b"h" * 32).decode(),
    "PAYMENT_PROVIDER_ALLOWED_DOMAINS": "sandbox.example.test",
})
os.environ.setdefault("MONGO_URL", "mongodb://127.0.0.1:27017")
os.environ.setdefault("DB_NAME", "payment_hub_import")

client = AsyncMongoMockClient()
db = client["payment_hub_test"]

from payment_hub.adapters import (  # noqa: E402
    _PinnedHTTPSConnection as HubPinnedHTTPSConnection,
    AdapterResult, BaseAdapter, GenericRestAdapter, WebhookResult,
)
from payment_hub.domain import Capability, GatewayError, PayinStatus, require_transition  # noqa: E402
from payment_hub.registry import registry  # noqa: E402
from payment_hub import service  # noqa: E402

service.db = db


class DeterministicTestGatewayAdapter(BaseAdapter):
    """Test-only fake; the runtime registry contains no synthetic gateway."""

    code = "TEST_FAKE"
    capabilities = frozenset(Capability)

    def __init__(self, config=None, secrets=None, allowed_domains=None):
        self.config = dict(config or {})
        self.secrets = dict(secrets or {})

    async def validate_config(self):
        if len(str(self.secrets.get("webhook_secret", ""))) < 32:
            raise GatewayError("GATEWAY_SECRET_INVALID", "Test webhook secret is unavailable.")

    async def health_check(self, context=None):
        await self.validate_config()
        return {"status": "HEALTHY", "latency_ms": 0, "adapter": self.code}

    @staticmethod
    def _id(prefix, value):
        return f"{prefix}_{hashlib.sha256(value.encode()).hexdigest()[:24]}"

    async def create_payin(self, request, idempotency_key):
        return AdapterResult(self._id("test_payin", idempotency_key), "PENDING")

    async def get_payin_status(self, provider_payment_id):
        return AdapterResult(provider_payment_id, "PENDING")

    async def create_payout(self, request, idempotency_key):
        return AdapterResult(self._id("test_payout", idempotency_key), "PROCESSING")

    async def get_payout_status(self, provider_payout_id):
        return AdapterResult(provider_payout_id, "PROCESSING")

    def sign_webhook(self, raw_body, timestamp=None):
        stamp = int(time.time() if timestamp is None else timestamp)
        digest = hmac.new(
            str(self.secrets["webhook_secret"]).encode(), f"{stamp}.".encode() + raw_body,
            hashlib.sha256,
        ).hexdigest()
        return {"X-Payment-Timestamp": str(stamp), "X-Payment-Signature": f"sha256={digest}"}

    def verify_webhook(self, headers, raw_body):
        lowered = {str(key).lower(): str(value) for key, value in headers.items()}
        try:
            stamp = int(lowered.get("x-payment-timestamp", ""))
        except ValueError as exc:
            raise GatewayError("WEBHOOK_SIGNATURE_INVALID", "Webhook verification failed.", status_code=401) from exc
        if abs(int(time.time()) - stamp) > 300:
            raise GatewayError("WEBHOOK_REPLAY_REJECTED", "Webhook timestamp is outside the replay window.", status_code=401)
        expected = hmac.new(
            str(self.secrets["webhook_secret"]).encode(), f"{stamp}.".encode() + raw_body,
            hashlib.sha256,
        ).hexdigest()
        supplied = lowered.get("x-payment-signature", "").removeprefix("sha256=")
        if not hmac.compare_digest(supplied, expected):
            raise GatewayError("WEBHOOK_SIGNATURE_INVALID", "Webhook verification failed.", status_code=401)

    def parse_webhook(self, headers, raw_body):
        self.verify_webhook(headers, raw_body)
        payload = json.loads(raw_body)
        direction = str(payload.get("direction", "PAYIN")).upper()
        canonical_types = {
            "payment.updated": "PAYIN.PAYMENT_UPDATED",
            "payout.updated": "PAYOUT.PAYOUT_UPDATED",
        }
        event_type = canonical_types.get(payload["type"], str(payload["type"]).upper())
        return WebhookResult(
            payload["id"], event_type, direction, payload["object_id"], payload["status"],
            payload.get("amount_minor"), payload.get("currency"),
            payload.get("provider_reference"), payload,
        )


if "TEST_FAKE" not in registry.codes():
    registry.register(
        "TEST_FAKE",
        lambda config, secrets, domains: DeterministicTestGatewayAdapter(config, secrets, domains),
    )


def generic_rest_config():
    return {
        "base_url": "https://sandbox.example.test",
        "checkout_hosts": ["checkout.sandbox.example.test"],
        "capabilities": [
            "PAYIN", "PAYOUT", "PAYMENT_STATUS_QUERY", "PAYOUT_STATUS_QUERY", "WEBHOOKS",
        ],
        "endpoints": {
            "health_check": "/health", "create_payin": "/payments",
            "get_payin_status": "/payments/status", "create_payout": "/payouts",
            "get_payout_status": "/payouts/status",
        },
        "request_mapping": {
            "health_check": {},
            "create_payin": {"amount_minor": "amount", "currency": "currency", "reference": "merchant.reference"},
            "get_payin_status": {"provider_payment_id": "payment_id"},
            "create_payout": {
                "withdrawal_id": "merchant.withdrawal_id", "provider_beneficiary_id": "beneficiary_id",
                "amount_minor": "amount", "currency": "currency",
            },
            "get_payout_status": {"provider_payout_id": "payout_id"},
        },
        "response_mapping": {
            "create_payin": {"provider_id": "data.id", "status": "data.status", "checkout_url": "data.checkout_url"},
            "get_payin_status": {
                "provider_id": "data.id", "status": "data.status", "amount_minor": "data.amount",
                "currency": "data.currency", "provider_reference": "data.reference",
            },
            "create_payout": {"provider_id": "data.id", "status": "data.status"},
            "get_payout_status": {
                "provider_id": "data.id", "status": "data.status", "amount_minor": "data.amount",
                "currency": "data.currency", "provider_reference": "data.reference",
                "withdrawal_id": "data.withdrawal_id", "idempotency_key": "data.idempotency_key",
                "provider_beneficiary_id": "data.beneficiary_id",
            },
        },
        "status_mapping": {
            "PENDING": "PENDING", "SUCCEEDED": "SUCCEEDED",
            "PROCESSING": "PROCESSING", "PAID": "PAID",
        },
        "auth": {"strategy": "bearer", "credential_key": "api_token"},
        "idempotency_header": "Idempotency-Key",
        "webhook": {
            "algorithm": "hmac-sha256", "credential_key": "webhook_secret",
            "timestamp_header": "X-Payment-Timestamp", "signature_header": "X-Payment-Signature",
            "signature_prefix": "sha256=", "replay_window_seconds": 300,
        },
        "webhook_mapping": {
            "event_id": "event.id", "event_type": "event.type", "object_id": "payment.id",
            "status": "payment.status", "amount_minor": "payment.amount",
            "currency": "payment.currency", "provider_reference": "payment.reference",
        },
        "webhook_event_mapping": {
            "payment.updated": {"event_type": "PAYIN.PAYMENT_UPDATED", "direction": "PAYIN"},
            "payout.updated": {"event_type": "PAYOUT.PAYOUT_UPDATED", "direction": "PAYOUT"},
        },
    }


class PaymentHubTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        for name in await db.list_collection_names():
            await db[name].delete_many({})
        await service.ensure_indexes()
        self.maker = "admin-maker"
        self.checker = "admin-checker"

    async def gateway(self, code="TEST_PRIMARY"):
        row = await service.create_gateway({
            "code": code, "display_name": "Test Primary", "adapter_type": "TEST_FAKE",
            "environment": "SANDBOX", "capabilities": [item.value for item in Capability],
            "non_secret_config": {},
        }, self.maker)
        await service.store_credentials(row["id"], {"webhook_secret": "sandbox-webhook-secret-at-least-32-characters"}, self.maker)
        await service.test_gateway(row["id"], self.maker)
        return await db.payment_gateways.find_one({"id": row["id"]})

    async def activate(self, gateway):
        approval = await service.request_approval("GATEWAY_ACTIVATION", "PAYMENT_GATEWAY", gateway["id"], self.maker, "Enable tested sandbox")
        return await service.approve_activation(gateway["id"], approval["id"], self.checker)

    def test_registry_contract_and_invalid_transition(self):
        self.assertEqual(registry.codes(), ("GENERIC_REST", "TEST_FAKE"))
        self.assertNotIn("MOCK_SANDBOX", registry.codes())
        adapter = registry.create("TEST_FAKE", {}, {"webhook_secret": "x" * 40}, set())
        self.assertIn(Capability.PAYIN, adapter.capabilities)
        with self.assertRaises(GatewayError) as transition:
            require_transition("PAYIN", PayinStatus.FAILED.value, PayinStatus.SUCCEEDED.value)
        self.assertEqual(transition.exception.code, "PAYMENT_INVALID_STATE_TRANSITION")

    async def test_generic_rest_blocks_private_addresses_and_unapproved_hosts(self):
        adapter = GenericRestAdapter(
            {"base_url": "https://sandbox.example.test", "capabilities": [], "endpoints": {}},
            {}, {"sandbox.example.test"},
        )
        private = [(2, 1, 6, "", ("127.0.0.1", 443))]
        with patch("payment_hub.adapters.socket.getaddrinfo", return_value=private):
            with self.assertRaises(GatewayError) as blocked:
                await adapter.validate_config()
        self.assertEqual(blocked.exception.code, "GATEWAY_SSRF_BLOCKED")
        unapproved = GenericRestAdapter({"base_url": "https://sandbox.example.test", "capabilities": [], "endpoints": {}}, {}, {"approved.example"})
        with self.assertRaises(GatewayError) as denied:
            await unapproved.validate_config()
        self.assertEqual(denied.exception.code, "GATEWAY_DOMAIN_NOT_ALLOWED")

    async def test_pinned_hub_request_uses_logical_host_authority(self):
        for hostname, port, expected in (
            ("sandbox.example.test", 8443, b"Host: sandbox.example.test:8443"),
            ("2001:4860:4860::8888", 9443, b"Host: [2001:4860:4860::8888]:9443"),
        ):
            with self.subTest(hostname=hostname, port=port):
                connection = HubPinnedHTTPSConnection(
                    "93.184.216.34", hostname, port, timeout=1,
                )
                connection.putrequest("POST", "/health")
                self.assertIn(expected, connection._buffer)

        config = generic_rest_config()
        config["base_url"] = "https://sandbox.example.test:8443"
        adapter = GenericRestAdapter(
            config,
            {"api_token": "encrypted-store-token", "webhook_secret": "w" * 40},
            {"sandbox.example.test"},
        )
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

        addresses = [(2, 1, 6, "", ("93.184.216.34", 8443))]
        with patch(
            "payment_hub.adapters.socket.getaddrinfo", return_value=addresses,
        ), patch("payment_hub.adapters._PinnedHTTPSConnection", RecordingConnection):
            await adapter._request("health_check", {"probe": True})
        self.assertEqual(
            (captured["hostname"], captured["port"]),
            ("sandbox.example.test", 8443),
        )
        self.assertNotIn("Host", captured["headers"])

    async def test_generic_rest_rejects_sensitive_headers_outside_secret_auth_config(self):
        config = generic_rest_config()
        config["headers"] = {"X-Merchant-Context": "credential-bearing-static-value"}
        adapter = GenericRestAdapter(
            config,
            {"api_token": "encrypted-store-token", "webhook_secret": "w" * 40},
            {"sandbox.example.test"},
        )
        addresses = [(2, 1, 6, "", ("93.184.216.34", 443))]
        with patch("payment_hub.adapters.socket.getaddrinfo", return_value=addresses):
            with self.assertRaises(GatewayError) as denied:
                await adapter.validate_config()
        self.assertEqual(denied.exception.code, "GATEWAY_CONFIG_INVALID")
        with self.assertRaises(GatewayError) as stored:
            await service.create_gateway({
                "code": "STATIC_HEADERS", "display_name": "Unsafe static headers",
                "adapter_type": "GENERIC_REST", "environment": "LIVE",
                "non_secret_config": {"headers": config["headers"]},
            }, self.maker)
        self.assertEqual(stored.exception.code, "GATEWAY_CONFIG_INVALID")
        legacy_dto = service.gateway_dto({
            "id": "legacy", "code": "LEGACY_HEADERS", "non_secret_config": {
                "headers": config["headers"], "timeout_seconds": 10,
            },
        })
        self.assertNotIn("headers", legacy_dto["non_secret_config"])
        self.assertNotIn("credential-bearing-static-value", json.dumps(legacy_dto))

    async def test_generic_rest_requires_explicit_mappings_auth_and_secret_store(self):
        config = generic_rest_config()
        adapter = GenericRestAdapter(
            config, {"api_token": "encrypted-store-token", "webhook_secret": "w" * 40},
            {"sandbox.example.test"},
        )
        addresses = [(2, 1, 6, "", ("93.184.216.34", 443))]
        with patch("payment_hub.adapters.socket.getaddrinfo", return_value=addresses):
            await adapter.validate_config()
        self.assertEqual(adapter._mapped_request("create_payin", {
            "amount_minor": 25000, "currency": "INR", "reference": "PAY-123",
        }), {"amount": 25000, "currency": "INR", "merchant": {"reference": "PAY-123"}})

        missing_mapping = generic_rest_config()
        del missing_mapping["request_mapping"]["create_payin"]["reference"]
        with patch("payment_hub.adapters.socket.getaddrinfo", return_value=addresses):
            with self.assertRaises(GatewayError) as incomplete:
                await GenericRestAdapter(
                    missing_mapping, {"api_token": "token", "webhook_secret": "w" * 40},
                    {"sandbox.example.test"},
                ).validate_config()
        self.assertEqual(incomplete.exception.code, "GATEWAY_CONFIG_INVALID")

        missing_endpoint = generic_rest_config()
        del missing_endpoint["endpoints"]["create_payout"]
        with patch("payment_hub.adapters.socket.getaddrinfo", return_value=addresses):
            with self.assertRaises(GatewayError) as capability:
                await GenericRestAdapter(
                    missing_endpoint, {"api_token": "token", "webhook_secret": "w" * 40},
                    {"sandbox.example.test"},
                ).validate_config()
        self.assertEqual(capability.exception.code, "GATEWAY_CONFIG_INVALID")

    async def test_generic_rest_webhook_replay_signature_and_money_are_fail_closed(self):
        adapter = GenericRestAdapter(
            generic_rest_config(),
            {"api_token": "encrypted-store-token", "webhook_secret": "w" * 40},
            {"sandbox.example.test"},
        )
        body = json.dumps({
            "event": {"id": "evt-1", "type": "payment.updated"},
            "payment": {
                "id": "pay-1", "status": "SUCCEEDED", "amount": 25000,
                "currency": "INR", "reference": "provider-ref-1",
                "payer_email": "private@example.test", "bank_account": "1234567890",
            },
        }, separators=(",", ":")).encode()
        stamp = str(int(time.time()))
        digest = hmac.new(b"w" * 40, stamp.encode() + b"." + body, hashlib.sha256).hexdigest()
        parsed = adapter.parse_webhook({
            "X-Payment-Timestamp": stamp, "X-Payment-Signature": f"sha256={digest}",
        }, body)
        self.assertEqual((parsed.amount_minor, parsed.currency, parsed.provider_reference), (25000, "INR", "provider-ref-1"))
        self.assertEqual((parsed.event_type, parsed.direction), ("PAYIN.PAYMENT_UPDATED", "PAYIN"))
        self.assertEqual(set(parsed.sanitized_payload), {
            "event_id", "event_type", "direction", "object_id", "status",
            "amount_minor", "currency", "provider_reference",
        })
        self.assertNotIn("private@example.test", json.dumps(parsed.sanitized_payload))
        unsupported_body = body.replace(b'payment.updated', b'payment.unknown')
        unsupported_digest = hmac.new(
            b"w" * 40, stamp.encode() + b"." + unsupported_body, hashlib.sha256,
        ).hexdigest()
        with self.assertRaises(GatewayError) as unsupported:
            adapter.parse_webhook({
                "X-Payment-Timestamp": stamp,
                "X-Payment-Signature": f"sha256={unsupported_digest}",
            }, unsupported_body)
        self.assertEqual(unsupported.exception.code, "WEBHOOK_EVENT_UNSUPPORTED")
        wrong_direction_body = body.replace(b'payment.updated', b'payout.updated')
        wrong_direction_digest = hmac.new(
            b"w" * 40, stamp.encode() + b"." + wrong_direction_body, hashlib.sha256,
        ).hexdigest()
        with self.assertRaises(GatewayError) as wrong_direction:
            adapter.parse_webhook({
                "X-Payment-Timestamp": stamp,
                "X-Payment-Signature": f"sha256={wrong_direction_digest}",
            }, wrong_direction_body)
        self.assertEqual(wrong_direction.exception.code, "WEBHOOK_STATUS_DIRECTION_MISMATCH")
        with self.assertRaises(GatewayError) as tampered:
            adapter.parse_webhook({
                "X-Payment-Timestamp": stamp, "X-Payment-Signature": "sha256=" + "0" * 64,
            }, body)
        self.assertEqual(tampered.exception.code, "WEBHOOK_SIGNATURE_INVALID")
        stale = str(int(time.time()) - 301)
        stale_digest = hmac.new(b"w" * 40, stale.encode() + b"." + body, hashlib.sha256).hexdigest()
        with self.assertRaises(GatewayError) as replay:
            adapter.parse_webhook({
                "X-Payment-Timestamp": stale, "X-Payment-Signature": f"sha256={stale_digest}",
            }, body)
        self.assertEqual(replay.exception.code, "WEBHOOK_REPLAY_REJECTED")

    def test_generic_rest_rejects_unsafe_checkout_and_unbound_payout_status(self):
        adapter = GenericRestAdapter(
            generic_rest_config(),
            {"api_token": "encrypted-store-token", "webhook_secret": "w" * 40},
            {"sandbox.example.test"},
        )
        accepted = adapter._result("create_payin", {"data": {
            "id": "pay-1", "status": "PENDING",
            "checkout_url": "https://checkout.sandbox.example.test/session/1?token=opaque",
        }})
        self.assertEqual(accepted.checkout_url, "https://checkout.sandbox.example.test/session/1?token=opaque")
        for unsafe_url in (
            "http://checkout.sandbox.example.test/checkout",
            "https://sub.checkout.sandbox.example.test/checkout",
            "https://sandbox.example.test/checkout",
            "https://user:password@checkout.sandbox.example.test/checkout",
            "https://checkout.sandbox.example.test/checkout#fragment",
            "https://checkout.sandbox.example.test:444/checkout",
        ):
            with self.subTest(unsafe_url=unsafe_url):
                with self.assertRaises(GatewayError) as checkout:
                    adapter._result("create_payin", {"data": {
                        "id": "pay-1", "status": "PENDING", "checkout_url": unsafe_url,
                    }})
                self.assertEqual(checkout.exception.code, "PROVIDER_RESPONSE_INVALID")
        with self.assertRaises(GatewayError) as binding:
            adapter._result("get_payout_status", {"data": {
                "id": "payout-1", "status": "PAID", "amount": 25000,
                "currency": "INR", "reference": "provider-ref",
                "withdrawal_id": "wd-1", "idempotency_key": "idem-1",
            }})
        self.assertEqual(binding.exception.code, "PROVIDER_RESPONSE_INVALID")

    async def test_public_webhook_url_is_sanitized_and_unique_per_gateway(self):
        original = os.environ.get("PAYMENT_WEBHOOK_PUBLIC_BASE_URL")
        try:
            os.environ["PAYMENT_WEBHOOK_PUBLIC_BASE_URL"] = "https://api.chakri.casino"
            first = await service.create_gateway({
                "code": "PROVIDER_ONE", "display_name": "Provider One",
                "adapter_type": "GENERIC_REST", "environment": "LIVE",
            }, self.maker)
            second = await service.create_gateway({
                "code": "PROVIDER_TWO", "display_name": "Provider Two",
                "adapter_type": "GENERIC_REST", "environment": "LIVE",
            }, self.maker)
            self.assertEqual(
                service.gateway_dto(first)["webhook_url"],
                "https://api.chakri.casino/api/webhooks/payments/PROVIDER_ONE",
            )
            self.assertNotEqual(
                service.gateway_dto(first)["webhook_url"], service.gateway_dto(second)["webhook_url"],
            )
            with patch.dict(os.environ, {"PAYMENTS_V2_ENABLED": "false"}):
                self.assertIsNone(service.feature_status()["webhook_base_url"])
                self.assertIsNone(service.gateway_dto(first)["webhook_url"])
            os.environ["PAYMENT_WEBHOOK_PUBLIC_BASE_URL"] = "http://127.0.0.1:8000/path"
            self.assertIsNone(service.feature_status()["webhook_base_url"])
            self.assertIsNone(service.gateway_dto(first)["webhook_url"])
        finally:
            if original is None:
                os.environ.pop("PAYMENT_WEBHOOK_PUBLIC_BASE_URL", None)
            else:
                os.environ["PAYMENT_WEBHOOK_PUBLIC_BASE_URL"] = original

    async def test_secrets_are_encrypted_write_only_and_rotation_archives_old_version(self):
        gateway = await self.gateway()
        first = await db.payment_gateway_secrets.find_one({"gateway_id": gateway["id"], "status": "ACTIVE"})
        self.assertNotIn("sandbox-webhook", first["ciphertext"])
        self.assertNotIn("ciphertext", service.gateway_dto(await db.payment_gateways.find_one({"id": gateway["id"]})))
        await service.store_credentials(gateway["id"], {"webhook_secret": "replacement-webhook-secret-at-least-32-chars"}, self.checker)
        self.assertEqual(await db.payment_gateway_secrets.count_documents({"gateway_id": gateway["id"], "status": "ACTIVE"}), 1)
        self.assertEqual(await db.payment_gateway_secrets.count_documents({"gateway_id": gateway["id"], "status": "ROTATED"}), 1)

    async def test_crm_round_trips_safe_signature_metadata_without_secret_values(self):
        config = generic_rest_config()
        row = await service.create_gateway({
            "code": "SIGNED_PROVIDER", "display_name": "Signed Provider",
            "adapter_type": "GENERIC_REST", "environment": "LIVE",
            "base_url": config.pop("base_url"), "capabilities": config.pop("capabilities"),
            "non_secret_config": config,
        }, self.maker)
        dto = service.gateway_dto(row)
        self.assertEqual(dto["non_secret_config"]["webhook"]["signature_header"], "X-Payment-Signature")
        self.assertEqual(dto["non_secret_config"]["webhook"]["credential_key"], "webhook_secret")
        self.assertNotIn("encrypted-store-token", json.dumps(dto, default=str))
        with self.assertRaises(GatewayError) as embedded:
            await service.create_gateway({
                "code": "UNSAFE_PROVIDER", "display_name": "Unsafe Provider",
                "adapter_type": "GENERIC_REST", "environment": "LIVE",
                "non_secret_config": {"api_key": "must-not-be-stored"},
            }, self.maker)
        self.assertEqual(embedded.exception.code, "GATEWAY_CONFIG_INVALID")

    async def test_activation_is_maker_checker_and_live_draft_fails_closed_until_cutover(self):
        gateway = await self.gateway()
        approval = await service.request_approval("GATEWAY_ACTIVATION", "PAYMENT_GATEWAY", gateway["id"], self.maker, "Enable sandbox")
        with self.assertRaises(GatewayError) as same_admin:
            await service.approve_activation(gateway["id"], approval["id"], self.maker)
        self.assertEqual(same_admin.exception.code, "MAKER_CHECKER_REQUIRED")
        active = await service.approve_activation(gateway["id"], approval["id"], self.checker)
        self.assertTrue(active["is_enabled"])
        live = await service.create_gateway({
            "code": "LIVE_DRAFT", "display_name": "Live draft",
            "adapter_type": "GENERIC_REST", "environment": "LIVE",
        }, self.maker)
        self.assertEqual((live["status"], live["is_enabled"]), ("DRAFT", False))
        with self.assertRaises(GatewayError) as live_test:
            await service.test_gateway(live["id"], self.maker)
        self.assertEqual(live_test.exception.code, "PAYMENT_LIVE_MODE_DISABLED")
        await db.payment_gateways.update_one(
            {"id": live["id"]}, {"$set": {"health_status": "HEALTHY"}},
        )
        live_approval = await service.request_approval(
            "GATEWAY_ACTIVATION", "PAYMENT_GATEWAY", live["id"], self.maker,
            "Prepare approved provider for later cutover",
        )
        with self.assertRaises(GatewayError) as live_activation:
            await service.approve_activation(live["id"], live_approval["id"], self.checker)
        self.assertEqual(live_activation.exception.code, "PAYMENT_LIVE_MODE_DISABLED")

        # Even stale database state cannot bypass the runtime live traffic gate.
        await db.payment_gateways.update_one(
            {"id": live["id"]},
            {"$set": {"status": "ACTIVE", "is_enabled": True, "health_status": "HEALTHY"}},
        )
        route = await service.create_route({
            "name": "Stale live route", "direction": "PAYIN", "payment_method": "UPI",
            "currency": "INR", "gateway_id": live["id"], "priority": 1, "weight": 100,
        }, self.maker)
        await db.payment_routes.update_one({"id": route["id"]}, {"$set": {"is_enabled": True}})
        with self.assertRaises(GatewayError) as live_traffic:
            await service.choose_gateway({
                "direction": "PAYIN", "payment_method": "UPI", "currency": "INR",
                "amount_minor": 10000, "subject_type": "USER",
            }, "live-traffic-must-stay-off")
        self.assertEqual(live_traffic.exception.code, "PAYMENT_ROUTE_NOT_FOUND")

    async def test_preview_mode_blocks_gateway_and_route_activation_operations(self):
        gateway = await self.gateway("PREVIEW_GATE")
        route = await service.create_route({
            "name": "Preview route", "direction": "PAYIN", "payment_method": "UPI",
            "currency": "INR", "gateway_id": gateway["id"],
        }, self.maker)
        gateway_approval = await service.request_approval(
            "GATEWAY_ACTIVATION", "PAYMENT_GATEWAY", gateway["id"],
            self.maker, "Prepared before preview gate",
        )
        route_approval = await service.request_approval(
            "PAYMENT_ROUTE_ACTIVATION", "PAYMENT_ROUTE", route["id"],
            self.maker, "Prepared before preview gate",
        )

        with patch.dict(os.environ, {"PAYMENTS_V2_ENABLED": "false"}):
            for operation in (
                service.request_approval(
                    "GATEWAY_ACTIVATION", "PAYMENT_GATEWAY", gateway["id"],
                    self.maker, "Must remain unavailable",
                ),
                service.request_approval(
                    "PAYMENT_ROUTE_ACTIVATION", "PAYMENT_ROUTE", route["id"],
                    self.maker, "Must remain unavailable",
                ),
                service.approve_activation(gateway["id"], gateway_approval["id"], self.checker),
                service.approve_route_activation(route["id"], route_approval["id"], self.checker),
            ):
                with self.assertRaises(GatewayError) as disabled:
                    await operation
                self.assertEqual(disabled.exception.code, "PAYMENTS_V2_DISABLED")

        self.assertFalse((await db.payment_gateways.find_one({"id": gateway["id"]}))["is_enabled"])
        self.assertFalse((await db.payment_routes.find_one({"id": route["id"]}))["is_enabled"])

    async def test_active_credentials_are_locked_and_rotation_requires_fresh_approval(self):
        active = await self.activate(await self.gateway("ROTATION_LOCK"))
        before = await db.payment_gateways.find_one({"id": active["id"]})
        with self.assertRaises(GatewayError) as locked:
            await service.store_credentials(
                active["id"],
                {"webhook_secret": "active-rotation-must-not-be-written-123456"},
                self.checker,
            )
        self.assertEqual(locked.exception.code, "GATEWAY_ACTIVE_CREDENTIALS_LOCKED")
        unchanged = await db.payment_gateways.find_one({"id": active["id"]})
        self.assertEqual(unchanged["version"], before["version"])
        self.assertEqual(unchanged["credential_epoch"], before["credential_epoch"])

        await service.disable_gateway(active["id"], self.checker, "Rotate credentials safely")
        stale_approval = await service.request_approval(
            "GATEWAY_ACTIVATION", "PAYMENT_GATEWAY", active["id"],
            self.maker, "Approval before rotation",
        )
        await service.store_credentials(
            active["id"],
            {"webhook_secret": "disabled-rotation-requires-reapproval-123456"},
            self.checker,
        )
        rotated_gateway = await db.payment_gateways.find_one({"id": active["id"]})
        self.assertNotIn("credential_rotation_id", rotated_gateway)
        self.assertEqual(
            await db.payment_gateway_secrets.count_documents({
                "gateway_id": active["id"], "status": "STAGED",
            }),
            0,
        )
        self.assertEqual(
            await db.payment_gateway_secrets.count_documents({
                "gateway_id": active["id"],
                "secret_key_name": "webhook_secret", "status": "ACTIVE",
            }),
            1,
        )
        with self.assertRaises(GatewayError) as expired:
            await service.approve_activation(active["id"], stale_approval["id"], self.checker)
        self.assertEqual(expired.exception.code, "APPROVAL_NOT_AVAILABLE")

        fresh_approval = await service.request_approval(
            "GATEWAY_ACTIVATION", "PAYMENT_GATEWAY", active["id"],
            self.maker, "Approve the rotated credential set",
        )
        with self.assertRaises(GatewayError) as not_tested:
            await service.approve_activation(active["id"], fresh_approval["id"], self.checker)
        self.assertEqual(not_tested.exception.code, "GATEWAY_NOT_HEALTHY")
        await service.test_gateway(active["id"], self.maker)
        reactivated = await service.approve_activation(active["id"], fresh_approval["id"], self.checker)
        self.assertTrue(reactivated["is_enabled"])

    async def test_failed_secret_publication_leaves_gateway_locked_and_untestable(self):
        gateway = await self.gateway("ROTATION_FAILURE")
        before = await db.payment_gateways.find_one({"id": gateway["id"]})
        original_encrypt = service._encrypt
        calls = 0

        def fail_during_staging(*args, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise RuntimeError("simulated secret publication failure")
            return original_encrypt(*args, **kwargs)

        with patch.object(service, "_encrypt", side_effect=fail_during_staging):
            with self.assertRaises(GatewayError) as failed:
                await service.store_credentials(
                    gateway["id"],
                    {
                        "api_key": "first-staged-secret-at-least-32-characters",
                        "webhook_secret": "failed-rotation-secret-at-least-32-characters",
                    },
                    self.checker,
                )
        self.assertEqual(
            failed.exception.code, "GATEWAY_CREDENTIAL_ROTATION_INCOMPLETE",
        )

        locked = await db.payment_gateways.find_one({"id": gateway["id"]})
        self.assertEqual(locked["credential_rotation_status"], "FAILED")
        self.assertTrue(locked.get("credential_rotation_id"))
        self.assertEqual(locked["version"], before["version"])
        self.assertEqual(locked["credential_epoch"], before["credential_epoch"])
        self.assertEqual(locked["health_status"], "UNKNOWN")

        with self.assertRaises(GatewayError) as secret_read:
            await service._credentials(gateway["id"])
        self.assertEqual(
            secret_read.exception.code, "GATEWAY_CREDENTIAL_ROTATION_IN_PROGRESS",
        )
        with self.assertRaises(GatewayError) as health:
            await service.test_gateway(gateway["id"], self.maker)
        self.assertEqual(
            health.exception.code, "GATEWAY_CREDENTIAL_ROTATION_IN_PROGRESS",
        )
        with self.assertRaises(GatewayError) as approval:
            await service.request_approval(
                "GATEWAY_ACTIVATION", "PAYMENT_GATEWAY", gateway["id"],
                self.maker, "Must remain locked",
            )
        self.assertEqual(
            approval.exception.code, "GATEWAY_CREDENTIAL_ROTATION_IN_PROGRESS",
        )

    async def test_gateway_config_and_secret_changes_invalidate_health_and_activation_approval(self):
        gateway = await self.gateway("BOUND_GATEWAY")
        original_version = gateway["version"]
        original_epoch = gateway["credential_epoch"]
        self.assertEqual(gateway["health_checked_version"], original_version)
        self.assertEqual(gateway["health_checked_credential_epoch"], original_epoch)

        config_approval = await service.request_approval(
            "GATEWAY_ACTIVATION", "PAYMENT_GATEWAY", gateway["id"],
            self.maker, "Activate this exact tested configuration",
        )
        self.assertEqual(config_approval["target_version"], original_version)
        self.assertEqual(config_approval["target_credential_epoch"], original_epoch)
        self.assertEqual(config_approval["target_config_hash"], gateway["health_checked_config_hash"])

        changed = await service.update_gateway(
            gateway["id"], {"display_name": "Changed Provider"},
            self.maker, expected_version=original_version,
        )
        self.assertEqual(changed["health_status"], "UNKNOWN")
        self.assertNotIn("health_checked_version", changed)
        expired = await db.approval_requests.find_one({"id": config_approval["id"]})
        self.assertEqual(expired["status"], "EXPIRED")
        self.assertEqual(expired["expiration_reason"], "GATEWAY_CONFIGURATION_CHANGED")

        await service.test_gateway(gateway["id"], self.maker)
        retested = await db.payment_gateways.find_one({"id": gateway["id"]})
        secret_approval = await service.request_approval(
            "GATEWAY_ACTIVATION", "PAYMENT_GATEWAY", gateway["id"],
            self.maker, "Activate after retest",
        )
        await service.store_credentials(
            gateway["id"],
            {"webhook_secret": "third-webhook-secret-at-least-32-characters"},
            self.checker,
        )
        rotated = await db.payment_gateways.find_one({"id": gateway["id"]})
        self.assertEqual(rotated["version"], retested["version"] + 1)
        self.assertEqual(rotated["credential_epoch"], retested["credential_epoch"] + 1)
        self.assertEqual(rotated["health_status"], "UNKNOWN")
        self.assertNotIn("health_checked_credential_epoch", rotated)
        expired = await db.approval_requests.find_one({"id": secret_approval["id"]})
        self.assertEqual(expired["status"], "EXPIRED")
        self.assertEqual(expired["expiration_reason"], "GATEWAY_CREDENTIALS_CHANGED")

    async def test_gateway_activation_rejects_a_stale_binding_even_if_health_was_not_reset(self):
        gateway = await self.gateway("STALE_BINDING")
        approval = await service.request_approval(
            "GATEWAY_ACTIVATION", "PAYMENT_GATEWAY", gateway["id"],
            self.maker, "Activate tested version only",
        )

        # Simulate a concurrent/legacy writer that increments the row version but
        # neglects to clear the old health fields. Approval must still fail closed.
        await db.payment_gateways.update_one(
            {"id": gateway["id"], "version": gateway["version"]},
            {"$set": {"display_name": "Changed concurrently"}, "$inc": {"version": 1}},
        )
        with self.assertRaises(GatewayError) as stale:
            await service.approve_activation(gateway["id"], approval["id"], self.checker)
        self.assertEqual(stale.exception.code, "GATEWAY_APPROVAL_STALE")
        stored = await db.approval_requests.find_one({"id": approval["id"]})
        self.assertEqual(stored["status"], "EXPIRED")
        self.assertEqual(stored["expiration_reason"], "GATEWAY_BINDING_CHANGED")

    async def payment_order(
        self, gateway, provider_payment_id, *, amount_minor=10000,
        direction="PAYIN", status="PENDING", provider_reference=None,
    ):
        row = {
            "id": f"order-{provider_payment_id}", "gateway_id": gateway["id"],
            "public_reference": f"TEST-{provider_payment_id}",
            "operation_scope": direction, "idempotency_key": f"idem-{provider_payment_id}",
            "provider_payment_id": provider_payment_id, "amount_minor": amount_minor,
            "currency": "INR", "direction": direction, "normalized_status": status,
            "provider_reference": provider_reference, "row_version": 1,
        }
        await db.payment_orders_v2.insert_one(row)
        return row

    async def test_route_selection_is_deterministic_and_records_exclusions(self):
        first = await self.activate(await self.gateway("TEST_FIRST"))
        second = await self.activate(await self.gateway("TEST_SECOND"))
        for gateway in (first, second):
            route = await service.create_route({"name": gateway["code"], "direction": "PAYIN", "payment_method": "UPI", "currency": "INR", "gateway_id": gateway["id"], "priority": 10, "weight": 100}, self.maker)
            await db.payment_routes.update_one({"id": route["id"]}, {"$set": {"is_enabled": True, "approved_by_admin_id": self.checker}})
        request = {"direction": "PAYIN", "payment_method": "UPI", "currency": "INR", "amount_minor": 25000, "subject_type": "USER"}
        one = await service.choose_gateway(request, "stable-correlation-id")
        two = await service.choose_gateway(request, "stable-correlation-id")
        self.assertEqual(one["selected_gateway_id"], two["selected_gateway_id"])
        self.assertEqual(await db.payment_routing_decisions.count_documents({}), 2)
        self.assertNotEqual(first["id"], second["id"])

    async def test_route_activation_requires_a_different_admin_and_an_active_gateway(self):
        gateway = await self.activate(await self.gateway())
        route = await service.create_route({
            "name": "Approved UPI", "direction": "PAYIN", "payment_method": "UPI",
            "currency": "INR", "gateway_id": gateway["id"], "priority": 10, "weight": 100,
        }, self.maker)
        approval = await service.request_approval(
            "PAYMENT_ROUTE_ACTIVATION", "PAYMENT_ROUTE", route["id"], self.maker, "Enable tested route",
        )
        with self.assertRaises(GatewayError) as same_admin:
            await service.approve_route_activation(route["id"], approval["id"], self.maker)
        self.assertEqual(same_admin.exception.code, "MAKER_CHECKER_REQUIRED")
        active = await service.approve_route_activation(route["id"], approval["id"], self.checker)
        self.assertTrue(active["is_enabled"])
        self.assertEqual(active["approved_by_admin_id"], self.checker)

    async def test_duplicate_webhook_cannot_repeat_transition(self):
        gateway = await self.activate(await self.gateway())
        order = await self.payment_order(gateway, "provider-payment-1")
        payload = json.dumps({
            "id": "evt-1", "type": "payment.updated",
            "object_id": order["provider_payment_id"], "status": "SUCCEEDED",
            "amount_minor": 10000, "currency": "INR",
            "provider_reference": "provider-ref-1",
            "payer_email": "must-not-be-persisted@example.test",
            "bank_account": "1234567890",
        }, separators=(",", ":")).encode()
        adapter = DeterministicTestGatewayAdapter({}, {"webhook_secret": "sandbox-webhook-secret-at-least-32-characters"})
        headers = adapter.sign_webhook(payload, int(time.time()))
        first = await service.process_webhook(gateway["code"], headers, payload)
        second = await service.process_webhook(gateway["code"], headers, payload)
        self.assertFalse(first["duplicate"])
        self.assertTrue(second["duplicate"])
        self.assertEqual(await db.webhook_events_v2.count_documents({}), 1)
        self.assertEqual((await db.payment_orders_v2.find_one({"id": order["id"]}))["normalized_status"], "SUCCEEDED")
        event = await db.webhook_events_v2.find_one({"provider_event_id": "evt-1"})
        self.assertEqual(set(event["sanitized_payload"]), {
            "event_id", "event_type", "direction", "object_id", "status",
            "amount_minor", "currency", "provider_reference",
        })
        self.assertNotIn("must-not-be-persisted", json.dumps(event["sanitized_payload"]))

    async def test_retry_pending_duplicate_is_atomically_reprocessed_then_terminally_idempotent(self):
        gateway = await self.activate(await self.gateway())
        payload = json.dumps({
            "id": "evt-retry", "type": "payment.updated", "object_id": "provider-late",
            "status": "SUCCEEDED", "amount_minor": 10000, "currency": "INR",
            "provider_reference": "late-provider-ref",
        }, separators=(",", ":")).encode()
        adapter = DeterministicTestGatewayAdapter(
            {}, {"webhook_secret": "sandbox-webhook-secret-at-least-32-characters"},
        )
        headers = adapter.sign_webhook(payload, int(time.time()))
        with self.assertRaises(GatewayError) as missing:
            await service.process_webhook(gateway["code"], headers, payload)
        self.assertEqual(missing.exception.code, "PAYMENT_NOT_FOUND")
        pending = await db.webhook_events_v2.find_one({"provider_event_id": "evt-retry"})
        self.assertEqual((pending["processing_status"], pending["processing_attempts"]), ("RETRY_PENDING", 1))

        order = await self.payment_order(gateway, "provider-late")
        with self.assertRaises(GatewayError) as too_early:
            await service.process_webhook(gateway["code"], headers, payload)
        self.assertEqual(too_early.exception.code, "WEBHOOK_EVENT_BUSY")
        waiting = await db.webhook_events_v2.find_one({"provider_event_id": "evt-retry"})
        self.assertEqual((waiting["processing_status"], waiting["processing_attempts"]), ("RETRY_PENDING", 1))
        self.assertEqual((await db.payment_orders_v2.find_one({"id": order["id"]}))["row_version"], 1)
        await db.webhook_events_v2.update_one(
            {"id": waiting["id"]},
            {"$set": {"next_retry_at": service.utcnow() - timedelta(seconds=1)}},
        )
        outcomes = await asyncio.gather(
            service.process_webhook(gateway["code"], headers, payload),
            service.process_webhook(gateway["code"], headers, payload),
            return_exceptions=True,
        )
        applied = [item for item in outcomes if isinstance(item, dict) and not item.get("duplicate")]
        self.assertEqual(len(applied), 1)
        for outcome in outcomes:
            if isinstance(outcome, GatewayError):
                self.assertEqual(outcome.code, "WEBHOOK_EVENT_BUSY")
            elif isinstance(outcome, dict) and outcome is not applied[0]:
                self.assertTrue(outcome["duplicate"])
        settled = await db.webhook_events_v2.find_one({"provider_event_id": "evt-retry"})
        self.assertEqual((settled["processing_status"], settled["processing_attempts"]), ("PROCESSED", 2))
        self.assertEqual((await db.payment_orders_v2.find_one({"id": order["id"]}))["row_version"], 2)
        terminal = await service.process_webhook(gateway["code"], headers, payload)
        self.assertTrue(terminal["duplicate"])
        self.assertEqual(terminal["processing_status"], "PROCESSED")

    async def test_stale_processing_webhook_lease_is_atomically_reclaimed(self):
        gateway = await self.activate(await self.gateway())
        order = await self.payment_order(gateway, "provider-stale-claim")
        payload = json.dumps({
            "id": "evt-stale-claim", "type": "payment.updated",
            "object_id": order["provider_payment_id"], "status": "SUCCEEDED",
            "amount_minor": 10000, "currency": "INR",
            "provider_reference": "provider-ref-1",
        }, separators=(",", ":")).encode()
        await db.webhook_events_v2.insert_one({
            "id": "stale-event-row",
            "gateway_id": gateway["id"],
            "provider_event_id": "evt-stale-claim",
            "body_hash": hashlib.sha256(payload).hexdigest(),
            "processing_status": "PROCESSING",
            "processing_started_at": service.utcnow() - timedelta(
                seconds=service.WEBHOOK_PROCESSING_LEASE_SECONDS + 1,
            ),
            "processing_claim_id": "abandoned-worker",
            "processing_attempts": 1,
        })
        adapter = DeterministicTestGatewayAdapter(
            {}, {"webhook_secret": "sandbox-webhook-secret-at-least-32-characters"},
        )

        processed = await service.process_webhook(
            gateway["code"], adapter.sign_webhook(payload), payload,
        )

        self.assertFalse(processed["duplicate"])
        event = await db.webhook_events_v2.find_one({"id": "stale-event-row"})
        self.assertEqual((event["processing_status"], event["processing_attempts"]), ("PROCESSED", 2))
        self.assertIsNone(event["processing_started_at"])
        self.assertIsNone(event["processing_claim_id"])
        self.assertEqual(
            (await db.payment_orders_v2.find_one({"id": order["id"]}))["normalized_status"],
            "SUCCEEDED",
        )

    async def test_fresh_processing_webhook_lease_cannot_be_stolen(self):
        gateway = await self.activate(await self.gateway())
        order = await self.payment_order(gateway, "provider-fresh-claim")
        payload = json.dumps({
            "id": "evt-fresh-claim", "type": "payment.updated",
            "object_id": order["provider_payment_id"], "status": "SUCCEEDED",
            "amount_minor": 10000, "currency": "INR",
            "provider_reference": "provider-ref-1",
        }, separators=(",", ":")).encode()
        await db.webhook_events_v2.insert_one({
            "id": "fresh-event-row",
            "gateway_id": gateway["id"],
            "provider_event_id": "evt-fresh-claim",
            "body_hash": hashlib.sha256(payload).hexdigest(),
            "processing_status": "PROCESSING",
            "processing_started_at": service.utcnow(),
            "processing_claim_id": "active-worker",
            "processing_attempts": 1,
        })
        adapter = DeterministicTestGatewayAdapter(
            {}, {"webhook_secret": "sandbox-webhook-secret-at-least-32-characters"},
        )

        with self.assertRaises(GatewayError) as busy:
            await service.process_webhook(
                gateway["code"], adapter.sign_webhook(payload), payload,
            )

        self.assertEqual(busy.exception.code, "WEBHOOK_EVENT_BUSY")
        event = await db.webhook_events_v2.find_one({"id": "fresh-event-row"})
        self.assertEqual((event["processing_status"], event["processing_attempts"]), ("PROCESSING", 1))
        self.assertEqual(event["processing_claim_id"], "active-worker")
        self.assertEqual(
            (await db.payment_orders_v2.find_one({"id": order["id"]}))["normalized_status"],
            "PENDING",
        )

    async def test_webhook_direction_and_provider_reference_are_bound_to_order(self):
        gateway = await self.activate(await self.gateway())
        adapter = DeterministicTestGatewayAdapter(
            {}, {"webhook_secret": "sandbox-webhook-secret-at-least-32-characters"},
        )

        payin = await self.payment_order(
            gateway, "payin-bound", provider_reference="original-reference",
        )
        mismatched_reference = json.dumps({
            "id": "evt-ref-mismatch", "type": "payment.updated",
            "object_id": payin["provider_payment_id"], "status": "SUCCEEDED",
            "amount_minor": 10000, "currency": "INR", "provider_reference": "other-reference",
        }, separators=(",", ":")).encode()
        with self.assertRaises(GatewayError) as reference_error:
            await service.process_webhook(
                gateway["code"], adapter.sign_webhook(mismatched_reference), mismatched_reference,
            )
        self.assertEqual(reference_error.exception.code, "PAYMENT_PROVIDER_REFERENCE_MISMATCH")
        self.assertEqual(
            (await db.payment_orders_v2.find_one({"id": payin["id"]}))["normalized_status"],
            "PENDING",
        )

        payout = await self.payment_order(
            gateway, "payout-bound", direction="PAYOUT", status="PROCESSING",
            provider_reference="payout-reference",
        )
        payout_payload = json.dumps({
            "id": "evt-payout", "type": "payout.updated", "direction": "PAYOUT",
            "object_id": payout["provider_payment_id"], "status": "PAID",
            "amount_minor": 10000, "currency": "INR", "provider_reference": "payout-reference",
        }, separators=(",", ":")).encode()
        result = await service.process_webhook(
            gateway["code"], adapter.sign_webhook(payout_payload), payout_payload,
        )
        self.assertEqual(result["status"], "PAID")

        wrong_direction = await self.payment_order(
            gateway, "wrong-direction", direction="PAYOUT", status="PROCESSING",
        )
        wrong_payload = json.dumps({
            "id": "evt-wrong-direction", "type": "payment.updated",
            "object_id": wrong_direction["provider_payment_id"], "status": "SUCCEEDED",
            "amount_minor": 10000, "currency": "INR", "provider_reference": "wrong-direction-ref",
        }, separators=(",", ":")).encode()
        with self.assertRaises(GatewayError) as direction_error:
            await service.process_webhook(
                gateway["code"], adapter.sign_webhook(wrong_payload), wrong_payload,
            )
        self.assertEqual(direction_error.exception.code, "PAYMENT_DIRECTION_MISMATCH")

        missing_direction = await self.payment_order(gateway, "missing-direction")
        await db.payment_orders_v2.update_one(
            {"id": missing_direction["id"]}, {"$unset": {"direction": ""}},
        )
        missing_direction_payload = json.dumps({
            "id": "evt-missing-direction", "type": "payment.updated",
            "object_id": missing_direction["provider_payment_id"], "status": "SUCCEEDED",
            "amount_minor": 10000, "currency": "INR", "provider_reference": "missing-direction-ref",
        }, separators=(",", ":")).encode()
        with self.assertRaises(GatewayError) as missing_direction_error:
            await service.process_webhook(
                gateway["code"], adapter.sign_webhook(missing_direction_payload),
                missing_direction_payload,
            )
        self.assertEqual(missing_direction_error.exception.code, "PAYMENT_DIRECTION_INVALID")

        wrong_event = await self.payment_order(gateway, "wrong-event")
        wrong_event_payload = json.dumps({
            "id": "evt-wrong-event", "type": "PAYOUT.UNSUPPORTED", "direction": "PAYIN",
            "object_id": wrong_event["provider_payment_id"], "status": "SUCCEEDED",
            "amount_minor": 10000, "currency": "INR", "provider_reference": "wrong-event-ref",
        }, separators=(",", ":")).encode()
        with self.assertRaises(GatewayError) as wrong_event_error:
            await service.process_webhook(
                gateway["code"], adapter.sign_webhook(wrong_event_payload), wrong_event_payload,
            )
        self.assertEqual(wrong_event_error.exception.code, "WEBHOOK_EVENT_DIRECTION_MISMATCH")

    async def test_live_inbound_callback_for_existing_orders_survives_traffic_cutoff(self):
        gateway = await service.create_gateway({
            "code": "LIVE_CALLBACK", "display_name": "Live Callback",
            "adapter_type": "TEST_FAKE", "environment": "LIVE",
            "capabilities": ["PAYIN", "WEBHOOKS"],
        }, self.maker)
        await service.store_credentials(
            gateway["id"],
            {"webhook_secret": "live-webhook-secret-at-least-32-characters"},
            self.maker,
        )
        await db.payment_gateways.update_one(
            {"id": gateway["id"]},
            {"$set": {"status": "ACTIVE", "is_enabled": True, "health_status": "HEALTHY"}},
        )
        gateway = await db.payment_gateways.find_one({"id": gateway["id"]})
        with self.assertRaises(GatewayError) as outbound:
            await service.adapter_for(gateway)
        self.assertEqual(outbound.exception.code, "PAYMENT_LIVE_MODE_DISABLED")

        adapter = DeterministicTestGatewayAdapter(
            {}, {"webhook_secret": "live-webhook-secret-at-least-32-characters"},
        )
        existing = await self.payment_order(gateway, "live-existing")
        payload = json.dumps({
            "id": "evt-live-existing", "type": "payment.updated",
            "object_id": existing["provider_payment_id"], "status": "SUCCEEDED",
            "amount_minor": 10000, "currency": "INR", "provider_reference": "live-reference",
        }, separators=(",", ":")).encode()
        processed = await service.process_webhook(
            gateway["code"], adapter.sign_webhook(payload), payload,
        )
        self.assertEqual(processed["status"], "SUCCEEDED")

        await db.payment_gateways.update_one(
            {"id": gateway["id"]}, {"$set": {"status": "DISABLED", "is_enabled": False}},
        )
        disabled_existing = await self.payment_order(gateway, "live-disabled-existing")
        disabled_payload = json.dumps({
            "id": "evt-live-disabled", "type": "payment.updated",
            "object_id": disabled_existing["provider_payment_id"], "status": "SUCCEEDED",
            "amount_minor": 10000, "currency": "INR", "provider_reference": "disabled-reference",
        }, separators=(",", ":")).encode()
        disabled_result = await service.process_webhook(
            gateway["code"], adapter.sign_webhook(disabled_payload), disabled_payload,
        )
        self.assertEqual(disabled_result["status"], "SUCCEEDED")

        unknown_payload = json.dumps({
            "id": "evt-live-unknown", "type": "payment.updated", "object_id": "not-created",
            "status": "SUCCEEDED", "amount_minor": 10000, "currency": "INR",
            "provider_reference": "unknown-reference",
        }, separators=(",", ":")).encode()
        with self.assertRaises(GatewayError) as unknown:
            await service.process_webhook(
                gateway["code"], adapter.sign_webhook(unknown_payload), unknown_payload,
            )
        self.assertEqual((unknown.exception.code, unknown.exception.status_code), ("PAYMENT_NOT_FOUND", 404))
        self.assertIsNone(await db.webhook_events_v2.find_one({"provider_event_id": "evt-live-unknown"}))

    async def test_mismatched_webhook_is_quarantined_without_mutating_payment(self):
        gateway = await self.activate(await self.gateway())
        order = await self.payment_order(gateway, "provider-payment-mismatch")
        payload = json.dumps({"id": "evt-mismatch", "type": "payment.updated", "object_id": order["provider_payment_id"], "status": "SUCCEEDED", "amount_minor": 9999, "currency": "INR", "provider_reference": "provider-ref-mismatch"}, separators=(",", ":")).encode()
        adapter = DeterministicTestGatewayAdapter({}, {"webhook_secret": "sandbox-webhook-secret-at-least-32-characters"})
        with self.assertRaises(GatewayError) as mismatch:
            await service.process_webhook(gateway["code"], adapter.sign_webhook(payload, int(time.time())), payload)
        self.assertEqual(mismatch.exception.code, "PAYMENT_AMOUNT_MISMATCH")
        event = await db.webhook_events_v2.find_one({"provider_event_id": "evt-mismatch"})
        self.assertEqual(event["processing_status"], "DEAD_LETTER")
        self.assertEqual((await db.payment_orders_v2.find_one({"id": order["id"]}))["normalized_status"], order["normalized_status"])
        duplicate = await service.process_webhook(
            gateway["code"], adapter.sign_webhook(payload, int(time.time())), payload,
        )
        self.assertTrue(duplicate["duplicate"])
        self.assertEqual(duplicate["processing_status"], "DEAD_LETTER")

    async def test_settlement_import_checksum_is_idempotent(self):
        gateway = await self.gateway()
        content = b"provider_id,amount,currency\nabc,10000,INR\n"
        first = await service.import_settlement(gateway["id"], "settlement.csv", content, self.maker)
        second = await service.import_settlement(gateway["id"], "settlement.csv", content, self.maker)
        self.assertFalse(first["duplicate"])
        self.assertTrue(second["duplicate"])
        self.assertEqual(await db.settlement_imports.count_documents({}), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
