"""Universal payment hub contract, security and idempotency tests."""
from __future__ import annotations

import asyncio
import base64
import json
import os
import sys
import time
import unittest
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

from payment_hub.adapters import GenericRestAdapter, MockSandboxAdapter  # noqa: E402
from payment_hub.domain import Capability, GatewayError, PayinStatus, require_transition  # noqa: E402
from payment_hub.registry import registry  # noqa: E402
from payment_hub import service  # noqa: E402

service.db = db


class PaymentHubTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        for name in await db.list_collection_names():
            await db[name].delete_many({})
        await service.ensure_indexes()
        self.maker = "admin-maker"
        self.checker = "admin-checker"

    async def gateway(self, code="MOCK_PRIMARY"):
        row = await service.create_gateway({
            "code": code, "display_name": "Mock Primary", "adapter_type": "MOCK_SANDBOX",
            "environment": "SANDBOX", "capabilities": [item.value for item in Capability],
            "non_secret_config": {"scenario": "success", "replay_window_seconds": 300},
        }, self.maker)
        await service.store_credentials(row["id"], {"webhook_secret": "sandbox-webhook-secret-at-least-32-characters"}, self.maker)
        await service.test_gateway(row["id"], self.maker)
        return await db.payment_gateways.find_one({"id": row["id"]})

    async def activate(self, gateway):
        approval = await service.request_approval("GATEWAY_ACTIVATION", "PAYMENT_GATEWAY", gateway["id"], self.maker, "Enable tested sandbox")
        return await service.approve_activation(gateway["id"], approval["id"], self.checker)

    def test_registry_contract_and_invalid_transition(self):
        self.assertEqual(registry.codes(), ("GENERIC_REST", "MOCK_SANDBOX"))
        adapter = registry.create("MOCK_SANDBOX", {"scenario": "success"}, {"webhook_secret": "x" * 40}, set())
        self.assertIn(Capability.PAYIN, adapter.capabilities)
        with self.assertRaises(GatewayError) as transition:
            require_transition("PAYIN", PayinStatus.FAILED.value, PayinStatus.SUCCEEDED.value)
        self.assertEqual(transition.exception.code, "PAYMENT_INVALID_STATE_TRANSITION")

    async def test_generic_rest_blocks_private_addresses_and_unapproved_hosts(self):
        adapter = GenericRestAdapter({"base_url": "https://127.0.0.1", "capabilities": [], "endpoints": {}}, {}, {"127.0.0.1"})
        with self.assertRaises(GatewayError) as blocked:
            await adapter.validate_config()
        self.assertEqual(blocked.exception.code, "GATEWAY_SSRF_BLOCKED")
        unapproved = GenericRestAdapter({"base_url": "https://sandbox.example.test", "capabilities": [], "endpoints": {}}, {}, {"approved.example"})
        with self.assertRaises(GatewayError) as denied:
            await unapproved.validate_config()
        self.assertEqual(denied.exception.code, "GATEWAY_DOMAIN_NOT_ALLOWED")

    async def test_generic_rest_rejects_sensitive_headers_outside_secret_auth_config(self):
        adapter = GenericRestAdapter({
            "base_url": "https://sandbox.example.test", "capabilities": [], "endpoints": {},
            "headers": {"Authorization": "must-not-live-in-non-secret-config"},
        }, {}, {"sandbox.example.test"})
        addresses = [(2, 1, 6, "", ("93.184.216.34", 443))]
        with patch("payment_hub.adapters.socket.getaddrinfo", return_value=addresses):
            with self.assertRaises(GatewayError) as denied:
                await adapter.validate_config()
        self.assertEqual(denied.exception.code, "GATEWAY_CONFIG_INVALID")

    async def test_secrets_are_encrypted_write_only_and_rotation_archives_old_version(self):
        gateway = await self.gateway()
        first = await db.payment_gateway_secrets.find_one({"gateway_id": gateway["id"], "status": "ACTIVE"})
        self.assertNotIn("sandbox-webhook", first["ciphertext"])
        self.assertNotIn("ciphertext", service.gateway_dto(await db.payment_gateways.find_one({"id": gateway["id"]})))
        await service.store_credentials(gateway["id"], {"webhook_secret": "replacement-webhook-secret-at-least-32-chars"}, self.checker)
        self.assertEqual(await db.payment_gateway_secrets.count_documents({"gateway_id": gateway["id"], "status": "ACTIVE"}), 1)
        self.assertEqual(await db.payment_gateway_secrets.count_documents({"gateway_id": gateway["id"], "status": "ROTATED"}), 1)

    async def test_activation_is_maker_checker_and_live_mode_fails_closed(self):
        gateway = await self.gateway()
        approval = await service.request_approval("GATEWAY_ACTIVATION", "PAYMENT_GATEWAY", gateway["id"], self.maker, "Enable sandbox")
        with self.assertRaises(GatewayError) as same_admin:
            await service.approve_activation(gateway["id"], approval["id"], self.maker)
        self.assertEqual(same_admin.exception.code, "MAKER_CHECKER_REQUIRED")
        active = await service.approve_activation(gateway["id"], approval["id"], self.checker)
        self.assertTrue(active["is_enabled"])
        with self.assertRaises(GatewayError) as live:
            await service.create_gateway({"code": "LIVE_FORBIDDEN", "display_name": "Live", "adapter_type": "GENERIC_REST", "environment": "LIVE"}, self.maker)
        self.assertEqual(live.exception.code, "PAYMENT_LIVE_MODE_DISABLED")

    async def test_concurrent_sandbox_creation_is_idempotent(self):
        gateway = await self.gateway()
        results = await asyncio.gather(*[
            service.create_sandbox_payin(gateway["id"], {"amount_minor": 10050, "currency": "INR"}, self.maker, "same-idempotency-key")
            for _ in range(8)
        ])
        self.assertEqual(await db.payment_orders_v2.count_documents({}), 1)
        self.assertEqual(len({row["id"] for row in results}), 1)
        self.assertEqual(results[0]["amount_minor"], 10050)

    async def test_route_selection_is_deterministic_and_records_exclusions(self):
        first = await self.activate(await self.gateway("MOCK_FIRST"))
        second = await self.activate(await self.gateway("MOCK_SECOND"))
        for gateway in (first, second):
            route = await service.create_route({"name": gateway["code"], "direction": "PAYIN", "payment_method": "UPI", "currency": "INR", "gateway_id": gateway["id"], "priority": 10, "weight": 100}, self.maker)
            await db.payment_routes.update_one({"id": route["id"]}, {"$set": {"is_enabled": True, "approved_by_admin_id": self.checker}})
        request = {"direction": "PAYIN", "payment_method": "UPI", "currency": "INR", "amount_minor": 25000, "subject_type": "USER"}
        one = await service.choose_gateway(request, "stable-correlation-id")
        two = await service.choose_gateway(request, "stable-correlation-id")
        self.assertEqual(one["selected_gateway_id"], two["selected_gateway_id"])
        self.assertEqual(await db.payment_routing_decisions.count_documents({}), 2)

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
        order = await service.create_sandbox_payin(gateway["id"], {"amount_minor": 10000, "currency": "INR"}, self.maker, "payin-webhook-idem")
        payload = json.dumps({"id": "evt-1", "type": "payment.updated", "object_id": order["provider_payment_id"], "status": "SUCCEEDED", "amount_minor": 10000, "currency": "INR", "provider_reference": "provider-ref-1"}, separators=(",", ":")).encode()
        adapter = MockSandboxAdapter({"scenario": "success"}, {"webhook_secret": "sandbox-webhook-secret-at-least-32-characters"})
        headers = adapter.sign_webhook(payload, int(time.time()))
        first = await service.process_webhook(gateway["code"], headers, payload)
        second = await service.process_webhook(gateway["code"], headers, payload)
        self.assertFalse(first["duplicate"])
        self.assertTrue(second["duplicate"])
        self.assertEqual(await db.webhook_events_v2.count_documents({}), 1)
        self.assertEqual((await db.payment_orders_v2.find_one({"id": order["id"]}))["normalized_status"], "SUCCEEDED")

    async def test_mismatched_webhook_is_quarantined_without_mutating_payment(self):
        gateway = await self.activate(await self.gateway())
        order = await service.create_sandbox_payin(gateway["id"], {"amount_minor": 10000, "currency": "INR"}, self.maker, "payin-mismatch-idem")
        payload = json.dumps({"id": "evt-mismatch", "type": "payment.updated", "object_id": order["provider_payment_id"], "status": "SUCCEEDED", "amount_minor": 9999, "currency": "INR"}, separators=(",", ":")).encode()
        adapter = MockSandboxAdapter({"scenario": "success"}, {"webhook_secret": "sandbox-webhook-secret-at-least-32-characters"})
        with self.assertRaises(GatewayError) as mismatch:
            await service.process_webhook(gateway["code"], adapter.sign_webhook(payload, int(time.time())), payload)
        self.assertEqual(mismatch.exception.code, "PAYMENT_AMOUNT_MISMATCH")
        event = await db.webhook_events_v2.find_one({"provider_event_id": "evt-mismatch"})
        self.assertEqual(event["processing_status"], "DEAD_LETTER")
        self.assertEqual((await db.payment_orders_v2.find_one({"id": order["id"]}))["normalized_status"], order["normalized_status"])

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
