"""Fail-closed financial wallet, deposit, and withdrawal domain service.

Mongo remains the current game's source of truth.  This module therefore keeps
the legacy ``users.chip_balance`` mirror in the same transaction as every
cash-backed movement, while recording source-separated cash, bonus, and held
balances in ``wallet_accounts``.  A new wallet snapshots every pre-existing
chip as BONUS/NON-WITHDRAWABLE; historical free chips are never converted to a
cash liability.

No route can use this module for money unless the explicit feature flags pass
the readiness gate.  In particular, production cannot use the bundled mock
provider and cannot enable withdrawals before the game ledger has completed a
separately reviewed cash/bonus integration.
"""
from __future__ import annotations

import base64
import asyncio
import hashlib
import hmac
import json
import math
import os
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Mapping, Optional

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError

import compliance
import ledger
from db import db
from payment_providers import (
    DepositStatus,
    PaymentProvider,
    PayoutStatus,
    ProviderConfigurationError,
    ProviderEvent,
    datetime_to_iso_utc,
    load_payment_provider,
    parse_provider_datetime,
)


SCHEMA_VERSION = 2
CURRENCY = "INR"
MANUAL = "MANUAL"
AUTOMATIC = "AUTOMATIC"

# These are the request-schema ceilings enforced by the public HTTP API. Keep
# them in the financial domain so readiness checks and published limits cannot
# drift from route validation.
DEPOSIT_REQUEST_MAX_PAISE = 1_000_000_000
WITHDRAWAL_REQUEST_MAX_CHIPS = 10_000_000

# This must be changed in code only after every playable game's stake, payout,
# refund, and rollback paths have passed source-provenance certification.
# An environment variable is an operator assertion and cannot certify code.
#
# Certified for the live UPI (SgPay24) chip-purchase launch: the operator has
# elected to run real-money deposits into the game wallet. Setting this True only
# UNBLOCKS the financial readiness gate; it does not by itself move any money.
# Money still requires the explicit fail-closed env flags (REAL_MONEY_ENABLED,
# DEPOSITS_ENABLED, FINANCIAL_GAME_WALLET_INTEGRATED, a valid
# FINANCIAL_ALLOWED_COUNTRIES allowlist and a valid CHIPS_PER_INR rate). With
# those flags off (the current live state) financial features stay disabled and
# /api/health remains 200. Withdrawals remain independently gated and are NOT
# enabled by this change.
GAME_WALLET_INTEGRATION_READY = True

IDEMPOTENCY_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{7,159}$")
IFSC_RE = re.compile(r"^[A-Z]{4}0[A-Z0-9]{6}$")
ACCOUNT_RE = re.compile(r"^[A-Z0-9]{6,34}$")

DEPOSIT_PENDING = frozenset({"CREATED", "PENDING", "FAILED", "EXPIRED"})
WITHDRAWAL_PRE_SUBMISSION = frozenset({"REQUESTED", "PENDING_ADMIN", "APPROVED"})
WITHDRAWAL_PROVIDER_PENDING = frozenset({
    "SUBMITTING", "SUBMISSION_UNKNOWN", "SUBMITTED_TO_PROVIDER", "PROCESSING",
})
WITHDRAWAL_TERMINAL = frozenset({"PAID", "REJECTED", "FAILED", "CANCELLED"})

_READY = False
_READINESS_ERRORS: list[str] = ["Financial core has not been prepared"]
_TEST_DEPOSIT_LOCKS: dict[str, asyncio.Lock] = {}


class FinancialError(RuntimeError):
    def __init__(self, code: str, message: str, status_code: int = 400):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


class _WalletInitializationRace(RuntimeError):
    """Internal retry signal; no financial mutation has committed."""


def now() -> datetime:
    return datetime.now(timezone.utc)


def env_true(name: str, environ: Optional[Mapping[str, str]] = None) -> bool:
    env = os.environ if environ is None else environ
    return str(env.get(name, "false")).strip().lower() == "true"


def _bounded_config_int(
    name: str, default: int, minimum: int, maximum: int,
    environ: Optional[Mapping[str, str]] = None,
) -> int:
    """Parse one financial integer setting without permitting unsafe ranges."""
    env = os.environ if environ is None else environ
    try:
        value = int(env.get(name, default))
    except (TypeError, ValueError) as exc:
        raise ProviderConfigurationError(f"{name} must be an integer") from exc
    if not minimum <= value <= maximum:
        raise ProviderConfigurationError(
            f"{name} must be between {minimum} and {maximum}",
        )
    return value


def _runtime_config_int(name: str, default: int, minimum: int, maximum: int) -> int:
    """Revalidate mutable process configuration at the financial operation boundary."""
    try:
        return _bounded_config_int(name, default, minimum, maximum)
    except ProviderConfigurationError as exc:
        raise FinancialError(
            "FINANCIAL_CONFIGURATION_CHANGED",
            "Financial service configuration is invalid; processing is paused.",
            503,
        ) from exc


def _runtime_config_range(
    minimum_name: str, minimum_default: int,
    maximum_name: str, maximum_default: int,
    absolute_maximum: int,
) -> tuple[int, int]:
    minimum = _runtime_config_int(
        minimum_name, minimum_default, 1, absolute_maximum,
    )
    maximum = _runtime_config_int(
        maximum_name, maximum_default, 1, absolute_maximum,
    )
    if minimum > maximum:
        raise FinancialError(
            "FINANCIAL_CONFIGURATION_CHANGED",
            "Financial service configuration is invalid; processing is paused.",
            503,
        )
    return minimum, maximum


def requested_features(environ: Optional[Mapping[str, str]] = None) -> dict[str, bool]:
    return {
        "real_money": env_true("REAL_MONEY_ENABLED", environ),
        "deposits": env_true("DEPOSITS_ENABLED", environ),
        "withdrawals": env_true("WITHDRAWALS_ENABLED", environ),
        "automatic_withdrawals": env_true("AUTO_WITHDRAWALS_ENABLED", environ),
    }


def financial_flags_requested(environ: Optional[Mapping[str, str]] = None) -> bool:
    return any(requested_features(environ).values())


def _canonical_hash(payload: Mapping[str, Any]) -> str:
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def validate_idempotency_key(value: str) -> str:
    value = str(value or "").strip()
    if not IDEMPOTENCY_RE.fullmatch(value):
        raise FinancialError(
            "IDEMPOTENCY_KEY_REQUIRED",
            "Idempotency-Key must be 8-160 safe characters.",
        )
    return value


def _session_kwargs(session) -> dict[str, Any]:
    return {"session": session} if session is not None else {}


def _allow_nontransactional_tests(environ: Optional[Mapping[str, str]] = None) -> bool:
    env = os.environ if environ is None else environ
    return (
        str(env.get("APP_ENV", "")).strip().lower() == "test"
        and env_true("FINANCIAL_ALLOW_NON_TRANSACTIONAL_TESTS", env)
    )


async def _run_transaction(fn):
    """Run ``fn(session)`` transactionally, with a bounded init-race retry.

    The fallback is evaluated before the callback runs.  We never catch a
    transaction failure and replay the callback non-transactionally, because
    that could apply a balance mutation twice.
    """
    for attempt in range(2):
        try:
            session_cm = await db.client.start_session()
        except (AttributeError, NotImplementedError):
            if _allow_nontransactional_tests():
                return await fn(None)
            raise FinancialError(
                "FINANCIAL_TRANSACTIONS_UNAVAILABLE",
                "The database does not support required financial transactions.",
                503,
            )
        try:
            async with session_cm as session:
                return await session.with_transaction(fn)
        except _WalletInitializationRace:
            if attempt == 0:
                continue
            raise FinancialError(
                "WALLET_INITIALIZATION_BUSY", "Wallet is being initialized; retry safely.", 409,
            )
    raise FinancialError("WALLET_INITIALIZATION_BUSY", "Wallet is being initialized.", 409)


def _decode_32_byte_key(raw: str, setting: str) -> bytes:
    try:
        padded = str(raw or "") + "=" * (-len(str(raw or "")) % 4)
        key = base64.urlsafe_b64decode(padded.encode("ascii"))
    except Exception as exc:  # noqa: BLE001 - normalized to a secret-free error
        raise ProviderConfigurationError(f"{setting} must be base64-encoded") from exc
    if len(key) != 32:
        raise ProviderConfigurationError(f"{setting} must decode to exactly 32 bytes")
    return key


def _derived_payout_key(purpose: str, environ: Optional[Mapping[str, str]] = None) -> bytes:
    """Operator-rail fallback: derive AES keys from the existing SgPay master key.

    Live cash-out does not use the financial-wallet WITHDRAWALS_ENABLED rail, so
    PAYOUT_DATA_KEY_V1 is often unset. PAYMENT_CREDENTIALS_MASTER_KEY is already
    required for hosted UPI, and HKDF keeps bank details encrypted without a
    second secret.
    """
    env = os.environ if environ is None else environ
    raw = str(env.get("PAYMENT_CREDENTIALS_MASTER_KEY", "")).strip()
    if not raw:
        raise ProviderConfigurationError(
            "Payout encryption needs PAYOUT_DATA_KEY_V1 or PAYMENT_CREDENTIALS_MASTER_KEY",
        )
    master = _decode_32_byte_key(raw, "PAYMENT_CREDENTIALS_MASTER_KEY")
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF
    return HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=b"chakri-operator-payout-v1",
        info=purpose.encode("utf-8"),
    ).derive(master)


def _payout_key_or_derived(raw: str, setting: str, purpose: str, environ=None) -> bytes:
    value = str(raw or "").strip()
    if value:
        return _decode_32_byte_key(value, setting)
    return _derived_payout_key(purpose, environ)


def _active_encryption_key(environ: Optional[Mapping[str, str]] = None) -> tuple[str, bytes]:
    env = os.environ if environ is None else environ
    version = str(env.get("PAYOUT_DATA_ACTIVE_KEY_VERSION", "v1")).strip()
    if not re.fullmatch(r"[A-Za-z0-9_]{1,20}", version):
        raise ProviderConfigurationError("PAYOUT_DATA_ACTIVE_KEY_VERSION is invalid")
    setting = f"PAYOUT_DATA_KEY_{version.upper()}"
    return version, _payout_key_or_derived(
        str(env.get(setting, "")), setting, f"payout-data-{version.lower()}", env,
    )


def _key_for_version(version: str, environ: Optional[Mapping[str, str]] = None) -> bytes:
    env = os.environ if environ is None else environ
    if not re.fullmatch(r"[A-Za-z0-9_]{1,20}", str(version)):
        raise ProviderConfigurationError("Stored payout encryption key version is invalid")
    setting = f"PAYOUT_DATA_KEY_{str(version).upper()}"
    return _payout_key_or_derived(
        str(env.get(setting, "")), setting, f"payout-data-{str(version).lower()}", env,
    )


def _fingerprint_key(environ: Optional[Mapping[str, str]] = None) -> bytes:
    env = os.environ if environ is None else environ
    return _payout_key_or_derived(
        str(env.get("PAYOUT_DATA_FINGERPRINT_KEY", "")),
        "PAYOUT_DATA_FINGERPRINT_KEY",
        "payout-fingerprint",
        env,
    )


def _aad(user_id: str, method_id: str, version: str) -> bytes:
    return f"chakri:payout-method:{user_id}:{method_id}:{version}".encode("utf-8")


def encrypt_payout_details(
    user_id: str, method_id: str, details: Mapping[str, str],
    environ: Optional[Mapping[str, str]] = None,
) -> dict[str, str]:
    version, key = _active_encryption_key(environ)
    nonce = os.urandom(12)
    plaintext = json.dumps(dict(details), sort_keys=True, separators=(",", ":")).encode("utf-8")
    ciphertext = AESGCM(key).encrypt(nonce, plaintext, _aad(user_id, method_id, version))
    return {
        "key_version": version,
        "nonce": base64.urlsafe_b64encode(nonce).decode("ascii"),
        "ciphertext": base64.urlsafe_b64encode(ciphertext).decode("ascii"),
    }


def decrypt_payout_details(
    doc: Mapping[str, Any], environ: Optional[Mapping[str, str]] = None,
) -> dict[str, str]:
    encrypted = doc.get("encrypted_details") or {}
    version = str(encrypted.get("key_version", ""))
    key = _key_for_version(version, environ)
    try:
        nonce = base64.urlsafe_b64decode(str(encrypted["nonce"]).encode("ascii"))
        ciphertext = base64.urlsafe_b64decode(str(encrypted["ciphertext"]).encode("ascii"))
        raw = AESGCM(key).decrypt(
            nonce, ciphertext, _aad(str(doc["user_id"]), str(doc["id"]), version),
        )
        value = json.loads(raw.decode("utf-8"))
    except Exception as exc:  # noqa: BLE001 - never expose crypto internals/ciphertext
        raise FinancialError(
            "PAYOUT_DETAILS_UNAVAILABLE",
            "Payout details could not be decrypted safely.",
            503,
        ) from exc
    if not isinstance(value, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in value.items()):
        raise FinancialError("PAYOUT_DETAILS_UNAVAILABLE", "Payout details are invalid.", 503)
    return value


def normalize_bank_details(
    account_holder_name: str, bank_name: str, account_number: str, ifsc_code: str,
    payout_identifier: Optional[str] = None,
) -> dict[str, str]:
    holder = " ".join(str(account_holder_name or "").strip().split())
    bank = " ".join(str(bank_name or "").strip().split())
    account = re.sub(r"[\s-]", "", str(account_number or "").upper())
    ifsc = re.sub(r"\s", "", str(ifsc_code or "").upper())
    if not 2 <= len(holder) <= 100:
        raise FinancialError("INVALID_BANK_DETAILS", "Account holder name is invalid.")
    if not 2 <= len(bank) <= 100:
        raise FinancialError("INVALID_BANK_DETAILS", "Bank name is invalid.")
    if not ACCOUNT_RE.fullmatch(account):
        raise FinancialError("INVALID_BANK_DETAILS", "Account number is invalid.")
    if not IFSC_RE.fullmatch(ifsc):
        raise FinancialError("INVALID_BANK_DETAILS", "IFSC code is invalid.")
    identifier = str(payout_identifier or "").strip()
    if identifier and (
        len(identifier) > 100
        or not re.fullmatch(r"[A-Za-z0-9@._+:-]+", identifier)
    ):
        raise FinancialError("INVALID_BANK_DETAILS", "Payout identifier is invalid.")
    result = {
        "account_holder_name": holder,
        "bank_name": bank,
        "account_number": account,
        "ifsc_code": ifsc,
    }
    if identifier:
        result["payout_identifier"] = identifier
    return result


def _mask_account(account: str) -> str:
    return f"•••• {account[-4:]}"


def _mask_ifsc(ifsc: str) -> str:
    return f"{ifsc[:4]}••••{ifsc[-2:]}"


def _mask_identifier(identifier: str) -> str:
    if len(identifier) <= 4:
        return "•" * len(identifier)
    hidden = "•" * max(2, len(identifier) - 4)
    return f"{identifier[:2]}{hidden}{identifier[-2:]}"


def _method_fingerprint(details: Mapping[str, str], environ=None) -> str:
    value = (
        f"{details['account_number']}|{details['ifsc_code']}|"
        f"{details.get('payout_identifier', '')}"
    ).encode("utf-8")
    return hmac.new(_fingerprint_key(environ), value, hashlib.sha256).hexdigest()


def conversion_snapshot(environ: Optional[Mapping[str, str]] = None) -> dict[str, Any]:
    env = os.environ if environ is None else environ
    try:
        chips_per_inr = int(env.get("CHIPS_PER_INR", "1"))
    except ValueError as exc:
        raise ProviderConfigurationError("CHIPS_PER_INR must be an integer") from exc
    if not 1 <= chips_per_inr <= 1_000_000:
        raise ProviderConfigurationError("CHIPS_PER_INR must be between 1 and 1000000")
    version = str(env.get("CHIP_RATE_VERSION", "v1")).strip()
    if not re.fullmatch(r"[A-Za-z0-9_.-]{1,40}", version):
        raise ProviderConfigurationError("CHIP_RATE_VERSION is invalid")
    return {
        "version": version,
        "chips_per_inr": chips_per_inr,
        "paise_per_inr": 100,
        "rounding": "REQUIRE_EXACT_WITHDRAWAL_DOWN_ON_DEPOSIT",
    }


def paise_to_chips(amount_paise: int, rate: Mapping[str, Any]) -> int:
    chips = int(amount_paise) * int(rate["chips_per_inr"]) // 100
    if chips <= 0:
        raise FinancialError("AMOUNT_TOO_SMALL", "Deposit amount is too small to purchase one chip.")
    return chips


def chips_to_paise(amount_chips: int, rate: Mapping[str, Any]) -> int:
    numerator = int(amount_chips) * 100
    divisor = int(rate["chips_per_inr"])
    if numerator % divisor:
        raise FinancialError(
            "AMOUNT_NOT_CONVERTIBLE",
            "The selected chip amount cannot be converted to an exact INR value.",
        )
    return numerator // divisor


def _effective_withdrawal_chip_bounds(
    *, rate: Mapping[str, Any], minimum_paise: int,
    minimum_chips: int, maximum_chips: int,
) -> tuple[int, int]:
    """Return exact-conversion chip bounds after every public constraint."""
    chips_per_inr = int(rate["chips_per_inr"])
    paise_per_inr = int(rate["paise_per_inr"])
    conversion_step = chips_per_inr // math.gcd(chips_per_inr, paise_per_inr)
    currency_floor_chips = (
        (int(minimum_paise) * chips_per_inr + paise_per_inr - 1)
        // paise_per_inr
    )
    lower_bound = max(int(minimum_chips), currency_floor_chips)
    effective_minimum = (
        (lower_bound + conversion_step - 1) // conversion_step
    ) * conversion_step
    public_maximum = min(int(maximum_chips), WITHDRAWAL_REQUEST_MAX_CHIPS)
    effective_maximum = (public_maximum // conversion_step) * conversion_step
    if effective_minimum > effective_maximum:
        raise ProviderConfigurationError(
            "Withdrawal limits do not allow any request that meets the INR minimum",
        )
    return effective_minimum, effective_maximum


def _effective_deposit_paise_bounds(
    *, rate: Mapping[str, Any], minimum_paise: int, maximum_paise: int,
) -> tuple[int, int]:
    """Return public deposit bounds that always purchase at least one chip."""
    chips_per_inr = int(rate["chips_per_inr"])
    paise_per_inr = int(rate["paise_per_inr"])
    minimum_for_one_chip = (
        paise_per_inr + chips_per_inr - 1
    ) // chips_per_inr
    effective_minimum = max(int(minimum_paise), minimum_for_one_chip)
    effective_maximum = min(int(maximum_paise), DEPOSIT_REQUEST_MAX_PAISE)
    if effective_minimum > effective_maximum:
        raise ProviderConfigurationError(
            "Deposit limits do not allow any request through the public API",
        )
    return effective_minimum, effective_maximum


def public_money_config(
    environ: Optional[Mapping[str, str]] = None,
) -> dict[str, Any]:
    """Return the non-secret conversion and transaction limits for players.

    These values are derived from the same validated settings used at the
    mutation boundary.  Provider identity, credentials, routing information,
    and internal readiness errors are intentionally excluded.
    """
    env = os.environ if environ is None else environ
    flags = requested_features(env)
    rate = conversion_snapshot(env)
    deposits = None
    checkout_hosts: list[str] = []
    if flags["deposits"]:
        # Redirect destinations are part of the reviewed provider contract,
        # not a client preference. Loading the provider here keeps the player
        # surface closed when credentials or its exact host allowlist drift.
        checkout_hosts = list(load_payment_provider(env).checkout_allowed_hosts)
        deposit_minimum = _bounded_config_int(
            "MIN_DEPOSIT_PAISE", 10_000, 1, 100_000_000_000, env,
        )
        deposit_maximum = _bounded_config_int(
            "MAX_DEPOSIT_PAISE", 100_000_000, 1, 100_000_000_000, env,
        )
        effective_minimum, effective_maximum = _effective_deposit_paise_bounds(
            rate=rate,
            minimum_paise=deposit_minimum,
            maximum_paise=deposit_maximum,
        )
        deposits = {
            "minimum_paise": effective_minimum,
            "maximum_paise": effective_maximum,
        }

    withdrawals = None
    if flags["withdrawals"]:
        withdrawal_minimum = _bounded_config_int(
            "MIN_WITHDRAWAL_PAISE", 100_000, 100_000, 100_000_000_000, env,
        )
        withdrawal_minimum_chips = _bounded_config_int(
            "MIN_WITHDRAWAL_CHIPS", 500, 1, 1_000_000_000, env,
        )
        withdrawal_maximum_chips = _bounded_config_int(
            "MAX_WITHDRAWAL_CHIPS", 1_000_000, 1, 1_000_000_000, env,
        )
        effective_minimum, effective_maximum = _effective_withdrawal_chip_bounds(
            rate=rate,
            minimum_paise=withdrawal_minimum,
            minimum_chips=withdrawal_minimum_chips,
            maximum_chips=withdrawal_maximum_chips,
        )
        withdrawals = {
            "minimum_paise": chips_to_paise(effective_minimum, rate),
            "maximum_paise": chips_to_paise(effective_maximum, rate),
            "minimum_chips": effective_minimum,
            "maximum_chips": effective_maximum,
            "exact_chip_conversion_required": True,
        }
    return {
        "currency": CURRENCY,
        "rate": {
            "version": rate["version"],
            "chips_per_inr": int(rate["chips_per_inr"]),
            "paise_per_inr": int(rate["paise_per_inr"]),
        },
        "checkout_hosts": checkout_hosts,
        "deposits": deposits,
        "withdrawals": withdrawals,
    }


def _parse_optional_datetime(value: Any) -> Optional[datetime]:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


async def _touch_deposit_limit_lock(user_id: str, session=None) -> None:
    """Serialize reservation and settlement decisions for one player.

    Every production caller executes this inside a Mongo transaction. Two
    concurrent deposits therefore contend on the same document and one
    transaction is retried with a fresh view of held reservations.
    """
    await db.financial_player_locks.update_one(
        {"_id": f"deposit-limit:{user_id}"},
        {"$inc": {"serial": 1}, "$set": {"updated_at": now()}},
        upsert=True, **_session_kwargs(session),
    )


async def _sum_chips(collection, pipeline: list[dict[str, Any]], session=None) -> int:
    cursor = collection.aggregate(pipeline, **_session_kwargs(session))
    rows = await cursor.to_list(1)
    return int(rows[0].get("chips", 0)) if rows else 0


async def _deposit_limit_violations(
    user_id: str, additional_chips: int, *, exclude_deposit_id: Optional[str] = None,
    session=None,
) -> list[dict[str, int | str]]:
    """Evaluate credited plus reserved deposits against every active limit."""
    kwargs = _session_kwargs(session)
    limits = await db.player_limits.find(
        {"user_id": user_id, "kind": compliance.DEPOSIT}, {"_id": 0}, **kwargs,
    ).to_list(20)
    violations: list[dict[str, int | str]] = []
    checked_at = now()
    for row in limits:
        period = str(row.get("period") or "")
        if period not in compliance.PERIODS:
            # Corrupt/unknown compliance configuration must fail closed.
            violations.append({
                "period": period or "UNKNOWN", "limit": 0,
                "used": 0, "reserved": 0, "remaining": 0,
            })
            continue
        effective_at = _parse_optional_datetime(row.get("pending_effective_from"))
        cap = row.get("pending_amount") if effective_at and effective_at <= checked_at else row.get("amount")
        if cap is None:
            continue
        cap = int(cap)
        since = compliance.window_start(period, checked_at)
        credited = await _sum_chips(db.chip_transactions, [
            {"$match": {
                "user_id": user_id, "kind": ledger.DEPOSIT,
                "gaming_day": {"$gte": since},
            }},
            {"$group": {"_id": None, "chips": {"$sum": "$amount"}}},
        ], session=session)
        held_query: dict[str, Any] = {
            "user_id": user_id, "limit_reservation_status": "HELD",
            "reservation_gaming_day": {"$gte": since},
        }
        if exclude_deposit_id:
            held_query["id"] = {"$ne": exclude_deposit_id}
        reserved = await _sum_chips(db.deposit_orders, [
            {"$match": held_query},
            {"$group": {"_id": None, "chips": {"$sum": "$chips"}}},
        ], session=session)
        hosted_reserved = await _sum_chips(db.operator_payment_requests, [
            {"$match": {
                "user_id": user_id,
                "source": "SGPAY24_UPI",
                "status": {"$in": ["CREATED", "PENDING", "RECONCILIATION_REQUIRED"]},
                "reservation_gaming_day": {"$gte": since},
            }},
            {"$group": {"_id": None, "chips": {"$sum": "$chips"}}},
        ], session=session)
        reserved += hosted_reserved
        proposed = credited + reserved + int(additional_chips)
        if proposed > cap:
            violations.append({
                "period": period, "limit": cap, "used": credited,
                "reserved": reserved, "remaining": max(0, cap - credited - reserved),
            })
    return violations


def _deposit_limit_error(violation: Mapping[str, Any]) -> FinancialError:
    period = str(violation.get("period") or "deposit").lower()
    return FinancialError(
        "DEPOSIT_LIMIT",
        f"This would take you past your {period} deposit limit. "
        f"You have {int(violation.get('remaining', 0)):,} chips left in this period.",
        403,
    )


async def ensure_financial_indexes() -> None:
    """Create required financial indexes; any failure is fatal to readiness."""
    await db.wallet_accounts.create_index("user_id", unique=True, name="wallet_account_user_unique")
    await db.wallet_operations.create_index(
        [("user_id", 1), ("idempotency_key", 1)], unique=True,
        name="wallet_operation_idempotency_unique",
    )
    await db.wallet_operations.create_index("source_key", unique=True, name="wallet_operation_source_unique")
    await db.wallet_entries.create_index([("operation_id", 1), ("entry_no", 1)], unique=True,
                                         name="wallet_entry_operation_sequence_unique")
    await db.wallet_entries.create_index([("user_id", 1), ("created_at", -1)],
                                         name="wallet_entry_user_created")
    await db.chip_transactions.create_index("id", unique=True, name="chip_transaction_id_unique")
    await db.deposit_orders.create_index(
        [("user_id", 1), ("idempotency_key", 1)], unique=True,
        name="deposit_user_idempotency_unique",
    )
    await db.deposit_orders.create_index(
        [("provider", 1), ("provider_order_id", 1)], unique=True,
        partialFilterExpression={"provider_order_id": {"$type": "string"}},
        name="deposit_provider_order_unique",
    )
    await db.withdrawal_requests.create_index(
        [("user_id", 1), ("idempotency_key", 1)], unique=True,
        name="withdrawal_user_idempotency_unique",
    )
    await db.withdrawal_requests.create_index(
        [("provider", 1), ("provider_payout_id", 1)], unique=True,
        partialFilterExpression={"provider_payout_id": {"$type": "string"}},
        name="withdrawal_provider_payout_unique",
    )
    await db.withdrawal_requests.create_index(
        [("provider", 1), ("provider_reference", 1)], unique=True,
        partialFilterExpression={"provider_reference": {"$type": "string"}},
        name="withdrawal_provider_reference_unique",
    )
    await db.withdrawal_requests.create_index(
        [("provider", 1), ("withdrawal_mode", 1), ("status", 1), ("next_reconcile_at", 1)],
        name="withdrawal_reconciliation_due",
    )
    await db.deposit_orders.create_index(
        [("provider", 1), ("provider_reference", 1)], unique=True,
        partialFilterExpression={"provider_reference": {"$type": "string"}},
        name="deposit_provider_reference_unique",
    )
    await db.deposit_orders.create_index(
        [("provider", 1), ("refund_provider_reference", 1)], unique=True,
        partialFilterExpression={"refund_provider_reference": {"$type": "string"}},
        name="deposit_refund_reference_unique",
    )
    await db.deposit_orders.create_index(
        [("user_id", 1), ("limit_reservation_status", 1), ("reservation_gaming_day", 1)],
        name="deposit_limit_reservation_lookup",
    )
    await db.deposit_orders.create_index(
        [("provider", 1), ("status", 1), ("next_reconcile_at", 1)],
        name="deposit_reconciliation_due",
    )
    await db.deposit_orders.create_index(
        [("provider", 1), ("status", 1), ("refund_reconcile_until", 1), ("next_reconcile_at", 1)],
        name="deposit_refund_reconciliation_due",
    )
    await db.payout_methods.create_index(
        [("user_id", 1), ("fingerprint", 1)], unique=True,
        name="payout_method_user_fingerprint_unique",
    )
    await db.provider_webhook_events.create_index(
        [("provider", 1), ("event_id", 1)], unique=True,
        name="webhook_provider_event_unique",
    )
    await db.provider_webhook_events.create_index([("status", 1), ("received_at", 1)],
                                                  name="webhook_status_received")
    await db.financial_outbox.create_index("dedupe_key", unique=True, name="financial_outbox_dedupe_unique")
    await db.financial_outbox.create_index([("status", 1), ("next_attempt_at", 1)],
                                           name="financial_outbox_pending")
    await db.payment_settings.create_index("key", unique=True, name="payment_settings_key_unique")
    await db.financial_audit.create_index("id", unique=True, name="financial_audit_id_unique")
    await db.financial_audit.create_index([("created_at", -1), ("action", 1)],
                                          name="financial_audit_created_action")
    await db.payout_attempts.create_index("idempotency_key", unique=True,
                                         name="payout_attempt_idempotency_unique")
    await db.financial_rate_limits.create_index(
        "expires_at", expireAfterSeconds=0, name="financial_rate_limit_expiry",
    )
    await db.financial_schema.update_one(
        {"key": "main"},
        {"$set": {"key": "main", "schema_version": SCHEMA_VERSION, "indexes_ready_at": now()}},
        upsert=True,
    )


_REQUIRED_INDEXES = {
    "wallet_accounts": {"wallet_account_user_unique"},
    "wallet_operations": {
        "wallet_operation_idempotency_unique", "wallet_operation_source_unique",
    },
    "wallet_entries": {"wallet_entry_operation_sequence_unique"},
    "chip_transactions": {"chip_transaction_id_unique"},
    "deposit_orders": {
        "deposit_user_idempotency_unique", "deposit_provider_order_unique",
        "deposit_provider_reference_unique", "deposit_limit_reservation_lookup",
        "deposit_refund_reference_unique", "deposit_reconciliation_due",
        "deposit_refund_reconciliation_due",
    },
    "withdrawal_requests": {
        "withdrawal_user_idempotency_unique", "withdrawal_provider_payout_unique",
        "withdrawal_provider_reference_unique", "withdrawal_reconciliation_due",
    },
    "payout_methods": {"payout_method_user_fingerprint_unique"},
    "provider_webhook_events": {"webhook_provider_event_unique"},
    "financial_outbox": {"financial_outbox_dedupe_unique"},
    "payment_settings": {"payment_settings_key_unique"},
    "financial_audit": {"financial_audit_id_unique"},
    "payout_attempts": {"payout_attempt_idempotency_unique"},
    "financial_rate_limits": {"financial_rate_limit_expiry"},
}


def _configuration_errors(environ: Optional[Mapping[str, str]] = None) -> list[str]:
    env = os.environ if environ is None else environ
    flags = requested_features(env)
    errors = []
    if (flags["deposits"] or flags["withdrawals"] or flags["automatic_withdrawals"]) and not flags["real_money"]:
        errors.append("REAL_MONEY_ENABLED must be true before a financial sub-feature")
    if flags["automatic_withdrawals"] and not flags["withdrawals"]:
        errors.append("WITHDRAWALS_ENABLED must be true before AUTO_WITHDRAWALS_ENABLED")
    if not flags["real_money"]:
        return errors
    if not GAME_WALLET_INTEGRATION_READY:
        errors.append("Gameplay wallet source integration is not certified in this build")
    elif not env_true("FINANCIAL_GAME_WALLET_INTEGRATED", env):
        errors.append("FINANCIAL_GAME_WALLET_INTEGRATED is not true")
    countries = [v.strip().upper() for v in str(env.get("FINANCIAL_ALLOWED_COUNTRIES", "")).split(",") if v.strip()]
    if not countries or any(not re.fullmatch(r"[A-Z]{2}", c) for c in countries):
        errors.append("FINANCIAL_ALLOWED_COUNTRIES must be a non-empty ISO alpha-2 allowlist")
    rate = None
    try:
        rate = conversion_snapshot(env)
    except ProviderConfigurationError as exc:
        errors.append(str(exc))
    parsed_limits: dict[str, int] = {}
    # Reconciliation remains responsible for already-created deposits even
    # while new deposit intake is paused, so its operational settings must
    # always stay valid whenever the financial core is enabled.
    limit_settings = [
        ("DEPOSIT_CHECKOUT_RESERVATION_TTL_SECONDS", 1800, 300, 86_400),
        ("DEPOSIT_REFUND_RECONCILIATION_DAYS", 120, 1, 365),
        ("DEPOSIT_REFUND_RECONCILE_SECONDS", 86400, 3600, 604_800),
    ]
    if flags["deposits"]:
        limit_settings.extend([
            ("MIN_DEPOSIT_PAISE", 10_000, 1, 100_000_000_000),
            ("MAX_DEPOSIT_PAISE", 100_000_000, 1, 100_000_000_000),
        ])
    if flags["withdrawals"]:
        limit_settings.extend([
            ("MIN_WITHDRAWAL_PAISE", 100_000, 100_000, 100_000_000_000),
            ("MIN_WITHDRAWAL_CHIPS", 500, 1, 1_000_000_000),
            ("MAX_WITHDRAWAL_CHIPS", 1_000_000, 1, 1_000_000_000),
        ])
    for setting, default, minimum, maximum in limit_settings:
        try:
            parsed_limits[setting] = _bounded_config_int(
                setting, default, minimum, maximum, env,
            )
        except ProviderConfigurationError as exc:
            errors.append(str(exc))
    if flags["deposits"] and all(
        key in parsed_limits for key in ("MIN_DEPOSIT_PAISE", "MAX_DEPOSIT_PAISE")
    ):
        if rate is not None:
            try:
                _effective_deposit_paise_bounds(
                    rate=rate,
                    minimum_paise=parsed_limits["MIN_DEPOSIT_PAISE"],
                    maximum_paise=parsed_limits["MAX_DEPOSIT_PAISE"],
                )
            except ProviderConfigurationError as exc:
                errors.append(str(exc))
    if flags["withdrawals"] and all(
        key in parsed_limits for key in ("MIN_WITHDRAWAL_CHIPS", "MAX_WITHDRAWAL_CHIPS")
    ):
        if parsed_limits["MIN_WITHDRAWAL_CHIPS"] > parsed_limits["MAX_WITHDRAWAL_CHIPS"]:
            errors.append("Withdrawal minimum cannot exceed maximum")
    if flags["withdrawals"] and rate is not None and all(key in parsed_limits for key in (
        "MIN_WITHDRAWAL_PAISE", "MIN_WITHDRAWAL_CHIPS", "MAX_WITHDRAWAL_CHIPS",
    )):
        try:
            _effective_withdrawal_chip_bounds(
                rate=rate,
                minimum_paise=parsed_limits["MIN_WITHDRAWAL_PAISE"],
                minimum_chips=parsed_limits["MIN_WITHDRAWAL_CHIPS"],
                maximum_chips=parsed_limits["MAX_WITHDRAWAL_CHIPS"],
            )
        except ProviderConfigurationError as exc:
            errors.append(str(exc))
    try:
        _active_encryption_key(env)
        _fingerprint_key(env)
    except ProviderConfigurationError as exc:
        errors.append(str(exc))
    try:
        provider = load_payment_provider(env)
        if flags["deposits"] and not (
            provider.capabilities.deposit_idempotency
            and provider.capabilities.payment_status_lookup
        ):
            errors.append(
                "Deposits require provider idempotency and authoritative payment status lookup",
            )
        if flags["automatic_withdrawals"] and not (
            provider.capabilities.payout_idempotency and provider.capabilities.payout_status_lookup
        ):
            errors.append("Automatic withdrawals require provider idempotency and status lookup")
    except ProviderConfigurationError as exc:
        errors.append(str(exc))
    return errors


async def prepare_financial_core(environ: Optional[Mapping[str, str]] = None) -> dict[str, Any]:
    global _READY, _READINESS_ERRORS
    env = os.environ if environ is None else environ
    _READY = False
    _READINESS_ERRORS = []
    if not financial_flags_requested(env):
        _READINESS_ERRORS = ["Financial features are disabled"]
        return financial_status(env)
    try:
        _READINESS_ERRORS.extend(_configuration_errors(env))
    except Exception as exc:  # noqa: BLE001 - malformed env must fail closed, not abort startup
        _READINESS_ERRORS.append(
            f"Financial configuration is invalid ({type(exc).__name__})",
        )
    if _READINESS_ERRORS:
        return financial_status(env)
    try:
        await ensure_financial_indexes()
        for collection, indexes in _REQUIRED_INDEXES.items():
            info = await db[collection].index_information()
            for index in indexes:
                if index not in info:
                    _READINESS_ERRORS.append(f"Required index missing: {collection}.{index}")
        schema = await db.financial_schema.find_one({"key": "main"})
        if not schema or int(schema.get("schema_version", 0)) != SCHEMA_VERSION:
            _READINESS_ERRORS.append("Financial schema version is not ready")
        if not _allow_nontransactional_tests(env):
            try:
                session_cm = await db.client.start_session()
                async with session_cm as session:
                    async def probe(s):
                        await db.financial_schema.find_one({"key": "main"}, session=s)
                    await session.with_transaction(probe)
            except Exception as exc:  # noqa: BLE001 - readiness reports only the class
                _READINESS_ERRORS.append(f"Mongo transactions unavailable ({type(exc).__name__})")
        if not _READINESS_ERRORS:
            await ensure_payment_settings()
    except Exception as exc:  # noqa: BLE001 - fail closed, never partially ready
        _READINESS_ERRORS.append(f"Financial schema preparation failed ({type(exc).__name__})")
    _READY = not _READINESS_ERRORS
    return financial_status(env)


def financial_status(environ: Optional[Mapping[str, str]] = None) -> dict[str, Any]:
    return {
        "ready": bool(_READY),
        "features": requested_features(environ),
        "errors": list(_READINESS_ERRORS),
        "schema_version": SCHEMA_VERSION,
    }


def require_financial_feature(feature: str, environ: Optional[Mapping[str, str]] = None) -> None:
    flags = requested_features(environ)
    key = {
        "deposits": "deposits",
        "withdrawals": "withdrawals",
        "automatic_withdrawals": "automatic_withdrawals",
    }.get(feature)
    if not flags["real_money"] or key is None or not flags[key]:
        raise FinancialError("FEATURE_DISABLED", "This financial feature is not enabled.", 503)
    if not _READY:
        raise FinancialError("FINANCIAL_NOT_READY", "Financial services are temporarily unavailable.", 503)


def require_financial_core(environ: Optional[Mapping[str, str]] = None) -> None:
    """Allow settlement of existing obligations even when intake is paused."""
    if not requested_features(environ)["real_money"] or not _READY:
        raise FinancialError(
            "FINANCIAL_NOT_READY", "Financial services are temporarily unavailable.", 503,
        )


async def acquire_financial_worker_lease(worker_id: str, ttl_seconds: int = 45) -> bool:
    """Best-effort single leader for bounded outbox/reconciliation work."""
    current = now()
    try:
        row = await db.system_locks.find_one_and_update(
            {
                "_id": "financial_worker",
                "$or": [
                    {"lease_until": {"$lt": current}},
                    {"holder": worker_id},
                ],
            },
            {"$set": {
                "holder": worker_id,
                "lease_until": current + timedelta(seconds=max(15, min(ttl_seconds, 120))),
                "updated_at": current,
            }},
            upsert=True, return_document=ReturnDocument.AFTER,
        )
        return bool(row) and row.get("holder") == worker_id
    except DuplicateKeyError:
        return False


async def ensure_payment_settings(session=None) -> dict[str, Any]:
    kwargs = _session_kwargs(session)
    await db.payment_settings.update_one(
        {"key": "main"},
        {"$setOnInsert": {
            "key": "main", "withdrawal_mode": MANUAL, "mode_version": 1,
            "claim_serial": 0, "created_at": now(), "updated_at": now(), "updated_by": "system",
        }},
        upsert=True,
        **kwargs,
    )
    return await db.payment_settings.find_one({"key": "main"}, {"_id": 0}, **kwargs)


async def _ensure_wallet_account(user_id: str, session=None) -> dict[str, Any]:
    kwargs = _session_kwargs(session)
    existing = await db.wallet_accounts.find_one({"user_id": user_id}, {"_id": 0}, **kwargs)
    if existing:
        return existing
    user = await db.users.find_one({"id": user_id}, {"_id": 0, "chip_balance": 1}, **kwargs)
    if not user:
        raise FinancialError("USER_NOT_FOUND", "User account was not found.", 404)
    legacy = max(0, int(user.get("chip_balance", 0)))
    candidate_id = str(uuid.uuid4())
    account = {
        "id": candidate_id,
        "user_id": user_id,
        "available_cash_chips": 0,
        "available_bonus_chips": legacy,
        "held_cash_chips": 0,
        "version": 1,
        "legacy_nonwithdrawable_snapshot": legacy,
        "created_at": now(),
        "updated_at": now(),
    }
    try:
        stored = await db.wallet_accounts.find_one_and_update(
            {"user_id": user_id}, {"$setOnInsert": account}, upsert=True,
            return_document=ReturnDocument.AFTER, **kwargs,
        )
    except DuplicateKeyError as exc:
        if session is not None:
            raise _WalletInitializationRace() from exc
        stored = await db.wallet_accounts.find_one({"user_id": user_id}, **kwargs)
        if not stored:
            raise FinancialError(
                "WALLET_INITIALIZATION_BUSY", "Wallet is being initialized; retry safely.", 409,
            ) from exc
    if stored.get("id") != candidate_id:
        return {key: value for key, value in stored.items() if key != "_id"}

    operation_id = str(uuid.uuid4())
    source_key = f"legacy-bonus-snapshot:{user_id}"
    operation = {
        "id": operation_id, "user_id": user_id,
        "kind": "LEGACY_BONUS_SNAPSHOT", "source_key": source_key,
        "idempotency_key": source_key, "request_hash": _canonical_hash({"chips": legacy}),
        "status": "COMMITTED", "result": {"bonus_chips": legacy}, "created_at": now(),
    }
    await db.wallet_operations.insert_one(operation, **kwargs)
    if legacy:
        await db.wallet_entries.insert_many([
            {
                "id": str(uuid.uuid4()), "operation_id": operation_id, "entry_no": 1,
                "user_id": user_id, "bucket": "AVAILABLE_BONUS", "delta_chips": legacy,
                "balance_after": legacy, "created_at": now(),
            },
            {
                "id": str(uuid.uuid4()), "operation_id": operation_id, "entry_no": 2,
                "user_id": None, "bucket": "PROMO_CLEARING", "delta_chips": -legacy,
                "balance_after": None, "created_at": now(),
            },
        ], **kwargs)
    return account


async def wallet_for_user(user_id: str) -> dict[str, Any]:
    async def work(session):
        return await _ensure_wallet_account(user_id, session=session)
    return await _run_transaction(work)


async def wallet_public(user_id: str) -> dict[str, int]:
    """Return a non-mutating wallet projection.

    Reads remain safe while payment features are paused.  If a financial
    account has never been initialized, every legacy chip is projected as
    promotional/non-withdrawable without creating collections or indexes.
    """
    account = await db.wallet_accounts.find_one({"user_id": user_id}, {"_id": 0})
    user = await db.users.find_one({"id": user_id}, {"_id": 0, "chip_balance": 1}) or {}
    if not account:
        legacy = max(0, int(user.get("chip_balance", 0)))
        remaining = 0
        try:
            import wager as _promo_wager
            remaining = await _promo_wager.remaining_deposit_wager(user_id)
        except Exception:
            remaining = 0
        return {
            "available_chips": legacy,
            "cash_chips": 0,
            "bonus_chips": legacy,
            "held_chips": 0,
            "withdrawable_chips": 0,
            "wager_remaining_chips": remaining,
        }
    cash = int(account.get("available_cash_chips", 0))
    bonus = int(account.get("available_bonus_chips", 0))
    held = int(account.get("held_cash_chips", 0))
    remaining = 0
    try:
        import wager as _promo_wager
        remaining = await _promo_wager.remaining_deposit_wager(user_id)
    except Exception:
        remaining = 0
    return {
        "available_chips": int(user.get("chip_balance", cash + bonus)),
        "cash_chips": cash,
        "bonus_chips": bonus,
        "held_chips": held,
        "withdrawable_chips": 0 if remaining > 0 else cash,
        "wager_remaining_chips": remaining,
    }


async def _find_operation(user_id: str, idempotency_key: str, source_key: str, session=None):
    kwargs = _session_kwargs(session)
    return await db.wallet_operations.find_one({
        "$or": [
            {"user_id": user_id, "idempotency_key": idempotency_key},
            {"source_key": source_key},
        ]
    }, {"_id": 0}, **kwargs)


async def apply_wallet_movement(
    *, user_id: str, kind: str, source_key: str, idempotency_key: str,
    deltas: Mapping[str, int], mirror_user_delta: int,
    metadata: Optional[Mapping[str, Any]] = None, session=None,
) -> dict[str, Any]:
    """Apply one balanced wallet movement exactly once."""
    idem = validate_idempotency_key(idempotency_key)
    clean_deltas = {str(k): int(v) for k, v in deltas.items() if int(v)}
    allowed = {"available_cash_chips", "available_bonus_chips", "held_cash_chips"}
    if not clean_deltas or set(clean_deltas) - allowed:
        raise FinancialError("INVALID_WALLET_MOVEMENT", "Wallet movement is invalid.")
    payload = {
        "kind": kind, "source_key": source_key, "deltas": clean_deltas,
        "mirror_user_delta": int(mirror_user_delta), "metadata": dict(metadata or {}),
    }
    request_hash = _canonical_hash(payload)

    async def work(tx_session):
        existing = await _find_operation(user_id, idem, source_key, session=tx_session)
        if existing:
            if existing.get("request_hash") != request_hash:
                raise FinancialError(
                    "IDEMPOTENCY_CONFLICT",
                    "This idempotency key belongs to a different wallet operation.",
                    409,
                )
            return {**existing.get("result", {}), "duplicate": True,
                    "operation_id": existing["id"]}

        account = await _ensure_wallet_account(user_id, session=tx_session)
        query: dict[str, Any] = {"user_id": user_id}
        for bucket, delta in clean_deltas.items():
            if delta < 0:
                query[bucket] = {"$gte": -delta}
        kwargs = _session_kwargs(tx_session)
        updated = await db.wallet_accounts.find_one_and_update(
            query,
            {"$inc": {**clean_deltas, "version": 1}, "$set": {"updated_at": now()}},
            return_document=ReturnDocument.AFTER,
            **kwargs,
        )
        if not updated:
            raise FinancialError("INSUFFICIENT_WITHDRAWABLE_CHIPS", "Not enough withdrawable chips.", 409)

        if mirror_user_delta:
            user_query: dict[str, Any] = {"id": user_id}
            if mirror_user_delta < 0:
                user_query["chip_balance"] = {"$gte": -mirror_user_delta}
            mirrored = await db.users.find_one_and_update(
                user_query, {"$inc": {"chip_balance": int(mirror_user_delta)}},
                return_document=ReturnDocument.AFTER, **kwargs,
            )
            if not mirrored:
                raise FinancialError(
                    "WALLET_RECONCILIATION_REQUIRED",
                    "The game balance and financial wallet do not reconcile.",
                    409,
                )

        operation_id = str(uuid.uuid4())
        result = {
            "cash_chips": int(updated.get("available_cash_chips", 0)),
            "bonus_chips": int(updated.get("available_bonus_chips", 0)),
            "held_chips": int(updated.get("held_cash_chips", 0)),
        }
        operation = {
            "id": operation_id, "user_id": user_id, "kind": kind,
            "source_key": source_key, "idempotency_key": idem,
            "request_hash": request_hash, "status": "COMMITTED",
            "result": result, "metadata": dict(metadata or {}), "created_at": now(),
        }
        await db.wallet_operations.insert_one(operation, **kwargs)
        entries = []
        entry_no = 0
        for bucket, delta in sorted(clean_deltas.items()):
            entry_no += 1
            entries.append({
                "id": str(uuid.uuid4()), "operation_id": operation_id, "entry_no": entry_no,
                "user_id": user_id, "bucket": bucket.replace("_chips", "").upper(),
                "delta_chips": delta, "balance_after": int(updated.get(bucket, 0)),
                "created_at": now(),
            })
        entry_no += 1
        entries.append({
            "id": str(uuid.uuid4()), "operation_id": operation_id, "entry_no": entry_no,
            "user_id": None, "bucket": f"{kind}_CLEARING",
            "delta_chips": -sum(clean_deltas.values()), "balance_after": None,
            "created_at": now(),
        })
        await db.wallet_entries.insert_many(entries, **kwargs)
        return {**result, "duplicate": False, "operation_id": operation_id}

    if session is not None:
        return await work(session)
    try:
        return await _run_transaction(work)
    except DuplicateKeyError:
        existing = await _find_operation(user_id, idem, source_key)
        if not existing or existing.get("request_hash") != request_hash:
            raise FinancialError("IDEMPOTENCY_CONFLICT", "Wallet operation already exists.", 409)
        return {**existing.get("result", {}), "duplicate": True, "operation_id": existing["id"]}


async def create_payout_method(
    user_id: str, *, account_holder_name: str, bank_name: str,
    account_number: str, ifsc_code: str, payout_identifier: Optional[str] = None,
) -> dict[str, Any]:
    details = normalize_bank_details(
        account_holder_name, bank_name, account_number, ifsc_code, payout_identifier,
    )
    method_id = str(uuid.uuid4())
    fingerprint = _method_fingerprint(details)
    doc = {
        "id": method_id, "user_id": user_id, "type": "BANK_ACCOUNT",
        "encrypted_details": encrypt_payout_details(user_id, method_id, details),
        "fingerprint": fingerprint,
        "bank_name": details["bank_name"],
        "account_number_masked": _mask_account(details["account_number"]),
        "ifsc_masked": _mask_ifsc(details["ifsc_code"]),
        "payout_identifier_masked": (
            _mask_identifier(details["payout_identifier"])
            if details.get("payout_identifier") else None
        ),
        "status": "ACTIVE", "provider_beneficiary_id": None,
        "created_at": now(), "updated_at": now(),
    }
    try:
        await db.payout_methods.insert_one(doc)
    except DuplicateKeyError:
        async def reactivate(session):
            kwargs = _session_kwargs(session)
            existing = await db.payout_methods.find_one(
                {"user_id": user_id, "fingerprint": fingerprint}, {"_id": 0}, **kwargs,
            )
            if not existing:
                raise FinancialError(
                    "BANK_DETAILS_ALREADY_EXIST", "These bank details already exist.", 409,
                )
            if existing.get("status") == "ACTIVE":
                return existing
            if existing.get("status") != "INACTIVE":
                raise FinancialError(
                    "BANK_DETAILS_UNAVAILABLE", "These bank details require review.", 409,
                )
            encrypted = encrypt_payout_details(user_id, str(existing["id"]), details)
            updated = await db.payout_methods.find_one_and_update(
                {"id": existing["id"], "user_id": user_id, "status": "INACTIVE"},
                {"$set": {
                    "status": "ACTIVE", "encrypted_details": encrypted,
                    "bank_name": details["bank_name"],
                    "account_number_masked": _mask_account(details["account_number"]),
                    "ifsc_masked": _mask_ifsc(details["ifsc_code"]),
                    "payout_identifier_masked": (
                        _mask_identifier(details["payout_identifier"])
                        if details.get("payout_identifier") else None
                    ),
                    # Provider beneficiary identity may include the holder name;
                    # never reuse a token created from the old encrypted record.
                    "provider_beneficiary_id": None,
                    "reactivated_at": now(), "updated_at": now(),
                }, "$unset": {"deactivated_at": ""}},
                return_document=ReturnDocument.AFTER, **kwargs,
            )
            if not updated:
                return await db.payout_methods.find_one(
                    {"id": existing["id"], "user_id": user_id}, {"_id": 0}, **kwargs,
                )
            await financial_audit(
                user_id, "PAYOUT_METHOD_REACTIVATED", "PAYOUT_METHOD", str(existing["id"]),
                session=session,
            )
            return {key: value for key, value in updated.items() if key != "_id"}

        return await _run_transaction(reactivate)
    doc.pop("_id", None)
    return doc


def payout_method_dto(doc: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "id": doc.get("id"), "type": "BANK_ACCOUNT",
        "bank_name": doc.get("bank_name"),
        "account_number_masked": doc.get("account_number_masked"),
        "ifsc_masked": doc.get("ifsc_masked"),
        "payout_identifier_masked": doc.get("payout_identifier_masked"),
        "status": doc.get("status"),
        "created_at": doc.get("created_at"),
    }


async def list_payout_methods(user_id: str) -> list[dict[str, Any]]:
    rows = await db.payout_methods.find(
        {"user_id": user_id, "status": "ACTIVE"}, {"_id": 0},
    ).sort("created_at", -1).to_list(20)
    return [payout_method_dto(row) for row in rows]


async def deactivate_payout_method(user_id: str, method_id: str) -> dict[str, Any]:
    """Soft-deactivate bank details once no unresolved payout depends on them."""
    async def work(session):
        kwargs = _session_kwargs(session)
        method = await db.payout_methods.find_one(
            {"id": method_id, "user_id": user_id}, {"_id": 0}, **kwargs,
        )
        if not method:
            raise FinancialError("BANK_DETAILS_NOT_FOUND", "Bank details were not found.", 404)
        if method.get("status") == "INACTIVE":
            return method
        pending = await db.withdrawal_requests.find_one({
            "user_id": user_id, "payout_method_id": method_id,
            "status": {"$nin": list(WITHDRAWAL_TERMINAL)},
        }, {"_id": 0, "id": 1}, **kwargs)
        if pending:
            raise FinancialError(
                "BANK_DETAILS_IN_USE", "Bank details are attached to a pending withdrawal.", 409,
            )
        await db.payout_methods.update_one(
            {"id": method_id, "user_id": user_id, "status": "ACTIVE"},
            {"$set": {"status": "INACTIVE", "deactivated_at": now(), "updated_at": now()}},
            **kwargs,
        )
        await financial_audit(
            user_id, "PAYOUT_METHOD_DEACTIVATED", "PAYOUT_METHOD", method_id,
            session=session, audit_id=f"payout-method:{method_id}:deactivated",
        )
        stored = await db.payout_methods.find_one(
            {"id": method_id, "user_id": user_id}, {"_id": 0}, **kwargs,
        )
        return stored

    return await _run_transaction(work)


_TERMINAL_PAYMENT_STATUSES = {
    "CREDITED", "PAID", "FAILED", "EXPIRED", "REFUNDED", "REJECTED",
    "CANCELLED", "APPROVED", "RECONCILIATION_REQUIRED",
}


def _iso_payment_time(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, datetime):
        dt = value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)
        return datetime_to_iso_utc(dt)
    return datetime_to_iso_utc(parse_provider_datetime(value) or value)


def _payment_display_at(doc: Mapping[str, Any]) -> Any:
    status = str(doc.get("status") or doc.get("internal_status") or "").upper()
    provider = doc.get("provider_occurred_at")
    resolved = doc.get("resolved_at") or doc.get("paid_at") or doc.get("credited_at")
    created = doc.get("created_at")
    if status in _TERMINAL_PAYMENT_STATUSES:
        return provider or resolved or created
    return created or provider or resolved


def deposit_dto(doc: Mapping[str, Any]) -> dict[str, Any]:
    display = _payment_display_at(doc)
    return {
        "id": doc.get("id"), "status": doc.get("status"),
        "amount_paise": int(doc.get("amount_paise", 0)), "currency": CURRENCY,
        "chips": int(doc.get("chips", 0)), "rate": doc.get("rate_snapshot"),
        "provider": doc.get("provider"),
        "created_at": _iso_payment_time(doc.get("created_at")),
        "updated_at": _iso_payment_time(doc.get("updated_at")),
        "resolved_at": _iso_payment_time(doc.get("resolved_at") or doc.get("credited_at")),
        "provider_occurred_at": _iso_payment_time(doc.get("provider_occurred_at")),
        "paid_at": _iso_payment_time(display),
        "occurred_at": _iso_payment_time(display),
    }


async def _ensure_deposit_checkout(
    order: Mapping[str, Any], provider: PaymentProvider,
) -> tuple[dict[str, Any], str]:
    """Finish or repair the DB/provider gap using a stable provider key."""
    if order.get("provider") != provider.name:
        raise FinancialError(
            "PAYMENT_PROVIDER_MISMATCH", "This deposit belongs to another payment provider.", 409,
        )
    if order.get("status") not in {"CREATED", "PENDING"}:
        return dict(order), str(order.get("checkout_url") or "")
    if order.get("provider_order_id") and order.get("checkout_url"):
        return dict(order), str(order["checkout_url"])
    return_url = os.environ.get(
        "PAYMENT_RETURN_URL", "http://localhost:3000/chips/deposit/return",
    )
    try:
        if order.get("provider_order_id"):
            checkout = await provider.create_checkout_session(
                provider_order_id=str(order["provider_order_id"]), return_url=return_url,
            )
        else:
            checkout = await provider.create_deposit_order(
                deposit_id=str(order["id"]), amount_paise=int(order["amount_paise"]),
                currency=CURRENCY, idempotency_key=f"deposit:{order['id']}",
                return_url=return_url,
            )
    except Exception as exc:  # noqa: BLE001 - provider details must not leak
        await db.deposit_orders.update_one(
            {"id": order["id"], "status": {"$in": ["CREATED", "PENDING"]}},
            {"$set": {"last_error": type(exc).__name__, "updated_at": now()}},
        )
        raise FinancialError(
            "PAYMENT_PROVIDER_UNAVAILABLE", "Payment checkout is unavailable.", 503,
        ) from exc
    try:
        await db.deposit_orders.update_one(
            {
                "id": order["id"],
                "status": {"$in": ["CREATED", "PENDING"]},
                "$or": [
                    {"provider_order_id": None},
                    {"provider_order_id": checkout.provider_order_id},
                ],
            },
            {"$set": {
                "status": "PENDING", "provider_order_id": checkout.provider_order_id,
                "checkout_url": checkout.checkout_url, "last_error": None,
                "updated_at": now(),
            }},
        )
    except DuplicateKeyError as exc:
        await db.deposit_orders.update_one(
            {"id": order["id"]},
            {"$set": {"status": "RECONCILIATION_REQUIRED", "updated_at": now()}},
        )
        raise FinancialError(
            "PAYMENT_PROVIDER_REFERENCE_CONFLICT",
            "Payment checkout requires reconciliation.", 409,
        ) from exc
    stored = await db.deposit_orders.find_one({"id": order["id"]}, {"_id": 0})
    if not stored or stored.get("provider_order_id") != checkout.provider_order_id:
        raise FinancialError(
            "PAYMENT_CHECKOUT_CONFLICT", "Payment checkout requires reconciliation.", 409,
        )
    return stored, str(stored.get("checkout_url") or checkout.checkout_url)


async def create_deposit(
    user_id: str, amount_paise: int, idempotency_key: str, provider: PaymentProvider,
) -> tuple[dict[str, Any], str]:
    idem = validate_idempotency_key(idempotency_key)
    amount = int(amount_paise)
    existing = await db.deposit_orders.find_one(
        {"user_id": user_id, "idempotency_key": idem}, {"_id": 0},
    )
    if existing:
        if int(existing.get("amount_paise", -1)) != amount or existing.get("currency") != CURRENCY:
            raise FinancialError("IDEMPOTENCY_CONFLICT", "Idempotency key belongs to another deposit.", 409)
        return await _ensure_deposit_checkout(existing, provider)

    minimum, maximum = _runtime_config_range(
        "MIN_DEPOSIT_PAISE", 10_000,
        "MAX_DEPOSIT_PAISE", 100_000_000,
        100_000_000_000,
    )
    if not minimum <= amount <= maximum:
        raise FinancialError(
            "DEPOSIT_LIMIT", f"Deposit must be between {minimum} and {maximum} paise."
        )
    rate = conversion_snapshot()
    chips = paise_to_chips(amount, rate)
    request_hash = _canonical_hash({"amount_paise": amount, "currency": CURRENCY, "rate": rate})

    deposit_id = str(uuid.uuid4())
    doc = {
        "id": deposit_id, "user_id": user_id, "idempotency_key": idem,
        "request_hash": request_hash, "amount_paise": amount, "currency": CURRENCY,
        "chips": chips, "rate_snapshot": rate, "provider": provider.name,
        "provider_order_id": None, "provider_reference": None,
        "checkout_url": None, "status": "CREATED", "wallet_operation_id": None,
        "limit_reservation_status": "HELD",
        "reservation_gaming_day": ledger.gaming_day(),
        "created_at": now(), "updated_at": now(),
    }

    async def reserve_and_insert(session):
        kwargs = _session_kwargs(session)
        duplicate = await db.deposit_orders.find_one(
            {"user_id": user_id, "idempotency_key": idem}, {"_id": 0}, **kwargs,
        )
        if duplicate:
            if (
                int(duplicate.get("amount_paise", -1)) != amount
                or duplicate.get("currency") != CURRENCY
            ):
                raise FinancialError(
                    "IDEMPOTENCY_CONFLICT", "Idempotency key belongs to another deposit.", 409,
                )
            return duplicate
        await _touch_deposit_limit_lock(user_id, session=session)
        violations = await _deposit_limit_violations(
            user_id, chips, exclude_deposit_id=deposit_id, session=session,
        )
        if violations:
            raise _deposit_limit_error(violations[0])
        await db.deposit_orders.insert_one(dict(doc), **kwargs)
        return dict(doc)

    try:
        if _allow_nontransactional_tests():
            # The production lock is a Mongo write-conflict lock. Mongomock has
            # no transactions, so serialize this one critical section locally
            # to keep the concurrency test representative.
            lock = _TEST_DEPOSIT_LOCKS.setdefault(user_id, asyncio.Lock())
            async with lock:
                stored = await _run_transaction(reserve_and_insert)
        else:
            stored = await _run_transaction(reserve_and_insert)
    except DuplicateKeyError:
        existing = await db.deposit_orders.find_one(
            {"user_id": user_id, "idempotency_key": idem}, {"_id": 0},
        )
        if not existing or (
            int(existing.get("amount_paise", -1)) != amount
            or existing.get("currency") != CURRENCY
        ):
            raise FinancialError("IDEMPOTENCY_CONFLICT", "Deposit request already exists.", 409)
        return await _ensure_deposit_checkout(existing, provider)
    stored.pop("_id", None)
    return await _ensure_deposit_checkout(stored, provider)


async def _credit_deposit(
    order: Mapping[str, Any], event: ProviderEvent, actor: str = "provider-webhook",
) -> dict[str, Any]:
    async def work(session):
        kwargs = _session_kwargs(session)
        current = await db.deposit_orders.find_one({"id": order["id"]}, {"_id": 0}, **kwargs)
        if not current:
            raise FinancialError("DEPOSIT_NOT_FOUND", "Deposit order was not found.", 404)
        payment_reference = str(event.provider_reference or "").strip()
        if (
            event.amount_paise != int(current["amount_paise"])
            or event.currency != CURRENCY
            or not 1 <= len(payment_reference) <= 160
        ):
            if current.get("status") not in {"CREDITED", "REFUNDED", "REFUND_REVIEW_REQUIRED"}:
                await db.deposit_orders.update_one(
                    {"id": current["id"]},
                    {"$set": {
                        "status": "RECONCILIATION_REQUIRED",
                        "reconciliation_error_code": "PAYMENT_MISMATCH", "updated_at": now(),
                    }},
                    **kwargs,
                )
            return {"_error_code": "PAYMENT_MISMATCH"}
        if current.get("status") == "CREDITED":
            if current.get("provider_reference") != payment_reference:
                await db.users.update_one(
                    {"id": current["user_id"]},
                    {"$set": {"financial_status": "REVIEW_REQUIRED"}}, **kwargs,
                )
                await financial_audit(
                    actor, "DEPOSIT_TERMINAL_CONFLICT", "DEPOSIT", str(current["id"]),
                    reason="Provider payment reference changed after credit",
                    session=session,
                    audit_id=f"deposit:{current['id']}:terminal-conflict",
                )
                return {"_error_code": "DEPOSIT_TERMINAL_CONFLICT"}
            return {"deposit_id": current["id"], "status": "CREDITED", "duplicate": True}
        if current.get("status") in {"REFUNDED", "REFUND_REVIEW_REQUIRED"}:
            raise FinancialError(
                "DEPOSIT_ALREADY_REFUNDED",
                "A refunded deposit cannot be credited; provider reconciliation is required.",
                409,
            )
        await _touch_deposit_limit_lock(current["user_id"], session=session)
        limit_violations: list[dict[str, int | str]] = []
        if current.get("limit_reservation_status") != "HELD":
            limit_violations = await _deposit_limit_violations(
                current["user_id"], int(current["chips"]),
                exclude_deposit_id=str(current["id"]), session=session,
            )
            if limit_violations:
                # The provider has already accepted the player's money. Never
                # silently discard it: credit exactly once, freeze further
                # financial actions, and require an operator refund/review.
                await db.users.update_one(
                    {"id": current["user_id"]},
                    {"$set": {"financial_status": "REVIEW_REQUIRED"}}, **kwargs,
                )
        movement = await apply_wallet_movement(
            user_id=current["user_id"], kind="DEPOSIT_CREDIT",
            source_key=f"deposit-credit:{current['id']}",
            idempotency_key=f"deposit-credit:{current['id']}",
            deltas={"available_cash_chips": int(current["chips"])},
            mirror_user_delta=int(current["chips"]),
            metadata={"deposit_id": current["id"], "amount_paise": current["amount_paise"]},
            session=session,
        )
        user = await db.users.find_one(
            {"id": current["user_id"]}, {"_id": 0, "chip_balance": 1}, **kwargs,
        )
        await db.chip_transactions.update_one(
            {"id": f"financial-deposit:{current['id']}"},
            {"$setOnInsert": {
                "id": f"financial-deposit:{current['id']}",
                "user_id": current["user_id"], "type": "CREDIT", "kind": ledger.DEPOSIT,
                "amount": int(current["chips"]),
                "balance_after": int((user or {}).get("chip_balance", 0)),
                "game": None, "gaming_day": ledger.gaming_day(),
                "note": "Verified payment deposit", "ref": current["id"],
                "created_at": now().isoformat(),
            }},
            upsert=True, **kwargs,
        )
        await db.deposit_orders.update_one(
            {"id": current["id"], "status": {"$ne": "CREDITED"}},
            {"$set": {
                "status": "CREDITED", "provider_reference": payment_reference,
                "wallet_operation_id": movement["operation_id"],
                "paid_at": parse_provider_datetime(event.occurred_at) or now(),
                "credited_at": now(), "updated_at": now(),
                **({} if current.get("provider_occurred_at") or not event.occurred_at else {
                    "provider_occurred_at": parse_provider_datetime(event.occurred_at) or event.occurred_at,
                }),
                "limit_reservation_status": "CONSUMED",
                "limit_exception_review": bool(limit_violations),
                "next_reconcile_at": now() + timedelta(
                    seconds=_runtime_config_int(
                        "DEPOSIT_REFUND_RECONCILE_SECONDS", 86_400, 3600, 604_800,
                    ),
                ),
                "refund_reconcile_until": now() + timedelta(
                    days=_runtime_config_int(
                        "DEPOSIT_REFUND_RECONCILIATION_DAYS", 120, 1, 365,
                    ),
                ),
            }},
            **kwargs,
        )
        await financial_audit(
            actor, "DEPOSIT_CREDITED", "DEPOSIT", str(current["id"]),
            metadata={
                "amount_paise": int(current["amount_paise"]),
                "chips": int(current["chips"]),
                "wallet_operation_id": movement["operation_id"],
                "limit_exception_review": bool(limit_violations),
            },
            session=session, audit_id=f"deposit:{current['id']}:credited",
        )
        if not movement.get("duplicate"):
            import wager as _promo_wager
            await _promo_wager.open_deposit_bucket(
                current["user_id"], int(current["chips"]), current["id"], session=session,
            )
        return {"deposit_id": current["id"], "status": "CREDITED",
                "duplicate": movement["duplicate"], "user_id": current["user_id"]}
    try:
        result = await _run_transaction(work)
    except DuplicateKeyError as exc:
        async def require_reference_review(session):
            kwargs = _session_kwargs(session)
            await db.deposit_orders.update_one(
                {"id": order["id"], "status": {"$ne": "CREDITED"}},
                {"$set": {
                    "status": "RECONCILIATION_REQUIRED",
                    "reconciliation_error_code": "PROVIDER_REFERENCE_CONFLICT",
                    "updated_at": now(),
                }}, **kwargs,
            )
            await db.users.update_one(
                {"id": order["user_id"]},
                {"$set": {"financial_status": "REVIEW_REQUIRED"}}, **kwargs,
            )
        await _run_transaction(require_reference_review)
        raise FinancialError(
            "PROVIDER_REFERENCE_CONFLICT",
            "Provider payment reference is already bound to another deposit.", 409,
        ) from exc
    error_code = result.pop("_error_code", None)
    if error_code == "PAYMENT_MISMATCH":
        raise FinancialError(
            "PAYMENT_MISMATCH", "Provider payment does not match the deposit order.", 409,
        )
    if error_code == "DEPOSIT_TERMINAL_CONFLICT":
        raise FinancialError(
            "DEPOSIT_TERMINAL_CONFLICT",
            "Provider payment identity conflicts with an already credited deposit.", 409,
        )
    return result


def withdrawal_dto(doc: Mapping[str, Any], admin: bool = False) -> dict[str, Any]:
    internal = str(doc.get("status", "REQUESTED"))
    display = internal if internal in WITHDRAWAL_TERMINAL else "PENDING"
    shown = _payment_display_at({**doc, "status": internal})
    result = {
        "id": doc.get("id"), "status": display,
        "amount_chips": int(doc.get("amount_chips", 0)),
        "amount_paise": int(doc.get("amount_paise", 0)), "currency": CURRENCY,
        "bank_detail": doc.get("bank_detail_snapshot"),
        "created_at": _iso_payment_time(doc.get("created_at")),
        "updated_at": _iso_payment_time(doc.get("updated_at")),
        "resolved_at": _iso_payment_time(doc.get("resolved_at") or doc.get("paid_at")),
        "provider_occurred_at": _iso_payment_time(doc.get("provider_occurred_at")),
        "paid_at": _iso_payment_time(shown),
        "occurred_at": _iso_payment_time(shown),
    }
    if admin:
        result.update({
            "internal_status": internal, "user_id": doc.get("user_id"),
            "withdrawal_mode": doc.get("withdrawal_mode"),
            "mode_version": doc.get("mode_version"),
            "provider": doc.get("provider"),
            "provider_reference": doc.get("provider_reference"),
            "admin_note": doc.get("admin_note"),
        })
    return result


async def create_withdrawal(
    user_id: str, amount_chips: int, payout_method_id: str,
    idempotency_key: str, provider: PaymentProvider,
) -> dict[str, Any]:
    idem = validate_idempotency_key(idempotency_key)
    chips = int(amount_chips)
    import wager as _promo_wager
    await _promo_wager.require_clear_for_withdrawal(user_id)
    existing = await db.withdrawal_requests.find_one(
        {"user_id": user_id, "idempotency_key": idem}, {"_id": 0},
    )
    if existing:
        if (
            int(existing.get("amount_chips", -1)) != chips
            or existing.get("payout_method_id") != payout_method_id
        ):
            raise FinancialError("IDEMPOTENCY_CONFLICT", "Idempotency key belongs to another withdrawal.", 409)
        return existing

    minimum, maximum = _runtime_config_range(
        "MIN_WITHDRAWAL_CHIPS", 500,
        "MAX_WITHDRAWAL_CHIPS", 1_000_000,
        1_000_000_000,
    )
    if not minimum <= chips <= maximum:
        raise FinancialError(
            "WITHDRAWAL_LIMIT", f"Withdrawal must be between {minimum} and {maximum} chips."
        )
    rate = conversion_snapshot()
    amount_paise = chips_to_paise(chips, rate)
    minimum_paise = _runtime_config_int(
        "MIN_WITHDRAWAL_PAISE", 100_000, 100_000, 100_000_000_000,
    )
    if amount_paise < minimum_paise:
        whole, fraction = divmod(minimum_paise, 100)
        minimum_label = f"₹{whole:,}" + (f".{fraction:02d}" if fraction else "")
        raise FinancialError(
            "WITHDRAWAL_LIMIT",
            f"Withdrawal must be at least {minimum_label}.",
        )
    request_hash = _canonical_hash({
        "amount_chips": chips, "amount_paise": amount_paise,
        "payout_method_id": payout_method_id, "rate": rate,
    })
    withdrawal_id = str(uuid.uuid4())

    async def work(session):
        kwargs = _session_kwargs(session)
        duplicate = await db.withdrawal_requests.find_one(
            {"user_id": user_id, "idempotency_key": idem}, {"_id": 0}, **kwargs,
        )
        if duplicate:
            if (
                int(duplicate.get("amount_chips", -1)) != chips
                or duplicate.get("payout_method_id") != payout_method_id
            ):
                raise FinancialError("IDEMPOTENCY_CONFLICT", "Withdrawal request conflicts.", 409)
            return duplicate
        # This write serializes creation against soft-deactivation. A plain
        # pre-transaction read could snapshot an account after deactivation had
        # already won the race.
        method = await db.payout_methods.find_one_and_update(
            {"id": payout_method_id, "user_id": user_id, "status": "ACTIVE"},
            {"$inc": {"use_serial": 1}, "$set": {"last_used_at": now()}},
            projection={"_id": 0}, return_document=ReturnDocument.AFTER, **kwargs,
        )
        if not method:
            raise FinancialError(
                "BANK_DETAILS_NOT_FOUND", "Active bank details were not found.", 404,
            )
        settings = await ensure_payment_settings(session=session)
        mode = settings.get("withdrawal_mode", MANUAL)
        player = await db.users.find_one(
            {"id": user_id}, {"_id": 0, "financial_risk_status": 1}, **kwargs,
        )
        risk_status = str((player or {}).get("financial_risk_status") or "NOT_ASSESSED").upper()
        automatic = (
            mode == AUTOMATIC and env_true("AUTO_WITHDRAWALS_ENABLED")
            and risk_status == "ELIGIBLE"
        )
        routing_mode = AUTOMATIC if automatic else MANUAL
        status = "APPROVED" if automatic else "PENDING_ADMIN"
        doc = {
            "id": withdrawal_id, "user_id": user_id,
            "idempotency_key": idem, "request_hash": request_hash,
            "amount_chips": chips, "amount_paise": amount_paise, "currency": CURRENCY,
            "rate_snapshot": rate, "payout_method_id": payout_method_id,
            "bank_detail_snapshot": payout_method_dto(method),
            "provider": provider.name, "provider_payout_id": None,
            "provider_reference": None, "status": "REQUESTED",
            "withdrawal_mode": routing_mode,
            "requested_withdrawal_mode": mode,
            "risk_status_snapshot": risk_status,
            "mode_version": int(settings.get("mode_version", 1)),
            "hold_operation_id": None, "release_operation_id": None,
            "finalize_operation_id": None,
            "created_at": now(), "updated_at": now(),
        }
        await db.withdrawal_requests.insert_one(doc, **kwargs)
        held = await apply_wallet_movement(
            user_id=user_id, kind="WITHDRAWAL_HOLD",
            source_key=f"withdrawal-hold:{withdrawal_id}",
            idempotency_key=f"withdrawal-hold:{withdrawal_id}",
            deltas={"available_cash_chips": -chips, "held_cash_chips": chips},
            mirror_user_delta=-chips,
            metadata={"withdrawal_id": withdrawal_id, "amount_paise": amount_paise},
            session=session,
        )
        await db.withdrawal_requests.update_one(
            {"id": withdrawal_id, "status": "REQUESTED"},
            {"$set": {"status": status, "hold_operation_id": held["operation_id"], "updated_at": now()}},
            **kwargs,
        )
        if automatic:
            await _enqueue(
                "SUBMIT_PAYOUT", withdrawal_id, f"submit-payout:{withdrawal_id}",
                {"withdrawal_id": withdrawal_id}, session=session,
            )
        doc.update({"status": status, "hold_operation_id": held["operation_id"]})
        return doc

    try:
        return await _run_transaction(work)
    except DuplicateKeyError:
        existing = await db.withdrawal_requests.find_one(
            {"user_id": user_id, "idempotency_key": idem}, {"_id": 0},
        )
        if not existing or (
            int(existing.get("amount_chips", -1)) != chips
            or existing.get("payout_method_id") != payout_method_id
        ):
            raise FinancialError("IDEMPOTENCY_CONFLICT", "Withdrawal request already exists.", 409)
        return existing


async def _enqueue(kind: str, aggregate_id: str, dedupe_key: str, payload: Mapping[str, Any], session=None):
    kwargs = _session_kwargs(session)
    doc = {
        "id": str(uuid.uuid4()), "kind": kind, "aggregate_id": aggregate_id,
        "dedupe_key": dedupe_key, "payload": dict(payload), "status": "PENDING",
        "attempts": 0, "next_attempt_at": now(), "lease_until": None,
        "claim_id": None,
        "created_at": now(), "updated_at": now(),
    }
    try:
        await db.financial_outbox.insert_one(doc, **kwargs)
    except DuplicateKeyError:
        return await db.financial_outbox.find_one({"dedupe_key": dedupe_key}, {"_id": 0}, **kwargs)
    return doc


async def _release_withdrawal(
    withdrawal: Mapping[str, Any], *, status: str, reason: str,
    actor: str, session=None,
) -> dict[str, Any]:
    movement = await apply_wallet_movement(
        user_id=withdrawal["user_id"], kind="WITHDRAWAL_RELEASE",
        source_key=f"withdrawal-release:{withdrawal['id']}",
        idempotency_key=f"withdrawal-release:{withdrawal['id']}",
        deltas={
            "available_cash_chips": int(withdrawal["amount_chips"]),
            "held_cash_chips": -int(withdrawal["amount_chips"]),
        },
        mirror_user_delta=int(withdrawal["amount_chips"]),
        metadata={"withdrawal_id": withdrawal["id"], "reason": reason},
        session=session,
    )
    kwargs = _session_kwargs(session)
    await db.withdrawal_requests.update_one(
        {"id": withdrawal["id"], "status": {"$ne": "PAID"}},
        {"$set": {
            "status": status, "release_operation_id": movement["operation_id"],
            "admin_note": reason, "resolved_by": actor, "resolved_at": now(), "updated_at": now(),
        }},
        **kwargs,
    )
    updated = await db.withdrawal_requests.find_one(
        {"id": withdrawal["id"]}, {"_id": 0}, **kwargs,
    )
    await financial_audit(
        actor, f"WITHDRAWAL_{status}", "WITHDRAWAL", str(withdrawal["id"]),
        reason=reason,
        metadata={"from_status": withdrawal.get("status"), "to_status": status},
        session=session, audit_id=f"withdrawal:{withdrawal['id']}:{status.lower()}",
    )
    return updated


async def reject_withdrawal(withdrawal_id: str, actor: str, reason: str) -> dict[str, Any]:
    if not str(reason or "").strip():
        raise FinancialError("REASON_REQUIRED", "A rejection reason is required.")

    async def work(session):
        kwargs = _session_kwargs(session)
        row = await db.withdrawal_requests.find_one({"id": withdrawal_id}, {"_id": 0}, **kwargs)
        if not row:
            raise FinancialError("WITHDRAWAL_NOT_FOUND", "Withdrawal was not found.", 404)
        if row.get("status") == "REJECTED":
            return row
        if row.get("status") not in WITHDRAWAL_PRE_SUBMISSION:
            raise FinancialError("INVALID_WITHDRAWAL_STATE", "Submitted withdrawals cannot be rejected here.", 409)
        return await _release_withdrawal(
            row, status="REJECTED", reason=str(reason).strip(), actor=actor, session=session,
        )
    return await _run_transaction(work)


async def approve_withdrawal(withdrawal_id: str, actor: str, note: Optional[str] = None) -> dict[str, Any]:
    async def work(session):
        kwargs = _session_kwargs(session)
        row = await db.withdrawal_requests.find_one({"id": withdrawal_id}, {"_id": 0}, **kwargs)
        if not row:
            raise FinancialError("WITHDRAWAL_NOT_FOUND", "Withdrawal was not found.", 404)
        if row.get("status") == "APPROVED":
            return row
        if row.get("status") != "PENDING_ADMIN":
            raise FinancialError("INVALID_WITHDRAWAL_STATE", "Only a pending withdrawal can be approved.", 409)
        await db.withdrawal_requests.update_one(
            {"id": withdrawal_id, "status": "PENDING_ADMIN"},
            {"$set": {"status": "APPROVED", "approved_by": actor, "approved_at": now(),
                      "admin_note": note, "updated_at": now()}}, **kwargs,
        )
        # Routing is frozen with the request.  A MANUAL request never becomes
        # an API payout merely because the global switch changed afterwards.
        if row.get("withdrawal_mode") == AUTOMATIC and env_true("AUTO_WITHDRAWALS_ENABLED"):
            await _enqueue("SUBMIT_PAYOUT", withdrawal_id, f"submit-payout:{withdrawal_id}",
                           {"withdrawal_id": withdrawal_id}, session=session)
        await financial_audit(
            actor, "WITHDRAWAL_APPROVED", "WITHDRAWAL", withdrawal_id,
            reason=note, metadata={"from_status": "PENDING_ADMIN", "to_status": "APPROVED"},
            session=session, audit_id=f"withdrawal:{withdrawal_id}:approved",
        )
        return await db.withdrawal_requests.find_one(
            {"id": withdrawal_id}, {"_id": 0}, **kwargs,
        )
    return await _run_transaction(work)


async def mark_withdrawal_submitted(
    withdrawal_id: str, actor: str, provider_reference: str,
) -> dict[str, Any]:
    reference = str(provider_reference or "").strip()
    if not 2 <= len(reference) <= 160:
        raise FinancialError("PROVIDER_REFERENCE_REQUIRED", "A valid provider reference is required.")
    async def work(session):
        kwargs = _session_kwargs(session)
        row = await db.withdrawal_requests.find_one(
            {"id": withdrawal_id}, {"_id": 0}, **kwargs,
        )
        if not row:
            raise FinancialError("WITHDRAWAL_NOT_FOUND", "Withdrawal was not found.", 404)
        if row.get("status") == "SUBMITTED_TO_PROVIDER" and row.get("provider_reference") == reference:
            return row
        if row.get("status") != "APPROVED":
            raise FinancialError("INVALID_WITHDRAWAL_STATE", "Withdrawal must be approved first.", 409)
        if row.get("withdrawal_mode") != MANUAL:
            raise FinancialError(
                "AUTOMATIC_WITHDRAWAL", "Automatic withdrawals cannot be submitted manually.", 409,
            )
        try:
            await db.withdrawal_requests.update_one(
                {"id": withdrawal_id, "status": "APPROVED"},
                {"$set": {
            "status": "SUBMITTED_TO_PROVIDER", "provider_reference": reference,
                    "provider_payout_id": reference,
                    "submitted_by": actor, "submitted_at": now(), "updated_at": now(),
                }}, **kwargs,
            )
        except DuplicateKeyError as exc:
            raise FinancialError(
                "PROVIDER_REFERENCE_CONFLICT", "Provider reference is already in use.", 409,
            ) from exc
        await financial_audit(
            actor, "WITHDRAWAL_MARKED_SUBMITTED", "WITHDRAWAL", withdrawal_id,
            metadata={"provider_reference": reference}, session=session,
            audit_id=f"withdrawal:{withdrawal_id}:submitted",
        )
        return await db.withdrawal_requests.find_one(
            {"id": withdrawal_id}, {"_id": 0}, **kwargs,
        )
    return await _run_transaction(work)


async def attach_unknown_payout_reference(
    withdrawal_id: str, actor: str, provider_reference: str, reason: str,
) -> dict[str, Any]:
    """Attach an externally confirmed ID to an uncertain automatic submission."""
    reference = str(provider_reference or "").strip()
    rationale = str(reason or "").strip()
    if not 2 <= len(reference) <= 160:
        raise FinancialError("PROVIDER_REFERENCE_REQUIRED", "A valid provider reference is required.")
    if len(rationale) < 5:
        raise FinancialError("REASON_REQUIRED", "A clear recovery reason is required.")

    async def work(session):
        kwargs = _session_kwargs(session)
        row = await db.withdrawal_requests.find_one(
            {"id": withdrawal_id}, {"_id": 0}, **kwargs,
        )
        if not row:
            raise FinancialError("WITHDRAWAL_NOT_FOUND", "Withdrawal was not found.", 404)
        if row.get("provider_payout_id") == reference:
            return row
        if row.get("status") != "SUBMISSION_UNKNOWN" or row.get("withdrawal_mode") != AUTOMATIC:
            raise FinancialError(
                "INVALID_WITHDRAWAL_STATE",
                "Only an uncertain automatic payout can receive a recovered provider reference.", 409,
            )
        try:
            await db.withdrawal_requests.update_one(
                {"id": withdrawal_id, "status": "SUBMISSION_UNKNOWN"},
                {"$set": {
                    "provider_payout_id": reference, "provider_reference": reference,
                    "reference_recovered_by": actor, "reference_recovered_at": now(),
                    "updated_at": now(),
                }}, **kwargs,
            )
        except DuplicateKeyError as exc:
            raise FinancialError(
                "PROVIDER_REFERENCE_CONFLICT", "Provider reference is already in use.", 409,
            ) from exc
        await financial_audit(
            actor, "PAYOUT_REFERENCE_RECOVERED", "WITHDRAWAL", withdrawal_id,
            reason=rationale, metadata={"provider_reference": reference}, session=session,
            audit_id=f"withdrawal:{withdrawal_id}:reference-recovered",
        )
        return await db.withdrawal_requests.find_one(
            {"id": withdrawal_id}, {"_id": 0}, **kwargs,
        )

    return await _run_transaction(work)


async def _finalize_paid(
    withdrawal: Mapping[str, Any], provider_reference: str, actor: str, session=None,
) -> dict[str, Any]:
    movement = await apply_wallet_movement(
        user_id=withdrawal["user_id"], kind="WITHDRAWAL_PAID",
        source_key=f"withdrawal-paid:{withdrawal['id']}",
        idempotency_key=f"withdrawal-paid:{withdrawal['id']}",
        deltas={"held_cash_chips": -int(withdrawal["amount_chips"])},
        mirror_user_delta=0,
        metadata={"withdrawal_id": withdrawal["id"], "provider_reference": provider_reference},
        session=session,
    )
    kwargs = _session_kwargs(session)
    await db.withdrawal_requests.update_one(
        {"id": withdrawal["id"], "status": {"$ne": "PAID"}},
        {"$set": {
            "status": "PAID", "provider_reference": provider_reference,
            "finalize_operation_id": movement["operation_id"], "paid_at": now(),
            "paid_by": actor, "updated_at": now(),
        }}, **kwargs,
    )
    user = await db.users.find_one(
        {"id": withdrawal["user_id"]}, {"_id": 0, "chip_balance": 1}, **kwargs,
    )
    await db.chip_transactions.update_one(
        {"id": f"financial-withdrawal:{withdrawal['id']}"},
        {"$setOnInsert": {
            "id": f"financial-withdrawal:{withdrawal['id']}",
            "user_id": withdrawal["user_id"], "type": "DEBIT", "kind": ledger.WITHDRAWAL,
            "amount": int(withdrawal["amount_chips"]),
            "balance_after": int((user or {}).get("chip_balance", 0)),
            "game": None, "gaming_day": ledger.gaming_day(),
            "note": "Withdrawal paid", "ref": withdrawal["id"],
            "created_at": now().isoformat(),
        }}, upsert=True, **kwargs,
    )
    return await db.withdrawal_requests.find_one({"id": withdrawal["id"]}, {"_id": 0}, **kwargs)


async def mark_withdrawal_paid(
    withdrawal_id: str, actor: str, provider_reference: str, *, manual_only: bool = False,
) -> dict[str, Any]:
    reference = str(provider_reference or "").strip()
    if not 2 <= len(reference) <= 160:
        raise FinancialError("PROVIDER_REFERENCE_REQUIRED", "A valid provider reference is required.")

    async def work(session):
        kwargs = _session_kwargs(session)
        row = await db.withdrawal_requests.find_one({"id": withdrawal_id}, {"_id": 0}, **kwargs)
        if not row:
            raise FinancialError("WITHDRAWAL_NOT_FOUND", "Withdrawal was not found.", 404)
        if row.get("status") == "PAID":
            if row.get("provider_reference") != reference:
                raise FinancialError("PROVIDER_REFERENCE_CONFLICT", "Withdrawal is already paid.", 409)
            return row
        if manual_only and row.get("withdrawal_mode") != MANUAL:
            raise FinancialError(
                "AUTOMATIC_WITHDRAWAL",
                "Automatic withdrawals require provider confirmation or reconciliation.", 409,
            )
        if row.get("status") not in {"SUBMITTED_TO_PROVIDER", "PROCESSING", "SUBMISSION_UNKNOWN"}:
            raise FinancialError("INVALID_WITHDRAWAL_STATE", "Withdrawal has not been submitted.", 409)
        updated = await _finalize_paid(row, reference, actor, session=session)
        await financial_audit(
            actor, "WITHDRAWAL_MARKED_PAID", "WITHDRAWAL", withdrawal_id,
            metadata={"provider_reference": reference}, session=session,
            audit_id=f"withdrawal:{withdrawal_id}:paid",
        )
        return updated
    return await _run_transaction(work)


async def set_withdrawal_mode(
    mode: str, actor: str, reason: str, provider: Optional[PaymentProvider] = None,
) -> dict[str, Any]:
    mode = str(mode or "").strip().upper()
    reason = str(reason or "").strip()
    if mode not in {MANUAL, AUTOMATIC}:
        raise FinancialError("INVALID_WITHDRAWAL_MODE", "Mode must be MANUAL or AUTOMATIC.")
    if not reason:
        raise FinancialError("REASON_REQUIRED", "A reason is required.")
    if mode == AUTOMATIC:
        require_financial_feature("automatic_withdrawals")
        if provider is None:
            raise FinancialError("PAYMENT_PROVIDER_NOT_READY", "A payout provider is required.", 503)
        if not (provider.capabilities.payout_idempotency and provider.capabilities.payout_status_lookup):
            raise FinancialError(
                "PROVIDER_NOT_SAFE_FOR_AUTOMATIC_PAYOUTS",
                "Provider does not support safe automatic payouts.", 409,
            )

    async def work(session):
        kwargs = _session_kwargs(session)
        current = await ensure_payment_settings(session=session)
        old = current.get("withdrawal_mode", MANUAL)
        if old == mode:
            return current
        updated = await db.payment_settings.find_one_and_update(
            {"key": "main", "mode_version": int(current.get("mode_version", 1))},
            {"$set": {"withdrawal_mode": mode, "updated_at": now(), "updated_by": actor},
             "$inc": {"mode_version": 1, "claim_serial": 1}},
            return_document=ReturnDocument.AFTER, **kwargs,
        )
        if not updated:
            raise FinancialError("PAYMENT_SETTINGS_CHANGED", "Payment settings changed; retry.", 409)
        await db.financial_audit.insert_one({
            "id": str(uuid.uuid4()), "actor_id": actor,
            "action": "WITHDRAWAL_MODE_CHANGED", "target_type": "PAYMENT_SETTINGS",
            "target_id": "main", "before": {"withdrawal_mode": old},
            "after": {"withdrawal_mode": mode}, "reason": reason, "created_at": now(),
        }, **kwargs)
        if mode == AUTOMATIC:
            await db.financial_outbox.update_many(
                {"kind": "SUBMIT_PAYOUT", "status": "PAUSED"},
                {"$set": {"status": "PENDING", "next_attempt_at": now(), "updated_at": now()}},
                **kwargs,
            )
        else:
            await db.financial_outbox.update_many(
                {"kind": "SUBMIT_PAYOUT", "status": {"$in": ["PENDING", "RETRY"]}},
                {"$set": {"status": "PAUSED", "updated_at": now()}},
                **kwargs,
            )
        return {k: v for k, v in updated.items() if k != "_id"}
    return await _run_transaction(work)


async def review_player_kyc(
    user_id: str, status: str, actor: str, reason: str,
) -> dict[str, Any]:
    """Record an explicit human KYC decision; contact OTP never calls this."""
    decision = str(status or "").strip().upper()
    rationale = str(reason or "").strip()
    if decision not in {"VERIFIED", "REJECTED"}:
        raise FinancialError("INVALID_KYC_STATUS", "KYC status must be VERIFIED or REJECTED.")
    if len(rationale) < 5:
        raise FinancialError("REASON_REQUIRED", "A clear KYC review reason is required.")

    async def work(session):
        kwargs = _session_kwargs(session)
        user = await db.users.find_one(
            {"id": user_id, "role": "PLAYER"}, {"_id": 0}, **kwargs,
        )
        if not user:
            raise FinancialError("USER_NOT_FOUND", "Player account was not found.", 404)
        previous = str(user.get("kyc_status") or "UNVERIFIED").upper()
        if previous == decision:
            return user
        reviewed_at = now()
        updated = await db.users.find_one_and_update(
            {"id": user_id, "role": "PLAYER"},
            {"$set": {
                "kyc_status": decision, "kyc_reviewed_at": reviewed_at,
                "kyc_reviewed_by": actor, "kyc_review_reason": rationale,
            }}, return_document=ReturnDocument.AFTER, **kwargs,
        )
        await financial_audit(
            actor, f"KYC_{decision}", "PLAYER", user_id, reason=rationale,
            metadata={"before": previous, "after": decision}, session=session,
        )
        return {key: value for key, value in updated.items() if key != "_id"}

    return await _run_transaction(work)


async def claim_automatic_withdrawal(withdrawal_id: str) -> dict[str, Any]:
    """Atomically claim a payout while serializing against mode changes."""
    require_financial_feature("automatic_withdrawals")

    async def work(session):
        kwargs = _session_kwargs(session)
        settings = await ensure_payment_settings(session=session)
        if settings.get("withdrawal_mode") != AUTOMATIC:
            raise FinancialError("AUTO_WITHDRAWALS_PAUSED", "Automatic withdrawals are paused.", 409)
        # This write deliberately conflicts with a simultaneous mode update, so
        # either the pause wins first or this one claim does; no request can be
        # claimed from a stale read after the pause has committed.
        touched = await db.payment_settings.update_one(
            {"key": "main", "mode_version": int(settings.get("mode_version", 1)),
             "withdrawal_mode": AUTOMATIC},
            {"$inc": {"claim_serial": 1}}, **kwargs,
        )
        if not touched.modified_count:
            raise FinancialError("AUTO_WITHDRAWALS_PAUSED", "Automatic withdrawals are paused.", 409)
        row = await db.withdrawal_requests.find_one_and_update(
            {"id": withdrawal_id, "status": "APPROVED", "withdrawal_mode": AUTOMATIC},
            {"$set": {"status": "SUBMITTING", "submission_started_at": now(), "updated_at": now()}},
            return_document=ReturnDocument.AFTER, **kwargs,
        )
        if not row:
            current = await db.withdrawal_requests.find_one({"id": withdrawal_id}, {"_id": 0}, **kwargs)
            if current and current.get("withdrawal_mode") != AUTOMATIC:
                raise FinancialError(
                    "MANUAL_WITHDRAWAL", "This request is permanently routed for manual processing.", 409,
                )
            if current and current.get("status") in WITHDRAWAL_PROVIDER_PENDING:
                return current
            raise FinancialError("INVALID_WITHDRAWAL_STATE", "Withdrawal is not ready for submission.", 409)
        attempt = {
            "id": str(uuid.uuid4()), "withdrawal_id": withdrawal_id,
            "provider": row["provider"], "idempotency_key": f"withdrawal:{withdrawal_id}",
            "status": "SUBMITTING", "created_at": now(), "updated_at": now(),
        }
        try:
            await db.payout_attempts.insert_one(attempt, **kwargs)
        except DuplicateKeyError:
            pass
        return {k: v for k, v in row.items() if k != "_id"}
    return await _run_transaction(work)


async def _authorize_automatic_submission(withdrawal_id: str) -> bool:
    """Commit a last-moment payout intent serialized with the mode switch.

    If MANUAL won the race first, an as-yet-unsubmitted claim is put back into
    APPROVED and the caller must not cross the provider boundary. If this
    intent wins first, a subsequent pause treats it as already in flight.
    """
    async def work(session):
        kwargs = _session_kwargs(session)
        settings = await ensure_payment_settings(session=session)
        if settings.get("withdrawal_mode") != AUTOMATIC:
            await db.withdrawal_requests.update_one(
                {
                    "id": withdrawal_id, "status": "SUBMITTING",
                    "provider_payout_id": None,
                },
                {"$set": {"status": "APPROVED", "updated_at": now()}}, **kwargs,
            )
            return False
        touched = await db.payment_settings.update_one(
            {
                "key": "main", "withdrawal_mode": AUTOMATIC,
                "mode_version": int(settings.get("mode_version", 1)),
            },
            {"$inc": {"claim_serial": 1}}, **kwargs,
        )
        if not touched.modified_count:
            return False
        authorized_at = now()
        updated = await db.withdrawal_requests.find_one_and_update(
            {
                "id": withdrawal_id, "withdrawal_mode": AUTOMATIC,
                "status": {"$in": ["SUBMITTING", "SUBMISSION_UNKNOWN"]},
            },
            {"$set": {
                "submission_intent": f"withdrawal:{withdrawal_id}",
                "submission_authorized_at": authorized_at,
                "submission_authorized_mode_version": int(settings.get("mode_version", 1)),
                "updated_at": authorized_at,
            }},
            return_document=ReturnDocument.AFTER, **kwargs,
        )
        return bool(updated)

    return bool(await _run_transaction(work))


async def submit_automatic_withdrawal(withdrawal_id: str, provider: PaymentProvider) -> dict[str, Any]:
    row = await claim_automatic_withdrawal(withdrawal_id)
    if row.get("status") not in {"SUBMITTING", "SUBMISSION_UNKNOWN"}:
        return row
    if row.get("provider") != provider.name:
        raise FinancialError("PAYMENT_PROVIDER_MISMATCH", "Withdrawal provider does not match.", 409)
    method = await db.payout_methods.find_one({
        "id": row["payout_method_id"], "user_id": row["user_id"], "status": "ACTIVE",
    }, {"_id": 0})
    if not method:
        await db.withdrawal_requests.update_one(
            {"id": withdrawal_id, "status": "SUBMITTING"},
            {"$set": {"status": "PENDING_ADMIN", "last_error": "PAYOUT_METHOD_UNAVAILABLE", "updated_at": now()}},
        )
        raise FinancialError("BANK_DETAILS_NOT_FOUND", "Bank details are unavailable.", 409)
    beneficiary_id = method.get("provider_beneficiary_id")
    try:
        if not beneficiary_id:
            details = decrypt_payout_details(method)
            beneficiary = await provider.create_beneficiary(
                bank_details=details, idempotency_key=f"beneficiary:{method['id']}",
            )
            beneficiary_id = beneficiary.provider_beneficiary_id
            await db.payout_methods.update_one(
                {"id": method["id"], "provider_beneficiary_id": None},
                {"$set": {"provider_beneficiary_id": beneficiary_id, "updated_at": now()}},
            )
    except Exception as exc:  # noqa: BLE001 - no payout instruction was sent yet
        await db.withdrawal_requests.update_one(
            {"id": withdrawal_id, "status": "SUBMITTING"},
            {"$set": {"status": "APPROVED", "last_error": type(exc).__name__, "updated_at": now()}},
        )
        raise FinancialError(
            "PAYOUT_PREPARATION_FAILED", "Payout preparation failed and will be retried.", 503,
        ) from exc
    await db.withdrawal_requests.update_one(
        {
            "id": withdrawal_id,
            "status": {"$in": ["SUBMITTING", "SUBMISSION_UNKNOWN"]},
        },
        {"$set": {"provider_beneficiary_id": beneficiary_id, "updated_at": now()}},
    )
    if not await _authorize_automatic_submission(withdrawal_id):
        raise FinancialError(
            "AUTO_WITHDRAWALS_PAUSED", "Automatic withdrawals are paused.", 409,
        )
    try:
        submitted = await provider.submit_payout(
            withdrawal_id=withdrawal_id, provider_beneficiary_id=beneficiary_id,
            amount_paise=int(row["amount_paise"]), currency=CURRENCY,
            idempotency_key=f"withdrawal:{withdrawal_id}",
        )
    except Exception as exc:  # noqa: BLE001 - unknown outcome must never release funds
        await db.withdrawal_requests.update_one(
            {"id": withdrawal_id, "status": {"$in": ["SUBMITTING", "SUBMISSION_UNKNOWN"]}},
            {"$set": {"status": "SUBMISSION_UNKNOWN", "last_error": type(exc).__name__,
                      "updated_at": now()}},
        )
        await db.payout_attempts.update_one(
            {"idempotency_key": f"withdrawal:{withdrawal_id}"},
            {"$set": {"status": "SUBMISSION_UNKNOWN", "updated_at": now()}},
        )
        raise FinancialError(
            "PAYOUT_SUBMISSION_UNKNOWN",
            "Payout status is unknown and requires reconciliation.", 503,
        ) from exc
    submitted_id = getattr(submitted, "provider_payout_id", None)
    submitted_status = str(getattr(submitted, "status", "")).strip().upper()
    if not isinstance(submitted_id, str) or not 2 <= len(submitted_id.strip()) <= 160:
        await db.withdrawal_requests.update_one(
            {"id": withdrawal_id, "status": {"$in": ["SUBMITTING", "SUBMISSION_UNKNOWN"]}},
            {"$set": {"status": "SUBMISSION_UNKNOWN", "last_error": "INVALID_PROVIDER_RESPONSE",
                      "updated_at": now()}},
        )
        raise FinancialError(
            "PAYOUT_SUBMISSION_UNKNOWN", "Payout status is unknown and requires reconciliation.", 503,
        )
    status = "PROCESSING" if submitted_status == "PROCESSING" else "SUBMITTED_TO_PROVIDER"
    try:
        await db.withdrawal_requests.update_one(
            {"id": withdrawal_id, "status": {"$in": ["SUBMITTING", "SUBMISSION_UNKNOWN"]}},
            {"$set": {
                "status": status, "provider_payout_id": submitted_id,
                "provider_reference": submitted_id,
                "submitted_at": now(), "updated_at": now(),
            }},
        )
    except DuplicateKeyError as exc:
        await db.withdrawal_requests.update_one(
            {"id": withdrawal_id},
            {"$set": {"status": "SUBMISSION_UNKNOWN", "last_error": "PROVIDER_REFERENCE_CONFLICT",
                      "updated_at": now()}},
        )
        raise FinancialError(
            "PAYOUT_SUBMISSION_UNKNOWN", "Payout identity requires reconciliation.", 503,
        ) from exc
    await db.payout_attempts.update_one(
        {"idempotency_key": f"withdrawal:{withdrawal_id}"},
        {"$set": {"status": status, "provider_payout_id": submitted_id,
                  "updated_at": now()}},
    )
    return await db.withdrawal_requests.find_one({"id": withdrawal_id}, {"_id": 0})


async def process_outbox_batch(provider: PaymentProvider, limit: int = 20) -> dict[str, int]:
    processed = paused = review = retry_scheduled = 0
    for _ in range(max(1, min(int(limit), 100))):
        claim_time = now()
        claim_id = str(uuid.uuid4())
        lease = claim_time + timedelta(minutes=2)
        row = await db.financial_outbox.find_one_and_update(
            {"$or": [
                {"status": {"$in": ["PENDING", "RETRY"]}, "next_attempt_at": {"$lte": claim_time}},
                {"status": "PROCESSING", "lease_until": {"$lte": claim_time}},
            ]},
            {"$set": {
                "status": "PROCESSING", "claim_id": claim_id,
                "lease_until": lease, "updated_at": claim_time,
            },
             "$inc": {"attempts": 1}},
            sort=[("created_at", 1)], return_document=ReturnDocument.AFTER,
        )
        if not row:
            break
        ownership = {
            "id": row["id"], "status": "PROCESSING", "claim_id": claim_id,
        }
        try:
            if row["kind"] != "SUBMIT_PAYOUT":
                raise FinancialError("UNKNOWN_OUTBOX_EVENT", "Unknown financial outbox event.", 409)
            await submit_automatic_withdrawal(row["aggregate_id"], provider)
            completed = await db.financial_outbox.update_one(
                ownership,
                {"$set": {
                    "status": "COMPLETED", "claim_id": None, "lease_until": None,
                    "completed_at": now(), "updated_at": now(),
                }},
            )
            if completed.matched_count:
                processed += 1
        except FinancialError as exc:
            if exc.code == "AUTO_WITHDRAWALS_PAUSED":
                status = "PAUSED"
            elif exc.code in {"PAYOUT_SUBMISSION_UNKNOWN", "PAYOUT_PREPARATION_FAILED"} and int(
                row.get("attempts", 0)
            ) < 8:
                status = "RETRY"
            else:
                status = "RECONCILIATION_REQUIRED"
            updates: dict[str, Any] = {
                "status": status, "last_error_code": exc.code,
                "claim_id": None, "lease_until": None, "updated_at": now(),
            }
            if status == "RETRY":
                updates["next_attempt_at"] = now() + _reconciliation_delay(int(row.get("attempts", 1)))
            finalized = await db.financial_outbox.update_one(
                ownership,
                {"$set": updates},
            )
            if not finalized.matched_count:
                continue
            if status == "PAUSED":
                paused += 1
            elif status == "RETRY":
                retry_scheduled += 1
            else:
                review += 1
    return {
        "processed": processed, "paused": paused,
        "retry_scheduled": retry_scheduled, "reconciliation_required": review,
    }


async def _close_unpaid_deposit(
    deposit_id: str, status: str, actor: str = "provider-webhook",
) -> dict[str, Any]:
    """Close an unpaid order and release its deposit-limit reservation."""
    if status not in {"FAILED", "EXPIRED"}:
        raise FinancialError("INVALID_DEPOSIT_STATE", "Invalid unpaid deposit state.")

    async def work(session):
        kwargs = _session_kwargs(session)
        current = await db.deposit_orders.find_one(
            {"id": deposit_id}, {"_id": 0}, **kwargs,
        )
        if not current:
            raise FinancialError("DEPOSIT_NOT_FOUND", "Deposit order was not found.", 404)
        if current.get("status") in {"CREDITED", "REFUNDED", "REFUND_REVIEW_REQUIRED"}:
            return current
        await _touch_deposit_limit_lock(current["user_id"], session=session)
        await db.deposit_orders.update_one(
            {"id": deposit_id, "status": {"$nin": ["CREDITED", "REFUNDED"]}},
            {"$set": {
                "status": status, "limit_reservation_status": "RELEASED",
                "limit_reservation_released_at": now(), "updated_at": now(),
            }}, **kwargs,
        )
        await financial_audit(
            actor, f"DEPOSIT_{status}", "DEPOSIT", deposit_id,
            session=session, audit_id=f"deposit:{deposit_id}:{status.lower()}",
        )
        return await db.deposit_orders.find_one(
            {"id": deposit_id}, {"_id": 0}, **kwargs,
        )

    return await _run_transaction(work)


async def _route_deposit_event_mismatch(
    order: Mapping[str, Any], event: ProviderEvent,
    actor: str = "provider-webhook",
) -> None:
    """Keep a mismatched terminal webhook from releasing a deposit reservation."""
    async def work(session):
        kwargs = _session_kwargs(session)
        current = await db.deposit_orders.find_one(
            {"id": order["id"]}, {"_id": 0}, **kwargs,
        )
        if not current:
            raise FinancialError("DEPOSIT_NOT_FOUND", "Deposit order was not found.", 404)
        terminal = current.get("status") in {
            "CREDITED", "REFUNDED", "REFUND_REVIEW_REQUIRED",
        }
        updates: dict[str, Any] = {
            "reconciliation_error_code": "PAYMENT_MISMATCH",
            "next_reconcile_at": now(), "updated_at": now(),
        }
        if not terminal:
            updates["status"] = "RECONCILIATION_REQUIRED"
        else:
            await db.users.update_one(
                {"id": current["user_id"]},
                {"$set": {"financial_status": "REVIEW_REQUIRED"}}, **kwargs,
            )
        await db.deposit_orders.update_one(
            {"id": current["id"]}, {"$set": updates}, **kwargs,
        )
        await financial_audit(
            actor, "DEPOSIT_EVENT_MISMATCH", "DEPOSIT", str(current["id"]),
            reason="Provider terminal event amount or currency did not match the deposit",
            metadata={"provider_event_id": event.event_id, "event_type": event.event_type},
            session=session,
            audit_id=f"deposit:{current['id']}:event-mismatch:{event.event_id}",
        )

    await _run_transaction(work)


async def _refund_deposit(
    order: Mapping[str, Any], *, amount_paise: Optional[int], currency: Optional[str],
    provider_reference: Optional[str], actor: str = "provider-webhook",
) -> dict[str, Any]:
    """Apply a provider-confirmed refund without a wallet/order commit gap."""
    async def work(session):
        kwargs = _session_kwargs(session)
        current = await db.deposit_orders.find_one(
            {"id": order["id"]}, {"_id": 0}, **kwargs,
        )
        if not current:
            raise FinancialError("DEPOSIT_NOT_FOUND", "Deposit order was not found.", 404)
        refund_reference = str(provider_reference or "").strip()
        if (
            amount_paise != int(current["amount_paise"])
            or currency != CURRENCY
            or not 1 <= len(refund_reference) <= 160
        ):
            updates = {
                "reconciliation_error_code": "REFUND_MISMATCH", "updated_at": now(),
            }
            if current.get("status") != "CREDITED":
                updates["status"] = "RECONCILIATION_REQUIRED"
            else:
                await db.users.update_one(
                    {"id": current["user_id"]},
                    {"$set": {"financial_status": "REVIEW_REQUIRED"}}, **kwargs,
                )
            await db.deposit_orders.update_one(
                {"id": current["id"]}, {"$set": updates}, **kwargs,
            )
            return {"_error_code": "REFUND_MISMATCH"}
        conflicting = await db.deposit_orders.find_one({
            "provider": current.get("provider"),
            "refund_provider_reference": refund_reference,
            "id": {"$ne": current["id"]},
        }, {"_id": 0, "id": 1, "user_id": 1}, **kwargs)
        if conflicting:
            await db.users.update_many(
                {"id": {"$in": [current["user_id"], conflicting["user_id"]]}},
                {"$set": {"financial_status": "REVIEW_REQUIRED"}}, **kwargs,
            )
            await db.deposit_orders.update_many(
                {"id": {"$in": [current["id"], conflicting["id"]]}},
                {"$set": {
                    "reconciliation_error_code": "REFUND_REFERENCE_CONFLICT",
                    "updated_at": now(),
                }}, **kwargs,
            )
            await financial_audit(
                actor, "REFUND_REFERENCE_CONFLICT", "DEPOSIT", str(current["id"]),
                reason="Provider refund reference is already bound to another deposit",
                metadata={"conflicting_deposit_id": conflicting["id"]},
                session=session,
                audit_id=f"deposit:{current['id']}:refund-reference-conflict",
            )
            return {"_error_code": "REFUND_REFERENCE_CONFLICT"}
        if current.get("status") == "REFUNDED":
            if current.get("refund_provider_reference") != refund_reference:
                return {"_error_code": "DEPOSIT_TERMINAL_CONFLICT"}
            return {"deposit_id": current["id"], "status": "REFUNDED", "duplicate": True}
        await _touch_deposit_limit_lock(current["user_id"], session=session)
        movement = None
        if current.get("status") == "CREDITED":
            movement = await apply_wallet_movement(
                user_id=current["user_id"], kind="DEPOSIT_REFUND",
                source_key=f"deposit-refund:{current['id']}",
                idempotency_key=f"deposit-refund:{current['id']}",
                deltas={"available_cash_chips": -int(current["chips"])},
                mirror_user_delta=-int(current["chips"]),
                metadata={"deposit_id": current["id"]}, session=session,
            )
        await db.deposit_orders.update_one(
            {"id": current["id"], "status": {"$ne": "REFUNDED"}},
            {"$set": {
                "status": "REFUNDED",
                "refund_operation_id": movement and movement["operation_id"],
                "refund_provider_reference": refund_reference,
                "limit_reservation_status": "REFUNDED",
                "limit_reservation_released_at": now(),
                "refunded_at": now(), "updated_at": now(),
            }}, **kwargs,
        )
        await financial_audit(
            actor, "DEPOSIT_REFUNDED", "DEPOSIT", str(current["id"]),
            metadata={"wallet_operation_id": movement and movement["operation_id"]},
            session=session, audit_id=f"deposit:{current['id']}:refunded",
        )
        return {
            "deposit_id": current["id"], "status": "REFUNDED",
            "duplicate": bool(movement and movement.get("duplicate")),
        }

    try:
        result = await _run_transaction(work)
        error_code = result.pop("_error_code", None)
        if error_code == "REFUND_MISMATCH":
            raise FinancialError(
                "REFUND_MISMATCH",
                "Provider refund amount, currency, or reference does not match the deposit.", 409,
            )
        if error_code == "DEPOSIT_TERMINAL_CONFLICT":
            raise FinancialError(
                "DEPOSIT_TERMINAL_CONFLICT",
                "Provider refund identity conflicts with an already refunded deposit.", 409,
            )
        if error_code == "REFUND_REFERENCE_CONFLICT":
            raise FinancialError(
                "REFUND_REFERENCE_CONFLICT",
                "Provider refund reference is already bound to another deposit.", 409,
            )
        return result
    except DuplicateKeyError as exc:
        reference = str(provider_reference or "").strip()
        conflicting = await db.deposit_orders.find_one({
            "provider": order.get("provider"),
            "refund_provider_reference": reference,
            "id": {"$ne": order["id"]},
        }, {"_id": 0, "id": 1, "user_id": 1})
        if not conflicting:
            raise
        await _flag_financial_review(
            str(order["user_id"]), "REFUND_REFERENCE_CONFLICT", "DEPOSIT", str(order["id"]),
            "Provider refund reference is already bound to another deposit",
        )
        await _flag_financial_review(
            str(conflicting["user_id"]), "REFUND_REFERENCE_CONFLICT", "DEPOSIT",
            str(conflicting["id"]),
            "Provider refund reference was reused for another deposit",
        )
        await db.deposit_orders.update_many(
            {"id": {"$in": [order["id"], conflicting["id"]]}},
            {"$set": {"reconciliation_error_code": "REFUND_REFERENCE_CONFLICT", "updated_at": now()}},
        )
        raise FinancialError(
            "REFUND_REFERENCE_CONFLICT",
            "Provider refund reference is already bound to another deposit.", 409,
        ) from exc
    except FinancialError as exc:
        if exc.code not in {"INSUFFICIENT_WITHDRAWABLE_CHIPS", "WALLET_RECONCILIATION_REQUIRED"}:
            raise

        async def require_review(session):
            kwargs = _session_kwargs(session)
            await db.deposit_orders.update_one(
                {"id": order["id"], "status": {"$ne": "REFUNDED"}},
                {"$set": {"status": "REFUND_REVIEW_REQUIRED", "updated_at": now()}},
                **kwargs,
            )
            await db.users.update_one(
                {"id": order["user_id"]},
                {"$set": {"financial_status": "REVIEW_REQUIRED"}}, **kwargs,
            )
            await financial_audit(
                actor, "DEPOSIT_REFUND_REVIEW_REQUIRED", "DEPOSIT", str(order["id"]),
                reason=exc.code, session=session,
                audit_id=f"deposit:{order['id']}:refund-review",
            )
            return {"deposit_id": order["id"], "status": "REFUND_REVIEW_REQUIRED"}

        return await _run_transaction(require_review)


_DEPOSIT_SUCCESS = frozenset({"PAID", "SUCCESS", "SUCCEEDED", "CAPTURED", "CREDITED"})
_DEPOSIT_WAITING = frozenset({"CREATED", "PENDING", "PROCESSING", "AUTHORIZED"})
_PAYOUT_SUCCESS = frozenset({"PAID", "SUCCESS", "SUCCEEDED", "COMPLETED"})
_PAYOUT_WAITING = frozenset({"CREATED", "PENDING", "PROCESSING", "SUBMITTED", "QUEUED"})


def _reconciliation_delay(attempts: int) -> timedelta:
    return timedelta(seconds=min(15 * (2 ** min(max(0, int(attempts)), 6)), 900))


def _require_deposit_status(value: Any) -> DepositStatus:
    if not isinstance(value, DepositStatus):
        raise FinancialError(
            "UNSAFE_PROVIDER_STATUS",
            "Payment provider did not return authoritative reconciliation details.", 503,
        )
    return value


def _require_payout_status(value: Any) -> PayoutStatus:
    if not isinstance(value, PayoutStatus):
        raise FinancialError(
            "UNSAFE_PROVIDER_STATUS",
            "Payout provider did not return authoritative reconciliation details.", 503,
        )
    return value


def _payout_status_is_bound(
    authoritative: PayoutStatus, withdrawal: Mapping[str, Any],
) -> bool:
    reference = str(authoritative.provider_reference or "").strip()
    return (
        authoritative.amount_paise == int(withdrawal["amount_paise"])
        and authoritative.currency == CURRENCY
        and authoritative.withdrawal_id == str(withdrawal["id"])
        and authoritative.idempotency_key == f"withdrawal:{withdrawal['id']}"
        and authoritative.provider_beneficiary_id
        == withdrawal.get("provider_beneficiary_id")
        and 1 <= len(reference) <= 160
    )


async def reconcile_deposit(
    deposit_id: str, provider: PaymentProvider, actor: str = "reconciliation-job",
) -> dict[str, Any]:
    order = await db.deposit_orders.find_one({"id": deposit_id}, {"_id": 0})
    if not order:
        raise FinancialError("DEPOSIT_NOT_FOUND", "Deposit order was not found.", 404)
    if order.get("provider") != provider.name:
        raise FinancialError("PAYMENT_PROVIDER_MISMATCH", "Deposit provider does not match.", 409)
    if order.get("status") == "REFUNDED":
        return {"deposit_id": deposit_id, "status": order["status"], "terminal": True}
    if not order.get("provider_order_id"):
        ttl_seconds = _runtime_config_int(
            "DEPOSIT_CHECKOUT_RESERVATION_TTL_SECONDS", 1800, 300, 86_400,
        )
        created_at = _parse_optional_datetime(order.get("created_at"))
        if created_at and created_at <= now() - timedelta(seconds=ttl_seconds):
            expired = await _close_unpaid_deposit(deposit_id, "EXPIRED", actor=actor)
            return {"deposit_id": deposit_id, "status": expired.get("status", "EXPIRED")}
        stored, _ = await _ensure_deposit_checkout(order, provider)
        attempts = int(stored.get("reconcile_attempts", 0)) + 1
        await db.deposit_orders.update_one(
            {"id": deposit_id},
            {"$set": {
                "next_reconcile_at": now() + _reconciliation_delay(attempts),
                "reconciled_at": now(), "updated_at": now(),
            }, "$inc": {"reconcile_attempts": 1}},
        )
        return {"deposit_id": deposit_id, "status": stored.get("status", "PENDING")}
    try:
        authoritative = _require_deposit_status(
            await provider.get_payment_status(str(order["provider_order_id"])),
        )
        provider_status = str(authoritative.status).strip().upper()
    except Exception as exc:  # noqa: BLE001 - do not leak provider internals
        attempts = int(order.get("reconcile_attempts", 0)) + 1
        await db.deposit_orders.update_one(
            {"id": deposit_id},
            {"$set": {
                "next_reconcile_at": now() + _reconciliation_delay(attempts),
                "reconciliation_error_code": (
                    exc.code if isinstance(exc, FinancialError) else type(exc).__name__
                ),
                "updated_at": now(),
            }, "$inc": {"reconcile_attempts": 1}},
        )
        if isinstance(exc, FinancialError):
            raise
        raise FinancialError(
            "PAYMENT_STATUS_UNAVAILABLE", "Deposit status could not be checked.", 503,
        ) from exc
    if provider_status in _DEPOSIT_SUCCESS:
        event = ProviderEvent(
            event_id=f"reconcile-deposit:{deposit_id}", event_type="deposit.paid",
            object_id=str(order["provider_order_id"]),
            amount_paise=authoritative.amount_paise, currency=authoritative.currency,
            provider_reference=authoritative.provider_reference,
            occurred_at=datetime_to_iso_utc(getattr(authoritative, "occurred_at", None)), data={},
        )
        result = await _credit_deposit(order, event, actor=actor)
        if order.get("status") == "CREDITED":
            await db.deposit_orders.update_one(
                {"id": deposit_id, "status": "CREDITED"},
                {"$set": {
                    "next_reconcile_at": now() + timedelta(
                        seconds=_runtime_config_int(
                            "DEPOSIT_REFUND_RECONCILE_SECONDS", 86_400, 3600, 604_800,
                        ),
                    ),
                    "reconciled_at": now(), "updated_at": now(),
                }, "$inc": {"reconcile_attempts": 1}},
            )
        return result
    if provider_status == "REFUNDED":
        return await _refund_deposit(
            order, amount_paise=authoritative.amount_paise,
            currency=authoritative.currency,
            provider_reference=authoritative.provider_reference, actor=actor,
        )
    if provider_status in {"FAILED", "EXPIRED"}:
        if order.get("status") == "CREDITED":
            await _flag_financial_review(
                order["user_id"], "DEPOSIT_TERMINAL_CONFLICT", "DEPOSIT", deposit_id,
                f"Provider reported {provider_status.lower()} after deposit credit",
            )
            raise FinancialError(
                "DEPOSIT_TERMINAL_CONFLICT",
                "Provider payment state conflicts with a credited deposit.", 409,
            )
        stored = await _close_unpaid_deposit(deposit_id, provider_status, actor=actor)
        return {"deposit_id": deposit_id, "status": stored.get("status", provider_status)}
    elif provider_status in _DEPOSIT_WAITING:
        if order.get("status") == "CREDITED":
            await _flag_financial_review(
                order["user_id"], "DEPOSIT_TERMINAL_CONFLICT", "DEPOSIT", deposit_id,
                f"Provider regressed credited deposit to {provider_status.lower()}",
            )
            raise FinancialError(
                "DEPOSIT_TERMINAL_CONFLICT",
                "Provider payment state regressed after credit.", 409,
            )
        attempts = int(order.get("reconcile_attempts", 0)) + 1
        await db.deposit_orders.update_one(
            {"id": deposit_id, "status": {"$in": list(DEPOSIT_PENDING)}},
            {"$set": {
                "status": "PENDING", "reconciled_at": now(), "updated_at": now(),
                "next_reconcile_at": now() + _reconciliation_delay(attempts),
            }, "$inc": {"reconcile_attempts": 1}},
        )
    else:
        raise FinancialError(
            "UNKNOWN_PROVIDER_STATUS", "Provider returned an unsupported deposit status.", 409,
        )
    stored = await db.deposit_orders.find_one({"id": deposit_id}, {"_id": 0})
    return {"deposit_id": deposit_id, "status": stored.get("status", provider_status)}


async def reconcile_withdrawal(
    withdrawal_id: str, provider: PaymentProvider, actor: str = "reconciliation-job",
) -> dict[str, Any]:
    withdrawal = await db.withdrawal_requests.find_one({"id": withdrawal_id}, {"_id": 0})
    if not withdrawal:
        raise FinancialError("WITHDRAWAL_NOT_FOUND", "Withdrawal was not found.", 404)
    if withdrawal.get("provider") != provider.name:
        raise FinancialError("PAYMENT_PROVIDER_MISMATCH", "Withdrawal provider does not match.", 409)
    if withdrawal.get("status") in WITHDRAWAL_TERMINAL:
        return {
            "withdrawal_id": withdrawal_id, "status": withdrawal["status"], "terminal": True,
        }
    provider_payout_id = withdrawal.get("provider_payout_id")
    if not provider_payout_id:
        raise FinancialError(
            "PAYOUT_REFERENCE_MISSING",
            "Payout outcome cannot be queried without a provider payout identifier.", 409,
        )
    try:
        authoritative = _require_payout_status(
            await provider.get_payout_status(str(provider_payout_id)),
        )
        provider_status = str(authoritative.status).strip().upper()
    except Exception as exc:  # noqa: BLE001 - do not leak provider internals
        if isinstance(exc, FinancialError):
            raise
        raise FinancialError(
            "PAYOUT_STATUS_UNAVAILABLE", "Payout status could not be checked.", 503,
        ) from exc
    if not _payout_status_is_bound(authoritative, withdrawal):
        await _flag_financial_review(
            withdrawal["user_id"], "PAYOUT_BINDING_MISMATCH", "WITHDRAWAL", withdrawal_id,
            "Provider payout details do not bind to the original withdrawal instruction",
        )
        raise FinancialError(
            "PAYOUT_BINDING_MISMATCH",
            "Provider payout details do not match this withdrawal.", 409,
        )
    if provider_status in _PAYOUT_SUCCESS:
        paid = await mark_withdrawal_paid(
            withdrawal_id, actor, str(authoritative.provider_reference),
        )
        return {"withdrawal_id": withdrawal_id, "status": paid["status"]}
    if provider_status in {"FAILED", "CANCELLED"}:
        async def release(session):
            kwargs = _session_kwargs(session)
            current = await db.withdrawal_requests.find_one(
                {"id": withdrawal_id}, {"_id": 0}, **kwargs,
            )
            if current.get("status") in {"FAILED", "CANCELLED"}:
                return current
            if current.get("status") == "PAID":
                raise FinancialError("WITHDRAWAL_ALREADY_PAID", "Paid withdrawal cannot fail.", 409)
            return await _release_withdrawal(
                current, status=provider_status,
                reason=f"Provider reconciliation confirmed {provider_status.lower()}",
                actor=actor, session=session,
            )

        released = await _run_transaction(release)
        return {"withdrawal_id": withdrawal_id, "status": released["status"]}
    if provider_status in _PAYOUT_WAITING:
        attempts = int(withdrawal.get("reconcile_attempts", 0)) + 1
        await db.withdrawal_requests.update_one(
            {"id": withdrawal_id, "status": {"$in": list(WITHDRAWAL_PROVIDER_PENDING)}},
            {"$set": {
                "status": "PROCESSING", "reconciled_at": now(), "updated_at": now(),
                "next_reconcile_at": now() + _reconciliation_delay(attempts),
            }, "$inc": {"reconcile_attempts": 1}},
        )
        stored = await db.withdrawal_requests.find_one({"id": withdrawal_id}, {"_id": 0})
        return {"withdrawal_id": withdrawal_id, "status": stored.get("status", "PROCESSING")}
    raise FinancialError(
        "UNKNOWN_PROVIDER_STATUS", "Provider returned an unsupported payout status.", 409,
    )


async def reconcile_payment_event(
    internal_event_id: str, provider: PaymentProvider, actor: str,
) -> dict[str, Any]:
    event = await db.provider_webhook_events.find_one({"id": internal_event_id}, {"_id": 0})
    if not event:
        raise FinancialError("PAYMENT_EVENT_NOT_FOUND", "Payment event was not found.", 404)
    if event.get("provider") != provider.name:
        raise FinancialError("PAYMENT_PROVIDER_MISMATCH", "Event provider does not match.", 409)
    if str(event.get("event_type", "")).startswith("deposit."):
        order = await db.deposit_orders.find_one({
            "provider": provider.name, "provider_order_id": event.get("object_id"),
        }, {"_id": 0})
        if not order:
            raise FinancialError("DEPOSIT_NOT_FOUND", "Deposit order was not found.", 404)
        result = await reconcile_deposit(order["id"], provider, actor=actor)
    elif str(event.get("event_type", "")).startswith("withdrawal."):
        withdrawal = await db.withdrawal_requests.find_one({
            "provider": provider.name, "provider_payout_id": event.get("object_id"),
        }, {"_id": 0})
        if not withdrawal:
            raise FinancialError("WITHDRAWAL_NOT_FOUND", "Withdrawal was not found.", 404)
        result = await reconcile_withdrawal(withdrawal["id"], provider, actor=actor)
    else:
        raise FinancialError("EVENT_NOT_RECONCILABLE", "This event type cannot be reconciled.", 409)
    await db.provider_webhook_events.update_one(
        {"id": internal_event_id},
        {"$set": {
            "status": "RECONCILED", "reconciliation_result": result,
            "reconciled_at": now(), "reconciled_by": actor, "lease_until": None,
        }},
    )
    await financial_audit(
        actor, "PAYMENT_EVENT_RECONCILED", "PAYMENT_EVENT", internal_event_id,
        metadata={"result": result}, audit_id=f"payment-event:{internal_event_id}:reconciled",
    )
    return result


async def reconcile_financial_records(
    provider: PaymentProvider, limit: int = 50, actor: str = "reconciliation-job",
) -> dict[str, int]:
    """Run independent bounded queues so deposits cannot starve payouts."""
    cap = max(1, min(int(limit), 100))
    due = now()
    open_deposits = await db.deposit_orders.find({
        "provider": provider.name,
        "status": {"$in": ["CREATED", "PENDING", "RECONCILIATION_REQUIRED"]},
        "$or": [
            {"next_reconcile_at": {"$exists": False}},
            {"next_reconcile_at": {"$lte": due}},
        ],
    }, {"_id": 0, "id": 1, "reconcile_attempts": 1}).sort([
        ("next_reconcile_at", 1), ("created_at", 1),
    ]).limit(cap).to_list(cap)
    credited_deposits = await db.deposit_orders.find({
        "provider": provider.name, "status": "CREDITED",
        "refund_reconcile_until": {"$gte": due},
        "$or": [
            {"next_reconcile_at": {"$exists": False}},
            {"next_reconcile_at": {"$lte": due}},
        ],
    }, {"_id": 0, "id": 1, "reconcile_attempts": 1}).sort([
        ("next_reconcile_at", 1), ("created_at", 1),
    ]).limit(cap).to_list(cap)
    deposits = [*open_deposits, *credited_deposits]
    withdrawals = await db.withdrawal_requests.find({
        "provider": provider.name, "provider_payout_id": {"$type": "string"},
        "withdrawal_mode": AUTOMATIC,
        "status": {"$in": list(WITHDRAWAL_PROVIDER_PENDING)},
        "$or": [
            {"next_reconcile_at": {"$exists": False}},
            {"next_reconcile_at": {"$lte": due}},
        ],
    }, {"_id": 0, "id": 1, "reconcile_attempts": 1}).sort([
        ("next_reconcile_at", 1), ("created_at", 1),
    ]).limit(cap).to_list(cap)
    checked = repaired = review = checked_deposits = checked_withdrawals = 0
    checked_refund_window = 0
    for item, fn in [
        *((row, reconcile_deposit) for row in deposits),
        *((row, reconcile_withdrawal) for row in withdrawals),
    ]:
        checked += 1
        if fn is reconcile_deposit:
            checked_deposits += 1
            if item in credited_deposits:
                checked_refund_window += 1
        else:
            checked_withdrawals += 1
        try:
            result = await fn(item["id"], provider, actor=actor)
            if result.get("status") in {"CREDITED", "REFUNDED", "PAID", "FAILED", "CANCELLED"}:
                repaired += 1
        except FinancialError as exc:
            review += 1
            collection = db.deposit_orders if fn is reconcile_deposit else db.withdrawal_requests
            attempts = int(item.get("reconcile_attempts", 0)) + 1
            await collection.update_one(
                {"id": item["id"]},
                {"$set": {
                    "reconciliation_error_code": exc.code,
                    "next_reconcile_at": now() + _reconciliation_delay(attempts),
                    "updated_at": now(),
                }, "$inc": {"reconcile_attempts": 1}},
            )
    return {
        "checked": checked, "checked_deposits": checked_deposits,
        "checked_withdrawals": checked_withdrawals,
        "checked_refund_window": checked_refund_window,
        "repaired": repaired, "review_required": review,
    }


async def _flag_financial_review(
    user_id: str, action: str, target_type: str, target_id: str, reason: str,
) -> None:
    async def work(session):
        kwargs = _session_kwargs(session)
        await db.users.update_one(
            {"id": user_id}, {"$set": {"financial_status": "REVIEW_REQUIRED"}}, **kwargs,
        )
        await financial_audit(
            "provider-webhook", action, target_type, target_id, reason=reason,
            session=session, audit_id=f"review:{target_type.lower()}:{target_id}:{action.lower()}",
        )
    await _run_transaction(work)


async def process_provider_event(provider: PaymentProvider, event: ProviderEvent, raw_body: bytes) -> dict[str, Any]:
    body_hash = hashlib.sha256(raw_body).hexdigest()
    event_doc = {
        "id": str(uuid.uuid4()), "provider": provider.name, "event_id": event.event_id,
        "event_type": event.event_type, "object_id": event.object_id,
        "amount_paise": event.amount_paise, "currency": event.currency,
        "provider_reference": event.provider_reference, "occurred_at": event.occurred_at,
        "raw_body_sha256": body_hash, "status": "RECEIVED", "attempts": 0,
        "lease_until": None, "claim_id": None,
        "received_at": now(), "processed_at": None,
    }
    try:
        await db.provider_webhook_events.insert_one(event_doc)
    except DuplicateKeyError:
        existing = await db.provider_webhook_events.find_one(
            {"provider": provider.name, "event_id": event.event_id}, {"_id": 0},
        )
        if not existing or existing.get("raw_body_sha256") != body_hash:
            raise FinancialError(
                "WEBHOOK_EVENT_CONFLICT", "Webhook event identity conflicts with an earlier body.", 409,
            )
        if existing.get("status") == "PROCESSED":
            return {"event_id": event.event_id, "duplicate": True, "status": "PROCESSED"}
    claim_time = now()
    claim_id = str(uuid.uuid4())
    claimed = await db.provider_webhook_events.find_one_and_update(
        {
            "provider": provider.name, "event_id": event.event_id,
            "raw_body_sha256": body_hash,
            "$or": [
                {"status": {"$in": ["RECEIVED", "RETRY", "REVIEW_REQUIRED"]}},
                {"status": "PROCESSING", "lease_until": {"$lte": claim_time}},
            ],
        },
        {"$set": {
            "status": "PROCESSING", "claim_id": claim_id,
            "lease_until": claim_time + timedelta(minutes=2),
            "last_attempt_at": claim_time,
        }, "$inc": {"attempts": 1}},
        return_document=ReturnDocument.AFTER,
    )
    if not claimed:
        existing = await db.provider_webhook_events.find_one(
            {"provider": provider.name, "event_id": event.event_id}, {"_id": 0},
        )
        return {
            "event_id": event.event_id, "duplicate": True,
            "status": (existing or {}).get("status", "PROCESSING"),
        }

    ownership = {
        "provider": provider.name, "event_id": event.event_id,
        "raw_body_sha256": body_hash, "status": "PROCESSING",
        "claim_id": claim_id,
    }

    try:
        result: dict[str, Any]
        if event.event_type == "deposit.paid":
            order = await db.deposit_orders.find_one({
                "provider": provider.name, "provider_order_id": event.object_id,
            }, {"_id": 0})
            if not order:
                raise FinancialError("DEPOSIT_NOT_FOUND", "Deposit order was not found.", 404)
            result = await _credit_deposit(order, event)
        elif event.event_type in {"deposit.failed", "deposit.expired"}:
            target = "FAILED" if event.event_type.endswith("failed") else "EXPIRED"
            order = await db.deposit_orders.find_one(
                {"provider": provider.name, "provider_order_id": event.object_id}, {"_id": 0},
            )
            if not order:
                raise FinancialError("DEPOSIT_NOT_FOUND", "Deposit order was not found.", 404)
            if (
                event.amount_paise != int(order["amount_paise"])
                or event.currency != order.get("currency", CURRENCY)
            ):
                await _route_deposit_event_mismatch(order, event)
                raise FinancialError(
                    "PAYMENT_MISMATCH",
                    "Provider terminal event amount or currency does not match the deposit.",
                    409,
                )
            stored = await _close_unpaid_deposit(order["id"], target)
            result = {"status": stored.get("status", target)}
        elif event.event_type == "deposit.refunded":
            order = await db.deposit_orders.find_one({
                "provider": provider.name, "provider_order_id": event.object_id,
            }, {"_id": 0})
            if not order:
                raise FinancialError("DEPOSIT_NOT_FOUND", "Deposit order was not found.", 404)
            result = await _refund_deposit(
                order, amount_paise=event.amount_paise, currency=event.currency,
                provider_reference=event.provider_reference,
            )
        elif event.event_type in {"withdrawal.processing", "withdrawal.paid", "withdrawal.failed"}:
            withdrawal = await db.withdrawal_requests.find_one({
                "provider": provider.name, "provider_payout_id": event.object_id,
            }, {"_id": 0})
            if not withdrawal:
                raise FinancialError("WITHDRAWAL_NOT_FOUND", "Withdrawal was not found.", 404)
            if (
                event.amount_paise != int(withdrawal["amount_paise"])
                or event.currency != CURRENCY
            ):
                raise FinancialError("PAYMENT_MISMATCH", "Provider payout amount does not match.", 409)
            if event.event_type == "withdrawal.processing":
                await db.withdrawal_requests.update_one(
                    {"id": withdrawal["id"], "status": {"$in": list(WITHDRAWAL_PROVIDER_PENDING)}},
                    {"$set": {"status": "PROCESSING", "updated_at": now()}},
                )
                current = await db.withdrawal_requests.find_one(
                    {"id": withdrawal["id"]}, {"_id": 0},
                )
                result = {"status": (current or {}).get("status", "PROCESSING")}
            elif event.event_type == "withdrawal.paid":
                if withdrawal.get("status") in {"FAILED", "CANCELLED", "REJECTED"}:
                    await _flag_financial_review(
                        withdrawal["user_id"], "PAYOUT_TERMINAL_CONFLICT",
                        "WITHDRAWAL", withdrawal["id"],
                        f"Provider reported paid after {withdrawal['status']}",
                    )
                    raise FinancialError(
                        "PAYOUT_TERMINAL_CONFLICT",
                        "Provider payout state conflicts with a terminal withdrawal.", 409,
                    )
                reference = event.provider_reference or event.object_id
                paid = await mark_withdrawal_paid(withdrawal["id"], "provider-webhook", reference)
                result = {"status": paid["status"]}
            else:
                if withdrawal.get("status") == "PAID":
                    await _flag_financial_review(
                        withdrawal["user_id"], "PAYOUT_TERMINAL_CONFLICT",
                        "WITHDRAWAL", withdrawal["id"],
                        "Provider reported failed after paid",
                    )
                    raise FinancialError(
                        "PAYOUT_TERMINAL_CONFLICT",
                        "Provider payout state conflicts with a paid withdrawal.", 409,
                    )
                async def release(session):
                    kwargs = _session_kwargs(session)
                    current = await db.withdrawal_requests.find_one(
                        {"id": withdrawal["id"]}, {"_id": 0}, **kwargs,
                    )
                    if current.get("status") == "FAILED":
                        return current
                    if current.get("status") == "PAID":
                        raise FinancialError("WITHDRAWAL_ALREADY_PAID", "Paid withdrawal cannot fail.", 409)
                    return await _release_withdrawal(
                        current, status="FAILED", reason="Provider confirmed payout failure",
                        actor="provider-webhook", session=session,
                    )
                failed = await _run_transaction(release)
                result = {"status": failed["status"]}
        else:
            result = {"status": "IGNORED", "event_type": event.event_type}
        completed = await db.provider_webhook_events.update_one(
            ownership,
            {"$set": {"status": "PROCESSED", "result": result,
                      "processed_at": now(), "lease_until": None,
                      "claim_id": None, "error_code": None}},
        )
        if not completed.matched_count:
            current = await db.provider_webhook_events.find_one(
                {"provider": provider.name, "event_id": event.event_id}, {"_id": 0},
            )
            return {
                "event_id": event.event_id, "duplicate": True,
                "status": (current or {}).get("status", "PROCESSING"),
            }
        return {"event_id": event.event_id, "duplicate": False, **result}
    except FinancialError as exc:
        await db.provider_webhook_events.update_one(
            ownership,
            {"$set": {"status": "REVIEW_REQUIRED", "error_code": exc.code,
                      "processed_at": now(), "lease_until": None, "claim_id": None}},
        )
        raise
    except Exception as exc:  # noqa: BLE001 - preserve retry without leaking internals
        await db.provider_webhook_events.update_one(
            ownership,
            {"$set": {"status": "RETRY", "error_code": type(exc).__name__,
                      "processed_at": now(), "lease_until": None, "claim_id": None}},
        )
        raise


async def financial_audit(
    actor_id: str, action: str, target_type: str, target_id: str,
    reason: Optional[str] = None, metadata: Optional[Mapping[str, Any]] = None,
    *, session=None, audit_id: Optional[str] = None,
) -> None:
    kwargs = _session_kwargs(session)
    doc = {
        "id": audit_id or str(uuid.uuid4()), "actor_id": actor_id, "action": action,
        "target_type": target_type, "target_id": target_id,
        "reason": reason, "metadata": dict(metadata or {}), "created_at": now(),
    }
    if audit_id:
        await db.financial_audit.update_one(
            {"id": audit_id}, {"$setOnInsert": doc}, upsert=True, **kwargs,
        )
    else:
        await db.financial_audit.insert_one(doc, **kwargs)
