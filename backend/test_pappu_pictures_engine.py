import os
import sys

import pytest
from fastapi import HTTPException

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from live_engines import (  # noqa: E402
    PICTURE_SYMBOLS,
    generate_outcome,
    limits_for,
    settle_bet,
    summarize_outcome,
    validate_selection,
)


def test_picture_table_limits_and_selection_contract():
    assert limits_for("pappu-pictures") == (10, 200)
    assert validate_selection("pappu-pictures", "butterfly") == "butterfly"
    with pytest.raises(HTTPException):
        validate_selection("pappu-pictures", "not-a-picture")


def test_normal_and_extra_pay_settlement():
    normal = {"symbol": "rose", "multiplier": 8, "extra_pay": False, "boosts": {}}
    assert settle_bet("pappu-pictures", normal, "rose", 20)[0] == 160
    assert settle_bet("pappu-pictures", normal, "rabbit", 20)[0] == 0

    extra = {"symbol": "rabbit", "multiplier": 50, "extra_pay": True, "boosts": {"rabbit": 50}}
    payout, detail = settle_bet("pappu-pictures", extra, "rabbit", 20)
    assert payout == 1000
    assert detail == {
        "result": "win",
        "symbol": "rabbit",
        "multiplier": 50,
        "extra_pay": True,
    }


def test_generated_outcomes_are_complete_and_summarizable():
    for _ in range(500):
        outcome = generate_outcome("pappu-pictures")
        assert outcome["symbol"] in PICTURE_SYMBOLS
        assert outcome["multiplier"] in {8, 20, 30, 50, 100, 200}
        assert isinstance(outcome["extra_pay"], bool)
        if outcome["extra_pay"]:
            assert len(outcome["boosts"]) == 5
            assert outcome["multiplier"] == outcome["boosts"].get(outcome["symbol"], 8)
        else:
            assert outcome["boosts"] == {}
            assert outcome["multiplier"] == 8
        assert summarize_outcome("pappu-pictures", outcome) == {
            "symbol": outcome["symbol"],
            "multiplier": outcome["multiplier"],
            "extra_pay": outcome["extra_pay"],
        }
