"""First Person Blackjack — server-authoritative logic.

Real Evolution rules: dealer stands on all 17, blackjack pays 3:2, insurance
2:1. Side bets Perfect Pairs (25/12/6:1) and 21+3 (flush 5, straight 10, trips
30, straight-flush 40, suited-trips 100 :1). Secure RNG shoe. PLAY CHIPS ONLY.
"""
import secrets

RNG = secrets.SystemRandom()
SUITS = ["S", "H", "D", "C"]
RANKS = list(range(2, 15))  # 11=J 12=Q 13=K 14=A
RED = {"H", "D"}


def new_shoe(decks=6):
    shoe = [(r, s) for _ in range(decks) for r in RANKS for s in SUITS]
    RNG.shuffle(shoe)
    return shoe


def card_str(c):
    names = {11: "J", 12: "Q", 13: "K", 14: "A"}
    return f"{names.get(c[0], c[0])}{c[1]}"


def cards_str(cards):
    return [card_str(c) for c in cards]


def card_value(r):
    if r == 14:
        return 11
    return min(r, 10)


def hand_total(cards):
    """Best total <= 21 if possible. Returns (total, soft)."""
    total = sum(card_value(r) for r, _ in cards)
    aces = sum(1 for r, _ in cards if r == 14)
    soft = aces > 0
    while total > 21 and aces > 0:
        total -= 10
        aces -= 1
        soft = aces > 0
    return total, (soft and total <= 21)


def hand_value(cards):
    return hand_total(cards)[0]


def is_blackjack(cards):
    return len(cards) == 2 and hand_value(cards) == 21


def is_bust(cards):
    return hand_value(cards) > 21


def dealer_should_hit(cards):
    # Stands on all 17 (hard and soft).
    return hand_value(cards) < 17


# ---------------- side bets ----------------
def eval_perfect_pairs(two):
    """First two player cards. Returns (mult, label)."""
    if len(two) != 2 or two[0][0] != two[1][0]:
        return 0, None
    (r0, s0), (r1, s1) = two
    if s0 == s1:
        return 25, "PERFECT PAIR"
    if (s0 in RED) == (s1 in RED):
        return 12, "COLOURED PAIR"
    return 6, "MIXED PAIR"


def eval_21plus3(two, dealer_up):
    """Player's two cards + dealer up card -> 3-card poker. Returns (mult, label)."""
    three = list(two) + [dealer_up]
    ranks = sorted([r for r, _ in three])
    suits = [s for _, s in three]
    flush = len(set(suits)) == 1
    trips = ranks[0] == ranks[1] == ranks[2]
    # straight (A can be high or low: A-2-3 and Q-K-A)
    uniq = sorted(set(ranks))
    straight = False
    if len(uniq) == 3:
        if uniq[2] - uniq[0] == 2:
            straight = True
        elif uniq == [2, 3, 14] or uniq == [12, 13, 14]:
            straight = True
    if trips and flush:
        return 100, "SUITED TRIPS"
    if straight and flush:
        return 40, "STRAIGHT FLUSH"
    if trips:
        return 30, "THREE OF A KIND"
    if straight:
        return 10, "STRAIGHT"
    if flush:
        return 5, "FLUSH"
    return 0, None


# ---------------- settlement ----------------
def settle_hand(player, dealer, bet, from_split_aces=False):
    """Total return (incl. stake) for one player hand vs the dealer's final hand.
    Returns (payout:int, outcome:str)."""
    pv = hand_value(player)
    dv = hand_value(dealer)
    p_bj = is_blackjack(player) and not from_split_aces
    d_bj = is_blackjack(dealer)
    if pv > 21:
        return 0, "BUST"
    if p_bj and d_bj:
        return bet, "PUSH"
    if p_bj:
        return int(round(bet * 2.5)), "BLACKJACK"   # 3:2
    if d_bj:
        return 0, "LOSE"
    if dv > 21 or pv > dv:
        return bet * 2, "WIN"                        # 1:1
    if pv == dv:
        return bet, "PUSH"
    return 0, "LOSE"
