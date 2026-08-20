"""Contract tests for the reference-matched live Keno table."""
from math import comb

from game_engines import KENO_PAYTABLE
from live_engines import LIVE_GAMES, betting_mutation_open, cycle_seconds, fixed_cycle_clock, generate_outcome, limits_for, settle_bet, summarize_outcome, validate_selection


def test_reference_paytable_and_limits():
    assert limits_for("keno") == (10, 1000)
    assert KENO_PAYTABLE[1] == {1: 2.51}
    assert KENO_PAYTABLE[4] == {1: 0.36, 2: 1.31, 3: 3.02, 4: 15.12}
    assert KENO_PAYTABLE[10] == {
        1: 0.00, 2: 0.00, 3: 1.00, 4: 1.50, 5: 3.30,
        6: 10.20, 7: 25.00, 8: 40.00, 9: 75.00, 10: 100.00,
    }


def test_round_is_one_minute_and_bets_close_at_half_time():
    assert LIVE_GAMES["keno"] == {"bet": 30, "reveal": 20, "result": 10, "kind": "picks"}
    assert cycle_seconds("keno") == 60


def test_server_mutation_guard_closes_the_final_fraction_of_a_second():
    assert betting_mutation_open("BETTING", 0.41, 42, expected_round=42)
    assert not betting_mutation_open("BETTING", 0.40, 42, expected_round=42)
    assert not betting_mutation_open("REVEAL", 20, 42, expected_round=42)
    assert not betting_mutation_open("BETTING", 20, 43, expected_round=42)


def test_keno_clock_exact_phase_boundaries():
    cfg = LIVE_GAMES["keno"]

    def clock(now):
        return fixed_cycle_clock(now, cfg["bet"], cfg["reveal"], cfg["result"])

    assert clock(29.99)[1:3] == ("BETTING", 0.01)
    assert clock(30.00)[1:3] == ("REVEAL", 20.0)
    assert clock(49.99)[1:3] == ("REVEAL", 0.01)
    assert clock(50.00)[1:3] == ("RESULT", 10.0)
    assert clock(59.99)[1:3] == ("RESULT", 0.01)
    assert clock(60.00)[:3] == (1, "BETTING", 30.0)


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
