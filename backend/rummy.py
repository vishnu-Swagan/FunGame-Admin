"""Server-side Indian 13-card Rummy rules and secure deck utilities.

This module contains no HTTP, database, or presentation code.  Keeping the
rules pure makes declaration validation identical for players, bots, tests and
settlement.  Cards have stable unique ids because two physical decks can
contain the same rank and suit.
"""
from __future__ import annotations

import hashlib
import hmac
import itertools
import secrets
from functools import lru_cache


SUITS = ("S", "H", "D", "C")
RANKS = tuple(range(1, 14))  # A, 2..10, J, Q, K
RANK_LABELS = {1: "A", 11: "J", 12: "Q", 13: "K"}
MAX_PLAYERS = 5
HAND_SIZE = 13


RUMMY_CATEGORIES = (
    {
        "id": "LV1", "displayName": "Beginner", "entryChips": 100,
        "pointsValue": 1, "minChipBalance": 100, "maxChipBalance": None,
        "turnDurationSeconds": 30, "skillRatingMin": 0, "skillRatingMax": 999,
        "reconnectAllowanceSeconds": 20, "practiceBotDifficulty": "guided",
        "firstDropPoints": 20, "middleDropPoints": 40, "invalidDeclarationPoints": 80,
        "maxPlayers": MAX_PLAYERS, "enabled": True, "displayOrder": 1,
        "accent": {"from": "#0c8f71", "to": "#08483c", "metal": "#d9b862"},
    },
    {
        "id": "LV2", "displayName": "Classic", "entryChips": 500,
        "pointsValue": 2, "minChipBalance": 500, "maxChipBalance": None,
        "turnDurationSeconds": 30, "skillRatingMin": 300, "skillRatingMax": 1599,
        "reconnectAllowanceSeconds": 20, "practiceBotDifficulty": "standard",
        "firstDropPoints": 20, "middleDropPoints": 40, "invalidDeclarationPoints": 80,
        "maxPlayers": MAX_PLAYERS, "enabled": True, "displayOrder": 2,
        "accent": {"from": "#2f9f58", "to": "#14532d", "metal": "#e5c56d"},
    },
    {
        "id": "LV3", "displayName": "Pro", "entryChips": 1000,
        "pointsValue": 5, "minChipBalance": 1000, "maxChipBalance": None,
        "turnDurationSeconds": 28, "skillRatingMin": 900, "skillRatingMax": 2299,
        "reconnectAllowanceSeconds": 18, "practiceBotDifficulty": "strong",
        "firstDropPoints": 20, "middleDropPoints": 40, "invalidDeclarationPoints": 80,
        "maxPlayers": MAX_PLAYERS, "enabled": True, "displayOrder": 3,
        "accent": {"from": "#0d9488", "to": "#134e4a", "metal": "#f3cf72"},
    },
    {
        "id": "LV4", "displayName": "Elite", "entryChips": 2500,
        "pointsValue": 10, "minChipBalance": 2500, "maxChipBalance": None,
        "turnDurationSeconds": 25, "skillRatingMin": 1600, "skillRatingMax": 2999,
        "reconnectAllowanceSeconds": 15, "practiceBotDifficulty": "expert",
        "firstDropPoints": 20, "middleDropPoints": 40, "invalidDeclarationPoints": 80,
        "maxPlayers": MAX_PLAYERS, "enabled": True, "displayOrder": 4,
        "accent": {"from": "#3557ad", "to": "#172554", "metal": "#f0c96a"},
    },
    {
        "id": "LV5", "displayName": "Royal", "entryChips": 5000,
        "pointsValue": 20, "minChipBalance": 5000, "maxChipBalance": None,
        "turnDurationSeconds": 22, "skillRatingMin": 2300, "skillRatingMax": 9999,
        "reconnectAllowanceSeconds": 15, "practiceBotDifficulty": "royal",
        "firstDropPoints": 20, "middleDropPoints": 40, "invalidDeclarationPoints": 80,
        "maxPlayers": MAX_PLAYERS, "enabled": True, "displayOrder": 5,
        "accent": {"from": "#a42631", "to": "#4c0519", "metal": "#ffd978"},
    },
)


def category_map(categories=None):
    return {row["id"]: dict(row) for row in (categories or RUMMY_CATEGORIES)}


def new_deck() -> list[dict]:
    cards = []
    for deck_number in (1, 2):
        for suit in SUITS:
            for rank in RANKS:
                cards.append({
                    "id": f"D{deck_number}-{suit}-{rank}",
                    "deck": deck_number,
                    "suit": suit,
                    "rank": rank,
                    "printedJoker": False,
                    "code": f"{RANK_LABELS.get(rank, rank)}{suit}",
                })
        cards.append({
            "id": f"D{deck_number}-PJ", "deck": deck_number, "suit": "J",
            "rank": 0, "printedJoker": True, "code": "PJ",
        })
    return cards


class HmacShuffle:
    """Deterministic CSPRNG stream used only with an unrevealed random seed."""

    def __init__(self, seed: bytes):
        if not isinstance(seed, bytes) or len(seed) < 32:
            raise ValueError("shuffle seed must contain at least 256 bits")
        self.seed = seed
        self.counter = 0

    def _word(self) -> int:
        payload = self.counter.to_bytes(16, "big")
        self.counter += 1
        return int.from_bytes(hmac.new(self.seed, payload, hashlib.sha256).digest(), "big")

    def randbelow(self, upper: int) -> int:
        if upper <= 0:
            raise ValueError("upper must be positive")
        space = 1 << 256
        limit = space - (space % upper)
        while True:
            value = self._word()
            if value < limit:
                return value % upper


def secure_shuffle(cards: list[dict], seed: bytes | None = None):
    """Return shuffled cards and proof data using Fisher-Yates + HMAC-SHA256."""
    seed = seed or secrets.token_bytes(32)
    shuffled = [dict(card) for card in cards]
    stream = HmacShuffle(seed)
    for index in range(len(shuffled) - 1, 0, -1):
        swap = stream.randbelow(index + 1)
        shuffled[index], shuffled[swap] = shuffled[swap], shuffled[index]
    order = ",".join(card["id"] for card in shuffled).encode()
    return shuffled, {
        "seed": seed.hex(),
        "seedCommitment": hashlib.sha256(seed).hexdigest(),
        "deckHash": hashlib.sha256(order).hexdigest(),
        "shuffleVersion": "rummy-hmac-fy-v1",
    }


def is_joker(card: dict, wild_rank: int) -> bool:
    return bool(card.get("printedJoker")) or int(card.get("rank", -1)) == int(wild_rank)


def card_points(card: dict, wild_rank: int) -> int:
    if is_joker(card, wild_rank):
        return 0
    rank = int(card["rank"])
    return 10 if rank == 1 or rank >= 10 else rank


def _rank_variants(cards: list[dict]):
    """Yield Ace-low/Ace-high natural rank interpretations."""
    ranks = [int(card["rank"]) for card in cards]
    ace_indexes = [index for index, rank in enumerate(ranks) if rank == 1]
    for high_flags in itertools.product((False, True), repeat=len(ace_indexes)):
        candidate = list(ranks)
        for index, high in zip(ace_indexes, high_flags):
            if high:
                candidate[index] = 14
        yield sorted(candidate)


def _natural_sequence(cards: list[dict]) -> bool:
    if len(cards) < 3 or len({card["suit"] for card in cards}) != 1:
        return False
    for ranks in _rank_variants(cards):
        if len(set(ranks)) == len(ranks) and all(b - a == 1 for a, b in zip(ranks, ranks[1:])):
            return True
    return False


def _impure_sequence(naturals: list[dict], joker_count: int, total: int) -> bool:
    if total < 3 or len(naturals) < 2 or len({card["suit"] for card in naturals}) != 1:
        return False
    for ranks in _rank_variants(naturals):
        if len(set(ranks)) != len(ranks):
            continue
        # Naturals must fit inside one consecutive run whose remaining places
        # are exactly what the jokers can occupy.
        for start in range(1, 15 - total + 1):
            run = set(range(start, start + total))
            if set(ranks).issubset(run) and total - len(ranks) == joker_count:
                return True
    return False


def classify_group(cards: list[dict], wild_rank: int) -> str:
    if len(cards) < 3:
        return "INVALID"
    # A wild-rank card may still be played as its natural suit/rank in a pure
    # sequence. Printed jokers can never make a pure sequence. Test the
    # natural run before treating wild-rank cards as substitutes.
    if not any(card.get("printedJoker") for card in cards) and _natural_sequence(cards):
        return "PURE_SEQUENCE"
    jokers = [card for card in cards if is_joker(card, wild_rank)]
    naturals = [card for card in cards if not is_joker(card, wild_rank)]
    if jokers and _impure_sequence(naturals, len(jokers), len(cards)):
        return "IMPURE_SEQUENCE"
    if 3 <= len(cards) <= 4 and naturals:
        ranks = {int(card["rank"]) for card in naturals}
        suits = [card["suit"] for card in naturals]
        if len(ranks) == 1 and len(suits) == len(set(suits)):
            return "SET"
    return "INVALID"


def _index_cards(cards: list[dict]):
    indexed = {card["id"]: card for card in cards}
    if len(indexed) != len(cards):
        raise ValueError("duplicate card id")
    return indexed


def validate_declaration(cards: list[dict], group_ids: list[list[str]], wild_rank: int) -> dict:
    """Validate one exact 13-card declaration and return stable group labels."""
    indexed = _index_cards(cards)
    flat = [card_id for group in group_ids for card_id in group]
    if len(cards) != HAND_SIZE or len(flat) != HAND_SIZE or len(set(flat)) != HAND_SIZE:
        return {"valid": False, "code": "CARDS_NOT_FULLY_GROUPED", "groups": []}
    if set(flat) != set(indexed):
        return {"valid": False, "code": "CARD_OWNERSHIP_MISMATCH", "groups": []}
    labels = [classify_group([indexed[card_id] for card_id in group], wild_rank) for group in group_ids]
    if "INVALID" in labels:
        return {"valid": False, "code": "INVALID_GROUP", "groups": labels}
    sequences = sum(label.endswith("SEQUENCE") for label in labels)
    pure = labels.count("PURE_SEQUENCE")
    if pure < 1:
        return {"valid": False, "code": "PURE_SEQUENCE_REQUIRED", "groups": labels}
    if sequences < 2:
        return {"valid": False, "code": "SECOND_SEQUENCE_REQUIRED", "groups": labels}
    return {"valid": True, "code": "VALID_DECLARATION", "groups": labels}


def best_arrangement(cards: list[dict], wild_rank: int) -> dict:
    """Find the lowest-point legal grouping without leaking any other hand."""
    indexed = list(cards)
    count = len(indexed)
    if count > 14:
        raise ValueError("a Rummy hand cannot exceed fourteen cards")
    points = [card_points(card, wild_rank) for card in indexed]
    candidates = []
    for mask in range(1, 1 << count):
        # Keep the rules module compatible with the production Python runtime,
        # which may predate ``int.bit_count``.
        size = bin(mask).count("1")
        if size < 3:
            continue
        group = [indexed[i] for i in range(count) if mask & (1 << i)]
        label = classify_group(group, wild_rank)
        if label != "INVALID":
            candidates.append((mask, label))

    by_first = {index: [] for index in range(count)}
    for mask, label in candidates:
        for index in range(count):
            if mask & (1 << index):
                by_first[index].append((mask, label))
                break

    @lru_cache(maxsize=None)
    def solve(remaining: int):
        if not remaining:
            # covered points, covered cards, sequences, pure sequences, masks, labels
            return (0, 0, 0, 0, (), ())
        first = (remaining & -remaining).bit_length() - 1
        best = solve(remaining & ~(1 << first))
        for mask, label in by_first.get(first, ()):
            if mask & remaining != mask:
                continue
            nested = solve(remaining ^ mask)
            covered = sum(points[i] for i in range(count) if mask & (1 << i)) + nested[0]
            used_count = bin(mask).count("1") + nested[1]
            sequence_count = int(label.endswith("SEQUENCE")) + nested[2]
            pure_count = int(label == "PURE_SEQUENCE") + nested[3]
            candidate = (
                covered, used_count, sequence_count, pure_count,
                (mask,) + nested[4], (label,) + nested[5],
            )
            # Covering a zero-point joker still matters: it can turn a partial
            # layout into a complete declaration.  Then prefer arrangements
            # satisfying the one-pure/two-sequence declaration constraints.
            # Indian Rummy scoring protects a pure sequence first and a second
            # sequence next.  Maximising point coverage before those invariants
            # can incorrectly prefer three high-card sets over a low-card pure
            # run, then score the entire hand.  Honour the rule hierarchy first.
            quality = (min(candidate[3], 1), min(candidate[2], 2), candidate[0], candidate[1])
            best_quality = (min(best[3], 1), min(best[2], 2), best[0], best[1])
            if quality > best_quality:
                best = candidate
        return best

    full = (1 << count) - 1
    covered, _used_count, _sequence_count, _pure_count, masks, labels = solve(full)
    used = 0
    groups = []
    for mask, label in zip(masks, labels):
        used |= mask
        groups.append({
            "label": label,
            "cardIds": [indexed[i]["id"] for i in range(count) if mask & (1 << i)],
        })
    remaining_cards = [indexed[i] for i in range(count) if not used & (1 << i)]
    sequences = sum(row["label"].endswith("SEQUENCE") for row in groups)
    pure = sum(row["label"] == "PURE_SEQUENCE" for row in groups)
    if pure == 0:
        scoring_cards = indexed
    elif sequences < 2:
        protected = {
            card_id for row in groups if row["label"] == "PURE_SEQUENCE"
            for card_id in row["cardIds"]
        }
        scoring_cards = [card for card in indexed if card["id"] not in protected]
    else:
        scoring_cards = remaining_cards
    score = min(80, sum(card_points(card, wild_rank) for card in scoring_cards))
    return {
        "groups": groups,
        "ungroupedCardIds": [card["id"] for card in remaining_cards],
        "score": score,
        "valid": count == HAND_SIZE and not remaining_cards and sequences >= 2 and pure >= 1,
        "coveredPoints": covered,
    }


BOT_DIFFICULTIES = ("guided", "standard", "strong", "expert", "royal")


def bot_difficulty(value: str | None) -> str:
    """Return one stable level name for persisted/admin supplied values."""
    canonical = str(value or "standard").strip().lower()
    return canonical if canonical in BOT_DIFFICULTIES else "standard"


def _bot_private_meld_potential(
    cards: list[dict], wild_rank: int,
) -> tuple[int, int]:
    """Measure future meld links using only cards the bot may inspect.

    Royal bots use this as a final look-ahead after the normal declaration,
    point and coverage rules.  It never receives the closed deck or another
    player's hand: same-rank/different-suit pairs can grow into sets, while
    close same-suit ranks can grow into sequences.  Aces are treated as both
    low (A-2) and high (Q-K-A) connectors.
    """
    naturals = [card for card in cards if not is_joker(card, wild_rank)]
    strength = 0
    linked_card_ids = set()
    for left_index, left in enumerate(naturals):
        for right in naturals[left_index + 1:]:
            link_strength = 0
            if (
                int(left["rank"]) == int(right["rank"])
                and left["suit"] != right["suit"]
            ):
                link_strength = 3
            elif left["suit"] == right["suit"]:
                left_rank = int(left["rank"])
                right_rank = int(right["rank"])
                distances = [abs(left_rank - right_rank)]
                if left_rank == 1:
                    distances.append(abs(14 - right_rank))
                if right_rank == 1:
                    distances.append(abs(left_rank - 14))
                distance = min(distances)
                if distance == 1:
                    link_strength = 3
                elif distance == 2:
                    link_strength = 1
            if link_strength:
                strength += link_strength
                linked_card_ids.update((left["id"], right["id"]))
    return strength, len(linked_card_ids)


def _bot_choice_rows(
    cards: list[dict], wild_rank: int, forbidden_card_id: str | None = None,
) -> list[tuple]:
    """Score legal discards without looking at any opponent or covered card."""
    rows = []
    for card in cards:
        if card["id"] == forbidden_card_id or is_joker(card, wild_rank):
            continue
        remaining = [candidate for candidate in cards if candidate["id"] != card["id"]]
        arrangement = best_arrangement(remaining, wild_rank)
        rows.append((
            int(not arrangement["valid"]),
            int(arrangement["score"]),
            -int(arrangement.get("coveredPoints", 0)),
            -card_points(card, wild_rank),
            card["id"],
            card,
            arrangement,
        ))
    if rows:
        return rows
    # A hand made entirely of jokers is unusual but still needs one legal move.
    return [
        (1, 0, 0, 0, card["id"], card, best_arrangement(
            [candidate for candidate in cards if candidate["id"] != card["id"]],
            wild_rank,
        ))
        for card in cards
        if card["id"] != forbidden_card_id
    ]


def choose_bot_discard(
    cards: list[dict], wild_rank: int, difficulty: str = "expert",
    forbidden_card_id: str | None = None,
) -> dict:
    """Choose a legal discard using only the bot's private hand.

    Difficulty changes decision quality, never the deal.  Guided bots make the
    familiar high-card discard; stronger levels increasingly protect valid
    groups and point coverage.  A picked open card can be forbidden so the bot
    obeys the same no-pick-and-return rule as a person.
    """
    level = bot_difficulty(difficulty)
    rows = _bot_choice_rows(cards, wild_rank, forbidden_card_id)
    if not rows:
        raise ValueError("a bot must own a legal discard")
    if level == "guided":
        return min(rows, key=lambda row: (row[0], row[3], row[4]))[5]
    if level == "standard":
        return min(rows, key=lambda row: (row[0], row[1], row[3], row[4]))[5]
    if level == "strong":
        return min(rows, key=lambda row: (row[0], row[1], row[2], row[4]))[5]
    if level == "expert":
        return min(rows, key=lambda row: row[:5])[5]

    def royal_key(row):
        remaining = [card for card in cards if card["id"] != row[4]]
        potential, linked_cards = _bot_private_meld_potential(remaining, wild_rank)
        return (
            row[0], row[1], row[2], -potential, -linked_cards, row[3], row[4],
        )

    return min(rows, key=royal_key)[5]


def choose_bot_draw_source(
    cards: list[dict], open_discard: dict | None, wild_rank: int,
    difficulty: str = "expert",
) -> str:
    """Choose ``DISCARD`` or ``CLOSED`` from information a player may see.

    The covered deck is intentionally not accepted by this function.  A bot
    therefore cannot peek at the next card even though the server stores it.
    """
    if not open_discard:
        return "CLOSED"
    level = bot_difficulty(difficulty)
    if is_joker(open_discard, wild_rank):
        return "DISCARD"
    base = best_arrangement(cards, wild_rank)
    candidate_cards = [*cards, open_discard]
    discard = choose_bot_discard(
        candidate_cards, wild_rank, level, forbidden_card_id=open_discard["id"],
    )
    remaining = [card for card in candidate_cards if card["id"] != discard["id"]]
    candidate = best_arrangement(remaining, wild_rank)
    score_gain = int(base["score"]) - int(candidate["score"])
    coverage_gain = int(candidate.get("coveredPoints", 0)) - int(base.get("coveredPoints", 0))
    if level == "guided":
        useful = score_gain >= 10
    elif level == "standard":
        useful = score_gain >= 4
    elif level == "strong":
        useful = score_gain > 0 or coverage_gain >= 5
    elif level == "expert":
        useful = (
            int(not candidate["valid"]), int(candidate["score"]),
            -int(candidate.get("coveredPoints", 0)),
        ) < (
            int(not base["valid"]), int(base["score"]),
            -int(base.get("coveredPoints", 0)),
        )
    else:
        candidate_potential = _bot_private_meld_potential(remaining, wild_rank)
        base_potential = _bot_private_meld_potential(cards, wild_rank)
        useful = (
            int(not candidate["valid"]), int(candidate["score"]),
            -int(candidate.get("coveredPoints", 0)),
            -candidate_potential[0], -candidate_potential[1],
        ) < (
            int(not base["valid"]), int(base["score"]),
            -int(base.get("coveredPoints", 0)),
            -base_potential[0], -base_potential[1],
        )
    return "DISCARD" if useful else "CLOSED"


def masked_player_id(value: str) -> str:
    compact = "".join(character for character in str(value or "") if character.isalnum())
    if len(compact) < 4:
        return "P***R"
    return f"{compact[:2]}***{compact[-2:]}"
