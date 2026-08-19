"""Contract tests for the reference-matched live Keno table."""
from math import comb

from game_engines import KENO_PAYTABLE
from live_engines import generate_outcome, limits_for, settle_bet, summarize_outcome, validate_selection


def test_reference_paytable_and_limits():
    assert limits_for("keno") == (10, 1000)
    assert KENO_PAYTABLE[1] == {1: 2.51}
    assert KENO_PAYTABLE[4] == {1: 0.36, 2: 1.31, 3: 3.02, 4: 15.12}
    assert KENO_PAYTABLE[10] == {
        1: 0.00, 2: 0.00, 3: 1.00, 4: 1.50, 5: 3.30,
        6: 10.20, 7: 25.00, 8: 40.00, 9: 75.00, 10: 100.00,
    }


def test_reference_return_profile_is_explicit_and_stable():
    denominator = comb(36, 10)
    for picks, table in KENO_PAYTABLE.items():
        expected_return = sum(
            comb(picks, hits) * comb(36 - picks, 10 - hits) / denominator * payout
            for hits, payout in table.items()
        )
        if picks == 10:
            assert 0.970 <= expected_return <= 0.971
        else:
            assert 0.695 <= expected_return <= 0.702


def test_selection_validation_and_settlement():
    selection = validate_selection("keno", [22, 1, 15])
    assert selection == [1, 15, 22]
    outcome = {"drawn": [22, 15, 4, 8, 12, 16, 20, 24, 28, 32]}
    payout, detail = settle_bet("keno", outcome, selection, 10)
    assert payout == 17
    assert detail == {"matches": [15, 22], "multiplier": 1.66}


def test_reference_five_hit_win_is_exactly_thirty_three_on_ten_chips():
    selection = list(range(1, 11))
    outcome = {"drawn": [1, 2, 3, 4, 5, 20, 21, 22, 23, 24]}
    payout, detail = settle_bet("keno", outcome, selection, 10)
    assert payout == 33
    assert detail == {"matches": [1, 2, 3, 4, 5], "multiplier": 3.30}


def test_live_draw_has_ten_unique_ordered_events_and_full_history_summary():
    for _ in range(30):
        outcome = generate_outcome("keno")
        assert len(outcome["drawn"]) == 10
        assert len(set(outcome["drawn"])) == 10
        assert all(1 <= number <= 36 for number in outcome["drawn"])
        assert summarize_outcome("keno", outcome) == outcome
