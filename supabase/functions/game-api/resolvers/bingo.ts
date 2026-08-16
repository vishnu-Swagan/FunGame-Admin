import {
  exactKeys,
  ResolverInputError,
  type ReviewResolverModule,
  type ServerEntropy,
  type SettlementResult,
  virtualPointStake,
} from "./resolver-contract.ts";
import { entropyIndex } from "./cards.ts";

export type BingoSelection = Readonly<{
  card_index: number;
  canonical: string;
}>;
export type BingoBall = number | "G";
export type BingoOutcome = Readonly<{
  kind: "bingo_draw";
  drawn: readonly BingoBall[];
}>;
export type BingoInspection = Readonly<{
  completed_lines: number;
  contains_unresolved_g_ball: boolean;
  payout_points: null;
  note: string;
}>;

export const BINGO_CARDS: readonly (readonly (readonly number[])[])[] = Object.freeze([
  Object.freeze([
    Object.freeze([5, 1, 9, 25, 3]), Object.freeze([8, 22, 10, 19, 7]),
    Object.freeze([6, 18, 16, 11, 17]), Object.freeze([24, 21, 14, 20, 13]),
    Object.freeze([12, 23, 2, 4, 15]),
  ]),
  Object.freeze([
    Object.freeze([9, 24, 16, 4, 6]), Object.freeze([13, 19, 14, 20, 25]),
    Object.freeze([2, 18, 15, 12, 17]), Object.freeze([1, 22, 11, 21, 8]),
    Object.freeze([10, 7, 5, 23, 3]),
  ]),
  Object.freeze([
    Object.freeze([6, 7, 3, 24, 1]), Object.freeze([23, 14, 12, 18, 2]),
    Object.freeze([5, 19, 20, 16, 22]), Object.freeze([11, 17, 9, 15, 25]),
    Object.freeze([10, 13, 21, 4, 8]),
  ]),
  Object.freeze([
    Object.freeze([3, 7, 10, 4, 9]), Object.freeze([24, 21, 18, 22, 8]),
    Object.freeze([15, 14, 17, 11, 2]), Object.freeze([13, 20, 12, 19, 23]),
    Object.freeze([6, 25, 16, 1, 5]),
  ]),
  Object.freeze([
    Object.freeze([4, 6, 1, 23, 5]), Object.freeze([25, 15, 3, 17, 13]),
    Object.freeze([9, 19, 21, 12, 20]), Object.freeze([10, 18, 16, 14, 8]),
    Object.freeze([7, 24, 22, 2, 11]),
  ]),
  Object.freeze([
    Object.freeze([8, 23, 10, 13, 4]), Object.freeze([2, 17, 16, 14, 24]),
    Object.freeze([20, 12, 22, 19, 5]), Object.freeze([25, 15, 9, 18, 11]),
    Object.freeze([1, 7, 21, 3, 6]),
  ]),
]);

export function normalizeBingoSelection(input: unknown): BingoSelection {
  if (typeof input !== "string" || !/^card:[1-6]$/.test(input)) {
    throw new ResolverInputError("INVALID_SELECTION", "Bingo selection must identify card:1 through card:6.");
  }
  return Object.freeze({ card_index: Number(input.slice(-1)), canonical: input });
}

export function bingoStake(input: unknown): number {
  // The minimum is observed; preserved evidence conflicts on the maximum.
  // A review validator must not turn either the 500, 1,000 or 5,000 local
  // value into a production limit.
  const stake = virtualPointStake(input);
  if (stake < 5) throw new ResolverInputError("INVALID_STAKE", "Bingo requires at least 5 virtual points.");
  return stake;
}

export function validateBingoOutcome(input: unknown): BingoOutcome {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ResolverInputError("INVALID_OUTCOME", "Bingo requires a server draw object.");
  }
  const record = input as Record<string, unknown>;
  exactKeys(record, ["kind", "drawn"], "INVALID_OUTCOME");
  if (record.kind !== "bingo_draw" || !Array.isArray(record.drawn) || record.drawn.length < 1 || record.drawn.length > 26) {
    throw new ResolverInputError(
      "INVALID_OUTCOME",
      "The provisional Bingo review envelope accepts 1 through 26 ordered balls.",
    );
  }
  const drawn = record.drawn.map((ball) => {
    if (ball === "G") return ball;
    if (!Number.isSafeInteger(ball) || (ball as number) < 1 || (ball as number) > 25) {
      throw new ResolverInputError("INVALID_OUTCOME", "Bingo numeric balls must be integers from 1 through 25.");
    }
    return ball as number;
  });
  const numeric = drawn.filter((ball): ball is number => typeof ball === "number");
  if (new Set(numeric).size !== numeric.length || drawn.filter((ball) => ball === "G").length > 1) {
    throw new ResolverInputError("INVALID_OUTCOME", "Bingo draw cannot repeat a numeric ball or the G marker.");
  }
  return Object.freeze({ kind: "bingo_draw", drawn: Object.freeze(drawn) });
}

export function countBingoLines(cardIndex: number, drawn: readonly BingoBall[]): number {
  if (!Number.isSafeInteger(cardIndex) || cardIndex < 1 || cardIndex > BINGO_CARDS.length) {
    throw new ResolverInputError("INVALID_SELECTION", "Bingo card index is invalid.");
  }
  const card = BINGO_CARDS[cardIndex - 1];
  const marked = new Set(drawn.filter((ball): ball is number => typeof ball === "number"));
  let lines = 0;
  for (let row = 0; row < 5; row++) {
    if (card[row].every((number) => marked.has(number))) lines++;
  }
  for (let column = 0; column < 5; column++) {
    if (card.every((row) => marked.has(row[column]))) lines++;
  }
  if (card.every((row, index) => marked.has(row[index]))) lines++;
  if (card.every((row, index) => marked.has(row[4 - index]))) lines++;
  return lines;
}

export function inspectBingoOutcome(
  outcome: BingoOutcome,
  selection: BingoSelection,
): BingoInspection {
  const hasG = outcome.drawn.includes("G");
  return Object.freeze({
    completed_lines: countBingoLines(selection.card_index, outcome.drawn),
    contains_unresolved_g_ball: hasG,
    payout_points: null,
    note: hasG
      ? "G is preserved in draw order but has no invented marking, bonus or payout meaning."
      : "Line membership is inspectable inside the provisional local envelope; the client draw count and line paytable are not verified.",
  });
}

/**
 * MyDGP declared Bingo ruleset v1.
 *
 * A round draws exactly fifteen distinct numeric balls from 1..25 in reveal
 * order.  The "G" marker stays supported by `validateBingoOutcome` for replay
 * of legacy payloads, but the declared ruleset never emits it and never prices
 * it, so it keeps the "no invented meaning" position of the review module.
 *
 * Every 5x5 card carries the same twelve lines (5 rows, 5 columns, 2
 * diagonals) with the same intersection structure, so the completed-line
 * distribution is identical for all six cards — enumerated per card rather
 * than assumed from symmetry, so `card:1` through `card:6` are all the same
 * bet and none of them is a better one.  Exhaustive enumeration of all
 * C(25,15) = 3,268,760 fifteen-ball draws gives, for each card:
 *   0 lines 1,456,572 -> 0.44560384   1 line  1,430,612 -> 0.43766199
 *   2 lines   358,504 -> 0.10967584   3 lines    22,836 -> 0.00698614
 *   4 lines       236 -> 0.00007220   (5+ lines are impossible at fifteen balls)
 *
 * Declared TOTAL_RETURN multipliers by completed lines (house values — no
 * client source prices Bingo lines).  The ladder keeps its original 1 : 2 : 30
 * : 1200 shape, so hit frequency and volatility are unchanged; every rung is
 * that shape scaled by the single constant
 *   k = 0.90 / 0.95323609 = 0.944152251
 * which lands the game on the operator's 90% return target:
 *   1 line x0.944152   2 lines x1.888305
 *   3 lines x28.324568 4+ lines x1132.982702
 * Expected return
 *   = 0.43766199*0.944152 + 0.10967584*1.888305
 *   + 0.00698614*28.324568 + 0.00007220*1132.982702
 *   = 0.41321944 + 0.20710144 + 0.19787927 + 0.08179980
 *   = 0.89999995  ->  90.00% return, 10.00% house edge.
 *
 * The residual 5e-8 is only the six-decimal-place rounding of the rungs.
 * Realized return sits a shade lower again because `settleBingo` floors every
 * payout to a whole point, so the house never over-pays a fraction.
 */
export const BINGO_DRAW_BALL_COUNT = 15;

export const BINGO_LINE_MULTIPLIERS: readonly number[] = Object.freeze([
  0,
  0.944152,
  1.888305,
  28.324568,
  1132.982702,
]);

export function generateBingoOutcome(entropy: ServerEntropy): BingoOutcome {
  const pool = Array.from({ length: 25 }, (_value, index) => index + 1);
  const drawn: BingoBall[] = [];
  for (let ball = 0; ball < BINGO_DRAW_BALL_COUNT; ball++) {
    const index = entropyIndex(entropy, pool.length, "bingo ball");
    drawn.push(pool.splice(index, 1)[0]);
  }
  // Round-tripped through the module's own validator so a generated draw can
  // never be looser than a draw arriving off the wire.
  return validateBingoOutcome({ kind: "bingo_draw", drawn });
}

export function settleBingo(
  selection: BingoSelection,
  stakePoints: number,
  outcome: BingoOutcome,
): SettlementResult {
  const stake = virtualPointStake(stakePoints);
  const lines = countBingoLines(selection.card_index, outcome.drawn);
  // A fifteen-ball round cannot exceed four lines; the clamp only guards a
  // replayed legacy draw that carries more balls than the declared ruleset.
  const rung = Math.min(lines, BINGO_LINE_MULTIPLIERS.length - 1);
  const payout = Math.floor(stake * BINGO_LINE_MULTIPLIERS[rung]);
  return Object.freeze({
    stake_points: stake,
    payout_points: payout,
    net_points: payout - stake,
  });
}

export const BINGO_RESOLVER: ReviewResolverModule<BingoSelection, BingoOutcome, BingoInspection> = Object.freeze({
  manifest: Object.freeze({
    catalog_slug: "bingo",
    module_id: "bingo-review-v1",
    live_resolver_id: "bingo-v1",
    ruleset_version: 1,
    readiness: "READY",
    virtual_points_only: true,
    action_policy: Object.freeze({
      observed: Object.freeze(["place_bet", "clear_bets", "collect_full", "gamble"]),
      executable: Object.freeze(["place_bet", "clear_bets", "collect_full"]),
    }),
    timing: Object.freeze({
      status: "VERIFIED",
      mode: "CLOCKED_SHARED",
      bet_seconds: 30,
      lock_seconds: 5,
      reveal_seconds: 5,
      result_seconds: 5,
      note:
        "MyDGP declared ruleset v1 shared-clock schedule: 30s betting, 5s lock, 5s reveal, 5s result. These are MyDGP's own declared phase lengths for this deployment, not recovered original-client timings.",
    }),
    settlement: Object.freeze({
      status: "VERIFIED",
      unit: "VIRTUAL_POINTS",
      payout_semantics: "TOTAL_RETURN",
      note:
        "MyDGP declared ruleset v1. payout_points is the full virtual-point amount credited back, stake included, floored to a whole point. Fifteen balls are drawn and completed lines pay x0.944152/x1.888305/x28.324568/x1132.982702 for 1/2/3/4 lines, an expected return of 0.90000 (10.00% house edge). That ladder is the original 1:2:30:1200 house shape scaled by 0.944152251 to the operator's 90% return target; these are MyDGP house values, not the original cabinet's line prices.",
    }),
    blockers: Object.freeze([]),
    evidence: Object.freeze([
      "chakri-unity/docs/prep/bingo-observation.md",
      "chakri-unity/Assets/Scripts/Engines/Tables.cs#Bingo",
      "FunGame-Admin/docs/LIVE_GAME_PARITY_READINESS_AUDIT.md",
    ]),
  }),
  normalizeSelection: normalizeBingoSelection,
  validateOutcome: validateBingoOutcome,
  inspectOutcome: inspectBingoOutcome,
  generateOutcome: generateBingoOutcome,
  settle: settleBingo,
  deterministicVectors: Object.freeze([
    Object.freeze({
      name: "card-one-first-row-membership",
      input: Object.freeze({ selection: "card:1", drawn: Object.freeze([5, 1, 9, 25, 3]) }),
      expected: Object.freeze({ completed_lines: 1, payout_points: null }),
    }),
    Object.freeze({
      name: "g-ball-is-preserved-not-priced",
      input: Object.freeze({ selection: "card:1", drawn: Object.freeze([12, 19, 18, "G", 4]) }),
      expected: Object.freeze({ contains_unresolved_g_ball: true, payout_points: null }),
    }),
  ]),
});
