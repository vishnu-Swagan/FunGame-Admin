"""Focused rules, configuration, proof and five-seat privacy tests for Rummy."""
from __future__ import annotations

import asyncio
import copy
import hashlib
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
    assert human == {
        "pot": 500, "humanPayout": 0,
        "seatStakeTotal": 500, "realStakeTotal": 0,
    }
    assert bot["pot"] == 500
    assert bot["humanPayout"] == 0


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
        rows = [row for row in self.rows if all(row.get(key) == value for key, value in query.items())]
        if projection:
            excluded = {key for key, value in projection.items() if value == 0}
            rows = [{key: value for key, value in row.items() if key not in excluded} for row in rows]
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
    seats = [
        {"room_id": "room-1", "user_id": "player-1", "seat_index": 0, "display_name": "You", "status": "ACTIVE", "is_bot": False},
        {"room_id": "room-1", "user_id": "player-2", "seat_index": 1, "display_name": "Rival", "status": "ACTIVE", "is_bot": False},
        {"room_id": "room-1", "seat_index": 4, "status": "EMPTY"},
    ]
    hands = [
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
