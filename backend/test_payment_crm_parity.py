"""CRM operator-parity tests: gateway presentation fields, deposit/withdrawal
and auto-approve toggles, payment platform settings, local deposit agents, and
the composed admin dashboard.

Every control here is stored configuration only. None of these functions can
credit or debit a player wallet, and all of them work with the admin API flag
on while PAYMENTS_V2_ENABLED / REAL_MONEY_ENABLED remain false.
"""
from __future__ import annotations

import base64
import os
import sys
import unittest

from mongomock_motor import AsyncMongoMockClient

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
# Only set env that is stable across the whole test process. Flags such as
# PAYMENTS_V2_ENABLED and the webhook base URL are scoped per-test with
# ``unittest_env`` so this module never fights other payment suites that share
# the interpreter under pytest-xdist loadscope.
os.environ.update({
    "APP_ENV": "test",
    "PAYMENT_GATEWAY_ADMIN_ENABLED": "true",
    "PAYMENT_LIVE_MODE_ALLOWED": "false",
    "PAYMENT_CREDENTIALS_MASTER_KEY": base64.urlsafe_b64encode(b"h" * 32).decode(),
})
os.environ.setdefault("MONGO_URL", "mongodb://127.0.0.1:27017")
os.environ.setdefault("DB_NAME", "crm_parity_test")

from auth_utils import hash_password  # noqa: E402
from payment_hub import service  # noqa: E402
from payment_hub.domain import GatewayError, HealthStatus  # noqa: E402
import routes_admin  # noqa: E402
import routes_payment_hub  # noqa: E402

client = AsyncMongoMockClient()
db = client["crm_parity_test"]
service.db = db
routes_admin.db = db

ADMIN = "admin-crm-actor"


async def _reset():
    # Rebind the shared globals so this suite is isolated from other modules
    # (e.g. test_payment_hub) that also point these at their own mock client.
    service.db = db
    routes_admin.db = db
    for name in await db.list_collection_names():
        await db[name].delete_many({})
    await service.ensure_indexes()


class GatewayCrmFieldTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        await _reset()

    async def _manual_gateway(self):
        return await service.create_gateway({
            "code": "MANUAL_BANK", "display_name": "Manual Bank Transfer",
            "adapter_type": "GENERIC_REST", "environment": "SANDBOX",
            "category": "BANK", "provider_type": "MANUAL",
            "non_secret_config": {"bankName": "Test Bank", "accountNumber": "000123"},
        }, ADMIN)

    async def _automated_gateway(self):
        return await service.create_gateway({
            "code": "AUTO_CARD", "display_name": "Automated Card",
            "adapter_type": "GENERIC_REST", "environment": "SANDBOX",
            "category": "CARD", "provider_type": "AUTOMATED",
            "capabilities": ["PAYIN", "CARD"],
            "non_secret_config": {"apiBaseUrl": "https://api.provider.com"},
        }, ADMIN)

    async def test_dto_exposes_crm_presentation_fields(self):
        row = await self._manual_gateway()
        with unittest_env(PAYMENT_WEBHOOK_PUBLIC_BASE_URL="https://api.chakri.casino"):
            dto = service.gateway_dto(row)
        self.assertEqual(dto["category"], "BANK")
        self.assertEqual(dto["provider_type"], "MANUAL")
        self.assertEqual(dto["mode"], "SANDBOX")
        self.assertFalse(dto["connection_tested"])
        self.assertTrue(dto["configured"])  # manual bank fields are present
        self.assertFalse(dto["deposits_enabled"])
        self.assertFalse(dto["auto_approve_deposits"])
        self.assertEqual(
            dto["webhook_url"],
            "https://api.chakri.casino/api/webhooks/payments/MANUAL_BANK",
        )
        self.assertEqual(
            dto["origin_verification_url"],
            "https://api.chakri.casino/api/webhooks/payments/MANUAL_BANK/origin",
        )
        self.assertEqual(dto["integrationMode"], "MANUAL")
        self.assertFalse(dto["depositEnabled"])
        self.assertTrue(dto["sandboxMode"])
        self.assertEqual(dto["webhookUrl"], dto["webhook_url"])

    async def test_other_category_and_camelcase_payload(self):
        row = await service.create_gateway({
            "code": "OTHER_CASH", "display_name": "Cash Desk",
            "adapter_type": "GENERIC_REST", "environment": "SANDBOX",
            "category": "OTHER", "provider_type": "MANUAL",
        }, ADMIN)
        dto = service.gateway_dto(row)
        self.assertEqual(dto["category"], "OTHER")
        normalized = service.normalize_crm_gateway_payload({
            "input": {
                "depositEnabled": True,
                "withdrawalEnabled": False,
                "sandboxMode": False,
                "countries": ["in", "us"],
                "description": "Walk-in cash",
                "secrets": {"apiSecret": "super-secret", "webhookSecret": "hook"},
            },
            "currentPassword": "ignored-here",
        })
        self.assertTrue(normalized["deposits_enabled"])
        self.assertEqual(normalized["environment"], "LIVE")
        self.assertEqual(normalized["countries"], ["IN", "US"])
        self.assertEqual(normalized["description"], "Walk-in cash")
        self.assertEqual(normalized["_secrets"], {
            "api_secret": "super-secret", "webhook_secret": "hook",
        })
        updated = await service.update_gateway_crm(row["id"], {
            "deposits_enabled": True, "countries": ["IN"], "description": "Walk-in cash",
        }, ADMIN)
        updated_dto = service.gateway_dto(updated)
        self.assertEqual(updated_dto["countries"], ["IN"])
        self.assertEqual(updated_dto["description"], "Walk-in cash")
        self.assertTrue(updated_dto["depositEnabled"])

    async def test_automated_needs_setup_until_configured(self):
        row = await service.create_gateway({
            "code": "AUTO_EMPTY", "display_name": "Empty Automated",
            "adapter_type": "GENERIC_REST", "environment": "SANDBOX",
            "category": "CARD", "provider_type": "AUTOMATED",
        }, ADMIN)
        self.assertFalse(service.gateway_dto(row)["configured"])

    async def test_manual_provider_cannot_auto_approve(self):
        row = await self._manual_gateway()
        await service.update_gateway_crm(row["id"], {"deposits_enabled": True}, ADMIN)
        with self.assertRaises(GatewayError) as ctx:
            await service.update_gateway_crm(row["id"], {"auto_approve_deposits": True}, ADMIN)
        self.assertEqual(ctx.exception.code, "GATEWAY_AUTO_APPROVE_NOT_ALLOWED")

    async def test_auto_approve_requires_test_and_direction_enabled(self):
        row = await self._automated_gateway()
        # No successful connection test yet.
        with self.assertRaises(GatewayError) as untested:
            await service.update_gateway_crm(row["id"], {
                "deposits_enabled": True, "auto_approve_deposits": True,
            }, ADMIN)
        self.assertEqual(untested.exception.code, "GATEWAY_AUTO_APPROVE_NOT_ALLOWED")

        # Simulate a passing connection test.
        await db.payment_gateways.update_one(
            {"id": row["id"]}, {"$set": {"health_status": HealthStatus.HEALTHY.value}},
        )
        # Auto-approve without the deposits toggle is still refused.
        with self.assertRaises(GatewayError) as no_direction:
            await service.update_gateway_crm(row["id"], {"auto_approve_deposits": True}, ADMIN)
        self.assertEqual(no_direction.exception.code, "GATEWAY_AUTO_APPROVE_NOT_ALLOWED")

        enabled = await service.update_gateway_crm(row["id"], {
            "deposits_enabled": True, "auto_approve_deposits": True,
        }, ADMIN)
        dto = service.gateway_dto(enabled)
        self.assertTrue(dto["connection_tested"])
        self.assertTrue(dto["deposits_enabled"])
        self.assertTrue(dto["auto_approve_deposits"])

    async def test_disabling_direction_clears_auto_approve(self):
        row = await self._automated_gateway()
        await db.payment_gateways.update_one(
            {"id": row["id"]}, {"$set": {"health_status": HealthStatus.HEALTHY.value}},
        )
        await service.update_gateway_crm(row["id"], {
            "deposits_enabled": True, "auto_approve_deposits": True,
        }, ADMIN)
        disabled = await service.update_gateway_crm(row["id"], {"deposits_enabled": False}, ADMIN)
        self.assertFalse(service.gateway_dto(disabled)["auto_approve_deposits"])

    async def test_toggles_do_not_require_v2_and_never_touch_wallets(self):
        row = await self._manual_gateway()
        with unittest_env(PAYMENTS_V2_ENABLED="false"):
            updated = await service.update_gateway_crm(row["id"], {
                "deposits_enabled": True, "withdrawals_enabled": True,
            }, ADMIN)
        dto = service.gateway_dto(updated)
        self.assertTrue(dto["deposits_enabled"])
        self.assertTrue(dto["withdrawals_enabled"])
        # No wallet or ledger collection is written by configuration changes.
        self.assertEqual(await db.wallet_accounts.count_documents({}), 0)
        self.assertEqual(await db.chip_transactions.count_documents({}), 0)


class PlatformSettingsTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        await _reset()

    async def test_defaults_then_update_round_trip(self):
        defaults = await service.get_platform_settings()
        self.assertFalse(defaults["deposits_enabled"])
        self.assertFalse(defaults["wallet_to_wallet_enabled"])
        self.assertEqual(defaults["return_pages"]["success_path"], "/play/wallet")
        self.assertEqual(defaults["returnPages"]["successPath"], "/play/wallet")
        self.assertFalse(defaults["localSettings"]["depositsEnabled"])

        updated = await service.update_platform_settings({
            "returnPages": {"successPath": "/wallet/ok", "failurePath": "/wallet/no"},
            "localSettings": {"depositsEnabled": True},
            "walletToWalletEnabled": True,
        }, ADMIN)
        self.assertEqual(updated["return_pages"]["success_path"], "/wallet/ok")
        self.assertTrue(updated["deposits_enabled"])
        self.assertTrue(updated["wallet_to_wallet_enabled"])
        self.assertTrue(updated["localSettings"]["depositsEnabled"])
        self.assertTrue(updated["walletToWalletEnabled"])

        https_ok = await service.update_platform_settings({
            "returnPages": {"successPath": "https://chakri.casino/play/wallet"},
        }, ADMIN)
        self.assertEqual(https_ok["returnPages"]["successPath"], "https://chakri.casino/play/wallet")

        reloaded = await service.get_platform_settings()
        self.assertEqual(reloaded["return_pages"]["failure_path"], "/wallet/no")

    async def test_rejects_insecure_return_url(self):
        with self.assertRaises(GatewayError) as ctx:
            await service.update_platform_settings({
                "return_pages": {"success_path": "http://evil.example/steal"},
            }, ADMIN)
        self.assertEqual(ctx.exception.code, "PAYMENT_SETTINGS_INVALID")


class LocalAgentTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        await _reset()

    async def test_receiving_details_hidden_unless_shown(self):
        hidden = await service.create_local_agent({
            "agent_type": "UPI", "agent_name": "Mumbai UPI Desk",
            "country_code": "IN", "deposit_enabled": True,
            "show_details": False, "details": "upi@bank",
        }, ADMIN)
        self.assertIsNone(hidden["details"])
        self.assertTrue(hidden["details_hidden"])

        shown = await service.create_local_agent({
            "agent_type": "BANK", "agent_name": "Delhi Bank Desk",
            "country_code": "IN", "show_details": True, "details": "ACC-999",
        }, ADMIN)
        self.assertEqual(shown["details"], "ACC-999")
        self.assertFalse(shown["details_hidden"])

        rows = await service.list_local_agents()
        self.assertEqual(len(rows), 2)

    async def test_cash_agent_camelcase_create(self):
        agent = await service.create_local_agent({
            "agentType": "CASH", "agentName": "Goa Collection",
            "countryCode": "IN", "depositEnabled": True,
            "withdrawalEnabled": False, "showDetails": False,
            "details": "Shop 12, Mapusa",
        }, ADMIN)
        self.assertEqual(agent["agent_type"], "CASH")
        self.assertEqual(agent["agentType"], "CASH")
        self.assertEqual(agent["agentName"], "Goa Collection")
        self.assertIsNone(agent["details"])
        self.assertTrue(agent["details_hidden"])
        self.assertFalse(agent["detailsConfigured"])

    async def test_delete_and_validation(self):
        agent = await service.create_local_agent({
            "agent_type": "CARD", "agent_name": "Card Desk", "country_code": "IN",
        }, ADMIN)
        result = await service.delete_local_agent(agent["id"], ADMIN)
        self.assertTrue(result["deleted"])
        self.assertEqual(len(await service.list_local_agents()), 0)
        with self.assertRaises(GatewayError) as missing:
            await service.delete_local_agent("nope", ADMIN)
        self.assertEqual(missing.exception.code, "PAYMENT_LOCAL_AGENT_NOT_FOUND")
        with self.assertRaises(GatewayError) as bad_country:
            await service.create_local_agent({
                "agent_type": "BANK", "agent_name": "Bad", "country_code": "INDIA",
            }, ADMIN)
        self.assertEqual(bad_country.exception.code, "PAYMENT_LOCAL_AGENT_INVALID")


class DashboardTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        await _reset()

    async def test_empty_state_returns_zeroed_sections(self):
        result = await routes_admin.dashboard(admin={"id": ADMIN, "role": "ADMIN"})
        self.assertEqual(result["action_queue"], [])
        self.assertEqual(result["cash_movement"]["deposits"]["amount_paise"], 0)
        self.assertEqual(result["cash_movement"]["net_paise"], 0)
        self.assertEqual(result["recent_transactions"], [])
        self.assertEqual(result["audit_activity"], [])
        self.assertEqual(result["distributors"]["count"], 0)
        self.assertTrue(any(m["label"] == "Active players" for m in result["metrics"]))

    async def test_populated_dashboard_composes_real_sources(self):
        await db.users.insert_many([
            {"id": "u1", "role": "PLAYER", "status": "ACTIVE"},
            {"id": "u2", "role": "PLAYER", "status": "PENDING", "created_at": "2026-08-01T00:00:00+00:00"},
        ])
        await db.deposit_orders.insert_one({
            "id": "d1", "status": "CREDITED", "amount_paise": 500000, "created_at": "2026-08-02T00:00:00+00:00",
        })
        await db.chip_transactions.insert_one({
            "id": "t1", "user_id": "u1", "type": "CREDIT", "kind": "ADJUST",
            "amount": 1000, "balance_after": 1000, "note": "Welcome play chips",
            "created_at": "2026-08-03T00:00:00+00:00",
        })
        await db.distributors.insert_one({"id": "dist1", "name": "North Hub", "is_house": False})
        await db.commission_ledger.insert_one({
            "distributor_id": "dist1", "commission": 250, "ngr": 4000, "turnover": 12000, "status": "ACCRUED",
        })
        await db.financial_audit.insert_one({
            "id": "a1", "action": "WITHDRAWAL_MODE_CHANGED", "target_type": "SETTINGS",
            "target_id": "main", "actor_id": ADMIN, "created_at": "2026-08-04T00:00:00+00:00",
        })

        result = await routes_admin.dashboard(admin={"id": ADMIN, "role": "ADMIN"})
        queue_keys = {item["key"] for item in result["action_queue"]}
        self.assertIn("player_approvals", queue_keys)
        approvals = next(item for item in result["action_queue"] if item["key"] == "player_approvals")
        self.assertEqual(approvals["count"], 1)
        self.assertEqual(approvals["severity"], "critical")
        self.assertEqual(result["cash_movement"]["deposits"]["amount_paise"], 500000)
        self.assertEqual(result["cash_movement"]["net_paise"], 500000)
        self.assertEqual(len(result["recent_transactions"]), 1)
        self.assertEqual(result["distributors"]["count"], 1)
        self.assertEqual(result["distributors"]["top"][0]["commission_chips"], 250)
        self.assertEqual(len(result["audit_activity"]), 1)
        self.assertEqual(result["audit_activity"][0]["event_type"], "WITHDRAWAL_MODE_CHANGED")


class AdminPasswordGuardTests(unittest.IsolatedAsyncioTestCase):
    async def test_password_required_when_secrets_are_present(self):
        admin = {"id": ADMIN, "password_hash": hash_password("Admin-Pass-9")}
        with self.assertRaises(Exception) as missing:
            await routes_payment_hub._require_current_admin_password(admin, None)
        self.assertEqual(missing.exception.status_code, 403)
        with self.assertRaises(Exception) as wrong:
            await routes_payment_hub._require_current_admin_password(admin, "wrong-pass")
        self.assertEqual(wrong.exception.status_code, 401)
        await routes_payment_hub._require_current_admin_password(admin, "Admin-Pass-9")


class _unittest_env:
    def __init__(self, **overrides):
        self.overrides = overrides
        self.previous = {}

    def __enter__(self):
        for key, value in self.overrides.items():
            self.previous[key] = os.environ.get(key)
            os.environ[key] = value
        return self

    def __exit__(self, *exc):
        for key, value in self.previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        return False


def unittest_env(**overrides):
    return _unittest_env(**overrides)


if __name__ == "__main__":
    unittest.main(verbosity=2)
