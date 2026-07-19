"""Server-authoritative game engines for FunGame.

All outcomes are generated server-side with a cryptographically secure RNG.
Clients only submit bets/selections - never outcomes.
All payouts are integer play chips. PLAY CHIPS - NO CASH VALUE.
"""
import secrets
import math
from fastapi import HTTPException

RNG = secrets.SystemRandom()

MIN_BET = 10
MAX_BET = 100000

SUITS = ["S", "H", "D", "C"]
RANKS = list(range(2, 15))  # 11=J 12=Q 13=K 14=A


def new_deck():
    return [(r, s) for r in RANKS for s in SUITS]


def draw_cards(n, deck=None):
    d = deck if deck is not None else new_deck()
    picked = RNG.sample(d, n)
    for c in picked:
        d.remove(c)
    return picked


def card_str(c):
    names = {11: "J", 12: "Q", 13: "K", 14: "A"}
    return f"{names.get(c[0], c[0])}{c[1]}"


def bad(msg):
    raise HTTPException(status_code=400, detail=msg)


# ---------------- Poker hand evaluation (5-card) ----------------
def eval_poker5(cards):
    """Returns (category, tiebreak...) - higher tuple wins.
    9 royal, 8 straight flush, 7 quads, 6 full house, 5 flush,
    4 straight, 3 trips, 2 two pair, 1 pair, 0 high card."""
    ranks = sorted([c[0] for c in cards], reverse=True)
    suits = [c[1] for c in cards]
    flush = len(set(suits)) == 1
    counts = {}
    for r in ranks:
        counts[r] = counts.get(r, 0) + 1
    groups = sorted(counts.items(), key=lambda kv: (kv[1], kv[0]), reverse=True)
    uniq = sorted(counts.keys(), reverse=True)
    straight_high = None
    if len(uniq) == 5:
        if uniq[0] - uniq[4] == 4:
            straight_high = uniq[0]
        elif uniq == [14, 5, 4, 3, 2]:
            straight_high = 5
    if flush and straight_high == 14:
        return (9, 14)
    if flush and straight_high:
        return (8, straight_high)
    if groups[0][1] == 4:
        return (7, groups[0][0], groups[1][0])
    if groups[0][1] == 3 and groups[1][1] == 2:
        return (6, groups[0][0], groups[1][0])
    if flush:
        return (5, *ranks)
    if straight_high:
        return (4, straight_high)
    if groups[0][1] == 3:
        kick = [r for r in ranks if r != groups[0][0]]
        return (3, groups[0][0], *kick)
    if groups[0][1] == 2 and groups[1][1] == 2:
        kick = [r for r in ranks if counts[r] == 1]
        return (2, max(groups[0][0], groups[1][0]), min(groups[0][0], groups[1][0]), *kick)
    if groups[0][1] == 2:
        kick = [r for r in ranks if r != groups[0][0]]
        return (1, groups[0][0], *kick)
    return (0, *ranks)


VP_PAYTABLE = [
    (9, "ROYAL FLUSH", 300), (8, "STRAIGHT FLUSH", 60), (7, "FOUR OF A KIND", 30),
    (6, "FULL HOUSE", 10), (5, "FLUSH", 7), (4, "STRAIGHT", 5),
    (3, "THREE OF A KIND", 4), (2, "TWO PAIR", 3),
]


def vp_result(cards):
    """Video poker: returns (label, multiplier)."""
    ev = eval_poker5(cards)
    for cat, label, mult in VP_PAYTABLE:
        if ev[0] == cat:
            return label, mult
    if ev[0] == 1 and ev[1] >= 11:
        return "JACKS OR BETTER", 2
    return "NO WIN", 0


# ---------------- Teen Patti (3-card) evaluation ----------------
def eval_teen_patti(cards):
    ranks = sorted([c[0] for c in cards], reverse=True)
    suits = [c[1] for c in cards]
    flush = len(set(suits)) == 1
    uniq = sorted(set(ranks), reverse=True)
    seq_high = None
    if len(uniq) == 3:
        if uniq[0] - uniq[2] == 2 and uniq[0] - uniq[1] == 1:
            seq_high = uniq[0]
        elif uniq == [14, 3, 2]:
            seq_high = 3
    if ranks[0] == ranks[2]:
        return (6, ranks[0])  # trail
    if flush and seq_high:
        return (5, seq_high)  # pure sequence
    if seq_high:
        return (4, seq_high)  # sequence
    if flush:
        return (3, *ranks)  # color
    if ranks[0] == ranks[1] or ranks[1] == ranks[2]:
        pair = ranks[1]
        kicker = ranks[0] if ranks[1] == ranks[2] else ranks[2]
        return (2, pair, kicker)
    return (1, *ranks)


TP_LABELS = {6: "Trail", 5: "Pure Sequence", 4: "Sequence", 3: "Color", 2: "Pair", 1: "High Card"}


# ---------------- Slots (generic 3-reel) ----------------
SLOT_CONFIGS = {
    "fever-joker-bonus": {
        "wild": "joker", "wild_pay": 50,
        "symbols": [
            {"id": "cherry", "glyph": "CH", "weight": 30, "pay": 2},
            {"id": "lemon", "glyph": "LE", "weight": 25, "pay": 3},
            {"id": "bell", "glyph": "BL", "weight": 18, "pay": 5},
            {"id": "star", "glyph": "ST", "weight": 12, "pay": 8},
            {"id": "seven", "glyph": "77", "weight": 8, "pay": 15},
            {"id": "joker", "glyph": "JK", "weight": 7, "pay": 0},
        ],
    },
    "giant-jackpot": {
        "wild": "diamond", "wild_pay": 100,
        "symbols": [
            {"id": "coin", "glyph": "CO", "weight": 30, "pay": 2},
            {"id": "bar", "glyph": "BR", "weight": 24, "pay": 4},
            {"id": "bell", "glyph": "BL", "weight": 16, "pay": 6},
            {"id": "gem", "glyph": "GM", "weight": 12, "pay": 10},
            {"id": "crown", "glyph": "CR", "weight": 12, "pay": 20},
            {"id": "diamond", "glyph": "DI", "weight": 6, "pay": 0},
        ],
    },
    "joker-bonus": {
        "wild": "joker", "wild_pay": 40,
        "symbols": [
            {"id": "plum", "glyph": "PL", "weight": 30, "pay": 2},
            {"id": "grape", "glyph": "GR", "weight": 25, "pay": 3},
            {"id": "melon", "glyph": "ME", "weight": 18, "pay": 5},
            {"id": "bell", "glyph": "BL", "weight": 12, "pay": 10},
            {"id": "seven", "glyph": "77", "weight": 8, "pay": 18},
            {"id": "joker", "glyph": "JK", "weight": 7, "pay": 0},
        ],
    },
    "lucky-8-line": {
        "wild": "dragon", "wild_pay": 60,
        "symbols": [
            {"id": "blossom", "glyph": "BS", "weight": 30, "pay": 2},
            {"id": "ingot", "glyph": "IG", "weight": 24, "pay": 4},
            {"id": "coin", "glyph": "CO", "weight": 16, "pay": 6},
            {"id": "fish", "glyph": "FI", "weight": 12, "pay": 10},
            {"id": "eight", "glyph": "88", "weight": 10, "pay": 25},
            {"id": "dragon", "glyph": "DR", "weight": 8, "pay": 0},
        ],
    },
    "triple-fun": {
        "wild": "trifun", "wild_pay": 75,
        "symbols": [
            {"id": "dot", "glyph": "DT", "weight": 32, "pay": 2},
            {"id": "duo", "glyph": "DU", "weight": 24, "pay": 4},
            {"id": "trio", "glyph": "TR", "weight": 18, "pay": 6},
            {"id": "spark", "glyph": "SP", "weight": 12, "pay": 12},
            {"id": "tri7", "glyph": "37", "weight": 9, "pay": 30},
            {"id": "trifun", "glyph": "TF", "weight": 5, "pay": 0},
        ],
    },
}


def weighted_choice(pairs):
    total = sum(w for _, w in pairs)
    x = RNG.uniform(0, total)
    acc = 0
    for v, w in pairs:
        acc += w
        if x <= acc:
            return v
    return pairs[-1][0]


def play_slot(slug, bet, payload):
    cfg = SLOT_CONFIGS[slug]
    strip = [(s["id"], s["weight"]) for s in cfg["symbols"]]
    reels = [weighted_choice(strip) for _ in range(3)]
    wild = cfg["wild"]
    mult = 0
    label = "NO WIN"
    if all(r == wild for r in reels):
        mult = cfg["wild_pay"]
        label = "WILD JACKPOT"
    else:
        three = [(s["pay"], s["id"]) for s in cfg["symbols"] if s["id"] != wild and sum(1 for r in reels if r == s["id"] or r == wild) == 3]
        two = [s["id"] for s in cfg["symbols"] if s["id"] != wild and sum(1 for r in reels if r == s["id"] or r == wild) == 2]
        if three:
            best = max(three)
            mult = best[0]
            label = f"3x {best[1].upper()}"
        elif two:
            mult = 1
            label = "PAIR - STAKE BACK"
    payout = bet * mult
    return {"reels": reels, "label": label, "multiplier": mult}, payout


# ---------------- Instant game engines ----------------
def play_seven_up_down(bet, payload):
    side = payload.get("side")
    if side not in ("up", "down", "seven"):
        bad("Pick a side: up, down or seven")
    d1, d2 = RNG.randint(1, 6), RNG.randint(1, 6)
    total = d1 + d2
    won = (side == "up" and total > 7) or (side == "down" and total < 7) or (side == "seven" and total == 7)
    mult = 5.8 if side == "seven" else 2.3
    payout = int(bet * mult) if won else 0
    return {"dice": [d1, d2], "total": total, "side": side, "won": won}, payout


def play_andar_bahar(bet, payload):
    side = payload.get("side")
    if side not in ("andar", "bahar"):
        bad("Pick a side: andar or bahar")
    deck = new_deck()
    joker = draw_cards(1, deck)[0]
    sequence = []
    winner = None
    turn = "andar"
    while winner is None and deck:
        c = draw_cards(1, deck)[0]
        sequence.append({"card": card_str(c), "side": turn})
        if c[0] == joker[0]:
            winner = turn
        turn = "bahar" if turn == "andar" else "andar"
    won = winner == side
    payout = int(bet * 1.9) if won else 0
    return {"joker": card_str(joker), "sequence": sequence[:40], "winner": winner, "side": side, "won": won}, payout


def play_fun_target(bet, payload):
    pick = payload.get("number")
    if not isinstance(pick, int) or pick < 0 or pick > 9:
        bad("Pick a number from 0 to 9")
    result = RNG.randint(0, 9)
    won = result == pick
    payout = bet * 9 if won else 0
    return {"pick": pick, "result": result, "won": won}, payout


ROULETTE_RED = {1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36}


def play_fun_roulette(bet, payload):
    btype = payload.get("bet_type")
    value = payload.get("value")
    n = RNG.randint(0, 36)
    color = "green" if n == 0 else ("red" if n in ROULETTE_RED else "black")
    won, mult = False, 0
    if btype == "straight":
        if not isinstance(value, int) or value < 0 or value > 36:
            bad("Straight bet needs a number 0-36")
        won, mult = (n == value), 36
    elif btype == "color":
        if value not in ("red", "black"):
            bad("Color bet must be red or black")
        won, mult = (color == value), 2
    elif btype == "parity":
        if value not in ("odd", "even"):
            bad("Parity bet must be odd or even")
        won, mult = (n != 0 and (n % 2 == 1) == (value == "odd")), 2
    elif btype == "range":
        if value not in ("low", "high"):
            bad("Range bet must be low or high")
        won, mult = (1 <= n <= 18) if value == "low" else (19 <= n <= 36), 2
    elif btype == "dozen":
        if value not in (1, 2, 3):
            bad("Dozen must be 1, 2 or 3")
        won, mult = (n != 0 and (n - 1) // 12 + 1 == value), 3
    else:
        bad("Invalid bet type")
    payout = bet * mult if won else 0
    return {"number": n, "color": color, "bet_type": btype, "value": value, "won": won}, payout


KENO_PAYTABLE = {
    1: {1: 3}, 2: {2: 9}, 3: {2: 2, 3: 25}, 4: {2: 1, 3: 5, 4: 60},
    5: {3: 2, 4: 12, 5: 150}, 6: {3: 1, 4: 5, 5: 40, 6: 400},
    7: {4: 2, 5: 15, 6: 80, 7: 700}, 8: {4: 1, 5: 8, 6: 40, 7: 200, 8: 1000},
    9: {5: 4, 6: 20, 7: 80, 8: 500, 9: 2000}, 10: {5: 2, 6: 10, 7: 40, 8: 200, 9: 1000, 10: 5000},
}


def play_keno(bet, payload):
    picks = payload.get("picks")
    if not isinstance(picks, list) or not (1 <= len(picks) <= 10):
        bad("Pick between 1 and 10 numbers")
    if len(set(picks)) != len(picks) or any(not isinstance(p, int) or p < 1 or p > 80 for p in picks):
        bad("Picks must be unique numbers 1-80")
    drawn = RNG.sample(range(1, 81), 20)
    matches = sorted(set(picks) & set(drawn))
    mult = KENO_PAYTABLE[len(picks)].get(len(matches), 0)
    payout = bet * mult
    return {"picks": sorted(picks), "drawn": sorted(drawn), "matches": matches, "multiplier": mult}, payout


def play_bingo(bet, payload):
    # 5x5 card, center free, 30 balls drawn from 75, payout by completed lines
    card = []
    for col in range(5):
        lo, hi = col * 15 + 1, col * 15 + 15
        card.append(RNG.sample(range(lo, hi + 1), 5))
    grid = [[card[c][r] for c in range(5)] for r in range(5)]  # rows
    grid[2][2] = 0  # free center
    drawn = set(RNG.sample(range(1, 76), 30))
    marked = [[(grid[r][c] == 0 or grid[r][c] in drawn) for c in range(5)] for r in range(5)]
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
    table = {0: 0, 1: 2, 2: 5, 3: 10, 4: 25, 5: 50}
    mult = table.get(lines, 50) if lines < 12 else 100
    if lines >= 12:
        mult = 100
    payout = bet * mult
    return {"grid": grid, "drawn": sorted(drawn), "lines": lines, "multiplier": mult}, payout


WHEEL_SEGMENTS = [
    {"m": 0, "w": 670}, {"m": 1.5, "w": 150}, {"m": 2, "w": 90}, {"m": 3, "w": 50},
    {"m": 5, "w": 25}, {"m": 10, "w": 10}, {"m": 20, "w": 4}, {"m": 50, "w": 1},
]


def play_super_golden_wheel(bet, payload):
    seg = weighted_choice([(s["m"], s["w"]) for s in WHEEL_SEGMENTS])
    payout = int(bet * seg)
    return {"multiplier": seg, "won": seg > 0}, payout


def play_card_duel(bet, payload, game="teen-patti"):
    deck = new_deck()
    if game == "teen-patti":
        player = draw_cards(3, deck)
        dealer = draw_cards(3, deck)
        pe, de = eval_teen_patti(player), eval_teen_patti(dealer)
        plabel, dlabel = TP_LABELS[pe[0]], TP_LABELS[de[0]]
    else:  # poker 5-card showdown
        player = draw_cards(5, deck)
        dealer = draw_cards(5, deck)
        pe, de = eval_poker5(player), eval_poker5(dealer)
        labels = {9: "Royal Flush", 8: "Straight Flush", 7: "Four of a Kind", 6: "Full House", 5: "Flush", 4: "Straight", 3: "Three of a Kind", 2: "Two Pair", 1: "Pair", 0: "High Card"}
        plabel, dlabel = labels[pe[0]], labels[de[0]]
    if pe > de:
        result, payout = "win", int(bet * 1.95)
    elif pe < de:
        result, payout = "lose", 0
    else:
        result, payout = "push", bet
    return {
        "player": [card_str(c) for c in player], "dealer": [card_str(c) for c in dealer],
        "player_hand": plabel, "dealer_hand": dlabel, "result": result,
    }, payout


def play_checker(bet, payload):
    side = payload.get("side")
    if side not in ("gold", "steel"):
        bad("Pick a side: gold or steel")
    # Simulated capture duel - server decides winner, 1.9x payout
    rounds = []
    gold_caps, steel_caps = 0, 0
    for _ in range(6):
        winner = RNG.choice(["gold", "steel"])
        if winner == "gold":
            gold_caps += 1
        else:
            steel_caps += 1
        rounds.append(winner)
    if gold_caps == steel_caps:
        rounds.append(RNG.choice(["gold", "steel"]))
        if rounds[-1] == "gold":
            gold_caps += 1
        else:
            steel_caps += 1
    winner = "gold" if gold_caps > steel_caps else "steel"
    won = winner == side
    payout = int(bet * 1.9) if won else 0
    return {"side": side, "rounds": rounds, "gold": gold_caps, "steel": steel_caps, "winner": winner, "won": won}, payout


def play_no_hold(bet, payload):
    deck = new_deck()
    cards = draw_cards(5, deck)
    label, mult = vp_result(cards)
    payout = bet * mult
    return {"cards": [card_str(c) for c in cards], "hand": label, "multiplier": mult}, payout


# ---------------- Aviator helpers ----------------
AVIATOR_GROWTH = 0.12  # m(t) = e^(0.12 * t)


def aviator_crash_point():
    u = RNG.random()
    crash = max(1.0, 0.96 / max(1e-9, 1 - u))
    return round(min(crash, 200.0), 2)


def aviator_multiplier(elapsed_seconds):
    return round(math.exp(AVIATOR_GROWTH * max(0.0, elapsed_seconds)), 2)


def aviator_time_for(mult):
    return math.log(max(1.0, mult)) / AVIATOR_GROWTH


# ---------------- Engine registry (instant games) ----------------
def make_slot_engine(slug):
    def engine(bet, payload):
        return play_slot(slug, bet, payload)
    return engine


ENGINES = {
    "seven-up-down": play_seven_up_down,
    "andar-bahar": play_andar_bahar,
    "fun-target": play_fun_target,
    "fun-roulette": play_fun_roulette,
    "keno": play_keno,
    "bingo": play_bingo,
    "super-golden-wheel": play_super_golden_wheel,
    "teen-patti": lambda bet, payload: play_card_duel(bet, payload, "teen-patti"),
    "poker": lambda bet, payload: play_card_duel(bet, payload, "poker"),
    "checker": play_checker,
    "no-hold": play_no_hold,
    "fever-joker-bonus": make_slot_engine("fever-joker-bonus"),
    "giant-jackpot": make_slot_engine("giant-jackpot"),
    "joker-bonus": make_slot_engine("joker-bonus"),
    "lucky-8-line": make_slot_engine("lucky-8-line"),
    "triple-fun": make_slot_engine("triple-fun"),
}
# aviator + champion-poker are stateful and handled in routes_games.py
