"""Fail-closed wager missions and player referral rewards.

This module deliberately does not register routes or observers at import time.
The application must wire the routers and the ledger/deposit hooks explicitly,
and every mutation remains disabled until the regulatory and source-wallet
readiness gates pass.

Deposited cash is never locked by this domain.  A wager mission controls only
an unearned promotional reward; claiming that reward creates a separately
audited wallet movement.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable, Mapping, Optional
from urllib.parse import quote, urlsplit

from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError

from db import db
import compliance
import financial_wallet as finance


logger = logging.getLogger(__name__)


WAGER = "WAGER"
REFERRAL = "REFERRAL"

OFFER_REVIEW = "OFFER_REVIEW"
ACTIVE = "ACTIVE"
PENDING_SETTLEMENT = "PENDING_SETTLEMENT"
CLAIMABLE = "CLAIMABLE"
CLAIMED = "CLAIMED"
EXPIRED = "EXPIRED"
FORFEITED = "FORFEITED"
PAUSED_FOR_REVIEW = "PAUSED_FOR_REVIEW"

MISSION_OPEN_STATES = (ACTIVE, PENDING_SETTLEMENT, CLAIMABLE)
MISSION_EVENT_STATES = (*MISSION_OPEN_STATES, CLAIMED, PAUSED_FOR_REVIEW)
REWARD_TYPES = ("CASH_CREDIT", "BONUS_CHIPS")
WAGER_EVENT_TYPES = ("STAKE", "SETTLED", "VOID", "REFUND")
REFERRAL_EVENT_TYPES = ("REGISTRATION_VERIFIED", "FIRST_DEPOSIT_VERIFIED")
PROMOTION_SCHEMA_VERSION = 2

IDEMPOTENCY_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{7,159}$")
CAMPAIGN_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{2,63}$")
INVITE_CODE_RE = re.compile(r"^[A-Z0-9]{8,20}$")
POLICY_VERSION_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$")

_PROMOTION_CORE_READY = False
_PROMOTION_CORE_ERRORS: list[str] = ["Promotion core has not been prepared"]

_REQUIRED_PROMOTION_INDEXES = {
    "promotion_campaigns": {
        "promotion_campaign_id_unique", "promotion_campaign_type_status",
    },
    "promotion_versions": {
        "promotion_version_campaign_unique", "promotion_version_offer_lookup",
    },
    "promotion_consents": {
        "promotion_consent_id_unique", "promotion_consent_user_idempotency_unique",
        "promotion_consent_deposit_unique",
    },
    "wager_missions": {
        "wager_mission_id_unique", "wager_mission_deposit_campaign_unique",
        "wager_mission_user_status_deadline", "wager_mission_finality_due",
    },
    "wager_events": {
        "wager_event_source_unique", "wager_event_mission_bet_timeline",
        "wager_event_stake_allocation_unique",
    },
    "bonus_claims": {
        "bonus_claim_id_unique", "bonus_claim_mission_unique",
        "bonus_claim_user_idempotency_unique",
    },
    "player_referrals": {
        "player_referral_invite_code_unique", "player_referral_profile_user_unique",
        "player_referral_invited_user_unique", "player_referral_inviter_created",
    },
    "referral_events": {"referral_event_source_unique", "referral_event_type_lookup"},
    "reward_claims": {
        "reward_claim_id_unique", "reward_task_referral_key_unique",
        "reward_claim_user_idempotency_unique", "reward_claim_task_set_unique",
        "reward_claim_user_status",
    },
    "promotion_audit": {"promotion_audit_id_unique", "promotion_audit_entity_created"},
    "wager_reward_counters": {"wager_reward_counter_key_unique"},
    "referral_reward_counters": {"referral_reward_counter_key_unique"},
    "promotion_quotes": {"promotion_quote_id_unique", "promotion_quote_expiry"},
}


class PromotionError(RuntimeError):
    def __init__(
        self, code: str, message: str, status_code: int = 400,
        *, meta: Optional[Mapping[str, Any]] = None,
    ):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = int(status_code)
        self.meta = dict(meta or {})


def now() -> datetime:
    return datetime.now(timezone.utc)


def _session_kwargs(session) -> dict[str, Any]:
    return {"session": session} if session is not None else {}


def _env_true(name: str, environ: Optional[Mapping[str, str]] = None) -> bool:
    env = os.environ if environ is None else environ
    return str(env.get(name, "false")).strip().lower() == "true"


def _settlement_finality_certification_status(
    environ: Optional[Mapping[str, str]] = None,
) -> dict[str, Any]:
    """Describe external wager-settlement finality certification.

    The runtime policy version and the independently certified version are
    deliberately separate inputs.  A boolean alone cannot prove which policy
    was reviewed, and one version input cannot detect configuration drift.
    """
    env = os.environ if environ is None else environ
    policy_version = str(
        env.get("WAGER_SETTLEMENT_FINALITY_POLICY_VERSION") or ""
    ).strip()
    certified_version = str(
        env.get("WAGER_SETTLEMENT_FINALITY_CERTIFIED_POLICY_VERSION") or ""
    ).strip()
    policy_valid = bool(POLICY_VERSION_RE.fullmatch(policy_version))
    certified_valid = bool(POLICY_VERSION_RE.fullmatch(certified_version))
    certified = _env_true("WAGER_SETTLEMENT_FINALITY_CERTIFIED", env)
    return {
        "certified": certified,
        "policy_version": policy_version if policy_valid else None,
        "certified_policy_version": certified_version if certified_valid else None,
        "versions_match": bool(
            policy_valid and certified_valid and policy_version == certified_version
        ),
    }


def _referral_risk_pepper_configured(
    environ: Optional[Mapping[str, str]] = None,
) -> bool:
    env = os.environ if environ is None else environ
    return len(str(env.get("REFERRAL_RISK_PEPPER") or "")) >= 32


def _approved_public_app_origin(
    environ: Optional[Mapping[str, str]] = None,
) -> Optional[str]:
    env = os.environ if environ is None else environ
    raw = str(env.get("PROMOTIONS_PUBLIC_APP_ORIGIN") or "").strip().rstrip("/")
    try:
        parsed = urlsplit(raw)
        port = parsed.port
    except ValueError:
        return None
    production = str(env.get("APP_ENV") or "").strip().lower() in {"prod", "production"}
    allowed_schemes = {"https"} if production else {"http", "https"}
    if (
        not parsed.hostname or parsed.username or parsed.password
        or parsed.query or parsed.fragment or parsed.path not in {"", "/"}
        or parsed.scheme not in allowed_schemes
        or (parsed.scheme == "https" and port not in {None, 443})
        or (production and port is not None)
    ):
        return None
    return raw


def feature_status(
    feature: str, environ: Optional[Mapping[str, str]] = None,
) -> dict[str, Any]:
    """Return a secret-free, fail-closed readiness projection."""
    feature = str(feature).strip().upper()
    if feature not in {WAGER, REFERRAL}:
        raise ValueError("Unknown promotion feature")
    env = os.environ if environ is None else environ
    required = {
        "regulatory_approved": _env_true("REGULATORY_APPROVED", env),
        "real_money_enabled": _env_true("REAL_MONEY_ENABLED", env),
        "feature_enabled": _env_true(
            "WAGER_MISSIONS_ENABLED" if feature == WAGER else "REFERRAL_REWARDS_ENABLED",
            env,
        ),
        "promotion_core_ready": bool(_PROMOTION_CORE_READY),
        "financial_core_ready": bool(finance.financial_status(env).get("ready", False)),
    }
    if feature == WAGER:
        finality = _settlement_finality_certification_status(env)
        required.update({
            "game_wallet_code_certified": bool(finance.GAME_WALLET_INTEGRATION_READY),
            "financial_game_wallet_integration_attested": _env_true(
                "FINANCIAL_GAME_WALLET_INTEGRATED", env,
            ),
            "promotion_wallet_integration_attested": _env_true(
                "PROMOTIONS_GAME_WALLET_INTEGRATED", env,
            ),
            "settlement_finality_certified": bool(finality["certified"]),
            "settlement_finality_policy_configured": bool(finality["policy_version"]),
            "settlement_finality_certified_policy_configured": bool(
                finality["certified_policy_version"]
            ),
            "settlement_finality_policy_matches_certification": bool(
                finality["versions_match"]
            ),
        })
    else:
        required["privacy_safe_risk_clustering"] = _referral_risk_pepper_configured(env)
        required["trusted_public_invite_origin"] = bool(_approved_public_app_origin(env))
    return {
        "feature": feature,
        "enabled": all(required.values()),
        "requirements": required,
    }


def feature_enabled(feature: str, environ: Optional[Mapping[str, str]] = None) -> bool:
    return bool(feature_status(feature, environ)["enabled"])


def require_feature(feature: str) -> None:
    status = feature_status(feature)
    if not status["enabled"]:
        raise PromotionError(
            "PROMOTION_FEATURE_NOT_READY",
            "This promotion feature is not available.",
            503,
            meta={"feature": status["feature"]},
        )


async def _assert_new_bonus_participation_allowed(user_id: str, *, session=None) -> None:
    """Apply self-exclusion at service seams that do not pass through a route."""
    try:
        await compliance.assert_not_excluded(str(user_id), session=session)
    except compliance.ComplianceBlock as exc:
        # ComplianceBlock owns a stable player-safe contract in ``detail``.
        detail = exc.detail if isinstance(exc.detail, Mapping) else {}
        raise PromotionError(
            str(detail.get("code") or "PROMOTION_PARTICIPATION_BLOCKED"),
            str(detail.get("message") or "New bonus participation is unavailable."),
            403,
        ) from exc
    except Exception as exc:
        logger.exception(
            "Promotion exclusion evaluation failed for player %s", user_id,
        )
        raise PromotionError(
            "PROMOTION_ELIGIBILITY_UNAVAILABLE",
            "Promotion eligibility is temporarily unavailable. Please try again later.",
            503,
        ) from exc


def randomized_rewards_enabled(
    environ: Optional[Mapping[str, str]] = None,
) -> bool:
    return _env_true("RANDOMIZED_REWARDS_LEGAL_APPROVED", environ)


def _canonical_hash(payload: Mapping[str, Any]) -> str:
    raw = json.dumps(
        payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True,
        default=lambda value: value.isoformat() if isinstance(value, datetime) else str(value),
    )
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def privacy_safe_risk_cluster(
    kind: str, value: Any, environ: Optional[Mapping[str, str]] = None,
) -> str:
    """Return a purpose-separated, non-reversible referral-risk token.

    Inputs are accepted only from trusted server evidence (verified contacts,
    KYC-provider identity tokens, payment-provider fingerprints and request
    metadata).  Raw inputs must never be written to promotion collections.
    """
    env = os.environ if environ is None else environ
    pepper = str(env.get("REFERRAL_RISK_PEPPER") or "")
    if len(pepper) < 32:
        raise PromotionError(
            "REFERRAL_RISK_CONFIGURATION_REQUIRED",
            "Referral risk controls are not configured.",
            503,
        )
    label = re.sub(r"[^a-z0-9_-]", "", str(kind or "").strip().lower())
    normalized = " ".join(str(value or "").strip().casefold().split())
    if not label or not normalized or len(normalized) > 1024:
        raise PromotionError(
            "INVALID_REFERRAL_RISK_EVIDENCE",
            "Referral risk evidence is invalid.",
        )
    digest = hmac.new(
        pepper.encode("utf-8"),
        f"chakri:referral-risk:v1:{label}:{normalized}".encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return f"rr1:{digest}"


def registration_risk_clusters(
    *, client_ip: Any = None, user_agent: Any = None,
) -> dict[str, list[str]]:
    """Build weak, server-derived registration signals without raw identifiers.

    These signals are review hints only.  A shared device/network signal can
    never by itself produce a rejection decision.
    """
    ip_value = str(client_ip or "").strip().lower()
    agent_value = " ".join(str(user_agent or "").strip().casefold().split())[:512]
    clusters: dict[str, list[str]] = {}
    if ip_value and ip_value != "unknown":
        clusters["network"] = [privacy_safe_risk_cluster("network", ip_value)]
    if agent_value:
        # Coupling the user agent to the authenticated peer address avoids
        # treating every installation of a common browser as one "device".
        device_material = f"{ip_value or 'unknown'}|{agent_value}"
        clusters["device"] = [privacy_safe_risk_cluster("device", device_material)]
    return clusters


def _validate_idempotency_key(value: str) -> str:
    clean = str(value or "").strip()
    if not IDEMPOTENCY_RE.fullmatch(clean):
        raise PromotionError(
            "IDEMPOTENCY_KEY_REQUIRED",
            "Idempotency-Key must be 8-160 safe characters.",
        )
    return clean


def _as_utc(value: Any, field: str) -> datetime:
    if isinstance(value, datetime):
        parsed = value
    else:
        try:
            parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        except (TypeError, ValueError) as exc:
            raise PromotionError("INVALID_CAMPAIGN", f"{field} must be an ISO timestamp.") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _public(doc: Optional[Mapping[str, Any]]) -> Optional[dict[str, Any]]:
    if doc is None:
        return None
    return {key: value for key, value in doc.items() if key != "_id"}


async def _run_transaction(work):
    """Run a promotion operation transactionally; tests may opt into fallback."""
    try:
        session_cm = await db.client.start_session()
    except (AttributeError, NotImplementedError):
        if (
            str(os.environ.get("APP_ENV", "")).strip().lower() == "test"
            and _env_true("FINANCIAL_ALLOW_NON_TRANSACTIONAL_TESTS")
        ):
            return await work(None)
        raise PromotionError(
            "PROMOTION_TRANSACTIONS_UNAVAILABLE",
            "Required database transactions are unavailable.",
            503,
        )
    async with session_cm as session:
        return await session.with_transaction(work)


async def _in_transaction(work, session=None):
    if session is not None:
        return await work(session)
    return await _run_transaction(work)


async def ensure_promotion_indexes() -> None:
    """Create every uniqueness and operational index required by this domain."""
    await db.promotion_campaigns.create_index(
        "id", unique=True, name="promotion_campaign_id_unique",
    )
    await db.promotion_campaigns.create_index(
        [("campaign_type", 1), ("status", 1)], name="promotion_campaign_type_status",
    )
    await db.promotion_versions.create_index(
        [("campaign_id", 1), ("version", 1)], unique=True,
        name="promotion_version_campaign_unique",
    )
    await db.promotion_versions.create_index(
        [("campaign_type", 1), ("status", 1), ("starts_at", 1), ("ends_at", 1)],
        name="promotion_version_offer_lookup",
    )
    await db.promotion_consents.create_index(
        "id", unique=True, name="promotion_consent_id_unique",
    )
    await db.promotion_consents.create_index(
        [("user_id", 1), ("idempotency_key", 1)], unique=True,
        name="promotion_consent_user_idempotency_unique",
    )
    await db.promotion_consents.create_index(
        "deposit_id", unique=True,
        partialFilterExpression={"deposit_id": {"$type": "string"}},
        name="promotion_consent_deposit_unique",
    )
    await db.promotion_quotes.create_index(
        "id", unique=True, name="promotion_quote_id_unique",
    )
    await db.promotion_quotes.create_index(
        "expires_at", expireAfterSeconds=0, name="promotion_quote_expiry",
    )
    await db.wager_missions.create_index("id", unique=True, name="wager_mission_id_unique")
    await db.wager_missions.create_index(
        [("deposit_id", 1), ("campaign_id", 1)], unique=True,
        name="wager_mission_deposit_campaign_unique",
    )
    await db.wager_missions.create_index(
        [("user_id", 1), ("status", 1), ("deadline_at", 1)],
        name="wager_mission_user_status_deadline",
    )
    await db.wager_missions.create_index(
        [("status", 1), ("claim_finality_status", 1), ("claim_finality_at", 1)],
        name="wager_mission_finality_due",
    )
    await db.wager_events.create_index(
        "source_key", unique=True, name="wager_event_source_unique",
    )
    await db.wager_events.create_index(
        [("mission_id", 1), ("bet_id", 1), ("occurred_at", 1)],
        name="wager_event_mission_bet_timeline",
    )
    await db.wager_events.create_index(
        [("user_id", 1), ("bet_id", 1), ("event_type", 1)], unique=True,
        partialFilterExpression={"event_type": "STAKE"},
        name="wager_event_stake_allocation_unique",
    )
    await db.bonus_claims.create_index("id", unique=True, name="bonus_claim_id_unique")
    await db.bonus_claims.create_index(
        "mission_id", unique=True, name="bonus_claim_mission_unique",
    )
    await db.bonus_claims.create_index(
        [("user_id", 1), ("idempotency_key", 1)], unique=True,
        name="bonus_claim_user_idempotency_unique",
    )
    await db.player_referrals.create_index(
        "invite_code", unique=True,
        partialFilterExpression={"invite_code": {"$type": "string"}},
        name="player_referral_invite_code_unique",
    )
    await db.player_referrals.create_index(
        "user_id", unique=True,
        partialFilterExpression={"kind": "PROFILE"},
        name="player_referral_profile_user_unique",
    )
    await db.player_referrals.create_index(
        "invited_user_id", unique=True,
        partialFilterExpression={"invited_user_id": {"$type": "string"}},
        name="player_referral_invited_user_unique",
    )
    await db.player_referrals.create_index(
        [("inviter_user_id", 1), ("created_at", -1)],
        name="player_referral_inviter_created",
    )
    await db.referral_events.create_index(
        "source_key", unique=True, name="referral_event_source_unique",
    )
    await db.referral_events.create_index(
        [("referral_id", 1), ("event_type", 1)],
        name="referral_event_type_lookup",
    )
    await db.reward_claims.create_index("id", unique=True, name="reward_claim_id_unique")
    await db.reward_claims.create_index(
        [("referral_id", 1), ("task_key", 1)], unique=True,
        partialFilterExpression={"kind": "TASK"},
        name="reward_task_referral_key_unique",
    )
    await db.reward_claims.create_index(
        [("user_id", 1), ("idempotency_key", 1)], unique=True,
        partialFilterExpression={"kind": "CLAIM"},
        name="reward_claim_user_idempotency_unique",
    )
    await db.reward_claims.create_index(
        "task_set_key", unique=True,
        partialFilterExpression={"kind": "CLAIM"},
        name="reward_claim_task_set_unique",
    )
    await db.reward_claims.create_index(
        [("user_id", 1), ("kind", 1), ("status", 1), ("verify_after", 1)],
        name="reward_claim_user_status",
    )
    await db.promotion_audit.create_index("id", unique=True, name="promotion_audit_id_unique")
    await db.promotion_audit.create_index(
        [("entity_type", 1), ("entity_id", 1), ("created_at", -1)],
        name="promotion_audit_entity_created",
    )
    await db.wager_reward_counters.create_index(
        "key", unique=True, name="wager_reward_counter_key_unique",
    )
    await db.referral_reward_counters.create_index(
        "key", unique=True, name="referral_reward_counter_key_unique",
    )
    await db.promotion_schema.update_one(
        {"key": "main"},
        {"$set": {
            "key": "main", "schema_version": PROMOTION_SCHEMA_VERSION,
            "indexes_ready_at": now(),
        }},
        upsert=True,
    )


def promotion_core_status() -> dict[str, Any]:
    return {
        "ready": bool(_PROMOTION_CORE_READY),
        "errors": list(_PROMOTION_CORE_ERRORS),
        "schema_version": PROMOTION_SCHEMA_VERSION,
    }


async def prepare_promotion_core() -> dict[str, Any]:
    """Retain index/transaction failures as a hard mutation readiness latch."""
    global _PROMOTION_CORE_READY, _PROMOTION_CORE_ERRORS
    _PROMOTION_CORE_READY = False
    _PROMOTION_CORE_ERRORS = []
    try:
        await ensure_promotion_indexes()
        for collection, required in _REQUIRED_PROMOTION_INDEXES.items():
            info = await db[collection].index_information()
            for name in required:
                if name not in info:
                    _PROMOTION_CORE_ERRORS.append(
                        f"Required index missing: {collection}.{name}",
                    )
        schema = await db.promotion_schema.find_one({"key": "main"})
        if not schema or int(schema.get("schema_version", 0)) != PROMOTION_SCHEMA_VERSION:
            _PROMOTION_CORE_ERRORS.append("Promotion schema version is not ready")
        if not (
            str(os.environ.get("APP_ENV", "")).strip().lower() == "test"
            and _env_true("FINANCIAL_ALLOW_NON_TRANSACTIONAL_TESTS")
        ):
            try:
                session_cm = await db.client.start_session()
                async with session_cm as session:
                    async def probe(tx_session):
                        await db.promotion_schema.find_one(
                            {"key": "main"}, session=tx_session,
                        )
                    await session.with_transaction(probe)
            except Exception as exc:  # noqa: BLE001 - only class is retained
                _PROMOTION_CORE_ERRORS.append(
                    f"Mongo transactions unavailable ({type(exc).__name__})",
                )
    except Exception as exc:  # noqa: BLE001 - readiness must fail closed
        _PROMOTION_CORE_ERRORS.append(
            f"Promotion schema preparation failed ({type(exc).__name__})",
        )
    _PROMOTION_CORE_READY = not _PROMOTION_CORE_ERRORS
    return promotion_core_status()


async def _audit(
    actor: str, action: str, entity_type: str, entity_id: str,
    *, reason: Optional[str] = None, metadata: Optional[Mapping[str, Any]] = None,
    audit_id: Optional[str] = None, session=None,
) -> None:
    doc = {
        "id": audit_id or str(uuid.uuid4()),
        "actor": str(actor),
        "action": str(action),
        "entity_type": str(entity_type),
        "entity_id": str(entity_id),
        "reason": str(reason).strip() if reason else None,
        "metadata": dict(metadata or {}),
        "created_at": now(),
    }
    try:
        await db.promotion_audit.insert_one(doc, **_session_kwargs(session))
    except DuplicateKeyError:
        return


def _normalise_jurisdictions(values: Iterable[str]) -> list[str]:
    clean = sorted({str(value).strip().upper() for value in values if str(value).strip()})
    if not clean or any(not re.fullmatch(r"[A-Z]{2}", value) for value in clean):
        raise PromotionError(
            "INVALID_CAMPAIGN", "A non-empty ISO alpha-2 jurisdiction allowlist is required.",
        )
    return clean


def _strict_config_int(
    value: Any, field: str, *, default: Optional[int] = None, minimum: int = 0,
) -> int:
    """Accept JSON integer tokens only for promotion financial configuration.

    ``bool`` is an ``int`` subclass in Python and ``int()`` also silently
    truncates floats and accepts numeric strings. None of those coercions is
    acceptable for an immutable financial campaign snapshot.
    """
    if value is None and default is not None:
        value = default
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        qualifier = "positive" if minimum > 0 else "non-negative"
        raise PromotionError(
            "INVALID_CAMPAIGN", f"{field} must be a {qualifier} integer.",
        )
    return value


def _validate_reward(spec: Mapping[str, Any]) -> dict[str, Any]:
    reward_type = str(spec.get("reward_type", "")).strip().upper()
    if reward_type not in REWARD_TYPES:
        raise PromotionError("INVALID_CAMPAIGN", "reward_type is invalid.")
    reward_chips = _strict_config_int(
        spec.get("reward_chips"), "reward_chips", minimum=1,
    )
    reward_paise = _strict_config_int(
        spec.get("reward_paise"), "reward_paise", default=0,
    )
    try:
        reward_rate = finance.conversion_snapshot()
        exact_reward_paise = finance.chips_to_paise(reward_chips, reward_rate)
    except Exception as exc:
        raise PromotionError(
            "INVALID_CAMPAIGN",
            "The reward must convert exactly under the current versioned chip rate.",
        ) from exc
    if reward_type == "BONUS_CHIPS" and reward_paise != 0:
        raise PromotionError(
            "INVALID_CAMPAIGN",
            "BONUS_CHIPS rewards must not include a cash-denominated reward_paise value.",
        )
    if reward_type == "CASH_CREDIT" and reward_paise and reward_paise != exact_reward_paise:
        raise PromotionError(
            "INVALID_CAMPAIGN",
            "reward_chips and reward_paise must describe the same exact amount.",
        )
    if reward_type == "CASH_CREDIT" and reward_paise <= 0:
        reward_paise = exact_reward_paise
    return {
        "reward_type": reward_type,
        "reward_chips": reward_chips,
        "reward_paise": reward_paise,
        "reward_rate_snapshot": {
            "version": reward_rate["version"],
            "chips_per_inr": int(reward_rate["chips_per_inr"]),
            "paise_per_inr": int(reward_rate["paise_per_inr"]),
        },
    }


RESPONSIBLE_GAMBLING_POLICY_SCHEMA = "promotion-rg-v1"
_RESPONSIBLE_GAMBLING_POLICY_VALUES = {
    "schema_version": RESPONSIBLE_GAMBLING_POLICY_SCHEMA,
    "account_eligibility": "ACTIVE_VERIFIED_PLAYER",
    "self_exclusion": "BLOCK_NEW_PARTICIPATION",
    "jurisdiction": "REGISTERED_COUNTRY_ALLOWLIST",
    "player_limits": "APPLY_PLATFORM_LIMITS",
}
_RESPONSIBLE_GAMBLING_SUPPORT_ROUTES = {"/responsible-play", "/support"}


def _validate_responsible_gambling_rules(values: Any) -> dict[str, str]:
    """Validate the immutable, operator-reviewed promotion eligibility policy.

    Campaign data is not an extension point for executable policy. Keeping a
    small versioned and allowlisted vocabulary makes unsupported policy fail
    closed instead of being silently stored as an ineffective free-form value.
    """
    if not isinstance(values, Mapping):
        raise PromotionError(
            "INVALID_CAMPAIGN",
            "Versioned responsible-gambling eligibility rules are required.",
        )
    allowed = {*_RESPONSIBLE_GAMBLING_POLICY_VALUES, "support_route"}
    supplied = {str(key) for key in values}
    if supplied != allowed:
        raise PromotionError(
            "INVALID_CAMPAIGN",
            "Responsible-gambling rules must use the complete approved policy schema.",
        )
    clean = {key: str(values.get(key) or "").strip() for key in allowed}
    if any(clean[key] != expected for key, expected in _RESPONSIBLE_GAMBLING_POLICY_VALUES.items()):
        raise PromotionError(
            "INVALID_CAMPAIGN",
            "Responsible-gambling rules contain an unsupported policy value or schema version.",
        )
    if clean["support_route"] not in _RESPONSIBLE_GAMBLING_SUPPORT_ROUTES:
        raise PromotionError(
            "INVALID_CAMPAIGN",
            "Responsible-gambling rules require an approved in-product support route.",
        )
    return clean


def validate_campaign_spec(campaign_type: str, values: Mapping[str, Any]) -> dict[str, Any]:
    campaign_type = str(campaign_type).strip().upper()
    if campaign_type not in {WAGER, REFERRAL}:
        raise PromotionError("INVALID_CAMPAIGN", "campaign_type is invalid.")
    starts_at = _as_utc(values.get("starts_at"), "starts_at")
    ends_at = _as_utc(values.get("ends_at"), "ends_at")
    if ends_at <= starts_at:
        raise PromotionError("INVALID_CAMPAIGN", "ends_at must be after starts_at.")
    terms_version = str(values.get("terms_version") or "").strip()
    terms_text = str(values.get("terms_text") or "").strip()
    if not 1 <= len(terms_version) <= 80 or not 20 <= len(terms_text) <= 20_000:
        raise PromotionError(
            "INVALID_CAMPAIGN", "Versioned significant terms are required.",
        )
    result = {
        "campaign_type": campaign_type,
        "title": str(values.get("title") or "").strip()[:120],
        "starts_at": starts_at,
        "ends_at": ends_at,
        "timezone": str(values.get("timezone") or "UTC").strip()[:80],
        "jurisdictions": _normalise_jurisdictions(values.get("jurisdictions") or []),
        "terms_version": terms_version,
        "terms_text": terms_text,
        "terms_hash": hashlib.sha256(terms_text.encode("utf-8")).hexdigest(),
        "responsible_gambling_rules": _validate_responsible_gambling_rules(
            values.get("responsible_gambling_rules")
        ),
        **_validate_reward(values),
    }
    incentive_products = sorted({
        str(value).strip().upper()
        for value in values.get("incentive_products") or ["CASINO"]
        if str(value).strip()
    })
    if not incentive_products:
        raise PromotionError("INVALID_CAMPAIGN", "At least one incentive product is required.")
    if "GB" in result["jurisdictions"] and len(incentive_products) != 1:
        raise PromotionError(
            "JURISDICTION_POLICY_VIOLATION",
            "Great Britain incentives cannot combine multiple gambling products.",
        )
    result["incentive_products"] = incentive_products
    if campaign_type == WAGER:
        multiplier_bps = _strict_config_int(
            values.get("wager_multiplier_bps"), "wager_multiplier_bps", minimum=1,
        )
        duration_hours = _strict_config_int(
            values.get("duration_hours"), "duration_hours", minimum=1,
        )
        claim_finality_hours = _strict_config_int(
            values.get("claim_finality_hours"), "claim_finality_hours",
            default=24, minimum=1,
        )
        settlement_finality_policy_version = str(
            values.get("settlement_finality_policy_version") or ""
        ).strip()
        default_bps = _strict_config_int(
            values.get("default_contribution_bps"), "default_contribution_bps",
            default=10_000,
        )
        max_stake = _strict_config_int(
            values.get("max_qualifying_stake_chips"),
            "max_qualifying_stake_chips", minimum=1,
        )
        if multiplier_bps > 1_000_000:
            raise PromotionError("INVALID_CAMPAIGN", "wager_multiplier_bps is invalid.")
        if "GB" in result["jurisdictions"] and multiplier_bps > 100_000:
            raise PromotionError(
                "JURISDICTION_POLICY_VIOLATION",
                "Great Britain campaign wagering cannot exceed the configured 10x cap.",
            )
        if duration_hours > 8_760:
            raise PromotionError("INVALID_CAMPAIGN", "duration_hours is invalid.")
        if claim_finality_hours > 720:
            raise PromotionError(
                "INVALID_CAMPAIGN", "claim_finality_hours must be between 1 and 720.",
            )
        if not POLICY_VERSION_RE.fullmatch(settlement_finality_policy_version):
            raise PromotionError(
                "INVALID_CAMPAIGN",
                "A valid versioned settlement-finality policy is required.",
            )
        if default_bps > 10_000:
            raise PromotionError("INVALID_CAMPAIGN", "Contribution rules are invalid.")
        game_bps = {
            str(game).strip().lower(): _strict_config_int(
                bps, f"game_contribution_bps.{str(game).strip().lower()}",
            )
            for game, bps in dict(values.get("game_contribution_bps") or {}).items()
        }
        if any(not game or bps > 10_000 for game, bps in game_bps.items()):
            raise PromotionError("INVALID_CAMPAIGN", "Game contribution rules are invalid.")
        allowed = sorted({str(v).strip().lower() for v in values.get("allowed_games") or [] if str(v).strip()})
        excluded = sorted({str(v).strip().lower() for v in values.get("excluded_games") or [] if str(v).strip()})
        if set(allowed) & set(excluded):
            raise PromotionError("INVALID_CAMPAIGN", "A game cannot be both allowed and excluded.")
        forfeit_allowed = values.get("forfeit_allowed", False)
        if not isinstance(forfeit_allowed, bool):
            raise PromotionError(
                "INVALID_CAMPAIGN", "forfeit_allowed must be a boolean.",
            )
        forfeit_disclosure = str(values.get("forfeit_disclosure") or "").strip()[:1000]
        if forfeit_allowed and len(forfeit_disclosure) < 20:
            raise PromotionError(
                "INVALID_CAMPAIGN",
                "An exact bonus-forfeiture disclosure is required when forfeiture is allowed.",
            )
        per_user_cap = _strict_config_int(
            values.get("per_user_cap_chips"), "per_user_cap_chips", minimum=1,
        )
        daily_cap = _strict_config_int(
            values.get("daily_cap_chips"), "daily_cap_chips", minimum=1,
        )
        campaign_cap = _strict_config_int(
            values.get("campaign_cap_chips"), "campaign_cap_chips", minimum=1,
        )
        reward_chips = int(result["reward_chips"])
        if min(per_user_cap, daily_cap, campaign_cap) < reward_chips:
            raise PromotionError(
                "INVALID_CAMPAIGN",
                "Wager reward caps must be explicit positive values at least as large as one reward.",
            )
        if per_user_cap > campaign_cap or daily_cap > campaign_cap:
            raise PromotionError(
                "INVALID_CAMPAIGN",
                "Wager per-user and daily reward caps cannot exceed the campaign cap.",
            )
        result.update({
            "wager_multiplier_bps": multiplier_bps,
            "duration_hours": duration_hours,
            "claim_finality_hours": claim_finality_hours,
            "settlement_finality_policy_version": settlement_finality_policy_version,
            "default_contribution_bps": default_bps,
            "game_contribution_bps": game_bps,
            "max_qualifying_stake_chips": max_stake,
            "allowed_games": allowed,
            "excluded_games": excluded,
            "eligible_source_buckets": sorted({
                str(v).strip().upper()
                for v in values.get("eligible_source_buckets") or ["CASH", "BONUS"]
                if str(v).strip()
            }),
            "forfeit_allowed": forfeit_allowed,
            "forfeit_disclosure": forfeit_disclosure,
            "per_user_cap_chips": per_user_cap,
            "daily_cap_chips": daily_cap,
            "campaign_cap_chips": campaign_cap,
        })
        if (
            not result["eligible_source_buckets"]
            or not set(result["eligible_source_buckets"]).issubset({"CASH", "BONUS"})
        ):
            raise PromotionError(
                "INVALID_CAMPAIGN",
                "Eligible source buckets must contain only CASH and/or BONUS.",
            )
    else:
        threshold = _strict_config_int(
            values.get("claim_threshold_chips"), "claim_threshold_chips", minimum=1,
        )
        cooling_hours = _strict_config_int(
            values.get("cooling_period_hours"), "cooling_period_hours", default=24,
        )
        tasks = dict(values.get("referral_tasks") or {})
        if cooling_hours > 2_160:
            raise PromotionError("INVALID_CAMPAIGN", "Referral threshold or cooling period is invalid.")
        clean_tasks: dict[str, dict[str, int]] = {}
        for event_type in REFERRAL_EVENT_TYPES:
            task = dict(tasks.get(event_type) or {})
            if not task:
                continue
            if str(task.get("reward_mode", "FIXED")).upper() != "FIXED":
                if not randomized_rewards_enabled():
                    raise PromotionError(
                        "RANDOM_REWARDS_NOT_APPROVED",
                        "Randomized referral rewards are not legally approved.",
                    )
                raise PromotionError(
                    "RANDOM_REWARDS_UNSUPPORTED",
                    "A versioned random-draw service is required before randomized rewards can be used.",
                )
            chips = _strict_config_int(
                task.get("reward_chips"),
                f"referral_tasks.{event_type}.reward_chips",
                minimum=1,
            )
            task_paise = _strict_config_int(
                task.get("reward_paise"),
                f"referral_tasks.{event_type}.reward_paise",
                default=0,
            )
            try:
                exact_task_paise = finance.chips_to_paise(
                    chips, result["reward_rate_snapshot"],
                )
            except Exception as exc:
                raise PromotionError(
                    "INVALID_CAMPAIGN",
                    "Referral task rewards must convert exactly under the campaign chip rate.",
                ) from exc
            if result["reward_type"] == "BONUS_CHIPS" and task_paise != 0:
                raise PromotionError(
                    "INVALID_CAMPAIGN",
                    "BONUS_CHIPS referral tasks must not include cash-denominated reward_paise.",
                )
            if (
                result["reward_type"] == "CASH_CREDIT"
                and task_paise
                and task_paise != exact_task_paise
            ):
                raise PromotionError(
                    "INVALID_CAMPAIGN",
                    "Referral task reward_chips and reward_paise must describe the same amount.",
                )
            if result["reward_type"] == "CASH_CREDIT" and task_paise <= 0:
                task_paise = exact_task_paise
            clean_tasks[event_type] = {
                "reward_chips": chips,
                "reward_paise": task_paise,
            }
        if not clean_tasks:
            raise PromotionError("INVALID_CAMPAIGN", "At least one fixed referral task is required.")
        result.update({
            "claim_threshold_chips": threshold,
            "cooling_period_hours": cooling_hours,
            "referral_tasks": clean_tasks,
            "per_user_cap_chips": _strict_config_int(
                values.get("per_user_cap_chips"), "per_user_cap_chips",
                default=threshold * 100, minimum=1,
            ),
            "daily_cap_chips": _strict_config_int(
                values.get("daily_cap_chips"), "daily_cap_chips",
                default=threshold * 20, minimum=1,
            ),
            "campaign_cap_chips": _strict_config_int(
                values.get("campaign_cap_chips"), "campaign_cap_chips",
                default=threshold * 10_000, minimum=1,
            ),
        })
        if min(
            result["per_user_cap_chips"], result["daily_cap_chips"], result["campaign_cap_chips"],
        ) <= 0:
            raise PromotionError("INVALID_CAMPAIGN", "Referral reward caps must be positive.")
    return result


def _validate_stored_campaign_version(row: Mapping[str, Any]) -> None:
    """Recheck an immutable snapshot immediately before a trust transition."""
    try:
        validated = validate_campaign_spec(row.get("campaign_type"), row)
    except PromotionError as exc:
        raise PromotionError(
            "CAMPAIGN_VERSION_INVALID",
            f"Stored campaign version failed launch validation: {exc.message}",
            409,
        ) from exc
    except (KeyError, TypeError, ValueError) as exc:
        raise PromotionError(
            "CAMPAIGN_VERSION_INVALID",
            "Stored campaign version failed launch validation.",
            409,
        ) from exc
    if str(row.get("terms_hash") or "") != validated["terms_hash"]:
        raise PromotionError(
            "CAMPAIGN_VERSION_INVALID",
            "Stored campaign terms do not match their immutable hash.",
            409,
        )
    if str(row.get("campaign_type") or "").upper() == WAGER:
        _require_certified_settlement_finality_binding(row, status_code=409)


def _require_certified_settlement_finality_binding(
    row: Mapping[str, Any], *, status_code: int = 503,
    environ: Optional[Mapping[str, str]] = None,
) -> str:
    """Require this immutable object to use the externally certified policy."""
    certification = _settlement_finality_certification_status(environ)
    if not certification["certified"] or not certification["versions_match"]:
        raise PromotionError(
            "WAGER_SETTLEMENT_FINALITY_NOT_CERTIFIED",
            "Authoritative wager-settlement finality has not been certified for this configured policy.",
            status_code,
        )
    expected = str(certification["certified_policy_version"])
    actual = str(row.get("settlement_finality_policy_version") or "").strip()
    if actual != expected:
        raise PromotionError(
            "WAGER_SETTLEMENT_FINALITY_POLICY_MISMATCH",
            "This wager campaign is not bound to the currently certified settlement-finality policy.",
            status_code,
            meta={"campaign_policy_version": actual or None},
        )
    return expected


async def create_campaign(
    campaign_id: str, campaign_type: str, values: Mapping[str, Any], actor: str,
    *, session=None,
) -> dict[str, Any]:
    campaign_id = str(campaign_id).strip().lower()
    if not CAMPAIGN_ID_RE.fullmatch(campaign_id):
        raise PromotionError("INVALID_CAMPAIGN_ID", "Campaign ID is invalid.")
    spec = validate_campaign_spec(campaign_type, values)

    async def work(tx_session):
        stamp = now()
        campaign = {
            "id": campaign_id,
            "campaign_type": spec["campaign_type"],
            "status": "DRAFT",
            "latest_version": 1,
            "created_by": str(actor),
            "created_at": stamp,
            "updated_at": stamp,
        }
        version = {
            "id": f"{campaign_id}:1",
            "campaign_id": campaign_id,
            "version": 1,
            "status": "DRAFT",
            "created_by": str(actor),
            "created_at": stamp,
            **spec,
        }
        try:
            await db.promotion_campaigns.insert_one(campaign, **_session_kwargs(tx_session))
            await db.promotion_versions.insert_one(version, **_session_kwargs(tx_session))
        except DuplicateKeyError as exc:
            raise PromotionError("CAMPAIGN_EXISTS", "Campaign already exists.", 409) from exc
        await _audit(
            actor, "CAMPAIGN_CREATED", "CAMPAIGN", campaign_id,
            metadata={"version": 1, "campaign_type": spec["campaign_type"]},
            session=tx_session,
        )
        return {"campaign": _public(campaign), "version": _public(version)}

    return await _in_transaction(work, session)


async def create_campaign_version(
    campaign_id: str, values: Mapping[str, Any], actor: str,
    *, expected_version: int, session=None,
) -> dict[str, Any]:
    async def work(tx_session):
        kwargs = _session_kwargs(tx_session)
        campaign = await db.promotion_campaigns.find_one({"id": campaign_id}, **kwargs)
        if not campaign:
            raise PromotionError("CAMPAIGN_NOT_FOUND", "Campaign was not found.", 404)
        if int(campaign.get("latest_version", 0)) != int(expected_version):
            raise PromotionError("CAMPAIGN_VERSION_CONFLICT", "Campaign changed; reload and retry.", 409)
        spec = validate_campaign_spec(campaign["campaign_type"], values)
        version_no = int(expected_version) + 1
        version = {
            "id": f"{campaign_id}:{version_no}",
            "campaign_id": campaign_id,
            "version": version_no,
            "status": "DRAFT",
            "created_by": str(actor),
            "created_at": now(),
            **spec,
        }
        updated = await db.promotion_campaigns.update_one(
            {"id": campaign_id, "latest_version": int(expected_version)},
            {"$set": {"latest_version": version_no, "updated_at": now()}},
            **kwargs,
        )
        if updated.modified_count != 1:
            raise PromotionError("CAMPAIGN_VERSION_CONFLICT", "Campaign changed; reload and retry.", 409)
        await db.promotion_versions.insert_one(version, **kwargs)
        await _audit(
            actor, "CAMPAIGN_VERSION_CREATED", "CAMPAIGN", campaign_id,
            metadata={"version": version_no}, session=tx_session,
        )
        return _public(version)

    return await _in_transaction(work, session)


async def approve_campaign_version(
    campaign_id: str, version: int, actor: str, reason: str, *, session=None,
) -> dict[str, Any]:
    if len(str(reason).strip()) < 5:
        raise PromotionError("REASON_REQUIRED", "A review reason is required.")

    async def work(tx_session):
        kwargs = _session_kwargs(tx_session)
        row = await db.promotion_versions.find_one(
            {"campaign_id": campaign_id, "version": int(version)}, **kwargs,
        )
        if not row:
            raise PromotionError("CAMPAIGN_VERSION_NOT_FOUND", "Campaign version was not found.", 404)
        _validate_stored_campaign_version(row)
        if row.get("status") == "APPROVED":
            return _public(row)
        if row.get("status") != "DRAFT":
            raise PromotionError("CAMPAIGN_IMMUTABLE", "Only a draft version can be approved.", 409)
        if row.get("created_by") == str(actor):
            raise PromotionError(
                "MAKER_CHECKER_REQUIRED", "A different administrator must approve this version.", 409,
            )
        await db.promotion_versions.update_one(
            {"id": row["id"], "status": "DRAFT"},
            {"$set": {
                "status": "APPROVED", "approved_by": str(actor),
                "approved_at": now(), "approval_reason": str(reason).strip(),
            }}, **kwargs,
        )
        await _audit(
            actor, "CAMPAIGN_VERSION_APPROVED", "CAMPAIGN", campaign_id,
            reason=reason, metadata={"version": int(version)}, session=tx_session,
        )
        return _public(await db.promotion_versions.find_one({"id": row["id"]}, **kwargs))

    return await _in_transaction(work, session)


async def activate_campaign_version(
    campaign_id: str, version: int, actor: str, reason: str, *, session=None,
) -> dict[str, Any]:
    if len(str(reason).strip()) < 5:
        raise PromotionError("REASON_REQUIRED", "An activation reason is required.")

    async def work(tx_session):
        kwargs = _session_kwargs(tx_session)
        row = await db.promotion_versions.find_one(
            {"campaign_id": campaign_id, "version": int(version)}, **kwargs,
        )
        if not row:
            raise PromotionError("CAMPAIGN_VERSION_NOT_FOUND", "Campaign version was not found.", 404)
        _validate_stored_campaign_version(row)
        if row.get("status") == "ACTIVE":
            return _public(row)
        if row.get("status") != "APPROVED" or row.get("created_by") == str(actor):
            raise PromotionError(
                "MAKER_CHECKER_REQUIRED",
                "An independently approved campaign version is required.",
                409,
            )
        # One active immutable version per campaign. Historical versions remain
        # intact and existing missions retain their accepted snapshot.
        await db.promotion_versions.update_many(
            {"campaign_id": campaign_id, "status": "ACTIVE"},
            {"$set": {"status": "RETIRED", "retired_at": now(), "retired_by": str(actor)}},
            **kwargs,
        )
        await db.promotion_versions.update_one(
            {"id": row["id"], "status": "APPROVED"},
            {"$set": {
                "status": "ACTIVE", "activated_by": str(actor),
                "activated_at": now(), "activation_reason": str(reason).strip(),
            }}, **kwargs,
        )
        await db.promotion_campaigns.update_one(
            {"id": campaign_id},
            {"$set": {
                "status": "ACTIVE", "active_version": int(version), "updated_at": now(),
            }}, **kwargs,
        )
        await _audit(
            actor, "CAMPAIGN_VERSION_ACTIVATED", "CAMPAIGN", campaign_id,
            reason=reason, metadata={"version": int(version)}, session=tx_session,
        )
        return _public(await db.promotion_versions.find_one({"id": row["id"]}, **kwargs))

    return await _in_transaction(work, session)


async def list_offers(
    jurisdiction: str, campaign_type: str = WAGER,
    *, deposit_amount_paise: Optional[int] = None, user_id: Optional[str] = None,
) -> list[dict[str, Any]]:
    require_feature(campaign_type)
    if str(campaign_type).upper() == WAGER and user_id:
        await _assert_new_bonus_participation_allowed(user_id)
    jurisdiction = str(jurisdiction or "").strip().upper()
    stamp = now()
    cursor = db.promotion_versions.find({
        "campaign_type": str(campaign_type).upper(),
        "status": "ACTIVE",
        "starts_at": {"$lte": stamp},
        "ends_at": {"$gt": stamp},
        "jurisdictions": jurisdiction,
    }, {"_id": 0}).sort([("starts_at", 1), ("campaign_id", 1)])
    rows = await cursor.to_list(length=100)
    offers = []
    for row in rows:
        if row.get("campaign_type") == WAGER:
            try:
                _require_certified_settlement_finality_binding(row)
            except PromotionError:
                # A previously active version cannot remain offerable after a
                # certified-policy rotation or configuration drift.
                continue
        dto = offer_dto(row)
        dto["jurisdiction"] = jurisdiction
        if deposit_amount_paise is not None and row["campaign_type"] == WAGER:
            if not user_id:
                raise PromotionError(
                    "PROMOTION_QUOTE_USER_REQUIRED", "A signed-in player is required for a quote.",
                )
            dto["quote"] = await create_offer_quote(
                user_id, jurisdiction, row, deposit_amount_paise,
            )
        offers.append(dto)
    return offers


def quote_offer(row: Mapping[str, Any], deposit_amount_paise: int) -> dict[str, Any]:
    """Return the exact server-side target for one deposit amount."""
    amount = int(deposit_amount_paise)
    if amount <= 0:
        raise PromotionError("INVALID_DEPOSIT_AMOUNT", "Deposit amount must be positive.")
    try:
        rate = finance.conversion_snapshot()
        chips = finance.paise_to_chips(amount, rate)
    except Exception as exc:
        if hasattr(exc, "code"):
            raise PromotionError(exc.code, getattr(exc, "message", str(exc)), exc.status_code) from exc
        raise PromotionError(
            "PROMOTION_QUOTE_UNAVAILABLE", "A promotion quote is temporarily unavailable.", 503,
        ) from exc
    target = (chips * int(row["wager_multiplier_bps"]) + 9_999) // 10_000
    return {
        "deposit_amount_paise": amount,
        "deposit_chips": chips,
        "target_chips": target,
        "deadline_preview_at": min(
            now() + timedelta(hours=int(row["duration_hours"])),
            _as_utc(row["ends_at"], "ends_at"),
        ),
        "rate_version": rate["version"],
    }


async def create_offer_quote(
    user_id: str, jurisdiction: str, row: Mapping[str, Any], deposit_amount_paise: int,
    *, session=None,
) -> dict[str, Any]:
    quote = quote_offer(row, deposit_amount_paise)
    stamp = now()
    expires_at = min(stamp + timedelta(minutes=10), _as_utc(row["ends_at"], "ends_at"))
    token = str(uuid.uuid4())
    doc = {
        "id": token, "user_id": str(user_id),
        "campaign_id": row["campaign_id"], "campaign_version": int(row["version"]),
        "jurisdiction": str(jurisdiction).upper(), "terms_hash": row["terms_hash"],
        **quote, "status": "ISSUED", "created_at": stamp, "expires_at": expires_at,
    }
    await db.promotion_quotes.insert_one(doc, **_session_kwargs(session))
    return {**quote, "quote_token": token, "quote_expires_at": expires_at}


def offer_dto(row: Mapping[str, Any]) -> dict[str, Any]:
    result = {
        "campaign_id": row["campaign_id"],
        "campaign_version": int(row["version"]),
        "campaign_type": row["campaign_type"],
        "title": row.get("title"),
        "starts_at": row.get("starts_at"),
        "ends_at": row.get("ends_at"),
        "timezone": row.get("timezone", "UTC"),
        "jurisdictions": list(row.get("jurisdictions") or []),
        "terms_version": row["terms_version"],
        "terms_text": row["terms_text"],
        "reward": {
            "type": row["reward_type"],
            "chips": int(row.get("reward_chips", 0)),
            "paise": int(row.get("reward_paise", 0)),
            "rate_snapshot": dict(row.get("reward_rate_snapshot") or {}),
        },
    }
    if row["campaign_type"] == WAGER:
        result.update({
            "wager_multiplier_bps": int(row["wager_multiplier_bps"]),
            "duration_hours": int(row["duration_hours"]),
            "claim_finality_hours": int(row.get("claim_finality_hours", 24)),
            "settlement_finality_policy_version": row.get(
                "settlement_finality_policy_version"
            ),
            "contribution_rules": _contribution_rules(row),
            "forfeit_allowed": bool(row.get("forfeit_allowed", False)),
            "forfeit_disclosure": row.get("forfeit_disclosure") or None,
        })
    else:
        result.update({
            "claim_threshold_chips": int(row["claim_threshold_chips"]),
            "cooling_period_hours": int(row["cooling_period_hours"]),
            "referral_tasks": dict(row.get("referral_tasks") or {}),
        })
    return result


def _campaign_snapshot(row: Mapping[str, Any]) -> dict[str, Any]:
    keys = {
        "campaign_id", "version", "campaign_type", "title", "starts_at", "ends_at",
        "timezone", "jurisdictions", "terms_version", "terms_hash", "reward_type",
        "reward_chips", "reward_paise", "reward_rate_snapshot",
        "wager_multiplier_bps", "duration_hours",
        "claim_finality_hours", "settlement_finality_policy_version",
        "default_contribution_bps", "game_contribution_bps",
        "max_qualifying_stake_chips", "allowed_games", "excluded_games",
        "eligible_source_buckets", "forfeit_allowed", "forfeit_disclosure",
        "claim_threshold_chips", "cooling_period_hours", "referral_tasks",
        "per_user_cap_chips", "daily_cap_chips", "campaign_cap_chips",
        "incentive_products", "terms_text", "responsible_gambling_rules",
    }
    return {key: row.get(key) for key in keys if key in row}


async def accept_offer(
    user_id: str, campaign_id: str, *, jurisdiction: str, terms_accepted: bool,
    idempotency_key: str, deposit_amount_paise: int,
    quote_token: str, campaign_version: Optional[int] = None, session=None,
) -> dict[str, Any]:
    require_feature(WAGER)
    if terms_accepted is not True:
        raise PromotionError(
            "PROMOTION_TERMS_NOT_ACCEPTED", "Accept the significant terms or continue without the bonus.",
        )
    idem = _validate_idempotency_key(idempotency_key)
    jurisdiction = str(jurisdiction or "").strip().upper()
    payload = {
        "campaign_id": campaign_id, "campaign_version": campaign_version,
        "jurisdiction": jurisdiction, "terms_accepted": True,
        "deposit_amount_paise": int(deposit_amount_paise),
        "quote_token": str(quote_token),
    }
    request_hash = _canonical_hash(payload)

    async def work(tx_session):
        kwargs = _session_kwargs(tx_session)
        existing = await db.promotion_consents.find_one(
            {"user_id": user_id, "idempotency_key": idem}, **kwargs,
        )
        if existing:
            if existing.get("request_hash") != request_hash:
                raise PromotionError(
                    "IDEMPOTENCY_CONFLICT", "This key belongs to another offer acceptance.", 409,
                )
            return _public(existing)
        await _assert_new_bonus_participation_allowed(
            user_id, session=tx_session,
        )
        query: dict[str, Any] = {
            "campaign_id": campaign_id, "campaign_type": WAGER, "status": "ACTIVE",
            "starts_at": {"$lte": now()}, "ends_at": {"$gt": now()},
            "jurisdictions": jurisdiction,
        }
        if campaign_version is not None:
            query["version"] = int(campaign_version)
        version = await db.promotion_versions.find_one(query, **kwargs)
        if not version:
            raise PromotionError(
                "OFFER_NOT_AVAILABLE", "This offer is unavailable in the player's jurisdiction.", 404,
            )
        _require_certified_settlement_finality_binding(version)
        quote = await db.promotion_quotes.find_one({
            "id": str(quote_token), "user_id": user_id,
            "campaign_id": version["campaign_id"],
            "campaign_version": int(version["version"]),
            "jurisdiction": jurisdiction, "status": "ISSUED",
            "expires_at": {"$gt": now()},
        }, **kwargs)
        if not quote:
            raise PromotionError(
                "PROMOTION_QUOTE_INVALID", "The promotion quote is expired, used, or invalid.", 409,
            )
        if (
            int(quote["deposit_amount_paise"]) != int(deposit_amount_paise)
            or quote.get("terms_hash") != version.get("terms_hash")
        ):
            raise PromotionError(
                "PROMOTION_QUOTE_MISMATCH", "The promotion quote does not match this offer.", 409,
            )
        fresh = quote_offer(version, deposit_amount_paise)
        if (
            fresh["rate_version"] != quote["rate_version"]
            or int(fresh["deposit_chips"]) != int(quote["deposit_chips"])
            or int(fresh["target_chips"]) != int(quote["target_chips"])
        ):
            raise PromotionError(
                "PROMOTION_QUOTE_STALE", "The conversion rate changed; request a new quote.", 409,
            )
        consent = {
            "id": str(uuid.uuid4()), "user_id": user_id,
            "campaign_id": version["campaign_id"],
            "campaign_version": int(version["version"]),
            "terms_version": version["terms_version"],
            "terms_hash": version["terms_hash"],
            "settlement_finality_policy_version": version[
                "settlement_finality_policy_version"
            ],
            "jurisdiction": jurisdiction,
            "accepted_at": now(), "status": "PENDING_DEPOSIT",
            "quoted_deposit_amount_paise": quote["deposit_amount_paise"],
            "quoted_deposit_chips": quote["deposit_chips"],
            "quoted_target_chips": quote["target_chips"],
            "quoted_deadline_at": quote["deadline_preview_at"],
            "rate_version": quote["rate_version"],
            "quote_token": str(quote_token),
            "idempotency_key": idem, "request_hash": request_hash,
            "campaign_snapshot": _campaign_snapshot(version),
            "created_at": now(), "updated_at": now(),
        }
        await db.promotion_consents.insert_one(consent, **kwargs)
        consumed_quote = await db.promotion_quotes.update_one(
            {"id": str(quote_token), "status": "ISSUED"},
            {"$set": {
                "status": "ACCEPTED", "consent_id": consent["id"],
                "accepted_at": now(),
            }}, **kwargs,
        )
        if consumed_quote.modified_count != 1:
            raise PromotionError(
                "PROMOTION_QUOTE_USED", "The promotion quote was already accepted.", 409,
            )
        await _audit(
            user_id, "PROMOTION_TERMS_ACCEPTED", "CONSENT", consent["id"],
            metadata={
                "campaign_id": version["campaign_id"], "version": int(version["version"]),
                "terms_version": version["terms_version"], "jurisdiction": jurisdiction,
                "settlement_finality_policy_version": version[
                    "settlement_finality_policy_version"
                ],
            }, session=tx_session,
        )
        return _public(consent)

    return await _in_transaction(work, session)


def _contribution_rules(row: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "default_bps": int(row.get("default_contribution_bps", 0)),
        "game_bps": dict(row.get("game_contribution_bps") or {}),
        "max_qualifying_stake_chips": int(row.get("max_qualifying_stake_chips", 0)),
        "allowed_games": list(row.get("allowed_games") or []),
        "excluded_games": list(row.get("excluded_games") or []),
        "eligible_source_buckets": list(row.get("eligible_source_buckets") or []),
    }


def _wager_liability_coordinates(mission: Mapping[str, Any]) -> dict[str, Any]:
    amount = int(mission.get("reward_chips") or 0)
    per_user_cap = int(mission.get("per_user_cap_chips") or 0)
    daily_cap = int(mission.get("daily_cap_chips") or 0)
    campaign_cap = int(mission.get("campaign_cap_chips") or 0)
    if amount <= 0 or min(per_user_cap, daily_cap, campaign_cap) < amount:
        raise PromotionError(
            "WAGER_REWARD_CAP_CONFIG_INVALID",
            "The accepted campaign has invalid reward-liability limits.", 503,
        )
    mission_id = str(mission.get("id") or "")
    user_id = str(mission.get("user_id") or "")
    if not mission_id or not user_id:
        raise PromotionError(
            "WAGER_REWARD_CAP_CONFIG_INVALID",
            "The wager reward reservation identity is incomplete.", 503,
        )
    activated_at = _as_utc(mission.get("activated_at") or now(), "activated_at")
    return {
        "key": f"{mission['campaign_id']}:{int(mission['campaign_version'])}",
        "campaign_id": str(mission["campaign_id"]),
        "campaign_version": int(mission["campaign_version"]),
        "mission_id": mission_id,
        "reservation_key": hashlib.sha256(mission_id.encode("utf-8")).hexdigest()[:40],
        "user_key": hashlib.sha256(user_id.encode("utf-8")).hexdigest()[:32],
        # Liability-day limits use a single disclosed server standard, avoiding
        # DST and client-timezone ambiguity. The evidence stores that standard.
        "day_key": activated_at.astimezone(timezone.utc).strftime("%Y%m%d"),
        "day_timezone": "UTC",
        "amount": amount,
        "per_user_cap": per_user_cap,
        "daily_cap": daily_cap,
        "campaign_cap": campaign_cap,
    }


async def _reserve_wager_reward_liability(
    mission: Mapping[str, Any], *, session=None,
) -> None:
    """Atomically reserve all three caps before a deposit creates a mission."""
    values = _wager_liability_coordinates(mission)
    kwargs = _session_kwargs(session)
    stamp = now()
    try:
        await db.wager_reward_counters.update_one(
            {"key": values["key"]},
            {"$setOnInsert": {
                "key": values["key"], "campaign_id": values["campaign_id"],
                "campaign_version": values["campaign_version"],
                "per_user_cap_chips": values["per_user_cap"],
                "daily_cap_chips": values["daily_cap"],
                "campaign_cap_chips": values["campaign_cap"],
                "approved_chips": 0, "claimed_chips": 0,
                "daily": {}, "users": {}, "claimed_daily": {}, "claimed_users": {},
                "reservations": {}, "created_at": stamp,
            }}, upsert=True, **kwargs,
        )
    except DuplicateKeyError:
        pass
    reservation_path = f"reservations.{values['reservation_key']}"
    query = {
        "key": values["key"],
        "per_user_cap_chips": values["per_user_cap"],
        "daily_cap_chips": values["daily_cap"],
        "campaign_cap_chips": values["campaign_cap"],
        reservation_path: {"$exists": False},
        "$and": [
            {"approved_chips": {"$lte": values["campaign_cap"] - values["amount"]}},
            {"$or": [
                {f"daily.{values['day_key']}": {"$exists": False}},
                {f"daily.{values['day_key']}": {"$lte": values["daily_cap"] - values["amount"]}},
            ]},
            {"$or": [
                {f"users.{values['user_key']}": {"$exists": False}},
                {f"users.{values['user_key']}": {"$lte": values["per_user_cap"] - values["amount"]}},
            ]},
        ],
    }
    reserved = await db.wager_reward_counters.find_one_and_update(
        query,
        {"$inc": {
            "approved_chips": values["amount"],
            f"daily.{values['day_key']}": values["amount"],
            f"users.{values['user_key']}": values["amount"],
        }, "$set": {
            "updated_at": stamp,
            reservation_path: {
                "mission_id": values["mission_id"], "amount": values["amount"],
                "day_key": values["day_key"], "day_timezone": values["day_timezone"],
                "user_key": values["user_key"], "status": "RESERVED",
                "reserved_at": stamp,
            },
        }},
        return_document=ReturnDocument.AFTER, **kwargs,
    )
    if reserved:
        return
    current = await db.wager_reward_counters.find_one({"key": values["key"]}, **kwargs)
    existing = dict((current or {}).get("reservations", {}).get(values["reservation_key"]) or {})
    if existing:
        if (
            existing.get("mission_id") == values["mission_id"]
            and int(existing.get("amount") or 0) == values["amount"]
            and existing.get("status") in {"RESERVED", "CLAIMED"}
        ):
            return
        raise PromotionError(
            "WAGER_REWARD_CAP_RECONCILIATION_REQUIRED",
            "Wager reward reservation evidence conflicts with this mission.", 503,
        )
    if current and any(
        int(current.get(field) or 0) != values[expected]
        for field, expected in (
            ("per_user_cap_chips", "per_user_cap"),
            ("daily_cap_chips", "daily_cap"),
            ("campaign_cap_chips", "campaign_cap"),
        )
    ):
        raise PromotionError(
            "WAGER_REWARD_CAP_RECONCILIATION_REQUIRED",
            "Stored wager reward limits do not match the accepted campaign version.", 503,
        )
    raise PromotionError(
        "WAGER_REWARD_CAP",
        "This campaign has reached a configured reward-liability cap. The cleared deposit remains available without the bonus mission.",
        409,
    )


async def _release_wager_reward_liability(
    mission: Mapping[str, Any], *, reason: str = "ACTIVATION_FAILED", session=None,
) -> None:
    """Release one exact reservation once while retaining reconciliation evidence."""
    values = _wager_liability_coordinates(mission)
    kwargs = _session_kwargs(session)
    reservation_path = f"reservations.{values['reservation_key']}"
    released = await db.wager_reward_counters.update_one(
        {
            "key": values["key"], f"{reservation_path}.mission_id": values["mission_id"],
            f"{reservation_path}.status": "RESERVED",
        },
        {"$inc": {
            "approved_chips": -values["amount"],
            f"daily.{values['day_key']}": -values["amount"],
            f"users.{values['user_key']}": -values["amount"],
        }, "$set": {
            f"{reservation_path}.status": "RELEASED",
            f"{reservation_path}.released_at": now(),
            f"{reservation_path}.release_reason": str(reason),
            "updated_at": now(),
        }},
        **kwargs,
    )
    if released.modified_count == 1:
        return
    current = await db.wager_reward_counters.find_one({"key": values["key"]}, **kwargs)
    existing = dict((current or {}).get("reservations", {}).get(values["reservation_key"]) or {})
    if not existing or existing.get("status") == "RELEASED":
        return
    raise PromotionError(
        "WAGER_REWARD_CAP_RECONCILIATION_REQUIRED",
        "Wager reward reservation could not be released safely.", 503,
    )


async def _consume_wager_reward_liability(
    mission: Mapping[str, Any], *, session=None,
) -> None:
    """Convert one exact reservation to claimed without increasing any cap."""
    values = _wager_liability_coordinates(mission)
    kwargs = _session_kwargs(session)
    reservation_path = f"reservations.{values['reservation_key']}"
    current = await db.wager_reward_counters.find_one({"key": values["key"]}, **kwargs)
    reservation = dict((current or {}).get("reservations", {}).get(values["reservation_key"]) or {})
    if (
        reservation.get("mission_id") != values["mission_id"]
        or int(reservation.get("amount") or 0) != values["amount"]
        or reservation.get("day_key") != values["day_key"]
        or reservation.get("user_key") != values["user_key"]
    ):
        raise PromotionError(
            "WAGER_REWARD_CAP_RECONCILIATION_REQUIRED",
            "The mission reward has no matching liability reservation.", 503,
        )
    if reservation.get("status") == "CLAIMED":
        return
    if reservation.get("status") != "RESERVED":
        raise PromotionError(
            "WAGER_REWARD_CAP_RECONCILIATION_REQUIRED",
            "The mission reward reservation is not claimable.", 503,
        )
    consumed = await db.wager_reward_counters.find_one_and_update(
        {
            "key": values["key"],
            "per_user_cap_chips": values["per_user_cap"],
            "daily_cap_chips": values["daily_cap"],
            "campaign_cap_chips": values["campaign_cap"],
            f"{reservation_path}.mission_id": values["mission_id"],
            f"{reservation_path}.status": "RESERVED",
            "approved_chips": {"$lte": values["campaign_cap"]},
            f"daily.{values['day_key']}": {"$lte": values["daily_cap"]},
            f"users.{values['user_key']}": {"$lte": values["per_user_cap"]},
            "$and": [
                {"claimed_chips": {"$lte": values["campaign_cap"] - values["amount"]}},
                {"$or": [
                    {f"claimed_daily.{values['day_key']}": {"$exists": False}},
                    {f"claimed_daily.{values['day_key']}": {"$lte": values["daily_cap"] - values["amount"]}},
                ]},
                {"$or": [
                    {f"claimed_users.{values['user_key']}": {"$exists": False}},
                    {f"claimed_users.{values['user_key']}": {"$lte": values["per_user_cap"] - values["amount"]}},
                ]},
            ],
        },
        {"$inc": {
            "claimed_chips": values["amount"],
            f"claimed_daily.{values['day_key']}": values["amount"],
            f"claimed_users.{values['user_key']}": values["amount"],
        }, "$set": {
            f"{reservation_path}.status": "CLAIMED",
            f"{reservation_path}.claimed_at": now(), "updated_at": now(),
        }},
        return_document=ReturnDocument.AFTER, **kwargs,
    )
    if consumed:
        return
    latest = await db.wager_reward_counters.find_one({"key": values["key"]}, **kwargs)
    latest_reservation = dict(
        (latest or {}).get("reservations", {}).get(values["reservation_key"]) or {}
    )
    if latest_reservation.get("status") == "CLAIMED":
        return
    raise PromotionError(
        "WAGER_REWARD_CAP_RECONCILIATION_REQUIRED",
        "The mission reward cap could not be consumed safely.", 503,
    )


async def activate_deposit_mission(
    deposit: Mapping[str, Any], *, session=None,
) -> Optional[dict[str, Any]]:
    """Consume the deposit's exact consent and create one mission.

    Call this after verified cash credit, inside the same Mongo transaction.
    If rollout readiness has been turned off, the cash deposit still succeeds
    and no mission is created.
    """
    if not feature_enabled(WAGER):
        return None
    consent_id = str(deposit.get("promotion_consent_id") or "").strip()
    if not consent_id:
        return None
    deposit_id = str(deposit.get("id") or "").strip()
    user_id = str(deposit.get("user_id") or "").strip()
    chips = int(deposit.get("chips") or 0)
    if not deposit_id or not user_id or chips <= 0:
        raise PromotionError("INVALID_DEPOSIT_ACTIVATION", "Deposit activation data is incomplete.")

    async def work(tx_session):
        kwargs = _session_kwargs(tx_session)
        consent = await db.promotion_consents.find_one(
            {"id": consent_id, "user_id": user_id}, **kwargs,
        )
        if not consent:
            raise PromotionError("PROMOTION_CONSENT_NOT_FOUND", "Promotion consent was not found.", 409)
        existing = await db.wager_missions.find_one(
            {"deposit_id": deposit_id, "campaign_id": consent["campaign_id"]}, **kwargs,
        )
        if existing:
            return mission_dto(existing)
        if consent.get("status") == "PARTICIPATION_BLOCKED":
            return None
        try:
            await _assert_new_bonus_participation_allowed(
                user_id, session=tx_session,
            )
        except PromotionError as exc:
            stamp = now()
            await db.promotion_consents.update_one(
                {"id": consent_id, "status": "PENDING_DEPOSIT"},
                {"$set": {
                    "status": "PARTICIPATION_BLOCKED",
                    "participation_block_code": exc.code,
                    "participation_blocked_at": stamp,
                    "updated_at": stamp,
                }}, **kwargs,
            )
            await _audit(
                "system:deposit-credit", "WAGER_MISSION_PARTICIPATION_BLOCKED",
                "CONSENT", consent_id,
                metadata={
                    "code": exc.code, "deposit_id": deposit_id,
                    "cleared_deposit_affected": False,
                }, session=tx_session,
            )
            return None
        if consent.get("status") != "PENDING_DEPOSIT":
            raise PromotionError("PROMOTION_CONSENT_USED", "Promotion consent has already been used.", 409)
        snapshot = dict(consent.get("campaign_snapshot") or {})
        if snapshot.get("campaign_type") != WAGER:
            raise PromotionError("INVALID_PROMOTION_CONSENT", "Promotion consent is invalid.", 409)
        _require_certified_settlement_finality_binding(snapshot)
        if (
            str(consent.get("settlement_finality_policy_version") or "")
            != str(snapshot.get("settlement_finality_policy_version") or "")
        ):
            raise PromotionError(
                "INVALID_PROMOTION_CONSENT",
                "Promotion consent finality-policy evidence is inconsistent.", 409,
            )
        stamp = now()
        accepted_deadline = min(
            _as_utc(consent["quoted_deadline_at"], "quoted_deadline_at"),
            _as_utc(snapshot["ends_at"], "ends_at"),
        )
        if stamp >= accepted_deadline:
            await db.promotion_consents.update_one(
                {"id": consent_id, "status": "PENDING_DEPOSIT"},
                {"$set": {"status": "EXPIRED", "updated_at": stamp}}, **kwargs,
            )
            return None
        if (
            int(deposit.get("amount_paise") or 0) != int(consent["quoted_deposit_amount_paise"])
            or chips != int(consent["quoted_deposit_chips"])
        ):
            raise PromotionError(
                "PROMOTION_QUOTE_MISMATCH",
                "The deposit amount no longer matches the accepted promotion quote.", 409,
            )
        target = int(consent["quoted_target_chips"])
        mission = {
            "id": str(uuid.uuid4()), "user_id": user_id, "deposit_id": deposit_id,
            "deposit_chips": chips, "deposit_amount_paise": int(deposit.get("amount_paise") or 0),
            "consent_id": consent_id, "campaign_id": consent["campaign_id"],
            "campaign_version": int(consent["campaign_version"]),
            "terms_version": consent["terms_version"], "terms_hash": consent["terms_hash"],
            "jurisdiction": consent["jurisdiction"], "accepted_at": consent["accepted_at"],
            "activated_at": stamp,
            # Bind the mission to the exact absolute deadline shown and
            # accepted before checkout. Payment completion cannot silently
            # substitute a later duration window.
            "deadline_at": accepted_deadline,
            "timezone": snapshot.get("timezone") or "UTC",
            "reward_type": snapshot["reward_type"],
            "reward_chips": int(snapshot.get("reward_chips") or 0),
            "reward_paise": int(snapshot.get("reward_paise") or 0),
            "reward_rate_snapshot": dict(snapshot.get("reward_rate_snapshot") or {}),
            "per_user_cap_chips": int(snapshot.get("per_user_cap_chips") or 0),
            "daily_cap_chips": int(snapshot.get("daily_cap_chips") or 0),
            "campaign_cap_chips": int(snapshot.get("campaign_cap_chips") or 0),
            "claim_finality_hours": int(snapshot.get("claim_finality_hours", 24)),
            "settlement_finality_policy_version": snapshot[
                "settlement_finality_policy_version"
            ],
            "claim_finality_status": "NOT_STARTED",
            "target_chips": target,
            "settled_contribution_chips": 0,
            "pending_settlement_chips": 0,
            "remaining_chips": target,
            "progress_percent": 0,
            "progress_basis_points": 0,
            "status": ACTIVE,
            "contribution_rules": _contribution_rules(snapshot),
            "forfeit_allowed": bool(snapshot.get("forfeit_allowed", False)),
            "forfeit_disclosure": snapshot.get("forfeit_disclosure") or None,
            "created_at": stamp, "updated_at": stamp, "version": 1,
        }
        await _reserve_wager_reward_liability(mission, session=tx_session)
        try:
            consumed = await db.promotion_consents.update_one(
                {"id": consent_id, "user_id": user_id, "status": "PENDING_DEPOSIT"},
                {"$set": {
                    "status": "CONSUMED", "deposit_id": deposit_id,
                    "consumed_at": stamp, "updated_at": stamp,
                }}, **kwargs,
            )
            if consumed.modified_count != 1:
                raise PromotionError(
                    "PROMOTION_CONSENT_USED", "Promotion consent has already been used.", 409,
                )
            await db.wager_missions.insert_one(mission, **kwargs)
        except DuplicateKeyError:
            duplicate = await db.wager_missions.find_one(
                {"deposit_id": deposit_id, "campaign_id": consent["campaign_id"]}, **kwargs,
            )
            if duplicate:
                await _release_wager_reward_liability(mission, session=tx_session)
                return mission_dto(duplicate)
            await _release_wager_reward_liability(mission, session=tx_session)
            raise
        except Exception:
            await _release_wager_reward_liability(mission, session=tx_session)
            raise
        await _audit(
            "system:deposit-credit", "WAGER_MISSION_ACTIVATED", "MISSION", mission["id"],
            metadata={
                "deposit_id": deposit_id, "campaign_id": mission["campaign_id"],
                "campaign_version": mission["campaign_version"], "target_chips": target,
                "reward_chips": mission["reward_chips"], "status": "LIABILITY_RESERVED",
            }, session=tx_session,
        )
        return mission_dto(mission)

    return await _in_transaction(work, session)


def mission_dto(row: Mapping[str, Any]) -> dict[str, Any]:
    target = max(0, int(row.get("target_chips", 0)))
    settled = max(0, int(row.get("settled_contribution_chips", 0)))
    pending = max(0, int(row.get("pending_settlement_chips", 0)))
    remaining = max(0, target - settled)
    basis_points = min(10_000, (settled * 10_000 // target) if target else 0)
    status = row.get("status")
    if status in {ACTIVE, PENDING_SETTLEMENT} and settled < target and row.get("deadline_at") and _as_utc(
        row["deadline_at"], "deadline_at",
    ) <= now():
        status = EXPIRED
    finality_at = row.get("claim_finality_at")
    finality_status = str(row.get("claim_finality_status") or "NOT_STARTED")
    return {
        "id": row["id"],
        "user_id": row.get("user_id"),
        "deposit": {
            "id": row.get("deposit_id"),
            "chips": int(row.get("deposit_chips", 0)),
            "amount_paise": int(row.get("deposit_amount_paise", 0)),
        },
        "campaign_id": row.get("campaign_id"),
        "campaign_version": int(row.get("campaign_version", 0)),
        "terms_version": row.get("terms_version"),
        "jurisdiction": row.get("jurisdiction"),
        "status": status,
        "activated_at": row.get("activated_at"),
        "deadline_at": row.get("deadline_at"),
        "timezone": row.get("timezone") or "UTC",
        "reward": {
            "type": row.get("reward_type"),
            "chips": int(row.get("reward_chips", 0)),
            "paise": int(row.get("reward_paise", 0)),
            "rate_snapshot": dict(row.get("reward_rate_snapshot") or {}),
        },
        "progress": {
            "target_chips": target,
            "settled_chips": settled,
            "pending_chips": pending,
            "remaining_chips": remaining,
            "percent": basis_points // 100,
            "percent_basis_points": basis_points,
        },
        "claimable": status == CLAIMABLE and settled >= target,
        "claim_finality": {
            "status": finality_status,
            "window_hours": int(row.get("claim_finality_hours", 24)),
            "policy_version": row.get("settlement_finality_policy_version"),
            "target_achieved_at": row.get("target_achieved_at"),
            "started_at": row.get("claim_finality_started_at"),
            "finality_at": finality_at,
            "satisfied_at": row.get("claim_finality_satisfied_at"),
            "reason": row.get("claim_finality_reason"),
            "remaining_seconds": max(
                0, int((_as_utc(finality_at, "claim_finality_at") - now()).total_seconds()),
            ) if finality_at and finality_status == "PENDING" else 0,
        },
        "forfeit_allowed": bool(row.get("forfeit_allowed", False)),
        "forfeit_disclosure": row.get("forfeit_disclosure"),
        "contribution_rules": dict(row.get("contribution_rules") or {}),
        "created_at": row.get("created_at"),
        "updated_at": row.get("updated_at"),
        "server_time": now(),
    }


async def expire_due_mission(mission_id: str, *, session=None) -> Optional[dict[str, Any]]:
    async def work(tx_session):
        stamp = now()
        row = await db.wager_missions.find_one_and_update(
            {
                "id": mission_id, "status": {"$in": [ACTIVE, PENDING_SETTLEMENT]},
                "claim_finality_status": {"$nin": ["PENDING", "SATISFIED"]},
                "deadline_at": {"$lte": stamp},
            },
            {"$set": {"status": EXPIRED, "expired_at": stamp, "updated_at": stamp}},
            return_document=ReturnDocument.AFTER, **_session_kwargs(tx_session),
        )
        if not row:
            return None
        await _release_wager_reward_liability(
            row, reason="MISSION_EXPIRED", session=tx_session,
        )
        await _audit(
            "system:mission-expiry", "WAGER_MISSION_EXPIRED", "MISSION", mission_id,
            metadata={"reward_chips": int(row.get("reward_chips") or 0)},
            session=tx_session,
        )
        return mission_dto(row)

    return await _in_transaction(work, session)


async def get_mission(user_id: str, mission_id: str) -> dict[str, Any]:
    row = await db.wager_missions.find_one({"id": mission_id, "user_id": user_id}, {"_id": 0})
    if not row:
        raise PromotionError("MISSION_NOT_FOUND", "Wager mission was not found.", 404)
    if (
        feature_enabled(WAGER)
        and row.get("claim_finality_status") == "PENDING"
        and row.get("claim_finality_at")
        and _as_utc(row["claim_finality_at"], "claim_finality_at") <= now()
    ):
        await promote_mission_claim_finality(mission_id)
    await expire_due_mission(mission_id)
    row = await db.wager_missions.find_one({"id": mission_id, "user_id": user_id}, {"_id": 0})
    return mission_dto(row)


async def get_active_mission(user_id: str) -> Optional[dict[str, Any]]:
    stamp = now()
    if feature_enabled(WAGER):
        due = await db.wager_missions.find(
            {
                "user_id": user_id, "status": PENDING_SETTLEMENT,
                "claim_finality_status": "PENDING",
                "claim_finality_at": {"$lte": stamp},
            },
            {"id": 1, "_id": 0},
        ).sort("claim_finality_at", 1).to_list(length=10)
        for mission in due:
            await promote_mission_claim_finality(str(mission["id"]))
    expiring = await db.wager_missions.find(
        {
            "user_id": user_id, "status": {"$in": [ACTIVE, PENDING_SETTLEMENT]},
            "claim_finality_status": {"$nin": ["PENDING", "SATISFIED"]},
            "deadline_at": {"$lte": stamp},
        }, {"id": 1, "_id": 0},
    ).to_list(length=None)
    for mission in expiring:
        await expire_due_mission(str(mission["id"]))
    row = await db.wager_missions.find_one(
        {"user_id": user_id, "status": {"$in": list(MISSION_OPEN_STATES)}},
        {"_id": 0}, sort=[("deadline_at", 1), ("created_at", 1)],
    )
    return mission_dto(row) if row else None


def _eligible_stake(
    stake_chips: int, rules: Mapping[str, Any], source_allocation: Optional[Mapping[str, Any]],
) -> int:
    stake = max(0, int(stake_chips))
    if not source_allocation:
        return 0
    eligible = {str(v).upper() for v in rules.get("eligible_source_buckets") or []}
    totals = _allocation_bucket_totals(source_allocation)
    if totals is None:
        return 0
    amount = sum(value for bucket, value in totals.items() if bucket in eligible)
    return min(stake, amount)


def _allocation_bucket_totals(
    source_allocation: Optional[Mapping[str, Any]],
) -> Optional[dict[str, int]]:
    if not isinstance(source_allocation, Mapping) or not source_allocation:
        return None
    aliases = {
        "CASH": ("cash_chips", "available_cash_chips", "available_cash"),
        "BONUS": ("bonus_chips", "available_bonus_chips", "available_bonus"),
    }
    totals: dict[str, int] = {}
    for bucket, names in aliases.items():
        selected = next((source_allocation[name] for name in names if name in source_allocation), 0)
        # Do not silently truncate floats, parse strings, or treat booleans as
        # chips. Authoritative wallet allocations are integer Mongo values.
        if isinstance(selected, bool) or not isinstance(selected, int):
            return None
        totals[bucket] = int(selected)
    if any(value < 0 for value in totals.values()):
        return None
    return totals


def contribution_for(
    mission: Mapping[str, Any], game: str, stake_chips: int,
    source_allocation: Optional[Mapping[str, Any]] = None,
) -> int:
    rules = dict(mission.get("contribution_rules") or {})
    game = str(game or "").strip().lower()
    allowed = set(rules.get("allowed_games") or [])
    excluded = set(rules.get("excluded_games") or [])
    if not game or game in excluded or (allowed and game not in allowed):
        return 0
    eligible_stake = _eligible_stake(stake_chips, rules, source_allocation)
    capped = min(eligible_stake, max(0, int(rules.get("max_qualifying_stake_chips", 0))))
    bps = int(dict(rules.get("game_bps") or {}).get(game, rules.get("default_bps", 0)))
    return max(0, capped * max(0, min(10_000, bps)) // 10_000)


def contribution_rate_bps_for(mission: Mapping[str, Any], game: str) -> int:
    """Return the immutable disclosed rate for one mission/game pair."""
    rules = dict(mission.get("contribution_rules") or {})
    game = str(game or "").strip().lower()
    allowed = set(rules.get("allowed_games") or [])
    excluded = set(rules.get("excluded_games") or [])
    if not game or game in excluded or (allowed and game not in allowed):
        return 0
    value = int(dict(rules.get("game_bps") or {}).get(
        game, rules.get("default_bps", 0),
    ))
    return max(0, min(10_000, value))


def _bet_projection(events: Iterable[Mapping[str, Any]]) -> dict[str, Any]:
    rows = list(events)
    if any(row.get("event_type") in {"VOID", "REFUND"} for row in rows):
        return {"state": "REVERSED", "pending": 0, "settled": 0}
    settled = [row for row in rows if row.get("event_type") == "SETTLED"]
    stakes = [row for row in rows if row.get("event_type") == "STAKE"]
    if settled:
        # The original stake owns source allocation. Settlement markers can be
        # intentionally balance-neutral and therefore carry no allocation.
        evidence = stakes or settled
        value = max(int(row.get("contribution_chips", 0)) for row in evidence)
        return {"state": "SETTLED", "pending": 0, "settled": value}
    if stakes:
        value = max(int(row.get("contribution_chips", 0)) for row in stakes)
        return {"state": "PENDING", "pending": value, "settled": 0}
    return {"state": "NONE", "pending": 0, "settled": 0}


async def _choose_mission(user_id: str, occurred_at: datetime, session=None):
    certification = _settlement_finality_certification_status()
    certified_version = (
        certification.get("certified_policy_version")
        if certification.get("certified") and certification.get("versions_match")
        else None
    )
    if not certified_version:
        return None
    return await db.wager_missions.find_one(
        {
            "user_id": user_id,
            "status": {"$in": [ACTIVE, PENDING_SETTLEMENT]},
            "claim_finality_status": {"$ne": "PENDING"},
            "settlement_finality_policy_version": certified_version,
            "activated_at": {"$lte": occurred_at},
            "deadline_at": {"$gt": occurred_at},
        }, sort=[("deadline_at", 1), ("created_at", 1)], **_session_kwargs(session),
    )


async def record_wager_event(
    *, user_id: str, bet_id: str, event_type: str, source_event_id: str,
    game: str, stake_chips: int, occurred_at: Any = None,
    source_allocation: Optional[Mapping[str, Any]] = None,
    mission_id: Optional[str] = None, bet_reference: Optional[str] = None,
    session=None,
) -> Optional[dict[str, Any]]:
    """Append one authoritative event and update one earliest-expiry mission."""
    if not feature_enabled(WAGER):
        return None
    event_type = str(event_type).strip().upper()
    if event_type not in WAGER_EVENT_TYPES:
        raise PromotionError("INVALID_WAGER_EVENT", "Wager event type is invalid.")
    user_id = str(user_id).strip()
    bet_id = str(bet_id).strip()
    source_event_id = str(source_event_id).strip()
    game = str(game or "").strip().lower()
    if not user_id or not bet_id or not source_event_id or int(stake_chips) < 0:
        raise PromotionError("INVALID_WAGER_EVENT", "Wager event data is incomplete.")
    event_time = _as_utc(occurred_at or now(), "occurred_at")
    source_key = f"wager:{source_event_id}:{event_type.lower()}"
    allocation_valid = True
    try:
        normalized_allocation = dict(source_allocation or {})
    except (TypeError, ValueError):
        normalized_allocation = {}
    totals = _allocation_bucket_totals(normalized_allocation)
    allocation_valid = bool(totals) and sum(totals.values()) == int(stake_chips)
    source_allocation = normalized_allocation

    async def work(tx_session):
        kwargs = _session_kwargs(tx_session)
        existing = await db.wager_events.find_one({"source_key": source_key}, **kwargs)
        linked_event = await db.wager_events.find_one(
            {"user_id": user_id, "bet_id": bet_id, "event_type": "STAKE"}, **kwargs,
        )
        effective_allocation = dict(source_allocation or {})
        effective_bet_reference = str(bet_reference or bet_id)
        if linked_event and event_type != "STAKE":
            if (
                str(linked_event.get("game") or "") != game
                or int(linked_event.get("stake_chips", -1)) != int(stake_chips)
            ):
                raise PromotionError(
                    "WAGER_SETTLEMENT_SOURCE_CONFLICT",
                    "Settlement evidence does not match the authoritative stake.", 409,
                )
            # The original STAKE owns mission allocation, source eligibility,
            # and contribution. A marker cannot upgrade an ineligible stake by
            # carrying a different or incomplete allocation payload.
            effective_allocation = dict(linked_event.get("source_allocation") or {})
            effective_bet_reference = str(
                linked_event.get("bet_reference") or bet_reference or bet_id
            )
        if (
            mission_id and linked_event
            and linked_event.get("mission_id") != str(mission_id)
        ):
            raise PromotionError(
                "WAGER_MISSION_ALLOCATION_CONFLICT",
                "This authoritative stake is already allocated to another mission.", 409,
            )
        if event_type != "STAKE" and not linked_event:
            return None
        if mission_id:
            mission = await db.wager_missions.find_one(
                {"id": mission_id, "user_id": user_id}, **kwargs,
            )
        elif linked_event:
            mission = await db.wager_missions.find_one(
                {"id": linked_event["mission_id"], "user_id": user_id}, **kwargs,
            )
        else:
            mission = await _choose_mission(user_id, event_time, tx_session)
        if existing:
            if mission and existing.get("mission_id") != mission.get("id"):
                raise PromotionError("WAGER_EVENT_CONFLICT", "Wager event already belongs to another mission.", 409)
            if (
                existing.get("user_id") != user_id
                or existing.get("bet_id") != bet_id
                or existing.get("event_type") != event_type
                or existing.get("game") != game
                or int(existing.get("stake_chips", -1)) != int(stake_chips)
                or dict(existing.get("source_allocation") or {}) != effective_allocation
            ):
                raise PromotionError(
                    "WAGER_EVENT_CONFLICT",
                    "The authoritative wager event ID belongs to different data.", 409,
                )
            return {
                "event": _public(existing),
                "mission": mission_dto(mission) if mission else None,
                "duplicate": True,
            }
        if not mission:
            return None
        after_deadline = event_time >= _as_utc(mission["deadline_at"], "deadline_at")
        if (
            (mission.get("status") == EXPIRED or after_deadline)
            and not (linked_event and event_type in {"VOID", "REFUND"})
        ):
            return None
        prior_events = await db.wager_events.find(
            {"mission_id": mission["id"], "bet_id": bet_id}, **kwargs,
        ).to_list(length=100)
        before = _bet_projection(prior_events)
        # A malformed source breakdown is quarantined, never partially
        # interpreted as turnover. Ancillary provenance fields are tolerated,
        # but the recognized cash+bonus totals must conserve the full stake.
        if event_type != "STAKE" and linked_event:
            contribution = int(linked_event.get("contribution_chips", 0))
        else:
            contribution = (
                0 if not allocation_valid
                else contribution_for(mission, game, int(stake_chips), effective_allocation)
            )
        event_payload = {
            "mission_id": mission["id"], "user_id": user_id, "bet_id": bet_id,
            "bet_reference": effective_bet_reference,
            "event_type": event_type, "source_event_id": source_event_id,
            "game": game, "stake_chips": int(stake_chips),
            "contribution_chips": contribution,
            "source_allocation": effective_allocation,
            "occurred_at": event_time,
        }
        event = {
            "id": str(uuid.uuid4()), "source_key": source_key,
            "request_hash": _canonical_hash(event_payload),
            **event_payload, "created_at": now(),
        }
        try:
            await db.wager_events.insert_one(event, **kwargs)
        except DuplicateKeyError:
            duplicate = await db.wager_events.find_one({"source_key": source_key}, **kwargs)
            if duplicate and duplicate.get("request_hash") == event["request_hash"]:
                return {"event": _public(duplicate), "mission": mission_dto(mission), "duplicate": True}
            raise PromotionError("WAGER_EVENT_CONFLICT", "Wager event conflicts with existing data.", 409)
        if event_type == "STAKE" and not allocation_valid:
            # Preserve causal ordering even on stores with millisecond date
            # precision: the stake happened before the pause it triggered.
            pause_stamp = max(now(), event_time) + timedelta(milliseconds=1)
            await db.wager_missions.update_one(
                {"id": mission["id"], "status": {"$in": list(MISSION_OPEN_STATES)}},
                {"$set": {
                    "status": PAUSED_FOR_REVIEW, "paused_at": pause_stamp,
                    "pause_reason_code": "SOURCE_ALLOCATION_MISSING_OR_INVALID",
                    "updated_at": pause_stamp,
                }, "$inc": {"version": 1}}, **kwargs,
            )
            mission = await db.wager_missions.find_one({"id": mission["id"]}, **kwargs)
            await _audit(
                "system:wager-observer", "WAGER_MISSION_SOURCE_EVIDENCE_MISSING",
                "MISSION", mission["id"],
                metadata={"bet_id": bet_id, "source_event_id": source_event_id},
                session=tx_session,
            )
        after = _bet_projection([*prior_events, event])
        pending_delta = int(after["pending"]) - int(before["pending"])
        settled_delta = int(after["settled"]) - int(before["settled"])
        if pending_delta or settled_delta:
            updated = await db.wager_missions.find_one_and_update(
                {"id": mission["id"], "version": int(mission.get("version", 1))},
                {"$inc": {
                    "pending_settlement_chips": pending_delta,
                    "settled_contribution_chips": settled_delta,
                    "version": 1,
                }, "$set": {"updated_at": now()}},
                return_document=ReturnDocument.AFTER, **kwargs,
            )
            if not updated:
                raise PromotionError("MISSION_CONCURRENT_UPDATE", "Mission changed; retry safely.", 409)
            settled_total = max(0, int(updated.get("settled_contribution_chips", 0)))
            pending_total = max(0, int(updated.get("pending_settlement_chips", 0)))
            target = int(updated["target_chips"])
            if mission.get("status") == PAUSED_FOR_REVIEW:
                next_status = PAUSED_FOR_REVIEW
            elif mission.get("status") == FORFEITED:
                next_status = FORFEITED
            elif mission.get("status") == EXPIRED:
                next_status = EXPIRED
            elif mission.get("status") == CLAIMED:
                next_status = PAUSED_FOR_REVIEW if settled_delta < 0 else CLAIMED
            elif mission.get("status") == CLAIMABLE:
                next_status = PAUSED_FOR_REVIEW if settled_delta < 0 else CLAIMABLE
            elif settled_total >= target:
                # Reaching 100% starts a correction/finality window. The
                # reward is not claimable and no wallet value exists yet.
                next_status = PENDING_SETTLEMENT
            elif pending_total > 0:
                next_status = PENDING_SETTLEMENT
            else:
                next_status = ACTIVE
            basis_points = min(10_000, settled_total * 10_000 // target) if target else 0
            state_set: dict[str, Any] = {}
            state_unset: dict[str, str] = {}
            prior_finality = str(mission.get("claim_finality_status") or "NOT_STARTED")
            if (
                settled_total >= target
                and next_status == PENDING_SETTLEMENT
                and prior_finality != "PENDING"
            ):
                finality_started_at = max(now(), event_time)
                state_set.update({
                    "claim_finality_status": "PENDING",
                    "claim_finality_started_at": finality_started_at,
                    "claim_finality_at": finality_started_at + timedelta(
                        hours=int(mission.get("claim_finality_hours", 24)),
                    ),
                    "claim_finality_reason": "AUTHORITATIVE_WAGER_CORRECTION_WINDOW",
                    "target_achieved_at": event_time,
                })
            elif settled_total < target and prior_finality == "PENDING":
                state_set.update({
                    "claim_finality_status": "RESET_BY_CORRECTION",
                    "claim_finality_reset_at": now(),
                    "claim_finality_reason": "QUALIFYING_WAGER_REVERSED",
                })
                state_unset.update({
                    "claim_finality_started_at": "", "claim_finality_at": "",
                    "claim_finality_satisfied_at": "", "target_achieved_at": "",
                })
            post_finality_reversal = bool(
                settled_delta < 0
                and mission.get("status") in {CLAIMABLE, CLAIMED}
            )
            if post_finality_reversal:
                state_set.update({
                    "pause_reason_code": "CERTIFIED_SETTLEMENT_FINALITY_ANOMALY",
                    "paused_at": now(),
                })
            await db.wager_missions.update_one(
                {"id": mission["id"]},
                {"$set": {
                    "pending_settlement_chips": pending_total,
                    "settled_contribution_chips": settled_total,
                    "remaining_chips": max(0, target - settled_total),
                    "progress_percent": basis_points // 100,
                    "progress_basis_points": basis_points,
                    "status": next_status,
                    **({"paused_at": now()} if next_status == PAUSED_FOR_REVIEW else {}),
                    **state_set,
                    "updated_at": now(),
                }, **({"$unset": state_unset} if state_unset else {})}, **kwargs,
            )
            if post_finality_reversal:
                await db.bonus_claims.update_one(
                    {"mission_id": mission["id"], "status": CLAIMED},
                    {"$set": {
                        "status": PAUSED_FOR_REVIEW,
                        "review_reason_code": "CERTIFIED_SETTLEMENT_FINALITY_ANOMALY",
                        "review_started_at": now(), "updated_at": now(),
                    }}, **kwargs,
                )
                await _audit(
                    "system:wager-observer", "WAGER_SETTLEMENT_FINALITY_CERTIFICATION_ANOMALY",
                    "MISSION", mission["id"],
                    metadata={
                        "bet_id": bet_id, "source_event_id": source_event_id,
                        "settlement_finality_policy_version": mission.get(
                            "settlement_finality_policy_version"
                        ),
                        "classification": "IMPOSSIBLE_UNDER_CERTIFIED_POLICY",
                        "cleared_funds_debited": False,
                    },
                    session=tx_session,
                )
            mission = await db.wager_missions.find_one({"id": mission["id"]}, **kwargs)
        return {"event": _public(event), "mission": mission_dto(mission), "duplicate": False}

    return await _in_transaction(work, session)


async def handle_ledger_event(event: Mapping[str, Any], session=None) -> Optional[dict[str, Any]]:
    """Session-aware observer hook for authoritative chip ledger events.

    STAKE becomes pending. REFUND reverses it. Existing payout rows do not prove
    that a stake settled (a losing stake has no payout), so game settlement code
    must separately call ``record_wager_settlement`` for every outcome.
    """
    if not feature_enabled(WAGER):
        return None
    kind = str(event.get("kind") or "").strip().upper()
    if kind not in {"STAKE", "SETTLEMENT"}:
        return None
    if kind == "STAKE":
        event_type = "STAKE"
    else:
        outcome = str(event.get("settlement_status") or "").strip().upper()
        if outcome == "SETTLED":
            event_type = "SETTLED"
        elif outcome in {"VOID", "REVERSED"}:
            event_type = "VOID"
        else:
            raise PromotionError("INVALID_WAGER_EVENT", "Settlement status is invalid.")
    return await record_wager_event(
        user_id=str(event.get("user_id") or ""),
        bet_id=str(
            event.get("source_transaction_id")
            or event.get("id")
            or ""
        ),
        event_type=event_type,
        source_event_id=str(event.get("id") or ""),
        game=str(event.get("game") or ""),
        stake_chips=int(event.get("amount") or 0),
        occurred_at=event.get("created_at") or now(),
        source_allocation=(
            event.get("funding_allocation")
            or event.get("source_allocation")
            or {}
        ),
        bet_reference=str(event.get("ref") or event.get("bet_id") or ""),
        session=session,
    )


def install_ledger_observer() -> None:
    """Install the session-aware observer exactly once.

    Application startup must call this after importing the ledger module. The
    observer is safe while rollout flags are false: it becomes a no-op and does
    not create promotion state.
    """
    import ledger  # Local import keeps this module import-safe in isolated tools/tests.

    ledger.register_ledger_observer(handle_ledger_event)


async def record_wager_settlement(
    *, user_id: str, bet_id: str, source_event_id: str, game: str,
    stake_chips: int, occurred_at: Any = None,
    source_allocation: Optional[Mapping[str, Any]] = None, session=None,
) -> Optional[dict[str, Any]]:
    return await record_wager_event(
        user_id=user_id, bet_id=bet_id, event_type="SETTLED",
        source_event_id=source_event_id, game=game, stake_chips=stake_chips,
        occurred_at=occurred_at, source_allocation=source_allocation, session=session,
    )


async def list_mission_events(user_id: str, mission_id: str, limit: int = 100) -> list[dict[str, Any]]:
    mission = await db.wager_missions.find_one({"id": mission_id, "user_id": user_id}, {"_id": 0})
    if not mission:
        raise PromotionError("MISSION_NOT_FOUND", "Wager mission was not found.", 404)
    rows = await db.wager_events.find(
        {"mission_id": mission_id}, {"_id": 0},
    ).sort("occurred_at", -1).to_list(length=max(1, min(int(limit), 250)))
    timezone_name = str(mission.get("timezone") or "UTC")
    public_rows = []
    for row in rows:
        event_type = str(row.get("event_type") or "").strip().upper()
        status = (
            "PENDING" if event_type == "STAKE"
            else "REVERSED" if event_type in {"VOID", "REFUND"}
            else "SETTLED" if event_type == "SETTLED"
            else "PENDING"
        )
        public_rows.append({
            "id": row.get("id"),
            "bet_reference": row.get("bet_reference") or row.get("bet_id"),
            "event_type": event_type,
            "status": status,
            "game": row.get("game"),
            "stake_chips": max(0, int(row.get("stake_chips", 0))),
            "contribution_bps": contribution_rate_bps_for(
                mission, str(row.get("game") or ""),
            ),
            "contribution_chips": max(0, int(row.get("contribution_chips", 0))),
            "occurred_at": row.get("occurred_at"),
            "created_at": row.get("created_at"),
            "timezone": timezone_name,
        })
    return public_rows


async def claim_mission(
    user_id: str, mission_id: str, idempotency_key: str, *, session=None,
) -> dict[str, Any]:
    require_feature(WAGER)
    idem = _validate_idempotency_key(idempotency_key)
    request_hash = _canonical_hash({"user_id": user_id, "mission_id": mission_id})

    async def work(tx_session):
        kwargs = _session_kwargs(tx_session)
        prior_idem = await db.bonus_claims.find_one(
            {"user_id": user_id, "idempotency_key": idem}, **kwargs,
        )
        if prior_idem:
            if prior_idem.get("request_hash") != request_hash:
                raise PromotionError("IDEMPOTENCY_CONFLICT", "This claim key is already in use.", 409)
            mission = await db.wager_missions.find_one({"id": mission_id}, **kwargs)
            return {"mission": mission_dto(mission), "claim": _public(prior_idem), "duplicate": True}
        mission = await db.wager_missions.find_one({"id": mission_id, "user_id": user_id}, **kwargs)
        if not mission:
            raise PromotionError("MISSION_NOT_FOUND", "Wager mission was not found.", 404)
        prior_claim = await db.bonus_claims.find_one({"mission_id": mission_id}, **kwargs)
        if prior_claim:
            return {"mission": mission_dto(mission), "claim": _public(prior_claim), "duplicate": True}
        try:
            _require_certified_settlement_finality_binding(mission)
        except PromotionError as exc:
            paused_at = now()
            paused = await db.wager_missions.update_one(
                {"id": mission_id, "status": {"$in": list(MISSION_OPEN_STATES)}},
                {"$set": {
                    "status": PAUSED_FOR_REVIEW,
                    "claim_finality_status": "FAILED_REVIEW",
                    "claim_finality_reason": "SETTLEMENT_FINALITY_POLICY_DRIFT",
                    "claim_finality_failed_at": paused_at,
                    "pause_reason_code": "SETTLEMENT_FINALITY_POLICY_DRIFT",
                    "paused_at": paused_at, "updated_at": paused_at,
                }, "$inc": {"version": 1}}, **kwargs,
            )
            if paused.modified_count:
                await _audit(
                    "system:claim-finality", "WAGER_SETTLEMENT_FINALITY_POLICY_DRIFT",
                    "MISSION", mission_id,
                    metadata={
                        "mission_policy_version": mission.get(
                            "settlement_finality_policy_version"
                        ),
                    }, session=tx_session,
                )
            return {"_promotion_error": {
                "code": exc.code, "message": exc.message,
                "status_code": exc.status_code, "meta": exc.meta,
            }}
        if (
            mission.get("status") == PENDING_SETTLEMENT
            and mission.get("claim_finality_status") == "PENDING"
        ):
            await promote_mission_claim_finality(mission_id, session=tx_session)
            mission = await db.wager_missions.find_one(
                {"id": mission_id, "user_id": user_id}, **kwargs,
            )
        if (
            mission.get("status") == PENDING_SETTLEMENT
            and mission.get("claim_finality_status") == "PENDING"
        ):
            finality_at = mission.get("claim_finality_at")
            raise PromotionError(
                "MISSION_FINALITY_PENDING",
                "The completed wager requirement is still in its authoritative settlement correction window.",
                409,
                meta={
                    "status": PENDING_SETTLEMENT,
                    "claim_finality_status": "PENDING",
                    "finality_at": finality_at,
                    "server_time": now(),
                },
            )
        if mission.get("status") == EXPIRED:
            return {"_promotion_error": {
                "code": "MISSION_EXPIRED",
                "message": "This wager mission has expired.",
                "status_code": 409,
            }}
        if (
            _as_utc(mission["deadline_at"], "deadline_at") <= now()
            and int(mission.get("settled_contribution_chips", 0))
            < int(mission.get("target_chips", 0))
            and mission.get("status") in {ACTIVE, PENDING_SETTLEMENT}
        ):
            await expire_due_mission(mission_id, session=tx_session)
            return {"_promotion_error": {
                "code": "MISSION_EXPIRED",
                "message": "This wager mission has expired.",
                "status_code": 409,
            }}
        if (
            mission.get("status") != CLAIMABLE
            or mission.get("claim_finality_status") != "SATISFIED"
            or int(mission.get("settled_contribution_chips", 0)) < int(mission.get("target_chips", 0))
        ):
            return {"_promotion_error": {
                "code": "MISSION_NOT_CLAIMABLE",
                "message": "The wager reward is not claimable.",
                "status_code": 409,
                "meta": {
                    "status": mission.get("status"),
                    "claim_finality_status": mission.get("claim_finality_status"),
                },
            }}
        reward_chips = int(mission.get("reward_chips", 0))
        reward_type = mission["reward_type"]
        wallet_bucket = (
            "available_cash_chips" if reward_type == "CASH_CREDIT" else "available_bonus_chips"
        )
        # The wallet operation request must be byte-for-byte identical across
        # concurrent retries. A random grant id would make the second request
        # look like an idempotency conflict even though it is the same mission.
        claim_id = (
            "mission-claim:"
            + hashlib.sha256(str(mission_id).encode("utf-8")).hexdigest()[:40]
        )
        # The verified deposit reserved this exact liability before the mission
        # was exposed. Consume that reservation before any wallet credit so a
        # missing/corrupt counter fails closed without withholding deposited cash.
        await _consume_wager_reward_liability(mission, session=tx_session)
        movement = await finance.apply_wallet_movement(
            user_id=user_id, kind="PROMOTION_REWARD",
            source_key=f"mission-claim:{mission_id}",
            idempotency_key=f"mission-claim:{mission_id}",
            deltas={wallet_bucket: reward_chips}, mirror_user_delta=reward_chips,
            metadata={
                "mission_id": mission_id, "campaign_id": mission["campaign_id"],
                "campaign_version": mission["campaign_version"],
                "terms_version": mission["terms_version"],
                "reward_type": reward_type, "promotion_grant_id": claim_id,
                "claim_id": claim_id,
                "bonus_source_type": "WAGER_MISSION_REWARD",
                "restriction_reason": (
                    "This promotional mission reward is not withdrawable as cash."
                    if reward_type == "BONUS_CHIPS" else None
                ),
                "restriction_class": (
                    "WITHDRAWABLE_CASH" if reward_type == "CASH_CREDIT"
                    else "RESTRICTED_BONUS"
                ),
            }, session=tx_session,
        )
        claim = {
            "id": claim_id, "mission_id": mission_id, "user_id": user_id,
            "campaign_id": mission["campaign_id"],
            "campaign_version": mission["campaign_version"],
            "reward_type": reward_type, "reward_chips": reward_chips,
            "reward_paise": int(mission.get("reward_paise", 0)),
            "reward_rate_snapshot": dict(mission.get("reward_rate_snapshot") or {}),
            "status": CLAIMED, "idempotency_key": idem, "request_hash": request_hash,
            "wallet_operation_id": movement["operation_id"], "claimed_at": now(),
        }
        try:
            await db.bonus_claims.insert_one(claim, **kwargs)
        except DuplicateKeyError:
            duplicate = await db.bonus_claims.find_one({"mission_id": mission_id}, **kwargs)
            current = await db.wager_missions.find_one({"id": mission_id}, **kwargs)
            if duplicate:
                return {
                    "mission": mission_dto(current), "claim": _public(duplicate),
                    "duplicate": True,
                }
            raise
        await db.wager_missions.update_one(
            {"id": mission_id, "status": CLAIMABLE},
            {"$set": {
                "status": CLAIMED, "claim_id": claim["id"],
                "claimed_at": claim["claimed_at"], "updated_at": now(),
            }, "$inc": {"version": 1}}, **kwargs,
        )
        mission = await db.wager_missions.find_one({"id": mission_id}, **kwargs)
        await _audit(
            user_id, "WAGER_REWARD_CLAIMED", "MISSION", mission_id,
            metadata={"claim_id": claim["id"], "reward_chips": reward_chips},
            session=tx_session,
        )
        return {
            "mission": mission_dto(mission), "claim": _public(claim),
            "wallet": {
                "cash_chips": int(movement.get("cash_chips", 0)),
                "bonus_chips": int(movement.get("bonus_chips", 0)),
                "held_chips": int(movement.get("held_chips", 0)),
            }, "duplicate": False,
        }

    result = await _in_transaction(work, session)
    internal_error = result.get("_promotion_error") if isinstance(result, Mapping) else None
    if internal_error:
        raise PromotionError(
            str(internal_error["code"]), str(internal_error["message"]),
            int(internal_error["status_code"]),
            meta=internal_error.get("meta"),
        )
    return result


async def forfeit_mission(
    user_id: str, mission_id: str, reason: str, idempotency_key: str, *, session=None,
) -> dict[str, Any]:
    require_feature(WAGER)
    idem = _validate_idempotency_key(idempotency_key)
    if len(str(reason).strip()) < 3:
        raise PromotionError("REASON_REQUIRED", "A forfeiture confirmation reason is required.")
    request_hash = _canonical_hash({
        "user_id": user_id, "mission_id": mission_id, "reason": str(reason).strip(),
    })

    async def work(tx_session):
        kwargs = _session_kwargs(tx_session)
        mission = await db.wager_missions.find_one({"id": mission_id, "user_id": user_id}, **kwargs)
        if not mission:
            raise PromotionError("MISSION_NOT_FOUND", "Wager mission was not found.", 404)
        if mission.get("status") == FORFEITED:
            if (
                mission.get("forfeit_idempotency_key") == idem
                and mission.get("forfeit_request_hash") != request_hash
            ):
                raise PromotionError(
                    "IDEMPOTENCY_CONFLICT", "This forfeiture key belongs to another request.", 409,
                )
            return mission_dto(mission)
        if not mission.get("forfeit_allowed") or mission.get("status") not in MISSION_OPEN_STATES:
            raise PromotionError("MISSION_FORFEIT_NOT_ALLOWED", "This mission cannot be forfeited.", 409)
        await db.wager_missions.update_one(
            {"id": mission_id, "status": {"$in": list(MISSION_OPEN_STATES)}},
            {"$set": {
                "status": FORFEITED, "forfeited_at": now(),
                "forfeit_reason": str(reason).strip(), "updated_at": now(),
                "forfeit_idempotency_key": idem,
                "forfeit_request_hash": request_hash,
            }, "$inc": {"version": 1}}, **kwargs,
        )
        await _release_wager_reward_liability(
            mission, reason="MISSION_FORFEITED", session=tx_session,
        )
        mission = await db.wager_missions.find_one({"id": mission_id}, **kwargs)
        await _audit(
            user_id, "WAGER_MISSION_FORFEITED", "MISSION", mission_id,
            reason=reason, session=tx_session,
        )
        return mission_dto(mission)

    return await _in_transaction(work, session)


def _rebuild_projection(events: Iterable[Mapping[str, Any]]) -> tuple[int, int]:
    groups: dict[str, list[Mapping[str, Any]]] = {}
    for event in events:
        groups.setdefault(str(event["bet_id"]), []).append(event)
    pending = settled = 0
    for rows in groups.values():
        projection = _bet_projection(rows)
        pending += int(projection["pending"])
        settled += int(projection["settled"])
    return pending, settled


def _authoritative_target_achieved_at(
    events: Iterable[Mapping[str, Any]], target_chips: int,
) -> Optional[datetime]:
    """Return the latest chronological crossing that still remains achieved.

    A void can pull the projection below the target and a later independent
    settlement can reach it again.  Finality must run from that later crossing,
    not from an earlier achievement that no longer supplies the reward.
    """
    target = max(0, int(target_chips))
    if target <= 0:
        return None
    groups: dict[str, list[Mapping[str, Any]]] = {}
    settled_total = 0
    achieved_at: Optional[datetime] = None
    ordered = sorted(
        events,
        key=lambda row: (
            _as_utc(row.get("occurred_at") or now(), "occurred_at"),
            str(row.get("source_key") or row.get("source_event_id") or ""),
        ),
    )
    for event in ordered:
        bet_id = str(event["bet_id"])
        rows = groups.setdefault(bet_id, [])
        before = int(_bet_projection(rows)["settled"])
        rows.append(event)
        after = int(_bet_projection(rows)["settled"])
        prior_total = settled_total
        settled_total = max(0, settled_total + after - before)
        if prior_total < target <= settled_total:
            achieved_at = _as_utc(event.get("occurred_at") or now(), "occurred_at")
        elif settled_total < target:
            achieved_at = None
    return achieved_at if settled_total >= target else None


def _expected_wager_event(
    mission: Mapping[str, Any], ledger_row: Mapping[str, Any], *,
    event_type: str, stake: Mapping[str, Any], contribution_chips: int,
) -> dict[str, Any]:
    source_event_id = str(ledger_row["id"])
    occurred_at = _as_utc(ledger_row.get("created_at") or now(), "created_at")
    source_allocation = dict(stake.get("funding_allocation") or {})
    payload = {
        "mission_id": mission["id"], "user_id": mission["user_id"],
        "bet_id": str(stake["id"]), "bet_reference": str(stake.get("ref") or stake["id"]),
        "event_type": event_type, "source_event_id": source_event_id,
        "game": str(stake.get("game") or "").strip().lower(),
        "stake_chips": int(stake.get("amount") or 0),
        "contribution_chips": int(contribution_chips),
        # Settlement marker allocation is not authoritative; retain the
        # original stake allocation on every derived projection row.
        "source_allocation": source_allocation,
        "occurred_at": occurred_at,
    }
    return {
        "id": f"reconciled:{hashlib.sha256(f'{source_event_id}:{event_type}'.encode()).hexdigest()[:40]}",
        "source_key": f"wager:{source_event_id}:{event_type.lower()}",
        "request_hash": _canonical_hash(payload),
        **payload,
        "created_at": now(), "reconciled_from_ledger": True,
    }


def _event_core(row: Mapping[str, Any]) -> dict[str, Any]:
    return {
        key: row.get(key)
        for key in (
            "mission_id", "user_id", "bet_id", "bet_reference", "event_type",
            "source_event_id", "game", "stake_chips", "contribution_chips",
            "source_allocation",
        )
    }


def _mission_accepts_stake_at(mission: Mapping[str, Any], stake_time: datetime) -> bool:
    if not (
        _as_utc(mission["activated_at"], "activated_at") <= stake_time
        < _as_utc(mission["deadline_at"], "deadline_at")
    ):
        return False
    closures = [
        _as_utc(mission[field], field)
        for field in ("claimed_at", "forfeited_at", "expired_at", "paused_at")
        if mission.get(field)
    ]
    if not closures and mission.get("status") in {
        CLAIMED, FORFEITED, EXPIRED, PAUSED_FOR_REVIEW,
    } and mission.get("updated_at"):
        closures.append(_as_utc(mission["updated_at"], "updated_at"))
    return not closures or stake_time < min(closures)


async def _authoritative_mission_projection(
    mission: Mapping[str, Any], *, session=None,
) -> dict[str, Any]:
    """Derive one mission entirely from authoritative chip_transactions."""
    kwargs = _session_kwargs(session)
    user_id = mission["user_id"]
    ledger_rows = await db.chip_transactions.find({
        "user_id": user_id, "kind": {"$in": ["STAKE", "SETTLEMENT"]},
    }, {"_id": 0}, **kwargs).to_list(length=None)
    stakes = {
        str(row.get("id")): row
        for row in ledger_rows if row.get("kind") == "STAKE" and row.get("id")
    }
    settlements: dict[str, list[dict[str, Any]]] = {}
    orphan_settlements: list[str] = []
    mission_start = _as_utc(mission["activated_at"], "activated_at")
    mission_end = _as_utc(mission["deadline_at"], "deadline_at")
    for row in ledger_rows:
        if row.get("kind") != "SETTLEMENT":
            continue
        source_id = str(row.get("source_transaction_id") or "")
        if source_id and source_id in stakes:
            settlements.setdefault(source_id, []).append(row)
            continue
        marker_time = _as_utc(row.get("created_at") or now(), "created_at")
        if mission_start <= marker_time <= mission_end + timedelta(days=7):
            orphan_settlements.append(str(row.get("id") or "unknown"))

    all_missions = await db.wager_missions.find(
        {"user_id": user_id}, {"_id": 0}, **kwargs,
    ).to_list(length=None)
    expected_events: list[dict[str, Any]] = []
    missing_source_allocation: list[str] = []
    invalid_source_allocation: list[str] = []
    for stake in stakes.values():
        stake_time = _as_utc(stake.get("created_at") or now(), "created_at")
        candidates = [
            row for row in all_missions
            if _mission_accepts_stake_at(row, stake_time)
        ]
        if not candidates:
            continue
        allocated = min(
            candidates,
            key=lambda row: (
                _as_utc(row["deadline_at"], "deadline_at"),
                _as_utc(row["created_at"], "created_at"), str(row["id"]),
            ),
        )
        if allocated["id"] != mission["id"]:
            continue
        allocation = stake.get("funding_allocation")
        allocation_totals = _allocation_bucket_totals(allocation)
        if not isinstance(allocation, Mapping) or not allocation:
            contribution = 0
            missing_source_allocation.append(str(stake["id"]))
        elif (
            allocation_totals is None
            or sum(allocation_totals.values()) != int(stake.get("amount") or 0)
        ):
            contribution = 0
            invalid_source_allocation.append(str(stake["id"]))
        else:
            contribution = contribution_for(
                mission, str(stake.get("game") or ""), int(stake.get("amount") or 0),
                allocation,
            )
        expected_events.append(_expected_wager_event(
            mission, stake, event_type="STAKE", stake=stake,
            contribution_chips=contribution,
        ))
        for marker in sorted(
            settlements.get(str(stake["id"]), []),
            key=lambda row: _as_utc(row.get("created_at") or now(), "created_at"),
        ):
            outcome = str(marker.get("settlement_status") or "").strip().upper()
            if outcome == "SETTLED":
                if _as_utc(marker.get("created_at") or now(), "created_at") >= mission_end:
                    # The runtime does not count a settlement after the
                    # accepted deadline. Reconciliation must not resurrect it.
                    continue
                event_type = "SETTLED"
            elif outcome in {"VOID", "REVERSED"}:
                event_type = "VOID"
            else:
                orphan_settlements.append(str(marker.get("id") or "unknown"))
                continue
            expected_events.append(_expected_wager_event(
                mission, marker, event_type=event_type, stake=stake,
                contribution_chips=contribution,
            ))

    expected_pending, expected_settled = _rebuild_projection(expected_events)
    target_achieved_at = _authoritative_target_achieved_at(
        expected_events, int(mission.get("target_chips", 0)),
    )
    existing_user_events = await db.wager_events.find(
        {"user_id": user_id}, {"_id": 0}, **kwargs,
    ).to_list(length=None)
    existing_by_source = {row["source_key"]: row for row in existing_user_events}
    expected_by_source = {row["source_key"]: row for row in expected_events}
    missing_events: list[str] = []
    corrupt_events: list[str] = []
    for source_key, expected_row in expected_by_source.items():
        existing = existing_by_source.get(source_key)
        if not existing:
            missing_events.append(source_key)
        elif _event_core(existing) != _event_core(expected_row):
            corrupt_events.append(source_key)
    orphan_events = sorted(
        row["source_key"]
        for row in existing_user_events
        if row.get("mission_id") == mission["id"] and row["source_key"] not in expected_by_source
    )
    return {
        "pending_chips": expected_pending,
        "settled_chips": expected_settled,
        "target_achieved_at": target_achieved_at,
        "expected_events": expected_events,
        "issues": {
            "missing_derived_events": sorted(missing_events),
            "corrupt_derived_events": sorted(corrupt_events),
            "orphan_derived_events": orphan_events,
            "orphan_settlement_markers": sorted(set(orphan_settlements)),
            "missing_source_allocation": sorted(missing_source_allocation),
            "invalid_source_allocation": sorted(invalid_source_allocation),
        },
    }


async def promote_mission_claim_finality(
    mission_id: str, *, session=None,
) -> dict[str, Any]:
    """Promote an earned mission only after a clean authoritative cool-off.

    The finality window is part of the accepted immutable campaign snapshot.
    No reward is put into a wallet while this function leaves the mission in
    ``PENDING_SETTLEMENT``.  Any evidence or timestamp integrity problem fails
    closed to operator review and never debits a player's existing balances.
    """
    require_feature(WAGER)

    async def work(tx_session):
        kwargs = _session_kwargs(tx_session)
        mission = await db.wager_missions.find_one({"id": str(mission_id)}, **kwargs)
        if not mission:
            raise PromotionError("MISSION_NOT_FOUND", "Wager mission was not found.", 404)
        if (
            mission.get("status") != PENDING_SETTLEMENT
            or mission.get("claim_finality_status") != "PENDING"
        ):
            return mission_dto(mission)

        stamp = now()
        version = int(mission.get("version", 1))
        finality_at = mission.get("claim_finality_at")
        finality_started_at = mission.get("claim_finality_started_at")
        target_achieved_at = mission.get("target_achieved_at")
        integrity_reasons: list[str] = []
        try:
            parsed_finality_at = _as_utc(finality_at, "claim_finality_at")
            parsed_started_at = _as_utc(finality_started_at, "claim_finality_started_at")
            parsed_achieved_at = _as_utc(target_achieved_at, "target_achieved_at")
        except PromotionError:
            parsed_finality_at = parsed_started_at = parsed_achieved_at = None
            integrity_reasons.append("FINALITY_TIMESTAMPS_MISSING_OR_INVALID")
        if parsed_finality_at and parsed_started_at and parsed_achieved_at:
            minimum_finality = parsed_started_at + timedelta(
                hours=int(mission.get("claim_finality_hours", 24)),
            )
            if parsed_started_at < parsed_achieved_at:
                integrity_reasons.append("FINALITY_STARTED_BEFORE_TARGET_ACHIEVEMENT")
            if parsed_finality_at < minimum_finality:
                integrity_reasons.append("FINALITY_WINDOW_SHORTENED")

        async def pause_for_review(
            reasons: Iterable[str], *, metadata=None,
            pause_reason_code: str = "CLAIM_FINALITY_RECONCILIATION_FAILED",
        ):
            reason_list = sorted({str(value) for value in reasons if str(value)})
            paused_at = now()
            updated = await db.wager_missions.find_one_and_update(
                {
                    "id": str(mission_id), "version": version,
                    "status": PENDING_SETTLEMENT,
                    "claim_finality_status": "PENDING",
                },
                {"$set": {
                    "status": PAUSED_FOR_REVIEW,
                    "claim_finality_status": "FAILED_REVIEW",
                    "claim_finality_reason": pause_reason_code,
                    "claim_finality_failed_at": paused_at,
                    "pause_reason_code": pause_reason_code,
                    "paused_at": paused_at, "updated_at": paused_at,
                }, "$inc": {"version": 1}},
                return_document=ReturnDocument.AFTER, **kwargs,
            )
            current = updated or await db.wager_missions.find_one(
                {"id": str(mission_id)}, **kwargs,
            )
            if updated:
                await _audit(
                    "system:claim-finality", "WAGER_CLAIM_FINALITY_FAILED",
                    "MISSION", str(mission_id),
                    metadata={"reasons": reason_list, **dict(metadata or {})},
                    session=tx_session,
                )
            return mission_dto(current)

        try:
            _require_certified_settlement_finality_binding(mission)
        except PromotionError as exc:
            return await pause_for_review(
                [exc.code],
                metadata={
                    "mission_policy_version": mission.get(
                        "settlement_finality_policy_version"
                    ),
                },
                pause_reason_code="SETTLEMENT_FINALITY_POLICY_DRIFT",
            )

        if integrity_reasons:
            return await pause_for_review(integrity_reasons)
        if parsed_finality_at > stamp:
            return mission_dto(mission)

        authoritative = await _authoritative_mission_projection(
            mission, session=tx_session,
        )
        target = int(mission.get("target_chips", 0))
        expected_pending = int(authoritative["pending_chips"])
        expected_settled = int(authoritative["settled_chips"])
        authoritative_achieved_at = authoritative.get("target_achieved_at")
        issues = authoritative["issues"]
        reasons: list[str] = []
        if any(bool(values) for values in issues.values()):
            reasons.append("AUTHORITATIVE_EVIDENCE_ISSUES")
        if (
            expected_pending != int(mission.get("pending_settlement_chips", 0))
            or expected_settled != int(mission.get("settled_contribution_chips", 0))
        ):
            reasons.append("MISSION_PROJECTION_MISMATCH")
        if expected_settled < target:
            reasons.append("TARGET_NO_LONGER_ACHIEVED")
        if not authoritative_achieved_at:
            reasons.append("AUTHORITATIVE_TARGET_ACHIEVEMENT_MISSING")
        else:
            authoritative_achieved_at = _as_utc(
                authoritative_achieved_at, "authoritative_target_achieved_at",
            )
            if authoritative_achieved_at != parsed_achieved_at:
                reasons.append("TARGET_ACHIEVEMENT_TIMESTAMP_MISMATCH")
            if authoritative_achieved_at >= _as_utc(
                mission["deadline_at"], "deadline_at",
            ):
                reasons.append("TARGET_ACHIEVED_AFTER_DEADLINE")
        if reasons:
            return await pause_for_review(
                reasons,
                metadata={
                    "expected_pending_chips": expected_pending,
                    "expected_settled_chips": expected_settled,
                    "issue_counts": {
                        name: len(values) for name, values in issues.items()
                    },
                },
            )

        satisfied_at = now()
        updated = await db.wager_missions.find_one_and_update(
            {
                "id": str(mission_id), "version": version,
                "status": PENDING_SETTLEMENT,
                "claim_finality_status": "PENDING",
                "claim_finality_at": {"$lte": satisfied_at},
            },
            {"$set": {
                "status": CLAIMABLE,
                "claim_finality_status": "SATISFIED",
                "claim_finality_reason": "AUTHORITATIVE_CORRECTION_WINDOW_SATISFIED",
                "claim_finality_satisfied_at": satisfied_at,
                "updated_at": satisfied_at,
            }, "$inc": {"version": 1}},
            return_document=ReturnDocument.AFTER, **kwargs,
        )
        current = updated or await db.wager_missions.find_one(
            {"id": str(mission_id)}, **kwargs,
        )
        if updated:
            await _audit(
                "system:claim-finality", "WAGER_CLAIM_FINALITY_SATISFIED",
                "MISSION", str(mission_id),
                metadata={
                    "target_chips": target,
                    "settled_contribution_chips": expected_settled,
                    "target_achieved_at": authoritative_achieved_at,
                    "finality_at": parsed_finality_at,
                },
                session=tx_session,
            )
        return mission_dto(current)

    return await _in_transaction(work, session)


async def reconcile_mission(
    mission_id: str, actor: str, *, repair: bool = False, reason: Optional[str] = None,
    session=None,
) -> dict[str, Any]:
    async def work(tx_session):
        kwargs = _session_kwargs(tx_session)
        mission = await db.wager_missions.find_one({"id": mission_id}, **kwargs)
        if not mission:
            raise PromotionError("MISSION_NOT_FOUND", "Wager mission was not found.", 404)
        authoritative = await _authoritative_mission_projection(mission, session=tx_session)
        expected_pending = int(authoritative["pending_chips"])
        expected_settled = int(authoritative["settled_chips"])
        authoritative_achieved_at = authoritative.get("target_achieved_at")
        stored = {
            "pending_chips": int(mission.get("pending_settlement_chips", 0)),
            "settled_chips": int(mission.get("settled_contribution_chips", 0)),
        }
        expected = {"pending_chips": expected_pending, "settled_chips": expected_settled}
        issues = authoritative["issues"]
        has_issues = any(bool(values) for values in issues.values())
        target = int(mission["target_chips"])
        finality_status = str(mission.get("claim_finality_status") or "NOT_STARTED")
        stored_achieved_at = mission.get("target_achieved_at")
        if expected_settled >= target:
            finality_matches = bool(
                authoritative_achieved_at
                and stored_achieved_at
                and _as_utc(stored_achieved_at, "target_achieved_at")
                == _as_utc(authoritative_achieved_at, "target_achieved_at")
                and finality_status in {"PENDING", "SATISFIED"}
            )
        else:
            finality_matches = finality_status not in {"PENDING", "SATISFIED"}
        matches = stored == expected and not has_issues and finality_matches
        if repair and not matches:
            if len(str(reason or "").strip()) < 5:
                raise PromotionError("REASON_REQUIRED", "A repair reason is required.")
            expected_by_source = {
                row["source_key"]: row for row in authoritative["expected_events"]
            }
            for source_key in issues["missing_derived_events"]:
                try:
                    await db.wager_events.insert_one(
                        {
                            **expected_by_source[source_key],
                            "reconciled_by": str(actor), "reconciled_at": now(),
                        }, **kwargs,
                    )
                except DuplicateKeyError:
                    # A concurrent repair inserted it. The post-repair audit
                    # below will expose any conflicting contents.
                    pass
            blocking_issue_names = (
                "corrupt_derived_events", "orphan_derived_events",
                "orphan_settlement_markers", "missing_source_allocation",
                "invalid_source_allocation",
            )
            blocking = any(issues[name] for name in blocking_issue_names)
            achieved_before_deadline = bool(
                authoritative_achieved_at
                and _as_utc(authoritative_achieved_at, "target_achieved_at")
                < _as_utc(mission["deadline_at"], "deadline_at")
            )
            if blocking or mission.get("status") == PAUSED_FOR_REVIEW:
                status = PAUSED_FOR_REVIEW
            elif mission.get("status") == CLAIMED:
                status = CLAIMED if expected_settled >= target else PAUSED_FOR_REVIEW
            elif mission.get("status") == FORFEITED:
                status = FORFEITED
            elif expected_settled >= target:
                if not achieved_before_deadline:
                    status = PAUSED_FOR_REVIEW
                elif (
                    mission.get("status") == CLAIMABLE
                    and finality_status == "SATISFIED"
                ):
                    status = CLAIMABLE
                else:
                    # Repairs never bypass the accepted correction window.
                    status = PENDING_SETTLEMENT
            elif mission.get("status") == CLAIMABLE:
                status = PAUSED_FOR_REVIEW
            elif now() >= _as_utc(mission["deadline_at"], "deadline_at"):
                status = EXPIRED
            elif expected_pending:
                status = PENDING_SETTLEMENT
            else:
                status = ACTIVE
            bps = min(10_000, expected_settled * 10_000 // target) if target else 0
            state_set: dict[str, Any] = {}
            state_unset: dict[str, str] = {}
            if status == PENDING_SETTLEMENT and expected_settled >= target:
                finality_started_at = now()
                state_set.update({
                    "claim_finality_status": "PENDING",
                    "claim_finality_started_at": finality_started_at,
                    "claim_finality_at": finality_started_at + timedelta(
                        hours=int(mission.get("claim_finality_hours", 24)),
                    ),
                    "claim_finality_reason": "RECONCILIATION_CORRECTION_WINDOW",
                    "target_achieved_at": authoritative_achieved_at,
                })
                state_unset.update({
                    "claim_finality_satisfied_at": "",
                    "claim_finality_failed_at": "",
                    "claim_finality_reset_at": "",
                })
            elif expected_settled < target and finality_status == "PENDING":
                state_set.update({
                    "claim_finality_status": "RESET_BY_RECONCILIATION",
                    "claim_finality_reset_at": now(),
                    "claim_finality_reason": "AUTHORITATIVE_PROGRESS_BELOW_TARGET",
                })
                state_unset.update({
                    "claim_finality_started_at": "", "claim_finality_at": "",
                    "claim_finality_satisfied_at": "", "target_achieved_at": "",
                })
            await db.wager_missions.update_one(
                {"id": mission_id}, {"$set": {
                    "pending_settlement_chips": expected_pending,
                    "settled_contribution_chips": expected_settled,
                    "remaining_chips": max(0, target - expected_settled),
                    "progress_percent": bps // 100, "progress_basis_points": bps,
                    "status": status,
                    **({"paused_at": now()} if status == PAUSED_FOR_REVIEW else {}),
                    **state_set,
                    "updated_at": now(),
                }, "$inc": {"version": 1},
                **({"$unset": state_unset} if state_unset else {})}, **kwargs,
            )
            await _audit(
                actor, "WAGER_MISSION_RECONCILED", "MISSION", mission_id,
                reason=reason, metadata={
                    "stored": stored, "expected": expected,
                    "issue_counts": {name: len(values) for name, values in issues.items()},
                    "status_after": status,
                },
                session=tx_session,
            )
        return {
            "mission_id": mission_id, "matches": matches,
            "stored": stored, "expected": expected, "issues": issues,
            "finality_matches": finality_matches,
            "authoritative_target_achieved_at": authoritative_achieved_at,
            "authoritative_event_count": len(authoritative["expected_events"]),
            "repaired": bool(repair and not matches),
        }

    return await _in_transaction(work, session)


async def wallet_promotion_projection(user_id: str) -> dict[str, Any]:
    mission = await get_active_mission(user_id)
    pending_reward = 0
    if mission and mission["status"] not in {CLAIMED, EXPIRED, FORFEITED}:
        pending_reward = int(mission["reward"]["chips"])
    account = await db.wallet_accounts.find_one({"user_id": user_id}, {"_id": 0}) or {}
    bonus_sources = await finance.bonus_lots_public(user_id)
    controlling_ids = sorted({
        str(source["mission_id"])
        for source in bonus_sources if source.get("mission_id")
    })
    controlling_missions: list[dict[str, Any]] = []
    if controlling_ids:
        rows = await db.wager_missions.find(
            {"user_id": user_id, "id": {"$in": controlling_ids}}, {"_id": 0},
        ).to_list(length=None)
        controlling_missions = [
            mission_dto(row) for row in sorted(rows, key=lambda value: str(value["id"]))
        ]
    return {
        # All available bonus is restricted; this never reduces available cash.
        "restricted_bonus_chips": max(0, int(account.get("available_bonus_chips", 0))),
        "restricted_bonus_sources": bonus_sources,
        "controlling_missions": controlling_missions,
        "pending_reward_chips": pending_reward,
        "active_mission": mission,
    }


async def withdrawal_eligibility_projection(
    user_id: str, requested_chips: int,
) -> dict[str, Any]:
    """Explain source restrictions without using a mission as a cash hold."""
    account = await db.wallet_accounts.find_one({"user_id": user_id}, {"_id": 0}) or {}
    withdrawable = max(0, int(account.get("available_cash_chips", 0)))
    restricted = max(0, int(account.get("available_bonus_chips", 0)))
    requested = max(0, int(requested_chips))
    bonus_sources = await finance.bonus_lots_public(user_id)
    controlling_ids = sorted({
        str(source["mission_id"])
        for source in bonus_sources if source.get("mission_id")
    })
    controlling_missions = []
    if controlling_ids:
        rows = await db.wager_missions.find(
            {"user_id": user_id, "id": {"$in": controlling_ids}}, {"_id": 0},
        ).to_list(length=None)
        controlling_missions = [
            mission_dto(row) for row in sorted(rows, key=lambda value: str(value["id"]))
        ]
    allowed = requested <= withdrawable
    return {
        "allowed": allowed,
        "code": None if allowed else "AMOUNT_EXCEEDS_WITHDRAWABLE_CASH",
        "message": (
            None if allowed else
            "The requested amount exceeds the cleared cash available for withdrawal. "
            "Restricted bonus funds are shown separately."
        ),
        "meta": {
            "requested_chips": requested,
            "withdrawable_chips": withdrawable,
            "restricted_bonus_chips": restricted,
            "restricted_bonus_sources": bonus_sources,
            "controlling_missions": controlling_missions,
            "active_mission": controlling_missions[0] if len(controlling_missions) == 1 else None,
        },
    }


def _invite_code() -> str:
    # Excludes ambiguous I/O/0/1 characters.
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    return "".join(secrets.choice(alphabet) for _ in range(10))


def invite_url(invite_code: str) -> Optional[str]:
    """Build a share URL only from the operator-approved public app origin."""
    raw = _approved_public_app_origin()
    if not raw:
        return None
    return f"{raw}/register?invite_code={quote(str(invite_code), safe='')}"


async def get_or_create_referral_profile(user_id: str, *, session=None) -> dict[str, Any]:
    kwargs = _session_kwargs(session)
    existing = await db.player_referrals.find_one({"kind": "PROFILE", "user_id": user_id}, **kwargs)
    if existing:
        return _public(existing)
    for _ in range(5):
        profile = {
            "id": str(uuid.uuid4()), "kind": "PROFILE", "user_id": user_id,
            "invite_code": _invite_code(), "status": "ACTIVE",
            "created_at": now(), "updated_at": now(),
        }
        try:
            await db.player_referrals.insert_one(profile, **kwargs)
            return _public(profile)
        except DuplicateKeyError:
            existing = await db.player_referrals.find_one(
                {"kind": "PROFILE", "user_id": user_id}, **kwargs,
            )
            if existing:
                return _public(existing)
    raise PromotionError("INVITE_CODE_UNAVAILABLE", "Could not allocate an invite code.", 503)


async def _active_referral_version(jurisdiction: str, session=None):
    stamp = now()
    return await db.promotion_versions.find_one({
        "campaign_type": REFERRAL, "status": "ACTIVE",
        "jurisdictions": str(jurisdiction).upper(),
        "starts_at": {"$lte": stamp}, "ends_at": {"$gt": stamp},
    }, sort=[("starts_at", 1)], **_session_kwargs(session))


_REFERRAL_NON_DEVICE_SIGNALS = frozenset({
    "DUPLICATE_VERIFIED_PHONE",
    "DUPLICATE_VERIFIED_EMAIL",
    "DUPLICATE_KYC_IDENTITY",
    "DUPLICATE_PAYMENT_INSTRUMENT",
})
_REFERRAL_DEVICE_SIGNALS = frozenset({
    "SHARED_DEVICE_CLUSTER", "SHARED_NETWORK_CLUSTER",
})
_REFERRAL_SUPPORT_PATH = "/support/referral-review"


def _stored_risk_tokens(user: Mapping[str, Any], kind: str) -> set[str]:
    values = dict(user.get("referral_risk_clusters") or {}).get(kind) or []
    if isinstance(values, str):
        values = [values]
    return {
        str(value) for value in values
        if re.fullmatch(r"rr1:[0-9a-f]{64}", str(value))
    }


async def _user_referral_risk_evidence(
    user_id: str, *, session=None,
) -> dict[str, set[str]]:
    """Load only privacy-safe comparison tokens for one player."""
    kwargs = _session_kwargs(session)
    user = await db.users.find_one({"id": user_id}, {"_id": 0}, **kwargs)
    if not user:
        raise PromotionError(
            "REFERRAL_ACCOUNT_EVIDENCE_UNAVAILABLE",
            "Referral account evidence is unavailable.",
            503,
        )
    evidence: dict[str, set[str]] = {
        "verified_phone": set(), "verified_email": set(),
        "kyc_identity": set(), "payment_instrument": set(),
        "device": _stored_risk_tokens(user, "device"),
        "network": _stored_risk_tokens(user, "network"),
    }
    if user.get("phone_verified") is True:
        phone = str(user.get("phone_normalized") or user.get("phone") or "").strip()
        if phone:
            evidence["verified_phone"].add(privacy_safe_risk_cluster("phone", phone))
    if user.get("email_verified") is True:
        email = str(user.get("email_normalized") or user.get("email") or "").strip()
        if email:
            evidence["verified_email"].add(privacy_safe_risk_cluster("email", email))
    if str(user.get("kyc_status") or "").strip().upper() == "VERIFIED":
        token = str(user.get("kyc_identity_cluster") or "")
        if re.fullmatch(r"rr1:[0-9a-f]{64}", token):
            evidence["kyc_identity"].add(token)

    payout_rows = await db.payout_methods.find(
        {"user_id": user_id, "fingerprint": {"$type": "string"}},
        {"_id": 0, "fingerprint": 1}, **kwargs,
    ).to_list(length=100)
    evidence["payment_instrument"].update(
        str(row["fingerprint"]) for row in payout_rows if row.get("fingerprint")
    )
    deposit_rows = await db.deposit_orders.find(
        {
            "user_id": user_id, "status": "CREDITED",
            "payment_instrument_cluster": {"$type": "string"},
        },
        {"_id": 0, "payment_instrument_cluster": 1}, **kwargs,
    ).to_list(length=250)
    evidence["payment_instrument"].update(
        str(row["payment_instrument_cluster"])
        for row in deposit_rows
        if re.fullmatch(r"rr1:[0-9a-f]{64}", str(row.get("payment_instrument_cluster") or ""))
    )
    return evidence


async def _assess_referral_risk(
    relationship: Mapping[str, Any], *, session=None,
) -> dict[str, Any]:
    inviter = await _user_referral_risk_evidence(
        str(relationship["inviter_user_id"]), session=session,
    )
    invited = await _user_referral_risk_evidence(
        str(relationship["invited_user_id"]), session=session,
    )
    matches = {
        "DUPLICATE_VERIFIED_PHONE": bool(inviter["verified_phone"] & invited["verified_phone"]),
        "DUPLICATE_VERIFIED_EMAIL": bool(inviter["verified_email"] & invited["verified_email"]),
        "DUPLICATE_KYC_IDENTITY": bool(inviter["kyc_identity"] & invited["kyc_identity"]),
        "DUPLICATE_PAYMENT_INSTRUMENT": bool(
            inviter["payment_instrument"] & invited["payment_instrument"]
        ),
        "SHARED_DEVICE_CLUSTER": bool(inviter["device"] & invited["device"]),
        "SHARED_NETWORK_CLUSTER": bool(inviter["network"] & invited["network"]),
    }
    positive = sorted(name for name, matched in matches.items() if matched)
    # The digest detects new evidence after a human clearance without storing
    # any reusable contact, KYC, payment or device token on the relationship.
    evidence_digest = _canonical_hash({
        "relationship_id": str(relationship["id"]),
        "inviter": {
            kind: sorted(hashlib.sha256(value.encode("utf-8")).hexdigest() for value in values)
            for kind, values in inviter.items()
        },
        "invited": {
            kind: sorted(hashlib.sha256(value.encode("utf-8")).hexdigest() for value in values)
            for kind, values in invited.items()
        },
    })
    return {
        "signals": {name: True for name in positive},
        "signal_names": positive,
        "evidence_digest": evidence_digest,
        "review_required": bool(positive),
        "has_non_device_signal": bool(set(positive) & _REFERRAL_NON_DEVICE_SIGNALS),
        "device_only": bool(positive) and set(positive).issubset(_REFERRAL_DEVICE_SIGNALS),
    }


async def _refresh_referral_fraud_review(
    relationship: Mapping[str, Any], *, session=None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Refresh risk evidence and reopen a stale clearance when evidence changes."""
    kwargs = _session_kwargs(session)
    assessment = await _assess_referral_risk(relationship, session=session)
    current = str(relationship.get("fraud_review_status") or "").strip().upper()
    reviewed_digest = str(relationship.get("fraud_reviewed_evidence_digest") or "")
    if current in {"REJECTED", "APPEAL_PENDING"}:
        next_status = current
    elif (
        assessment["review_required"]
        and not (current == "CLEARED" and reviewed_digest == assessment["evidence_digest"])
    ):
        next_status = "REVIEW_REQUIRED"
    else:
        next_status = "CLEARED"
    relationship_status = (
        "ACTIVE" if next_status == "CLEARED" else
        "REJECTED" if next_status in {"REJECTED", "APPEAL_PENDING"} else
        "PENDING"
    )
    update = {
        "risk_signals": assessment["signals"],
        "risk_evidence_digest": assessment["evidence_digest"],
        "risk_assessed_at": now(),
        "fraud_review_status": next_status,
        "status": relationship_status,
        "support_path": _REFERRAL_SUPPORT_PATH,
        "updated_at": now(),
    }
    refreshed = await db.player_referrals.find_one_and_update(
        {"id": relationship["id"], "kind": "RELATIONSHIP"},
        {"$set": update},
        return_document=ReturnDocument.AFTER, **kwargs,
    )
    if not refreshed:
        raise PromotionError(
            "PLAYER_REFERRAL_NOT_FOUND", "Player referral was not found.", 404,
        )
    return refreshed, assessment


async def _require_cleared_referral_review(
    relationship: Mapping[str, Any], *, session=None,
) -> dict[str, Any]:
    refreshed, assessment = await _refresh_referral_fraud_review(
        relationship, session=session,
    )
    if refreshed.get("fraud_review_status") != "CLEARED":
        raise PromotionError(
            "REFERRAL_FRAUD_REVIEW_REQUIRED",
            "Referral rewards are unavailable until the fraud review is cleared.",
            409,
            meta={
                "referral_id": str(refreshed["id"]),
                "review_status": refreshed.get("fraud_review_status"),
                "reason_code": refreshed.get("fraud_review_reason_code"),
                "signal_names": assessment["signal_names"],
                "support_path": _REFERRAL_SUPPORT_PATH,
                "appeal_status": refreshed.get("appeal_status"),
            },
        )
    return refreshed


async def attach_player_referral(
    invited_user_id: str, invite_code: str, *, jurisdiction: str,
    consented_at: Any, risk_signals: Optional[Mapping[str, Any]] = None,
    session=None,
) -> Optional[dict[str, Any]]:
    """Attach one inviter. Registration may call this without risking signup.

    ``risk_signals`` remains accepted for compatibility but is intentionally
    ignored: callers cannot submit their own fraud evidence or decision.
    """
    del risk_signals
    if not feature_enabled(REFERRAL):
        return None
    invite_code = str(invite_code or "").strip().upper()
    if not INVITE_CODE_RE.fullmatch(invite_code):
        raise PromotionError("INVALID_INVITE_CODE", "Invite code is invalid.")

    async def work(tx_session):
        kwargs = _session_kwargs(tx_session)
        existing = await db.player_referrals.find_one(
            {"kind": "RELATIONSHIP", "invited_user_id": invited_user_id}, **kwargs,
        )
        if existing:
            refreshed, _ = await _refresh_referral_fraud_review(
                existing, session=tx_session,
            )
            return _public(refreshed)
        profile = await db.player_referrals.find_one(
            {"kind": "PROFILE", "invite_code": invite_code, "status": "ACTIVE"}, **kwargs,
        )
        if not profile:
            raise PromotionError("INVITE_CODE_NOT_FOUND", "Invite code was not found.", 404)
        if profile["user_id"] == invited_user_id:
            raise PromotionError("SELF_REFERRAL_NOT_ALLOWED", "A player cannot invite their own account.", 409)
        version = await _active_referral_version(jurisdiction, tx_session)
        if not version:
            raise PromotionError("REFERRAL_CAMPAIGN_UNAVAILABLE", "Referral rewards are unavailable.", 404)
        relationship = {
            "id": str(uuid.uuid4()), "kind": "RELATIONSHIP",
            "invited_user_id": invited_user_id, "inviter_user_id": profile["user_id"],
            "invite_code_used": invite_code, "status": "PENDING",
            "fraud_review_status": "REVIEW_REQUIRED",
            "jurisdiction": str(jurisdiction).upper(),
            "campaign_id": version["campaign_id"],
            "campaign_version": int(version["version"]),
            "terms_version": version["terms_version"],
            "campaign_snapshot": _campaign_snapshot(version),
            "risk_signals": {}, "support_path": _REFERRAL_SUPPORT_PATH,
            "consented_at": _as_utc(consented_at, "consented_at"),
            "created_at": now(), "updated_at": now(),
        }
        try:
            await db.player_referrals.insert_one(relationship, **kwargs)
        except DuplicateKeyError:
            duplicate = await db.player_referrals.find_one(
                {"kind": "RELATIONSHIP", "invited_user_id": invited_user_id}, **kwargs,
            )
            if duplicate:
                refreshed, _ = await _refresh_referral_fraud_review(
                    duplicate, session=tx_session,
                )
                return _public(refreshed)
            raise
        relationship, assessment = await _refresh_referral_fraud_review(
            relationship, session=tx_session,
        )
        await _audit(
            invited_user_id, "PLAYER_REFERRAL_ATTACHED", "REFERRAL", relationship["id"],
            metadata={
                "campaign_id": version["campaign_id"],
                "status": relationship.get("fraud_review_status"),
            }, session=tx_session,
        )
        return _public(relationship)

    return await _in_transaction(work, session)


async def record_referral_event(
    invited_user_id: str, event_type: str, source_event_id: str,
    *, occurred_at: Any = None, metadata: Optional[Mapping[str, Any]] = None, session=None,
) -> Optional[dict[str, Any]]:
    if not feature_enabled(REFERRAL):
        return None
    event_type = str(event_type).strip().upper()
    if event_type not in REFERRAL_EVENT_TYPES:
        raise PromotionError("INVALID_REFERRAL_EVENT", "Referral event type is invalid.")
    source_key = f"referral:{source_event_id}:{event_type.lower()}"

    async def work(tx_session):
        kwargs = _session_kwargs(tx_session)
        duplicate = await db.referral_events.find_one({"source_key": source_key}, **kwargs)
        if duplicate:
            if (
                duplicate.get("invited_user_id") != invited_user_id
                or duplicate.get("event_type") != event_type
                or duplicate.get("source_event_id") != str(source_event_id)
                or dict(duplicate.get("metadata") or {}) != dict(metadata or {})
            ):
                raise PromotionError(
                    "REFERRAL_EVENT_CONFLICT",
                    "The authoritative referral event ID belongs to different data.", 409,
                )
            task = await db.reward_claims.find_one(
                {"kind": "TASK", "event_id": duplicate["id"]}, **kwargs,
            )
            return {"event": _public(duplicate), "task": _public(task), "duplicate": True}
        relationship = await db.player_referrals.find_one(
            {"kind": "RELATIONSHIP", "invited_user_id": invited_user_id}, **kwargs,
        )
        if not relationship:
            return None
        relationship, _ = await _refresh_referral_fraud_review(
            relationship, session=tx_session,
        )
        snapshot = dict(relationship.get("campaign_snapshot") or {})
        task_spec = dict(snapshot.get("referral_tasks") or {}).get(event_type)
        if not task_spec:
            return None
        event = {
            "id": str(uuid.uuid4()), "source_key": source_key,
            "referral_id": relationship["id"], "invited_user_id": invited_user_id,
            "inviter_user_id": relationship["inviter_user_id"],
            "event_type": event_type, "source_event_id": str(source_event_id),
            "occurred_at": _as_utc(occurred_at or now(), "occurred_at"),
            "metadata": dict(metadata or {}), "created_at": now(),
        }
        event["request_hash"] = _canonical_hash({
            key: event[key]
            for key in (
                "referral_id", "invited_user_id", "inviter_user_id", "event_type",
                "source_event_id", "occurred_at", "metadata",
            )
        })
        await db.referral_events.insert_one(event, **kwargs)
        task = {
            "id": str(uuid.uuid4()), "kind": "TASK",
            "referral_id": relationship["id"], "task_key": event_type,
            "event_id": event["id"], "user_id": relationship["inviter_user_id"],
            "invited_user_id": invited_user_id,
            "campaign_id": relationship["campaign_id"],
            "campaign_version": relationship["campaign_version"],
            "terms_version": relationship["terms_version"],
            "reward_type": snapshot["reward_type"],
            "reward_chips": int(task_spec["reward_chips"]),
            "reward_paise": int(task_spec.get("reward_paise") or 0),
            "reward_rate_snapshot": dict(snapshot.get("reward_rate_snapshot") or {}),
            "claim_threshold_chips": int(snapshot["claim_threshold_chips"]),
            "per_user_cap_chips": int(snapshot["per_user_cap_chips"]),
            "daily_cap_chips": int(snapshot["daily_cap_chips"]),
            "campaign_cap_chips": int(snapshot["campaign_cap_chips"]),
            "status": (
                "REJECTED"
                if relationship.get("fraud_review_status") == "REJECTED"
                else "PENDING"
            ),
            "fraud_review_status": relationship.get("fraud_review_status"),
            "rejection_origin": (
                "FRAUD_REVIEW"
                if relationship.get("fraud_review_status") == "REJECTED"
                else None
            ),
            "rejection_reason_code": (
                relationship.get("fraud_review_reason_code")
                if relationship.get("fraud_review_status") == "REJECTED"
                else None
            ),
            "support_path": _REFERRAL_SUPPORT_PATH,
            "verify_after": event["occurred_at"] + timedelta(
                hours=int(snapshot.get("cooling_period_hours", 24)),
            ),
            "created_at": now(), "updated_at": now(),
        }
        try:
            await db.reward_claims.insert_one(task, **kwargs)
        except DuplicateKeyError:
            task = await db.reward_claims.find_one(
                {"kind": "TASK", "referral_id": relationship["id"], "task_key": event_type},
                **kwargs,
            )
        return {"event": _public(event), "task": _public(task), "duplicate": False}

    return await _in_transaction(work, session)


async def review_referral_task(
    task_id: str, actor: str, *, approve: bool, reason: str, session=None,
) -> dict[str, Any]:
    if len(str(reason).strip()) < 5:
        raise PromotionError("REASON_REQUIRED", "A review reason is required.")

    async def work(tx_session):
        kwargs = _session_kwargs(tx_session)
        task = await db.reward_claims.find_one({"id": task_id, "kind": "TASK"}, **kwargs)
        if not task:
            raise PromotionError("REFERRAL_TASK_NOT_FOUND", "Referral task was not found.", 404)
        if task.get("status") in {"VERIFIED", "REJECTED", "CLAIMED"}:
            return _public(task)
        if approve and _as_utc(task["verify_after"], "verify_after") > now():
            raise PromotionError("REFERRAL_TASK_COOLING", "The verification period is not complete.", 409)
        if approve:
            relationship = await db.player_referrals.find_one(
                {"id": task.get("referral_id"), "kind": "RELATIONSHIP"}, **kwargs,
            )
            if not relationship:
                raise PromotionError(
                    "REFERRAL_FRAUD_REVIEW_REQUIRED",
                    "Referral rewards cannot be verified without a cleared relationship review.",
                    409,
                    meta={"referral_id": task.get("referral_id")},
                )
            relationship = await _require_cleared_referral_review(
                relationship, session=tx_session,
            )
        attempt_id = str(uuid.uuid4())
        locked = await db.reward_claims.find_one_and_update(
            {"id": task_id, "kind": "TASK", "status": "PENDING"},
            {"$set": {
                "status": "REVIEWING", "review_attempt_id": attempt_id,
                "review_started_at": now(), "updated_at": now(),
            }},
            return_document=ReturnDocument.AFTER, **kwargs,
        )
        if not locked:
            current = await db.reward_claims.find_one(
                {"id": task_id, "kind": "TASK"}, **kwargs,
            )
            if current and current.get("status") in {"VERIFIED", "REJECTED", "CLAIMED"}:
                return _public(current)
            raise PromotionError(
                "REFERRAL_TASK_REVIEW_IN_PROGRESS",
                "This referral task is already being reviewed.", 409,
            )

        reserved = False
        status = "VERIFIED" if approve else "REJECTED"
        try:
            if approve:
                await _reserve_referral_reward_cap(locked, session=tx_session)
                reserved = True
            reviewed_at = now()
            reviewed = await db.reward_claims.find_one_and_update(
                {
                    "id": task_id, "kind": "TASK", "status": "REVIEWING",
                    "review_attempt_id": attempt_id,
                },
                {
                    "$set": {
                        "status": status, "reviewed_by": str(actor),
                        "reviewed_at": reviewed_at,
                        "review_reason": str(reason).strip(), "updated_at": reviewed_at,
                        "fraud_review_status": relationship.get("fraud_review_status") if approve else task.get("fraud_review_status"),
                        **({
                            "rejection_origin": "TASK_REVIEW",
                            "rejection_reason_code": "TASK_EVIDENCE_NOT_VERIFIED",
                        } if not approve else {}),
                    },
                    "$unset": {"review_attempt_id": "", "review_started_at": ""},
                },
                return_document=ReturnDocument.AFTER, **kwargs,
            )
            if not reviewed:
                if reserved:
                    await _release_referral_reward_cap(locked, session=tx_session)
                raise PromotionError(
                    "REFERRAL_TASK_REVIEW_CONFLICT",
                    "The referral task changed during review; retry safely.", 409,
                )
        except Exception:
            # Production transactions roll this back atomically. The explicit
            # compensation also preserves invariants in the non-transactional
            # test-only fallback and if a driver reports a write conflict.
            if reserved:
                await _release_referral_reward_cap(locked, session=tx_session)
            await db.reward_claims.update_one(
                {
                    "id": task_id, "kind": "TASK", "status": "REVIEWING",
                    "review_attempt_id": attempt_id,
                },
                {
                    "$set": {"status": "PENDING", "updated_at": now()},
                    "$unset": {"review_attempt_id": "", "review_started_at": ""},
                }, **kwargs,
            )
            raise
        await _audit(
            actor, f"REFERRAL_TASK_{status}", "REWARD_TASK", task_id,
            reason=reason, session=tx_session,
        )
        return _public(reviewed)

    return await _in_transaction(work, session)


def _fraud_review_projection(relationship: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "status": relationship.get("fraud_review_status") or "REVIEW_REQUIRED",
        # Legacy rows may contain unsafe values; expose names only and never
        # serialize the corresponding evidence values.
        "signal_names": sorted(
            str(key) for key in (relationship.get("risk_signals") or {})
        ),
        "reason_code": relationship.get("fraud_review_reason_code"),
        "appeal_status": relationship.get("appeal_status"),
        "appeal_available": relationship.get("fraud_review_status") == "REJECTED",
        "support_path": relationship.get("support_path") or _REFERRAL_SUPPORT_PATH,
        "reviewed_at": relationship.get("fraud_reviewed_at"),
    }


async def review_referral_fraud(
    referral_id: str, actor: str, *, decision: str, reason_code: str,
    reason: str, session=None,
) -> dict[str, Any]:
    """Record a human duplicate-account review without exposing raw evidence."""
    require_feature(REFERRAL)
    decision = str(decision or "").strip().upper()
    reason_code = str(reason_code or "").strip().upper()
    rationale = str(reason or "").strip()
    if decision not in {"CLEAR", "REJECT"}:
        raise PromotionError(
            "INVALID_REFERRAL_FRAUD_DECISION",
            "Fraud review decision must be CLEAR or REJECT.",
        )
    if not re.fullmatch(r"[A-Z][A-Z0-9_]{2,63}", reason_code):
        raise PromotionError("REFERRAL_REASON_CODE_REQUIRED", "A review reason code is required.")
    if len(rationale) < 5:
        raise PromotionError("REASON_REQUIRED", "A review reason is required.")

    async def work(tx_session):
        kwargs = _session_kwargs(tx_session)
        relationship = await db.player_referrals.find_one(
            {"id": referral_id, "kind": "RELATIONSHIP"}, **kwargs,
        )
        if not relationship:
            raise PromotionError(
                "PLAYER_REFERRAL_NOT_FOUND", "Player referral was not found.", 404,
            )
        relationship, assessment = await _refresh_referral_fraud_review(
            relationship, session=tx_session,
        )
        signal_names = set(assessment["signal_names"])
        if decision == "REJECT":
            if assessment["device_only"]:
                raise PromotionError(
                    "DEVICE_ONLY_REJECTION_NOT_ALLOWED",
                    "A shared device or network signal cannot be the sole rejection reason.",
                    409,
                )
            if not assessment["has_non_device_signal"]:
                raise PromotionError(
                    "REFERRAL_REJECTION_EVIDENCE_REQUIRED",
                    "A verified contact, KYC or payment match is required before rejection.",
                    409,
                )
            supported_reason = (
                reason_code == "MULTI_SIGNAL_DUPLICATE_ACCOUNT"
                or reason_code in signal_names
                or (
                    reason_code == "DUPLICATE_VERIFIED_CONTACT"
                    and bool(signal_names & {
                        "DUPLICATE_VERIFIED_PHONE", "DUPLICATE_VERIFIED_EMAIL",
                    })
                )
            )
            if not supported_reason:
                raise PromotionError(
                    "REFERRAL_REASON_EVIDENCE_MISMATCH",
                    "The rejection reason code is not supported by the reviewed evidence.",
                    409,
                )
            claimed = await db.reward_claims.find_one(
                {"kind": "TASK", "referral_id": referral_id, "status": CLAIMED}, **kwargs,
            )
            if claimed:
                raise PromotionError(
                    "REFERRAL_REWARD_ALREADY_CLAIMED",
                    "A claimed referral requires a separate financial investigation.",
                    409,
                )
            verified_tasks = await db.reward_claims.find(
                {"kind": "TASK", "referral_id": referral_id, "status": "VERIFIED"},
                **kwargs,
            ).to_list(length=100)
            for task in verified_tasks:
                await _release_referral_reward_cap(task, session=tx_session)
            reviewed_at = now()
            await db.reward_claims.update_many(
                {
                    "kind": "TASK", "referral_id": referral_id,
                    "status": {"$in": ["PENDING", "REVIEWING", "VERIFIED"]},
                },
                {
                    "$set": {
                        "status": "REJECTED", "rejection_origin": "FRAUD_REVIEW",
                        "rejection_reason_code": reason_code,
                        "fraud_review_status": "REJECTED",
                        "support_path": _REFERRAL_SUPPORT_PATH,
                        "updated_at": reviewed_at,
                    },
                    "$unset": {"review_attempt_id": "", "review_started_at": ""},
                }, **kwargs,
            )
            relationship_updates = {
                "status": "REJECTED", "fraud_review_status": "REJECTED",
                "fraud_review_reason_code": reason_code,
                "fraud_review_reason": rationale,
                "fraud_reviewed_at": reviewed_at, "fraud_reviewed_by": str(actor),
                "fraud_reviewed_evidence_digest": assessment["evidence_digest"],
                "appeal_status": "AVAILABLE", "support_path": _REFERRAL_SUPPORT_PATH,
                "updated_at": reviewed_at,
            }
        else:
            reviewed_at = now()
            await db.reward_claims.update_many(
                {
                    "kind": "TASK", "referral_id": referral_id,
                    "status": "REJECTED", "rejection_origin": "FRAUD_REVIEW",
                },
                {
                    "$set": {
                        "status": "PENDING", "fraud_review_status": "CLEARED",
                        "updated_at": reviewed_at,
                    },
                    "$unset": {
                        "rejection_origin": "", "rejection_reason_code": "",
                        "reviewed_by": "", "reviewed_at": "", "review_reason": "",
                    },
                }, **kwargs,
            )
            relationship_updates = {
                "status": "ACTIVE", "fraud_review_status": "CLEARED",
                "fraud_review_reason_code": reason_code,
                "fraud_review_reason": rationale,
                "fraud_reviewed_at": reviewed_at, "fraud_reviewed_by": str(actor),
                "fraud_reviewed_evidence_digest": assessment["evidence_digest"],
                "appeal_status": (
                    "RESOLVED_CLEARED"
                    if relationship.get("fraud_review_status") == "APPEAL_PENDING"
                    or relationship.get("appeal_status") == "PENDING"
                    else "NOT_REQUIRED"
                ),
                "support_path": _REFERRAL_SUPPORT_PATH,
                "updated_at": reviewed_at,
            }
        reviewed = await db.player_referrals.find_one_and_update(
            {"id": referral_id, "kind": "RELATIONSHIP"},
            {"$set": relationship_updates},
            return_document=ReturnDocument.AFTER, **kwargs,
        )
        await _audit(
            actor, f"REFERRAL_FRAUD_{'REJECTED' if decision == 'REJECT' else 'CLEARED'}",
            "REFERRAL", referral_id, reason=rationale,
            metadata={"status": reviewed.get("fraud_review_status")},
            session=tx_session,
        )
        return _fraud_review_projection(reviewed)

    return await _in_transaction(work, session)


async def request_referral_appeal(
    user_id: str, referral_id: str, reason: str, *, session=None,
) -> dict[str, Any]:
    require_feature(REFERRAL)
    rationale = str(reason or "").strip()
    if len(rationale) < 10:
        raise PromotionError("APPEAL_REASON_REQUIRED", "Explain why this review should be reconsidered.")

    async def work(tx_session):
        kwargs = _session_kwargs(tx_session)
        relationship = await db.player_referrals.find_one({
            "id": referral_id, "kind": "RELATIONSHIP",
            "$or": [
                {"inviter_user_id": user_id}, {"invited_user_id": user_id},
            ],
        }, **kwargs)
        if not relationship:
            raise PromotionError(
                "PLAYER_REFERRAL_NOT_FOUND", "Player referral was not found.", 404,
            )
        if relationship.get("fraud_review_status") == "APPEAL_PENDING":
            return _fraud_review_projection(relationship)
        if relationship.get("fraud_review_status") != "REJECTED":
            raise PromotionError(
                "REFERRAL_APPEAL_NOT_AVAILABLE",
                "An appeal is available only after a rejected fraud review.",
                409,
            )
        appealed_at = now()
        appealed = await db.player_referrals.find_one_and_update(
            {
                "id": referral_id, "kind": "RELATIONSHIP",
                "fraud_review_status": "REJECTED",
            },
            {"$set": {
                "fraud_review_status": "APPEAL_PENDING",
                "appeal_status": "PENDING", "appeal_reason": rationale,
                "appealed_at": appealed_at, "appealed_by": user_id,
                "support_path": _REFERRAL_SUPPORT_PATH, "updated_at": appealed_at,
            }},
            return_document=ReturnDocument.AFTER, **kwargs,
        )
        if not appealed:
            raise PromotionError(
                "REFERRAL_APPEAL_CONFLICT", "Referral review changed; retry.", 409,
            )
        await _audit(
            user_id, "REFERRAL_FRAUD_APPEALED", "REFERRAL", referral_id,
            reason=rationale, metadata={"status": "APPEAL_PENDING"},
            session=tx_session,
        )
        return _fraud_review_projection(appealed)

    return await _in_transaction(work, session)


async def _reserve_referral_reward_cap(task: Mapping[str, Any], *, session=None) -> None:
    """Atomically reserve user/day/campaign caps in one shared counter doc."""
    kwargs = _session_kwargs(session)
    campaign_id = str(task["campaign_id"])
    campaign_version = int(task["campaign_version"])
    key = f"{campaign_id}:{campaign_version}"
    stamp = now()
    day_key = stamp.strftime("%Y%m%d")
    user_key = hashlib.sha256(str(task["user_id"]).encode("utf-8")).hexdigest()[:32]
    reservation_key = hashlib.sha256(str(task["id"]).encode("utf-8")).hexdigest()[:40]
    amount = int(task["reward_chips"])
    try:
        await db.referral_reward_counters.update_one(
            {"key": key},
            {"$setOnInsert": {
                "key": key, "campaign_id": campaign_id,
                "campaign_version": campaign_version,
                "approved_chips": 0, "daily": {}, "users": {},
                "reserved_task_ids": [], "reservations": {}, "created_at": stamp,
            }}, upsert=True, **kwargs,
        )
    except DuplicateKeyError:
        pass
    query = {
        "key": key,
        "reserved_task_ids": {"$ne": str(task["id"])},
        f"reservations.{reservation_key}": {"$exists": False},
        "$and": [
            {"$or": [
                {"approved_chips": {"$exists": False}},
                {"approved_chips": {"$lte": int(task["campaign_cap_chips"]) - amount}},
            ]},
            {"$or": [
                {f"daily.{day_key}": {"$exists": False}},
                {f"daily.{day_key}": {"$lte": int(task["daily_cap_chips"]) - amount}},
            ]},
            {"$or": [
                {f"users.{user_key}": {"$exists": False}},
                {f"users.{user_key}": {"$lte": int(task["per_user_cap_chips"]) - amount}},
            ]},
        ],
    }
    reserved = await db.referral_reward_counters.find_one_and_update(
        query,
        {"$inc": {
            "approved_chips": amount,
            f"daily.{day_key}": amount,
            f"users.{user_key}": amount,
        }, "$addToSet": {"reserved_task_ids": str(task["id"])},
         "$set": {
             "updated_at": stamp,
             f"reservations.{reservation_key}": {
                 "task_id": str(task["id"]), "amount": amount,
                 "day_key": day_key, "user_key": user_key,
             },
         }},
        return_document=ReturnDocument.AFTER, **kwargs,
    )
    if reserved:
        return
    current = await db.referral_reward_counters.find_one({"key": key}, **kwargs)
    if current and str(task["id"]) in set(current.get("reserved_task_ids") or []):
        # A transaction retry or concurrent identical review already reserved
        # this task; the task CAS determines the final idempotent response.
        return
    raise PromotionError(
        "REFERRAL_REWARD_CAP",
        "Approving this task would exceed a configured reward cap.", 409,
    )


async def _release_referral_reward_cap(
    task: Mapping[str, Any], *, session=None,
) -> None:
    """Release only this task's reservation after a failed review CAS."""
    kwargs = _session_kwargs(session)
    key = f"{task['campaign_id']}:{int(task['campaign_version'])}"
    reservation_key = hashlib.sha256(str(task["id"]).encode("utf-8")).hexdigest()[:40]
    counter = await db.referral_reward_counters.find_one({"key": key}, **kwargs)
    reservation = dict((counter or {}).get("reservations", {}).get(reservation_key) or {})
    if not reservation:
        return
    amount = int(reservation.get("amount") or 0)
    day_key = str(reservation.get("day_key") or "")
    user_key = str(reservation.get("user_key") or "")
    if amount <= 0 or not day_key or not user_key:
        raise PromotionError(
            "REFERRAL_CAP_RECONCILIATION_REQUIRED",
            "Referral cap reservation evidence is incomplete.", 503,
        )
    released = await db.referral_reward_counters.update_one(
        {"key": key, f"reservations.{reservation_key}.task_id": str(task["id"])},
        {
            "$inc": {
                "approved_chips": -amount,
                f"daily.{day_key}": -amount,
                f"users.{user_key}": -amount,
            },
            "$pull": {"reserved_task_ids": str(task["id"])},
            "$unset": {f"reservations.{reservation_key}": ""},
            "$set": {"updated_at": now()},
        }, **kwargs,
    )
    if released.modified_count != 1:
        raise PromotionError(
            "REFERRAL_CAP_RECONCILIATION_REQUIRED",
            "Referral cap reservation could not be released safely.", 503,
        )


def _referral_group_key(task: Mapping[str, Any]) -> tuple[str, str, int, int]:
    return (
        str(task["reward_type"]), str(task["campaign_id"]),
        int(task["campaign_version"]), int(task["claim_threshold_chips"]),
    )


def _select_referral_task_group(
    tasks: Iterable[Mapping[str, Any]],
) -> tuple[Optional[tuple[str, str, int, int]], list[Mapping[str, Any]], int]:
    groups: dict[tuple[str, str, int, int], list[Mapping[str, Any]]] = {}
    for row in tasks:
        groups.setdefault(_referral_group_key(row), []).append(row)
    # Both the player summary and claim path must select the same group even
    # though their database cursors use different presentation orders.
    ordered = sorted(
        groups.items(), key=lambda item: (
            item[0][1], item[0][2], item[0][0], item[0][3],
        ),
    )
    for key, rows in ordered:
        verified = sum(
            int(row.get("reward_chips", 0))
            for row in rows if row.get("status") == "VERIFIED"
        )
        if verified >= key[3]:
            return key, rows, len(groups)
    if not ordered:
        return None, [], 0
    # Until one group completes, show the group with the highest verified
    # progress; stable insertion order resolves ties.
    key, rows = min(
        ordered,
        key=lambda item: (
            -(
                sum(
                    int(row.get("reward_chips", 0))
                    for row in item[1] if row.get("status") == "VERIFIED"
                ) * 10_000 // max(1, item[0][3])
            ),
            item[0][1], item[0][2], item[0][0], item[0][3],
        ),
    )
    return key, rows, len(groups)


async def referral_summary(user_id: str) -> dict[str, Any]:
    require_feature(REFERRAL)
    profile = await get_or_create_referral_profile(user_id)
    profile = {**profile, "invite_url": invite_url(profile["invite_code"])}
    tasks = await db.reward_claims.find(
        {"kind": "TASK", "user_id": user_id}, {"_id": 0},
    ).sort("created_at", -1).to_list(length=250)
    selected_key, selected_tasks, group_count = _select_referral_task_group(tasks)
    relationship_ids = sorted({
        str(row.get("referral_id")) for row in tasks if row.get("referral_id")
    })
    relationships = await db.player_referrals.find(
        {"kind": "RELATIONSHIP", "id": {"$in": relationship_ids}},
    ).to_list(length=250)
    relationship_by_id = {str(row["id"]): row for row in relationships}
    selected_reviews: dict[str, dict[str, Any]] = {}
    for referral_id in {
        str(row.get("referral_id")) for row in selected_tasks if row.get("referral_id")
    }:
        relationship = relationship_by_id.get(referral_id)
        if relationship:
            relationship, _ = await _refresh_referral_fraud_review(relationship)
            relationship_by_id[referral_id] = relationship
            selected_reviews[referral_id] = _fraud_review_projection(relationship)
        else:
            selected_reviews[referral_id] = {
                "status": "REVIEW_REQUIRED", "signal_names": [],
                "reason_code": "RELATIONSHIP_EVIDENCE_MISSING",
                "appeal_status": None, "appeal_available": False,
                "support_path": _REFERRAL_SUPPORT_PATH, "reviewed_at": None,
            }
    public_tasks = []
    for task in tasks:
        referral_id = str(task.get("referral_id") or "")
        relationship = relationship_by_id.get(referral_id)
        fraud_review = (
            _fraud_review_projection(relationship)
            if relationship else selected_reviews.get(referral_id, {
                "status": "REVIEW_REQUIRED", "signal_names": [],
                "reason_code": "RELATIONSHIP_EVIDENCE_MISSING",
                "appeal_status": None, "appeal_available": False,
                "support_path": _REFERRAL_SUPPORT_PATH, "reviewed_at": None,
            })
        )
        public_tasks.append({
            "id": task.get("id"),
            "referral_id": referral_id or None,
            "task_key": task.get("task_key"),
            "task_type": task.get("task_key"),
            "status": task.get("status"),
            "campaign_id": task.get("campaign_id"),
            "campaign_version": task.get("campaign_version"),
            "terms_version": task.get("terms_version"),
            "reward_type": task.get("reward_type"),
            "reward_chips": max(0, int(task.get("reward_chips", 0))),
            "reward_paise": max(0, int(task.get("reward_paise", 0))),
            "reward_rate_snapshot": dict(task.get("reward_rate_snapshot") or {}),
            "verify_after": task.get("verify_after"),
            "verified_at": task.get("verified_at"),
            "claimed_at": task.get("claimed_at"),
            "created_at": task.get("created_at"),
            "rejection_reason": (
                "The task evidence could not be verified. Contact support if you believe this is incorrect."
                if str(task.get("status") or "").upper() == "REJECTED" else None
            ),
            "rejection_reason_code": task.get("rejection_reason_code"),
            "support_path": task.get("support_path") or _REFERRAL_SUPPORT_PATH,
            "fraud_review": fraud_review,
        })
    verified = sum(
        int(row.get("reward_chips", 0))
        for row in selected_tasks if row.get("status") == "VERIFIED"
    )
    pending = sum(
        int(row.get("reward_chips", 0))
        for row in selected_tasks if row.get("status") == "PENDING"
    )
    threshold = int(selected_key[3]) if selected_key else 0
    remaining = max(0, threshold - verified)
    percent = min(100, verified * 100 // threshold) if threshold else 0
    reviews_cleared = all(
        review.get("status") == "CLEARED" for review in selected_reviews.values()
    ) and bool(selected_tasks)
    claimable = bool(threshold and verified >= threshold and reviews_cleared)
    disabled_reason = None
    if not claimable:
        if not (threshold and verified >= threshold):
            disabled_reason = (
                "REWARDS_SPAN_CAMPAIGN_VERSIONS"
                if group_count > 1 else "VERIFICATION_OR_THRESHOLD_INCOMPLETE"
            )
        elif selected_reviews and not reviews_cleared:
            disabled_reason = "REFERRAL_FRAUD_REVIEW_REQUIRED"
        else:
            disabled_reason = "VERIFICATION_OR_THRESHOLD_INCOMPLETE"
    return {
        "referral": profile, "tasks": public_tasks,
        "rewards": {
            "verified_amount": verified, "pending_amount": pending,
            "claim_threshold": threshold, "remaining": remaining,
            "progress_percent": percent, "claimable": claimable,
            "disabled_reason": disabled_reason,
            "compatible_campaign_id": selected_key[1] if selected_key else None,
            "compatible_campaign_version": selected_key[2] if selected_key else None,
            "total_verified_amount": sum(
                int(row.get("reward_chips", 0))
                for row in tasks if row.get("status") == "VERIFIED"
            ),
        },
    }


async def claim_referral_rewards(
    user_id: str, idempotency_key: str, *, session=None,
) -> dict[str, Any]:
    require_feature(REFERRAL)
    idem = _validate_idempotency_key(idempotency_key)
    request_hash = _canonical_hash({"user_id": user_id, "kind": "REFERRAL_REWARD_CLAIM"})

    async def work(tx_session):
        kwargs = _session_kwargs(tx_session)
        prior = await db.reward_claims.find_one(
            {"kind": "CLAIM", "user_id": user_id, "idempotency_key": idem}, **kwargs,
        )
        if prior:
            if prior.get("request_hash") != request_hash:
                raise PromotionError("IDEMPOTENCY_CONFLICT", "This claim key is already in use.", 409)
            return {"claim": _public(prior), "duplicate": True}
        tasks = await db.reward_claims.find(
            {"kind": "TASK", "user_id": user_id, "status": "VERIFIED"}, **kwargs,
        ).sort("created_at", 1).to_list(length=1000)
        if not tasks:
            raise PromotionError("REFERRAL_REWARD_NOT_CLAIMABLE", "No verified referral reward is available.", 409)
        selected_key, selected, _ = _select_referral_task_group(tasks)
        if selected_key is None or sum(int(row["reward_chips"]) for row in selected) < selected_key[3]:
            verified = sum(int(row["reward_chips"]) for row in tasks)
            raise PromotionError(
                "REFERRAL_REWARD_NOT_CLAIMABLE",
                "No campaign-version reward threshold is complete.", 409,
                meta={"verified_chips": verified},
            )
        tasks = list(selected)
        for referral_id in sorted({str(row.get("referral_id") or "") for row in tasks}):
            relationship = await db.player_referrals.find_one(
                {"id": referral_id, "kind": "RELATIONSHIP"}, **kwargs,
            )
            if not relationship:
                raise PromotionError(
                    "REFERRAL_FRAUD_REVIEW_REQUIRED",
                    "Referral rewards cannot be claimed without a cleared relationship review.",
                    409,
                    meta={
                        "referral_id": referral_id,
                        "reason_code": "RELATIONSHIP_EVIDENCE_MISSING",
                        "support_path": _REFERRAL_SUPPORT_PATH,
                    },
                )
            await _require_cleared_referral_review(
                relationship, session=tx_session,
            )
        reward_types = {row["reward_type"] for row in tasks}
        total = sum(int(row["reward_chips"]) for row in tasks)
        threshold = max(int(row["claim_threshold_chips"]) for row in tasks)
        if total < threshold:
            raise PromotionError(
                "REFERRAL_REWARD_NOT_CLAIMABLE",
                "The verified referral reward threshold is not complete.", 409,
                meta={"verified_chips": total, "threshold_chips": threshold},
            )
        reward_type = next(iter(reward_types))
        bucket = "available_cash_chips" if reward_type == "CASH_CREDIT" else "available_bonus_chips"
        task_ids = sorted(row["id"] for row in tasks)
        task_set_key = hashlib.sha256(":".join(task_ids).encode("utf-8")).hexdigest()
        existing_set = await db.reward_claims.find_one(
            {"kind": "CLAIM", "task_set_key": task_set_key}, **kwargs,
        )
        if existing_set:
            return {"claim": _public(existing_set), "duplicate": True}
        claim_id = f"referral-claim:{task_set_key[:40]}"
        movement = await finance.apply_wallet_movement(
            user_id=user_id, kind="REFERRAL_REWARD",
            source_key=f"referral-task-set:{task_set_key}",
            idempotency_key=f"referral-task-set:{task_set_key}",
            deltas={bucket: total}, mirror_user_delta=total,
            metadata={
                "task_ids": task_ids, "reward_type": reward_type,
                "campaign_id": tasks[0]["campaign_id"],
                "campaign_version": tasks[0]["campaign_version"],
                "terms_version": tasks[0].get("terms_version"),
                "promotion_grant_id": claim_id,
                "referral_claim_id": claim_id,
                "bonus_source_type": "REFERRAL_REWARD",
                "restriction_reason": (
                    "This referral promotion reward is not withdrawable as cash."
                    if reward_type == "BONUS_CHIPS" else None
                ),
                "restriction_class": (
                    "WITHDRAWABLE_CASH" if reward_type == "CASH_CREDIT"
                    else "RESTRICTED_BONUS"
                ),
            },
            session=tx_session,
        )
        claimed_at = now()
        claim = {
            "id": claim_id, "kind": "CLAIM", "user_id": user_id,
            "task_ids": task_ids, "task_set_key": task_set_key, "reward_type": reward_type,
            "campaign_id": tasks[0]["campaign_id"],
            "campaign_version": int(tasks[0]["campaign_version"]),
            "terms_version": tasks[0].get("terms_version"),
            "reward_chips": total,
            "reward_paise": sum(int(row.get("reward_paise", 0)) for row in tasks),
            "reward_rate_snapshot": dict(tasks[0].get("reward_rate_snapshot") or {}),
            "status": CLAIMED, "idempotency_key": idem, "request_hash": request_hash,
            "wallet_operation_id": movement["operation_id"], "claimed_at": claimed_at,
        }
        try:
            await db.reward_claims.insert_one(claim, **kwargs)
        except DuplicateKeyError:
            duplicate = await db.reward_claims.find_one(
                {"kind": "CLAIM", "task_set_key": task_set_key}, **kwargs,
            )
            if duplicate:
                return {"claim": _public(duplicate), "duplicate": True}
            raise
        result = await db.reward_claims.update_many(
            {"id": {"$in": claim["task_ids"]}, "kind": "TASK", "status": "VERIFIED"},
            {"$set": {"status": CLAIMED, "claim_id": claim_id, "claimed_at": claimed_at, "updated_at": claimed_at}},
            **kwargs,
        )
        if result.modified_count != len(tasks):
            raise PromotionError("REFERRAL_CLAIM_CONFLICT", "Referral rewards changed; retry safely.", 409)
        await _audit(
            user_id, "REFERRAL_REWARDS_CLAIMED", "REWARD_CLAIM", claim_id,
            metadata={"reward_chips": total, "task_count": len(tasks)}, session=tx_session,
        )
        return {
            "claim": _public(claim), "duplicate": False,
            "wallet": {
                "cash_chips": int(movement.get("cash_chips", 0)),
                "bonus_chips": int(movement.get("bonus_chips", 0)),
                "held_chips": int(movement.get("held_chips", 0)),
            },
        }

    return await _in_transaction(work, session)


async def list_campaigns(campaign_type: Optional[str] = None) -> list[dict[str, Any]]:
    query = {"campaign_type": str(campaign_type).upper()} if campaign_type else {}
    return await db.promotion_campaigns.find(query, {"_id": 0}).sort("created_at", -1).to_list(length=500)


_OPERATOR_SAFE_AUDIT_METADATA = {
    "campaign_id", "campaign_version", "deposit_id", "target_chips",
    "bet_id", "source_event_id", "task_id", "claim_id", "status",
    "reward_chips", "contribution_chips", "mission_id",
    "expected_pending", "expected_settled", "stored_pending", "stored_settled",
    "repair", "jurisdiction", "terms_version",
}


def _operator_safe_audit_row(row: Mapping[str, Any]) -> dict[str, Any]:
    """Project one audit row onto the documented operator-safe surface."""
    metadata = dict(row.get("metadata") or {})
    safe_metadata = {
        key: value for key, value in metadata.items()
        if key in _OPERATOR_SAFE_AUDIT_METADATA
        and (value is None or isinstance(value, (str, int, float, bool)))
    }
    return {
        "id": row.get("id"), "actor": row.get("actor"),
        "action": row.get("action"), "entity_type": row.get("entity_type"),
        "entity_id": row.get("entity_id"), "reason": row.get("reason"),
        # Audited operator fields are scalar by contract. Reject nested values
        # so a legacy/arbitrary document cannot smuggle raw evidence through an
        # otherwise approved key such as ``status`` or ``claim_id``.
        "metadata": safe_metadata,
        "created_at": row.get("created_at"),
    }


async def list_promotion_audit(
    *, entity_type: Optional[str] = None, entity_id: Optional[str] = None,
    action: Optional[str] = None, page: int = 1, limit: int = 100,
) -> dict[str, Any]:
    """Bounded operator audit history without identity/device/payment secrets."""
    bounded_limit = max(1, min(int(limit), 250))
    bounded_page = max(1, min(int(page), 10_000))
    query: dict[str, Any] = {}
    if entity_type:
        query["entity_type"] = str(entity_type).strip().upper()
    if entity_id:
        query["entity_id"] = str(entity_id).strip()
    if action:
        query["action"] = str(action).strip().upper()
    total = await db.promotion_audit.count_documents(query)
    rows = await db.promotion_audit.find(query, {"_id": 0}).sort([
        ("created_at", -1), ("id", -1),
    ]).skip((bounded_page - 1) * bounded_limit).limit(bounded_limit).to_list(
        length=bounded_limit,
    )
    safe_rows = [_operator_safe_audit_row(row) for row in rows]
    return {
        "audits": safe_rows, "page": bounded_page, "limit": bounded_limit,
        "total": int(total),
        "next_page": bounded_page + 1 if bounded_page * bounded_limit < total else None,
    }


async def campaign_detail(campaign_id: str) -> dict[str, Any]:
    campaign = await db.promotion_campaigns.find_one({"id": campaign_id}, {"_id": 0})
    if not campaign:
        raise PromotionError("CAMPAIGN_NOT_FOUND", "Campaign was not found.", 404)
    versions = await db.promotion_versions.find(
        {"campaign_id": campaign_id}, {"_id": 0},
    ).sort("version", -1).to_list(length=100)
    return {"campaign": campaign, "versions": versions}


_ADMIN_WAGER_EVENT_FIELDS = (
    "id", "mission_id", "bet_id", "bet_reference", "event_type",
    "source_event_id", "game", "stake_chips", "contribution_chips",
    "occurred_at", "created_at",
)

_ADMIN_BONUS_CLAIM_FIELDS = (
    "id", "mission_id", "campaign_id", "campaign_version", "reward_type",
    "reward_chips", "reward_paise", "status", "claimed_at", "created_at",
    "updated_at",
)

_ADMIN_REFERRAL_RELATIONSHIP_FIELDS = (
    "id", "kind", "inviter_user_id", "invited_user_id", "status",
    "jurisdiction", "campaign_id", "campaign_version", "terms_version",
    "support_path", "consented_at", "created_at", "updated_at",
)

_ADMIN_REFERRAL_EVENT_FIELDS = (
    "id", "referral_id", "event_type", "occurred_at", "created_at",
)

_ADMIN_REFERRAL_TASK_FIELDS = (
    "id", "kind", "referral_id", "task_key", "event_id", "user_id",
    "invited_user_id", "campaign_id", "campaign_version", "terms_version",
    "reward_type", "reward_chips", "reward_paise", "claim_threshold_chips",
    "status", "fraud_review_status", "rejection_origin",
    "rejection_reason_code", "support_path", "verify_after", "reviewed_by",
    "reviewed_at", "review_reason", "claim_id", "claimed_at", "created_at",
    "updated_at",
)


def _allowlisted_admin_projection(
    row: Mapping[str, Any], fields: tuple[str, ...],
) -> dict[str, Any]:
    """Return only explicitly reviewed fields from a financial/admin record."""
    return {key: row.get(key) for key in fields if key in row}


def admin_referral_task_dto(row: Mapping[str, Any]) -> dict[str, Any]:
    """Operator-safe referral task without retry, wallet or risk internals."""
    return _allowlisted_admin_projection(row, _ADMIN_REFERRAL_TASK_FIELDS)


async def list_admin_referral_tasks(
    *, status: Optional[str] = None, limit: int = 100,
) -> list[dict[str, Any]]:
    """List bounded referral tasks through the operator-safe projection."""
    query: dict[str, Any] = {"kind": "TASK"}
    if status:
        query["status"] = str(status).strip().upper()
    bounded_limit = max(1, min(int(limit), 500))
    rows = await db.reward_claims.find(query, {"_id": 0}).sort(
        "created_at", -1,
    ).to_list(length=bounded_limit)
    return [admin_referral_task_dto(row) for row in rows]


async def admin_mission_detail(mission_id: str) -> dict[str, Any]:
    mission = await db.wager_missions.find_one({"id": mission_id}, {"_id": 0})
    if not mission:
        raise PromotionError("MISSION_NOT_FOUND", "Wager mission was not found.", 404)
    events = await db.wager_events.find(
        {"mission_id": mission_id}, {"_id": 0},
    ).sort("occurred_at", -1).to_list(length=500)
    claims = await db.bonus_claims.find({"mission_id": mission_id}, {"_id": 0}).to_list(length=10)
    audit_page = await list_promotion_audit(
        entity_type="MISSION", entity_id=mission_id, page=1, limit=250,
    )
    return {
        "mission": mission_dto(mission),
        "events": [
            _allowlisted_admin_projection(row, _ADMIN_WAGER_EVENT_FIELDS)
            for row in events
        ],
        "claims": [
            _allowlisted_admin_projection(row, _ADMIN_BONUS_CLAIM_FIELDS)
            for row in claims
        ],
        "audit": audit_page["audits"],
    }


async def admin_referral_detail(referral_id: str) -> dict[str, Any]:
    relationship = await db.player_referrals.find_one(
        {"id": referral_id, "kind": "RELATIONSHIP"}, {"_id": 0},
    )
    if not relationship:
        raise PromotionError("PLAYER_REFERRAL_NOT_FOUND", "Player referral was not found.", 404)
    events = await db.referral_events.find(
        {"referral_id": referral_id}, {"_id": 0},
    ).sort("occurred_at", -1).to_list(length=250)
    tasks = await db.reward_claims.find(
        {"kind": "TASK", "referral_id": referral_id}, {"_id": 0},
    ).sort("created_at", -1).to_list(length=100)
    public_relationship = _allowlisted_admin_projection(
        relationship, _ADMIN_REFERRAL_RELATIONSHIP_FIELDS,
    )
    fraud_review = _fraud_review_projection(relationship)
    # Preserve a useful structured reason for the existing admin UI without
    # returning the free-form review narrative, which may contain PII.
    fraud_review["reason"] = relationship.get("fraud_review_reason_code")
    fraud_review["appealed_at"] = relationship.get("appealed_at")
    return {
        "referral": public_relationship,
        "fraud_review": fraud_review,
        "events": [
            _allowlisted_admin_projection(row, _ADMIN_REFERRAL_EVENT_FIELDS)
            for row in events
        ],
        "tasks": [admin_referral_task_dto(row) for row in tasks],
    }
