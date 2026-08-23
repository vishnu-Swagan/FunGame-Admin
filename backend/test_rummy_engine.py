"""Focused rules, configuration, proof and five-seat privacy tests for Rummy."""
from __future__ import annotations

import asyncio
import copy
import hashlib
import inspect
import json
import os
import sys


HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("MONGO_URL", "mongodb://127.0.0.1:27017")
os.environ.setdefault("DB_NAME", "rummy_test")

import rummy  # noqa: E402
import routes_rummy  # noqa: E402
from fastapi import HTTPException  # noqa: E402
from mongomock_motor import AsyncMongoMockClient  # noqa: E402

routes_rummy._mark_rummy_core_ready_for_tests()


def _cards():
    return {card["id"]: card for card in rummy.new_deck()}


def test_two_decks_and_printed_jokers_are_unique():
    deck = rummy.new_deck()
    assert len(deck) == 106
    assert len({card["id"] for card in deck}) == 106
    assert sum(card["printedJoker"] for card in deck) == 2


def test_secure_shuffle_is_deterministic_for_a_seed_and_committed():
    seed = bytes(range(32))
    first, proof = rummy.secure_shuffle(rummy.new_deck(), seed)
    second, second_proof = rummy.secure_shuffle(rummy.new_deck(), seed)
    assert [card["id"] for card in first] == [card["id"] for card in second]
    assert proof == second_proof
    assert proof["seed"] == seed.hex()
    assert proof["seedCommitment"] == hashlib.sha256(seed).hexdigest()
    assert proof["shuffleVersion"] == "rummy-hmac-fy-v1"
    assert len(proof["deckHash"]) == 64


def test_exactly_five_central_categories_and_seats():
    assert [row["id"] for row in rummy.RUMMY_CATEGORIES] == ["LV1", "LV2", "LV3", "LV4", "LV5"]
    assert all(row["maxPlayers"] == 5 for row in rummy.RUMMY_CATEGORIES)
    assert all(isinstance(row["entryChips"], int) and row["entryChips"] > 0 for row in rummy.RUMMY_CATEGORIES)
    assert all("currency" not in row for row in rummy.RUMMY_CATEGORIES)
    assert all(row["firstDropPoints"] == 20 for row in rummy.RUMMY_CATEGORIES)
    assert all(row["middleDropPoints"] == 40 for row in rummy.RUMMY_CATEGORIES)
    assert all(row["invalidDeclarationPoints"] == 80 for row in rummy.RUMMY_CATEGORIES)


def test_pure_impure_set_and_full_declaration_rules():
    card = _cards()
    wild = 13
    pure = [card["D1-H-2"], card["D1-H-3"], card["D1-H-4"]]
    impure = [card["D1-S-5"], card["D1-PJ"], card["D1-S-7"]]
    valid_set = [card["D1-D-9"], card["D1-C-9"], card["D1-S-9"]]
    second_pure = [card["D1-D-10"], card["D1-D-11"], card["D1-D-12"], card["D1-D-13"]]
    hand = pure + impure + valid_set + second_pure
    groups = [[item["id"] for item in group] for group in (pure, impure, valid_set, second_pure)]

    assert rummy.classify_group(pure, wild) == "PURE_SEQUENCE"
    assert rummy.classify_group(impure, wild) == "IMPURE_SEQUENCE"
    assert rummy.classify_group(valid_set, wild) == "SET"
    assert rummy.validate_declaration(hand, groups, wild)["valid"] is True
    assert rummy.best_arrangement(hand, wild)["valid"] is True


def test_wild_rank_can_be_used_naturally_in_a_pure_sequence():
    card = _cards()
    natural_wild = [card["D1-D-4"], card["D1-D-5"], card["D1-D-6"]]
    substituted_wild = [card["D1-D-4"], card["D1-H-5"], card["D1-D-6"]]
    printed = [card["D1-D-4"], card["D1-PJ"], card["D1-D-6"]]

    assert rummy.classify_group(natural_wild, 5) == "PURE_SEQUENCE"
    assert rummy.classify_group(substituted_wild, 5) == "IMPURE_SEQUENCE"
    assert rummy.classify_group(printed, 5) == "IMPURE_SEQUENCE"


def test_declaration_rejects_missing_pure_sequence_and_card_replay():
    card = _cards()
    wild = 13
    groups = [
        [card["D1-S-5"], card["D1-PJ"], card["D1-S-7"]],
        [card["D1-H-8"], card["D2-PJ"], card["D1-H-10"]],
        [card["D1-D-9"], card["D1-C-9"], card["D1-S-9"]],
        [card["D1-D-2"], card["D1-C-2"], card["D1-S-2"], card["D1-H-2"]],
    ]
    hand = sum(groups, [])
    ids = [[item["id"] for item in group] for group in groups]
    assert rummy.validate_declaration(hand, ids, wild)["code"] == "PURE_SEQUENCE_REQUIRED"
    replay = [list(group) for group in ids]
    replay[-1][-1] = replay[0][0]
    assert rummy.validate_declaration(hand, replay, wild)["code"] == "CARDS_NOT_FULLY_GROUPED"


def test_scoring_requires_a_pure_then_a_second_sequence():
    card = _cards()
    no_pure = [card[f"D1-{suit}-{rank}"] for suit, rank in [
        ("S", 2), ("H", 3), ("D", 4), ("C", 5), ("S", 6), ("H", 7),
        ("D", 8), ("C", 9), ("S", 10), ("H", 11), ("D", 12), ("C", 1), ("S", 3),
    ]]
    arrangement = rummy.best_arrangement(no_pure, 13)
    assert arrangement["valid"] is False
    assert 1 <= arrangement["score"] <= 80


def test_arrangement_prioritizes_pure_and_second_sequence_before_high_point_sets():
    card = _cards()
    # Q/K/A of three suits can form three tempting ten-point sets.  Hearts
    # Q-K-A and clubs 2-3-4 are nevertheless the two sequences the scoring
    # hierarchy must preserve before maximising covered point value.
    hand = [
        card["D1-H-12"], card["D1-H-13"], card["D1-H-1"],
        card["D1-S-12"], card["D1-D-12"],
        card["D1-S-13"], card["D1-C-13"],
        card["D1-D-1"], card["D1-C-1"],
        card["D1-C-2"], card["D1-C-3"], card["D1-C-4"],
        card["D1-D-5"],
    ]
    arrangement = rummy.best_arrangement(hand, 11)
    labels = [group["label"] for group in arrangement["groups"]]
    assert labels.count("PURE_SEQUENCE") >= 2
    assert arrangement["score"] == 55


def test_private_group_metadata_has_own_version_and_never_advances_room_version():
    room = {"id": "room-1", "version": 17, "current_seat": 3}
    hand = {"user_id": "player-1", "hand_version": 4, "groups": []}
    updated = routes_rummy._apply_private_groups(hand, [["a", "b", "c"]])
    assert updated["hand_version"] == 5
    assert updated["groups"] == [["a", "b", "c"]]
    assert room == {"id": "room-1", "version": 17, "current_seat": 3}
    # Another seat's authoritative action still targets the same room version.
    other = routes_rummy.RummyAction(
        roomId="room-123456", roundId="round-1", actionId="other-action-1",
        expectedVersion=room["version"], actionType="draw_closed",
        actionPayload={}, clientTimestamp=100,
    )
    assert other.expectedVersion == 17


def test_table_chat_collapses_whitespace_and_removes_control_characters():
    message = routes_rummy.RummyChatCreate(body="  Nice\n\tmove!\x00  ")
    assert message.body == "Nice move!"


def test_live_pot_conserves_the_five_immutable_seat_stakes():
    seats = [
        {
            "user_id": f"player-{index}", "entry_chips": amount,
            "wallet_stake_chips": amount, "is_bot": False,
        }
        for index, amount in enumerate((100, 100, 100, 100, 100))
    ]
    human = routes_rummy._settlement_amounts(seats, winner_is_bot=False, mode="LIVE")
    assert human == {
        "pot": 500, "humanPayout": 500,
        "seatStakeTotal": 500, "realStakeTotal": 500,
    }
    assert human["humanPayout"] == sum(seat["entry_chips"] for seat in seats)


def test_practice_pot_uses_frozen_virtual_entries_and_bot_wins_credit_nobody():
    seats = [
        {"entry_chips": 100, "wallet_stake_chips": 0, "is_bot": index > 0}
        for index in range(5)
    ]
    human = routes_rummy._settlement_amounts(seats, winner_is_bot=False, mode="PRACTICE")
    bot = routes_rummy._settlement_amounts(seats, winner_is_bot=True, mode="PRACTICE")
    fallback = routes_rummy._settlement_amounts(seats, winner_is_bot=False, mode="BOT_TABLE")
    assert human == {
        "pot": 500, "humanPayout": 0,
        "seatStakeTotal": 500, "realStakeTotal": 0,
    }
    assert bot["pot"] == 500
    assert bot["humanPayout"] == 0
    assert fallback["humanPayout"] == 0


def test_bot_levels_make_only_legal_private_information_decisions():
    cards = list(rummy.new_deck()[:14])
    forbidden = cards[-1]["id"]
    for level in rummy.BOT_DIFFICULTIES:
        discard = rummy.choose_bot_discard(
            cards, 9, level, forbidden_card_id=forbidden,
        )
        assert discard["id"] in {card["id"] for card in cards}
        assert discard["id"] != forbidden
        assert rummy.choose_bot_draw_source(cards[:13], cards[-1], 9, level) in {
            "CLOSED", "DISCARD",
        }


def test_five_categories_freeze_distinct_level_brains_and_created_bot_avatars():
    assert [
        category["practiceBotDifficulty"] for category in rummy.RUMMY_CATEGORIES
    ] == list(rummy.BOT_DIFFICULTIES)

    frozen_difficulties = []
    for category in rummy.RUMMY_CATEGORIES:
        seat = routes_rummy._new_bot_seat(
            {"id": f"room-{category['id']}"}, dict(category), 1, 1, 100.0,
        )
        frozen_difficulties.append(seat["bot_difficulty"])
        assert seat["bot_profile"]["logicVersion"] == "fair-private-public-v3"
        assert seat["bot_profile"]["outcomeControl"] is False
    assert frozen_difficulties == list(rummy.BOT_DIFFICULTIES)

    avatars = {
        routes_rummy._new_bot_seat(
            {"id": "room-avatar"}, dict(rummy.RUMMY_CATEGORIES[4]),
            bot_number, bot_number, 100.0,
        )["avatar"]
        for bot_number in range(1, 5)
    }
    assert avatars == {"avatar-26", "avatar-37", "avatar-48", "avatar-59"}


def test_bot_level_fixture_has_three_distinct_legal_discard_bands():
    card = _cards()
    hand = [card[card_id] for card_id in (
        "D1-C-9", "D2-H-5", "D1-D-5", "D1-D-2", "D2-H-11",
        "D2-H-8", "D2-C-7", "D2-D-13", "D2-PJ", "D1-S-9",
        "D1-D-11", "D1-D-10", "D1-C-10", "D2-C-12",
    )]
    choices = {
        level: rummy.choose_bot_discard(hand, 11, level)["id"]
        for level in rummy.BOT_DIFFICULTIES
    }
    assert choices == {
        "guided": "D1-C-10",
        "standard": "D1-C-10",
        "strong": "D1-D-10",
        "expert": "D1-D-10",
        "royal": "D2-D-13",
    }
    assert len(set(choices.values())) == 3


def test_royal_bot_uses_private_meld_potential_for_visible_discard_lookahead():
    card = _cards()
    hand = [card[card_id] for card_id in (
        "D1-H-11", "D2-C-10", "D1-H-1", "D2-C-1", "D2-C-3",
        "D1-S-12", "D2-PJ", "D1-S-11", "D1-S-5", "D2-D-10",
        "D2-S-1", "D1-H-4", "D2-S-3",
    )]
    open_discard = card["D2-H-9"]
    assert rummy.choose_bot_draw_source(hand, open_discard, 7, "expert") == "CLOSED"
    assert rummy.choose_bot_draw_source(hand, open_discard, 7, "royal") == "DISCARD"
    royal_hand = [*hand, open_discard]
    royal_discard = rummy.choose_bot_discard(
        royal_hand, 7, "royal", forbidden_card_id=open_discard["id"],
    )
    assert royal_discard["id"] == "D1-H-4"


def test_bot_timing_is_level_bounded_and_does_not_touch_the_deck():
    deck = rummy.new_deck()
    before = [card["id"] for card in deck]
    assert routes_rummy._bot_think_delay_seconds("guided", 0) == 2.8
    assert routes_rummy._bot_think_delay_seconds("guided", 1000) == 5.0
    assert routes_rummy._bot_think_delay_seconds("royal", 0) == 1.6
    assert routes_rummy._bot_discard_delay_seconds("royal", 1000) == 1.5
    assert [card["id"] for card in deck] == before


def test_live_matchmaking_uses_shared_three_minute_level_cycles():
    assert routes_rummy.LIVE_MATCHMAKING_CYCLE_SECONDS == 180
    assert routes_rummy._next_live_start_epoch(0.0) == 180.0
    assert routes_rummy._next_live_start_epoch(179.999) == 180.0
    assert routes_rummy._next_live_start_epoch(180.0) == 360.0
    metadata = routes_rummy._live_cycle_metadata("LV4", 540.0)
    assert metadata["matchmaking_cycle_id"] == "LV4:540"
    assert metadata["scheduled_start_at_epoch"] == 540.0
    assert metadata["matchmaking_cycle_seconds"] == 180


def test_bot_identity_and_social_helpers_are_explicit_and_card_blind():
    seat = routes_rummy._new_bot_seat(
        {"id": "room-profile"}, dict(rummy.RUMMY_CATEGORIES[4]), 2, 1, 100.0,
    )
    assert seat["is_bot"] is True
    assert seat["display_name"] == "Mira"
    assert seat["bot_label"].startswith("AUTO ·")
    assert seat["bot_profile"]["difficulty"] == "royal"
    assert seat["bot_profile"]["outcomeControl"] is False
    assert seat["bot_profile"]["usesPrivateHandOnly"] is True
    assert set(inspect.signature(routes_rummy._bot_social_beat).parameters) == {
        "room", "seat", "phase",
    }
    assert "closed_deck" not in inspect.signature(rummy.choose_bot_draw_source).parameters
    try:
        routes_rummy.RummyChatRequest(
            requestId="unsafe-gif-001", eventType="GIF", reactionId="https://remote.example/gif",
        )
    except ValueError:
        pass
    else:
        raise AssertionError("an arbitrary remote GIF was accepted")


def test_current_chat_and_support_post_has_one_unambiguous_route():
    path = "/games/rummy/rooms/{room_id}/chat"
    matches = [
        route for route in routes_rummy.router.routes
        if getattr(route, "path", None) == path and "POST" in getattr(route, "methods", set())
    ]
    assert len(matches) == 1
    assert matches[0].endpoint is routes_rummy.rummy_table_chat_send


def test_category_snapshot_is_deeply_frozen_and_survives_disablement():
    mutable = copy.deepcopy(rummy.RUMMY_CATEGORIES[0])
    snapshot = routes_rummy._freeze_category(mutable)
    mutable["entryChips"] = 9999
    mutable["turnDurationSeconds"] = 89
    mutable["accent"]["from"] = "#ffffff"
    mutable["enabled"] = False

    frozen = asyncio.run(routes_rummy._room_category({
        "category_id": "LV1", "category_snapshot": snapshot,
    }))
    assert frozen["entryChips"] == 100
    assert frozen["turnDurationSeconds"] == 30
    assert frozen["accent"]["from"] == "#0c8f71"
    assert frozen["enabled"] is True


def test_live_skill_rating_uses_stored_value_with_a_sane_default():
    assert routes_rummy._player_skill_rating({}) == 500
    routes_rummy._assert_live_skill_eligible({}, dict(rummy.RUMMY_CATEGORIES[0]))
    try:
        routes_rummy._assert_live_skill_eligible(
            {"rummy_skill_rating": 1200}, dict(rummy.RUMMY_CATEGORIES[0]),
        )
    except HTTPException as exc:
        assert exc.detail["code"] == "RUMMY_SKILL_RATING_OUT_OF_RANGE"
    else:
        raise AssertionError("an ineligible live rating was accepted")


def test_turn_deadline_is_closed_at_the_exact_server_deadline():
    room = {"turn_deadline": 100.0}
    assert routes_rummy._turn_deadline_expired(room, 99.999) is False
    assert routes_rummy._turn_deadline_expired(room, 100.0) is True
    assert routes_rummy._turn_deadline_expired(room, 101.0) is True


def test_presence_moves_active_to_reconnecting_then_expires_with_snapshot_penalty():
    category = dict(rummy.RUMMY_CATEGORIES[0])
    category["reconnectAllowanceSeconds"] = 20
    seat = {
        "status": "ACTIVE", "is_bot": False, "last_seen_epoch": 100,
        "turns_taken": 0,
    }
    assert routes_rummy._presence_transition(seat, category, 105.9) is None
    reconnecting = routes_rummy._presence_transition(seat, category, 106.0)
    assert reconnecting["status"] == "RECONNECTING"
    assert reconnecting["reconnect_deadline"] == 126.0

    seat.update(reconnecting)
    assert routes_rummy._presence_transition(seat, category, 125.999) is None
    expired = routes_rummy._presence_transition(seat, category, 126.0)
    assert expired["status"] == "DROPPED"
    assert expired["drop_points"] == category["firstDropPoints"]


def test_expired_turn_action_is_rejected_before_any_card_or_room_mutation():
    async def scenario():
        mock = AsyncMongoMockClient()
        database = mock["rummy_expired_action"]
        room = {
            "id": "room-expired", "round_id": "round-expired",
            "category_id": "LV1", "category_snapshot": dict(rummy.RUMMY_CATEGORIES[0]),
            "mode": "LIVE", "state": "TURN_ACTIVE", "version": 7,
            "current_seat": 0, "turn_deadline": 1,
        }
        seat = {
            "room_id": room["id"], "user_id": "player-1", "seat_index": 0,
            "status": "ACTIVE", "is_bot": False, "entry_chips": 100,
        }
        hand = {
            "room_id": room["id"], "round_id": room["round_id"],
            "user_id": "player-1", "seat_index": 0,
            "cards": rummy.new_deck()[:13], "drawn": False, "groups": [],
        }
        await database.rummy_rooms.insert_one(copy.deepcopy(room))
        await database.rummy_seats.insert_one(copy.deepcopy(seat))
        await database.rummy_hands.insert_one(copy.deepcopy(hand))

        async def direct_transaction(_client, callback):
            return await callback(None)

        async def allow(_slug):
            return True

        original_db = routes_rummy.db
        original_runner = routes_rummy.run_game_transaction
        original_access = routes_rummy.require_playable_game
        routes_rummy.db = database
        routes_rummy.run_game_transaction = direct_transaction
        routes_rummy.require_playable_game = allow
        try:
            body = routes_rummy.RummyAction(
                roomId=room["id"], roundId=room["round_id"],
                actionId="expired-action-1", expectedVersion=7,
                actionType="DRAW_CLOSED", actionPayload={}, clientTimestamp=2,
            )
            try:
                await routes_rummy.rummy_action(room["id"], body, {"id": "player-1"})
            except HTTPException as exc:
                assert exc.status_code == 409
                assert exc.detail["code"] == "RUMMY_TURN_EXPIRED"
            else:
                raise AssertionError("a post-deadline draw was accepted")
            persisted_room = await database.rummy_rooms.find_one({"id": room["id"]})
            persisted_hand = await database.rummy_hands.find_one({"user_id": "player-1"})
            assert persisted_room["version"] == 7
            assert persisted_hand["drawn"] is False
            assert len(persisted_hand["cards"]) == 13
            assert await database.rummy_actions.count_documents({}) == 0
        finally:
            routes_rummy.db = original_db
            routes_rummy.run_game_transaction = original_runner
            routes_rummy.require_playable_game = original_access

    asyncio.run(scenario())


def test_automation_checks_requester_membership_before_advancing_a_room():
    async def scenario():
        mock = AsyncMongoMockClient()
        database = mock["rummy_automation_membership"]
        await database.rummy_rooms.insert_one({
            "id": "room-private", "state": "TURN_ACTIVE", "version": 1,
        })

        async def direct_transaction(_client, callback):
            return await callback(None)

        original_db = routes_rummy.db
        original_runner = routes_rummy.run_game_transaction
        routes_rummy.db = database
        routes_rummy.run_game_transaction = direct_transaction
        try:
            try:
                await routes_rummy._advance_one_automatic("room-private", "outsider")
            except HTTPException as exc:
                assert exc.status_code == 403
                assert exc.detail["code"] == "RUMMY_NOT_A_MEMBER"
            else:
                raise AssertionError("an outsider advanced a private Rummy room")
            persisted = await database.rummy_rooms.find_one({"id": "room-private"})
            assert persisted["version"] == 1
        finally:
            routes_rummy.db = original_db
            routes_rummy.run_game_transaction = original_runner

    asyncio.run(scenario())


def test_cancellation_refunds_each_frozen_seat_stake_not_a_changed_category_value():
    async def scenario():
        mock = AsyncMongoMockClient()
        database = mock["rummy_cancel_stakes"]
        room = {
            "id": "room-cancel", "round_id": "round-cancel", "category_id": "LV1",
            "category_snapshot": {**dict(rummy.RUMMY_CATEGORIES[0]), "entryChips": 9999},
            "mode": "LIVE", "state": "TURN_ACTIVE", "version": 3,
        }
        await database.rummy_seats.insert_many([
            {
                "room_id": room["id"], "user_id": f"player-{index}",
                "seat_index": index, "status": "ACTIVE", "is_bot": False,
                "entry_chips": 100, "wallet_stake_chips": 100,
                "stake_ref": f"stake-{index}",
            }
            for index in range(2)
        ])
        credited = []

        async def record_credit(user_id, amount, note, **kwargs):
            credited.append((user_id, amount, kwargs.get("ref")))

        original_db = routes_rummy.db
        original_credit = routes_rummy.credit_chips
        routes_rummy.db = database
        routes_rummy.credit_chips = record_credit
        try:
            await routes_rummy._cancel_room(room, "test", None)
        finally:
            routes_rummy.db = original_db
            routes_rummy.credit_chips = original_credit
        assert credited == [
            ("player-0", 100, "stake-0:refund"),
            ("player-1", 100, "stake-1:refund"),
        ]
        assert room["state"] == "CANCELLED"

    asyncio.run(scenario())


def test_admin_single_bound_patch_validates_merged_range_and_disable_returns_success():
    async def scenario():
        mock = AsyncMongoMockClient()
        database = mock["rummy_category_admin"]
        await database.rummy_categories.insert_one(copy.deepcopy(rummy.RUMMY_CATEGORIES[0]))
        original_db = routes_rummy.db
        routes_rummy.db = database
        try:
            try:
                await routes_rummy.admin_rummy_category_update(
                    "LV1", routes_rummy.CategoryPatch(skillRatingMin=1000), {"id": "admin-1"},
                )
            except HTTPException as exc:
                assert exc.status_code == 422
                assert exc.detail["code"] == "RUMMY_SKILL_RANGE_INVALID"
            else:
                raise AssertionError("a single-bound invalid skill range was accepted")

            response = await routes_rummy.admin_rummy_category_update(
                "LV1", routes_rummy.CategoryPatch(enabled=False), {"id": "admin-1"},
            )
            assert response["category"]["enabled"] is False
        finally:
            routes_rummy.db = original_db

    asyncio.run(scenario())


def test_practice_join_and_settlement_are_wallet_neutral_end_to_end():
    async def scenario():
        mock = AsyncMongoMockClient()
        database = mock["rummy_practice_neutral"]
        await database.rummy_categories.insert_one(copy.deepcopy(rummy.RUMMY_CATEGORIES[0]))
        await database.users.insert_one({
            "id": "practice-player", "display_name": "Practice Player", "chip_balance": 0,
        })
        debits = []
        credits = []

        async def reject_debit(*args, **kwargs):
            debits.append((args, kwargs))
            raise AssertionError("Practice attempted a wallet debit")

        async def record_credit(*args, **kwargs):
            credits.append((args, kwargs))

        async def direct_transaction(_client, callback):
            return await callback(None)

        async def allow(_slug):
            return True

        originals = (
            routes_rummy.db, routes_rummy.debit_chips, routes_rummy.credit_chips,
            routes_rummy.run_game_transaction, routes_rummy.require_playable_game,
        )
        routes_rummy.db = database
        routes_rummy.debit_chips = reject_debit
        routes_rummy.credit_chips = record_credit
        routes_rummy.run_game_transaction = direct_transaction
        routes_rummy.require_playable_game = allow
        try:
            joined = await routes_rummy.rummy_join(
                routes_rummy.JoinRequest(categoryId="LV1", mode="PRACTICE"),
                {"id": "practice-player", "display_name": "Practice Player"},
            )
            room = await database.rummy_rooms.find_one({"id": joined["roomId"]}, {"_id": 0})
            seats = await database.rummy_seats.find({"room_id": joined["roomId"]}, {"_id": 0}).to_list(5)
            assert debits == []
            assert len(seats) == 5
            assert all(seat["wallet_stake_chips"] == 0 for seat in seats)

            await routes_rummy._settle_room(room, "practice-player", "TEST_WIN", None)
            assert credits == []
            player = await database.users.find_one({"id": "practice-player"})
            assert player["chip_balance"] == 0
            round_row = await database.game_rounds.find_one({"user_id": "practice-player"})
            assert round_row["bet"] == 0
            assert round_row["payout"] == 0
            assert room["result"]["payoutChips"] == 0
            assert room["result"]["rows"][0]["chipDelta"] == 0
        finally:
            (
                routes_rummy.db, routes_rummy.debit_chips, routes_rummy.credit_chips,
                routes_rummy.run_game_transaction, routes_rummy.require_playable_game,
            ) = originals

    asyncio.run(scenario())


def test_action_contract_requires_version_id_and_client_timestamp():
    action = routes_rummy.RummyAction(
        roomId="room-123456", roundId="round-1", actionId="action-123456",
        expectedVersion=7, actionType="discard", actionPayload={"cardId": "D1-S-2"},
        clientTimestamp=123.5,
    )
    assert action.actionType == "DISCARD"
    assert action.expectedVersion == 7


def test_waiting_refund_is_limited_to_one_active_seat_stake():
    seat = {"status": "ACTIVE", "entry_chips": 500}
    assert routes_rummy._waiting_refund_amount(seat) == 500

    # A completed leave removes the active membership. A stale legacy row or a
    # new actionId after that transition must be rejected, never credited again.
    seat["status"] = "LEFT"
    try:
        routes_rummy._waiting_refund_amount(seat)
    except HTTPException as exc:
        assert exc.status_code == 409
        assert exc.detail["code"] == "RUMMY_SEAT_INACTIVE"
    else:
        raise AssertionError("an inactive waiting seat was accepted for a second refund")

    practice = {"status": "ACTIVE", "entry_chips": 500, "wallet_stake_chips": 0}
    assert routes_rummy._waiting_refund_amount(practice) == 0


class _Cursor:
    def __init__(self, rows):
        self.rows = list(rows)

    def sort(self, key, direction):
        self.rows.sort(key=lambda row: row.get(key, 0), reverse=direction < 0)
        return self

    async def to_list(self, length):
        return list(self.rows[:length])


class _Collection:
    def __init__(self, rows):
        self.rows = list(rows)

    def find(self, query, projection=None, **kwargs):
        def matches(row, conditions=query):
            for key, value in conditions.items():
                if key == "$or":
                    if not any(matches(row, clause) for clause in value):
                        return False
                    continue
                actual = row.get(key)
                if isinstance(value, dict) and "$type" in value:
                    if value["$type"] == "string" and not isinstance(actual, str):
                        return False
                    continue
                if isinstance(value, dict) and "$in" in value:
                    if actual not in value["$in"]:
                        return False
                    continue
                if actual != value:
                    return False
            return True

        rows = [row for row in self.rows if matches(row)]
        if projection:
            excluded = {key for key, value in projection.items() if value == 0}
            rows = [
                {key: value for key, value in row.items() if key not in excluded}
                for row in rows
            ]
        return _Cursor(rows)

    async def find_one(self, query, projection=None, **kwargs):
        return next((dict(row) for row in self.rows if all(row.get(key) == value for key, value in query.items())), None)


class _PrivacyDb:
    def __init__(self, seats, hands, categories, users, chat=None):
        self.rummy_seats = _Collection(seats)
        self.rummy_hands = _Collection(hands)
        self.rummy_categories = _Collection(categories)
        self.users = _Collection(users)
        self.rummy_chat = _Collection(chat or [])


def test_public_projection_contains_only_requesters_private_hand():
    deck = rummy.new_deck()
    own = deck[:13]
    opponent = deck[13:26]
    malformed_seats = [
        {"room_id": "room-1", "seat_index": index - 5, "status": "ACTIVE"}
        for index in range(rummy.MAX_PLAYERS)
    ]
    seats = malformed_seats + [
        {
            "room_id": "room-1", "user_id": "player-1", "seat_index": 0,
            "display_name": "You", "status": "ACTIVE", "is_bot": False,
            "avatar": "avatar-42", "avatar_source": "UPLOAD",
            "avatar_upload_id": "a" * 32,
            "avatar_url": f"/api/avatars/uploads/{'a' * 32}?v={'b' * 12}",
        },
        {
            "room_id": "room-1", "user_id": "player-2", "seat_index": 1,
            "display_name": "Rival", "status": "ACTIVE", "is_bot": False,
            "avatar": "avatar-11", "avatar_source": "UPLOAD",
            "avatar_upload_id": "c" * 32,
            "avatar_url": "https://example.invalid/private-avatar.png",
        },
    ]
    malformed_hands = [
        {
            "room_id": "room-1", "round_id": "round-1",
            "user_id": f"legacy-player-{index}", "seat_index": index,
        }
        for index in range(rummy.MAX_PLAYERS)
    ] + [{
        "room_id": "room-1", "round_id": "round-1",
        "user_id": "player-1", "seat_index": 4,
    }]
    hands = malformed_hands + [
        {"room_id": "room-1", "round_id": "round-1", "user_id": "player-1", "seat_index": 0, "cards": own, "groups": [], "drawn": False},
        {"room_id": "room-1", "round_id": "round-1", "user_id": "player-2", "seat_index": 1, "cards": opponent, "groups": [], "drawn": False},
    ]
    room = {
        "id": "room-1", "round_id": "round-1", "category_id": "LV1", "mode": "LIVE",
        "state": "TURN_ACTIVE", "version": 4, "current_seat": 0,
        "turn_deadline": 9999999999, "closed_deck": deck[30:], "discard_pile": [deck[28]],
        "wild_joker": deck[29], "wild_rank": 9,
        "shuffle_proof": {"seedCommitment": "commit", "deckHash": "hash", "shuffleVersion": "rummy-hmac-fy-v1"},
    }
    chat = [{
        "id": "message-1", "room_id": "room-1", "round_id": "round-1",
        "user_id": "player-2", "seatIndex": 1, "displayName": "Rival",
        "body": "Good luck", "created_at": "2026-08-21T00:00:00+00:00",
    }]
    fake = _PrivacyDb(
        seats, hands, [dict(rummy.RUMMY_CATEGORIES[0])],
        [{"id": "player-1", "chip_balance": 900}], chat,
    )
    original = routes_rummy.db
    routes_rummy.db = fake
    try:
        payload = asyncio.run(routes_rummy._public_state(room, "player-1"))
    finally:
        routes_rummy.db = original

    encoded = json.dumps(payload)
    assert {card["id"] for card in payload["privateState"]["cards"]} == {card["id"] for card in own}
    assert payload["seats"][1]["cardCount"] == 13
    assert payload["seats"][0]["status"] == "ACTIVE"
    assert all(card["id"] not in encoded for card in opponent)
    assert "player-1" not in encoded
    assert "player-2" not in encoded
    assert payload["chat"][0]["body"] == "Good luck"
    assert "seedReveal" not in payload["shuffleProof"]
    assert len(payload["seats"]) == 5
    assert payload["seats"][4] == {"seatIndex": 4, "status": "EMPTY", "cardCount": 0}
    assert payload["seats"][0]["displayName"] == "You"
    assert payload["seats"][1]["displayName"] == "Rival"
    assert payload["seats"][0]["avatar"] == "avatar-42"
    assert payload["seats"][0]["avatarUrl"] == (
        f"/api/avatars/uploads/{'a' * 32}?v={'b' * 12}"
    )
    assert payload["seats"][1]["avatarUrl"] == f"/api/avatars/uploads/{'c' * 32}"
    assert "example.invalid" not in encoded


def test_legacy_waiting_practice_room_is_rebuilt_before_resume():
    async def scenario():
        mock = AsyncMongoMockClient()
        database = mock["rummy_legacy_waiting"]
        category = copy.deepcopy(rummy.RUMMY_CATEGORIES[0])
        room = {
            "id": "legacy-practice-room", "category_id": "LV1",
            "category_snapshot": copy.deepcopy(category), "mode": "PRACTICE",
            "state": "WAITING_FOR_PLAYERS", "version": 1,
            "seat_count": rummy.MAX_PLAYERS, "max_players": rummy.MAX_PLAYERS,
            "created_at": "2026-08-21T00:00:00+00:00",
            "updated_at": "2026-08-21T00:00:00+00:00",
        }
        await database.rummy_categories.insert_one(category)
        await database.games.insert_one({"slug": "rummy", "status": "ENABLED", "name": "Rummy"})
        await database.users.insert_one({
            "id": "legacy-player", "display_name": "Legacy Player", "chip_balance": 500,
        })
        await database.rummy_rooms.insert_one(room)
        await database.rummy_seats.insert_one({
            "room_id": room["id"], "user_id": "legacy-player", "seat_index": 0,
            "display_name": "Legacy Player", "is_bot": False, "status": "ACTIVE",
            "entry_chips": int(category["entryChips"]), "wallet_stake_chips": 0,
            "turns_taken": 0, "missed_turns": 0,
            "joined_at": "2026-08-21T00:00:00+00:00",
        })
        await database.rummy_seats.insert_many([
            {
                "room_id": room["id"], "seat_index": index,
                "is_bot": True, "status": "ACTIVE",
            }
            for index in range(1, rummy.MAX_PLAYERS)
        ])

        async def direct_transaction(_client, callback):
            return await callback(None)

        async def allow(_slug):
            return True

        originals = (
            routes_rummy.db, routes_rummy.run_game_transaction,
            routes_rummy.require_playable_game,
        )
        routes_rummy.db = database
        routes_rummy.run_game_transaction = direct_transaction
        routes_rummy.require_playable_game = allow
        routes_rummy._mark_rummy_core_ready_for_tests()
        try:
            resumed = await routes_rummy.rummy_join(
                routes_rummy.JoinRequest(categoryId="LV1", mode="PRACTICE"),
                {"id": "legacy-player", "display_name": "Legacy Player"},
            )
            repaired_seats = await database.rummy_seats.find(
                {"room_id": room["id"]}, {"_id": 0},
            ).sort("seat_index", 1).to_list(rummy.MAX_PLAYERS + 5)
            assert resumed["state"] == "TURN_ACTIVE"
            assert len(resumed["privateState"]["cards"]) == rummy.HAND_SIZE
            assert len(repaired_seats) == rummy.MAX_PLAYERS
            assert all(isinstance(seat.get("user_id"), str) for seat in repaired_seats)
            assert [seat["seat_index"] for seat in repaired_seats] == list(range(rummy.MAX_PLAYERS))
            assert all(seat["status"] != "EMPTY" for seat in resumed["seats"])
        finally:
            (
                routes_rummy.db, routes_rummy.run_game_transaction,
                routes_rummy.require_playable_game,
            ) = originals
            routes_rummy._mark_rummy_core_ready_for_tests()

    asyncio.run(scenario())


def _fixed_valid_declaration():
    card = _cards()
    groups = [
        [card["D1-H-2"], card["D1-H-3"], card["D1-H-4"]],
        [card["D1-S-5"], card["D1-PJ"], card["D1-S-7"]],
        [card["D1-D-9"], card["D1-C-9"], card["D1-S-9"]],
        [card["D1-D-10"], card["D1-D-11"], card["D1-D-12"], card["D1-D-13"]],
    ]
    return sum(groups, []), [[item["id"] for item in group] for group in groups]


async def _install_practice_action_database(name):
    mock = AsyncMongoMockClient()
    database = mock[name]
    await database.rummy_categories.insert_one(copy.deepcopy(rummy.RUMMY_CATEGORIES[0]))
    await database.games.insert_one({"slug": "rummy", "status": "ENABLED", "name": "Rummy"})
    await database.users.insert_one({
        "id": "practice-player", "display_name": "Practice Player", "chip_balance": 0,
    })

    async def direct_transaction(_client, callback):
        return await callback(None)

    async def allow(_slug):
        return True

    originals = (
        routes_rummy.db, routes_rummy.run_game_transaction, routes_rummy.require_playable_game,
    )
    routes_rummy.db = database
    routes_rummy.run_game_transaction = direct_transaction
    routes_rummy.require_playable_game = allow
    routes_rummy._mark_rummy_core_ready_for_tests()
    joined = await routes_rummy.rummy_join(
        routes_rummy.JoinRequest(categoryId="LV1", mode="PRACTICE"),
        {"id": "practice-player", "display_name": "Practice Player"},
    )
    return database, joined, originals


def _restore_practice_action_database(originals):
    routes_rummy.db, routes_rummy.run_game_transaction, routes_rummy.require_playable_game = originals
    routes_rummy._mark_rummy_core_ready_for_tests()


def test_due_full_human_table_starts_live_without_refund_or_bot_seat():
    async def scenario():
        mock = AsyncMongoMockClient()
        database = mock["rummy_scheduled_full_live"]
        category = copy.deepcopy(rummy.RUMMY_CATEGORIES[0])
        room = {
            "id": "scheduled-live-room", "category_id": "LV1",
            "category_snapshot": category, "mode": "LIVE", "requested_mode": "LIVE",
            "state": "WAITING_FOR_PLAYERS", "version": 5,
            "seat_count": rummy.MAX_PLAYERS, "max_players": rummy.MAX_PLAYERS,
            **routes_rummy._live_cycle_metadata("LV1", 180.0),
            "fallback_at_epoch": 180.0,
            "created_at": "1970-01-01T00:01:40+00:00",
            "updated_at": "1970-01-01T00:01:40+00:00",
        }
        await database.rummy_categories.insert_one(category)
        await database.rummy_rooms.insert_one(copy.deepcopy(room))
        await database.rummy_seats.insert_many([
            {
                "room_id": room["id"], "user_id": f"player-{index}",
                "seat_index": index, "status": "ACTIVE", "is_bot": False,
                "entry_chips": 100, "wallet_stake_chips": 100,
                "stake_ref": f"stake-{index}", "turns_taken": 0,
            }
            for index in range(rummy.MAX_PLAYERS)
        ])
        credits = []

        async def direct_transaction(_client, callback):
            return await callback(None)

        async def record_credit(*args, **kwargs):
            credits.append((args, kwargs))

        originals = (
            routes_rummy.db, routes_rummy.run_game_transaction,
            routes_rummy.credit_chips, routes_rummy._epoch,
        )
        routes_rummy.db = database
        routes_rummy.run_game_transaction = direct_transaction
        routes_rummy.credit_chips = record_credit
        routes_rummy._epoch = lambda: 180.0
        try:
            assert await routes_rummy._activate_scheduled_room(room["id"]) is True
            persisted = await database.rummy_rooms.find_one({"id": room["id"]}, {"_id": 0})
            seats = await database.rummy_seats.find({"room_id": room["id"]}, {"_id": 0}).to_list(5)
            assert persisted["mode"] == "LIVE"
            assert persisted["state"] == "TURN_ACTIVE"
            assert persisted["scheduled_start_at_epoch"] == 180.0
            assert credits == []
            assert all(not seat.get("is_bot") for seat in seats)
            assert await database.rummy_hands.count_documents({"room_id": room["id"]}) == 5
            assert routes_rummy._settlement_amounts(
                seats, winner_is_bot=False, mode="LIVE",
            )["humanPayout"] == 500
        finally:
            (
                routes_rummy.db, routes_rummy.run_game_transaction,
                routes_rummy.credit_chips, routes_rummy._epoch,
            ) = originals

    asyncio.run(scenario())


def test_overdue_live_matchmaking_refunds_then_starts_labelled_wallet_neutral_bots():
    async def scenario():
        mock = AsyncMongoMockClient()
        database = mock["rummy_live_bot_fallback"]
        category = copy.deepcopy(rummy.RUMMY_CATEGORIES[2])
        await database.rummy_categories.insert_one(category)
        await database.games.insert_one({"slug": "rummy", "status": "ENABLED", "name": "Rummy"})
        await database.users.insert_one({
            "id": "fallback-player", "display_name": "Fallback Player",
            "chip_balance": 5000, "rummy_skill_rating": 1200,
        })

        clock = [100.0]

        async def direct_transaction(_client, callback):
            return await callback(None)

        async def allow(_slug):
            return True

        async def debit(user_id, amount, *args, **kwargs):
            await database.users.update_one({"id": user_id}, {"$inc": {"chip_balance": -int(amount)}})

        async def credit(user_id, amount, *args, **kwargs):
            await database.users.update_one({"id": user_id}, {"$inc": {"chip_balance": int(amount)}})

        originals = (
            routes_rummy.db, routes_rummy.run_game_transaction,
            routes_rummy.require_playable_game, routes_rummy.debit_chips,
            routes_rummy.credit_chips, routes_rummy._epoch,
        )
        routes_rummy.db = database
        routes_rummy.run_game_transaction = direct_transaction
        routes_rummy.require_playable_game = allow
        routes_rummy.debit_chips = debit
        routes_rummy.credit_chips = credit
        routes_rummy._epoch = lambda: clock[0]
        routes_rummy._mark_rummy_core_ready_for_tests()
        try:
            joined = await routes_rummy.rummy_join(
                routes_rummy.JoinRequest(categoryId="LV3", mode="LIVE"),
                {"id": "fallback-player", "display_name": "Fallback Player"},
            )
            assert joined["state"] == "WAITING_FOR_PLAYERS"
            assert joined["fallbackStartsIn"] == 80.0
            assert joined["scheduledStartAtEpoch"] == 180.0
            assert joined["matchmaking"]["cycleSeconds"] == 180
            assert joined["matchmaking"]["cycleId"] == "LV3:180"
            assert (await database.users.find_one({"id": "fallback-player"}))["chip_balance"] == 4000

            clock[0] = joined["scheduledStartAtEpoch"] + 0.1
            assert await routes_rummy._activate_live_bot_fallback(
                joined["roomId"], "fallback-player",
            ) is True
            room = await database.rummy_rooms.find_one({"id": joined["roomId"]}, {"_id": 0})
            seats = await database.rummy_seats.find(
                {"room_id": joined["roomId"]}, {"_id": 0},
            ).sort("seat_index", 1).to_list(5)
            assert room["mode"] == routes_rummy.BOT_TABLE_MODE
            assert room["state"] == "TURN_ACTIVE"
            assert room["wallet_neutral"] is True
            assert len(seats) == 5
            assert sum(bool(seat.get("is_bot")) for seat in seats) == 4
            assert all(seat.get("bot_label") for seat in seats if seat.get("is_bot"))
            assert all(routes_rummy._seat_wallet_stake_chips(seat) == 0 for seat in seats)
            assert (await database.users.find_one({"id": "fallback-player"}))["chip_balance"] == 5000
            assert routes_rummy._settlement_amounts(
                seats, winner_is_bot=False, mode=routes_rummy.BOT_TABLE_MODE,
            )["humanPayout"] == 0
        finally:
            (
                routes_rummy.db, routes_rummy.run_game_transaction,
                routes_rummy.require_playable_game, routes_rummy.debit_chips,
                routes_rummy.credit_chips, routes_rummy._epoch,
            ) = originals
            routes_rummy._mark_rummy_core_ready_for_tests()

    asyncio.run(scenario())


def test_table_chat_is_labelled_idempotent_rate_limited_and_records_support_only():
    async def scenario():
        mock = AsyncMongoMockClient()
        database = mock["rummy_table_chat"]
        room = {
            "id": "room-chat-live", "category_id": "LV1",
            "category_snapshot": copy.deepcopy(rummy.RUMMY_CATEGORIES[0]),
            "mode": routes_rummy.BOT_TABLE_MODE, "requested_mode": "LIVE",
            "state": "TURN_ACTIVE", "version": 2, "round_id": "round-chat-live",
        }
        human = {
            "room_id": room["id"], "user_id": "chat-player", "seat_index": 0,
            "display_name": "Chat Player", "status": "ACTIVE", "is_bot": False,
            "entry_chips": 100, "wallet_stake_chips": 0,
        }
        other_human = {
            "room_id": room["id"], "user_id": "other-player", "seat_index": 2,
            "display_name": "Other Player", "status": "ACTIVE", "is_bot": False,
            "entry_chips": 100, "wallet_stake_chips": 0,
        }
        bot = routes_rummy._new_bot_seat(room, room["category_snapshot"], 1, 1, 100.0)
        await database.rummy_rooms.insert_one(room)
        await database.rummy_seats.insert_many([human, bot, other_human])

        async def direct_transaction(_client, callback):
            return await callback(None)

        async def allow(_slug):
            return True

        clock = [100.0]
        originals = (
            routes_rummy.db, routes_rummy.run_game_transaction,
            routes_rummy.require_playable_game, routes_rummy._epoch,
        )
        routes_rummy.db = database
        routes_rummy.run_game_transaction = direct_transaction
        routes_rummy.require_playable_game = allow
        routes_rummy._epoch = lambda: clock[0]
        routes_rummy._mark_rummy_core_ready_for_tests()
        try:
            help_body = routes_rummy.RummyChatRequest(
                requestId="help-request-001", eventType="HELP_DESK",
                message="Please help me understand this turn.",
            )
            submitted = await routes_rummy.rummy_table_chat_send(
                room["id"], help_body, {"id": "chat-player"},
            )
            assert submitted["requestStatus"] == "SUBMITTED"
            assert submitted["event"]["sender"]["isBot"] is False
            assert submitted["event"]["generatedAt"]
            request = await database.rummy_support_requests.find_one({"id": submitted["event"]["id"]})
            assert request["status"] == "SUBMITTED"
            assert request["automated_reply_created"] is False
            crm_message = await database.support_messages.find_one({
                "rummy_event_id": submitted["event"]["id"],
            })
            assert crm_message["sender"] == "USER"
            assert crm_message["read_admin"] is False
            assert crm_message["body"].startswith("[Rummy · Help Desk · LV1 · room room-chat-live]")

            replay = await routes_rummy.rummy_table_chat_send(
                room["id"], help_body, {"id": "chat-player"},
            )
            assert replay == submitted
            assert await database.rummy_support_requests.count_documents({}) == 1
            assert await database.support_messages.count_documents({}) == 1

            try:
                await routes_rummy._claim_chat_rate_token(
                    "a-different-old-room", "chat-player", "HELP_DESK",
                )
            except HTTPException as exc:
                assert exc.status_code == 429
            else:
                raise AssertionError("support rate limit was bypassed with another room id")

            try:
                await routes_rummy.rummy_table_chat_send(
                    room["id"], routes_rummy.RummyChatRequest(
                        requestId="help-request-002", eventType="HELP_DESK",
                        message="A second immediate support request.",
                    ), {"id": "chat-player"},
                )
            except HTTPException as exc:
                assert exc.status_code == 429
                assert exc.detail["code"] == "RUMMY_CHAT_RATE_LIMITED"
            else:
                raise AssertionError("support request rate limit was bypassed")

            for index in range(routes_rummy.CHAT_RATE_MAX_EVENTS):
                sent = await routes_rummy.rummy_table_chat_send(
                    room["id"], routes_rummy.RummyChatRequest(
                        requestId=f"chat-request-{index:03d}", eventType="TEXT",
                        message=f"Table message {index}",
                    ), {"id": "chat-player"},
                )
                assert sent["accepted"] is True
            try:
                await routes_rummy.rummy_table_chat_send(
                    room["id"], routes_rummy.RummyChatRequest(
                        requestId="chat-request-999", eventType="TEXT",
                        message="This message exceeds the fixed-window allowance.",
                    ), {"id": "chat-player"},
                )
            except HTTPException as exc:
                assert exc.status_code == 429
            else:
                raise AssertionError("table chat rate limit was bypassed")

            bot_event = await routes_rummy._emit_bot_chat_event(room, bot, "TEST_SOCIAL")
            public_bot = routes_rummy._public_chat_event(bot_event)
            assert public_bot["sender"]["isBot"] is True
            assert public_bot["sender"]["label"] == "AUTO"
            assert public_bot["sender"]["botLabel"].startswith("AUTO ·")
            assert public_bot["generatedAt"]

            listing = await routes_rummy.rummy_table_chat(
                room["id"], afterEpoch=0.0, limit=100, user={"id": "chat-player"},
            )
            assert any(event["sender"]["isBot"] for event in listing["events"])
            assert all(event["sender"]["label"] in ("AUTO", "PLAYER") for event in listing["events"])
            assert all(event["eventType"] not in ("HELP_DESK", "MUSIC_REQUEST") for event in listing["events"])
            opponent_listing = await routes_rummy.rummy_table_chat(
                room["id"], afterEpoch=0.0, limit=100, user={"id": "other-player"},
            )
            encoded_opponent_chat = json.dumps(opponent_listing)
            assert help_body.message not in encoded_opponent_chat
            assert submitted["event"]["id"] not in encoded_opponent_chat
            await database.rummy_seats.update_one(
                {"room_id": room["id"], "user_id": "chat-player"},
                {"$set": {"status": "LOST"}},
            )
            try:
                await routes_rummy.rummy_table_chat_send(
                    room["id"], routes_rummy.RummyChatRequest(
                        requestId="closed-chat-001", eventType="MUSIC_REQUEST",
                        message="Palace focus",
                    ), {"id": "chat-player"},
                )
            except HTTPException as exc:
                assert exc.status_code == 409
                assert exc.detail["code"] == "RUMMY_CHAT_CLOSED"
            else:
                raise AssertionError("a completed seat sent a live table request")
        finally:
            (
                routes_rummy.db, routes_rummy.run_game_transaction,
                routes_rummy.require_playable_game, routes_rummy._epoch,
            ) = originals
            routes_rummy._mark_rummy_core_ready_for_tests()

    asyncio.run(scenario())


def test_bot_turn_is_persisted_as_think_draw_and_discard_phases():
    async def scenario():
        database, joined, originals = await _install_practice_action_database("rummy_bot_phases")
        clock = [200.0]
        original_epoch = routes_rummy._epoch
        original_think = routes_rummy._bot_think_delay_seconds
        original_discard = routes_rummy._bot_discard_delay_seconds
        routes_rummy._epoch = lambda: clock[0]
        routes_rummy._bot_think_delay_seconds = lambda _level: 1.0
        routes_rummy._bot_discard_delay_seconds = lambda _level: 0.5
        try:
            await database.rummy_rooms.update_one(
                {"id": joined["roomId"]},
                {"$set": {"current_seat": 1, "turn_deadline": 300.0}},
            )
            bot = await database.rummy_seats.find_one({"room_id": joined["roomId"], "seat_index": 1})
            hand_query = {
                "room_id": joined["roomId"], "round_id": joined["roundId"],
                "user_id": bot["user_id"],
            }

            assert await routes_rummy._advance_one_automatic(joined["roomId"], "practice-player") is True
            thinking = await database.rummy_rooms.find_one({"id": joined["roomId"]}, {"_id": 0})
            assert thinking["bot_action_phase"] == "DRAWING"
            assert len((await database.rummy_hands.find_one(hand_query))["cards"]) == 13

            clock[0] = 201.1
            assert await routes_rummy._advance_one_automatic(joined["roomId"], "practice-player") is True
            drawing = await database.rummy_rooms.find_one({"id": joined["roomId"]}, {"_id": 0})
            assert drawing["bot_action_phase"] == "DISCARDING"
            assert len((await database.rummy_hands.find_one(hand_query))["cards"]) == 14

            clock[0] = 202.0
            assert await routes_rummy._advance_one_automatic(joined["roomId"], "practice-player") is True
            finished = await database.rummy_rooms.find_one({"id": joined["roomId"]}, {"_id": 0})
            assert len((await database.rummy_hands.find_one(hand_query))["cards"]) == 13
            assert "bot_action_phase" not in finished
            assert await database.rummy_actions.count_documents({
                "room_id": joined["roomId"], "user_id": bot["user_id"],
            }) == 3
        finally:
            routes_rummy._epoch = original_epoch
            routes_rummy._bot_think_delay_seconds = original_think
            routes_rummy._bot_discard_delay_seconds = original_discard
            _restore_practice_action_database(originals)

    asyncio.run(scenario())


def test_rummy_core_failure_keeps_every_public_entry_point_closed():
    async def scenario():
        class FailingCollection:
            async def create_index(self, *args, **kwargs):
                raise RuntimeError("index unavailable")

        class FailingDb:
            rummy_rooms = FailingCollection()

        original_db = routes_rummy.db
        routes_rummy.db = FailingDb()
        try:
            try:
                await routes_rummy.ensure_rummy_core()
            except RuntimeError as exc:
                assert str(exc) == "index unavailable"
            else:
                raise AssertionError("failed Rummy preparation opened its routes")
            assert routes_rummy._RUMMY_CORE_READY is False
            assert "index unavailable" in routes_rummy._RUMMY_CORE_ERROR

            action = routes_rummy.RummyAction(
                roomId="room-123456", roundId="round-1", actionId="action-123456",
                expectedVersion=0, actionType="HEARTBEAT", actionPayload={}, clientTimestamp=1,
            )
            calls = (
                routes_rummy.rummy_categories({"id": "player-1"}),
                routes_rummy.rummy_join(routes_rummy.JoinRequest(mode="PRACTICE"), {"id": "player-1"}),
                routes_rummy.rummy_room_state("room-123456", {"id": "player-1"}),
                routes_rummy.rummy_action("room-123456", action, {"id": "player-1"}),
            )
            for call in calls:
                try:
                    await call
                except HTTPException as exc:
                    assert exc.status_code == 503
                    assert exc.detail["code"] == "RUMMY_CORE_UNAVAILABLE"
                else:
                    raise AssertionError("a Rummy route opened without its core indexes")
        finally:
            routes_rummy.db = original_db
            routes_rummy._mark_rummy_core_ready_for_tests()

    asyncio.run(scenario())


def test_rummy_core_gate_recovers_after_a_transient_preparation_failure():
    async def scenario():
        attempts = 0

        async def prepare():
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                raise RuntimeError("temporary database outage")

        original_prepare = routes_rummy._ensure_rummy_core_unchecked
        routes_rummy._ensure_rummy_core_unchecked = prepare
        routes_rummy.reset_rummy_core_readiness()
        try:
            try:
                await routes_rummy._require_rummy_core_ready()
            except HTTPException as exc:
                assert exc.status_code == 503
                assert exc.detail["code"] == "RUMMY_CORE_UNAVAILABLE"
            else:
                raise AssertionError("a failed preparation opened the readiness gate")

            routes_rummy._RUMMY_CORE_RETRY_AFTER = 0.0
            await routes_rummy._require_rummy_core_ready()
            assert attempts == 2
            assert routes_rummy._RUMMY_CORE_READY is True
            assert routes_rummy._RUMMY_CORE_ERROR is None
        finally:
            routes_rummy._ensure_rummy_core_unchecked = original_prepare
            routes_rummy._mark_rummy_core_ready_for_tests()

    asyncio.run(scenario())


def test_exact_persisted_groups_control_declare_and_atomic_discard_candidates():
    cards, groups = _fixed_valid_declaration()
    exact = routes_rummy._persisted_group_state({
        "cards": cards, "groups": groups, "drawn": False,
    }, 13)
    assert exact["validation"]["valid"] is True
    assert exact["validation"]["groups"] == [
        "PURE_SEQUENCE", "IMPURE_SEQUENCE", "SET", "PURE_SEQUENCE",
    ]

    extra = _cards()["D2-C-8"]
    drawn = routes_rummy._persisted_group_state({
        "cards": cards + [extra], "groups": groups + [[extra["id"]]],
        "drawn": True, "drawn_card_id": extra["id"], "draw_source": "CLOSED",
    }, 13)
    assert drawn["validation"]["code"] == "DISCARD_REQUIRED"
    assert drawn["declarableDiscardCardIds"] == [extra["id"]]

    picked_open = routes_rummy._persisted_group_state({
        "cards": cards + [extra], "groups": groups + [[extra["id"]]],
        "drawn": True, "drawn_card_id": extra["id"], "draw_source": "DISCARD",
    }, 13)
    assert picked_open["declarableDiscardCardIds"] == []

    seats = [{
        "room_id": "room-exact", "user_id": "player-1", "seat_index": 0,
        "display_name": "You", "status": "ACTIVE", "is_bot": False, "turns_taken": 0,
    }]
    hands = [{
        "room_id": "room-exact", "round_id": "round-exact", "user_id": "player-1",
        "seat_index": 0, "cards": cards, "groups": [], "drawn": False,
    }]
    room = {
        "id": "room-exact", "round_id": "round-exact", "category_id": "LV1",
        "category_snapshot": dict(rummy.RUMMY_CATEGORIES[0]), "mode": "PRACTICE",
        "state": "TURN_ACTIVE", "version": 1, "current_seat": 0,
        "turn_deadline": 9999999999, "closed_deck": [], "discard_pile": [],
        "wild_joker": _cards()["D1-D-13"], "wild_rank": 13, "shuffle_proof": {},
    }
    fake = _PrivacyDb(seats, hands, [], [{"id": "player-1", "chip_balance": 0}])
    original = routes_rummy.db
    routes_rummy.db = fake
    try:
        payload = asyncio.run(routes_rummy._public_state(room, "player-1"))
    finally:
        routes_rummy.db = original
    assert payload["privateState"]["suggestedGroups"]
    assert payload["privateState"]["groupValidation"]["valid"] is False
    assert payload["privateState"]["canDeclare"] is False
    assert payload["privateState"]["dropPenaltyPoints"] == 20


def test_malformed_group_actions_return_stable_errors_without_mutating_the_round():
    async def scenario():
        database, joined, originals = await _install_practice_action_database("rummy_group_validation")
        try:
            room_before = await database.rummy_rooms.find_one({"id": joined["roomId"]}, {"_id": 0})
            hand_before = await database.rummy_hands.find_one(
                {"room_id": joined["roomId"], "user_id": "practice-player"}, {"_id": 0},
            )
            malformed = (
                "not-a-list",
                {"group": []},
                [[{}]],
                [[1]],
                [[]],
            )
            for index, groups in enumerate(malformed):
                action = routes_rummy.RummyAction(
                    roomId=joined["roomId"], roundId=joined["roundId"],
                    actionId=f"malformed-action-{index}", expectedVersion=joined["version"],
                    actionType="DECLARE", actionPayload={"groups": groups}, clientTimestamp=1,
                )
                try:
                    await routes_rummy.rummy_action(joined["roomId"], action, {"id": "practice-player"})
                except HTTPException as exc:
                    assert exc.status_code == 422
                    assert exc.detail["code"] == "RUMMY_GROUP_FORMAT"
                else:
                    raise AssertionError(f"malformed grouping {groups!r} was accepted")

            duplicate = hand_before["cards"][0]["id"]
            duplicate_action = routes_rummy.RummyAction(
                roomId=joined["roomId"], roundId=joined["roundId"],
                actionId="duplicate-action-1", expectedVersion=joined["version"],
                actionType="GROUP", actionPayload={"groups": [[duplicate, duplicate]]},
                clientTimestamp=1,
            )
            try:
                await routes_rummy.rummy_action(
                    joined["roomId"], duplicate_action, {"id": "practice-player"},
                )
            except HTTPException as exc:
                assert exc.status_code == 409
                assert exc.detail["code"] == "RUMMY_GROUP_OWNERSHIP"
            else:
                raise AssertionError("duplicate grouped ownership was accepted")

            room_after = await database.rummy_rooms.find_one({"id": joined["roomId"]}, {"_id": 0})
            hand_after = await database.rummy_hands.find_one(
                {"room_id": joined["roomId"], "user_id": "practice-player"}, {"_id": 0},
            )
            assert room_after == room_before
            assert hand_after == hand_before
            assert await database.rummy_actions.count_documents({}) == 0
        finally:
            _restore_practice_action_database(originals)

    asyncio.run(scenario())


def test_atomic_discard_and_declare_settles_once_and_replays_exact_response():
    async def scenario():
        database, joined, originals = await _install_practice_action_database("rummy_atomic_valid")
        try:
            cards, groups = _fixed_valid_declaration()
            extra = _cards()["D2-C-8"]
            # The fixture below is intentionally authored for wild rank 13.
            # Practice join uses a secure random indicator, so pin only this
            # test room's rule metadata instead of making the assertion depend
            # on whichever rank the shuffle happened to select.
            await database.rummy_rooms.update_one(
                {"id": joined["roomId"]},
                {"$set": {
                    "wild_rank": 13,
                    "wild_joker": _cards()["D2-H-13"],
                }},
            )
            await database.rummy_hands.update_one(
                {"room_id": joined["roomId"], "user_id": "practice-player"},
                {"$set": {
                    "cards": cards + [extra], "groups": groups + [[extra["id"]]],
                    "drawn": True, "drawn_card_id": extra["id"], "draw_source": "CLOSED",
                }},
            )
            action = routes_rummy.RummyAction(
                roomId=joined["roomId"], roundId=joined["roundId"],
                actionId="atomic-declare-valid-1", expectedVersion=joined["version"],
                actionType="DISCARD_AND_DECLARE",
                actionPayload={"cardId": extra["id"], "groups": groups}, clientTimestamp=1,
            )
            stale = action.model_copy(update={
                "actionId": "atomic-declare-stale-1",
                "expectedVersion": joined["version"] - 1,
            })
            try:
                await routes_rummy.rummy_action(
                    joined["roomId"], stale, {"id": "practice-player"},
                )
            except HTTPException as exc:
                assert exc.status_code == 409
                assert exc.detail["code"] == "RUMMY_STALE_VERSION"
            else:
                raise AssertionError("a stale atomic declaration was accepted")
            assert await database.rummy_actions.count_documents({}) == 0

            response = await routes_rummy.rummy_action(
                joined["roomId"], action, {"id": "practice-player"},
            )
            assert response["code"] == "VALID_DECLARATION"
            assert response["state"]["state"] == "ROUND_SETTLED"
            assert response["state"]["result"]["winnerSeat"] == 0
            assert response["state"]["result"]["payoutChips"] == 0
            persisted_hand = await database.rummy_hands.find_one(
                {"room_id": joined["roomId"], "user_id": "practice-player"}, {"_id": 0},
            )
            persisted_room = await database.rummy_rooms.find_one({"id": joined["roomId"]}, {"_id": 0})
            assert len(persisted_hand["cards"]) == rummy.HAND_SIZE
            assert persisted_hand["groups"] == groups
            assert persisted_room["discard_pile"][-1]["id"] == extra["id"]
            assert await database.game_rounds.count_documents({"user_id": "practice-player"}) == 1
            assert (await database.users.find_one({"id": "practice-player"}))["chip_balance"] == 0

            replay = await routes_rummy.rummy_action(
                joined["roomId"], action, {"id": "practice-player"},
            )
            assert replay == response
            assert await database.game_rounds.count_documents({"user_id": "practice-player"}) == 1
            assert await database.rummy_actions.count_documents({"action_id": action.actionId}) == 1
            replay_room = await database.rummy_rooms.find_one({"id": joined["roomId"]}, {"_id": 0})
            assert len(replay_room["discard_pile"]) == len(persisted_room["discard_pile"])
        finally:
            _restore_practice_action_database(originals)

    asyncio.run(scenario())


def test_atomic_invalid_declaration_discards_once_and_applies_configured_penalty():
    async def scenario():
        database, joined, originals = await _install_practice_action_database("rummy_atomic_invalid")
        try:
            cards, _groups = _fixed_valid_declaration()
            extra = _cards()["D2-C-8"]
            await database.rummy_rooms.update_one(
                {"id": joined["roomId"]},
                {"$set": {"turn_count": routes_rummy.MAX_ROUND_TURNS - 2}},
            )
            await database.rummy_hands.update_one(
                {"room_id": joined["roomId"], "user_id": "practice-player"},
                {"$set": {
                    "cards": cards + [extra], "groups": [], "drawn": True,
                    "drawn_card_id": extra["id"], "draw_source": "CLOSED",
                }},
            )
            invalid_groups = [[card["id"] for card in cards]]
            action = routes_rummy.RummyAction(
                roomId=joined["roomId"], roundId=joined["roundId"],
                actionId="atomic-declare-invalid-1", expectedVersion=joined["version"],
                actionType="DISCARD_AND_DECLARE",
                actionPayload={"cardId": extra["id"], "groups": invalid_groups}, clientTimestamp=1,
            )
            response = await routes_rummy.rummy_action(
                joined["roomId"], action, {"id": "practice-player"},
            )
            assert response["code"] == "INVALID_GROUP"
            assert response["state"]["state"] == "TURN_ACTIVE"
            assert response["state"]["currentSeat"] == 1
            seat = await database.rummy_seats.find_one({
                "room_id": joined["roomId"], "user_id": "practice-player",
            })
            persisted_room = await database.rummy_rooms.find_one({"id": joined["roomId"]}, {"_id": 0})
            persisted_hand = await database.rummy_hands.find_one(
                {"room_id": joined["roomId"], "user_id": "practice-player"}, {"_id": 0},
            )
            assert seat["status"] == "DROPPED"
            assert seat["drop_points"] == rummy.RUMMY_CATEGORIES[0]["invalidDeclarationPoints"]
            assert "active_user_key" not in seat
            assert len(persisted_hand["cards"]) == rummy.HAND_SIZE
            assert persisted_room["discard_pile"][-1]["id"] == extra["id"]
            assert persisted_room["turn_count"] == routes_rummy.MAX_ROUND_TURNS - 1

            replay = await routes_rummy.rummy_action(
                joined["roomId"], action, {"id": "practice-player"},
            )
            assert replay == response
            replay_room = await database.rummy_rooms.find_one({"id": joined["roomId"]}, {"_id": 0})
            assert len(replay_room["discard_pile"]) == len(persisted_room["discard_pile"])
            assert await database.rummy_actions.count_documents({"action_id": action.actionId}) == 1

            original_best_arrangement = routes_rummy._best_arrangement
            original_think_delay = routes_rummy._bot_think_delay_seconds
            original_discard_delay = routes_rummy._bot_discard_delay_seconds

            async def fixed_non_winning_arrangement(cards, _wild_rank):
                return {
                    "valid": False, "score": len(cards),
                    "groups": [], "ungroupedCardIds": [card["id"] for card in cards],
                }

            routes_rummy._best_arrangement = fixed_non_winning_arrangement
            routes_rummy._bot_think_delay_seconds = lambda _level: 0
            routes_rummy._bot_discard_delay_seconds = lambda _level: 0
            try:
                advanced = False
                for _ in range(3):
                    advanced = await routes_rummy._advance_one_automatic(
                        joined["roomId"], "practice-player",
                    ) or advanced
            finally:
                routes_rummy._best_arrangement = original_best_arrangement
                routes_rummy._bot_think_delay_seconds = original_think_delay
                routes_rummy._bot_discard_delay_seconds = original_discard_delay
            assert advanced is True
            limit_room = await database.rummy_rooms.find_one({"id": joined["roomId"]}, {"_id": 0})
            assert limit_room["state"] == "ROUND_SETTLED"
            assert limit_room["result"]["reason"] == "TURN_LIMIT_LOWEST_SCORE"
        finally:
            _restore_practice_action_database(originals)

    asyncio.run(scenario())
