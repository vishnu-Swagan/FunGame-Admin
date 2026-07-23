"""Universal live-round engines: one outcome per round, shared by ALL users.

Rounds are derived from epoch time (24/7). Outcomes are generated once per
(game, round) with a secure RNG and stored so every player sees the same result.
Player-specific randomness (bingo cards) is created at bet time.
"""
from fastapi import HTTPException
from game_engines import (
    RNG, new_deck, draw_cards, card_str, eval_poker5, eval_teen_patti, TP_LABELS,
    vp_result, play_slot, play_no_hold, play_checker, play_andar_bahar,
    play_giant_jackpot, play_fever_joker, play_lucky8, play_triple_fun, play_joker_bonus, KENO_PAYTABLE, WHEEL_SEGMENTS, weighted_choice,
    ice_fishing_round, settle_ice_fishing, IF_LAYOUT, IF_SPOTS, IF_FISH_RANGE,
)

POKER_LABELS = {9: "Royal Flush", 8: "Straight Flush", 7: "Four of a Kind", 6: "Full House",
                5: "Flush", 4: "Straight", 3: "Three of a Kind", 2: "Two Pair", 1: "Pair", 0: "High Card"}


def bad(msg):
    raise HTTPException(status_code=400, detail=msg)


# ---------------- Cycle configuration (seconds) ----------------
# phase order: BETTING -> REVEAL (animation) -> RESULT, then next round
LIVE_GAMES = {
    "seven-up-down":     {"bet": 13, "reveal": 4, "result": 3, "kind": "sides"},
    "fun-target":        {"bet": 13, "reveal": 4, "result": 3, "kind": "pick"},
    "super-golden-wheel": {"bet": 13, "reveal": 5, "result": 3, "kind": "stake"},
    "checker":           {"bet": 13, "reveal": 4, "result": 3, "kind": "sides"},
    "teen-patti":        {"bet": 15, "reveal": 12, "result": 6, "kind": "sides"},
    "poker":             {"bet": 15, "reveal": 14, "result": 6, "kind": "sides"},
    "no-hold":           {"bet": 14, "reveal": 8, "result": 5, "kind": "stake"},
    "champion-poker":    {"bet": 15, "reveal": 14, "result": 6, "kind": "stake"},
    "andar-bahar":       {"bet": 15, "reveal": 16, "result": 5, "kind": "sides"},
    "keno":              {"bet": 20, "reveal": 6, "result": 4, "kind": "picks"},
    "bingo":             {"bet": 20, "reveal": 6, "result": 4, "kind": "stake"},
    "fever-joker-bonus": {"bet": 12, "reveal": 5, "result": 3, "kind": "stake"},
    "giant-jackpot":     {"bet": 12, "reveal": 5, "result": 3, "kind": "stake"},
    "joker-bonus":       {"bet": 12, "reveal": 5, "result": 3, "kind": "stake"},
    "lucky-8-line":      {"bet": 12, "reveal": 5, "result": 3, "kind": "stake"},
    "triple-fun":        {"bet": 12, "reveal": 5, "result": 3, "kind": "stake"},
    # reveal = multiplier-drop (~4s) + wheel spin (~8s); result = leaf payout or the cinematic fish bonus
    "ice-fishing":       {"bet": 14, "reveal": 12, "result": 10, "kind": "spots"},
}

SLOT_SLUGS = set()  # every slot now has its own weighted-reel engine

SIDE_OPTIONS = {
    "seven-up-down": {"down": 2.0, "seven": 5.0, "up": 2.0},
    "checker": {"gold": 1.4, "steel": 1.4},
    # Real casino Andar Bahar: Andar is dealt first (wins ~51.5%) so it pays
    # 0.9:1 (1.9x); Bahar pays 1:1 (2.0x). House edge ~2.15% Andar / 3% Bahar.
    "andar-bahar": {"andar": 1.9, "bahar": 2.0},
    # House-favorable ~70% RTP: Player/Dealer pay 1.40x, and a tie is a house
    # win for Player/Dealer bets (see settle_bet). Only the explicit Tie bet
    # wins on a tie.
    "teen-patti": {"player": 1.40, "dealer": 1.40, "tie": 6},
    "poker": {"player": 1.40, "dealer": 1.40, "tie": 15},
    # Ice Fishing carries its wheel layout + spot metadata here so the client
    # renders the exact same 53-segment wheel the server settles against.
    "ice-fishing": {"layout": IF_LAYOUT, "spots": list(IF_SPOTS), "fish_range": IF_FISH_RANGE},
}


def cycle_seconds(slug):
    c = LIVE_GAMES[slug]
    return c["bet"] + c["reveal"] + c["result"]


# ---------------- Universal outcome generators ----------------
def _gen_duel(game):
    deck = new_deck()
    n = 3 if game == "teen-patti" else 5
    player = draw_cards(n, deck)
    dealer = draw_cards(n, deck)
    if game == "teen-patti":
        pe, de = eval_teen_patti(player), eval_teen_patti(dealer)
        pl, dl = TP_LABELS[pe[0]], TP_LABELS[de[0]]
    else:
        pe, de = eval_poker5(player), eval_poker5(dealer)
        pl, dl = POKER_LABELS[pe[0]], POKER_LABELS[de[0]]
    winner = "player" if pe > de else ("dealer" if pe < de else "tie")
    return {
        "player": [card_str(c) for c in player], "dealer": [card_str(c) for c in dealer],
        "player_hand": pl, "dealer_hand": dl, "winner": winner,
    }


def _gen_champion():
    deck = new_deck()
    hand = draw_cards(5, deck)
    # auto-hold: keep paired ranks; otherwise keep J/Q/K/A
    counts = {}
    for r, s in hand:
        counts[r] = counts.get(r, 0) + 1
    holds = [counts[c[0]] >= 2 for c in hand]
    if not any(holds):
        holds = [c[0] >= 11 for c in hand]
    final = [hand[i] if holds[i] else draw_cards(1, deck)[0] for i in range(5)]
    label, mult = vp_result(final)
    return {
        "initial": [card_str(c) for c in hand], "holds": holds,
        "cards": [card_str(c) for c in final], "hand": label, "multiplier": mult,
    }


def generate_outcome(slug):
    if slug == "seven-up-down":
        d1, d2 = RNG.randint(1, 6), RNG.randint(1, 6)
        total = d1 + d2
        # True 7Up7Down: 2-6 = Down, 8-12 = Up, exactly 7 = Seven (Up and Down
        # lose on a 7 — the natural house edge). Fair secure-RNG dice.
        winner = "seven" if total == 7 else ("up" if total > 7 else "down")
        return {"dice": [d1, d2], "total": total, "winner": winner}
    if slug == "fun-target":
        return {"result": RNG.randint(0, 9)}
    if slug == "super-golden-wheel":
        return {"multiplier": weighted_choice([(s["m"], s["w"]) for s in WHEEL_SEGMENTS])}
    if slug == "ice-fishing":
        return ice_fishing_round()
    if slug == "giant-jackpot":
        outcome, _ = play_giant_jackpot(1, {})
        return outcome
    if slug == "fever-joker-bonus":
        outcome, _ = play_fever_joker(1, {})
        return outcome
    if slug == "lucky-8-line":
        outcome, _ = play_lucky8(1, {})
        return outcome
    if slug == "triple-fun":
        outcome, _ = play_triple_fun(1, {})
        return outcome
    if slug == "joker-bonus":
        outcome, _ = play_joker_bonus(1, {})
        return outcome
    if slug in SLOT_SLUGS:
        outcome, _ = play_slot(slug, 1, {})
        return outcome
    if slug == "no-hold":
        outcome, _ = play_no_hold(1, {})
        return outcome
    if slug == "champion-poker":
        return _gen_champion()
    if slug in ("teen-patti", "poker"):
        return _gen_duel(slug)
    if slug == "checker":
        o, _ = play_checker(1, {"side": "gold"})
        return {"rounds": o["rounds"], "gold": o["gold"], "steel": o["steel"], "winner": o["winner"], "pieces": o["pieces"]}
    if slug == "andar-bahar":
        o, _ = play_andar_bahar(1, {"side": "andar"})
        return {"joker": o["joker"], "sequence": o["sequence"], "winner": o["winner"]}
    if slug == "keno":
        return {"drawn": sorted(RNG.sample(range(1, 37), 10))}
    if slug == "bingo":
        return {"drawn": sorted(RNG.sample(range(1, 76), 30))}
    raise ValueError(f"No live outcome generator for {slug}")


# ---------------- Selection validation (at bet time) ----------------
def validate_selection(slug, selection):
    kind = LIVE_GAMES[slug]["kind"]
    if kind == "sides":
        if selection not in SIDE_OPTIONS[slug]:
            bad(f"Pick one of: {', '.join(SIDE_OPTIONS[slug].keys())}")
        return selection
    if kind == "pick":  # fun-target
        if not isinstance(selection, int) or selection < 0 or selection > 9:
            bad("Pick a number from 0 to 9")
        return selection
    if kind == "spots":  # ice-fishing multi-bet spots
        if selection not in IF_SPOTS:
            bad(f"Pick one of: {', '.join(IF_SPOTS)}")
        return selection
    if kind == "picks":  # keno
        if not isinstance(selection, list) or not (1 <= len(selection) <= 10):
            bad("Pick between 1 and 10 numbers")
        if len(set(selection)) != len(selection) or any(not isinstance(p, int) or p < 1 or p > 36 for p in selection):
            bad("Picks must be unique numbers 1-36")
        return sorted(selection)
    return None  # stake-only


def make_bingo_card():
    card = []
    for col in range(5):
        lo, hi = col * 15 + 1, col * 15 + 15
        card.append(RNG.sample(range(lo, hi + 1), 5))
    grid = [[card[c][r] for c in range(5)] for r in range(5)]
    grid[2][2] = 0
    return grid


def count_bingo_lines(grid, drawn):
    dset = set(drawn)
    marked = [[(grid[r][c] == 0 or grid[r][c] in dset) for c in range(5)] for r in range(5)]
    lines = 0
    for r in range(5):
        if all(marked[r]):
            lines += 1
    for c in range(5):
        if all(marked[r][c] for r in range(5)):
            lines += 1
    if all(marked[i][i] for i in range(5)):
        lines += 1
    if all(marked[i][4 - i] for i in range(5)):
        lines += 1
    return lines


BINGO_TABLE = {0: 0, 1: 4, 2: 13, 3: 36, 4: 118}  # house-favorable ~70% RTP


# ---------------- Settlement: bet + universal outcome -> payout ----------------
def settle_bet(slug, outcome, selection, amount, card=None):
    """Returns (payout:int, detail:dict)."""
    kind = LIVE_GAMES[slug]["kind"]
    if kind == "sides":
        winner = outcome["winner"]
        mults = SIDE_OPTIONS[slug]
        # Tougher: a tie is a HOUSE win — Player/Dealer bets lose on a tie
        # (only the explicit Tie bet wins). Raises the ~2.5% edge to ~5%.
        if selection == winner:
            return int(round(amount * mults[selection])), {"result": "win"}
        return 0, {"result": "lose"}
    if kind == "pick":
        won = selection == outcome["result"]
        return (amount * 7 if won else 0), {"result": "win" if won else "lose"}
    if kind == "spots":  # ice-fishing
        payout = settle_ice_fishing(outcome, selection, amount)
        return payout, {"spot": selection, "win_type": outcome["win_type"], "result": "win" if payout > 0 else "lose"}
    if kind == "picks":
        matches = sorted(set(selection) & set(outcome["drawn"]))
        mult = KENO_PAYTABLE[len(selection)].get(len(matches), 0)
        return int(round(amount * mult)), {"matches": matches, "multiplier": mult}
    # stake-only
    if slug == "bingo":
        lines = count_bingo_lines(card, outcome["drawn"])
        mult = 1000 if lines >= 12 else (400 if lines >= 5 else BINGO_TABLE.get(lines, 0))
        return amount * mult, {"lines": lines, "multiplier": mult}
    mult = outcome.get("multiplier", 0)
    return int(round(amount * mult)), {"multiplier": mult}


def summarize_outcome(slug, outcome):
    """Compact summary for last-results strips."""
    if slug == "seven-up-down":
        return {"total": outcome["total"], "winner": outcome["winner"]}
    if slug == "fun-target":
        return {"result": outcome["result"]}
    if slug == "ice-fishing":
        return {"win_type": outcome["win_type"], "fish": outcome.get("fish_final")}
    if slug in ("teen-patti", "poker", "checker", "andar-bahar"):
        return {"winner": outcome["winner"]}
    if slug == "keno":
        return {"drawn": outcome["drawn"][:5]}
    if slug == "bingo":
        return {"balls": len(outcome["drawn"])}
    if slug == "giant-jackpot":
        return {"multiplier": outcome.get("multiplier", 0), "jackpot": outcome.get("jackpot", False)}
    if slug == "fever-joker-bonus":
        return {"multiplier": outcome.get("multiplier", 0), "fever": outcome.get("fever", 1)}
    return {"multiplier": outcome.get("multiplier", 0)}
