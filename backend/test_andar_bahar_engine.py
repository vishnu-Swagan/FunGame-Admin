"""Contract tests for the live Andar Bahar table and reference side bets."""

import game_engines
from live_engines import SIDE_OPTIONS, TABLE_LIMITS, generate_outcome, settle_bet, summarize_outcome


def test_reference_side_and_card_count_prices():
    assert TABLE_LIMITS["andar-bahar"] == (20, 1000)
    assert SIDE_OPTIONS["andar-bahar"] == {
        "andar": 2.0,
        "bahar": 1.9,
        "count_1_5": 3.5,
        "count_6_10": 4.5,
        "count_11_15": 5.5,
        "count_16_25": 4.5,
        "count_26_30": 5.0,
        "count_31_35": 25.0,
        "count_36_40": 50.0,
        "count_41_49": 120.0,
    }


def test_side_and_card_count_bets_settle_independently():
    outcome = {
        "joker": "8d",
        "winner": "andar",
        "sequence": [{"card": f"{rank}s", "side": "andar"} for rank in range(7)],
    }
    assert settle_bet("andar-bahar", outcome, "andar", 100)[0] == 200
    assert settle_bet("andar-bahar", outcome, "bahar", 100)[0] == 0
    assert settle_bet("andar-bahar", outcome, "count_6_10", 100)[0] == 450
    assert settle_bet("andar-bahar", outcome, "count_1_5", 100)[0] == 0


def test_generated_round_has_valid_alternating_sequence_and_count_range():
    for _ in range(40):
        outcome = generate_outcome("andar-bahar")
        assert 1 <= len(outcome["sequence"]) <= 49
        assert outcome["sequence"][-1]["side"] == outcome["winner"]
        assert all(
            row["side"] == ("bahar" if index % 2 == 0 else "andar")
            for index, row in enumerate(outcome["sequence"])
        )


def test_history_summary_carries_winner_and_exact_card_count():
    outcome = generate_outcome("andar-bahar")
    assert summarize_outcome("andar-bahar", outcome) == {
        "winner": outcome["winner"],
        "card_count": len(outcome["sequence"]),
    }


def test_full_49_card_tail_is_preserved_for_longest_side_bet(monkeypatch):
    class TailMatchRng:
        first = True

        def sample(self, deck, _count):
            if self.first:
                self.first = False
                return [next(card for card in deck if card[0] == 2)]
            return [next((card for card in deck if card[0] != 2), deck[0])]

    monkeypatch.setattr(game_engines, "RNG", TailMatchRng())
    outcome = generate_outcome("andar-bahar")
    assert len(outcome["sequence"]) == 49
    assert outcome["winner"] == "bahar"
    assert settle_bet("andar-bahar", outcome, "count_41_49", 100)[0] == 12000
