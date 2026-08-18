"""Contract tests for the live 7 Up 7 Down table."""
from live_engines import SIDE_OPTIONS, generate_outcome, limits_for, settle_bet, summarize_outcome


def test_reference_odds_and_limits():
    assert limits_for("seven-up-down") == (10, 200)
    assert SIDE_OPTIONS["seven-up-down"] == {
        "down": 2.0, "seven": 5.0, "up": 2.0,
        "t2": 27.0, "t3": 13.0, "t4": 9.0, "t5": 7.0, "t6": 6.0,
        "t8": 6.0, "t9": 7.0, "t10": 9.0, "t11": 13.0, "t12": 27.0,
    }


def test_side_and_exact_total_settlement_are_independent():
    outcome = {"dice": [2, 6], "total": 8, "winner": "up"}
    assert settle_bet("seven-up-down", outcome, "up", 10)[0] == 20
    assert settle_bet("seven-up-down", outcome, "t8", 10)[0] == 60
    assert settle_bet("seven-up-down", outcome, "down", 10)[0] == 0
    assert settle_bet("seven-up-down", outcome, "seven", 10)[0] == 0


def test_seven_loses_both_sides_and_pays_blue_zone():
    outcome = {"dice": [3, 4], "total": 7, "winner": "seven"}
    assert settle_bet("seven-up-down", outcome, "down", 20)[0] == 0
    assert settle_bet("seven-up-down", outcome, "up", 20)[0] == 0
    assert settle_bet("seven-up-down", outcome, "seven", 20)[0] == 100


def test_generated_round_and_roadmap_summary_have_two_valid_dice():
    for _ in range(50):
        outcome = generate_outcome("seven-up-down")
        d1, d2 = outcome["dice"]
        assert 1 <= d1 <= 6 and 1 <= d2 <= 6
        assert outcome["total"] == d1 + d2
        expected = "seven" if d1 + d2 == 7 else ("up" if d1 + d2 > 7 else "down")
        assert outcome["winner"] == expected
        assert summarize_outcome("seven-up-down", outcome) == outcome
