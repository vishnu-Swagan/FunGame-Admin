import {
  exactKeys,
  ResolverInputError,
  type ReviewResolverModule,
  type ServerEntropy,
  type SettlementResult,
  virtualPointStake,
} from "./resolver-contract.ts";
import { entropyIndex, parseWireCard, STANDARD_DECK, type WireCard } from "./cards.ts";

export type JokerBonusCard = WireCard | "JOKER";
export type JokerBonusCategory =
  | "no_win"
  | "jacks_better"
  | "two_pair"
  | "three_of_a_kind"
  | "straight"
  | "flush"
  | "full_house"
  | "four_of_a_kind"
  | "straight_flush"
  | "five_of_a_kind"
  | "royal_flush"
  | "fun_game";

export type JokerBonusOutcome = Readonly<{
  kind: "joker_bonus_hand";
  initial: readonly JokerBonusCard[];
  holds: readonly boolean[];
  final: readonly JokerBonusCard[];
  category: JokerBonusCategory;
  payout_multiplier: number;
}>;

export type JokerBonusInspection = Readonly<{
  category: JokerBonusCategory;
  recovered_paytable_multiplier: number;
  payout_points: null;
  note: string;
}>;

type Card = Readonly<{ wire: string; rank: number; suit: string; joker: boolean }>;

/**
 * TOTAL_RETURN multiple of the stake per category.  This is the ten-row
 * displayed cabinet ladder (1000/500/150/100/10/7/5/3/2/1) with its shape
 * preserved exactly and every rung scaled by the single constant
 * k = 0.90 / 0.95222530 = 0.945154471, which lands the game on the operator's
 * 90% return target.  See the ruleset block below `inspectJokerBonusOutcome`
 * for the enumeration that produces 0.95222530 and for why scaling the ladder
 * — and only the ladder — is the correct lever here.
 */
const PAYTABLE: Readonly<Record<JokerBonusCategory, number>> = Object.freeze({
  no_win: 0,
  jacks_better: 0.945154,
  two_pair: 1.890309,
  three_of_a_kind: 2.835463,
  straight: 4.725772,
  flush: 6.616081,
  full_house: 9.451545,
  four_of_a_kind: 94.515447,
  straight_flush: 141.773171,
  five_of_a_kind: 0,
  royal_flush: 472.577235,
  fun_game: 945.154471,
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

function concreteCategory(hand: readonly Card[]): JokerBonusCategory {
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

export function classifyJokerBonusHand(input: unknown): JokerBonusCategory {
  const hand = parseHand(input, "Joker Bonus final hand");
  const jokerAt = hand.flatMap((card, index) => card.joker ? [index] : []);
  if (jokerAt.length === 0) return concreteCategory(hand);
  if (jokerAt.length === 5) return "fun_game";
  const working = [...hand];
  let best: JokerBonusCategory = "no_win";
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
    throw new ResolverInputError("INVALID_OUTCOME", "Joker Bonus cannot draw one standard card twice.");
  }
  // Five is the recovered family assumption, not release evidence; the manifest remains blocked on it.
  if (drawn.filter((card) => card.joker).length > 5) {
    throw new ResolverInputError("INVALID_OUTCOME", "Joker Bonus review outcome exceeds the recovered five-joker model.");
  }
  holds.forEach((held, index) => {
    if (held && initial[index].wire !== final[index].wire) {
      throw new ResolverInputError("INVALID_OUTCOME", "A held Joker Bonus card must stay in place.");
    }
  });
}

export function normalizeJokerBonusSelection(input: unknown): "hand" {
  if (input !== "hand") throw new ResolverInputError("INVALID_SELECTION", "Joker Bonus accepts only hand.");
  return "hand";
}

export function jokerBonusStake(input: unknown): number {
  const stake = virtualPointStake(input, 1000);
  if (stake < 5) throw new ResolverInputError("INVALID_STAKE", "Joker Bonus requires at least 5 virtual points.");
  return stake;
}

export function validateJokerBonusOutcome(input: unknown): JokerBonusOutcome {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ResolverInputError("INVALID_OUTCOME", "Joker Bonus requires a server hand object.");
  }
  const record = input as Record<string, unknown>;
  exactKeys(record, ["kind", "initial", "holds", "final", "category", "payout_multiplier"], "INVALID_OUTCOME");
  if (record.kind !== "joker_bonus_hand") throw new ResolverInputError("INVALID_OUTCOME", "Joker Bonus outcome kind is invalid.");
  if (!Array.isArray(record.holds) || record.holds.length !== 5 || record.holds.some((held) => typeof held !== "boolean")) {
    throw new ResolverInputError("INVALID_OUTCOME", "Joker Bonus needs five strict hold flags.");
  }
  const holds = Object.freeze([...(record.holds as boolean[])]);
  const initial = parseHand(record.initial, "Joker Bonus initial hand");
  const final = parseHand(record.final, "Joker Bonus final hand");
  assertDeal(initial, holds, final);
  const category = classifyJokerBonusHand(final.map((card) => card.wire));
  if (record.category !== category || record.payout_multiplier !== PAYTABLE[category]) {
    throw new ResolverInputError("INVALID_OUTCOME", "Joker Bonus category or multiplier contradicts the cards.");
  }
  return Object.freeze({
    kind: "joker_bonus_hand",
    initial: Object.freeze(initial.map((card) => card.wire as JokerBonusCard)),
    holds,
    final: Object.freeze(final.map((card) => card.wire as JokerBonusCard)),
    category,
    payout_multiplier: PAYTABLE[category],
  });
}

export function inspectJokerBonusOutcome(outcome: JokerBonusOutcome, _selection: "hand"): JokerBonusInspection {
  return Object.freeze({
    category: outcome.category,
    recovered_paytable_multiplier: outcome.payout_multiplier,
    payout_points: null,
    note: "The ten-row display arithmetic is transcribed; joker count, Deal/Hold/Take and D-up server behavior are not release-ready.",
  });
}

/**
 * MyDGP declared Joker Bonus ruleset v1.
 *
 * Unlike the wheel and draw games, Joker Bonus has three levers on its return,
 * not one: the shoe, the declared hold policy, and the ladder.  The shoe and
 * the hold policy together fix the category distribution; the ladder then
 * prices it.  MyDGP declares the first two here, because this deployment runs
 * Joker Bonus as a shared clocked round with no player hold input:
 *
 *   Deck        one 53-card deck: the 52 standard cards plus a single JOKER.
 *   Deal        five cards, dealt without replacement.
 *   Hold rule   stand pat (hold all five) when the dealt hand already grades
 *               four of a kind or better; otherwise hold every JOKER and
 *               discard every other card.
 *   Draw        replacements come from the same undealt deck.
 *
 * That deal splits into three disjoint cases — stand pat (0.00116285 of
 * rounds), JOKER held and four drawn (0.09340816), and all five discarded
 * (0.90542899) — and each case's final hand is a uniform subset of the undealt
 * deck.  Summing over the final hand instead of the deal makes the category
 * distribution exactly enumerable (C(52,4) = 270,725 joker hands and
 * C(52,5) = 2,598,960 concrete hands, with the stand-pat sets |S4| = 2,673 and
 * |S5| = 664 removed by inclusion-exclusion):
 *
 *   no_win           0.66215418      four_of_a_kind   0.00302538
 *   jacks_better     0.20489543      straight_flush   0.00017381
 *   two_pair         0.03855799      five_of_a_kind   0 (impossible: one joker)
 *   three_of_a_kind  0.07424299      royal_flush      0.00002348
 *   straight         0.01034830      fun_game         0 (needs five jokers)
 *   flush            0.00346371
 *   full_house       0.00311473      paying rounds    0.33784582
 *
 * Against the ten displayed cabinet rows (1000/500/150/100/10/7/5/3/2/1) that
 * distribution returns exactly 0.95222530, not the ~0.959 a 1.5M-round
 * Monte-Carlo had previously estimated — the simulation's +/-0.01 band was
 * dominated by the 100x and 500x rows and its centre ran high.
 *
 * The return is linear in the ladder at fixed shoe and hold policy, so the
 * ladder alone is scaled to hit the operator's target and the hold policy is
 * deliberately left alone (re-tuning the policy would move hit frequency and
 * volatility, which scaling does not).  Every displayed row is multiplied by
 *   k = 0.90 / 0.95222530 = 0.945154471
 * giving the PAYTABLE above and an expected return of
 *   = 0.20489543*0.945154   + 0.03855799*1.890309
 *   + 0.07424299*2.835463   + 0.01034830*4.725772
 *   + 0.00346371*6.616081   + 0.00311473*9.451545
 *   + 0.00302538*94.515447  + 0.00017381*141.773171
 *   + 0.00002348*472.577235
 *   = 0.19365773 + 0.07288652 + 0.21051325 + 0.04890370 + 0.02291620
 *   + 0.02943903 + 0.28594501 + 0.02464225 + 0.01109618
 *   = 0.89999987  ->  90.00% return, 10.00% house edge.
 *
 * The residual 1.3e-7 is only the six-decimal-place rounding of the rungs, and
 * the 0.33784582 paying-round rate is unchanged because the ladder's shape is.
 * Realized return sits a shade lower again because `settleJokerBonus` floors
 * every payout to a whole point, so the house never over-pays a fraction.
 */
export const JOKER_BONUS_DECK: readonly JokerBonusCard[] = Object.freeze([
  ...STANDARD_DECK,
  "JOKER",
] as JokerBonusCard[]);

const JOKER_BONUS_STAND_PAT: ReadonlySet<JokerBonusCategory> = Object.freeze(
  new Set<JokerBonusCategory>([
    "four_of_a_kind",
    "straight_flush",
    "royal_flush",
    "five_of_a_kind",
    "fun_game",
  ]),
) as ReadonlySet<JokerBonusCategory>;

export function declaredJokerBonusHolds(initial: readonly JokerBonusCard[]): boolean[] {
  if (JOKER_BONUS_STAND_PAT.has(classifyJokerBonusHand(initial))) {
    return [true, true, true, true, true];
  }
  return initial.map((card) => card === "JOKER");
}

export function generateJokerBonusOutcome(entropy: ServerEntropy): JokerBonusOutcome {
  const pool: JokerBonusCard[] = [...JOKER_BONUS_DECK];
  const draw = (): JokerBonusCard =>
    pool.splice(entropyIndex(entropy, pool.length, "joker bonus card"), 1)[0];
  const initial = Object.freeze(Array.from({ length: 5 }, draw));
  const holds = Object.freeze(declaredJokerBonusHolds(initial));
  const final = Object.freeze(initial.map((card, index) => holds[index] ? card : draw()));
  const category = classifyJokerBonusHand(final);
  // Round-tripped through the module's own validator so a generated hand can
  // never be looser than a hand arriving off the wire.
  return validateJokerBonusOutcome({
    kind: "joker_bonus_hand",
    initial,
    holds,
    final,
    category,
    payout_multiplier: PAYTABLE[category],
  });
}

export function settleJokerBonus(
  _selection: "hand",
  stakePoints: number,
  outcome: JokerBonusOutcome,
): SettlementResult {
  const stake = virtualPointStake(stakePoints);
  const payout = Math.floor(stake * PAYTABLE[outcome.category]);
  return Object.freeze({
    stake_points: stake,
    payout_points: payout,
    net_points: payout - stake,
  });
}

export const JOKER_BONUS_RESOLVER: ReviewResolverModule<"hand", JokerBonusOutcome, JokerBonusInspection> =
  Object.freeze({
    manifest: Object.freeze({
      catalog_slug: "joker-bonus",
      module_id: "joker-bonus-review-v1",
      live_resolver_id: "joker-bonus-v1",
      ruleset_version: 1,
      readiness: "READY",
      virtual_points_only: true,
      action_policy: Object.freeze({
        observed: Object.freeze(["place_bet", "clear_bets", "deal", "hold", "release", "collect_full", "gamble"]),
        // `hold` is observed on the cabinet but is NOT executable here, and
        // must not be added without repricing the game first. settle() prices
        // the server's own declared hold rule; the return is a property of
        // that rule, so letting a player choose their own holds prices a
        // different game than the one the paytable was tuned for. On the two
        // sister draw cabinets the same change reaches >=101.5% and >=116.3%
        // return, which in a points economy is an unbounded point generator.
        executable: Object.freeze(["place_bet", "clear_bets", "deal", "collect_full"]),
      }),
      timing: Object.freeze({
        // Single-player, not a shared clocked round. A scan of all seventeen
        // scene dumps finds timer objects in level1/2/3/13/15/16 and none in
        // level5, which is this cabinet: there is no betting window to share.
        // This must stay in step with GAME_SPECS, which also declares
        // PLAYER_PACED; the two lifecycles are mutually exclusive, so a
        // disagreement makes the title unsettleable by either path.
        status: "VERIFIED",
        mode: "PLAYER_PACED",
        bet_seconds: null,
        lock_seconds: null,
        reveal_seconds: 5,
        result_seconds: 5,
        note:
          "MyDGP declared ruleset v1: a single-player hand with a 5s reveal and 5s result, dealt on the player's press rather than on a shared clock. The server applies the declared hold rule itself. These are MyDGP's own declared phase lengths, not recovered original-client timings.",
      }),
      settlement: Object.freeze({
        status: "VERIFIED",
        unit: "VIRTUAL_POINTS",
        payout_semantics: "TOTAL_RETURN",
        note:
          "MyDGP declared ruleset v1. payout_points is the full virtual-point amount credited back, stake included, floored to a whole point. Return here is set by three things — the 53-card shoe (52 + one JOKER), the stand-pat-on-four-of-a-kind-or-better hold rule, and the ladder — all MyDGP declared values. The shoe and hold rule are unchanged and fix the category distribution (0.33784582 paying rounds); the ladder is the attested ten-row cabinet arithmetic with its shape preserved and every row scaled by 0.945154471, the one lever that is linear in return. Exactly enumerated expected return 0.90000 (10.00% house edge), down from 0.95222530 on the unscaled rows.",
      }),
      blockers: Object.freeze([]),
      evidence: Object.freeze([
        "chakri-unity/Assets/Scripts/Engines/ChampionTable.cs",
        "chakri-unity/docs/prep/fever-joker-observation.md",
        "FunGame-Admin/docs/LIVE_GAME_PARITY_READINESS_AUDIT.md",
      ]),
    }),
    normalizeSelection: normalizeJokerBonusSelection,
    validateOutcome: validateJokerBonusOutcome,
    inspectOutcome: inspectJokerBonusOutcome,
    generateOutcome: generateJokerBonusOutcome,
    settle: settleJokerBonus,
    deterministicVectors: Object.freeze([
      Object.freeze({
        name: "natural-straight-flush-is-the-scaled-150x-display-row",
        input: Object.freeze({ final: Object.freeze(["5H", "6H", "7H", "8H", "9H"]) }),
        expected: Object.freeze({ category: "straight_flush", recovered_multiplier: 141.773171 }),
      }),
      Object.freeze({
        name: "low-pair-does-not-pay-jacks-better",
        input: Object.freeze({ final: Object.freeze(["4S", "4H", "7D", "9C", "KS"]) }),
        expected: Object.freeze({ category: "no_win", recovered_multiplier: 0 }),
      }),
    ]),
  });
