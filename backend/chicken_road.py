"""Chicken Road — per-player 'cross the road' crash game.

Place a bet, pick a difficulty, then step the chicken across lanes one at a
time. Every lane crossed raises the multiplier; every lane also carries a
collision chance. Cash out any time to bank the current multiplier — but step
onto a truck and you lose the bet. Secure server RNG, provably fixed at start.

Math: after n safe crossings the multiplier is  M_n = RTP / p**n , where p is
the per-lane survival probability. Cashing out at ANY lane has the same
expected value (p**n * M_n = RTP), so the house edge is exactly 1 - RTP no
matter how the player plays — the thrill comes purely from variance.
"""
from game_engines import RNG

# per-lane survival prob p, target RTP, and road length (lanes). Tuned so Easy's
# first step is ~1.03x (matching the reference) and Hardcore tops a few-thousand x.
CR_DIFF = {
    "easy":     {"p": 0.955, "rtp": 0.98, "lanes": 24, "label": "Easy"},
    "medium":   {"p": 0.880, "rtp": 0.98, "lanes": 22, "label": "Medium"},
    "hard":     {"p": 0.750, "rtp": 0.98, "lanes": 18, "label": "Hard"},
    "hardcore": {"p": 0.550, "rtp": 0.97, "lanes": 14, "label": "Hardcore"},
}
CR_ORDER = ("easy", "medium", "hard", "hardcore")


def cr_multipliers(diff):
    """Multiplier banked after crossing lane 1..lanes (index 0 == lane 1)."""
    c = CR_DIFF[diff]
    return [round(c["rtp"] / (c["p"] ** n), 2) for n in range(1, c["lanes"] + 1)]


def cr_config():
    """Everything the client needs to render the board before a bet."""
    return {
        d: {
            "label": CR_DIFF[d]["label"],
            "lanes": CR_DIFF[d]["lanes"],
            "collision_pct": round((1 - CR_DIFF[d]["p"]) * 100, 1),
            "multipliers": cr_multipliers(d),
        }
        for d in CR_ORDER
    }


def cr_generate_crash(diff):
    """Fix the run at start: the first lane index (1-based) that is a truck, or
    lanes+1 if the chicken can cross the whole road safely."""
    c = CR_DIFF[diff]
    for lane in range(1, c["lanes"] + 1):
        if RNG.random() > c["p"]:
            return lane
    return c["lanes"] + 1
