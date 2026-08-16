import {
  exactKeys,
  ResolverInputError,
  type ReviewResolverModule,
  type ServerEntropy,
  type SettlementResult,
  virtualPointStake,
} from "./resolver-contract.ts";
import { entropyIndex, parseWireCard, STANDARD_DECK, type WireCard } from "./cards.ts";

export type FeverJokerBonusCard = WireCard | "JOKER";
export type FeverJokerBonusCategory =
  | "no_win"
  | "jacks_better"
  | "two_pair"
  | "three_of_a_kind"
  | "straight"
  | "flush"
  | "full_house"
  | "four_of_a_kind"
  | "star_flush"
  | "five_of_a_kind"
  | "royal_flush"
  | "fun_game";

export type FeverJokerBonusOutcome = Readonly<{
  kind: "fever_joker_bonus_hand";
  initial: readonly FeverJokerBonusCard[];
  holds: readonly boolean[];
  final: readonly FeverJokerBonusCard[];
  category: FeverJokerBonusCategory;
  payout_multiplier: number;
}>;

export type FeverJokerBonusInspection = Readonly<{
  category: FeverJokerBonusCategory;
  recovered_paytable_multiplier: number;
  payout_points: null;
  note: string;
}>;

type Card = Readonly<{ wire: string; rank: number; suit: string; joker: boolean }>;

/**
 * Ruleset v1 house ladder, in total returned virtual points.
 *
 * Every row is the recovered display value scaled by the single constant
 * k = 0.90 / 0.9467804 = 0.9505901 (four decimals), which is what moves this
 * cabinet from its 94.6780% return onto the operator's 90.00% target.  One
 * uniform k keeps the ordering of the rows, so the wild search in
 * `classifyFeverJokerBonusHand` still picks the same category it always did, and
 * it keeps every hit frequency exactly where it was.  The five-of-a-kind row
 * pays zero in the recovered table and zero scales to zero.
 *
 * The 90.00% figure is a property of this ladder TOGETHER WITH the shoe and the
 * declared server draw below - 52 cards, zero wilds, hold floor 7.  Both are
 * levers on the category frequencies, and this cabinet's rich 95x four-of-a-kind
 * and 142x STAR FLUSH rows make it unusually sensitive to them, so changing
 * either takes the return off target and the ladder would have to be re-scaled
 * against the new distribution.  See the block above `FEVER_HOUSE_WILDS`.
 */
const PAYTABLE: Readonly<Record<FeverJokerBonusCategory, number>> = Object.freeze({
  no_win: 0,
  jacks_better: 0.9506,
  two_pair: 1.9012,
  three_of_a_kind: 2.8518,
  straight: 4.753,
  flush: 6.6541,
  full_house: 9.5059,
  four_of_a_kind: 95.059,
  star_flush: 142.5885,
  five_of_a_kind: 0,
  royal_flush: 475.295,
  fun_game: 950.5901,
});

const CONCRETE_DECK: readonly Card[] = Object.freeze(STANDARD_DECK.map((wire) => {
  const parsed = parseWireCard(wire);
  return Object.freeze({ wire, rank: parsed.rank, suit: parsed.suit, joker: false });
}));

function parseCard(value: unknown): Card {
  if (value === "JOKER") return Object.freeze({ wire: "JOKER", rank: 15, suit: "J", joker: true });
  const parsed = parseWireCard(value);
  return Object.freeze({ wire: parsed.wire, rank: parsed.rank, suit: parsed.suit, joker: false });
}

function parseHand(value: unknown, label: string): readonly Card[] {
  if (!Array.isArray(value) || value.length !== 5) {
    throw new ResolverInputError("INVALID_OUTCOME", `${label} must contain exactly five cards.`);
  }
  return Object.freeze(value.map(parseCard));
}

function concreteCategory(hand: readonly Card[]): FeverJokerBonusCategory {
  const counts = new Map<number, number>();
  hand.forEach((card) => counts.set(card.rank, (counts.get(card.rank) || 0) + 1));
  const groups = [...counts.values()].sort((left, right) => right - left);
  if (groups[0] === 5) return "five_of_a_kind";
  const ranks = [...counts.keys()].sort((left, right) => left - right);
  const flush = hand.every((card) => card.suit === hand[0].suit);
  const wheel = ranks.length === 5 && ranks.join(",") === "2,3,4,5,14";
  const straight = ranks.length === 5 && (wheel || ranks[4] - ranks[0] === 4);
  if (straight && flush) return !wheel && ranks[0] === 10 ? "royal_flush" : "star_flush";
  if (groups[0] === 4) return "four_of_a_kind";
  if (groups[0] === 3 && groups[1] === 2) return "full_house";
  if (flush) return "flush";
  if (straight) return "straight";
  if (groups[0] === 3) return "three_of_a_kind";
  if (groups[0] === 2 && groups[1] === 2) return "two_pair";
  if (groups[0] === 2) {
    const pair = [...counts].find((entry) => entry[1] === 2)?.[0] || 0;
    return pair >= 11 ? "jacks_better" : "no_win";
  }
  return "no_win";
}

export function classifyFeverJokerBonusHand(input: unknown): FeverJokerBonusCategory {
  const hand = parseHand(input, "Fever Joker Bonus final hand");
  const jokerAt = hand.flatMap((card, index) => card.joker ? [index] : []);
  if (jokerAt.length === 0) return concreteCategory(hand);
  if (jokerAt.length === 5) return "fun_game";
  const working = [...hand];
  let best: FeverJokerBonusCategory = "no_win";
  let bestValue = -1;
  const search = (depth: number, from: number): void => {
    if (depth === jokerAt.length) {
      const category = concreteCategory(working);
      if (PAYTABLE[category] > bestValue) {
        best = category;
        bestValue = PAYTABLE[category];
      }
      return;
    }
    for (let index = from; index < CONCRETE_DECK.length; index++) {
      working[jokerAt[depth]] = CONCRETE_DECK[index];
      search(depth + 1, index);
    }
  };
  search(0, 0);
  return best;
}

function assertDeal(initial: readonly Card[], holds: readonly boolean[], final: readonly Card[]): void {
  const drawn = [...initial, ...final.filter((_card, index) => !holds[index])];
  const standard = drawn.filter((card) => !card.joker).map((card) => card.wire);
  if (new Set(standard).size !== standard.length) {
    throw new ResolverInputError("INVALID_OUTCOME", "Fever Joker Bonus cannot draw one standard card twice.");
  }
  if (drawn.filter((card) => card.joker).length > 5) {
    throw new ResolverInputError("INVALID_OUTCOME", "Fever Joker Bonus review outcome exceeds the recovered five-joker model.");
  }
  holds.forEach((held, index) => {
    if (held && initial[index].wire !== final[index].wire) {
      throw new ResolverInputError("INVALID_OUTCOME", "A held Fever Joker Bonus card must stay in place.");
    }
  });
}

export function normalizeFeverJokerBonusSelection(input: unknown): "hand" {
  if (input !== "hand") throw new ResolverInputError("INVALID_SELECTION", "Fever Joker Bonus accepts only hand.");
  return "hand";
}

export function feverJokerBonusStake(input: unknown): number {
  const stake = virtualPointStake(input, 1000);
  if (stake < 5) {
    throw new ResolverInputError("INVALID_STAKE", "Fever Joker Bonus requires at least 5 virtual points.");
  }
  return stake;
}

export function validateFeverJokerBonusOutcome(input: unknown): FeverJokerBonusOutcome {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ResolverInputError("INVALID_OUTCOME", "Fever Joker Bonus requires a server hand object.");
  }
  const record = input as Record<string, unknown>;
  exactKeys(record, ["kind", "initial", "holds", "final", "category", "payout_multiplier"], "INVALID_OUTCOME");
  if (record.kind !== "fever_joker_bonus_hand") {
    throw new ResolverInputError("INVALID_OUTCOME", "Fever Joker Bonus outcome kind is invalid.");
  }
  if (!Array.isArray(record.holds) || record.holds.length !== 5 || record.holds.some((held) => typeof held !== "boolean")) {
    throw new ResolverInputError("INVALID_OUTCOME", "Fever Joker Bonus needs five strict hold flags.");
  }
  const holds = Object.freeze([...(record.holds as boolean[])]);
  const initial = parseHand(record.initial, "Fever Joker Bonus initial hand");
  const final = parseHand(record.final, "Fever Joker Bonus final hand");
  assertDeal(initial, holds, final);
  const category = classifyFeverJokerBonusHand(final.map((card) => card.wire));
  if (record.category !== category || record.payout_multiplier !== PAYTABLE[category]) {
    throw new ResolverInputError("INVALID_OUTCOME", "Fever Joker Bonus category or multiplier contradicts the cards.");
  }
  return Object.freeze({
    kind: "fever_joker_bonus_hand",
    initial: Object.freeze(initial.map((card) => card.wire as FeverJokerBonusCard)),
    holds,
    final: Object.freeze(final.map((card) => card.wire as FeverJokerBonusCard)),
    category,
    payout_multiplier: PAYTABLE[category],
  });
}

export function inspectFeverJokerBonusOutcome(
  outcome: FeverJokerBonusOutcome,
  _selection: "hand",
): FeverJokerBonusInspection {
  return Object.freeze({
    category: outcome.category,
    recovered_paytable_multiplier: outcome.payout_multiplier,
    payout_points: null,
    note: "STAR FLUSH is the cabinet label for the straight-flush row, and the multiplier reported here is the house-scaled one (0.9505901 of the recovered display value); ruleset v1 scales that row linearly with the stake and leaves D-up out of scope.",
  });
}

/**
 * Operator-declared ruleset v1 house deal and draw (TOTAL_RETURN on the ladder).
 *
 * Three things set this cabinet's return together - the ladder, the shoe and the
 * server's reference draw - and ruleset v1 prices the target by scaling the
 * ladder only, because that alone is linear in return.  The shoe and the draw
 * are declared here and must not move:
 *
 *   shoe        52 standard cards, no wild jokers
 *   draw rule   hold every joker, every rank appearing three or more times and
 *               any pair of sevens or better; otherwise hold four to a flush;
 *               otherwise redraw all five.
 *
 * Category frequencies measured end to end through `generateOutcome` and
 * `settle` over 150,000,000 rounds across ten seeds (per-seed spread 94.47% to
 * 94.84%, standard error 0.041 points) priced the recovered ladder at 94.6780%,
 * so every row is scaled by k = 0.90 / 0.9467804 = 0.9505901:
 *
 *   four of a kind    p = 0.0020980 x  95.0590 = 19.9430%
 *   three of a kind   p = 0.0652578 x   2.8518 = 18.6102%
 *   jacks or better   p = 0.1882162 x   0.9506 = 17.8918%
 *   two pair          p = 0.0912374 x   1.9012 = 17.3461%
 *   full house        p = 0.0074665 x   9.5059 =  7.0976%
 *   flush             p = 0.0098205 x   6.6541 =  6.5347%
 *   straight          p = 0.0026745 x   4.7530 =  1.2712%
 *   star flush        p = 0.0000694 x 142.5885 =  0.9898%
 *   royal flush       p = 0.0000067 x 475.2950 =  0.3162%
 *   ------------------------------------------------------
 *   no win            p = 0.6331531 x   0      =  0%
 *                                        total = 90.0005%
 *
 *   player return = 90.00%, house edge = 10.00%
 *
 * (The 94.1% recorded here before was a 1,000,000-round sample and read about
 * half a point low, almost all of it in the 100x four-of-a-kind row; the
 * 150,000,000-round figure above supersedes it.)
 *
 * Payouts are floored to whole points, so the realized return sits just under
 * the table: 89.9814% at a 1000-point stake and 88.6144% at 10 points, where
 * flooring the 0.9506x jacks-or-better row down to 9 points costs most.
 * `feverJokerBonusStake` caps a round at 1000 points, so a 10,000-point stake is
 * not admissible here.
 *
 * The rich 95x four-of-a-kind and 142x STAR FLUSH rows make this the most
 * lever-sensitive of the five cabinets, and both levers must stay put.  Measured
 * on the scaled ladder over 400,000 rounds per row (+-0.8 points; the two v1
 * rows are the exact 90.00% priced above, not a sample):
 *
 *   shoe, at hold floor 7            hold floor, at the zero-wild shoe
 *     52 + 0 wild ->  90.0%  <- v1     floor  2 (any pair)  -> 105.3%
 *     52 + 1 wild -> 171.5%            floor  6             ->  93.4%
 *     52 + 2 wild -> 294.5%            floor  7  <- v1      ->  90.0%
 *                                      floor  8             ->  87.8%
 *                                      floor 11 (jacks up)  ->  80.1%
 *
 * A wild-loaded shoe, or a hold floor loosened to any pair, is player-positive
 * and would be an unbounded point source; neither may be changed without
 * re-pricing the ladder from scratch.  For the same reason ruleset v1 keeps the
 * hold decision on the server: `settle` prices the reference draw above, never a
 * player-elected hold.  Pricing every hold pattern that keeps at least one card
 * exactly - all C(47, n) draws enumerated - over 60,000 sampled deals puts
 * optimal player-elected play at 116.3% (+-0.9) or better against this ladder,
 * so hold election must never reach settlement without re-pricing the ladder for
 * optimal play.  Note that the manifest still lists hold/release as executable
 * actions; they must stay display-only.
 *
 * The five-of-a-kind row already pays zero in the recovered table, and the
 * fun-game row needs five wild jokers, so both are unreachable at ruleset v1's
 * zero-wild shoe; they stay in the ladder for display parity.  Hold/Take is
 * settled as one round and the D-up panel is not part of ruleset v1.
 */
const FEVER_HOUSE_WILDS = 0;
const FEVER_HOUSE_HOLD_FLOOR = 7;

function feverShoe(): FeverJokerBonusCard[] {
  return [
    ...(STANDARD_DECK as readonly FeverJokerBonusCard[]),
    ...Array.from({ length: FEVER_HOUSE_WILDS }, () => "JOKER" as FeverJokerBonusCard),
  ];
}

/** The declared server reference draw; player-elected holds are not ruleset v1. */
function feverHouseHolds(hand: readonly Card[]): boolean[] {
  const counts = new Map<number, number>();
  for (const card of hand) if (!card.joker) counts.set(card.rank, (counts.get(card.rank) || 0) + 1);
  const paired = hand.map((card) => {
    if (card.joker) return true;
    const matches = counts.get(card.rank) || 0;
    return matches >= 3 || (matches === 2 && card.rank >= FEVER_HOUSE_HOLD_FLOOR);
  });
  if (paired.some((held) => held)) return paired;

  const suits = new Map<string, number>();
  for (const card of hand) suits.set(card.suit, (suits.get(card.suit) || 0) + 1);
  for (const [suit, seen] of suits) {
    if (seen >= 4) return hand.map((card) => card.suit === suit);
  }
  return hand.map(() => false);
}

export function generateFeverJokerBonusOutcome(entropy: ServerEntropy): FeverJokerBonusOutcome {
  const shoe = feverShoe();
  const initial = Array.from({ length: 5 }, () =>
    shoe.splice(entropyIndex(entropy, shoe.length, "Fever Joker Bonus deal"), 1)[0]);
  const holds = feverHouseHolds(initial.map(parseCard));
  const final = initial.map((card, index) =>
    holds[index] ? card : shoe.splice(entropyIndex(entropy, shoe.length, "Fever Joker Bonus draw"), 1)[0]
  );
  const category = classifyFeverJokerBonusHand(final);
  return validateFeverJokerBonusOutcome({
    kind: "fever_joker_bonus_hand",
    initial,
    holds,
    final,
    category,
    payout_multiplier: PAYTABLE[category],
  });
}

export function settleFeverJokerBonus(
  selection: "hand",
  stakePoints: number,
  outcome: FeverJokerBonusOutcome,
): SettlementResult {
  normalizeFeverJokerBonusSelection(selection);
  const stake = feverJokerBonusStake(stakePoints);
  const payout = Math.floor(stake * PAYTABLE[outcome.category]);
  return Object.freeze({
    stake_points: stake,
    payout_points: payout,
    net_points: payout - stake,
  });
}

export const FEVER_JOKER_BONUS_RESOLVER: ReviewResolverModule<
  "hand",
  FeverJokerBonusOutcome,
  FeverJokerBonusInspection
> = Object.freeze({
  manifest: Object.freeze({
    catalog_slug: "fever-joker-bonus",
    module_id: "fever-joker-bonus-review-v1",
    live_resolver_id: "fever-joker-bonus-v1",
    ruleset_version: 1,
    readiness: "READY",
    virtual_points_only: true,
    action_policy: Object.freeze({
      observed: Object.freeze(["place_bet", "clear_bets", "deal", "hold", "release", "collect_full", "gamble"]),
      // `hold` and `release` are observed on the cabinet but are NOT executable
      // here, and must not be added without repricing the game first.
      // settle() prices the server's own reference draw. If hold election were
      // handed to the player, optimal play reaches >=116.3% return: a
      // player-positive game, and in a points economy an unbounded point
      // generator. Enumerating every hold pattern keeping at least one card
      // over 60,000 sampled deals puts that at a lower bound, not a ceiling.
      executable: Object.freeze(["place_bet", "clear_bets", "deal", "collect_full"]),
    }),
    timing: Object.freeze({
      status: "VERIFIED",
      mode: "PLAYER_PACED",
      bet_seconds: null,
      lock_seconds: null,
      reveal_seconds: 5,
      result_seconds: 5,
      note: "Operator-declared ruleset v1 cadence: the two-deal loop is player-paced with no betting clock, each deal/draw reveal runs five seconds and the settled result stands for five seconds.",
    }),
    settlement: Object.freeze({
      status: "VERIFIED",
      unit: "VIRTUAL_POINTS",
      payout_semantics: "TOTAL_RETURN",
      note: "Operator-declared ruleset v1 house values in total returned virtual points: the final hand's best ladder row multiplies the stake, floored to whole points, for a 90.00% return. Every row is the recovered display value scaled by 0.9505901 - jacks or better 0.9506x, two pair 1.9012x, trips 2.8518x, straight 4.753x, flush 6.6541x, full house 9.5059x, four of a kind 95.059x, STAR FLUSH 142.5885x, royal flush 475.295x, fun game 950.5901x, five of a kind 0x as recovered - and the 90.00% holds only for the declared zero-wild shoe and the server reference draw. The D-up panel is not part of ruleset v1.",
    }),
    blockers: Object.freeze([]),
    evidence: Object.freeze([
      "chakri-unity/Assets/Scripts/Engines/ChampionTable.cs",
      "chakri-unity/docs/prep/fever-joker-bonus-observation.md",
      "FunGame-Admin/docs/LIVE_GAME_PARITY_READINESS_AUDIT.md",
    ]),
  }),
  normalizeSelection: normalizeFeverJokerBonusSelection,
  validateOutcome: validateFeverJokerBonusOutcome,
  inspectOutcome: inspectFeverJokerBonusOutcome,
  generateOutcome: generateFeverJokerBonusOutcome,
  settle: settleFeverJokerBonus,
  deterministicVectors: Object.freeze([
    Object.freeze({
      name: "star-flush-row-is-the-scaled-150x-display",
      input: Object.freeze({ final: Object.freeze(["5C", "6C", "7C", "8C", "9C"]) }),
      expected: Object.freeze({ category: "star_flush", recovered_multiplier: 142.5885 }),
    }),
    Object.freeze({
      name: "jacks-better-is-the-scaled-one-times-display",
      input: Object.freeze({ final: Object.freeze(["QS", "QH", "3D", "7C", "9S"]) }),
      expected: Object.freeze({ category: "jacks_better", recovered_multiplier: 0.9506 }),
    }),
  ]),
});
