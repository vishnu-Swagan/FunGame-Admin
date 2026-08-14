"""Safely retire the two legacy MongoDB demo accounts after migration.

This module is intentionally a *manual maintenance tool*, not an API route and
not a startup task.  Running it without the deletion guards only produces a
JSON inventory.  It never creates accounts and it never touches Supabase.

The only eligible identities are the exact legacy seed addresses below.  The
tool removes data owned by those exact MongoDB ``users.id`` values, such as a
personal game history or wallet ledger.  It deliberately preserves shared
round outcomes, game configuration, audit history and any records that merely
reference a demo administrator.  If it finds one of those references it stops
before deletion so it cannot orphan real-user or shared records.

After the migration archive has been verified, a human can *explicitly* opt in
to deletion by setting all three values for the one command invocation::

    MIGRATION_ARCHIVE_CONFIRMED=yes \\
    DEMO_ACCOUNT_RETIREMENT_MODE=delete \\
    DEMO_ACCOUNT_RETIREMENT_CONFIRM=DELETE_ONLY_LEGACY_FUNGAME_DEMOS \\
    python backend/retire_legacy_demo_accounts.py

Even then the script performs its inventory and validation immediately before
it deletes anything.  Do not add a web route for this tool.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Mapping

from db import db


@dataclass(frozen=True)
class DemoTargetSpec:
    """The immutable fingerprint for a legacy demo identity."""

    email: str
    role: str


# Keep this list deliberately small.  This is not a generic account deletion
# utility and must never grow into one.
DEMO_TARGETS: tuple[DemoTargetSpec, ...] = (
    DemoTargetSpec("admin@fungame.app", "ADMIN"),
    DemoTargetSpec("player@fungame.app", "PLAYER"),
)

# These collections contain independently-owned records keyed directly by the
# legacy users.id field.  They can be safely removed without changing a shared
# game table, a global round outcome, another user's wallet, or a game config.
DIRECT_ID_OWNED_COLLECTIONS: dict[str, tuple[str, ...]] = {
    "aviator_bets": ("user_id",),
    "blackjack_games": ("user_id",),
    "chip_requests": ("user_id",),
    "chip_transactions": ("user_id",),
    "exclusions": ("user_id",),
    "game_rounds": ("user_id",),
    "live_bets": ("user_id",),
    "notifications": ("user_id",),
    "player_attribution": ("user_id",),
    "player_days": ("user_id",),
    "player_limits": ("user_id",),
    "points_transactions": ("user_id",),
    "roulette_bets": ("user_id",),
    "support_messages": ("user_id",),
}

# Signup requests pre-date an account id, so their only safe ownership key is
# the exact seed email.  It is still limited to the two values in DEMO_TARGETS.
DIRECT_EMAIL_OWNED_COLLECTIONS: dict[str, tuple[str, ...]] = {
    "signup_requests": ("email",),
}

# These fields can point at a demo account while the document itself belongs to
# another actor, a shared configuration record, or an audit trail.  They are
# *never* deleted by this script.  Any hit blocks deletion and is reported for
# manual review, preventing dangling references in live data.
REVIEW_ONLY_ID_REFERENCES: dict[str, tuple[str, ...]] = {
    "admin_audit": ("actor_id", "target_id"),
    "announcements": ("created_by",),
    "chip_requests": ("resolved_by",),
    "distributors": ("user_id", "created_by"),
    "payout_ledger": ("created_by",),
    "payouts": ("created_by", "approved_by", "paid_by", "rejected_by"),
    "signup_requests": ("reviewed_by",),
    "users": ("operator_created_by",),
}

# A surprising collection can conceal a relationship that this one-time tool
# does not understand.  Failing closed is safer than guessing at its schema.
KNOWN_COLLECTIONS = frozenset({
    "admin_audit",
    "announcements",
    "aviator_bets",
    "aviator_rounds",
    "blackjack_games",
    "chip_requests",
    "chip_transactions",
    "commission_ledger",
    "commission_runs",
    "compliance_config",
    "distributor_days",
    "distributor_rates",
    "distributors",
    "exclusions",
    "game_rounds",
    "game_settlement_nonces",
    "games",
    "live_bets",
    "live_outcomes",
    "migration_export_nonces",
    "notifications",
    "payout_ledger",
    "payouts",
    "player_attribution",
    "player_days",
    "player_limits",
    "points_transactions",
    "roulette_bets",
    "roulette_rounds",
    "signup_requests",
    "support_messages",
    "system_config",
    "system_locks",
    "users",
})

_DELETE_MODE_ENV = "DEMO_ACCOUNT_RETIREMENT_MODE"
_DELETE_CONFIRM_ENV = "DEMO_ACCOUNT_RETIREMENT_CONFIRM"
_MIGRATION_CONFIRMED_ENV = "MIGRATION_ARCHIVE_CONFIRMED"
_DELETE_CONFIRMATION = "DELETE_ONLY_LEGACY_FUNGAME_DEMOS"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _truthy(value: str | None) -> bool:
    return (value or "").strip().lower() in {"1", "true", "yes", "on"}


def deletion_guard_error(environment: Mapping[str, str] | None = None) -> str | None:
    """Return why destructive mode is unavailable, or ``None`` when armed.

    Three independent acknowledgements make a pasted shell command much less
    likely to turn an inventory run into an unintended production deletion.
    """

    env = environment if environment is not None else os.environ
    if (env.get(_DELETE_MODE_ENV) or "").strip().lower() != "delete":
        return f"set {_DELETE_MODE_ENV}=delete to request deletion"
    if env.get(_DELETE_CONFIRM_ENV) != _DELETE_CONFIRMATION:
        return f"set {_DELETE_CONFIRM_ENV}={_DELETE_CONFIRMATION} to confirm the exact demo targets"
    if not _truthy(env.get(_MIGRATION_CONFIRMED_ENV)):
        return f"set {_MIGRATION_CONFIRMED_ENV}=yes only after the migration archive has been verified"
    return None


def _target_summary(target: dict[str, str]) -> dict[str, str]:
    """Expose only the non-sensitive identity data needed in an operator plan."""

    return {
        "email": target["email"],
        "role": target["role"],
        "id": target["id"],
    }


async def _find_targets(database: Any) -> tuple[list[dict[str, str]], list[str]]:
    """Resolve exact target rows and fail closed on any ambiguous identity."""

    targets: list[dict[str, str]] = []
    blocking_errors: list[str] = []
    for spec in DEMO_TARGETS:
        rows = await database.users.find(
            {"email": spec.email},
            {"_id": 0, "id": 1, "email": 1, "role": 1},
        ).to_list(2)
        if len(rows) != 1:
            noun = "no" if not rows else "multiple"
            blocking_errors.append(
                f"expected exactly one {spec.email} user row, found {noun}"
            )
            continue
        row = rows[0]
        identifier = row.get("id")
        if not isinstance(identifier, str) or not identifier.strip():
            blocking_errors.append(f"{spec.email} has no usable users.id")
            continue
        if row.get("role") != spec.role:
            blocking_errors.append(
                f"{spec.email} has role {row.get('role')!r}, expected {spec.role!r}"
            )
            continue
        targets.append({"email": spec.email, "role": spec.role, "id": identifier})

    identifiers = [target["id"] for target in targets]
    if len(identifiers) != len(set(identifiers)):
        blocking_errors.append("the two demo email rows resolve to the same users.id")
    return targets, blocking_errors


def _id_filter(field: str, target_ids: list[str]) -> dict[str, Any]:
    return {field: {"$in": target_ids}}


def _email_filter(field: str, target_emails: list[str]) -> dict[str, Any]:
    return {field: {"$in": target_emails}}


async def _owned_counts(database: Any, target_ids: list[str], target_emails: list[str]) -> dict[str, int]:
    counts: dict[str, int] = {}
    if target_ids:
        for collection, fields in DIRECT_ID_OWNED_COLLECTIONS.items():
            for field in fields:
                key = f"{collection}.{field}"
                counts[key] = await database[collection].count_documents(_id_filter(field, target_ids))
    if target_emails:
        for collection, fields in DIRECT_EMAIL_OWNED_COLLECTIONS.items():
            for field in fields:
                key = f"{collection}.{field}"
                counts[key] = await database[collection].count_documents(_email_filter(field, target_emails))
    return counts


async def _preserved_reference_counts(
    database: Any,
    target_ids: list[str],
    target_emails: list[str],
) -> dict[str, int]:
    """Find references that are deliberately preserved and require review.

    For a child record that will itself be removed because it belongs to a demo
    player, we do not treat the ``resolved_by`` / ``reviewed_by`` field as a
    shared-reference blocker.  It is going away with its owner anyway.
    """

    counts: dict[str, int] = {}
    if not target_ids:
        return counts
    for collection, fields in REVIEW_ONLY_ID_REFERENCES.items():
        for field in fields:
            query: dict[str, Any] = _id_filter(field, target_ids)
            if collection == "chip_requests":
                query["user_id"] = {"$nin": target_ids}
            elif collection == "signup_requests":
                query["email"] = {"$nin": target_emails}
            elif collection == "users":
                query["id"] = {"$nin": target_ids}
            count = await database[collection].count_documents(query)
            if count:
                counts[f"{collection}.{field}"] = count
    return counts


async def discover_retirement(database: Any = db) -> dict[str, Any]:
    """Build a non-mutating, JSON-safe retirement plan for human inspection."""

    targets, blocking_errors = await _find_targets(database)
    target_ids = [target["id"] for target in targets]
    target_emails = [target["email"] for target in targets]
    owned_counts = await _owned_counts(database, target_ids, target_emails)
    preserved_references = await _preserved_reference_counts(database, target_ids, target_emails)
    collection_names = set(await database.list_collection_names())
    unexpected_collections = sorted(collection_names - KNOWN_COLLECTIONS)
    if unexpected_collections:
        blocking_errors.append(
            "unexpected collections require schema review before destructive mode: "
            + ", ".join(unexpected_collections)
        )
    if preserved_references:
        blocking_errors.append(
            "shared/audit references to a demo identity require manual review before deletion"
        )

    target_fingerprint = hashlib.sha256(
        "|".join(f"{target['email']}:{target['id']}" for target in targets).encode("utf-8")
    ).hexdigest() if targets else None
    return {
        "generated_at": _now(),
        "targets": [_target_summary(target) for target in targets],
        "target_fingerprint": target_fingerprint,
        "owned_document_counts": owned_counts,
        "preserved_reference_counts": preserved_references,
        "unexpected_collections": unexpected_collections,
        "blocking_errors": blocking_errors,
        "can_delete": not blocking_errors and len(targets) == len(DEMO_TARGETS),
    }


async def _delete_owned_documents(
    database: Any,
    target_ids: list[str],
    target_emails: list[str],
) -> dict[str, int]:
    """Delete only rows whose ownership key is exactly one of the target ids."""

    deleted: dict[str, int] = {}
    for collection, fields in DIRECT_ID_OWNED_COLLECTIONS.items():
        for field in fields:
            result = await database[collection].delete_many(_id_filter(field, target_ids))
            deleted[f"{collection}.{field}"] = result.deleted_count
    for collection, fields in DIRECT_EMAIL_OWNED_COLLECTIONS.items():
        for field in fields:
            result = await database[collection].delete_many(_email_filter(field, target_emails))
            deleted[f"{collection}.{field}"] = result.deleted_count
    return deleted


async def _delete_exact_users(database: Any, targets: list[dict[str, str]]) -> int:
    """Delete only the validated role/email/id triple for each legacy account."""

    exact_rows = [
        {"id": target["id"], "email": target["email"], "role": target["role"]}
        for target in targets
    ]
    result = await database.users.delete_many({"$or": exact_rows})
    return result.deleted_count


async def retire_demo_accounts(
    database: Any = db,
    environment: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    """Inventory by default; delete only when all explicit guards are present."""

    plan = await discover_retirement(database)
    env = environment if environment is not None else os.environ
    deletion_requested = (env.get(_DELETE_MODE_ENV) or "").strip().lower() == "delete"
    guard_error = deletion_guard_error(env)
    if guard_error:
        # No deletion mode means a normal successful inventory.  A malformed
        # destructive invocation is instead a failure: shell automation must
        # never interpret a missing confirmation as a completed retirement.
        mode = "blocked" if deletion_requested else "dry-run"
        result = (
            "No records were deleted because the destructive confirmation was incomplete."
            if deletion_requested else "No records were deleted."
        )
        return {
            **plan,
            "mode": mode,
            "result": result,
            "deletion_guard": guard_error,
        }
    if not plan["can_delete"]:
        return {
            **plan,
            "mode": "blocked",
            "result": "No records were deleted because the preflight safety checks did not pass.",
        }

    targets = plan["targets"]
    target_ids = [target["id"] for target in targets]
    target_emails = [target["email"] for target in targets]
    deleted = await _delete_owned_documents(database, target_ids, target_emails)
    deleted["users"] = await _delete_exact_users(database, targets)

    # A successful run must leave no direct child rows and no exact seed users.
    remaining_children = await _owned_counts(database, target_ids, target_emails)
    remaining_users = await database.users.count_documents({
        "$or": [
            {"id": target["id"], "email": target["email"], "role": target["role"]}
            for target in targets
        ],
    })
    if any(remaining_children.values()) or remaining_users:
        # The command has already made only scoped, idempotent changes.  It
        # reports an incomplete state loudly instead of claiming success.
        return {
            **plan,
            "mode": "incomplete",
            "result": "Scoped deletion did not fully verify; do not recreate demo accounts. Review the report before rerunning.",
            "deleted_document_counts": deleted,
            "remaining_owned_document_counts": remaining_children,
            "remaining_exact_users": remaining_users,
        }

    return {
        **plan,
        "mode": "deleted",
        "result": "Only the validated legacy demo accounts and their directly-owned records were deleted.",
        "deleted_document_counts": deleted,
        "remaining_owned_document_counts": remaining_children,
        "remaining_exact_users": remaining_users,
    }


async def _main() -> int:
    report = await retire_demo_accounts()
    print(json.dumps(report, indent=2, sort_keys=True))
    # A dry run is successful.  A requested deletion that was blocked/incomplete
    # is non-zero so a deployment shell does not mistake it for a completed cutover.
    return 0 if report["mode"] in {"dry-run", "deleted"} else 2


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_main()))
