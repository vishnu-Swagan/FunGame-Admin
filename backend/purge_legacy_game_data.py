"""Inventory or purge retired Roulette and Aviator runtime records.

This is a manual maintenance tool, never a startup migration or web route.
Its default mode is read-only.  The live ``games`` catalogue rows, users,
balances, points ledger and every current-format round are deliberately outside
its deletion set.

Legacy records have durable schema fingerprints:

* pre-American roulette rounds stored ``winning_number`` as a BSON number;
  current 0/00-capable rounds store a string pocket label;
* pre-reference Aviator settled rounds have no server seed/hash; current
  provably-fair rounds always carry both.

After reviewing the JSON inventory, destructive mode requires both guards::

    LEGACY_GAME_PURGE_MODE=delete \
    LEGACY_GAME_PURGE_CONFIRM=DELETE_ONLY_RETIRED_ROULETTE_AND_AVIATOR \
    python backend/purge_legacy_game_data.py

Any OPEN bet attached to a legacy round blocks the entire purge.  That prevents
removing a stake that may still require a refund or settlement.
"""

from __future__ import annotations

import asyncio
import json
import os
from typing import Any, Mapping

from db import db


MODE_ENV = "LEGACY_GAME_PURGE_MODE"
CONFIRM_ENV = "LEGACY_GAME_PURGE_CONFIRM"
CONFIRMATION = "DELETE_ONLY_RETIRED_ROULETTE_AND_AVIATOR"


def deletion_guard_error(environment: Mapping[str, str] | None = None) -> str | None:
    env = environment if environment is not None else os.environ
    if (env.get(MODE_ENV) or "").strip().lower() != "delete":
        return f"set {MODE_ENV}=delete to request deletion"
    if env.get(CONFIRM_ENV) != CONFIRMATION:
        return f"set {CONFIRM_ENV}={CONFIRMATION} to confirm the exact legacy schemas"
    return None


async def _round_numbers(collection: Any, query: dict[str, Any]) -> list[int]:
    rows = await collection.find(query, {"_id": 0, "round_number": 1}).to_list(1_000_000)
    return sorted({row["round_number"] for row in rows if isinstance(row.get("round_number"), int)})


def _in_rounds(round_numbers: list[int]) -> dict[str, Any]:
    return {"round_number": {"$in": round_numbers}}


async def discover_legacy_data(database: Any = db) -> dict[str, Any]:
    roulette_rounds = await _round_numbers(
        database.roulette_rounds,
        {"winning_number": {"$type": "number"}},
    )
    aviator_rounds = await _round_numbers(
        database.aviator_rounds,
        {
            "status": "SETTLED",
            "server_seed": {"$exists": False},
            "server_seed_hash": {"$exists": False},
        },
    )

    roulette_bet_query = _in_rounds(roulette_rounds)
    aviator_bet_query = _in_rounds(aviator_rounds)
    roulette_history_query = {
        "slug": "fun-roulette",
        "outcome.round_number": {"$in": roulette_rounds},
    }
    aviator_history_query = {
        "slug": "aviator",
        "round_number": {"$exists": False},
    }

    counts = {
        "roulette_rounds": len(roulette_rounds),
        "roulette_bets": await database.roulette_bets.count_documents(roulette_bet_query),
        "roulette_history": await database.game_rounds.count_documents(roulette_history_query),
        "aviator_rounds": len(aviator_rounds),
        "aviator_bets": await database.aviator_bets.count_documents(aviator_bet_query),
        "aviator_history": await database.game_rounds.count_documents(aviator_history_query),
    }
    open_bets = {
        "roulette": await database.roulette_bets.count_documents({
            **roulette_bet_query, "status": "OPEN",
        }),
        "aviator": await database.aviator_bets.count_documents({
            **aviator_bet_query, "status": "OPEN",
        }),
    }
    return {
        "mode": "inventory",
        "legacy_round_numbers": {
            "roulette": roulette_rounds,
            "aviator": aviator_rounds,
        },
        "document_counts": counts,
        "blocking_open_bets": open_bets,
        "can_delete": not any(open_bets.values()),
        "preserved": [
            "games catalogue rows",
            "users and chip balances",
            "points/chip transaction ledger",
            "current American Roulette rounds and bets",
            "current provably-fair Aviator rounds and bets",
        ],
    }


async def purge_legacy_data(
    database: Any = db,
    environment: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    env = environment if environment is not None else os.environ
    plan = await discover_legacy_data(database)
    guard_error = deletion_guard_error(env)
    delete_requested = (env.get(MODE_ENV) or "").strip().lower() == "delete"
    if not delete_requested:
        return {**plan, "mode": "dry-run", "guard": guard_error}
    if guard_error or not plan["can_delete"]:
        return {
            **plan,
            "mode": "blocked",
            "guard": guard_error,
            "error": guard_error or "legacy rounds still have OPEN bets",
        }

    roulette_rounds = plan["legacy_round_numbers"]["roulette"]
    aviator_rounds = plan["legacy_round_numbers"]["aviator"]
    deleted: dict[str, int] = {}

    result = await database.game_rounds.delete_many({
        "slug": "fun-roulette", "outcome.round_number": {"$in": roulette_rounds},
    })
    deleted["roulette_history"] = result.deleted_count
    result = await database.roulette_bets.delete_many(_in_rounds(roulette_rounds))
    deleted["roulette_bets"] = result.deleted_count
    result = await database.roulette_rounds.delete_many({
        "round_number": {"$in": roulette_rounds},
        "winning_number": {"$type": "number"},
    })
    deleted["roulette_rounds"] = result.deleted_count

    result = await database.game_rounds.delete_many({
        "slug": "aviator", "round_number": {"$exists": False},
    })
    deleted["aviator_history"] = result.deleted_count
    result = await database.aviator_bets.delete_many(_in_rounds(aviator_rounds))
    deleted["aviator_bets"] = result.deleted_count
    result = await database.aviator_rounds.delete_many({
        "round_number": {"$in": aviator_rounds},
        "status": "SETTLED",
        "server_seed": {"$exists": False},
        "server_seed_hash": {"$exists": False},
    })
    deleted["aviator_rounds"] = result.deleted_count
    return {**plan, "mode": "deleted", "deleted": deleted}


async def main() -> None:
    result = await purge_legacy_data()
    print(json.dumps(result, indent=2, sort_keys=True))
    if result["mode"] == "blocked":
        raise SystemExit(2)


if __name__ == "__main__":
    asyncio.run(main())
