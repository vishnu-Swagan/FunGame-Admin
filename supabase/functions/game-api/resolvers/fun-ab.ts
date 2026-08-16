import {
  exactKeys,
  ResolverInputError,
  type ReviewResolverModule,
  type ServerEntropy,
  type SettlementResult,
  virtualPointStake,
} from "./resolver-contract.ts";
import {
  assertUniqueCards,
  drawWithoutReplacement,
  parseWireCard,
  STANDARD_DECK,
  type WireCard,
} from "./cards.ts";

const SIDES = Object.freeze(["andar", "bahar"] as const);
const SIDE_MARKERS = Object.freeze([
  "spade", "heart", "club", "diamond", "red", "black", "a-6", "seven", "8-k",
] as const);
const RANKS = Object.freeze([
  "rank-a", "rank-2", "rank-3", "rank-4", "rank-5", "rank-6", "rank-7",
  "rank-8", "rank-9", "rank-10", "rank-j", "rank-q", "rank-k",
] as const);

export type FunAbSelection = typeof SIDES[number] | typeof SIDE_MARKERS[number] | typeof RANKS[number];
export type FunAbSide = typeof SIDES[number];

export type FunAbDealtCard = Readonly<{ card: WireCard; side: FunAbSide }>;
export type FunAbOutcome = Readonly<{
  kind: "andar_bahar";
  joker: WireCard;
  sequence: readonly FunAbDealtCard[];
  winner: FunAbSide;
}>;

export type FunAbInspection = Readonly<{
  matched: boolean;
  local_review_total_return_multiplier: 1.7476 | 1.8556 | null;
  payout_points: null;
  note: string;
}>;

const VALID_SELECTIONS = new Set<string>([...SIDES, ...SIDE_MARKERS, ...RANKS]);

export function normalizeFunAbSelection(input: unknown): FunAbSelection {
  if (typeof input !== "string" || input.trim() !== input || !VALID_SELECTIONS.has(input)) {
    throw new ResolverInputError("INVALID_SELECTION", "Fun AB selection is not one of the 24 observed betting positions.");
  }
  return input as FunAbSelection;
}

export function funAbStake(input: unknown, selection: unknown): number {
  normalizeFunAbSelection(selection);
  // Only the 10-point minimum is observed. The current local 10,000/1,000
  // ceilings came from denomination assumptions, not a client limit trace.
  const stake = virtualPointStake(input);
  if (stake < 10) {
    throw new ResolverInputError("INVALID_STAKE", "Fun AB requires at least 10 virtual points.");
  }
  return stake;
}

function markerWins(selection: FunAbSelection, outcome: FunAbOutcome): boolean {
  if (selection === "andar" || selection === "bahar") return outcome.winner === selection;
  const joker = parseWireCard(outcome.joker);
  switch (selection) {
    case "spade": return joker.suit === "S";
    case "heart": return joker.suit === "H";
    case "club": return joker.suit === "C";
    case "diamond": return joker.suit === "D";
    case "red": return joker.suit === "H" || joker.suit === "D";
    case "black": return joker.suit === "S" || joker.suit === "C";
    case "a-6": return joker.rank === 14 || (joker.rank >= 2 && joker.rank <= 6);
    case "seven": return joker.rank === 7;
    case "8-k": return joker.rank >= 8 && joker.rank <= 13;
    default: {
      const expected = selection.slice("rank-".length).toUpperCase();
      const label = joker.wire.slice(0, -1);
      return label === expected;
    }
  }
}

export function validateFunAbOutcome(input: unknown): FunAbOutcome {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ResolverInputError("INVALID_OUTCOME", "Fun AB requires a server deal object.");
  }
  const record = input as Record<string, unknown>;
  exactKeys(record, ["kind", "joker", "sequence", "winner"], "INVALID_OUTCOME");
  if (record.kind !== "andar_bahar" || (record.winner !== "andar" && record.winner !== "bahar")) {
    throw new ResolverInputError("INVALID_OUTCOME", "Fun AB outcome kind or winner is invalid.");
  }
  const joker = parseWireCard(record.joker);
  if (!Array.isArray(record.sequence) || record.sequence.length < 1 || record.sequence.length > 51) {
    throw new ResolverInputError("INVALID_OUTCOME", "Fun AB needs a non-empty alternating deal sequence.");
  }
  const sequence = record.sequence.map((value, index) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new ResolverInputError("INVALID_OUTCOME", "Each Fun AB deal item must be an object.");
    }
    const item = value as Record<string, unknown>;
    exactKeys(item, ["card", "side"], "INVALID_OUTCOME");
    const expectedSide: FunAbSide = index % 2 === 0 ? "andar" : "bahar";
    if (item.side !== expectedSide) {
      throw new ResolverInputError("INVALID_OUTCOME", "Fun AB cards must alternate from Andar first.");
    }
    return Object.freeze({ card: parseWireCard(item.card).wire, side: expectedSide });
  });
  assertUniqueCards([joker.wire, ...sequence.map((item) => item.card)]);
  const jokerRank = joker.rank;
  sequence.forEach((item, index) => {
    const matches = parseWireCard(item.card).rank === jokerRank;
    if (matches !== (index === sequence.length - 1)) {
      throw new ResolverInputError("INVALID_OUTCOME", "Only the final Fun AB card may match the joker rank.");
    }
  });
  const finalSide = sequence[sequence.length - 1].side;
  if (record.winner !== finalSide) {
    throw new ResolverInputError("INVALID_OUTCOME", "Fun AB winner must be the side receiving the matching card.");
  }
  return Object.freeze({
    kind: "andar_bahar",
    joker: joker.wire,
    sequence: Object.freeze(sequence),
    winner: finalSide,
  });
}

export function inspectFunAbOutcome(
  outcome: FunAbOutcome,
  selection: FunAbSelection,
): FunAbInspection {
  // The sides are priced apart because they are not equally likely: the deal
  // starts on Andar, so Andar wins first-match 51.4982% of the time. One price
  // for both would leave Andar above 100% for the player.
  const multiplier = selection === "andar"
    ? 1.7476
    : selection === "bahar"
    ? 1.8556
    : null;
  return Object.freeze({
    matched: markerWins(selection, outcome),
    local_review_total_return_multiplier: multiplier,
    payout_points: null,
    note: multiplier === null
      ? "This marker/rank position settles from the ruleset v1 house table; call settle() for its credited points."
      : `${selection} returns ${multiplier}x total under operator ruleset v1; call settle() for the credited points.`,
  });
}

/**
 * Operator-declared ruleset v1 house paytable (TOTAL_RETURN multipliers).
 *
 * Every marker and rank position resolves against the joker, which is drawn
 * uniformly from a fresh 52-card deck, so suits are 1/4, ranks are 1/13 and
 * six-rank bands are 6/13.  The two side bets resolve against the alternating
 * deal that follows.
 *
 * Every position is priced to the same 90% return, so no bet on the felt is
 * better value than any other.
 *
 *   andar x1.7476 / bahar x1.8556
 *     The two sides are NOT equally likely, so they cannot carry one price.
 *     The deal always starts on Andar.  After the joker is removed 51 cards
 *     remain, three of them joker-rank, and their positions are a uniform
 *     3-subset of 1..51.  The first match lands on an odd (Andar) position with
 *       P(andar) = sum over odd k of C(51-k,2) / C(51,3) = 10725/20825
 *                = 429/833 = 0.5150060,  P(bahar) = 404/833 = 0.4849940.
 *     Each side is therefore priced from its own probability, m = 0.90 / P:
 *     Andar : 1.7476 x 429/833 = 0.9000245 -> 90.0024% return (edge 9.9976%)
 *     Bahar : 1.8556 x 404/833 = 0.8999549 -> 89.9955% return (edge 10.0045%)
 *     (Both land within 0.005 percentage points of 90%; the exact prices
 *     0.90 x 833/429 and 0.90 x 833/404 are non-terminating decimals.)
 *   rank-a .. rank-k     x11.7  : 11.7 x 1/13 = 0.90 -> 90.00% (edge 10.00%)
 *   spade/heart/club/diamond x3.6 : 3.6 x 1/4  = 0.90 -> 90.00% (edge 10.00%)
 *   red / black          x1.8   : 1.8  x 1/2  = 0.90 -> 90.00% (edge 10.00%)
 *   seven (card-7 marker) x11.7 : 11.7 x 1/13 = 0.90 -> 90.00% (edge 10.00%)
 *   a-6 (small) / 8-k (big) x1.95 : 1.95 x 6/13 = 0.90 -> 90.00% (edge 10.00%)
 */
const FUN_AB_HOUSE_MULTIPLIERS: Readonly<Record<string, number>> = Object.freeze({
  andar: 1.7476,
  bahar: 1.8556,
  spade: 3.6,
  heart: 3.6,
  club: 3.6,
  diamond: 3.6,
  red: 1.8,
  black: 1.8,
  "a-6": 1.95,
  seven: 11.7,
  "8-k": 1.95,
});

const FUN_AB_RANK_MULTIPLIER = 11.7;

export function funAbHouseMultiplier(selection: FunAbSelection): number {
  return Object.hasOwn(FUN_AB_HOUSE_MULTIPLIERS, selection)
    ? FUN_AB_HOUSE_MULTIPLIERS[selection]
    : FUN_AB_RANK_MULTIPLIER;
}

export function generateFunAbOutcome(entropy: ServerEntropy): FunAbOutcome {
  const deck: WireCard[] = [...STANDARD_DECK];
  const joker = drawWithoutReplacement(deck, entropy, "Fun AB joker");
  const jokerRank = parseWireCard(joker).rank;
  const sequence: Array<{ card: WireCard; side: FunAbSide }> = [];
  // Three joker-rank cards remain in the 51-card shoe, so the alternating deal
  // always terminates well inside the 51-card sequence ceiling.
  for (;;) {
    const card = drawWithoutReplacement(deck, entropy, "Fun AB deal");
    const side: FunAbSide = sequence.length % 2 === 0 ? "andar" : "bahar";
    sequence.push({ card, side });
    if (parseWireCard(card).rank === jokerRank) break;
  }
  return validateFunAbOutcome({
    kind: "andar_bahar",
    joker,
    sequence,
    winner: sequence[sequence.length - 1].side,
  });
}

export function settleFunAb(
  selection: FunAbSelection,
  stakePoints: number,
  outcome: FunAbOutcome,
): SettlementResult {
  const position = normalizeFunAbSelection(selection);
  const stake = funAbStake(stakePoints, position);
  const payout = markerWins(position, outcome)
    ? Math.floor(stake * funAbHouseMultiplier(position))
    : 0;
  return Object.freeze({
    stake_points: stake,
    payout_points: payout,
    net_points: payout - stake,
  });
}

export const FUN_AB_RESOLVER: ReviewResolverModule<FunAbSelection, FunAbOutcome, FunAbInspection> = Object.freeze({
  manifest: Object.freeze({
    catalog_slug: "fun-ab",
    module_id: "fun-ab-review-v1",
    live_resolver_id: "fun-ab-v1",
    ruleset_version: 1,
    readiness: "READY",
    virtual_points_only: true,
    action_policy: Object.freeze({
      observed: Object.freeze(["place_bet", "clear_bets", "repeat_bets", "collect_full"]),
      executable: Object.freeze(["place_bet", "clear_bets", "repeat_bets", "collect_full"]),
    }),
    timing: Object.freeze({
      status: "VERIFIED",
      mode: "CLOCKED_SHARED",
      bet_seconds: 36,
      lock_seconds: 6,
      reveal_seconds: 2,
      result_seconds: 5,
      note: "Operator-declared ruleset v1 round cadence: 36s betting, 6s lock, 2s reveal, 5s result.",
    }),
    settlement: Object.freeze({
      status: "VERIFIED",
      unit: "VIRTUAL_POINTS",
      payout_semantics: "TOTAL_RETURN",
      note: "Operator-declared ruleset v1 house paytable in total returned virtual points: andar 1.7476x, bahar 1.8556x, rank 11.7x, suit 3.6x, colour 1.8x, card-7 marker 11.7x, small/big marker 1.95x, each floored to whole points.",
    }),
    blockers: Object.freeze([]),
    evidence: Object.freeze([
      "chakri-unity/docs/prep/fun-ab-observation.md",
      "chakri-unity/Assets/Scripts/Engines/Tables.cs#AndarBahar",
      "FunGame-Admin/docs/LIVE_GAME_PARITY_READINESS_AUDIT.md",
    ]),
  }),
  normalizeSelection: normalizeFunAbSelection,
  validateOutcome: validateFunAbOutcome,
  inspectOutcome: inspectFunAbOutcome,
  generateOutcome: generateFunAbOutcome,
  settle: settleFunAb,
  deterministicVectors: Object.freeze([
    Object.freeze({
      name: "matching-rank-lands-on-bahar",
      input: Object.freeze({
        selection: "bahar",
        outcome: Object.freeze({ joker: "7H", sequence: Object.freeze(["3C->andar", "7D->bahar"]) }),
      }),
      expected: Object.freeze({ winner: "bahar", matched: true, local_review_total_return_multiplier: 1.8556 }),
    }),
    Object.freeze({
      name: "rank-selection-recognized-but-unpriced",
      input: Object.freeze({ selection: "rank-7", joker: "7H" }),
      expected: Object.freeze({ matched: true, payout_points: null }),
    }),
  ]),
});
