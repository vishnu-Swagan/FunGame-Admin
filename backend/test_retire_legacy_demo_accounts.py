"""Focused checks for the guarded legacy demo-account retirement tool.

Run directly with ``python backend/test_retire_legacy_demo_accounts.py``.
It uses an in-memory Mongo implementation and never contacts the configured
production database.
"""

import asyncio
import os
import sys
import types

from mongomock_motor import AsyncMongoMockClient

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

client = AsyncMongoMockClient()
sys.modules["db"] = types.SimpleNamespace(db=client["retire_seed_import_test"])

import retire_legacy_demo_accounts as retirement
import seed


PASS = FAIL = 0


def check(name, condition):
    global PASS, FAIL
    print(("  PASS  " if condition else "  FAIL  ") + name)
    if condition:
        PASS += 1
    else:
        FAIL += 1


async def make_fixture(name: str):
    database = client[name]
    await database.users.insert_many([
        {"id": "demo-admin", "email": "admin@fungame.app", "role": "ADMIN"},
        {"id": "demo-player", "email": "player@fungame.app", "role": "PLAYER"},
        {"id": "real-player", "email": "real@example.test", "role": "PLAYER"},
    ])
    for collection, fields in retirement.DIRECT_ID_OWNED_COLLECTIONS.items():
        for field in fields:
            await database[collection].insert_many([
                {"id": f"demo-{collection}-{field}", field: "demo-player"},
                {"id": f"real-{collection}-{field}", field: "real-player"},
            ])
    for collection, fields in retirement.DIRECT_EMAIL_OWNED_COLLECTIONS.items():
        for field in fields:
            await database[collection].insert_many([
                {"id": f"demo-{collection}-{field}", field: "player@fungame.app"},
                {"id": f"real-{collection}-{field}", field: "real@example.test"},
            ])
    # Global outcomes/configuration are shared and must never be touched.
    await database.live_outcomes.insert_one({"slug": "triple-fun", "round_number": 7})
    await database.games.insert_one({"slug": "triple-fun", "name": "Triple Fun"})
    return database


def delete_environment():
    return {
        "MIGRATION_ARCHIVE_CONFIRMED": "yes",
        "DEMO_ACCOUNT_RETIREMENT_MODE": "delete",
        "DEMO_ACCOUNT_RETIREMENT_CONFIRM": "DELETE_ONLY_LEGACY_FUNGAME_DEMOS",
    }


async def main():
    seed_database = client["startup_never_creates_accounts"]
    original_seed_database = seed.db
    original_legacy_switch = os.environ.get("ENABLE_DEMO_SEEDS")
    try:
        seed.db = seed_database
        # This legacy variable is deliberately ignored now.  The check proves
        # a stale deployment setting cannot recreate a usable fixture account.
        os.environ["ENABLE_DEMO_SEEDS"] = "true"
        await seed.run_seed()
        check(
            "startup never creates legacy login accounts",
            await seed_database.users.count_documents({"email": {"$in": ["admin@fungame.app", "player@fungame.app"]}}) == 0
            and await seed_database.games.count_documents({}) > 0,
        )
    finally:
        seed.db = original_seed_database
        if original_legacy_switch is None:
            os.environ.pop("ENABLE_DEMO_SEEDS", None)
        else:
            os.environ["ENABLE_DEMO_SEEDS"] = original_legacy_switch

    check("delete guard defaults to dry-run", retirement.deletion_guard_error({}) is not None)
    check(
        "delete guard needs migration archive confirmation",
        retirement.deletion_guard_error({
            "DEMO_ACCOUNT_RETIREMENT_MODE": "delete",
            "DEMO_ACCOUNT_RETIREMENT_CONFIRM": "DELETE_ONLY_LEGACY_FUNGAME_DEMOS",
        }) is not None,
    )
    check("all explicit deletion guards are required", retirement.deletion_guard_error(delete_environment()) is None)

    dry_database = await make_fixture("retire_dry_run")
    dry = await retirement.retire_demo_accounts(dry_database, {})
    check("default invocation is a dry run", dry["mode"] == "dry-run")
    check(
        "dry run leaves exact demo rows intact",
        await dry_database.users.count_documents({"email": {"$in": ["admin@fungame.app", "player@fungame.app"]}}) == 2,
    )
    malformed_delete = await retirement.retire_demo_accounts(dry_database, {
        "DEMO_ACCOUNT_RETIREMENT_MODE": "delete",
    })
    check(
        "a malformed delete request fails rather than masquerading as a dry run",
        malformed_delete["mode"] == "blocked"
        and await dry_database.users.count_documents({"email": "admin@fungame.app"}) == 1,
    )

    database = await make_fixture("retire_delete")
    plan = await retirement.discover_retirement(database)
    check("valid exact-role fixture passes preflight", plan["can_delete"] is True)
    check("plan inventories both exact demo identities", len(plan["targets"]) == 2)
    check(
        "plan counts a directly owned game record",
        plan["owned_document_counts"]["game_rounds.user_id"] == 1,
    )
    check("plan excludes shared records from deletion", "live_outcomes.user_id" not in plan["owned_document_counts"])

    result = await retirement.retire_demo_accounts(database, delete_environment())
    check("guarded destructive mode deletes only after preflight", result["mode"] == "deleted")
    check(
        "only the two exact demo user rows were removed",
        await database.users.count_documents({"email": {"$in": ["admin@fungame.app", "player@fungame.app"]}}) == 0
        and await database.users.count_documents({"id": "real-player"}) == 1,
    )
    child_counts_ok = True
    for collection, fields in retirement.DIRECT_ID_OWNED_COLLECTIONS.items():
        for field in fields:
            child_counts_ok = child_counts_ok and (
                await database[collection].count_documents({field: "demo-player"}) == 0
                and await database[collection].count_documents({field: "real-player"}) == 1
            )
    for collection, fields in retirement.DIRECT_EMAIL_OWNED_COLLECTIONS.items():
        for field in fields:
            child_counts_ok = child_counts_ok and (
                await database[collection].count_documents({field: "player@fungame.app"}) == 0
                and await database[collection].count_documents({field: "real@example.test"}) == 1
            )
    check("only directly owned child documents were removed", child_counts_ok)
    check(
        "shared game outcome and configuration survive retirement",
        await database.live_outcomes.count_documents({"slug": "triple-fun"}) == 1
        and await database.games.count_documents({"slug": "triple-fun"}) == 1,
    )

    shared_database = await make_fixture("retire_shared_reference")
    await shared_database.admin_audit.insert_one({
        "id": "audit-1", "actor_id": "demo-admin", "target_id": "real-player",
    })
    shared_plan = await retirement.discover_retirement(shared_database)
    shared_result = await retirement.retire_demo_accounts(shared_database, delete_environment())
    check("shared/audit references block deletion", shared_plan["can_delete"] is False and shared_result["mode"] == "blocked")
    check(
        "blocked plan preserves all demo rows",
        await shared_database.users.count_documents({"email": "admin@fungame.app"}) == 1,
    )

    mismatch_database = client["retire_role_mismatch"]
    await mismatch_database.users.insert_many([
        {"id": "wrong-admin", "email": "admin@fungame.app", "role": "PLAYER"},
        {"id": "demo-player", "email": "player@fungame.app", "role": "PLAYER"},
    ])
    mismatch = await retirement.retire_demo_accounts(mismatch_database, delete_environment())
    check("role mismatch fails closed", mismatch["mode"] == "blocked")
    check(
        "role mismatch never deletes a reused exact address",
        await mismatch_database.users.count_documents({"email": "admin@fungame.app"}) == 1,
    )

    print(f"\n  {PASS} passed, {FAIL} failed")
    return FAIL


sys.exit(asyncio.run(main()))
