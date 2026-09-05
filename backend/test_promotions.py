"""Focused promotion-domain safety, idempotency and ledger-projection tests."""
from __future__ import annotations

import asyncio
import copy
import os
import sys
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from mongomock_motor import AsyncMongoMockClient


HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("MONGO_URL", "mongodb://127.0.0.1:27017")
os.environ.setdefault("DB_NAME", "promotions_import")

import financial_wallet as finance  # noqa: E402
import game_wallet  # noqa: E402
import ledger  # noqa: E402
import promotions  # noqa: E402
import compliance  # noqa: E402
import routes_payments  # noqa: E402
import routes_promotions  # noqa: E402


def wager_spec(*, jurisdictions=None, multiplier_bps=10_000, reward_type="BONUS_CHIPS"):
    stamp = datetime.now(timezone.utc)
    return {
        "title": "Transparent wager reward",
        "starts_at": stamp - timedelta(hours=1),
        "ends_at": stamp + timedelta(days=10),
        "timezone": "Asia/Kolkata",
        "jurisdictions": jurisdictions or ["IN"],
        "terms_version": "wager-terms-v1",
        "terms_text": (
            "Deposited cash remains withdrawable. Settled qualifying stakes unlock only "
            "the separate promotional reward. Void and refunded stakes do not count."
        ),
        "reward_type": reward_type,
        "reward_chips": 50,
        "reward_paise": 5_000 if reward_type == "CASH_CREDIT" else 0,
        "wager_multiplier_bps": multiplier_bps,
        "duration_hours": 72,
        "settlement_finality_policy_version": "settlement-finality-test-v1",
        "default_contribution_bps": 10_000,
        "game_contribution_bps": {"aviator": 10_000, "blackjack": 5_000},
        "max_qualifying_stake_chips": 1_000,
        "allowed_games": ["aviator", "blackjack"],
        "excluded_games": [],
        "eligible_source_buckets": ["CASH", "BONUS"],
        "forfeit_allowed": True,
        "forfeit_disclosure": "Leaving the mission forfeits only the unearned reward.",
        "per_user_cap_chips": 500,
        "daily_cap_chips": 5_000,
        "campaign_cap_chips": 50_000,
        "incentive_products": ["CASINO"],
        "responsible_gambling_rules": {
            "schema_version": "promotion-rg-v1",
            "account_eligibility": "ACTIVE_VERIFIED_PLAYER",
            "self_exclusion": "BLOCK_NEW_PARTICIPATION",
            "jurisdiction": "REGISTERED_COUNTRY_ALLOWLIST",
            "player_limits": "APPLY_PLATFORM_LIMITS",
            "support_route": "/responsible-play",
        },
    }


def referral_spec():
    stamp = datetime.now(timezone.utc)
    return {
        "title": "Verified referral rewards",
        "starts_at": stamp - timedelta(hours=1),
        "ends_at": stamp + timedelta(days=10),
        "timezone": "Asia/Kolkata",
        "jurisdictions": ["IN"],
        "terms_version": "referral-terms-v1",
        "terms_text": (
            "Fixed rewards require a verified new account and verified first deposit. "
            "Fraud review can reject a task with an appeal reason."
        ),
        "reward_type": "BONUS_CHIPS",
        "reward_chips": 1,
        "reward_paise": 0,
        "claim_threshold_chips": 20,
        "cooling_period_hours": 0,
        "referral_tasks": {
            "REGISTRATION_VERIFIED": {"reward_mode": "FIXED", "reward_chips": 10},
            "FIRST_DEPOSIT_VERIFIED": {"reward_mode": "FIXED", "reward_chips": 10},
        },
        "per_user_cap_chips": 100,
        "daily_cap_chips": 1_000,
        "campaign_cap_chips": 10_000,
        "incentive_products": ["CASINO"],
        "responsible_gambling_rules": {
            "schema_version": "promotion-rg-v1",
            "account_eligibility": "ACTIVE_VERIFIED_PLAYER",
            "self_exclusion": "BLOCK_NEW_PARTICIPATION",
            "jurisdiction": "REGISTERED_COUNTRY_ALLOWLIST",
            "player_limits": "APPLY_PLATFORM_LIMITS",
            "support_route": "/responsible-play",
        },
    }


class PromotionDomainTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.client = AsyncMongoMockClient()
        self.db = self.client["promotion_domain_test"]
        self.old_db = (promotions.db, finance.db, ledger.db, compliance.db)
        promotions.db = self.db
        finance.db = self.db
        ledger.db = self.db
        compliance.db = self.db
        self.old_game_ready = finance.GAME_WALLET_INTEGRATION_READY
        self.old_financial_ready = finance._READY
        self.old_promotion_ready = promotions._PROMOTION_CORE_READY
        self.old_promotion_errors = list(promotions._PROMOTION_CORE_ERRORS)
        finance.GAME_WALLET_INTEGRATION_READY = True
        finance._READY = True
        self.env = patch.dict(os.environ, {
            "APP_ENV": "test",
            "FINANCIAL_ALLOW_NON_TRANSACTIONAL_TESTS": "true",
            "REGULATORY_APPROVED": "true",
            "REAL_MONEY_ENABLED": "true",
            "WAGER_MISSIONS_ENABLED": "true",
            "REFERRAL_REWARDS_ENABLED": "true",
            "PROMOTIONS_GAME_WALLET_INTEGRATED": "true",
            "FINANCIAL_GAME_WALLET_INTEGRATED": "true",
            "WAGER_SETTLEMENT_FINALITY_CERTIFIED": "true",
            "WAGER_SETTLEMENT_FINALITY_POLICY_VERSION": "settlement-finality-test-v1",
            "WAGER_SETTLEMENT_FINALITY_CERTIFIED_POLICY_VERSION": "settlement-finality-test-v1",
            "RANDOMIZED_REWARDS_LEGAL_APPROVED": "false",
            "PROMOTIONS_PUBLIC_APP_ORIGIN": "https://chakri.example.test",
            "REFERRAL_RISK_PEPPER": "test-only-referral-risk-pepper-32-bytes-minimum",
            "CHIPS_PER_INR": "1", "CHIP_RATE_VERSION": "promo-test-v1",
        })
        self.env.start()
        await finance.ensure_financial_indexes()
        readiness = await promotions.prepare_promotion_core()
        self.assertTrue(readiness["ready"], readiness["errors"])
        await self.db.users.insert_many([
            {
                "id": "player-1", "chip_balance": 100, "role": "PLAYER",
                "status": "ACTIVE", "kyc_status": "VERIFIED",
            },
            {
                "id": "player-2", "chip_balance": 0, "role": "PLAYER",
                "status": "ACTIVE", "kyc_status": "VERIFIED",
            },
        ])
        await self.db.wallet_accounts.insert_many([
            {
                "id": "wallet-1", "user_id": "player-1", "available_cash_chips": 100,
                "available_bonus_chips": 0, "held_cash_chips": 0, "version": 1,
                "created_at": datetime.now(timezone.utc), "updated_at": datetime.now(timezone.utc),
            },
            {
                "id": "wallet-2", "user_id": "player-2", "available_cash_chips": 0,
                "available_bonus_chips": 0, "held_cash_chips": 0, "version": 1,
                "created_at": datetime.now(timezone.utc), "updated_at": datetime.now(timezone.utc),
            },
        ])

    async def asyncTearDown(self):
        self.env.stop()
        finance.GAME_WALLET_INTEGRATION_READY = self.old_game_ready
        finance._READY = self.old_financial_ready
        promotions._PROMOTION_CORE_READY = self.old_promotion_ready
        promotions._PROMOTION_CORE_ERRORS = self.old_promotion_errors
        promotions.db, finance.db, ledger.db, compliance.db = self.old_db

    async def activate_campaign(self, campaign_type="WAGER", campaign_id=None, spec=None):
        campaign_id = campaign_id or ("wager-main" if campaign_type == "WAGER" else "referral-main")
        spec = spec or (wager_spec() if campaign_type == "WAGER" else referral_spec())
        await promotions.create_campaign(campaign_id, campaign_type, spec, "admin-maker")
        await promotions.approve_campaign_version(
            campaign_id, 1, "admin-checker", "Reviewed significant terms",
        )
        await promotions.activate_campaign_version(
            campaign_id, 1, "admin-activator", "Approved controlled rollout",
        )
        return campaign_id

    async def activate_mission(self, *, deposit_id="deposit-1", chips=100):
        campaign_id = await self.activate_campaign()
        consent = await self.accept_player_offer(
            campaign_id, chips * 100, "accept-offer-0001",
        )
        mission = await promotions.activate_deposit_mission({
            "id": deposit_id, "user_id": "player-1", "chips": chips,
            "amount_paise": chips * 100,
            "promotion_consent_id": consent["id"],
        })
        return consent, mission

    async def add_cleared_referral_relationship(
        self, referral_id: str, invited_user_id: str,
    ):
        await self.db.users.update_one(
            {"id": invited_user_id},
            {"$setOnInsert": {
                "id": invited_user_id, "chip_balance": 0,
                "role": "PLAYER", "status": "ACTIVE",
            }},
            upsert=True,
        )
        await self.db.player_referrals.insert_one({
            "id": referral_id, "kind": "RELATIONSHIP",
            "invited_user_id": invited_user_id, "inviter_user_id": "player-1",
            "status": "ACTIVE", "fraud_review_status": "CLEARED",
            "risk_signals": {}, "support_path": "/support/referral-review",
            "created_at": datetime.now(timezone.utc),
            "updated_at": datetime.now(timezone.utc),
        })

    async def accept_player_offer(self, campaign_id: str, amount_paise: int, idem: str):
        offers = await promotions.list_offers(
            "IN", deposit_amount_paise=amount_paise, user_id="player-1",
        )
        offer = next(row for row in offers if row["campaign_id"] == campaign_id)
        return await promotions.accept_offer(
            "player-1", campaign_id, jurisdiction="IN", terms_accepted=True,
            idempotency_key=idem, deposit_amount_paise=amount_paise,
            quote_token=offer["quote"]["quote_token"],
        )

    async def complete_authoritative_mission(self, mission, *, prefix="finality"):
        """Record the source ledger stake and settlement used by finality."""
        stamp = datetime.now(timezone.utc)
        amount = int(mission["progress"]["target_chips"])
        allocation = {"cash_chips": amount, "bonus_chips": 0}
        stake = {
            "id": f"{prefix}-stake", "user_id": "player-1", "kind": "STAKE",
            "amount": amount, "game": "aviator", "ref": f"{prefix}-round",
            "funding_allocation": allocation, "created_at": stamp,
        }
        await self.db.chip_transactions.insert_one(stake)
        pending = await promotions.handle_ledger_event(stake)
        marker = {
            "id": f"{prefix}-settled", "user_id": "player-1", "kind": "SETTLEMENT",
            "amount": amount, "game": "aviator", "ref": f"{prefix}-round",
            "source_transaction_id": stake["id"], "settlement_status": "SETTLED",
            "funding_allocation": allocation,
            "created_at": stamp + timedelta(milliseconds=1),
        }
        await self.db.chip_transactions.insert_one(marker)
        settled = await promotions.handle_ledger_event(marker)
        return stake, marker, pending, settled

    async def promote_finality(self, mission_id: str):
        stored = await self.db.wager_missions.find_one({"id": mission_id})
        finality_at = promotions._as_utc(stored["claim_finality_at"], "claim_finality_at")
        future = finality_at + timedelta(seconds=1)
        with patch.object(promotions, "now", return_value=future):
            promoted = await promotions.promote_mission_claim_finality(mission_id)
        return promoted, future

    async def test_flags_fail_closed_and_never_change_deposit_cash(self):
        self.assertTrue(promotions.feature_enabled("WAGER"))
        with patch.dict(os.environ, {"REGULATORY_APPROVED": "false"}):
            self.assertFalse(promotions.feature_enabled("WAGER"))
            result = await promotions.activate_deposit_mission({
                "id": "deposit-disabled", "user_id": "player-1", "chips": 100,
                "promotion_consent_id": "missing-consent",
            })
            self.assertIsNone(result)
        wallet = await self.db.wallet_accounts.find_one({"user_id": "player-1"})
        self.assertEqual(wallet["available_cash_chips"], 100)
        self.assertEqual(wallet["available_bonus_chips"], 0)
        finance._READY = False
        self.assertFalse(promotions.feature_enabled("REFERRAL"))
        finance._READY = True
        with patch.dict(os.environ, {"FINANCIAL_GAME_WALLET_INTEGRATED": "false"}):
            self.assertFalse(promotions.feature_enabled("WAGER"))

    async def test_wager_finality_certification_readiness_fails_closed(self):
        self.assertTrue(promotions.feature_enabled("WAGER"))
        with patch.dict(os.environ, {"WAGER_SETTLEMENT_FINALITY_CERTIFIED": "false"}):
            status = promotions.feature_status("WAGER")
            self.assertFalse(status["enabled"])
            self.assertFalse(status["requirements"]["settlement_finality_certified"])
        with patch.dict(os.environ, {
            "WAGER_SETTLEMENT_FINALITY_POLICY_VERSION": "",
            "WAGER_SETTLEMENT_FINALITY_CERTIFIED_POLICY_VERSION": "",
        }):
            status = promotions.feature_status("WAGER")
            self.assertFalse(status["enabled"])
            self.assertFalse(status["requirements"]["settlement_finality_policy_configured"])
        with patch.dict(os.environ, {
            "WAGER_SETTLEMENT_FINALITY_POLICY_VERSION": "settlement-finality-runtime-v2",
            "WAGER_SETTLEMENT_FINALITY_CERTIFIED_POLICY_VERSION": "settlement-finality-certified-v1",
        }):
            status = promotions.feature_status("WAGER")
            self.assertFalse(status["enabled"])
            self.assertFalse(
                status["requirements"]["settlement_finality_policy_matches_certification"]
            )

    async def test_missing_required_index_keeps_promotion_core_fail_closed(self):
        await self.db.wager_events.drop_index("wager_event_source_unique")
        with patch.object(promotions, "ensure_promotion_indexes", new_callable=AsyncMock):
            status = await promotions.prepare_promotion_core()
        self.assertFalse(status["ready"])
        self.assertTrue(any("wager_event_source_unique" in row for row in status["errors"]))
        self.assertFalse(promotions.feature_enabled("WAGER"))

    async def test_gb_caps_multiplier_and_rejects_mixed_product_incentive(self):
        too_high = wager_spec(jurisdictions=["GB"], multiplier_bps=100_001)
        with self.assertRaises(promotions.PromotionError) as multiplier:
            promotions.validate_campaign_spec("WAGER", too_high)
        self.assertEqual(multiplier.exception.code, "JURISDICTION_POLICY_VIOLATION")

        mixed = wager_spec(jurisdictions=["GB"], multiplier_bps=100_000)
        mixed["incentive_products"] = ["CASINO", "BETTING"]
        with self.assertRaises(promotions.PromotionError) as products:
            promotions.validate_campaign_spec("WAGER", mixed)
        self.assertEqual(products.exception.code, "JURISDICTION_POLICY_VIOLATION")

        unknown_bucket = wager_spec()
        unknown_bucket["eligible_source_buckets"] = ["CASH", "MYSTERY_CREDIT"]
        with self.assertRaises(promotions.PromotionError) as source:
            promotions.validate_campaign_spec("WAGER", unknown_bucket)
        self.assertEqual(source.exception.code, "INVALID_CAMPAIGN")

    async def test_campaign_reward_chips_and_paise_must_be_conversion_consistent(self):
        inconsistent = wager_spec()
        inconsistent["reward_paise"] = 4_999
        with self.assertRaises(promotions.PromotionError) as mismatch:
            promotions.validate_campaign_spec("WAGER", inconsistent)
        self.assertEqual(mismatch.exception.code, "INVALID_CAMPAIGN")

        referral = referral_spec()
        referral["referral_tasks"]["REGISTRATION_VERIFIED"]["reward_paise"] = 999
        with self.assertRaises(promotions.PromotionError) as task_mismatch:
            promotions.validate_campaign_spec("REFERRAL", referral)
        self.assertEqual(task_mismatch.exception.code, "INVALID_CAMPAIGN")

        cash = wager_spec(reward_type="CASH_CREDIT")
        cash["reward_paise"] = 0
        validated = promotions.validate_campaign_spec("WAGER", cash)
        self.assertEqual(validated["reward_paise"], 5_000)
        self.assertEqual(
            validated["reward_rate_snapshot"]["version"],
            finance.conversion_snapshot()["version"],
        )

        for invalid in (True, 50.5, "50"):
            malformed = wager_spec()
            malformed["reward_chips"] = invalid
            with self.assertRaises(promotions.PromotionError) as strict_integer:
                promotions.validate_campaign_spec("WAGER", malformed)
            self.assertEqual(strict_integer.exception.code, "INVALID_CAMPAIGN")

        bonus_with_cash_value = wager_spec()
        bonus_with_cash_value["reward_paise"] = 5_000
        with self.assertRaises(promotions.PromotionError) as bonus_cash_label:
            promotions.validate_campaign_spec("WAGER", bonus_with_cash_value)
        self.assertEqual(bonus_cash_label.exception.code, "INVALID_CAMPAIGN")

        for field, invalid in (
            ("wager_multiplier_bps", True),
            ("duration_hours", 72.5),
            ("claim_finality_hours", "24"),
            ("default_contribution_bps", False),
            ("max_qualifying_stake_chips", 100.9),
            ("per_user_cap_chips", "500"),
            ("daily_cap_chips", 5_000.1),
            ("campaign_cap_chips", True),
            ("forfeit_allowed", "false"),
        ):
            malformed = wager_spec()
            malformed[field] = invalid
            with self.assertRaises(promotions.PromotionError) as strict_campaign:
                promotions.validate_campaign_spec("WAGER", malformed)
            self.assertEqual(strict_campaign.exception.code, "INVALID_CAMPAIGN")

        malformed_game_rate = wager_spec()
        malformed_game_rate["game_contribution_bps"]["aviator"] = 9_999.9
        with self.assertRaises(promotions.PromotionError) as strict_game_rate:
            promotions.validate_campaign_spec("WAGER", malformed_game_rate)
        self.assertEqual(strict_game_rate.exception.code, "INVALID_CAMPAIGN")

        for field, invalid in (
            ("claim_threshold_chips", "20"),
            ("cooling_period_hours", 1.5),
            ("per_user_cap_chips", True),
            ("daily_cap_chips", "1000"),
            ("campaign_cap_chips", 10_000.5),
        ):
            malformed = referral_spec()
            malformed[field] = invalid
            with self.assertRaises(promotions.PromotionError) as strict_referral:
                promotions.validate_campaign_spec("REFERRAL", malformed)
            self.assertEqual(strict_referral.exception.code, "INVALID_CAMPAIGN")

    async def test_campaign_validation_requires_versioned_rg_policy_and_forfeit_disclosure(self):
        missing_policy = wager_spec()
        missing_policy.pop("responsible_gambling_rules")
        with self.assertRaises(promotions.PromotionError) as missing:
            promotions.validate_campaign_spec("WAGER", missing_policy)
        self.assertEqual(missing.exception.code, "INVALID_CAMPAIGN")

        unsupported_policy = referral_spec()
        unsupported_policy["responsible_gambling_rules"]["device_fingerprint_policy"] = "STORE_RAW"
        with self.assertRaises(promotions.PromotionError) as unsupported:
            promotions.validate_campaign_spec("REFERRAL", unsupported_policy)
        self.assertEqual(unsupported.exception.code, "INVALID_CAMPAIGN")

        undisclosed_forfeit = wager_spec()
        undisclosed_forfeit["forfeit_disclosure"] = ""
        with self.assertRaises(promotions.PromotionError) as disclosure:
            promotions.validate_campaign_spec("WAGER", undisclosed_forfeit)
        self.assertEqual(disclosure.exception.code, "INVALID_CAMPAIGN")

        missing_caps = wager_spec()
        missing_caps.pop("campaign_cap_chips")
        with self.assertRaises(promotions.PromotionError) as caps:
            promotions.validate_campaign_spec("WAGER", missing_caps)
        self.assertEqual(caps.exception.code, "INVALID_CAMPAIGN")

        missing_finality_policy = wager_spec()
        missing_finality_policy.pop("settlement_finality_policy_version")
        with self.assertRaises(promotions.PromotionError) as finality_policy:
            promotions.validate_campaign_spec("WAGER", missing_finality_policy)
        self.assertEqual(finality_policy.exception.code, "INVALID_CAMPAIGN")

    async def test_approval_and_activation_revalidate_stored_policy_without_mutation(self):
        await promotions.create_campaign("invalid-at-approval", "WAGER", wager_spec(), "maker-a")
        await self.db.promotion_versions.update_one(
            {"id": "invalid-at-approval:1"},
            {"$set": {"responsible_gambling_rules": {}}},
        )
        with self.assertRaises(promotions.PromotionError) as approval:
            await promotions.approve_campaign_version(
                "invalid-at-approval", 1, "checker-a", "Independent policy review",
            )
        self.assertEqual(approval.exception.code, "CAMPAIGN_VERSION_INVALID")
        approval_row = await self.db.promotion_versions.find_one({"id": "invalid-at-approval:1"})
        self.assertEqual(approval_row["status"], "DRAFT")
        self.assertEqual(await self.db.promotion_audit.count_documents({
            "action": "CAMPAIGN_VERSION_APPROVED", "entity_id": "invalid-at-approval",
        }), 0)

        await promotions.create_campaign("invalid-at-activation", "WAGER", wager_spec(), "maker-b")
        await promotions.approve_campaign_version(
            "invalid-at-activation", 1, "checker-b", "Independent policy review",
        )
        await self.db.promotion_versions.update_one(
            {"id": "invalid-at-activation:1"},
            {"$set": {"forfeit_disclosure": ""}},
        )
        with self.assertRaises(promotions.PromotionError) as activation:
            await promotions.activate_campaign_version(
                "invalid-at-activation", 1, "activator-b", "Controlled launch approval",
            )
        self.assertEqual(activation.exception.code, "CAMPAIGN_VERSION_INVALID")
        activation_row = await self.db.promotion_versions.find_one({"id": "invalid-at-activation:1"})
        campaign = await self.db.promotion_campaigns.find_one({"id": "invalid-at-activation"})
        self.assertEqual(activation_row["status"], "APPROVED")
        self.assertEqual(campaign["status"], "DRAFT")
        self.assertNotIn("active_version", campaign)
        self.assertEqual(await self.db.promotion_audit.count_documents({
            "action": "CAMPAIGN_VERSION_ACTIVATED", "entity_id": "invalid-at-activation",
        }), 0)

    async def test_approval_and_activation_require_exact_certified_finality_policy(self):
        await promotions.create_campaign(
            "finality-policy-approval", "WAGER", wager_spec(), "policy-maker-a",
        )
        with patch.dict(os.environ, {
            "WAGER_SETTLEMENT_FINALITY_POLICY_VERSION": "settlement-finality-v2",
            "WAGER_SETTLEMENT_FINALITY_CERTIFIED_POLICY_VERSION": "settlement-finality-v2",
        }):
            with self.assertRaises(promotions.PromotionError) as approval:
                await promotions.approve_campaign_version(
                    "finality-policy-approval", 1, "policy-checker-a",
                    "Review against rotated finality policy",
                )
        self.assertEqual(
            approval.exception.code, "WAGER_SETTLEMENT_FINALITY_POLICY_MISMATCH",
        )
        draft = await self.db.promotion_versions.find_one({"id": "finality-policy-approval:1"})
        self.assertEqual(draft["status"], "DRAFT")

        await promotions.create_campaign(
            "finality-policy-activation", "WAGER", wager_spec(), "policy-maker-b",
        )
        await promotions.approve_campaign_version(
            "finality-policy-activation", 1, "policy-checker-b",
            "Review against certified finality policy",
        )
        with patch.dict(os.environ, {
            "WAGER_SETTLEMENT_FINALITY_POLICY_VERSION": "settlement-finality-v2",
            "WAGER_SETTLEMENT_FINALITY_CERTIFIED_POLICY_VERSION": "settlement-finality-v2",
        }):
            with self.assertRaises(promotions.PromotionError) as activation:
                await promotions.activate_campaign_version(
                    "finality-policy-activation", 1, "policy-activator-b",
                    "Activation after certificate rotation",
                )
        self.assertEqual(
            activation.exception.code, "WAGER_SETTLEMENT_FINALITY_POLICY_MISMATCH",
        )
        approved = await self.db.promotion_versions.find_one({"id": "finality-policy-activation:1"})
        self.assertEqual(approved["status"], "APPROVED")

    async def test_wager_liability_caps_serialize_activation_and_release_once(self):
        spec = wager_spec()
        spec.update({
            "per_user_cap_chips": 50,
            "daily_cap_chips": 50,
            "campaign_cap_chips": 50,
        })
        await promotions.create_campaign("wager-capped", "WAGER", spec, "cap-maker")
        await promotions.approve_campaign_version(
            "wager-capped", 1, "cap-checker", "Reviewed exact reward limits",
        )
        await promotions.activate_campaign_version(
            "wager-capped", 1, "cap-activator", "Approved capped campaign",
        )
        first_consent = await self.accept_player_offer(
            "wager-capped", 10_000, "capped-consent-one",
        )
        second_consent = await self.accept_player_offer(
            "wager-capped", 10_000, "capped-consent-two",
        )
        results = await asyncio.gather(
            promotions.activate_deposit_mission({
                "id": "capped-deposit-one", "user_id": "player-1", "chips": 100,
                "amount_paise": 10_000, "promotion_consent_id": first_consent["id"],
            }),
            promotions.activate_deposit_mission({
                "id": "capped-deposit-two", "user_id": "player-1", "chips": 100,
                "amount_paise": 10_000, "promotion_consent_id": second_consent["id"],
            }),
            return_exceptions=True,
        )
        missions = [row for row in results if isinstance(row, dict)]
        blocked = [row for row in results if isinstance(row, promotions.PromotionError)]
        self.assertEqual(len(missions), 1)
        self.assertEqual(len(blocked), 1)
        self.assertEqual(blocked[0].code, "WAGER_REWARD_CAP")
        counter = await self.db.wager_reward_counters.find_one({"key": "wager-capped:1"})
        self.assertEqual(counter["approved_chips"], 50)
        self.assertEqual(sum(counter["daily"].values()), 50)
        self.assertEqual(sum(counter["users"].values()), 50)
        self.assertEqual(await self.db.wager_missions.count_documents({
            "campaign_id": "wager-capped",
        }), 1)
        pending = await self.db.promotion_consents.find_one({
            "id": second_consent["id"] if missions[0]["deposit"]["id"] == "capped-deposit-one"
            else first_consent["id"],
        })
        self.assertEqual(pending["status"], "PENDING_DEPOSIT")

        active = missions[0]
        await promotions.forfeit_mission(
            "player-1", active["id"], "Player chose to continue without bonus",
            "forfeit-capped-mission",
        )
        released = await self.db.wager_reward_counters.find_one({"key": "wager-capped:1"})
        self.assertEqual(released["approved_chips"], 0)
        reservation = next(iter(released["reservations"].values()))
        self.assertEqual(reservation["status"], "RELEASED")
        await promotions.forfeit_mission(
            "player-1", active["id"], "Player chose to continue without bonus",
            "forfeit-capped-mission",
        )
        released_again = await self.db.wager_reward_counters.find_one({"key": "wager-capped:1"})
        self.assertEqual(released_again["approved_chips"], 0)

        retried = await promotions.activate_deposit_mission({
            "id": "capped-deposit-two" if active["deposit"]["id"] == "capped-deposit-one"
            else "capped-deposit-one",
            "user_id": "player-1", "chips": 100, "amount_paise": 10_000,
            "promotion_consent_id": pending["id"],
        })
        await self.db.wager_missions.update_one(
            {"id": retried["id"]},
            {"$set": {"deadline_at": datetime.now(timezone.utc) - timedelta(seconds=1)}},
        )
        expired = await promotions.expire_due_mission(retried["id"])
        self.assertEqual(expired["status"], "EXPIRED")
        expired_counter = await self.db.wager_reward_counters.find_one({"key": "wager-capped:1"})
        self.assertEqual(expired_counter["approved_chips"], 0)
        self.assertIsNone(await promotions.expire_due_mission(retried["id"]))
        expired_again = await self.db.wager_reward_counters.find_one({"key": "wager-capped:1"})
        self.assertEqual(expired_again["approved_chips"], 0)

    async def test_campaign_versions_and_accepted_terms_snapshot_are_immutable(self):
        campaign_id = await self.activate_campaign()
        consent = await self.accept_player_offer(campaign_id, 10_000, "accept-snapshot-01")
        original_hash = consent["terms_hash"]
        original_snapshot = dict(consent["campaign_snapshot"])
        second = wager_spec()
        second["terms_version"] = "wager-terms-v2"
        second["terms_text"] += " New players receive clearer eligible-game wording."
        version = await promotions.create_campaign_version(
            campaign_id, second, "admin-maker-2", expected_version=1,
        )
        self.assertEqual(version["version"], 2)
        stored = await self.db.promotion_consents.find_one({"id": consent["id"]})
        self.assertEqual(stored["terms_hash"], original_hash)
        self.assertEqual(stored["campaign_snapshot"], original_snapshot)
        first = await self.db.promotion_versions.find_one({"campaign_id": campaign_id, "version": 1})
        self.assertEqual(first["terms_version"], "wager-terms-v1")

    async def test_exact_consent_is_consumed_once_and_target_uses_integer_math(self):
        consent, mission = await self.activate_mission(chips=101)
        self.assertEqual(mission["progress"]["target_chips"], 101)
        self.assertEqual(
            mission["deadline_at"],
            promotions._as_utc(consent["quoted_deadline_at"], "quoted_deadline_at"),
        )
        self.assertIn("Deposited cash remains withdrawable", consent["campaign_snapshot"]["terms_text"])
        self.assertEqual(
            consent["settlement_finality_policy_version"],
            "settlement-finality-test-v1",
        )
        self.assertEqual(
            consent["campaign_snapshot"]["settlement_finality_policy_version"],
            "settlement-finality-test-v1",
        )
        self.assertEqual(
            mission["claim_finality"]["policy_version"],
            "settlement-finality-test-v1",
        )
        self.assertEqual(mission["status"], "ACTIVE")
        consumed = await self.db.promotion_consents.find_one({"id": consent["id"]})
        self.assertEqual(consumed["status"], "CONSUMED")
        duplicate = await promotions.activate_deposit_mission({
            "id": "deposit-1", "user_id": "player-1", "chips": 101,
            "amount_paise": 10_100, "promotion_consent_id": consent["id"],
        })
        self.assertEqual(duplicate["id"], mission["id"])
        self.assertEqual(await self.db.wager_missions.count_documents({}), 1)

    async def test_offer_quote_is_server_owned_and_activation_rejects_changed_amount(self):
        campaign_id = await self.activate_campaign()
        offers = await promotions.list_offers(
            "IN", deposit_amount_paise=10_000, user_id="player-1",
        )
        self.assertEqual(len(offers), 1)
        self.assertEqual(offers[0]["jurisdiction"], "IN")
        self.assertEqual(offers[0]["quote"]["deposit_chips"], 100)
        self.assertEqual(offers[0]["quote"]["target_chips"], 100)
        self.assertEqual(offers[0]["quote"]["rate_version"], "promo-test-v1")
        self.assertEqual(
            offers[0]["settlement_finality_policy_version"],
            "settlement-finality-test-v1",
        )
        consent = await promotions.accept_offer(
            "player-1", campaign_id, jurisdiction="IN", terms_accepted=True,
            deposit_amount_paise=10_000, idempotency_key="quote-consent-001",
            quote_token=offers[0]["quote"]["quote_token"],
        )
        self.assertEqual(consent["quoted_target_chips"], 100)
        with self.assertRaises(promotions.PromotionError) as mismatch:
            await promotions.activate_deposit_mission({
                "id": "changed-deposit", "user_id": "player-1", "chips": 110,
                "amount_paise": 11_000, "promotion_consent_id": consent["id"],
            })
        self.assertEqual(mismatch.exception.code, "PROMOTION_QUOTE_MISMATCH")
        wallet = await self.db.wallet_accounts.find_one({"user_id": "player-1"})
        self.assertEqual(wallet["available_cash_chips"], 100)

    async def test_policy_rotation_blocks_v1_offer_acceptance_and_deposit_activation(self):
        campaign_id = await self.activate_campaign(campaign_id="wager-policy-drift")
        accepted_offer = (
            await promotions.list_offers(
                "IN", deposit_amount_paise=10_000, user_id="player-1",
            )
        )[0]
        consent = await promotions.accept_offer(
            "player-1", campaign_id, jurisdiction="IN", terms_accepted=True,
            deposit_amount_paise=10_000, idempotency_key="policy-drift-consent-one",
            quote_token=accepted_offer["quote"]["quote_token"],
        )
        pending_offer = (
            await promotions.list_offers(
                "IN", deposit_amount_paise=10_000, user_id="player-1",
            )
        )[0]
        with patch.dict(os.environ, {
            "WAGER_SETTLEMENT_FINALITY_POLICY_VERSION": "settlement-finality-v2",
            "WAGER_SETTLEMENT_FINALITY_CERTIFIED_POLICY_VERSION": "settlement-finality-v2",
        }):
            self.assertEqual(
                await promotions.list_offers(
                    "IN", deposit_amount_paise=10_000, user_id="player-1",
                ),
                [],
            )
            with self.assertRaises(promotions.PromotionError) as acceptance:
                await promotions.accept_offer(
                    "player-1", campaign_id, jurisdiction="IN", terms_accepted=True,
                    deposit_amount_paise=10_000,
                    idempotency_key="policy-drift-consent-two",
                    quote_token=pending_offer["quote"]["quote_token"],
                )
            self.assertEqual(
                acceptance.exception.code,
                "WAGER_SETTLEMENT_FINALITY_POLICY_MISMATCH",
            )
            with self.assertRaises(promotions.PromotionError) as activation:
                await promotions.activate_deposit_mission({
                    "id": "policy-drift-deposit", "user_id": "player-1", "chips": 100,
                    "amount_paise": 10_000, "promotion_consent_id": consent["id"],
                })
            self.assertEqual(
                activation.exception.code,
                "WAGER_SETTLEMENT_FINALITY_POLICY_MISMATCH",
            )
        self.assertEqual(await self.db.wager_missions.count_documents({}), 0)

    async def test_self_exclusion_blocks_new_bonus_but_cleared_cash_stays_withdrawable(self):
        campaign_id = await self.activate_campaign(campaign_id="wager-self-exclusion")
        accepted_offer = (
            await promotions.list_offers(
                "IN", deposit_amount_paise=10_000, user_id="player-1",
            )
        )[0]
        consent = await promotions.accept_offer(
            "player-1", campaign_id, jurisdiction="IN", terms_accepted=True,
            deposit_amount_paise=10_000,
            idempotency_key="self-exclusion-existing-consent",
            quote_token=accepted_offer["quote"]["quote_token"],
        )
        pending_offer = (
            await promotions.list_offers(
                "IN", deposit_amount_paise=10_000, user_id="player-1",
            )
        )[0]
        await self.db.exclusions.insert_one({
            "id": "self-exclusion-promo-test", "user_id": "player-1",
            "kind": "SELF_EXCLUSION", "status": "ACTIVE", "ends_at": None,
            "created_at": datetime.now(timezone.utc),
        })
        with self.assertRaises(promotions.PromotionError) as listing:
            await promotions.list_offers(
                "IN", deposit_amount_paise=10_000, user_id="player-1",
            )
        self.assertEqual(listing.exception.code, "SELF_EXCLUDED")
        with self.assertRaises(promotions.PromotionError) as acceptance:
            await promotions.accept_offer(
                "player-1", campaign_id, jurisdiction="IN", terms_accepted=True,
                deposit_amount_paise=10_000,
                idempotency_key="self-exclusion-new-consent",
                quote_token=pending_offer["quote"]["quote_token"],
            )
        self.assertEqual(acceptance.exception.code, "SELF_EXCLUDED")
        mission = await promotions.activate_deposit_mission({
            "id": "self-exclusion-cleared-deposit", "user_id": "player-1", "chips": 100,
            "amount_paise": 10_000, "promotion_consent_id": consent["id"],
        })
        self.assertIsNone(mission)
        stored_consent = await self.db.promotion_consents.find_one({"id": consent["id"]})
        self.assertEqual(stored_consent["status"], "PARTICIPATION_BLOCKED")
        eligibility = await promotions.withdrawal_eligibility_projection("player-1", 100)
        self.assertTrue(eligibility["allowed"])
        self.assertEqual(eligibility["meta"]["withdrawable_chips"], 100)
        wallet = await self.db.wallet_accounts.find_one({"user_id": "player-1"})
        self.assertEqual(wallet["available_cash_chips"], 100)
        self.assertEqual(wallet["available_bonus_chips"], 0)

    async def test_legal_aml_hold_is_distinct_from_bonus_restriction(self):
        _, mission = await self.activate_mission(deposit_id="legal-hold-mission-deposit")
        bonus_explanation = await promotions.withdrawal_eligibility_projection(
            "player-1", 101,
        )
        self.assertFalse(bonus_explanation["allowed"])
        self.assertEqual(
            bonus_explanation["code"], "AMOUNT_EXCEEDS_WITHDRAWABLE_CASH",
        )
        self.assertEqual(
            bonus_explanation["meta"]["active_mission"], None,
        )
        held_user = {
            "id": "player-1", "role": "PLAYER", "status": "ACTIVE",
            "contact_verified": True, "email_verified": True,
            "phone_verified": False, "age_verified": True,
            "kyc_status": "VERIFIED", "country": "IN",
            "financial_status": "REVIEW_REQUIRED",
            "withdrawal_hold": {
                "id": "withdrawal-hold:promotion-aml-case",
                "category": "AML",
                "reason_code": "AML_SOURCE_OF_FUNDS_REVIEW",
                "review_status": "UNDER_REVIEW",
                "recorded_at": datetime.now(timezone.utc),
                "recorded_by": "compliance-reviewer-1",
                "support_path": "/support",
                "source": {
                    "type": "AML_REVIEW",
                    "id": "aml-review:promotion-001",
                },
            },
        }
        with patch.dict(os.environ, {"WITHDRAWALS_ENABLED": "true"}):
            with self.assertRaises(HTTPException) as blocked:
                await routes_payments._require_player("withdrawals", held_user)
        self.assertEqual(
            blocked.exception.detail["code"],
            "LEGAL_OR_COMPLIANCE_WITHDRAWAL_HOLD",
        )
        self.assertEqual(
            blocked.exception.detail["hold_reason_code"],
            "AML_SOURCE_OF_FUNDS_REVIEW",
        )
        self.assertEqual(
            blocked.exception.detail["support_path"],
            "/support",
        )
        stored = await self.db.wager_missions.find_one({"id": mission["id"]})
        self.assertEqual(stored["status"], "ACTIVE")
        wallet = await self.db.wallet_accounts.find_one({"user_id": "player-1"})
        self.assertEqual(wallet["available_cash_chips"], 100)

    async def test_wager_events_are_pending_then_settled_and_duplicate_safe(self):
        _, mission = await self.activate_mission()
        self.assertEqual(
            mission["reward"]["rate_snapshot"]["version"],
            finance.conversion_snapshot()["version"],
        )
        event_time = datetime.now(timezone.utc)
        pending = await promotions.record_wager_event(
            user_id="player-1", bet_id="stake-tx-1", event_type="STAKE",
            source_event_id="stake-event-0001", game="aviator", stake_chips=100,
            occurred_at=event_time, source_allocation={"available_cash_chips": 100},
        )
        self.assertEqual(pending["mission"]["status"], "PENDING_SETTLEMENT")
        self.assertEqual(pending["mission"]["progress"]["pending_chips"], 100)
        duplicate = await promotions.record_wager_event(
            user_id="player-1", bet_id="stake-tx-1", event_type="STAKE",
            source_event_id="stake-event-0001", game="aviator", stake_chips=100,
            occurred_at=event_time, source_allocation={"available_cash_chips": 100},
        )
        self.assertTrue(duplicate["duplicate"])
        settled = await promotions.record_wager_event(
            user_id="player-1", bet_id="stake-tx-1", event_type="SETTLED",
            source_event_id="settle-event-001", game="aviator", stake_chips=100,
            occurred_at=event_time + timedelta(seconds=1),
            source_allocation={"available_cash_chips": 100},
        )
        self.assertEqual(settled["mission"]["status"], "PENDING_SETTLEMENT")
        self.assertEqual(settled["mission"]["claim_finality"]["status"], "PENDING")
        self.assertEqual(settled["mission"]["progress"]["percent"], 100)
        self.assertEqual(settled["mission"]["progress"]["pending_chips"], 0)
        self.assertEqual(await self.db.wager_events.count_documents({"mission_id": mission["id"]}), 2)
        activity = await promotions.list_mission_events("player-1", mission["id"])
        self.assertEqual(len(activity), 2)
        self.assertTrue(all(row["contribution_bps"] == 10_000 for row in activity))
        self.assertEqual({row["status"] for row in activity}, {"PENDING", "SETTLED"})
        for row in activity:
            self.assertNotIn("source_allocation", row)
            self.assertNotIn("source_key", row)
            self.assertNotIn("source_event_id", row)
            self.assertNotIn("request_hash", row)
            self.assertNotIn("user_id", row)

    async def test_out_of_order_settlement_and_refund_reconcile_to_zero(self):
        _, mission = await self.activate_mission()
        stamp = datetime.now(timezone.utc) + timedelta(seconds=1)
        stake_id = "stake-late-0001"
        early = await promotions.record_wager_event(
            user_id="player-1", bet_id=stake_id, event_type="SETTLED",
            source_event_id="settle-first-01", game="aviator", stake_chips=100,
            occurred_at=stamp, source_allocation={"available_cash_chips": 100},
        )
        self.assertIsNone(early)
        late_stake = await promotions.record_wager_event(
            user_id="player-1", bet_id=stake_id, event_type="STAKE",
            source_event_id=stake_id, game="aviator", stake_chips=100,
            occurred_at=stamp - timedelta(milliseconds=500),
            source_allocation={"available_cash_chips": 100},
        )
        self.assertEqual(late_stake["mission"]["progress"]["pending_chips"], 100)
        replayed = await promotions.record_wager_event(
            user_id="player-1", bet_id=stake_id, event_type="SETTLED",
            source_event_id="settle-first-01", game="aviator", stake_chips=100,
            occurred_at=stamp, source_allocation={"available_cash_chips": 100},
        )
        self.assertEqual(replayed["mission"]["progress"]["settled_chips"], 100)
        reversed_row = await promotions.record_wager_event(
            user_id="player-1", bet_id=stake_id, event_type="VOID",
            source_event_id="refund-event-01", game="aviator", stake_chips=100,
            occurred_at=stamp + timedelta(seconds=1),
            source_allocation={"available_cash_chips": 100},
        )
        self.assertEqual(reversed_row["mission"]["progress"]["settled_chips"], 0)
        self.assertEqual(reversed_row["mission"]["status"], "ACTIVE")
        await self.db.chip_transactions.insert_many([
            {
                "id": stake_id, "user_id": "player-1", "kind": "STAKE",
                "amount": 100, "game": "aviator", "ref": stake_id,
                "funding_allocation": {"available_cash_chips": 100},
                "created_at": stamp - timedelta(milliseconds=500),
            },
            {
                "id": "settle-first-01", "user_id": "player-1", "kind": "SETTLEMENT",
                "amount": 100, "game": "aviator", "ref": stake_id,
                "source_transaction_id": stake_id, "settlement_status": "SETTLED",
                "created_at": stamp,
            },
            {
                "id": "refund-event-01", "user_id": "player-1", "kind": "SETTLEMENT",
                "amount": 100, "game": "aviator", "ref": stake_id,
                "source_transaction_id": stake_id, "settlement_status": "VOID",
                "created_at": stamp + timedelta(seconds=1),
            },
        ])
        reconciliation = await promotions.reconcile_mission(mission["id"], "admin-auditor")
        self.assertTrue(reconciliation["matches"])
        self.assertEqual(reconciliation["expected"], {"pending_chips": 0, "settled_chips": 0})

    async def test_game_percentage_max_stake_and_source_allocation_are_authoritative(self):
        _, mission = await self.activate_mission(chips=1_000)
        row = await promotions.record_wager_event(
            user_id="player-1", bet_id="blackjack-stake-1", event_type="STAKE",
            source_event_id="blackjack-ledger-1", game="blackjack", stake_chips=3_000,
            source_allocation={"available_cash_chips": 3_000},
        )
        # max stake 1,000 * blackjack contribution 50% = 500.
        self.assertEqual(row["mission"]["progress"]["pending_chips"], 500)
        settled = await promotions.record_wager_event(
            user_id="player-1", bet_id="blackjack-stake-1", event_type="SETTLED",
            source_event_id="blackjack-settle-1", game="blackjack", stake_chips=3_000,
            # Settlement marker intentionally has no allocation; the original
            # stake remains the source-authoritative contribution evidence.
            source_allocation={},
        )
        self.assertEqual(settled["mission"]["progress"]["settled_chips"], 500)
        self.assertEqual(settled["mission"]["progress"]["percent"], 50)

    async def test_source_ineligible_stake_remains_zero_when_settlement_copies_allocation(self):
        _, mission = await self.activate_mission()
        stake = await promotions.record_wager_event(
            user_id="player-1", bet_id="ineligible-stake-tx", event_type="STAKE",
            source_event_id="ineligible-stake-event", game="aviator", stake_chips=100,
            source_allocation={"unapproved_bucket": 100},
        )
        self.assertEqual(stake["mission"]["progress"]["pending_chips"], 0)
        settled = await promotions.record_wager_event(
            user_id="player-1", bet_id="ineligible-stake-tx", event_type="SETTLED",
            source_event_id="ineligible-settlement", game="aviator", stake_chips=100,
            source_allocation={"available_cash_chips": 100},
        )
        self.assertEqual(settled["mission"]["id"], mission["id"])
        self.assertEqual(settled["mission"]["progress"]["settled_chips"], 0)
        self.assertEqual(settled["mission"]["status"], "PAUSED_FOR_REVIEW")

    async def test_missing_source_allocation_contributes_zero_and_pauses_before_claim(self):
        _, mission = await self.activate_mission()
        result = await promotions.record_wager_event(
            user_id="player-1", bet_id="missing-allocation-stake", event_type="STAKE",
            source_event_id="missing-allocation-event", game="aviator", stake_chips=100,
            source_allocation={},
        )
        self.assertEqual(result["mission"]["id"], mission["id"])
        self.assertEqual(result["mission"]["status"], "PAUSED_FOR_REVIEW")
        self.assertEqual(result["mission"]["progress"]["settled_chips"], 0)
        self.assertEqual(result["mission"]["progress"]["pending_chips"], 0)
        with self.assertRaises(promotions.PromotionError) as blocked:
            await promotions.claim_mission("player-1", mission["id"], "missing-allocation-claim")
        self.assertEqual(blocked.exception.code, "MISSION_NOT_CLAIMABLE")

    async def test_invalid_source_allocation_remains_blocking_after_reconciliation_repair(self):
        _, mission = await self.activate_mission()
        stamp = datetime.now(timezone.utc)
        authoritative = {
            "id": "invalid-allocation-ledger-stake", "user_id": "player-1",
            "kind": "STAKE", "amount": 100, "game": "aviator",
            "ref": "invalid-allocation-round",
            "funding_allocation": {
                "policy": "BONUS_FIRST_THEN_CASH",
                "policy_version": "game-wallet-source-v1",
                "cash_chips": 99, "bonus_chips": 0,
                "bonus_lots": [], "operation_id": "wallet-op-invalid",
            },
            "created_at": stamp,
        }
        await self.db.chip_transactions.insert_one(authoritative)
        observed = await promotions.handle_ledger_event(authoritative)
        self.assertEqual(observed["mission"]["status"], "PAUSED_FOR_REVIEW")
        audit = await promotions.reconcile_mission(mission["id"], "admin-auditor")
        self.assertEqual(
            audit["issues"]["invalid_source_allocation"],
            ["invalid-allocation-ledger-stake"],
        )
        repaired = await promotions.reconcile_mission(
            mission["id"], "admin-auditor", repair=True,
            reason="Keep invalid source evidence quarantined for review",
        )
        self.assertTrue(repaired["repaired"])
        stored = await self.db.wager_missions.find_one({"id": mission["id"]})
        self.assertEqual(stored["status"], "PAUSED_FOR_REVIEW")
        self.assertEqual(stored["settled_contribution_chips"], 0)

    async def test_old_stake_settlement_never_progresses_a_new_mission(self):
        _, mission_a = await self.activate_mission(deposit_id="deposit-a")
        await promotions.record_wager_event(
            user_id="player-1", bet_id="mission-a-stake", event_type="STAKE",
            source_event_id="mission-a-stake-event", game="aviator", stake_chips=100,
            source_allocation={"available_cash_chips": 100},
        )
        await self.db.wager_missions.update_one(
            {"id": mission_a["id"]},
            {"$set": {
                "status": "EXPIRED", "deadline_at": datetime.now(timezone.utc) - timedelta(seconds=1),
            }},
        )
        consent_b = await self.accept_player_offer(
            "wager-main", 10_000, "mission-b-consent",
        )
        mission_b = await promotions.activate_deposit_mission({
            "id": "deposit-b", "user_id": "player-1", "chips": 100,
            "amount_paise": 10_000, "promotion_consent_id": consent_b["id"],
        })
        old_settlement = await promotions.record_wager_event(
            user_id="player-1", bet_id="mission-a-stake", event_type="SETTLED",
            source_event_id="mission-a-late-settlement", game="aviator", stake_chips=100,
        )
        self.assertIsNone(old_settlement)
        stored_b = await self.db.wager_missions.find_one({"id": mission_b["id"]})
        self.assertEqual(stored_b["settled_contribution_chips"], 0)
        self.assertEqual(stored_b["pending_settlement_chips"], 0)
        with self.assertRaises(promotions.PromotionError) as forced:
            await promotions.record_wager_event(
                user_id="player-1", bet_id="mission-a-stake", event_type="SETTLED",
                source_event_id="forced-mission-b-settlement", game="aviator", stake_chips=100,
                mission_id=mission_b["id"],
            )
        self.assertEqual(forced.exception.code, "WAGER_MISSION_ALLOCATION_CONFLICT")

    async def test_multiple_deposits_overlapping_campaigns_allocate_each_bet_once(self):
        early_spec = wager_spec()
        early_spec["duration_hours"] = 24
        late_spec = wager_spec()
        late_spec["duration_hours"] = 72
        early_campaign = await self.activate_campaign(
            campaign_id="wager-overlap-early", spec=early_spec,
        )
        late_campaign = await self.activate_campaign(
            campaign_id="wager-overlap-late", spec=late_spec,
        )
        early_consent = await self.accept_player_offer(
            early_campaign, 10_000, "overlap-early-consent",
        )
        late_consent = await self.accept_player_offer(
            late_campaign, 10_000, "overlap-late-consent",
        )
        early = await promotions.activate_deposit_mission({
            "id": "overlap-deposit-one", "user_id": "player-1", "chips": 100,
            "amount_paise": 10_000, "promotion_consent_id": early_consent["id"],
        })
        late = await promotions.activate_deposit_mission({
            "id": "overlap-deposit-two", "user_id": "player-1", "chips": 100,
            "amount_paise": 10_000, "promotion_consent_id": late_consent["id"],
        })
        first = await promotions.record_wager_event(
            user_id="player-1", bet_id="overlap-first-bet", event_type="STAKE",
            source_event_id="overlap-first-stake", game="aviator", stake_chips=40,
            source_allocation={"cash_chips": 40, "bonus_chips": 0},
        )
        self.assertEqual(first["mission"]["id"], early["id"])
        stored_early = await self.db.wager_missions.find_one({"id": early["id"]})
        stored_late = await self.db.wager_missions.find_one({"id": late["id"]})
        self.assertEqual(stored_early["pending_settlement_chips"], 40)
        self.assertEqual(stored_late["pending_settlement_chips"], 0)
        self.assertEqual(await self.db.wager_events.count_documents({
            "bet_id": "overlap-first-bet", "event_type": "STAKE",
        }), 1)

        await promotions.forfeit_mission(
            "player-1", early["id"], "Continue with the later accepted campaign",
            "forfeit-overlap-early-mission",
        )
        second = await promotions.record_wager_event(
            user_id="player-1", bet_id="overlap-second-bet", event_type="STAKE",
            source_event_id="overlap-second-stake", game="aviator", stake_chips=30,
            source_allocation={"cash_chips": 30, "bonus_chips": 0},
        )
        self.assertEqual(second["mission"]["id"], late["id"])
        stored_late = await self.db.wager_missions.find_one({"id": late["id"]})
        self.assertEqual(stored_late["pending_settlement_chips"], 30)

    async def test_concurrent_forfeit_and_settlement_cannot_resurrect_reward(self):
        _, mission = await self.activate_mission(deposit_id="forfeit-race-deposit")
        await promotions.record_wager_event(
            user_id="player-1", bet_id="forfeit-race-stake", event_type="STAKE",
            source_event_id="forfeit-race-stake", game="aviator", stake_chips=100,
            source_allocation={"cash_chips": 100, "bonus_chips": 0},
        )
        results = await asyncio.gather(
            promotions.forfeit_mission(
                "player-1", mission["id"], "Continue without this bonus",
                "forfeit-race-key",
            ),
            promotions.record_wager_event(
                user_id="player-1", bet_id="forfeit-race-stake", event_type="SETTLED",
                source_event_id="forfeit-race-settlement", game="aviator",
                stake_chips=100,
                # Marker payload is deliberately empty: the original stake is
                # the only authoritative source/contribution evidence.
                source_allocation={},
            ),
            return_exceptions=True,
        )
        stored = await self.db.wager_missions.find_one({"id": mission["id"]})
        self.assertEqual(stored["status"], "FORFEITED")
        self.assertEqual(await self.db.wager_events.count_documents({
            "mission_id": mission["id"], "event_type": "SETTLED",
        }), 1)
        settlement = await self.db.wager_events.find_one({
            "mission_id": mission["id"], "event_type": "SETTLED",
        })
        self.assertEqual(settlement["contribution_chips"], 100)
        self.assertEqual(
            settlement["source_allocation"], {"cash_chips": 100, "bonus_chips": 0},
        )
        self.assertTrue(any(not isinstance(row, Exception) for row in results))
        with self.assertRaises(promotions.PromotionError) as blocked:
            await promotions.claim_mission(
                "player-1", mission["id"], "claim-forfeited-race",
            )
        self.assertEqual(blocked.exception.code, "MISSION_NOT_CLAIMABLE")

    async def test_reconciliation_respects_historical_mission_closure(self):
        _, mission_a = await self.activate_mission(deposit_id="closure-deposit-a")
        closed_at = datetime.now(timezone.utc)
        await self.db.wager_missions.update_one(
            {"id": mission_a["id"]},
            {"$set": {
                "status": "CLAIMED", "claimed_at": closed_at,
                "updated_at": closed_at,
            }},
        )
        consent_b = await self.accept_player_offer(
            "wager-main", 10_000, "closure-mission-b-consent",
        )
        mission_b = await promotions.activate_deposit_mission({
            "id": "closure-deposit-b", "user_id": "player-1", "chips": 100,
            "amount_paise": 10_000, "promotion_consent_id": consent_b["id"],
        })
        stake_time = datetime.now(timezone.utc)
        stake = {
            "id": "post-closure-stake", "user_id": "player-1", "kind": "STAKE",
            "amount": 100, "game": "aviator", "ref": "post-closure-round",
            "funding_allocation": {"cash_chips": 100, "bonus_chips": 0},
            "created_at": stake_time,
        }
        await self.db.chip_transactions.insert_one(stake)
        observed = await promotions.handle_ledger_event(stake)
        self.assertEqual(observed["mission"]["id"], mission_b["id"])
        audit = await promotions.reconcile_mission(mission_b["id"], "admin-auditor")
        self.assertTrue(audit["matches"])
        self.assertEqual(audit["expected"]["pending_chips"], 100)

    async def test_reconciliation_ignores_settlement_after_accepted_deadline(self):
        _, mission = await self.activate_mission(deposit_id="late-settlement-deposit")
        current = datetime.now(timezone.utc)
        activated_at = current - timedelta(seconds=10)
        deadline_at = current - timedelta(seconds=1)
        await self.db.wager_missions.update_one(
            {"id": mission["id"]},
            {"$set": {
                "activated_at": activated_at, "deadline_at": deadline_at,
                "status": "ACTIVE", "updated_at": activated_at,
            }},
        )
        stake = {
            "id": "before-deadline-stake", "user_id": "player-1", "kind": "STAKE",
            "amount": 100, "game": "aviator", "ref": "late-settlement-round",
            "funding_allocation": {"cash_chips": 100, "bonus_chips": 0},
            "created_at": current - timedelta(seconds=5),
        }
        await self.db.chip_transactions.insert_one(stake)
        observed = await promotions.handle_ledger_event(stake)
        self.assertEqual(observed["mission"]["progress"]["pending_chips"], 100)
        marker = {
            "id": "after-deadline-settlement", "user_id": "player-1",
            "kind": "SETTLEMENT", "amount": 100, "game": "aviator",
            "ref": "late-settlement-round", "source_transaction_id": stake["id"],
            "settlement_status": "SETTLED",
            "funding_allocation": dict(stake["funding_allocation"]),
            "created_at": current,
        }
        await self.db.chip_transactions.insert_one(marker)
        self.assertIsNone(await promotions.handle_ledger_event(marker))
        await promotions.expire_due_mission(mission["id"])
        audit = await promotions.reconcile_mission(mission["id"], "admin-auditor")
        self.assertEqual(audit["expected"]["settled_chips"], 0)
        self.assertEqual(audit["expected"]["pending_chips"], 100)
        stored = await self.db.wager_missions.find_one({"id": mission["id"]})
        self.assertEqual(stored["status"], "EXPIRED")
        with self.assertRaises(promotions.PromotionError) as blocked:
            await promotions.claim_mission("player-1", mission["id"], "late-settle-claim-key")
        self.assertEqual(blocked.exception.code, "MISSION_EXPIRED")

    async def test_events_before_activation_or_after_deadline_do_not_count(self):
        await self.activate_campaign()
        no_mission = await promotions.record_wager_event(
            user_id="player-1", bet_id="pre-activation", event_type="SETTLED",
            source_event_id="pre-activation-event", game="aviator", stake_chips=100,
        )
        self.assertIsNone(no_mission)
        campaign = await self.db.promotion_campaigns.find_one({"id": "wager-main"})
        self.assertEqual(campaign["status"], "ACTIVE")
        consent = await self.accept_player_offer(
            "wager-main", 10_000, "deadline-consent-1",
        )
        mission = await promotions.activate_deposit_mission({
            "id": "deadline-deposit", "user_id": "player-1", "chips": 100,
            "amount_paise": 10_000, "promotion_consent_id": consent["id"],
        })
        after = await promotions.record_wager_event(
            user_id="player-1", bet_id="after-deadline", event_type="SETTLED",
            source_event_id="after-deadline-event", game="aviator", stake_chips=100,
            occurred_at=mission["deadline_at"] + timedelta(seconds=1),
        )
        self.assertIsNone(after)
        stored = await self.db.wager_missions.find_one({"id": mission["id"]})
        self.assertEqual(stored["settled_contribution_chips"], 0)

    async def test_claim_is_idempotent_and_only_reward_enters_bonus_bucket(self):
        _, mission = await self.activate_mission()
        await self.complete_authoritative_mission(mission, prefix="claim-idempotent")
        promoted, _ = await self.promote_finality(mission["id"])
        self.assertEqual(promoted["status"], "CLAIMABLE")
        first = await promotions.claim_mission("player-1", mission["id"], "claim-mission-001")
        retry = await promotions.claim_mission("player-1", mission["id"], "claim-mission-001")
        self.assertFalse(first["duplicate"])
        self.assertTrue(retry["duplicate"])
        wallet = await self.db.wallet_accounts.find_one({"user_id": "player-1"})
        self.assertEqual(wallet["available_cash_chips"], 100)
        self.assertEqual(wallet["available_bonus_chips"], 50)
        eligibility = await promotions.withdrawal_eligibility_projection("player-1", 120)
        self.assertFalse(eligibility["allowed"])
        self.assertEqual(eligibility["meta"]["withdrawable_chips"], 100)
        self.assertEqual(eligibility["meta"]["restricted_bonus_chips"], 50)

    async def test_reward_stays_uncredited_until_authoritative_finality(self):
        _, mission = await self.activate_mission()
        _, _, _, settled = await self.complete_authoritative_mission(
            mission, prefix="held-before-finality",
        )
        self.assertEqual(settled["mission"]["status"], "PENDING_SETTLEMENT")
        self.assertEqual(settled["mission"]["progress"]["percent"], 100)
        self.assertFalse(settled["mission"]["claimable"])
        self.assertEqual(settled["mission"]["claim_finality"]["status"], "PENDING")
        with self.assertRaises(promotions.PromotionError) as blocked:
            await promotions.claim_mission(
                "player-1", mission["id"], "claim-before-finality-window",
            )
        self.assertEqual(blocked.exception.code, "MISSION_FINALITY_PENDING")
        self.assertIn("finality_at", blocked.exception.meta)
        wallet = await self.db.wallet_accounts.find_one({"user_id": "player-1"})
        self.assertEqual(wallet["available_cash_chips"], 100)
        self.assertEqual(wallet["available_bonus_chips"], 0)
        self.assertEqual(await self.db.bonus_claims.count_documents({}), 0)

    async def test_target_earned_before_deadline_survives_finality_after_deadline(self):
        spec = wager_spec()
        spec["duration_hours"] = 1
        spec["claim_finality_hours"] = 24
        campaign_id = await self.activate_campaign(
            campaign_id="wager-finality-boundary", spec=spec,
        )
        consent = await self.accept_player_offer(
            campaign_id, 10_000, "accept-finality-boundary",
        )
        mission = await promotions.activate_deposit_mission({
            "id": "finality-boundary-deposit", "user_id": "player-1", "chips": 100,
            "amount_paise": 10_000, "promotion_consent_id": consent["id"],
        })
        await self.complete_authoritative_mission(mission, prefix="deadline-finality")
        promoted, future = await self.promote_finality(mission["id"])
        self.assertGreater(future, promotions._as_utc(mission["deadline_at"], "deadline_at"))
        self.assertEqual(promoted["status"], "CLAIMABLE")
        claim = await promotions.claim_mission(
            "player-1", mission["id"], "claim-after-deadline-finality",
        )
        self.assertEqual(claim["mission"]["status"], "CLAIMED")

    async def test_late_void_before_finality_resets_reward_without_wallet_credit(self):
        _, mission = await self.activate_mission()
        stake, marker, _, _ = await self.complete_authoritative_mission(
            mission, prefix="void-before-finality",
        )
        void = {
            "id": "void-before-finality-marker", "user_id": "player-1",
            "kind": "SETTLEMENT", "amount": stake["amount"], "game": "aviator",
            "ref": marker["ref"], "source_transaction_id": stake["id"],
            "settlement_status": "VOID",
            "funding_allocation": dict(stake["funding_allocation"]),
            "created_at": marker["created_at"] + timedelta(seconds=1),
        }
        await self.db.chip_transactions.insert_one(void)
        reversed_once = await promotions.handle_ledger_event(void)
        reversed_twice = await promotions.handle_ledger_event(void)
        self.assertEqual(reversed_once["mission"]["progress"]["settled_chips"], 0)
        self.assertEqual(
            reversed_once["mission"]["claim_finality"]["status"],
            "RESET_BY_CORRECTION",
        )
        self.assertTrue(reversed_twice["duplicate"])
        wallet = await self.db.wallet_accounts.find_one({"user_id": "player-1"})
        self.assertEqual(wallet["available_cash_chips"], 100)
        self.assertEqual(wallet["available_bonus_chips"], 0)

    async def test_finality_reconciliation_failure_pauses_without_credit(self):
        _, mission = await self.activate_mission()
        _, marker, _, _ = await self.complete_authoritative_mission(
            mission, prefix="missing-finality-evidence",
        )
        await self.db.wager_events.delete_one({"source_event_id": marker["id"]})
        promoted, _ = await self.promote_finality(mission["id"])
        self.assertEqual(promoted["status"], "PAUSED_FOR_REVIEW")
        self.assertEqual(promoted["claim_finality"]["status"], "FAILED_REVIEW")
        wallet = await self.db.wallet_accounts.find_one({"user_id": "player-1"})
        self.assertEqual(wallet["available_cash_chips"], 100)
        self.assertEqual(wallet["available_bonus_chips"], 0)

    async def test_policy_rotation_pauses_pending_finality_and_claimable_mission(self):
        _, pending_mission = await self.activate_mission(
            deposit_id="pending-policy-drift-deposit",
        )
        await self.complete_authoritative_mission(
            pending_mission, prefix="pending-policy-drift",
        )
        with patch.dict(os.environ, {
            "WAGER_SETTLEMENT_FINALITY_POLICY_VERSION": "settlement-finality-v2",
            "WAGER_SETTLEMENT_FINALITY_CERTIFIED_POLICY_VERSION": "settlement-finality-v2",
        }):
            pending_result = await promotions.promote_mission_claim_finality(
                pending_mission["id"],
            )
        self.assertEqual(pending_result["status"], "PAUSED_FOR_REVIEW")
        self.assertEqual(
            pending_result["claim_finality"]["reason"],
            "SETTLEMENT_FINALITY_POLICY_DRIFT",
        )

        # Use a separate campaign scope because the paused mission retains its
        # immutable v1 evidence and must not be edited or reused.
        campaign_id = await self.activate_campaign(
            campaign_id="wager-claim-policy-drift",
        )
        consent = await self.accept_player_offer(
            campaign_id, 10_000, "claim-policy-drift-consent",
        )
        claimable_mission = await promotions.activate_deposit_mission({
            "id": "claim-policy-drift-deposit", "user_id": "player-1", "chips": 100,
            "amount_paise": 10_000, "promotion_consent_id": consent["id"],
        })
        await self.complete_authoritative_mission(
            claimable_mission, prefix="claimable-policy-drift",
        )
        promoted, _ = await self.promote_finality(claimable_mission["id"])
        self.assertEqual(promoted["status"], "CLAIMABLE")
        with patch.dict(os.environ, {
            "WAGER_SETTLEMENT_FINALITY_POLICY_VERSION": "settlement-finality-v2",
            "WAGER_SETTLEMENT_FINALITY_CERTIFIED_POLICY_VERSION": "settlement-finality-v2",
        }):
            with self.assertRaises(promotions.PromotionError) as blocked:
                await promotions.claim_mission(
                    "player-1", claimable_mission["id"], "claim-after-policy-drift",
                )
        self.assertEqual(
            blocked.exception.code,
            "WAGER_SETTLEMENT_FINALITY_POLICY_MISMATCH",
        )
        stored = await self.db.wager_missions.find_one({"id": claimable_mission["id"]})
        self.assertEqual(stored["status"], "PAUSED_FOR_REVIEW")
        wallet = await self.db.wallet_accounts.find_one({"user_id": "player-1"})
        self.assertEqual(wallet["available_cash_chips"], 100)
        self.assertEqual(wallet["available_bonus_chips"], 0)

    async def test_concurrent_claim_retries_credit_reward_once(self):
        _, mission = await self.activate_mission()
        await self.complete_authoritative_mission(mission, prefix="claim-concurrent")
        await self.promote_finality(mission["id"])
        results = await asyncio.gather(
            promotions.claim_mission("player-1", mission["id"], "claim-race-key-1"),
            promotions.claim_mission("player-1", mission["id"], "claim-race-key-2"),
        )
        self.assertEqual(await self.db.bonus_claims.count_documents({"mission_id": mission["id"]}), 1)
        wallet = await self.db.wallet_accounts.find_one({"user_id": "player-1"})
        self.assertEqual(wallet["available_bonus_chips"], 50)
        self.assertTrue(any(row.get("duplicate") for row in results))
        counter = await self.db.wager_reward_counters.find_one({"key": "wager-main:1"})
        self.assertEqual(counter["approved_chips"], 50)
        self.assertEqual(counter["claimed_chips"], 50)
        reservation = next(iter(counter["reservations"].values()))
        self.assertEqual(reservation["status"], "CLAIMED")

    async def test_concurrent_withdrawal_and_bonus_claim_conserve_source_balances(self):
        _, mission = await self.activate_mission()
        await self.complete_authoritative_mission(
            mission, prefix="withdrawal-claim-race",
        )
        await self.promote_finality(mission["id"])
        await finance.apply_wallet_movement(
            user_id="player-1", kind="TEST_CLEARED_CASH_SEED",
            source_key="test-cleared-cash-seed:withdrawal-claim",
            idempotency_key="test-cleared-cash-seed:withdrawal-claim",
            deltas={"available_cash_chips": 1_000}, mirror_user_delta=1_000,
            metadata={"test_case": "concurrent_withdrawal_and_claim"},
        )
        payout_method_id = "withdrawal-claim-payout-method"
        await self.db.payout_methods.insert_one({
            "id": payout_method_id, "user_id": "player-1", "status": "ACTIVE",
            "use_serial": 0, "bank_name": "Test Bank",
            "account_number_masked": "********9012", "ifsc_masked": "ABCD***3456",
            "payout_identifier_masked": None,
            "created_at": datetime.now(timezone.utc),
            "updated_at": datetime.now(timezone.utc),
        })
        provider = type("PromotionWithdrawalProvider", (), {"name": "test-provider"})()
        withdrawal, claim = await asyncio.gather(
            finance.create_withdrawal(
                "player-1", 1_000, payout_method_id,
                "withdrawal-concurrent-with-claim", provider,
            ),
            promotions.claim_mission(
                "player-1", mission["id"], "claim-concurrent-with-withdrawal",
            ),
        )
        self.assertEqual(withdrawal["status"], "PENDING_ADMIN")
        self.assertEqual(claim["mission"]["status"], "CLAIMED")
        wallet = await self.db.wallet_accounts.find_one({"user_id": "player-1"})
        user = await self.db.users.find_one({"id": "player-1"})
        self.assertEqual(wallet["available_cash_chips"], 100)
        self.assertEqual(wallet["available_bonus_chips"], 50)
        self.assertEqual(wallet["held_cash_chips"], 1_000)
        self.assertEqual(user["chip_balance"], 150)
        self.assertEqual(
            user["chip_balance"],
            wallet["available_cash_chips"] + wallet["available_bonus_chips"],
        )
        operations = await self.db.wallet_operations.find({
            "user_id": "player-1",
            "kind": {"$in": [
                "TEST_CLEARED_CASH_SEED", "WITHDRAWAL_HOLD", "PROMOTION_REWARD",
            ]},
        }).to_list(length=None)
        self.assertEqual(len(operations), 3)
        for operation in operations:
            entries = await self.db.wallet_entries.find({
                "operation_id": operation["id"],
            }).to_list(length=None)
            self.assertEqual(sum(int(row["delta_chips"]) for row in entries), 0)

    async def test_claim_transaction_rollback_preserves_wallet_conservation(self):
        """A failed claim commit must roll back its wallet credit and liability.

        Mongomock does not implement MongoDB transactions, so this focused test
        supplies a transaction-harness rollback around the real claim work. The
        production readiness latch separately requires transaction support.
        """
        _, mission = await self.activate_mission(deposit_id="rollback-claim-deposit")
        await self.complete_authoritative_mission(mission, prefix="rollback-claim")
        await self.promote_finality(mission["id"])
        collection_names = (
            "wallet_accounts", "users", "wager_reward_counters",
            "wager_missions", "wallet_operations", "wallet_entries",
            "wallet_bonus_lots", "bonus_claims", "promotion_audit",
        )
        snapshots = {
            name: copy.deepcopy(
                await self.db[name].find({}).to_list(length=None)
            )
            for name in collection_names
        }

        async def transaction_with_test_rollback(work, session=None):
            self.assertIsNone(session)
            try:
                return await work(None)
            except Exception:
                for name, rows in snapshots.items():
                    collection = self.db[name]
                    await collection.delete_many({})
                    if rows:
                        await collection.insert_many(copy.deepcopy(rows))
                raise

        real_apply_wallet_movement = finance.apply_wallet_movement

        async def credit_then_fail(*args, **kwargs):
            await real_apply_wallet_movement(*args, **kwargs)
            raise RuntimeError("forced claim persistence failure")

        with patch.object(
            promotions, "_in_transaction", new=transaction_with_test_rollback,
        ), patch.object(
            finance, "apply_wallet_movement", new=credit_then_fail,
        ):
            with self.assertRaisesRegex(
                RuntimeError, "forced claim persistence failure",
            ):
                await promotions.claim_mission(
                    "player-1", mission["id"], "rollback-claim-idempotency",
                )

        for name, expected in snapshots.items():
            actual = await self.db[name].find({}).to_list(length=None)
            sort_key = lambda row: str(
                row.get("id") or row.get("key") or row.get("_id") or ""
            )
            self.assertEqual(
                sorted(actual, key=sort_key),
                sorted(expected, key=sort_key),
                f"{name} changed despite claim transaction rollback",
            )
        wallet = await self.db.wallet_accounts.find_one({"user_id": "player-1"})
        user = await self.db.users.find_one({"id": "player-1"})
        self.assertEqual(wallet["available_cash_chips"], 100)
        self.assertEqual(wallet["available_bonus_chips"], 0)
        self.assertEqual(user["chip_balance"], 100)
        self.assertEqual(
            user["chip_balance"],
            wallet["available_cash_chips"] + wallet["available_bonus_chips"],
        )
        self.assertEqual(
            await self.db.bonus_claims.count_documents({"mission_id": mission["id"]}),
            0,
        )

    async def test_refund_after_claim_pauses_review_without_touching_cash(self):
        _, mission = await self.activate_mission()
        stake, marker, _, _ = await self.complete_authoritative_mission(
            mission, prefix="claimed-bonus",
        )
        _, future = await self.promote_finality(mission["id"])
        await promotions.claim_mission("player-1", mission["id"], "claimed-before-refund")
        void = {
            "id": "claimed-bonus-void", "user_id": "player-1", "kind": "SETTLEMENT",
            "amount": stake["amount"], "game": "aviator", "ref": marker["ref"],
            "source_transaction_id": stake["id"], "settlement_status": "VOID",
            "funding_allocation": dict(stake["funding_allocation"]),
            "created_at": future + timedelta(seconds=1),
        }
        await self.db.chip_transactions.insert_one(void)
        reversal = await promotions.handle_ledger_event(void)
        duplicate = await promotions.handle_ledger_event(void)
        self.assertEqual(reversal["mission"]["status"], "PAUSED_FOR_REVIEW")
        self.assertTrue(duplicate["duplicate"])
        wallet = await self.db.wallet_accounts.find_one({"user_id": "player-1"})
        self.assertEqual(wallet["available_cash_chips"], 100)
        self.assertEqual(wallet["available_bonus_chips"], 50)
        claim = await self.db.bonus_claims.find_one({"mission_id": mission["id"]})
        self.assertEqual(claim["status"], "PAUSED_FOR_REVIEW")
        self.assertEqual(
            claim["review_reason_code"],
            "CERTIFIED_SETTLEMENT_FINALITY_ANOMALY",
        )
        audits = await self.db.promotion_audit.find({
            "entity_id": mission["id"],
            "action": "WAGER_SETTLEMENT_FINALITY_CERTIFICATION_ANOMALY",
        }).to_list(length=None)
        self.assertEqual(len(audits), 1)
        self.assertEqual(
            audits[0]["metadata"]["classification"],
            "IMPOSSIBLE_UNDER_CERTIFIED_POLICY",
        )
        self.assertFalse(audits[0]["metadata"]["cleared_funds_debited"])
        self.assertEqual(
            audits[0]["metadata"]["settlement_finality_policy_version"],
            "settlement-finality-test-v1",
        )

    async def test_cash_reward_late_reversal_pauses_without_debiting_cleared_cash(self):
        spec = wager_spec(reward_type="CASH_CREDIT")
        campaign_id = await self.activate_campaign(
            campaign_id="wager-cash-finality", spec=spec,
        )
        consent = await self.accept_player_offer(
            campaign_id, 10_000, "accept-cash-finality-offer",
        )
        mission = await promotions.activate_deposit_mission({
            "id": "cash-finality-deposit", "user_id": "player-1", "chips": 100,
            "amount_paise": 10_000, "promotion_consent_id": consent["id"],
        })
        stake, marker, _, _ = await self.complete_authoritative_mission(
            mission, prefix="claimed-cash",
        )
        _, future = await self.promote_finality(mission["id"])
        await promotions.claim_mission(
            "player-1", mission["id"], "claim-cash-before-late-void",
        )
        credited = await self.db.wallet_accounts.find_one({"user_id": "player-1"})
        self.assertEqual(credited["available_cash_chips"], 150)
        void = {
            "id": "claimed-cash-void", "user_id": "player-1", "kind": "SETTLEMENT",
            "amount": stake["amount"], "game": "aviator", "ref": marker["ref"],
            "source_transaction_id": stake["id"], "settlement_status": "VOID",
            "funding_allocation": dict(stake["funding_allocation"]),
            "created_at": future + timedelta(seconds=1),
        }
        await self.db.chip_transactions.insert_one(void)
        reversal = await promotions.handle_ledger_event(void)
        duplicate = await promotions.handle_ledger_event(void)
        self.assertEqual(reversal["mission"]["status"], "PAUSED_FOR_REVIEW")
        self.assertTrue(duplicate["duplicate"])
        after = await self.db.wallet_accounts.find_one({"user_id": "player-1"})
        self.assertEqual(after["available_cash_chips"], 150)
        self.assertEqual(after["available_bonus_chips"], 0)
        operations = await self.db.wallet_operations.find({
            "user_id": "player-1", "kind": "PROMOTION_REWARD",
        }).to_list(length=None)
        self.assertTrue(operations)
        self.assertTrue(all(
            int(dict(row.get("deltas") or {}).get("available_cash_chips", 0)) >= 0
            for row in operations
        ))

    async def test_reconciliation_detects_and_repairs_counter_drift(self):
        _, mission = await self.activate_mission()
        stamp = datetime.now(timezone.utc)
        await self.db.chip_transactions.insert_one({
            "id": "repair-stake-event", "user_id": "player-1", "kind": "STAKE",
            "amount": 40, "game": "aviator", "ref": "repair-stake-event",
            "funding_allocation": {"available_cash_chips": 40}, "created_at": stamp,
        })
        await promotions.record_wager_event(
            user_id="player-1", bet_id="repair-stake-event", event_type="STAKE",
            source_event_id="repair-stake-event", game="aviator", stake_chips=40,
            source_allocation={"available_cash_chips": 40}, occurred_at=stamp,
        )
        await self.db.wager_missions.update_one(
            {"id": mission["id"]},
            {"$set": {"pending_settlement_chips": 999, "settled_contribution_chips": 888}},
        )
        audit = await promotions.reconcile_mission(mission["id"], "admin-auditor")
        self.assertFalse(audit["matches"])
        repaired = await promotions.reconcile_mission(
            mission["id"], "admin-auditor", repair=True,
            reason="Restore counters from append-only events",
        )
        self.assertTrue(repaired["repaired"])
        stored = await self.db.wager_missions.find_one({"id": mission["id"]})
        self.assertEqual(stored["pending_settlement_chips"], 40)
        self.assertEqual(stored["settled_contribution_chips"], 0)

    async def test_reconciliation_rebuilds_missing_events_from_authoritative_ledger(self):
        _, mission = await self.activate_mission()
        stamp = datetime.now(timezone.utc)
        await self.db.chip_transactions.insert_many([
            {
                "id": "missing-stake", "user_id": "player-1", "kind": "STAKE",
                "amount": 100, "game": "aviator", "ref": "missing-stake",
                "funding_allocation": {"available_cash_chips": 100}, "created_at": stamp,
            },
            {
                "id": "missing-settlement", "user_id": "player-1", "kind": "SETTLEMENT",
                "amount": 100, "game": "aviator", "ref": "missing-stake",
                "source_transaction_id": "missing-stake", "settlement_status": "SETTLED",
                "created_at": stamp + timedelta(seconds=1),
            },
        ])
        before = await promotions.reconcile_mission(mission["id"], "admin-auditor")
        self.assertEqual(len(before["issues"]["missing_derived_events"]), 2)
        self.assertEqual(before["expected"]["settled_chips"], 100)
        await promotions.reconcile_mission(
            mission["id"], "admin-auditor", repair=True,
            reason="Rebuild missing promotion projection from financial ledger",
        )
        stored = await self.db.wager_missions.find_one({"id": mission["id"]})
        self.assertEqual(stored["settled_contribution_chips"], 100)
        self.assertEqual(stored["status"], "PENDING_SETTLEMENT")
        self.assertEqual(stored["claim_finality_status"], "PENDING")
        self.assertEqual(await self.db.wager_events.count_documents({"mission_id": mission["id"]}), 2)
        after = await promotions.reconcile_mission(mission["id"], "admin-auditor")
        self.assertTrue(after["matches"])

    async def test_reconciliation_detects_corrupt_derived_and_orphan_evidence(self):
        _, mission = await self.activate_mission()
        stamp = datetime.now(timezone.utc)
        await self.db.chip_transactions.insert_many([
            {
                "id": "corrupt-stake", "user_id": "player-1", "kind": "STAKE",
                "amount": 100, "game": "aviator", "ref": "corrupt-stake",
                "funding_allocation": {"available_cash_chips": 100}, "created_at": stamp,
            },
            {
                "id": "orphan-marker", "user_id": "player-1", "kind": "SETTLEMENT",
                "amount": 100, "game": "aviator", "ref": "unknown",
                "source_transaction_id": "missing-ledger-stake", "settlement_status": "SETTLED",
                "created_at": stamp + timedelta(seconds=1),
            },
        ])
        await self.db.wager_events.insert_many([
            {
                "id": "corrupt-derived", "source_key": "wager:corrupt-stake:stake",
                "mission_id": mission["id"], "user_id": "player-1", "bet_id": "corrupt-stake",
                "bet_reference": "corrupt-stake", "event_type": "STAKE",
                "source_event_id": "corrupt-stake", "game": "aviator", "stake_chips": 100,
                "contribution_chips": 999, "source_allocation": {"available_cash_chips": 100},
                "occurred_at": stamp, "created_at": stamp,
            },
            {
                "id": "orphan-derived", "source_key": "wager:not-in-ledger:stake",
                "mission_id": mission["id"], "user_id": "player-1", "bet_id": "not-in-ledger",
                "bet_reference": "not-in-ledger", "event_type": "STAKE",
                "source_event_id": "not-in-ledger", "game": "aviator", "stake_chips": 5,
                "contribution_chips": 5, "source_allocation": {"available_cash_chips": 5},
                "occurred_at": stamp, "created_at": stamp,
            },
        ])
        result = await promotions.reconcile_mission(mission["id"], "admin-auditor")
        self.assertEqual(result["issues"]["corrupt_derived_events"], ["wager:corrupt-stake:stake"])
        self.assertEqual(result["issues"]["orphan_derived_events"], ["wager:not-in-ledger:stake"])
        self.assertEqual(result["issues"]["orphan_settlement_markers"], ["orphan-marker"])
        await promotions.reconcile_mission(
            mission["id"], "admin-auditor", repair=True,
            reason="Pause mission because authoritative evidence conflicts",
        )
        stored = await self.db.wager_missions.find_one({"id": mission["id"]})
        self.assertEqual(stored["status"], "PAUSED_FOR_REVIEW")

    async def test_ledger_observer_maps_unique_stake_and_authoritative_settlement(self):
        _, mission = await self.activate_mission()
        stake = {
            "id": "ledger-stake-0001", "user_id": "player-1", "kind": "STAKE",
            "amount": 100, "game": "aviator", "ref": "round-44",
            "funding_allocation": {"available_cash_chips": 100},
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        pending = await promotions.handle_ledger_event(stake)
        self.assertEqual(pending["mission"]["progress"]["pending_chips"], 100)
        settlement = {
            "id": "ledger-settle-001", "user_id": "player-1", "kind": "SETTLEMENT",
            "amount": 100, "game": "aviator", "ref": "round-44",
            "source_transaction_id": "ledger-stake-0001", "settlement_status": "SETTLED",
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        complete = await promotions.handle_ledger_event(settlement)
        self.assertEqual(complete["mission"]["id"], mission["id"])
        self.assertEqual(complete["mission"]["status"], "PENDING_SETTLEMENT")
        self.assertEqual(complete["mission"]["claim_finality"]["status"], "PENDING")

    async def test_real_source_wallet_adapter_allocation_interoperates_with_observer(self):
        _, mission = await self.activate_mission()
        old_game_db = game_wallet.db
        old_adapter = ledger._source_wallet_adapter
        old_observers = list(ledger._ledger_observers)
        old_guards = list(ledger._stake_guards)
        try:
            game_wallet.db = self.db
            ledger._source_wallet_adapter = None
            ledger._ledger_observers = []
            # This focused integration test owns wallet+ledger+promotion. The
            # compliance guard has its own database-isolation suite.
            ledger._stake_guards = []
            game_wallet.install()
            promotions.install_ledger_observer()
            await ledger.debit_chips(
                "player-1", 100, "Aviator qualifying stake",
                ref="real-adapter-round", kind=ledger.STAKE, game="aviator",
            )
            stake = await self.db.chip_transactions.find_one({
                "user_id": "player-1", "kind": "STAKE", "ref": "real-adapter-round",
            })
            allocation = stake["funding_allocation"]
            self.assertEqual(allocation["policy"], "BONUS_FIRST_THEN_CASH")
            self.assertEqual(allocation["policy_version"], "game-wallet-source-v1")
            self.assertEqual(allocation["cash_chips"], 100)
            self.assertEqual(allocation["bonus_chips"], 0)
            self.assertIsInstance(allocation["bonus_lots"], list)
            self.assertTrue(allocation["operation_id"])
            event = await self.db.wager_events.find_one({"source_event_id": stake["id"]})
            self.assertEqual(event["source_allocation"], allocation)
            pending = await self.db.wager_missions.find_one({"id": mission["id"]})
            self.assertEqual(pending["pending_settlement_chips"], 100)
            self.assertNotEqual(pending["status"], "PAUSED_FOR_REVIEW")

            markers = await ledger.record_settlement(
                "player-1", ["real-adapter-round"], "aviator", status="SETTLED",
            )
            self.assertEqual(len(markers), 1)
            completed = await self.db.wager_missions.find_one({"id": mission["id"]})
            self.assertEqual(completed["settled_contribution_chips"], 100)
            self.assertEqual(completed["status"], "PENDING_SETTLEMENT")
            self.assertEqual(completed["claim_finality_status"], "PENDING")
        finally:
            game_wallet.db = old_game_db
            ledger._source_wallet_adapter = old_adapter
            ledger._ledger_observers = old_observers
            ledger._stake_guards = old_guards

    async def test_referral_domain_is_separate_fixed_audited_and_claimable(self):
        await self.activate_campaign("REFERRAL")
        inviter = await promotions.get_or_create_referral_profile("player-1")
        self.assertEqual(
            promotions.invite_url(inviter["invite_code"]),
            f"https://chakri.example.test/register?invite_code={inviter['invite_code']}",
        )
        with self.assertRaises(promotions.PromotionError) as self_referral:
            await promotions.attach_player_referral(
                "player-1", inviter["invite_code"], jurisdiction="IN",
                consented_at=datetime.now(timezone.utc),
            )
        self.assertEqual(self_referral.exception.code, "SELF_REFERRAL_NOT_ALLOWED")

        relationship = await promotions.attach_player_referral(
            "player-2", inviter["invite_code"], jurisdiction="IN",
            consented_at=datetime.now(timezone.utc), risk_signals={"device_match": False},
        )
        registration = await promotions.record_referral_event(
            "player-2", "REGISTRATION_VERIFIED", "registration-event-1",
        )
        deposit = await promotions.record_referral_event(
            "player-2", "FIRST_DEPOSIT_VERIFIED", "deposit-event-verified-1",
        )
        self.assertEqual(registration["task"]["referral_id"], relationship["id"])
        for task in (registration["task"], deposit["task"]):
            self.assertEqual(
                task["reward_rate_snapshot"]["version"],
                finance.conversion_snapshot()["version"],
            )
            reviewed = await promotions.review_referral_task(
                task["id"], "admin-reviewer", approve=True,
                reason="Identity and deposit evidence verified",
            )
            self.assertEqual(reviewed["status"], "VERIFIED")
        summary = await promotions.referral_summary("player-1")
        self.assertEqual(summary["rewards"]["verified_amount"], 20)
        self.assertEqual(summary["rewards"]["progress_percent"], 100)
        self.assertTrue(summary["rewards"]["claimable"])
        for task in summary["tasks"]:
            self.assertIn("fraud_review", task)
            self.assertIn("referral_id", task)
            self.assertNotIn("user_id", task)
            self.assertNotIn("invited_user_id", task)
            self.assertNotIn("event_id", task)
            self.assertNotIn("idempotency_key", task)
            self.assertNotIn("request_hash", task)
            self.assertNotIn("per_user_cap_chips", task)
            self.assertNotIn("daily_cap_chips", task)
            self.assertNotIn("campaign_cap_chips", task)
        claimed = await promotions.claim_referral_rewards("player-1", "referral-claim-01")
        retried = await promotions.claim_referral_rewards("player-1", "referral-claim-01")
        self.assertEqual(claimed["claim"]["reward_chips"], 20)
        self.assertEqual(
            claimed["claim"]["reward_rate_snapshot"]["version"],
            finance.conversion_snapshot()["version"],
        )
        self.assertTrue(retried["duplicate"])
        wallet = await self.db.wallet_accounts.find_one({"user_id": "player-1"})
        self.assertEqual(wallet["available_cash_chips"], 100)
        self.assertEqual(wallet["available_bonus_chips"], 20)
        sources = await finance.bonus_lots_public("player-1")
        referral_sources = [
            row for row in sources if row.get("referral_claim_id") == claimed["claim"]["id"]
        ]
        self.assertEqual(len(referral_sources), 1)
        self.assertEqual(referral_sources[0]["source_type"], "REFERRAL_REWARD")
        withdrawal = await promotions.withdrawal_eligibility_projection("player-1", 120)
        self.assertFalse(withdrawal["allowed"])
        self.assertEqual(withdrawal["meta"]["controlling_missions"], [])
        self.assertIsNone(withdrawal["meta"]["active_mission"])
        self.assertTrue(any(
            row.get("referral_claim_id") == claimed["claim"]["id"]
            for row in withdrawal["meta"]["restricted_bonus_sources"]
        ))

    async def test_production_referral_readiness_requires_trusted_https_invite_origin(self):
        with patch.dict(os.environ, {
            "APP_ENV": "production",
            "PROMOTIONS_PUBLIC_APP_ORIGIN": "http://chakri.example.test",
        }):
            unsafe = promotions.feature_status(promotions.REFERRAL)
            self.assertFalse(unsafe["requirements"]["trusted_public_invite_origin"])
            self.assertFalse(unsafe["enabled"])
        with patch.dict(os.environ, {
            "APP_ENV": "production",
            "PROMOTIONS_PUBLIC_APP_ORIGIN": "https://chakri.example.test",
        }):
            safe = promotions.feature_status(promotions.REFERRAL)
            self.assertTrue(safe["requirements"]["trusted_public_invite_origin"])
            self.assertTrue(safe["enabled"])

    async def test_same_verified_contact_requires_review_and_supports_appeal(self):
        await self.db.users.update_many(
            {"id": {"$in": ["player-1", "player-2"]}},
            {"$set": {
                "phone": "+919999999999", "phone_normalized": "+919999999999",
                "phone_verified": True,
            }},
        )
        await self.activate_campaign("REFERRAL")
        inviter = await promotions.get_or_create_referral_profile("player-1")
        relationship = await promotions.attach_player_referral(
            "player-2", inviter["invite_code"], jurisdiction="IN",
            consented_at=datetime.now(timezone.utc),
        )
        self.assertEqual(relationship["fraud_review_status"], "REVIEW_REQUIRED")
        self.assertEqual(
            relationship["risk_signals"], {"DUPLICATE_VERIFIED_PHONE": True},
        )
        registration = await promotions.record_referral_event(
            "player-2", "REGISTRATION_VERIFIED", "same-contact-registration",
        )
        with self.assertRaises(promotions.PromotionError) as blocked:
            await promotions.review_referral_task(
                registration["task"]["id"], "admin-reviewer", approve=True,
                reason="Registration event is otherwise verified",
            )
        self.assertEqual(blocked.exception.code, "REFERRAL_FRAUD_REVIEW_REQUIRED")

        rejected = await promotions.review_referral_fraud(
            relationship["id"], "admin-fraud", decision="REJECT",
            reason_code="DUPLICATE_VERIFIED_CONTACT",
            reason="Both accounts use the same independently verified mobile number",
        )
        self.assertEqual(rejected["status"], "REJECTED")
        stored_task = await self.db.reward_claims.find_one({"id": registration["task"]["id"]})
        self.assertEqual(stored_task["rejection_reason_code"], "DUPLICATE_VERIFIED_CONTACT")
        appeal = await promotions.request_referral_appeal(
            "player-1", relationship["id"],
            "The inviter asks support to review the duplicate-contact decision.",
        )
        self.assertEqual(appeal["status"], "APPEAL_PENDING")
        cleared = await promotions.review_referral_fraud(
            relationship["id"], "admin-appeal", decision="CLEAR",
            reason_code="APPEAL_EVIDENCE_ACCEPTED",
            reason="Independent support evidence resolved the apparent contact match",
        )
        self.assertEqual(cleared["status"], "CLEARED")
        reopened = await self.db.reward_claims.find_one({"id": registration["task"]["id"]})
        self.assertEqual(reopened["status"], "PENDING")

    async def test_same_verified_kyc_identity_requires_review(self):
        raw_token = "provider-identity-token-shared-0001"
        for user_id in ("player-1", "player-2"):
            await finance.review_player_kyc(
                user_id, "VERIFIED", "admin-kyc", "Provider identity verified",
                identity_evidence_token=raw_token,
            )
        users = await self.db.users.find(
            {"id": {"$in": ["player-1", "player-2"]}}, {"_id": 0},
        ).to_list(length=2)
        self.assertNotIn(raw_token, str(users))
        self.assertEqual(users[0]["kyc_identity_cluster"], users[1]["kyc_identity_cluster"])
        await self.activate_campaign("REFERRAL")
        inviter = await promotions.get_or_create_referral_profile("player-1")
        relationship = await promotions.attach_player_referral(
            "player-2", inviter["invite_code"], jurisdiction="IN",
            consented_at=datetime.now(timezone.utc),
        )
        self.assertEqual(relationship["fraud_review_status"], "REVIEW_REQUIRED")
        self.assertEqual(
            relationship["risk_signals"], {"DUPLICATE_KYC_IDENTITY": True},
        )

    async def test_new_shared_payment_cluster_reopens_review_and_blocks_claim(self):
        await self.activate_campaign("REFERRAL")
        inviter = await promotions.get_or_create_referral_profile("player-1")
        relationship = await promotions.attach_player_referral(
            "player-2", inviter["invite_code"], jurisdiction="IN",
            consented_at=datetime.now(timezone.utc),
        )
        registration = await promotions.record_referral_event(
            "player-2", "REGISTRATION_VERIFIED", "payment-cluster-registration",
        )
        deposit = await promotions.record_referral_event(
            "player-2", "FIRST_DEPOSIT_VERIFIED", "payment-cluster-deposit",
        )
        for row in (registration, deposit):
            await promotions.review_referral_task(
                row["task"]["id"], "admin-reviewer", approve=True,
                reason="Authoritative event passed initial review",
            )
        shared_fingerprint = "privacy-safe-existing-payment-fingerprint"
        await self.db.payout_methods.insert_many([
            {
                "id": "payment-method-inviter", "user_id": "player-1",
                "fingerprint": shared_fingerprint, "status": "ACTIVE",
            },
            {
                "id": "payment-method-invited", "user_id": "player-2",
                "fingerprint": shared_fingerprint, "status": "ACTIVE",
            },
        ])
        with self.assertRaises(promotions.PromotionError) as blocked:
            await promotions.claim_referral_rewards(
                "player-1", "shared-payment-cluster-claim",
            )
        self.assertEqual(blocked.exception.code, "REFERRAL_FRAUD_REVIEW_REQUIRED")
        stored = await self.db.player_referrals.find_one({"id": relationship["id"]})
        self.assertEqual(stored["fraud_review_status"], "REVIEW_REQUIRED")
        self.assertEqual(
            stored["risk_signals"], {"DUPLICATE_PAYMENT_INSTRUMENT": True},
        )

    async def test_device_only_signal_can_be_cleared_but_never_rejected(self):
        device_token = promotions.privacy_safe_risk_cluster(
            "device", "server-ip-and-user-agent-cluster",
        )
        await self.db.users.update_many(
            {"id": {"$in": ["player-1", "player-2"]}},
            {"$set": {"referral_risk_clusters": {"device": [device_token]}}},
        )
        await self.activate_campaign("REFERRAL")
        inviter = await promotions.get_or_create_referral_profile("player-1")
        relationship = await promotions.attach_player_referral(
            "player-2", inviter["invite_code"], jurisdiction="IN",
            consented_at=datetime.now(timezone.utc),
        )
        self.assertEqual(relationship["fraud_review_status"], "REVIEW_REQUIRED")
        with self.assertRaises(promotions.PromotionError) as blocked:
            await promotions.review_referral_fraud(
                relationship["id"], "admin-fraud", decision="REJECT",
                reason_code="SHARED_DEVICE_CLUSTER",
                reason="Both registrations have the same weak device signal",
            )
        self.assertEqual(blocked.exception.code, "DEVICE_ONLY_REJECTION_NOT_ALLOWED")
        cleared = await promotions.review_referral_fraud(
            relationship["id"], "admin-fraud", decision="CLEAR",
            reason_code="DEVICE_SIGNAL_REVIEWED",
            reason="Device evidence alone is insufficient for a rejection",
        )
        self.assertEqual(cleared["status"], "CLEARED")

    async def test_referral_outbox_drains_when_auto_withdrawals_are_false(self):
        stamp = datetime.now(timezone.utc)
        await self.db.financial_outbox.insert_many([
            {
                "id": "promotion-outbox-event", "kind": "PROMOTION_REFERRAL_EVENT",
                "dedupe_key": "promotion-referral:deposit-one",
                "aggregate_id": "deposit-one", "status": "PENDING",
                "next_attempt_at": stamp - timedelta(seconds=1),
                "created_at": stamp - timedelta(seconds=1),
                "payload": {
                    "invited_user_id": "player-2",
                    "event_type": "FIRST_DEPOSIT_VERIFIED",
                    "source_event_id": "deposit-one",
                },
            },
            {
                "id": "payout-outbox-event", "kind": "SUBMIT_PAYOUT",
                "dedupe_key": "payout:withdrawal-one",
                "aggregate_id": "withdrawal-one", "status": "PENDING",
                "next_attempt_at": stamp - timedelta(seconds=1),
                "created_at": stamp,
                "payload": {},
            },
        ])
        with patch.dict(os.environ, {"AUTO_WITHDRAWALS_ENABLED": "false"}), patch.object(
            promotions, "record_referral_event", new=AsyncMock(return_value=None),
        ) as referral_handler, patch.object(
            finance, "submit_automatic_withdrawal", new=AsyncMock(),
        ) as payout_handler:
            include_payouts = finance.financial_status()["features"]["automatic_withdrawals"]
            result = await finance.process_outbox_batch(
                object(), limit=10, include_payouts=include_payouts,
            )
        self.assertEqual(result["processed"], 1)
        referral_handler.assert_awaited_once()
        payout_handler.assert_not_awaited()
        promotion_row = await self.db.financial_outbox.find_one({"id": "promotion-outbox-event"})
        payout_row = await self.db.financial_outbox.find_one({"id": "payout-outbox-event"})
        self.assertEqual(promotion_row["status"], "COMPLETED")
        self.assertEqual(payout_row["status"], "PENDING")

    async def test_referral_summary_never_combines_incompatible_reward_groups(self):
        stamp = datetime.now(timezone.utc)
        rows = []
        for index, (version, reward_type) in enumerate(((1, "BONUS_CHIPS"), (2, "CASH_CREDIT"))):
            rows.append({
                "id": f"incompatible-task-{index}", "kind": "TASK",
                "referral_id": f"incompatible-referral-{index}",
                "task_key": "REGISTRATION_VERIFIED",
                "event_id": f"incompatible-event-{index}", "user_id": "player-1",
                "invited_user_id": f"invited-{index}", "campaign_id": "referral-mixed",
                "campaign_version": version, "terms_version": f"referral-v{version}",
                "reward_type": reward_type, "reward_chips": 10, "reward_paise": 1_000,
                "claim_threshold_chips": 20, "status": "VERIFIED",
                "created_at": stamp + timedelta(seconds=index), "updated_at": stamp,
            })
        await self.db.reward_claims.insert_many(rows)
        summary = await promotions.referral_summary("player-1")
        self.assertEqual(summary["rewards"]["verified_amount"], 10)
        self.assertEqual(summary["rewards"]["total_verified_amount"], 20)
        self.assertEqual(summary["rewards"]["progress_percent"], 50)
        self.assertFalse(summary["rewards"]["claimable"])
        self.assertEqual(
            summary["rewards"]["disabled_reason"],
            "REWARDS_SPAN_CAMPAIGN_VERSIONS",
        )
        with self.assertRaises(promotions.PromotionError) as blocked:
            await promotions.claim_referral_rewards("player-1", "incompatible-claim-key")
        self.assertEqual(blocked.exception.code, "REFERRAL_REWARD_NOT_CLAIMABLE")

    async def test_referral_summary_and_claim_choose_same_complete_group(self):
        stamp = datetime.now(timezone.utc)
        await self.add_cleared_referral_relationship("ref-a", "invited-a")
        await self.add_cleared_referral_relationship("ref-b", "invited-b")
        await self.db.reward_claims.insert_many([
            {
                "id": "complete-group-b", "kind": "TASK", "referral_id": "ref-b",
                "task_key": "REGISTRATION_VERIFIED", "event_id": "event-b",
                "user_id": "player-1", "invited_user_id": "invited-b",
                "campaign_id": "campaign-b", "campaign_version": 2,
                "terms_version": "b-v2", "reward_type": "BONUS_CHIPS",
                "reward_chips": 10, "reward_paise": 1_000,
                "claim_threshold_chips": 10, "status": "VERIFIED",
                "created_at": stamp, "updated_at": stamp,
            },
            {
                "id": "complete-group-a", "kind": "TASK", "referral_id": "ref-a",
                "task_key": "REGISTRATION_VERIFIED", "event_id": "event-a",
                "user_id": "player-1", "invited_user_id": "invited-a",
                "campaign_id": "campaign-a", "campaign_version": 1,
                "terms_version": "a-v1", "reward_type": "BONUS_CHIPS",
                "reward_chips": 10, "reward_paise": 1_000,
                "claim_threshold_chips": 10, "status": "VERIFIED",
                "created_at": stamp + timedelta(seconds=1), "updated_at": stamp,
            },
        ])
        summary = await promotions.referral_summary("player-1")
        self.assertEqual(summary["rewards"]["compatible_campaign_id"], "campaign-a")
        claimed = await promotions.claim_referral_rewards(
            "player-1", "same-referral-group-claim",
        )
        self.assertEqual(claimed["claim"]["campaign_id"], "campaign-a")
        self.assertEqual(claimed["claim"]["campaign_version"], 1)

    async def test_concurrent_referral_approvals_serialize_shared_caps(self):
        stamp = datetime.now(timezone.utc)
        tasks = []
        for index in range(2):
            await self.add_cleared_referral_relationship(
                f"cap-referral-{index}", f"cap-invited-{index}",
            )
            tasks.append({
                "id": f"cap-task-{index}", "kind": "TASK",
                "referral_id": f"cap-referral-{index}", "task_key": "REGISTRATION_VERIFIED",
                "event_id": f"cap-event-{index}", "user_id": "player-1",
                "invited_user_id": f"cap-invited-{index}", "campaign_id": "cap-campaign",
                "campaign_version": 1, "terms_version": "cap-terms-v1",
                "reward_type": "BONUS_CHIPS", "reward_chips": 10, "reward_paise": 1_000,
                "claim_threshold_chips": 10, "per_user_cap_chips": 10,
                "daily_cap_chips": 10, "campaign_cap_chips": 10,
                "status": "PENDING", "verify_after": stamp - timedelta(seconds=1),
                "created_at": stamp, "updated_at": stamp,
            })
        await self.db.reward_claims.insert_many(tasks)
        results = await asyncio.gather(*[
            promotions.review_referral_task(
                row["id"], "admin-reviewer", approve=True,
                reason="Verified referral evidence",
            ) for row in tasks
        ], return_exceptions=True)
        stored = await self.db.reward_claims.find({
            "id": {"$in": [row["id"] for row in tasks]},
        }).to_list(length=None)
        verified_total = sum(
            int(row["reward_chips"]) for row in stored if row["status"] == "VERIFIED"
        )
        counter = await self.db.referral_reward_counters.find_one({"key": "cap-campaign:1"})
        self.assertEqual(verified_total, 10)
        self.assertEqual(counter["approved_chips"], verified_total)
        self.assertEqual(sum(isinstance(row, Exception) for row in results), 1)

    async def test_concurrent_approve_reject_never_leaks_referral_cap(self):
        stamp = datetime.now(timezone.utc)
        await self.add_cleared_referral_relationship(
            "approve-reject-referral", "approve-reject-invited",
        )
        task = {
            "id": "approve-reject-task", "kind": "TASK",
            "referral_id": "approve-reject-referral", "task_key": "REGISTRATION_VERIFIED",
            "event_id": "approve-reject-event", "user_id": "player-1",
            "invited_user_id": "approve-reject-invited", "campaign_id": "review-race",
            "campaign_version": 1, "terms_version": "review-race-v1",
            "reward_type": "BONUS_CHIPS", "reward_chips": 10, "reward_paise": 1_000,
            "claim_threshold_chips": 10, "per_user_cap_chips": 10,
            "daily_cap_chips": 10, "campaign_cap_chips": 10,
            "status": "PENDING", "verify_after": stamp - timedelta(seconds=1),
            "created_at": stamp, "updated_at": stamp,
        }
        await self.db.reward_claims.insert_one(task)
        await asyncio.gather(
            promotions.review_referral_task(
                task["id"], "admin-approve", approve=True,
                reason="Verified referral evidence",
            ),
            promotions.review_referral_task(
                task["id"], "admin-reject", approve=False,
                reason="Evidence failed review",
            ),
            return_exceptions=True,
        )
        stored = await self.db.reward_claims.find_one({"id": task["id"]})
        counter = await self.db.referral_reward_counters.find_one({"key": "review-race:1"}) or {}
        expected = 10 if stored["status"] == "VERIFIED" else 0
        self.assertIn(stored["status"], {"VERIFIED", "REJECTED"})
        self.assertEqual(int(counter.get("approved_chips", 0)), expected)

    async def test_admin_audit_and_referral_detail_redact_sensitive_evidence(self):
        await promotions._audit(
            "admin-auditor", "REFERRAL_FRAUD_REVIEWED", "REFERRAL", "safe-referral",
            reason="Reviewed referral evidence",
            metadata={
                "campaign_id": "safe-campaign", "reward_chips": 10,
                "device_fingerprint": "must-not-leak", "bank_account": "must-not-leak",
                "status": {"device_evidence": "must-not-leak-through-safe-key"},
            },
        )
        history = await promotions.list_promotion_audit(
            entity_type="referral", entity_id="safe-referral",
            action="referral_fraud_reviewed", page=1, limit=1,
        )
        self.assertEqual(history["total"], 1)
        self.assertEqual(history["audits"][0]["metadata"], {
            "campaign_id": "safe-campaign", "reward_chips": 10,
        })
        self.assertNotIn("must-not-leak-through-safe-key", str(history))
        await self.db.player_referrals.insert_one({
            "id": "safe-referral", "kind": "RELATIONSHIP",
            "invited_user_id": "player-2", "inviter_user_id": "player-1",
            "campaign_id": "safe-campaign", "campaign_version": 1,
            "terms_version": "safe-terms-v1", "jurisdiction": "IN",
            "status": "PENDING", "risk_signals": {
                "device_match": "secret-device-value", "ip_cluster": "secret-ip-value",
            },
            "campaign_snapshot": {"internal": "full-version-snapshot"},
            "risk_evidence_digest": "secret-risk-digest",
            "fraud_review_reason_code": "MANUAL_REVIEW_REQUIRED",
            "fraud_review_reason": "secret-identity-review-narrative",
            "invite_code_used": "secret-invite-code",
            "identity_secret": "secret-identity-record",
            "created_at": datetime.now(timezone.utc),
        })
        stamp = datetime.now(timezone.utc)
        await self.db.referral_events.insert_one({
            "id": "safe-referral-event", "referral_id": "safe-referral",
            "event_type": "FIRST_DEPOSIT_VERIFIED", "occurred_at": stamp,
            "created_at": stamp, "source_event_id": "secret-payment-record",
            "source_key": "secret-payment-source-key",
            "request_hash": "secret-referral-event-request-hash",
            "metadata": {
                "device_fingerprint": "secret-event-device",
                "bank_account": "secret-event-bank",
            },
        })
        await self.db.reward_claims.insert_one({
            "id": "safe-referral-task", "kind": "TASK",
            "referral_id": "safe-referral", "task_key": "FIRST_DEPOSIT_VERIFIED",
            "event_id": "safe-referral-event", "user_id": "player-1",
            "invited_user_id": "player-2", "campaign_id": "safe-campaign",
            "campaign_version": 1, "terms_version": "safe-terms-v1",
            "reward_type": "BONUS_CHIPS", "reward_chips": 10,
            "reward_paise": 1_000, "claim_threshold_chips": 20,
            "status": "PENDING", "verify_after": stamp,
            "created_at": stamp, "updated_at": stamp,
            "idempotency_key": "secret-referral-idempotency",
            "request_hash": "secret-referral-task-request-hash",
            "wallet_operation_id": "secret-wallet-operation",
            "source_allocation": {"bonus_lot_ids": ["secret-bonus-lot"]},
            "raw_risk_evidence": {"payment": "secret-payment-token"},
        })
        detail = await promotions.admin_referral_detail("safe-referral")
        self.assertNotIn("risk_signals", detail["referral"])
        self.assertNotIn("campaign_snapshot", detail["referral"])
        self.assertEqual(
            detail["fraud_review"]["signal_names"], ["device_match", "ip_cluster"],
        )
        self.assertEqual(detail["fraud_review"]["reason"], "MANUAL_REVIEW_REQUIRED")
        self.assertEqual(detail["events"][0]["id"], "safe-referral-event")
        self.assertEqual(
            detail["events"][0]["event_type"], "FIRST_DEPOSIT_VERIFIED",
        )
        self.assertEqual(detail["tasks"][0]["id"], "safe-referral-task")
        self.assertEqual(detail["tasks"][0]["reward_chips"], 10)
        listed = await promotions.list_admin_referral_tasks(
            status="pending", limit=100,
        )
        self.assertEqual([row["id"] for row in listed], ["safe-referral-task"])
        for unsafe_key in (
            "idempotency_key", "request_hash", "wallet_operation_id",
            "source_allocation", "bonus_lot_ids", "raw_risk_evidence",
            "metadata", "source_key", "source_event_id", "invite_code_used",
            "identity_secret",
        ):
            self.assertNotIn(unsafe_key, detail["referral"])
            self.assertNotIn(unsafe_key, detail["events"][0])
            self.assertNotIn(unsafe_key, detail["tasks"][0])
            self.assertNotIn(unsafe_key, listed[0])
        self.assertNotIn("secret-device-value", str(detail))
        for secret in (
            "secret-identity-review-narrative", "secret-identity-record",
            "secret-invite-code", "secret-risk-digest", "secret-payment-record",
            "secret-payment-source-key", "secret-event-device", "secret-event-bank",
            "secret-referral-idempotency", "secret-referral-task-request-hash",
            "secret-wallet-operation", "secret-bonus-lot", "secret-payment-token",
        ):
            self.assertNotIn(secret, str(detail))
            self.assertNotIn(secret, str(listed))

        await self.db.reward_claims.update_one(
            {"id": "safe-referral-task"},
            {"$set": {
                "status": "REJECTED",
                "review_reason": "secret free-form operator investigation narrative",
                "rejection_reason_code": "TASK_EVIDENCE_NOT_VERIFIED",
            }},
        )
        player_summary = await promotions.referral_summary("player-1")
        self.assertNotIn("secret free-form operator", str(player_summary))
        self.assertEqual(
            player_summary["tasks"][0]["rejection_reason"],
            "The task evidence could not be verified. Contact support if you believe this is incorrect.",
        )

    async def test_admin_mission_detail_allowlists_events_claims_and_audit(self):
        _, mission = await self.activate_mission(
            deposit_id="admin-redaction-deposit", chips=100,
        )
        mission_id = mission["id"]
        stamp = datetime.now(timezone.utc)
        await self.db.wager_events.insert_one({
            "id": "admin-redaction-event", "mission_id": mission_id,
            "user_id": "player-1", "bet_id": "safe-bet-reference",
            "bet_reference": "safe-round-reference", "event_type": "SETTLED",
            "source_event_id": "safe-ledger-event", "game": "aviator",
            "stake_chips": 100, "contribution_chips": 100,
            "occurred_at": stamp, "created_at": stamp,
            "source_key": "secret-wager-source-key",
            "request_hash": "secret-wager-request-hash",
            "source_allocation": {
                "cash_chips": 40, "bonus_chips": 60,
                "bonus_lot_ids": ["secret-wager-bonus-lot"],
            },
            "wallet_operation_id": "secret-wager-wallet-operation",
        })
        await self.db.bonus_claims.insert_one({
            "id": "admin-redaction-claim", "mission_id": mission_id,
            "user_id": "player-1", "campaign_id": mission["campaign_id"],
            "campaign_version": mission["campaign_version"],
            "reward_type": "BONUS_CHIPS", "reward_chips": 50,
            "reward_paise": 5_000, "status": "CLAIMED", "claimed_at": stamp,
            "idempotency_key": "secret-claim-idempotency",
            "request_hash": "secret-claim-request-hash",
            "wallet_operation_id": "secret-claim-wallet-operation",
            "bonus_lot_ids": ["secret-claim-bonus-lot"],
        })
        await promotions._audit(
            "admin-redaction-auditor", "MISSION_REVIEWED", "MISSION", mission_id,
            reason="Reviewed authoritative contribution evidence",
            metadata={
                "bet_id": "safe-bet-reference", "contribution_chips": 100,
                "request_hash": "secret-audit-request-hash",
                "device_fingerprint": "secret-audit-device",
                "payment_token": "secret-audit-payment-token",
                "arbitrary": {"identity": "secret-audit-identity"},
            },
        )

        detail = await promotions.admin_mission_detail(mission_id)

        self.assertEqual(detail["mission"]["id"], mission_id)
        self.assertEqual(detail["mission"]["progress"]["target_chips"], 100)
        self.assertEqual(detail["events"][0]["id"], "admin-redaction-event")
        self.assertEqual(detail["events"][0]["bet_id"], "safe-bet-reference")
        self.assertEqual(detail["events"][0]["contribution_chips"], 100)
        self.assertEqual(detail["claims"][0]["id"], "admin-redaction-claim")
        self.assertEqual(detail["claims"][0]["reward_chips"], 50)
        reviewed = next(
            row for row in detail["audit"] if row["action"] == "MISSION_REVIEWED"
        )
        self.assertEqual(reviewed["metadata"], {
            "bet_id": "safe-bet-reference", "contribution_chips": 100,
        })
        for unsafe_key in (
            "idempotency_key", "request_hash", "source_allocation",
            "bonus_lot_ids", "wallet_operation_id",
        ):
            self.assertNotIn(unsafe_key, detail["events"][0])
            self.assertNotIn(unsafe_key, detail["claims"][0])
            self.assertNotIn(unsafe_key, reviewed["metadata"])
        for secret in (
            "secret-wager-source-key", "secret-wager-request-hash",
            "secret-wager-bonus-lot", "secret-wager-wallet-operation",
            "secret-claim-idempotency", "secret-claim-request-hash",
            "secret-claim-wallet-operation", "secret-claim-bonus-lot",
            "secret-audit-request-hash", "secret-audit-device",
            "secret-audit-payment-token", "secret-audit-identity",
        ):
            self.assertNotIn(secret, str(detail))

    async def test_randomized_referral_rewards_remain_fail_closed(self):
        spec = referral_spec()
        spec["referral_tasks"]["REGISTRATION_VERIFIED"] = {
            "reward_mode": "RANDOM", "reward_chips": 10,
        }
        with self.assertRaises(promotions.PromotionError) as blocked:
            promotions.validate_campaign_spec("REFERRAL", spec)
        self.assertEqual(blocked.exception.code, "RANDOM_REWARDS_NOT_APPROVED")

    async def test_unexpected_eligibility_failure_never_leaks_infrastructure_details(self):
        user = {"id": "player-1", "role": "PLAYER", "status": "ACTIVE"}
        with patch.object(
            compliance, "assert_playable",
            new=AsyncMock(side_effect=RuntimeError("mongodb://secret-host")),
        ):
            with self.assertRaises(HTTPException) as unavailable:
                await routes_promotions.require_new_bonus_participant(user)
        self.assertEqual(unavailable.exception.status_code, 503)
        self.assertEqual(
            unavailable.exception.detail["code"],
            "PROMOTION_ELIGIBILITY_UNAVAILABLE",
        )
        self.assertNotIn("secret-host", str(unavailable.exception.detail))

        with patch.object(
            compliance, "assert_not_excluded",
            new=AsyncMock(side_effect=RuntimeError("mongodb://service-secret-host")),
        ):
            with self.assertRaises(promotions.PromotionError) as service_unavailable:
                await promotions._assert_new_bonus_participation_allowed("player-1")
        self.assertEqual(service_unavailable.exception.status_code, 503)
        self.assertEqual(
            service_unavailable.exception.code,
            "PROMOTION_ELIGIBILITY_UNAVAILABLE",
        )
        self.assertNotIn("service-secret-host", service_unavailable.exception.message)


if __name__ == "__main__":
    unittest.main()
