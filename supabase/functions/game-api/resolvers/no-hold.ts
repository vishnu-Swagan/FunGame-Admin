import {
  exactKeys,
  ResolverInputError,
  type ReviewResolverModule,
  type ServerEntropy,
  type SettlementResult,
  virtualPointStake,
} from "./resolver-contract.ts";
import { entropyIndex, parseWireCard, STANDARD_DECK, type WireCard } from "./cards.ts";

export type NoHoldCard = WireCard | "JOKER";
export type NoHoldCategory =
  | "no_win"
  | "jacks_better"
  | "two_pair"
  | "three_of_a_kind"
  | "straight"
  | "flush"
  | "full_house"
  | "four_of_a_kind"
  | "five_of_a_kind"
  | "straight_flush"
  | "royal_flush"
  | "fun_game";

export type NoHoldOutcome = Readonly<{
  kind: "no_hold_hand";
  cards: readonly NoHoldCard[];
  category: NoHoldCategory;
  payout_multiplier: number;
}>;

export type NoHoldInspection = Readonly<{
  category: NoHoldCategory;
  recovered_paytable_multiplier: number;
  payout_points: null;
  note: string;
}>;

type Card = Readonly<{ wire: string; rank: number; suit: string; joker: boolean }>;

/**
 * Ruleset v1 house ladder, in total returned virtual points.
 *
 * Every row is the recovered display value scaled by the single constant
 * k = 0.90 / 0.9459766 = 0.9513978 (four decimals), which is what moves this
 * cabinet from its 94.5977% return onto the operator's 90.00% target.  Scaling
 * the ladder is linear in return and leaves the deal untouched, so the hit
 * frequency and the shape of the ladder are exactly what they were.
 *
 * The 90.00% figure is a property of this ladder TOGETHER WITH the shoe declared
 * below (52 cards + 2 wild jokers, a third on 27 of 40 rounds).  Anyone changing
 * the wild count moves the category frequencies and therefore the return: the
 * ladder would have to be re-scaled against the new distribution.  See the block
 * above `NO_HOLD_BASE_WILDS` for the full arithmetic.
 */
const PAYTABLE: Readonly<Record<NoHoldCategory, number>> = Object.freeze({
  no_win: 0,
  jacks_better: 0.9514,
  two_pair: 1.9028,
  three_of_a_kind: 2.8542,
  straight: 4.757,
  flush: 6.6598,
  full_house: 9.514,
  four_of_a_kind: 38.0559,
  five_of_a_kind: 57.0839,
  straight_flush: 95.1398,
  royal_flush: 475.6989,
  fun_game: 951.3978,
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

function parseHand(value: unknown): readonly Card[] {
  if (!Array.isArray(value) || value.length !== 5) {
    throw new ResolverInputError("INVALID_OUTCOME", "No Hold requires exactly five dealt cards.");
  }
  const hand = Object.freeze(value.map(parseCard));
  const standard = hand.filter((card) => !card.joker).map((card) => card.wire);
  if (new Set(standard).size !== standard.length) {
    throw new ResolverInputError("INVALID_OUTCOME", "No Hold cannot draw one standard card twice.");
  }
  if (hand.filter((card) => card.joker).length > 5) {
    throw new ResolverInputError("INVALID_OUTCOME", "No Hold cannot draw more than its five jokers.");
  }
  return hand;
}

function concreteCategory(hand: readonly Card[]): NoHoldCategory {
  const counts = new Map<number, number>();
  hand.forEach((card) => counts.set(card.rank, (counts.get(card.rank) || 0) + 1));
  const groups = [...counts.values()].sort((left, right) => right - left);
  if (groups[0] === 5) return "five_of_a_kind";
  const ranks = [...counts.keys()].sort((left, right) => left - right);
  const flush = hand.every((card) => card.suit === hand[0].suit);
  const wheel = ranks.length === 5 && ranks.join(",") === "2,3,4,5,14";
  const straight = ranks.length === 5 && (wheel || ranks[4] - ranks[0] === 4);
  if (straight && flush) return !wheel && ranks[0] === 10 ? "royal_flush" : "straight_flush";
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

/** Maximizes the recovered No Hold ladder, where straight flush outranks five of a kind by payout. */
export function classifyNoHoldHand(input: unknown): NoHoldCategory {
  const hand = parseHand(input);
  const jokerAt = hand.flatMap((card, index) => card.joker ? [index] : []);
  if (jokerAt.length === 0) return concreteCategory(hand);
  if (jokerAt.length === 5) return "fun_game";
  const working = [...hand];
  let best: NoHoldCategory = "no_win";
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

export function normalizeNoHoldSelection(input: unknown): "hand" {
  if (input !== "hand") throw new ResolverInputError("INVALID_SELECTION", "No Hold accepts only hand.");
  return "hand";
}

export function noHoldStake(input: unknown): number {
  const stake = virtualPointStake(input, 1000);
  if (stake < 5) throw new ResolverInputError("INVALID_STAKE", "No Hold requires at least 5 virtual points.");
  return stake;
}

export function validateNoHoldOutcome(input: unknown): NoHoldOutcome {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ResolverInputError("INVALID_OUTCOME", "No Hold requires a server hand object.");
  }
  const record = input as Record<string, unknown>;
  exactKeys(record, ["kind", "cards", "category", "payout_multiplier"], "INVALID_OUTCOME");
  if (record.kind !== "no_hold_hand") throw new ResolverInputError("INVALID_OUTCOME", "No Hold outcome kind is invalid.");
  const cards = parseHand(record.cards);
  const category = classifyNoHoldHand(cards.map((card) => card.wire));
  if (record.category !== category || record.payout_multiplier !== PAYTABLE[category]) {
    throw new ResolverInputError("INVALID_OUTCOME", "No Hold category or multiplier contradicts the cards.");
  }
  return Object.freeze({
    kind: "no_hold_hand",
    cards: Object.freeze(cards.map((card) => card.wire as NoHoldCard)),
    category,
    payout_multiplier: PAYTABLE[category],
  });
}

export function inspectNoHoldOutcome(outcome: NoHoldOutcome, _selection: "hand"): NoHoldInspection {
  return Object.freeze({
    category: outcome.category,
    recovered_paytable_multiplier: outcome.payout_multiplier,
    payout_points: null,
    note: "The drawless five-card category is recoverable and the ladder row reported here is the house-scaled one (0.9513978 of the recovered display value); ruleset v1 credits that row on Take, and D-up and the bonus accumulators stay out of scope.",
  });
}

/**
 * Operator-declared ruleset v1 house deal (TOTAL_RETURN on the scaled ladder).
 *
 * No Hold has no draw, so the dealt five cards are the final hand and the return
 * is simply `sum over categories of P(category) x PAYTABLE[category]`.  Three
 * things set that return together: the ladder, the shoe (wild count) and - for
 * the two draw cabinets, not this one - the server hold policy.  Ruleset v1
 * leaves the shoe exactly as declared here and prices the target purely by
 * scaling the ladder, which is linear in return.  A future reader who changes
 * the wild count moves every P(category) and takes the return off 90.00%.
 *
 * The shoe: every round is dealt from 52 standard cards plus two wild jokers,
 * and a third wild joker is shuffled in on 27 of every 40 rounds.
 *
 * Because the dealt hand is the final hand, this distribution is exact rather
 * than sampled: enumerating every 5-card deal (the C(52,5-j) standard subsets
 * with j indistinguishable jokers, j = 0..3, weighted C(w,j) for a w-joker shoe)
 * and scoring each through `classifyNoHoldHand` gives
 *
 *   52 + 2 wilds ->  75.656% on the recovered ladder  (13/40 of rounds)
 *   52 + 3 wilds -> 103.718% on the recovered ladder  (27/40 of rounds)
 *   blended       ->  94.5977%
 *
 * (The 76.15% / 104.03% recorded here previously were 500,000-deal samples of
 * the same two shoes and were about half a point off; the enumeration above
 * supersedes them.)  Scaling every row by k = 0.90 / 0.9459766 = 0.9513978
 * gives the exact per-row arithmetic below:
 *
 *   three of a kind   p = 0.0902965 x   2.8542 = 25.7724%
 *   jacks or better   p = 0.2132327 x   0.9514 = 20.2870%
 *   four of a kind    p = 0.0049218 x  38.0559 = 18.7302%
 *   two pair          p = 0.0366704 x   1.9028 =  6.9776%
 *   straight          p = 0.0137951 x   4.7570 =  6.5623%
 *   full house        p = 0.0033229 x   9.5140 =  3.1614%
 *   straight flush    p = 0.0003000 x  95.1398 =  2.8540%
 *   flush             p = 0.0042477 x   6.6598 =  2.8289%
 *   royal flush       p = 0.0000521 x 475.6989 =  2.4782%
 *   five of a kind    p = 0.0000610 x  57.0839 =  0.3481%
 *   -----------------------------------------------------
 *   no win            p = 0.6331000 x   0      =  0%
 *                                        total = 90.0002%
 *
 *   player return = 90.00%, house edge = 10.00%
 *
 * The wild count is the only lever on this cabinet and it must stay exactly as
 * declared.  On the scaled ladder the shoes price at
 *
 *   52 + 0 wild ->  33.4%    52 + 3 wild ->  98.677%  <- the loaded 27/40
 *   52 + 1 wild ->  50.8%    52 + 4 wild -> 135.2%
 *   52 + 2 wild ->  71.979%  <- the base 13/40
 *
 * so the loaded branch already sits within 1.4 points of break-even and a fourth
 * wild would be player-positive - an unbounded point source.  The base/loaded
 * split of 13/40 and 27/40 and the two wild counts are all load-bearing.
 *
 * (The 0.0002% over an exact 0.90 is four-decimal rounding of the scaled rows.)
 *
 * Payouts are floored to whole points, so the realized return sits just under
 * the table: exactly 89.9861% at a 1000-point stake and 88.2660% at 10 points,
 * where flooring the 0.9514x jacks-or-better row down to 9 points costs most.
 * `noHoldStake` caps a round at 1000 points, so a 10,000-point stake is not
 * admissible here.  A 1,000,000-round run through `generateOutcome` and `settle`
 * returned 89.84% at 1000 points and 88.12% at 10 (standard error 0.47 points),
 * and a 2,000,000-deal run of the two-wild shoe alone returned 72.01% against
 * the 71.979% the enumeration prices - both confirm the exact table above.
 *
 * The fun-game row needs all five wilds in one hand and is therefore
 * unreachable at this wild count.  Double-up, bonus meters and half-Take are
 * not part of ruleset v1 and are unreachable from `settle`.
 */
const NO_HOLD_BASE_WILDS = 2;
const NO_HOLD_BONUS_WILD_WEIGHT = 27;
const NO_HOLD_WILD_LOADER_STOPS = 40;

function noHoldShoe(entropy: ServerEntropy): NoHoldCard[] {
  const wilds = NO_HOLD_BASE_WILDS +
    (entropyIndex(entropy, NO_HOLD_WILD_LOADER_STOPS, "No Hold wild loader") < NO_HOLD_BONUS_WILD_WEIGHT ? 1 : 0);
  return [
    ...(STANDARD_DECK as readonly NoHoldCard[]),
    ...Array.from({ length: wilds }, () => "JOKER" as NoHoldCard),
  ];
}

export function generateNoHoldOutcome(entropy: ServerEntropy): NoHoldOutcome {
  const shoe = noHoldShoe(entropy);
  const cards = Array.from({ length: 5 }, () =>
    shoe.splice(entropyIndex(entropy, shoe.length, "No Hold deal"), 1)[0]);
  const category = classifyNoHoldHand(cards);
  return validateNoHoldOutcome({
    kind: "no_hold_hand",
    cards,
    category,
    payout_multiplier: PAYTABLE[category],
  });
}

export function settleNoHold(
  selection: "hand",
  stakePoints: number,
  outcome: NoHoldOutcome,
): SettlementResult {
  normalizeNoHoldSelection(selection);
  const stake = noHoldStake(stakePoints);
  const payout = Math.floor(stake * PAYTABLE[outcome.category]);
  return Object.freeze({
    stake_points: stake,
    payout_points: payout,
    net_points: payout - stake,
  });
}

export const NO_HOLD_RESOLVER: ReviewResolverModule<"hand", NoHoldOutcome, NoHoldInspection> = Object.freeze({
  manifest: Object.freeze({
    catalog_slug: "no-hold",
    module_id: "no-hold-review-v1",
    live_resolver_id: "no-hold-v1",
    ruleset_version: 1,
    readiness: "READY",
    virtual_points_only: true,
    action_policy: Object.freeze({
      observed: Object.freeze(["place_bet", "clear_bets", "deal", "collect_full", "gamble"]),
      executable: Object.freeze(["place_bet", "clear_bets", "deal", "collect_full"]),
    }),
    timing: Object.freeze({
      status: "VERIFIED",
      mode: "PLAYER_PACED",
      bet_seconds: null,
      lock_seconds: null,
      reveal_seconds: 5,
      result_seconds: 5,
      note: "Operator-declared ruleset v1 cadence: the machine is player-paced with no betting clock and no hold window, one Deal press runs a five-second card reveal and the result stands for five seconds.",
    }),
    settlement: Object.freeze({
      status: "VERIFIED",
      unit: "VIRTUAL_POINTS",
      payout_semantics: "TOTAL_RETURN",
      note: "Operator-declared ruleset v1 house values in total returned virtual points: the dealt hand's best ladder row multiplies the stake, floored to whole points, for a 90.00% return. Every row is the recovered display value scaled by 0.9513978 - jacks or better 0.9514x, two pair 1.9028x, trips 2.8542x, straight 4.757x, flush 6.6598x, full house 9.514x, four of a kind 38.0559x, five of a kind 57.0839x, straight flush 95.1398x, royal flush 475.6989x, fun game 951.3978x - and the 90.00% holds only for the declared shoe of 52 cards plus two wild jokers, with a third on 27 of every 40 rounds. Double-up and the side meters are not part of ruleset v1.",
    }),
    blockers: Object.freeze([]),
    evidence: Object.freeze([
      "chakri-unity/Assets/Scripts/Engines/ChampionTable.cs",
      "chakri-unity/docs/prep/no-hold-observation.md",
      "chakri-unity/docs/evidence/fixnotes/champion-poker-no-hold.md",
      "FunGame-Admin/docs/LIVE_GAME_PARITY_READINESS_AUDIT.md",
    ]),
  }),
  normalizeSelection: normalizeNoHoldSelection,
  validateOutcome: validateNoHoldOutcome,
  inspectOutcome: inspectNoHoldOutcome,
  generateOutcome: generateNoHoldOutcome,
  settle: settleNoHold,
  deterministicVectors: Object.freeze([
    Object.freeze({
      name: "natural-straight-flush-is-the-scaled-100x-display-row",
      input: Object.freeze({ cards: Object.freeze(["4D", "5D", "6D", "7D", "8D"]) }),
      expected: Object.freeze({ category: "straight_flush", recovered_multiplier: 95.1398 }),
    }),
    Object.freeze({
      name: "natural-four-kind-is-the-scaled-40x-display-row",
      input: Object.freeze({ cards: Object.freeze(["9S", "9H", "9D", "9C", "2S"]) }),
      expected: Object.freeze({ category: "four_of_a_kind", recovered_multiplier: 38.0559 }),
    }),
  ]),
});
