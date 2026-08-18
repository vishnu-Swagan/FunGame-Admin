"""In-memory checks for the guarded retired-game data purge."""

import asyncio
import os
import sys
import types

from mongomock_motor import AsyncMongoMockClient

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
client = AsyncMongoMockClient()
sys.modules["db"] = types.SimpleNamespace(db=client["legacy_game_purge_import"])

import purge_legacy_game_data as purge


def armed():
    return {
        purge.MODE_ENV: "delete",
        purge.CONFIRM_ENV: purge.CONFIRMATION,
    }


async def fixture(name):
    database = client[name]
    await database.games.insert_many([
        {"slug": "fun-roulette", "name": "American Roulette"},
        {"slug": "aviator", "name": "Aviator"},
    ])
    await database.users.insert_one({"id": "player", "chip_balance": 5000})
    await database.points_transactions.insert_one({"id": "ledger", "user_id": "player"})
    await database.roulette_rounds.insert_many([
        {"round_number": 10, "winning_number": 17, "status": "SETTLED"},
        {"round_number": 11, "winning_number": "00", "status": "SETTLED"},
    ])
    await database.roulette_bets.insert_many([
        {"id": "old-r", "round_number": 10, "status": "SETTLED"},
        {"id": "new-r", "round_number": 11, "status": "SETTLED"},
    ])
    await database.aviator_rounds.insert_many([
        {"round_number": 20, "status": "SETTLED", "crash_point": 1.5},
        {"round_number": 21, "status": "SETTLED", "server_seed": "seed", "server_seed_hash": "hash"},
    ])
    await database.aviator_bets.insert_many([
        {"id": "old-a", "round_number": 20, "status": "LOST"},
        {"id": "new-a", "round_number": 21, "status": "LOST"},
    ])
    await database.game_rounds.insert_many([
        {"id": "old-rh", "slug": "fun-roulette", "outcome": {"round_number": 10}},
        {"id": "new-rh", "slug": "fun-roulette", "outcome": {"round_number": 11}},
        {"id": "old-ah", "slug": "aviator"},
        {"id": "new-ah", "slug": "aviator", "round_number": 21},
    ])
    return database


async def main():
    database = await fixture("dry")
    dry = await purge.purge_legacy_data(database, {})
    assert dry["mode"] == "dry-run"
    assert await database.roulette_rounds.count_documents({}) == 2

    database = await fixture("delete")
    result = await purge.purge_legacy_data(database, armed())
    assert result["mode"] == "deleted"
    assert await database.roulette_rounds.count_documents({"round_number": 10}) == 0
    assert await database.roulette_rounds.count_documents({"round_number": 11}) == 1
    assert await database.aviator_rounds.count_documents({"round_number": 20}) == 0
    assert await database.aviator_rounds.count_documents({"round_number": 21}) == 1
    assert await database.games.count_documents({}) == 2
    assert await database.users.count_documents({}) == 1
    assert await database.points_transactions.count_documents({}) == 1

    database = await fixture("blocked")
    await database.aviator_bets.update_one({"id": "old-a"}, {"$set": {"status": "OPEN"}})
    blocked = await purge.purge_legacy_data(database, armed())
    assert blocked["mode"] == "blocked"
    assert await database.aviator_rounds.count_documents({"round_number": 20}) == 1
    print("legacy game purge: 14 checks passed")


sys.exit(asyncio.run(main()))
