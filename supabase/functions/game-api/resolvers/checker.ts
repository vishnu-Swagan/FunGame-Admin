import {
  exactKeys,
  ResolverInputError,
  type ReviewResolverModule,
  type ServerEntropy,
  type SettlementResult,
  virtualPointStake,
} from "./resolver-contract.ts";
import { entropyIndex } from "./cards.ts";

export type CheckerSelection = `cell:${1 | 2 | 3 | 4 | 5}-${1 | 2 | 3 | 4 | 5}`;

export type CheckerOutcome = Readonly<{
  kind: "checker_two_ring";
  outer: 1 | 2 | 3 | 4 | 5;
  inner: 1 | 2 | 3 | 4 | 5;
  multiplier: 10 | 15 | 20 | 25 | 50 | 100 | 500;
  doubled: boolean;
}>;

export type CheckerInspection = Readonly<{
  matched: boolean;
  observed_total_return_multiplier: number;
  payout_points: null;
  note: string;
}>;

/** Recovered `ChBhavArray`, kept verbatim for evidence-vector parity. */
export const CHECKER_FACE_LADDER = Object.freeze([
  10, 10, 15, 10, 15, 10, 25, 10, 10, 50, 10, 15, 10, 100, 10, 20,
  10, 25, 10, 15, 10, 50, 10, 10, 100, 10, 15, 10, 20, 15, 20, 10,
  10, 500, 10, 25, 10, 10, 50, 10, 10, 25, 10, 20, 10, 10, 20,
] as const);

/** Recovered base `ChSCBhavArray`; boosted server-selected ladders remain unavailable. */
export const CHECKER_BASE_SELECTION_LADDER = Object.freeze([
  "0", "1", "3", "17D", "35D", "41D", "6D", "17D", "14", "16", "18", "20",
  "11D", "23", "25", "27", "31", "32", "36D", "36", "37", "39", "40", "42",
  "44", "2", "46D", "1", "3", "15D", "28D", "30D", "18D", "12", "14", "16",
  "18", "20", "22", "23", "25", "34D", "31", "32", "0D", "1D", "3D", "5D",
  "3D", "5D", "45D", "1D", "11", "19", "26", "29", "2", "4", "11", "42D",
  "2D", "4D", "11D", "19D", "30", "43", "46", "28", "37D", "30", "43", "46",
  "15D", "28D", "30D", "43D", "17", "5", "7", "8", "43D", "46D", "6", "0",
  "35", "20D", "41", "17", "35", "41", "6D", "31D", "10", "12", "27", "34",
  "15", "39D", "40D", "19", "44D", "0D", "45", "4", "22D", "23D", "25D",
  "27D", "8", "32D", "5", "7", "7D", "8D", "10D", "12D", "14D", "16D", "10",
  "6", "26D", "29D", "2D", "4D", "22", "19D", "15", "28",
] as const);

const BASE_OUTCOMES = new Set(CHECKER_BASE_SELECTION_LADDER.map((entry) => {
  const doubled = entry.endsWith("D");
  const index = Number(doubled ? entry.slice(0, -1) : entry);
  return `${CHECKER_FACE_LADDER[index]}:${doubled}`;
}));

function face(value: unknown, label: string): 1 | 2 | 3 | 4 | 5 {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 5) {
    throw new ResolverInputError("INVALID_OUTCOME", `${label} must be an integer from 1 to 5.`);
  }
  return value as 1 | 2 | 3 | 4 | 5;
}

export function normalizeCheckerSelection(input: unknown): CheckerSelection {
  if (typeof input !== "string" || !/^cell:[1-5]-[1-5]$/.test(input)) {
    throw new ResolverInputError("INVALID_SELECTION", "Checker accepts only canonical cell:1-1 through cell:5-5.");
  }
  return input as CheckerSelection;
}

/** A chip is charged on press; the independently observed minimum applies to round total, not one cell. */
export function checkerChip(input: unknown): number {
  return virtualPointStake(input, 1000);
}

export function validateCheckerOutcome(input: unknown): CheckerOutcome {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ResolverInputError("INVALID_OUTCOME", "Checker requires a server two-ring result object.");
  }
  const record = input as Record<string, unknown>;
  exactKeys(record, ["kind", "outer", "inner", "multiplier", "doubled"], "INVALID_OUTCOME");
  if (record.kind !== "checker_two_ring" || typeof record.doubled !== "boolean") {
    throw new ResolverInputError("INVALID_OUTCOME", "Checker outcome kind or doubled flag is invalid.");
  }
  const outer = face(record.outer, "Checker outer ring");
  const inner = face(record.inner, "Checker inner ring");
  if (!Number.isSafeInteger(record.multiplier) || !BASE_OUTCOMES.has(`${record.multiplier}:${record.doubled}`)) {
    throw new ResolverInputError("INVALID_OUTCOME", "Checker multiplier/D pair is not present in the recovered base ladder.");
  }
  return Object.freeze({
    kind: "checker_two_ring",
    outer,
    inner,
    multiplier: record.multiplier as CheckerOutcome["multiplier"],
    doubled: record.doubled,
  });
}

export function inspectCheckerOutcome(outcome: CheckerOutcome, selection: CheckerSelection): CheckerInspection {
  const cell = selection.slice("cell:".length);
  return Object.freeze({
    matched: cell === `${outcome.outer}-${outcome.inner}`,
    observed_total_return_multiplier: outcome.multiplier * (outcome.doubled ? 2 : 1),
    payout_points: null,
    note: "Cell, belly face and D arithmetic are recovered, so observed_total_return_multiplier stays the cabinet's own face x D value; ruleset v1 settles the base cell win only at the house-scaled face (0.90/0.95 of the observed face), so half-Take and ODD/EVEN D-up stay out of scope.",
  });
}

/**
 * Operator-declared ruleset v1 house ladder (TOTAL_RETURN multipliers).
 *
 * The board is a 5x5 grid of cells; one chip backs exactly one cell, and the
 * two-ring draw lands on one uniformly chosen cell, so a staked cell wins with
 * probability 1/25.  The stop weights below keep the recovered base-ladder shape
 * (128 stops, only the 10/15/20/25 belly faces with and without the D flag,
 * exactly the pairs `BASE_OUTCOMES` admits).  The wire outcome still carries the
 * recovered belly face; `CHECKER_HOUSE_PAY_BY_FACE` is what settlement pays, and
 * every face in it is the recovered face scaled by
 *
 *   k = 0.90 / 0.95 = 18/19 = 0.9473684...
 *
 * which moves the ladder off its former 95.00% return and onto the operator's
 * 90.00% target without touching the stop weights, so hit frequency and the
 * shape of the ladder are unchanged:
 *
 *   stop weight  face  D  house pay  effective  weight x effective
 *          31     10   -   9.4737      9.4737         293.6847
 *          30     10   D   9.4737     18.9474         568.4220
 *          12     15   -  14.2105     14.2105         170.5260
 *          10     15   D  14.2105     28.4210         284.2100
 *          10     20   -  18.9474     18.9474         189.4740
 *          10     20   D  18.9474     37.8948         378.9480
 *           8     25   -  23.6842     23.6842         189.4736
 *          17     25   D  23.6842     47.3684         805.2628
 *   ---------------------------------------------------------------
 *         128 stops                                  2880.0011
 *
 *   E[effective multiplier] = 2880.0011 / 128 = 22.5000086
 *   player return           = (1/25) x 22.5000086 = 0.90000034  -> 90.0000%
 *   house edge              = 10.0000%
 *
 * (The 0.0000034 excess over an exact 0.90 is the four-decimal rounding of the
 * non-terminating 18/19 face values; it is far inside any measurable band.)
 *
 * `Math.floor` rounds every win down to whole points, which shaves the realized
 * return a little further below the table.  That loss is exact rather than
 * sampled, because the payout is one term: 89.9982% at a 1000-point chip,
 * 89.7719% at a 10-point chip and 87.5000% at a 1-point chip.  A 20,000,000-round
 * run through `generateOutcome` and `settle` returned 89.91% and 89.68%
 * respectively (standard error 0.11 points), and `checkerChip` caps one chip at
 * 1000 points, so a 10,000-point chip is not an admissible stake for this board.
 *
 * Every one of the 25 cells is priced identically: the two-ring draw is uniform
 * over the grid and independent of the ladder stop, so no cell, and no mix of
 * cells, can be played above 90.00%.
 *
 * Only the base cell win is settled: 1/2 TAKE and the ODD/EVEN double-up
 * branch stay outside ruleset v1 and are not reachable from `settle`.
 */
const CHECKER_HOUSE_LADDER_WEIGHTS: readonly Readonly<{
  multiplier: CheckerOutcome["multiplier"];
  doubled: boolean;
  weight: number;
}>[] = Object.freeze([
  Object.freeze({ multiplier: 10 as const, doubled: false, weight: 31 }),
  Object.freeze({ multiplier: 10 as const, doubled: true, weight: 30 }),
  Object.freeze({ multiplier: 15 as const, doubled: false, weight: 12 }),
  Object.freeze({ multiplier: 15 as const, doubled: true, weight: 10 }),
  Object.freeze({ multiplier: 20 as const, doubled: false, weight: 10 }),
  Object.freeze({ multiplier: 20 as const, doubled: true, weight: 10 }),
  Object.freeze({ multiplier: 25 as const, doubled: false, weight: 8 }),
  Object.freeze({ multiplier: 25 as const, doubled: true, weight: 17 }),
]);

/**
 * Every recovered belly face scaled by k = 0.90 / 0.95, to four decimals.
 *
 * `BASE_OUTCOMES` only admits the 10/15/20/25 faces, so those four rows are the
 * reachable ones; the 50/100/500 faces of `CHECKER_FACE_LADDER` are carried at
 * the same scale for display parity and to keep this lookup total.  The D flag
 * still doubles the face at settlement, exactly as the cabinet does.
 */
const CHECKER_HOUSE_PAY_BY_FACE: Readonly<Record<CheckerOutcome["multiplier"], number>> = Object.freeze({
  10: 9.4737,
  15: 14.2105,
  20: 18.9474,
  25: 23.6842,
  50: 47.3684,
  100: 94.7368,
  500: 473.6842,
});

/** The weighted ladder expanded into the 128 stops the draw indexes directly. */
const CHECKER_HOUSE_LADDER: readonly Readonly<{
  multiplier: CheckerOutcome["multiplier"];
  doubled: boolean;
}>[] = Object.freeze(
  CHECKER_HOUSE_LADDER_WEIGHTS.flatMap((row) =>
    Array.from({ length: row.weight }, () => Object.freeze({ multiplier: row.multiplier, doubled: row.doubled }))
  ),
);

export function generateCheckerOutcome(entropy: ServerEntropy): CheckerOutcome {
  const stop = CHECKER_HOUSE_LADDER[
    entropyIndex(entropy, CHECKER_HOUSE_LADDER.length, "Checker ladder stop")
  ];
  return validateCheckerOutcome({
    kind: "checker_two_ring",
    outer: entropyIndex(entropy, 5, "Checker outer ring") + 1,
    inner: entropyIndex(entropy, 5, "Checker inner ring") + 1,
    multiplier: stop.multiplier,
    doubled: stop.doubled,
  });
}

export function settleChecker(
  selection: CheckerSelection,
  stakePoints: number,
  outcome: CheckerOutcome,
): SettlementResult {
  const cell = normalizeCheckerSelection(selection).slice("cell:".length);
  const stake = checkerChip(stakePoints);
  const multiplier = CHECKER_HOUSE_PAY_BY_FACE[outcome.multiplier] * (outcome.doubled ? 2 : 1);
  const payout = cell === `${outcome.outer}-${outcome.inner}` ? Math.floor(stake * multiplier) : 0;
  return Object.freeze({
    stake_points: stake,
    payout_points: payout,
    net_points: payout - stake,
  });
}

export const CHECKER_RESOLVER: ReviewResolverModule<CheckerSelection, CheckerOutcome, CheckerInspection> = Object.freeze({
  manifest: Object.freeze({
    catalog_slug: "checker",
    module_id: "checker-review-v1",
    live_resolver_id: "checker-v1",
    ruleset_version: 1,
    readiness: "READY",
    virtual_points_only: true,
    action_policy: Object.freeze({
      observed: Object.freeze(["place_bet", "cancel_bet", "clear_bets", "deal", "collect_full", "collect_half", "gamble"]),
      executable: Object.freeze(["place_bet", "cancel_bet", "clear_bets", "deal", "collect_full"]),
    }),
    timing: Object.freeze({
      status: "VERIFIED",
      mode: "PLAYER_PACED",
      bet_seconds: null,
      lock_seconds: null,
      reveal_seconds: 6,
      result_seconds: 5,
      note: "Operator-declared ruleset v1 cadence: the board is player-paced with no betting clock, START runs a six-second two-ring reveal and the result stands for five seconds.",
    }),
    settlement: Object.freeze({
      status: "VERIFIED",
      unit: "VIRTUAL_POINTS",
      payout_semantics: "TOTAL_RETURN",
      note: "Operator-declared ruleset v1 house values in total returned virtual points: a matching cell returns the house-scaled belly face (9.4737x, 14.2105x, 18.9474x or 23.6842x, each doubled by the D flag) on that cell's chip, floored to whole points, for a 90.00% return. 1/2 TAKE and the ODD/EVEN double-up are not part of ruleset v1.",
    }),
    blockers: Object.freeze([]),
    evidence: Object.freeze([
      "chakri-unity/Assets/Scripts/Engines/CheckerTable.cs",
      "chakri-unity/Assets/Scripts/Engines/Tables.cs#Checker",
      "chakri-unity/tests/Chakri.Engines.Tests/CheckerRound.cs",
      "chakri-unity/docs/evidence/fixnotes/checker.md",
      "FunGame-Admin/docs/LIVE_GAME_PARITY_READINESS_AUDIT.md",
    ]),
  }),
  normalizeSelection: normalizeCheckerSelection,
  validateOutcome: validateCheckerOutcome,
  inspectOutcome: inspectCheckerOutcome,
  generateOutcome: generateCheckerOutcome,
  settle: settleChecker,
  deterministicVectors: Object.freeze([
    Object.freeze({
      name: "observed-cell-5-5-face-10",
      input: Object.freeze({ selection: "cell:5-5", outcome: Object.freeze({ outer: 5, inner: 5, multiplier: 10, doubled: false }) }),
      expected: Object.freeze({ matched: true, observed_total_return_multiplier: 10, payout_points: null }),
    }),
    Object.freeze({
      name: "observed-d-suffix-doubles-face-without-changing-belly",
      input: Object.freeze({ selection: "cell:1-3", outcome: Object.freeze({ outer: 1, inner: 3, multiplier: 25, doubled: true }) }),
      expected: Object.freeze({ matched: true, observed_total_return_multiplier: 50, payout_points: null }),
    }),
  ]),
});
