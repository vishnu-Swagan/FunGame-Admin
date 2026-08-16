import {
  ResolverInputError,
  type ServerEntropy,
} from "./resolver-contract.ts";

export const CARD_SUITS = Object.freeze(["S", "H", "D", "C"] as const);
export type CardSuit = typeof CARD_SUITS[number];
export type CardRank = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14;
export type WireCard = `${string}${CardSuit}`;

const RANK_LABELS: Readonly<Record<number, string>> = Object.freeze({
  11: "J",
  12: "Q",
  13: "K",
  14: "A",
});

const LABEL_RANKS: Readonly<Record<string, CardRank>> = Object.freeze({
  "2": 2,
  "3": 3,
  "4": 4,
  "5": 5,
  "6": 6,
  "7": 7,
  "8": 8,
  "9": 9,
  "10": 10,
  J: 11,
  Q: 12,
  K: 13,
  A: 14,
});

export type ParsedCard = Readonly<{
  wire: WireCard;
  rank: CardRank;
  suit: CardSuit;
}>;

export const STANDARD_DECK: readonly WireCard[] = Object.freeze(
  CARD_SUITS.flatMap((suit) =>
    Array.from({ length: 13 }, (_, index) => {
      const rank = index + 2;
      return `${RANK_LABELS[rank] || rank}${suit}` as WireCard;
    })
  ),
);

export function parseWireCard(value: unknown): ParsedCard {
  if (typeof value !== "string" || !/^(?:[2-9]|10|[JQKA])[SHDC]$/.test(value)) {
    throw new ResolverInputError("INVALID_OUTCOME", "A card must use canonical wire form such as 10H or AS.");
  }
  const suit = value.slice(-1) as CardSuit;
  const label = value.slice(0, -1);
  const rank = LABEL_RANKS[label];
  if (!rank) throw new ResolverInputError("INVALID_OUTCOME", "The card rank is invalid.");
  return Object.freeze({ wire: value as WireCard, rank, suit });
}

export function entropyIndex(
  source: ServerEntropy,
  exclusiveMax: number,
  label = "outcome",
): number {
  if (typeof source !== "function" || !Number.isSafeInteger(exclusiveMax) || exclusiveMax < 1) {
    throw new ResolverInputError("INVALID_OUTCOME", `A valid server entropy source is required for ${label}.`);
  }
  const value = source(exclusiveMax);
  if (!Number.isSafeInteger(value) || value < 0 || value >= exclusiveMax) {
    throw new ResolverInputError(
      "INVALID_OUTCOME",
      `Server entropy for ${label} must be an integer in [0, ${exclusiveMax}).`,
    );
  }
  return value;
}

export function drawCard(entropy: ServerEntropy): WireCard {
  return STANDARD_DECK[entropyIndex(entropy, STANDARD_DECK.length, "card draw")];
}

export function drawWithoutReplacement(
  pool: WireCard[],
  entropy: ServerEntropy,
  label = "card draw",
): WireCard {
  if (!Array.isArray(pool) || pool.length < 1) {
    throw new ResolverInputError("INVALID_OUTCOME", "The card deck is empty.");
  }
  const index = entropyIndex(entropy, pool.length, label);
  return pool.splice(index, 1)[0];
}

export function assertUniqueCards(cards: readonly WireCard[]): void {
  cards.forEach(parseWireCard);
  if (new Set(cards).size !== cards.length) {
    throw new ResolverInputError("INVALID_OUTCOME", "A single-deck outcome contains a duplicate card.");
  }
}
