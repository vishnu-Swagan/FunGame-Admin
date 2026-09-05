"""Source-aware bridge between gameplay and the financial wallet.

This module is certification-ready but dormant. It can move wallet source
buckets only when the compile-time readiness assertion and the explicit runtime
integration flag are both true. The current repository deliberately leaves the
compile-time assertion false.
"""
from __future__ import annotations

import os
import hashlib
from typing import Any, Iterable, Mapping

from db import db
import financial_wallet as finance
import ledger
from pymongo.errors import DuplicateKeyError


SOURCE_POLICY = "BONUS_FIRST_THEN_CASH"
SOURCE_POLICY_VERSION = "game-wallet-source-v1"


def integration_enabled() -> bool:
    return bool(
        finance.GAME_WALLET_INTEGRATION_READY
        and finance.financial_status().get("ready", False)
        and finance.env_true("REAL_MONEY_ENABLED")
        and finance.env_true("FINANCIAL_GAME_WALLET_INTEGRATED")
    )


def _session_kwargs(session) -> dict[str, Any]:
    return {"session": session} if session is not None else {}


def _require_transaction(session) -> None:
    if session is None and not (
        str(os.environ.get("APP_ENV", "")).lower() == "test"
        and finance.env_true("FINANCIAL_ALLOW_NON_TRANSACTIONAL_TESTS")
    ):
        raise finance.FinancialError(
            "GAME_WALLET_TRANSACTION_REQUIRED",
            "Gameplay wallet movement requires a MongoDB transaction.",
            503,
        )


async def _assert_wallet_mirror(
    user_id: str, account: Mapping[str, Any], *, session=None,
) -> None:
    kwargs = _session_kwargs(session)
    user = await db.users.find_one(
        {"id": user_id}, {"_id": 0, "chip_balance": 1}, **kwargs,
    )
    expected = (
        int(account.get("available_cash_chips", 0))
        + int(account.get("available_bonus_chips", 0))
    )
    if not user or int(user.get("chip_balance", 0)) != expected:
        raise finance.FinancialError(
            "GAME_WALLET_MIRROR_MISMATCH",
            "The game balance and source wallet require reconciliation before play.",
            503,
        )


def _public_allocation(
    cash: int, bonus: int, operation_id: str | None = None,
    *, bonus_lots: Iterable[Mapping[str, Any]] | None = None,
) -> dict[str, Any]:
    return {
        "policy": SOURCE_POLICY,
        "policy_version": SOURCE_POLICY_VERSION,
        "cash_chips": int(cash),
        "bonus_chips": int(bonus),
        "bonus_lots": [dict(item) for item in (bonus_lots or [])],
        "operation_id": operation_id,
    }


async def _stake_allocations(
    user_id: str, game: str | None, source_refs: Iterable[str], session=None,
    *, aggregate_owners: bool = False,
) -> dict[str, int]:
    refs = sorted({str(value) for value in source_refs if value})
    if not refs:
        raise finance.FinancialError(
            "WALLET_SOURCE_UNRESOLVED",
            "The originating stake could not be identified safely.",
            409,
        )
    query: dict[str, Any] = {"kind": ledger.STAKE, "ref": {"$in": refs}}
    if not aggregate_owners:
        query["user_id"] = user_id
    if game:
        query["game"] = game
    rows = await db.chip_transactions.find(
        query, {"_id": 0, "id": 1, "user_id": 1, "ref": 1, "amount": 1,
                "funding_allocation": 1},
        **_session_kwargs(session),
    ).to_list(length=None)
    if len(rows) != len(refs) or len({str(row.get("ref")) for row in rows}) != len(rows):
        raise finance.FinancialError(
            "WALLET_SOURCE_AMBIGUOUS",
            "Each originating reference must identify exactly one certified stake.",
            409,
        )
    for row in rows:
        allocation = row.get("funding_allocation") or {}
        row_cash = int(allocation.get("cash_chips", -1))
        row_bonus = int(allocation.get("bonus_chips", -1))
        if (
            row_cash < 0 or row_bonus < 0
            or row_cash + row_bonus != int(row.get("amount", -1))
            or allocation.get("policy") != SOURCE_POLICY
            or allocation.get("policy_version") != SOURCE_POLICY_VERSION
            or not allocation.get("operation_id")
        ):
            raise finance.FinancialError(
                "WALLET_SOURCE_UNCERTIFIED",
                "An originating stake has invalid source-allocation evidence.",
                409,
            )
    cash = sum(int(row["funding_allocation"]["cash_chips"]) for row in rows)
    bonus = sum(int(row["funding_allocation"]["bonus_chips"]) for row in rows)
    lots_by_id: dict[str, dict[str, Any]] = {}
    for row in rows:
        for raw_lot in (row.get("funding_allocation") or {}).get("bonus_lots", []):
            lot_id = str(raw_lot.get("lot_id") or "")
            chips = int(raw_lot.get("chips", 0))
            if not lot_id or chips <= 0:
                continue
            if lot_id not in lots_by_id:
                lots_by_id[lot_id] = {**dict(raw_lot), "lot_id": lot_id, "chips": 0}
            lots_by_id[lot_id]["chips"] += chips
    found_refs = {str(row.get("ref")) for row in rows}
    if found_refs != set(refs) or cash + bonus <= 0:
        raise finance.FinancialError(
            "WALLET_SOURCE_UNRESOLVED",
            "The originating stake has no certified funding allocation.",
            409,
        )
    bonus_lots = [lots_by_id[key] for key in sorted(lots_by_id)]
    if bonus and sum(int(item["chips"]) for item in bonus_lots) != bonus:
        raise finance.FinancialError(
            "BONUS_LOT_SOURCE_UNRESOLVED",
            "The originating stake has incomplete restricted bonus provenance.",
            409,
        )
    return {
        "cash_chips": cash, "bonus_chips": bonus, "bonus_lots": bonus_lots,
        "source_transactions": [{
            "id": str(row["id"]), "user_id": str(row["user_id"]),
            "ref": str(row["ref"]), "amount": int(row["amount"]),
        } for row in sorted(rows, key=lambda item: str(item["id"]))],
    }


async def _reserve_source_consumptions(
    *, credited_user_id: str, credit_kind: str, event_id: str,
    game: str | None, source_transactions: Iterable[Mapping[str, Any]], session=None,
) -> None:
    """Allow exactly one monetary terminal outcome per authoritative stake."""
    kwargs = _session_kwargs(session)
    for source in source_transactions:
        transaction_id = str(source["id"])
        digest = hashlib.sha256(transaction_id.encode("utf-8")).hexdigest()[:40]
        doc = {
            "_id": f"wallet-source-consumption:{digest}",
            "id": f"wallet-source-consumption:{digest}",
            "stake_transaction_id": transaction_id,
            "stake_user_id": source.get("user_id"),
            "stake_ref": source.get("ref"),
            "credited_user_id": credited_user_id,
            "credit_kind": credit_kind,
            "credit_event_id": event_id,
            "game": game,
            "created_at": finance.now(),
        }
        try:
            await db.wallet_source_consumptions.insert_one(doc, **kwargs)
        except DuplicateKeyError as exc:
            raise finance.FinancialError(
                "WALLET_SOURCE_ALREADY_CONSUMED",
                "This authoritative stake already has a monetary outcome.",
                409,
            ) from exc


def _payout_bonus_lot_changes(
    *, event_id: str, user_id: str, bonus_chips: int,
    source_lots: Iterable[Mapping[str, Any]],
) -> list[dict[str, Any]]:
    """Create derived lots while retaining every controlling grant origin."""
    sources = sorted(
        (dict(item) for item in source_lots if int(item.get("chips", 0)) > 0),
        key=lambda item: str(item.get("lot_id")),
    )
    source_total = sum(int(item["chips"]) for item in sources)
    if bonus_chips <= 0:
        return []
    if source_total <= 0:
        raise finance.FinancialError(
            "BONUS_LOT_SOURCE_UNRESOLVED",
            "A restricted payout has no originating bonus grant.",
            409,
        )
    awarded = [int(bonus_chips) * int(item["chips"]) // source_total for item in sources]
    remainder = int(bonus_chips) - sum(awarded)
    if remainder:
        # Stable first-lot remainder is disclosed in wallet operation metadata.
        awarded[0] += remainder
    changes: list[dict[str, Any]] = []
    for source, chips in zip(sources, awarded):
        if chips <= 0:
            continue
        parent_id = str(source["lot_id"])
        derived_source_key = f"game-payout-bonus:{event_id}:{parent_id}"
        changes.append({
            "lot_id": finance._bonus_lot_id(derived_source_key),
            "source_key": derived_source_key, "delta_chips": chips, "create": True,
            "source_type": "GAME_PAYOUT_RESTRICTED", "source_id": event_id,
            "parent_lot_id": parent_id,
            "mission_id": source.get("mission_id"),
            "campaign_id": source.get("campaign_id"),
            "campaign_version": source.get("campaign_version"),
            "referral_claim_id": source.get("referral_claim_id"),
            "terms_version": source.get("terms_version"),
            "restriction_reason": source.get("restriction_reason") or
                "Payout funded by promotional chips remains non-withdrawable.",
            "expires_at": source.get("expires_at"),
            "spend_priority": 0 if source.get("expires_at") else 1,
        })
    return changes


class SourceWalletAdapter:
    async def debit(
        self, *, event_id: str, user_id: str, amount: int, kind: str,
        ref: str | None, game: str | None, session=None,
    ) -> Mapping[str, Any] | None:
        if not integration_enabled() or kind != ledger.STAKE:
            return None
        _require_transaction(session)
        account = await finance._ensure_wallet_account(user_id, session=session)
        await _assert_wallet_mirror(user_id, account, session=session)
        bonus = min(int(amount), int(account.get("available_bonus_chips", 0)))
        cash = int(amount) - bonus
        if game == "rummy" and bonus:
            raise finance.FinancialError(
                "RESTRICTED_BONUS_P2P_NOT_ALLOWED",
                "Restricted bonus chips cannot fund peer-to-peer Rummy stakes.",
                409,
            )
        if cash > int(account.get("available_cash_chips", 0)):
            raise finance.FinancialError(
                "INSUFFICIENT_GAME_WALLET_CHIPS",
                "The source-separated game wallet has insufficient chips.",
                409,
            )
        deltas = {}
        if bonus:
            deltas["available_bonus_chips"] = -bonus
        if cash:
            deltas["available_cash_chips"] = -cash
        bonus_lots = await finance.allocate_bonus_lots(
            user_id, bonus, session=session,
        ) if bonus else []
        movement = await finance.apply_wallet_movement(
            user_id=user_id, kind="GAME_STAKE", source_key=f"game-stake:{event_id}",
            idempotency_key=f"game-stake:{event_id}", deltas=deltas,
            mirror_user_delta=0,
            metadata={
                "ledger_event_id": event_id, "game": game, "game_ref": ref,
                "source_policy": SOURCE_POLICY, "source_policy_version": SOURCE_POLICY_VERSION,
                "cash_chips": cash, "bonus_chips": bonus,
            },
            bonus_lot_changes=[{
                "lot_id": item["lot_id"], "delta_chips": -int(item["chips"]),
            } for item in bonus_lots],
            session=session,
        )
        return _public_allocation(
            cash, bonus, movement["operation_id"], bonus_lots=bonus_lots,
        )

    async def credit(
        self, *, event_id: str, user_id: str, amount: int, kind: str,
        ref: str | None, source_refs: Iterable[str], game: str | None, session=None,
    ) -> Mapping[str, Any] | None:
        if not integration_enabled() or kind not in {ledger.PAYOUT, ledger.REFUND, ledger.BONUS}:
            return None
        _require_transaction(session)
        account = await finance._ensure_wallet_account(user_id, session=session)
        await _assert_wallet_mirror(user_id, account, session=session)
        if kind == ledger.BONUS:
            cash, bonus = 0, int(amount)
            operation_kind = "GAME_BONUS_CREDIT"
            bonus_lot_changes = None
            source_bonus_lots: list[dict[str, Any]] = []
        else:
            aggregate_owners = bool(kind == ledger.PAYOUT and game == "rummy")
            sources = await _stake_allocations(
                user_id, game, source_refs, session=session,
                aggregate_owners=aggregate_owners,
            )
            source_total = sources["cash_chips"] + sources["bonus_chips"]
            source_bonus_lots = list(sources.get("bonus_lots", []))
            await _reserve_source_consumptions(
                credited_user_id=user_id, credit_kind=kind, event_id=event_id,
                game=game, source_transactions=sources["source_transactions"],
                session=session,
            )
            if kind == ledger.REFUND:
                if int(amount) != source_total:
                    raise finance.FinancialError(
                        "REFUND_SOURCE_MISMATCH",
                        "A refund must match the exact selected stake sources.",
                        409,
                    )
                cash, bonus = sources["cash_chips"], sources["bonus_chips"]
                operation_kind = "GAME_STAKE_REFUND"
                bonus_lot_changes = [{
                    "lot_id": item["lot_id"], "delta_chips": int(item["chips"]),
                } for item in source_bonus_lots]
            else:
                if aggregate_owners and source_total != int(amount):
                    raise finance.FinancialError(
                        "PAYOUT_SOURCE_MISMATCH",
                        "The Rummy payout does not match the certified source pot.",
                        409,
                    )
                # Cash receives floor(proportion). Any indivisible remainder
                # stays restricted in bonus, the safer deterministic rounding.
                cash = int(amount) * sources["cash_chips"] // source_total
                bonus = int(amount) - cash
                operation_kind = "GAME_PAYOUT"
                bonus_lot_changes = _payout_bonus_lot_changes(
                    event_id=event_id, user_id=user_id, bonus_chips=bonus,
                    source_lots=source_bonus_lots,
                )
        deltas = {}
        if cash:
            deltas["available_cash_chips"] = cash
        if bonus:
            deltas["available_bonus_chips"] = bonus
        movement = await finance.apply_wallet_movement(
            user_id=user_id, kind=operation_kind,
            source_key=f"{operation_kind.lower()}:{event_id}",
            idempotency_key=f"{operation_kind.lower()}:{event_id}", deltas=deltas,
            mirror_user_delta=0,
            metadata={
                "ledger_event_id": event_id, "game": game, "game_ref": ref,
                "source_refs": sorted({str(value) for value in source_refs if value}),
                "source_policy": SOURCE_POLICY, "source_policy_version": SOURCE_POLICY_VERSION,
                "rounding": "CASH_FLOOR_REMAINDER_TO_RESTRICTED_BONUS",
                "aggregate_source_owners": bool(kind == ledger.PAYOUT and game == "rummy"),
                "bonus_lot_rounding": "PROPORTIONAL_FLOOR_REMAINDER_TO_EARLIEST_LOT",
                "cash_chips": cash, "bonus_chips": bonus,
            },
            bonus_lot_changes=bonus_lot_changes,
            session=session,
        )
        credited_lots = [{
            "lot_id": item["lot_id"], "chips": int(item["delta_chips"]),
            **{key: value for key, value in item.items() if key not in {
                "lot_id", "delta_chips", "create", "source_key",
            }},
        } for item in (bonus_lot_changes or []) if int(item["delta_chips"]) > 0]
        return _public_allocation(
            cash, bonus, movement["operation_id"], bonus_lots=credited_lots,
        )


ADAPTER = SourceWalletAdapter()


def install() -> None:
    ledger.register_source_wallet_adapter(ADAPTER)
