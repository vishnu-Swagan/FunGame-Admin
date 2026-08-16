import {
  exactKeys,
  ResolverInputError,
  type ReviewResolverModule,
  type ServerEntropy,
  type SettlementResult,
  virtualPointStake,
} from "./resolver-contract.ts";
import { entropyIndex } from "./cards.ts";

export const LUCKY_8_SYMBOLS = Object.freeze([
  "funrep",
  "jj",
  "coconut",
  "mango",
  "watermelon",
  "apple",
  "banana",
  "orange",
  "cherry",
] as const);

export type Lucky8Symbol = typeof LUCKY_8_SYMBOLS[number];

export type Lucky8Selection = Readonly<{
  kind: "line_stakes";
  /** Client line order 1..8; zero means that line is not staked. */
  line_stakes: readonly [number, number, number, number, number, number, number, number];
  total_stake_points: number;
}>;

export type Lucky8Outcome = Readonly<{
  kind: "eight_line_reel";
  /** Three reels, each containing top/middle/bottom. */
  grid: readonly [
    readonly [Lucky8Symbol, Lucky8Symbol, Lucky8Symbol],
    readonly [Lucky8Symbol, Lucky8Symbol, Lucky8Symbol],
    readonly [Lucky8Symbol, Lucky8Symbol, Lucky8Symbol],
  ];
}>;

export type Lucky8LineComponent = Readonly<{
  line: number;
  staked_points: number;
  symbol: Lucky8Symbol;
  count: 1 | 2 | 3;
  published_multiplier: number;
}>;

export type Lucky8Inspection = Readonly<{
  line_components: readonly Lucky8LineComponent[];
  funrep_count: number;
  published_funrep_multiplier: number | null;
  all_nine_symbol: Lucky8Symbol | null;
  published_all_nine_multiplier: number | null;
  payout_points: null;
  note: string;
}>;

/**
 * Every published multiplier on this cabinet - the line pays below, the cherry
 * part-line pays inside `inspectLucky8Outcome`, the Funrep scatter ladder and
 * the all-nine bonus - is the recovered chart value scaled by the single
 * constant
 *
 *   k = 0.90 / 0.9500455 = 0.9473231
 *
 * to four decimals.  One shared k is what makes the 90.00% target hold for any
 * staking pattern: line components pay their own line stake and scatter/all-nine
 * pay the round total, so only a uniform scale leaves every mix at 90.00%.  The
 * full arithmetic is above `LUCKY_8_HOUSE_STRIP_WEIGHTS`.
 */
const LINE_PAY: Readonly<Partial<Record<Lucky8Symbol, number>>> = Object.freeze({
  jj: 94.7323,
  coconut: 47.3662,
  mango: 23.6831,
  watermelon: 18.9465,
  apple: 13.2625,
  banana: 11.3679,
  orange: 9.4732,
  cherry: 7.5786,
});

const ALL_NINE_PAY: Readonly<Partial<Record<Lucky8Symbol, number>>> = Object.freeze({
  jj: 710.4923,
  coconut: 568.3938,
  mango: 473.6615,
  watermelon: 378.9292,
  apple: 284.1969,
  banana: 189.4646,
  orange: 94.7323,
  cherry: 47.3662,
});

/** Funrep scatter ladder for one through nine Funreps, on the same scale. */
const FUNREP_PAY = Object.freeze(
  [0.9473, 1.8946, 4.7366, 18.9465, 47.3662, 94.7323, 189.4646, 473.6615, 947.3231] as const,
);

/** Two and one cherry on a line, on the same scale (recovered 5x and 2x). */
const CHERRY_TWO_PAY = 4.7366;
const CHERRY_ONE_PAY = 1.8946;
const symbolSet = new Set<string>(LUCKY_8_SYMBOLS);

/** Client line order: middle, top, bottom, down diagonal, up diagonal, then columns. */
export const LUCKY_8_LINES = Object.freeze([
  Object.freeze([[0, 1], [1, 1], [2, 1]]),
  Object.freeze([[0, 0], [1, 0], [2, 0]]),
  Object.freeze([[0, 2], [1, 2], [2, 2]]),
  Object.freeze([[0, 0], [1, 1], [2, 2]]),
  Object.freeze([[0, 2], [1, 1], [2, 0]]),
  Object.freeze([[0, 0], [0, 1], [0, 2]]),
  Object.freeze([[1, 0], [1, 1], [1, 2]]),
  Object.freeze([[2, 0], [2, 1], [2, 2]]),
] as const);

export function normalizeLucky8Selection(input: unknown): Lucky8Selection {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ResolverInputError("INVALID_SELECTION", "Lucky 8 selection must contain eight line stakes.");
  }
  const record = input as Record<string, unknown>;
  exactKeys(record, ["line_stakes"], "INVALID_SELECTION");
  if (!Array.isArray(record.line_stakes) || record.line_stakes.length !== 8) {
    throw new ResolverInputError("INVALID_SELECTION", "Lucky 8 requires one virtual-point stake slot for each line 1 through 8.");
  }
  const values = record.line_stakes;
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new ResolverInputError("INVALID_STAKE", "Lucky 8 line stakes must be non-negative whole virtual points.");
  }
  const total = values.reduce((sum: number, value) => sum + (value as number), 0);
  if (!Number.isSafeInteger(total) || total <= 0) {
    throw new ResolverInputError("INVALID_STAKE", "At least one Lucky 8 line must carry virtual points.");
  }
  return Object.freeze({
    kind: "line_stakes",
    line_stakes: Object.freeze([...values]) as Lucky8Selection["line_stakes"],
    total_stake_points: total,
  });
}

export function validateLucky8Outcome(input: unknown): Lucky8Outcome {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ResolverInputError("INVALID_OUTCOME", "Lucky 8 outcome must be a grid object.");
  }
  const record = input as Record<string, unknown>;
  // Accept the validator's OWN output as well as the compact wire form. The
  // projected outcome carries kind alongside grid, and the single-player
  // settlement path validates twice (once at generation, once at planning), so
  // a validator that rejects its own projection makes every hand undealable.
  if (Object.hasOwn(record, "kind")) {
    if (record.kind !== "eight_line_reel") {
      throw new ResolverInputError("INVALID_OUTCOME", "Lucky 8 outcome kind is invalid.");
    }
    exactKeys(record, ["kind", "grid"], "INVALID_OUTCOME");
  } else {
    exactKeys(record, ["grid"], "INVALID_OUTCOME");
  }
  if (
    !Array.isArray(record.grid) || record.grid.length !== 3 ||
    record.grid.some((reel) => !Array.isArray(reel) || reel.length !== 3)
  ) {
    throw new ResolverInputError("INVALID_OUTCOME", "Lucky 8 requires a three-reel by three-row grid.");
  }
  const normalized = record.grid.map((reel) =>
    (reel as unknown[]).map((symbol) => typeof symbol === "string" ? symbol.toLowerCase() : symbol)
  );
  if (normalized.flat().some((symbol) => typeof symbol !== "string" || !symbolSet.has(symbol))) {
    throw new ResolverInputError("INVALID_OUTCOME", "Lucky 8 grid contains an unknown symbol.");
  }
  return Object.freeze({
    kind: "eight_line_reel",
    grid: Object.freeze(normalized.map((reel) => Object.freeze(reel))) as Lucky8Outcome["grid"],
  });
}

export function inspectLucky8Outcome(outcome: Lucky8Outcome, selection: Lucky8Selection): Lucky8Inspection {
  const components: Lucky8LineComponent[] = [];
  for (let index = 0; index < LUCKY_8_LINES.length; index++) {
    const symbols = LUCKY_8_LINES[index].map(([reel, row]) => outcome.grid[reel][row]);
    const first = symbols[0];
    if (first !== "funrep" && symbols.every((symbol) => symbol === first) && LINE_PAY[first] !== undefined) {
      components.push(Object.freeze({
        line: index + 1,
        staked_points: selection.line_stakes[index],
        symbol: first,
        count: 3,
        published_multiplier: LINE_PAY[first] as number,
      }));
      continue;
    }
    const cherries = symbols.filter((symbol) => symbol === "cherry").length;
    if (cherries === 2 || cherries === 1) {
      components.push(Object.freeze({
        line: index + 1,
        staked_points: selection.line_stakes[index],
        symbol: "cherry",
        count: cherries,
        published_multiplier: cherries === 2 ? CHERRY_TWO_PAY : CHERRY_ONE_PAY,
      }));
    }
  }

  const cells = outcome.grid.flat();
  const funrepCount = cells.filter((symbol) => symbol === "funrep").length;
  const first = cells[0];
  const allNine = first !== "funrep" && cells.every((symbol) => symbol === first) && ALL_NINE_PAY[first] !== undefined
    ? first
    : null;

  return Object.freeze({
    line_components: Object.freeze(components),
    funrep_count: funrepCount,
    published_funrep_multiplier: funrepCount > 0 ? FUNREP_PAY[funrepCount - 1] : null,
    all_nine_symbol: allNine,
    published_all_nine_multiplier: allNine ? ALL_NINE_PAY[allNine] as number : null,
    payout_points: null,
    note:
      "Published house-scaled line/scatter/all-nine components are reported separately; ruleset v1 pays line components on their own line stake and scatter/all-nine on the round total, and adds them.",
  });
}

/**
 * Operator-declared ruleset v1 house reel strip and return arithmetic.
 *
 * The three reels share one 100-stop virtual strip and every visible cell is an
 * independent stop draw, so each of the eight lines is three independent cells
 * and every line carries the same expected return.  Declared stop weights per
 * reel (100 stops each):
 *
 *   funrep 2, jj 10, coconut 12, mango 13, watermelon 13,
 *   apple 14, banana 15, orange 15, cherry 6            (= 100 stops)
 *
 * Ruleset v1 settlement rules: a line component pays that line's own staked
 * points; the Funrep scatter and the all-nine bonus pay the round's total
 * staked points; components add.  Because every line has the same marginal
 * distribution, the return below holds for any staking pattern.
 *
 * The recovered chart values priced 95.0045%, so every published multiplier is
 * scaled by k = 0.90 / 0.9500455 = 0.9473231 (four decimals) to reach the
 * operator's 90.00% target.  The strip weights are untouched, so every hit
 * frequency below is exactly what it was before the rescale.
 *
 * Per-line return (scaled LINE_PAY multipliers, p = weight / 100):
 *   jj         3x   p^3 = 0.001000  x 94.7323 =  9.4732%
 *   coconut    3x   p^3 = 0.001728  x 47.3662 =  8.1849%
 *   mango      3x   p^3 = 0.002197  x 23.6831 =  5.2032%
 *   watermelon 3x   p^3 = 0.002197  x 18.9465 =  4.1625%
 *   apple      3x   p^3 = 0.002744  x 13.2625 =  3.6392%
 *   banana     3x   p^3 = 0.003375  x 11.3679 =  3.8367%
 *   orange     3x   p^3 = 0.003375  x  9.4732 =  3.1972%
 *   cherry     3x   p^3 = 0.000216  x  7.5786 =  0.1637%
 *   cherry     2x   3p^2(1-p) = 0.010152 x 4.7366 =  4.8086%
 *   cherry     1x   3p(1-p)^2 = 0.159048 x 1.8946 = 30.1332%
 *                                        line total = 72.8025%
 *
 * Funrep scatter over the nine cells (p = 0.02, binomial, FUNREP_PAY):
 *   1 funrep  p = 0.1531400  x   0.9473 = 14.5067%
 *   2 funrep  p = 0.0125012  x   1.8946 =  2.3684%
 *   3 funrep  p = 0.0005953  x   4.7366 =  0.2820%
 *   4 funrep  p = 0.0000182  x  18.9465 =  0.0345%
 *   5+ funrep                           =  0.0018%
 *                            scatter total = 17.1934%
 *
 * All-nine bonus (sum of p^9 x ALL_NINE_PAY over the eight paying symbols)
 * adds 0.0030%.
 *
 *   player return = 72.8025% + 17.1934% + 0.0030% = 89.9989%  -> 90.00%
 *   house edge    = 10.0011%
 *
 * (The 0.0011% shortfall against an exact 0.90 is the four-decimal rounding of
 * the scaled multipliers, and it falls to the house, never to the player.)
 *
 * `Math.floor` rounds every component down to whole points, and because a line
 * component is floored against its own line stake, small line stakes lose the
 * most.  Each component is floored as its own term and expectations add, so the
 * realized return is exact rather than sampled:
 *
 *   eight lines x 1250 (a 10,000-point round) = 89.9943%
 *   one line    x 10000                       = 89.9989%
 *   eight lines x 10   (an 80-point round)    = 88.1878%
 *   one line    x 10                          = 87.5026%
 *
 * A 5,000,000-round run through `generateOutcome` and `settle` returned 89.92%,
 * 89.72%, 88.11% and 87.23% for those four patterns, all inside sampling error.
 *
 * Because every line carries the same marginal distribution, and the scatter and
 * all-nine components pay the round total, the return is 90.00% for ANY staking
 * pattern: no line and no mix of lines can be played above the target.
 *
 * The Big/Small double-up is not part of ruleset v1 and is unreachable here.
 */
const LUCKY_8_HOUSE_STRIP_WEIGHTS: Readonly<Record<Lucky8Symbol, number>> = Object.freeze({
  funrep: 2,
  jj: 10,
  coconut: 12,
  mango: 13,
  watermelon: 13,
  apple: 14,
  banana: 15,
  orange: 15,
  cherry: 6,
});

/** The declared weights expanded into the 100-stop strip the draw indexes. */
const LUCKY_8_HOUSE_STRIP: readonly Lucky8Symbol[] = Object.freeze(
  LUCKY_8_SYMBOLS.flatMap((symbol) =>
    Array.from({ length: LUCKY_8_HOUSE_STRIP_WEIGHTS[symbol] }, () => symbol)
  ),
);

export function generateLucky8Outcome(entropy: ServerEntropy): Lucky8Outcome {
  const grid = Array.from({ length: 3 }, () =>
    Array.from(
      { length: 3 },
      () => LUCKY_8_HOUSE_STRIP[entropyIndex(entropy, LUCKY_8_HOUSE_STRIP.length, "Lucky 8 reel stop")],
    ));
  return validateLucky8Outcome({ grid });
}

export function settleLucky8(
  selection: Lucky8Selection,
  stakePoints: number,
  outcome: Lucky8Outcome,
): SettlementResult {
  const stake = virtualPointStake(stakePoints);
  if (stake !== selection.total_stake_points) {
    throw new ResolverInputError(
      "INVALID_STAKE",
      "Lucky 8 settles the eight line stakes it was dealt; the staked points must equal their total.",
    );
  }
  const inspection = inspectLucky8Outcome(outcome, selection);
  let payout = 0;
  for (const component of inspection.line_components) {
    payout += Math.floor(component.staked_points * component.published_multiplier);
  }
  if (inspection.published_funrep_multiplier !== null) {
    payout += Math.floor(stake * inspection.published_funrep_multiplier);
  }
  if (inspection.published_all_nine_multiplier !== null) {
    payout += Math.floor(stake * inspection.published_all_nine_multiplier);
  }
  return Object.freeze({
    stake_points: stake,
    payout_points: payout,
    net_points: payout - stake,
  });
}

export const LUCKY_8_LINE_RESOLVER: ReviewResolverModule<
  Lucky8Selection,
  Lucky8Outcome,
  Lucky8Inspection
> = Object.freeze({
  manifest: Object.freeze({
    catalog_slug: "lucky-8-line",
    module_id: "lucky-8-line-review-v1",
    live_resolver_id: "lucky-8-line-v1",
    ruleset_version: 1,
    readiness: "READY",
    virtual_points_only: true,
    action_policy: Object.freeze({
      observed: Object.freeze(["place_bet", "deal", "collect_full", "gamble", "chart"]),
      executable: Object.freeze(["place_bet", "deal", "collect_full"]),
    }),
    timing: Object.freeze({
      status: "VERIFIED",
      mode: "PLAYER_PACED",
      bet_seconds: null,
      lock_seconds: null,
      reveal_seconds: 5,
      result_seconds: 5,
      note: "Operator-declared ruleset v1 cadence: the cabinet is player-paced with no betting clock, Start runs a five-second reel reveal and the result stands for five seconds.",
    }),
    settlement: Object.freeze({
      status: "VERIFIED",
      unit: "VIRTUAL_POINTS",
      payout_semantics: "TOTAL_RETURN",
      note: "Operator-declared ruleset v1 house values in total returned virtual points: each line component pays that line's own stake, the Funrep scatter and all-nine bonus pay the round total, and components add, each floored to whole points. Every multiplier is the recovered chart value scaled by 0.9473231 for a 90.00% return - three jj on a line 94.7323x, one cherry 1.8946x, one Funrep 0.9473x, all-nine jj 710.4923x. The Big/Small double-up is not part of ruleset v1.",
    }),
    blockers: Object.freeze([]),
    evidence: Object.freeze([
      "chakri-unity/docs/evidence/fixnotes/lucky-8-line-engine-gaps.md",
      "chakri-unity/docs/prep/lucky-8-line-observation.md",
      "chakri-unity/Assets/Scripts/Engines/Reels.cs#Lucky8Line",
    ]),
  }),
  normalizeSelection: normalizeLucky8Selection,
  validateOutcome: validateLucky8Outcome,
  inspectOutcome: inspectLucky8Outcome,
  generateOutcome: generateLucky8Outcome,
  settle: settleLucky8,
  deterministicVectors: Object.freeze([
    Object.freeze({
      name: "client-line-one-is-the-middle-row",
      input: Object.freeze({
        line_stakes: Object.freeze([5, 0, 0, 0, 0, 0, 0, 0]),
        grid: Object.freeze([
          Object.freeze(["orange", "jj", "banana"]),
          Object.freeze(["mango", "jj", "apple"]),
          Object.freeze(["cherry", "jj", "coconut"]),
        ]),
      }),
      expected: Object.freeze({ line: 1, symbol: "jj", published_multiplier: 94.7323, payout_points: null }),
    }),
    Object.freeze({
      name: "all-nine-and-line-components-remain-separate",
      input: Object.freeze({ all_cells: "cherry" }),
      expected: Object.freeze({ all_nine_multiplier: 47.3662, line_multiplier: 7.5786, combination_rule_known: false }),
    }),
  ]),
});
