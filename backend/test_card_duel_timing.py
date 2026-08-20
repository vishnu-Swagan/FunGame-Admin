"""Timing contracts for the synchronized Teen Patti and Poker tables."""

import pytest

from live_engines import (
    LIVE_GAMES,
    betting_mutation_open,
    cycle_seconds,
    fixed_cycle_clock,
)


@pytest.mark.parametrize(
    ("slug", "reveal_seconds", "result_seconds", "round_seconds"),
    (
        ("teen-patti", 12, 36, 78),
        ("poker", 14, 36, 80),
    ),
)
def test_card_duel_betting_window_is_exactly_thirty_seconds(
    slug, reveal_seconds, result_seconds, round_seconds
):
    assert LIVE_GAMES[slug] == {
        "bet": 30,
        "reveal": reveal_seconds,
        "result": result_seconds,
        "kind": "sides",
    }
    assert cycle_seconds(slug) == round_seconds


@pytest.mark.parametrize(
    ("slug", "reveal_seconds", "result_seconds", "round_seconds"),
    (
        ("teen-patti", 12, 36, 78),
        ("poker", 14, 36, 80),
    ),
)
def test_card_duel_clock_switches_phase_at_server_owned_boundaries(
    slug, reveal_seconds, result_seconds, round_seconds
):
    cfg = LIVE_GAMES[slug]

    def clock(now):
        return fixed_cycle_clock(now, cfg["bet"], cfg["reveal"], cfg["result"])

    reveal_end = 30 + reveal_seconds

    assert clock(29.99)[1:3] == ("BETTING", 0.01)
    assert clock(30.00)[1:3] == ("REVEAL", float(reveal_seconds))
    assert clock(reveal_end - 0.01)[1:3] == ("REVEAL", 0.01)
    assert clock(reveal_end)[1:3] == ("RESULT", float(result_seconds))
    assert clock(round_seconds - 0.01)[1:3] == ("RESULT", 0.01)
    assert clock(round_seconds)[:3] == (1, "BETTING", 30.0)


@pytest.mark.parametrize(
    ("slug", "legacy_bet_seconds"),
    (("teen-patti", 60), ("poker", 60)),
)
def test_card_duel_round_ids_remain_continuous_across_timing_release(
    slug, legacy_bet_seconds
):
    """Shortening betting must not reinterpret any stored epoch round ID."""
    cfg = LIVE_GAMES[slug]
    legacy_total = legacy_bet_seconds + cfg["reveal"] + 6
    assert cycle_seconds(slug) == legacy_total

    for round_number in (1, 1_000, 20_000_000):
        boundary = round_number * legacy_total
        assert fixed_cycle_clock(
            boundary - 0.01, cfg["bet"], cfg["reveal"], cfg["result"]
        )[0] == round_number - 1
        assert fixed_cycle_clock(
            boundary, cfg["bet"], cfg["reveal"], cfg["result"]
        )[0] == round_number


@pytest.mark.parametrize("slug", ("teen-patti", "poker"))
def test_card_duel_server_mutations_lock_before_thirty_second_boundary(slug):
    cfg = LIVE_GAMES[slug]

    for now, expected in ((29.59, True), (29.60, False), (29.99, False), (30.0, False)):
        round_number, phase, seconds_left, *_ = fixed_cycle_clock(
            now, cfg["bet"], cfg["reveal"], cfg["result"]
        )
        assert betting_mutation_open(
            phase, seconds_left, round_number, expected_round=0, guard=0.4
        ) is expected
