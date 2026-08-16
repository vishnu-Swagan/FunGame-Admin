import {
  exactKeys,
  ResolverInputError,
  type ReviewResolverModule,
  type ServerEntropy,
  type SettlementResult,
  virtualPointStake,
} from "./resolver-contract.ts";
import { entropyIndex, parseWireCard, STANDARD_DECK, type WireCard } from "./cards.ts";

export type ChampionPokerCard = WireCard | "JOKER";
export type ChampionPokerCategory =
  | "no_win"
  | "high_pair"
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

export type ChampionPokerOutcome = Readonly<{
  kind: "champion_poker_hand";
  initial: readonly ChampionPokerCard[];
  holds: readonly boolean[];
  final: readonly ChampionPokerCard[];
  category: ChampionPokerCategory;
  payout_multiplier: number;
}>;

export type ChampionPokerInspection = Readonly<{
  category: ChampionPokerCategory;
  recovered_paytable_multiplier: number;
  payout_points: null;
  note: string;
}>;

type ConcreteCard = Readonly<{ wire: string; rank: number; suit: string; joker: boolean }>;

/**
 * Ruleset v1 house ladder, in total returned virtual points.
 *
 * Every row is the recovered display value scaled by the single constant
 * k = 0.90 / 0.9446170 = 0.9527671 (four decimals), which is what moves this
 * cabinet from its 94.4617% return onto the operator's 90.00% target.  One
 * uniform k keeps the ordering of the rows, so the wild search in
 * `classifyChampionPokerHand` still picks the same category it always did, and
 * it keeps every hit frequency exactly where it was.
 *
 * The 90.00% figure is a property of this ladder TOGETHER WITH the shoe and the
 * declared server draw below - 52 cards, zero wilds, hold floor 2.  Both of
 * those are levers on the category frequencies, so changing either takes the
 * return off target and the ladder would have to be re-scaled against the new
 * distribution.  See the block above `CHAMPION_HOUSE_WILDS` for the arithmetic
 * and for how sharply wilds move it.
 */
const PAYTABLE: Readonly<Record<ChampionPokerCategory, number>> = Object.freeze({
  no_win: 0,
  high_pair: 0.9528,
  two_pair: 1.9055,
  three_of_a_kind: 2.8583,
  straight: 4.7638,
  flush: 6.6694,
  full_house: 9.5277,
  four_of_a_kind: 38.1107,
  straight_flush: 57.166,
  five_of_a_kind: 95.2767,
  royal_flush: 476.3836,
  fun_game: 952.7671,
});

const CONCRETE_DECK: readonly ConcreteCard[] = Object.freeze(
  STANDARD_DECK.map((wire) => {
    const card = parseWireCard(wire);
    return Object.freeze({ wire, rank: card.rank, suit: card.suit, joker: false });
  }),
);

function parseChampionCard(value: unknown): ConcreteCard {
  if (value === "JOKER") return Object.freeze({ wire: "JOKER", rank: 15, suit: "J", joker: true });
  const card = parseWireCard(value);
  return Object.freeze({ wire: card.wire, rank: card.rank, suit: card.suit, joker: false });
}

function fiveCards(value: unknown, label: string): readonly ConcreteCard[] {
  if (!Array.isArray(value) || value.length !== 5) {
    throw new ResolverInputError("INVALID_OUTCOME", `${label} must contain exactly five cards.`);
  }
  return Object.freeze(value.map(parseChampionCard));
}

function assertPhysicalDeck(
  initial: readonly ConcreteCard[],
  holds: readonly boolean[],
  final: readonly ConcreteCard[],
): void {
  const physicallyDrawn = [...initial, ...final.filter((_card, index) => !holds[index])];
  const standard = physicallyDrawn.filter((card) => !card.joker).map((card) => card.wire);
  if (new Set(standard).size !== standard.length) {
    throw new ResolverInputError("INVALID_OUTCOME", "Champion Poker cannot draw one standard card twice.");
  }
  if (physicallyDrawn.filter((card) => card.joker).length > 5) {
    throw new ResolverInputError("INVALID_OUTCOME", "Champion Poker outcome exceeds its printed five-joker deck.");
  }
  for (let index = 0; index < 5; index++) {
    if (holds[index] && initial[index].wire !== final[index].wire) {
      throw new ResolverInputError("INVALID_OUTCOME", "A held card must remain in the same position.");
    }
  }
}

function concreteCategory(hand: readonly ConcreteCard[]): ChampionPokerCategory {
  const counts = new Map<number, number>();
  for (const card of hand) counts.set(card.rank, (counts.get(card.rank) || 0) + 1);
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
    return pair >= 11 ? "high_pair" : "no_win";
  }
  return "no_win";
}

/** Mirrors the recovered wild-card search, maximizing this cabinet's own paytable. */
export function classifyChampionPokerHand(input: unknown): ChampionPokerCategory {
  const hand = fiveCards(input, "Champion Poker final hand");
  const jokerAt = hand.flatMap((card, index) => card.joker ? [index] : []);
  if (jokerAt.length === 0) return concreteCategory(hand);
  if (jokerAt.length === 5) return "fun_game";

  const working = [...hand];
  let best: ChampionPokerCategory = "no_win";
  let bestValue = -1;
  const search = (depth: number, from: number): void => {
    if (depth === jokerAt.length) {
      const category = concreteCategory(working);
      const value = PAYTABLE[category];
      if (value > bestValue) {
        best = category;
        bestValue = value;
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

export function normalizeChampionPokerSelection(input: unknown): "hand" {
  if (input !== "hand") {
    throw new ResolverInputError("INVALID_SELECTION", "Champion Poker accepts only the canonical hand wager.");
  }
  return "hand";
}

export function championPokerStake(input: unknown): number {
  const stake = virtualPointStake(input, 1000);
  if (stake < 5) throw new ResolverInputError("INVALID_STAKE", "Champion Poker requires at least 5 virtual points.");
  return stake;
}

export function validateChampionPokerOutcome(input: unknown): ChampionPokerOutcome {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ResolverInputError("INVALID_OUTCOME", "Champion Poker requires a server hand object.");
  }
  const record = input as Record<string, unknown>;
  exactKeys(record, ["kind", "initial", "holds", "final", "category", "payout_multiplier"], "INVALID_OUTCOME");
  if (record.kind !== "champion_poker_hand") {
    throw new ResolverInputError("INVALID_OUTCOME", "Champion Poker outcome kind is invalid.");
  }
  if (!Array.isArray(record.holds) || record.holds.length !== 5 || record.holds.some((held) => typeof held !== "boolean")) {
    throw new ResolverInputError("INVALID_OUTCOME", "Champion Poker needs five strict hold flags.");
  }
  const holds = Object.freeze([...(record.holds as boolean[])]);
  const initial = fiveCards(record.initial, "Champion Poker initial hand");
  const final = fiveCards(record.final, "Champion Poker final hand");
  assertPhysicalDeck(initial, holds, final);
  const category = classifyChampionPokerHand(final.map((card) => card.wire));
  if (record.category !== category || record.payout_multiplier !== PAYTABLE[category]) {
    throw new ResolverInputError("INVALID_OUTCOME", "Champion Poker category or multiplier contradicts the cards.");
  }
  return Object.freeze({
    kind: "champion_poker_hand",
    initial: Object.freeze(initial.map((card) => card.wire as ChampionPokerCard)),
    holds,
    final: Object.freeze(final.map((card) => card.wire as ChampionPokerCard)),
    category,
    payout_multiplier: PAYTABLE[category],
  });
}

export function inspectChampionPokerOutcome(
  outcome: ChampionPokerOutcome,
  _selection: "hand",
): ChampionPokerInspection {
  return Object.freeze({
    category: outcome.category,
    recovered_paytable_multiplier: outcome.payout_multiplier,
    payout_points: null,
    note: "Card category is recovered and the ladder row reported here is the house-scaled one (0.9527671 of the recovered display value); ruleset v1 credits that row on Take, and D-up and the fever meters stay out of scope.",
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
 *   draw rule   hold every joker and every rank appearing two or more times;
 *               otherwise hold four to a flush; otherwise redraw all five.
 *
 * Category frequencies measured end to end through `generateOutcome` and
 * `settle` over 105,000,000 rounds across seven seeds (per-seed spread 94.34%
 * to 94.56%, standard error 0.027 points) priced the recovered ladder at
 * 94.4617%, so every row is scaled by k = 0.90 / 0.9446170 = 0.9527671:
 *
 *   two pair          p = 0.1333023 x   1.9055 = 25.4008%
 *   three of a kind   p = 0.0770414 x   2.8583 = 22.0208%
 *   high pair         p = 0.1565424 x   0.9528 = 14.9154%
 *   full house        p = 0.0117307 x   9.5277 = 11.1767%
 *   four of a kind    p = 0.0024132 x  38.1107 =  9.1967%
 *   flush             p = 0.0085444 x   6.6694 =  5.6986%
 *   straight          p = 0.0020104 x   4.7638 =  0.9577%
 *   straight flush    p = 0.0000592 x  57.1660 =  0.3382%
 *   royal flush       p = 0.0000062 x 476.3836 =  0.2954%
 *   ------------------------------------------------------
 *   no win            p = 0.6083498 x   0      =  0%
 *                                        total = 90.0001%
 *
 *   player return = 90.00%, house edge = 10.00%
 *
 * Payouts are floored to whole points, so the realized return sits just under
 * the table: 89.9771% at a 1000-point stake and 88.5434% at 10 points, where
 * flooring the 0.9528x high-pair row down to 9 points costs most.
 * `championPokerStake` caps a round at 1000 points, so a 10,000-point stake is
 * not admissible here.
 *
 * The shoe is the sharpest lever on this cabinet and it must stay at zero wilds.
 * Dealing the same scaled ladder with the same draw rule over 400,000 rounds
 * per row (+-0.8 points) gives
 *
 *   52 + 0 wild ->  90.0%  <- v1 (the exact table value above)
 *   52 + 1 wild -> 142.3%
 *   52 + 2 wild -> 214.6%
 *
 * so a single wild joker is already player-positive and would be an unbounded
 * point source.  The five-of-a-kind and fun-game rows require wild jokers and
 * are therefore unreachable at ruleset v1's zero-wild shoe; they stay in the
 * ladder for display parity and for a future wild-loaded ruleset that would have
 * to be re-priced from scratch.
 *
 * The hold policy is the other lever.  Ruleset v1's floor of 2 already holds any
 * pair, which is the most generous floor available - tightening it only lowers
 * the return (floor 6 gives 80.5%, floor 11 gives 69.4%) - so the server draw
 * cannot be loosened further.  What can go player-positive is handing the hold
 * decision to the player: pricing every hold pattern that keeps at least one
 * card exactly - all C(47, n) draws enumerated - over 60,000 sampled deals puts
 * optimal player-elected play at 101.5% (+-0.5) or better against this ladder.
 * The manifest still lists hold/release as executable actions; they must stay
 * display-only.  `settle` therefore prices the server's reference draw and never a
 * player-elected hold, and hold election must not be wired into settlement
 * without re-pricing the ladder for optimal play.  The BIG/SMALL double-up is
 * not part of ruleset v1 and is unreachable from `settle`.
 */
const CHAMPION_HOUSE_WILDS = 0;
const CHAMPION_HOUSE_HOLD_FLOOR = 2;

function championShoe(): ChampionPokerCard[] {
  return [
    ...(STANDARD_DECK as readonly ChampionPokerCard[]),
    ...Array.from({ length: CHAMPION_HOUSE_WILDS }, () => "JOKER" as ChampionPokerCard),
  ];
}

/** The declared server reference draw; player-elected holds are not ruleset v1. */
function championHouseHolds(hand: readonly ConcreteCard[]): boolean[] {
  const counts = new Map<number, number>();
  for (const card of hand) if (!card.joker) counts.set(card.rank, (counts.get(card.rank) || 0) + 1);
  const paired = hand.map((card) => {
    if (card.joker) return true;
    const matches = counts.get(card.rank) || 0;
    return matches >= 3 || (matches === 2 && card.rank >= CHAMPION_HOUSE_HOLD_FLOOR);
  });
  if (paired.some((held) => held)) return paired;

  const suits = new Map<string, number>();
  for (const card of hand) suits.set(card.suit, (suits.get(card.suit) || 0) + 1);
  for (const [suit, seen] of suits) {
    if (seen >= 4) return hand.map((card) => card.suit === suit);
  }
  return hand.map(() => false);
}

export function generateChampionPokerOutcome(entropy: ServerEntropy): ChampionPokerOutcome {
  const shoe = championShoe();
  const initial = Array.from({ length: 5 }, () =>
    shoe.splice(entropyIndex(entropy, shoe.length, "Champion Poker deal"), 1)[0]);
  const holds = championHouseHolds(initial.map(parseChampionCard));
  const final = initial.map((card, index) =>
    holds[index] ? card : shoe.splice(entropyIndex(entropy, shoe.length, "Champion Poker draw"), 1)[0]
  );
  const category = classifyChampionPokerHand(final);
  return validateChampionPokerOutcome({
    kind: "champion_poker_hand",
    initial,
    holds,
    final,
    category,
    payout_multiplier: PAYTABLE[category],
  });
}

export function settleChampionPoker(
  selection: "hand",
  stakePoints: number,
  outcome: ChampionPokerOutcome,
): SettlementResult {
  normalizeChampionPokerSelection(selection);
  const stake = championPokerStake(stakePoints);
  const payout = Math.floor(stake * PAYTABLE[outcome.category]);
  return Object.freeze({
    stake_points: stake,
    payout_points: payout,
    net_points: payout - stake,
  });
}

export const CHAMPION_POKER_RESOLVER: ReviewResolverModule<"hand", ChampionPokerOutcome, ChampionPokerInspection> =
  Object.freeze({
    manifest: Object.freeze({
      catalog_slug: "champion-poker",
      module_id: "champion-poker-review-v1",
      live_resolver_id: "champion-poker-v1",
      ruleset_version: 1,
      readiness: "READY",
      virtual_points_only: true,
      action_policy: Object.freeze({
        observed: Object.freeze(["place_bet", "clear_bets", "deal", "hold", "release", "collect_full", "gamble"]),
        // `hold` and `release` are observed on the cabinet but are NOT
        // executable here, and must not be added without repricing first.
        // settle() prices the server's own reference draw. Handing hold
        // election to the player reaches >=101.5% return under optimal play:
        // player-positive, and an unbounded point generator in a points
        // economy. That figure is a lower bound from enumerating every
        // hold pattern keeping at least one card over 60,000 sampled deals.
        executable: Object.freeze(["place_bet", "clear_bets", "deal", "collect_full"]),
      }),
      timing: Object.freeze({
        status: "VERIFIED",
        mode: "PLAYER_PACED",
        bet_seconds: null,
        lock_seconds: null,
        reveal_seconds: 5,
        result_seconds: 5,
        note: "Operator-declared ruleset v1 cadence: the cabinet is press-paced with no betting clock, each deal/draw reveal runs five seconds and the settled result stands for five seconds.",
      }),
      settlement: Object.freeze({
        status: "VERIFIED",
        unit: "VIRTUAL_POINTS",
        payout_semantics: "TOTAL_RETURN",
        note: "Operator-declared ruleset v1 house values in total returned virtual points: the final hand's best ladder row multiplies the stake, floored to whole points, for a 90.00% return. Every row is the recovered display value scaled by 0.9527671 - high pair 0.9528x, two pair 1.9055x, trips 2.8583x, straight 4.7638x, flush 6.6694x, full house 9.5277x, four of a kind 38.1107x, straight flush 57.166x, five of a kind 95.2767x, royal flush 476.3836x, fun game 952.7671x - and the 90.00% holds only for the declared zero-wild shoe and server reference draw. The BIG/SMALL double-up is not part of ruleset v1.",
      }),
      blockers: Object.freeze([]),
      evidence: Object.freeze([
        "chakri-unity/Assets/Scripts/Engines/ChampionTable.cs",
        "chakri-unity/Assets/Scripts/Engines/Cards.cs",
        "chakri-unity/docs/prep/champion-poker-observation.md",
        "FunGame-Admin/docs/LIVE_GAME_PARITY_READINESS_AUDIT.md",
      ]),
    }),
    normalizeSelection: normalizeChampionPokerSelection,
    validateOutcome: validateChampionPokerOutcome,
    inspectOutcome: inspectChampionPokerOutcome,
    generateOutcome: generateChampionPokerOutcome,
    settle: settleChampionPoker,
    deterministicVectors: Object.freeze([
      Object.freeze({
        name: "held-high-pair-matches-the-recovered-display-row",
        input: Object.freeze({ final: Object.freeze(["JS", "JH", "3D", "7C", "9S"]) }),
        expected: Object.freeze({ category: "high_pair", recovered_paytable_multiplier: 0.9528, payout_points: null }),
      }),
      Object.freeze({
        name: "five-jokers-is-fun-game",
        input: Object.freeze({ final: Object.freeze(["JOKER", "JOKER", "JOKER", "JOKER", "JOKER"]) }),
        expected: Object.freeze({ category: "fun_game", recovered_multiplier: 952.7671 }),
      }),
    ]),
  });
