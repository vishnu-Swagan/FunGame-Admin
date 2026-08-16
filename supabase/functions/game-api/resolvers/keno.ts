import {
  exactKeys,
  ResolverInputError,
  type ReviewResolverModule,
  type ServerEntropy,
  type SettlementResult,
  virtualPointStake,
} from "./resolver-contract.ts";
import { entropyIndex } from "./cards.ts";

export type KenoSelection = Readonly<{
  kind: "picks";
  picks: readonly number[];
  canonical: string;
}>;

export type KenoOutcome = Readonly<{
  kind: "keno_80_of_20";
  /** Server reveal order; deliberately not sorted. */
  drawn: readonly number[];
}>;

export type KenoInspection = Readonly<{
  hits: number;
  matched_numbers: readonly number[];
  payout_points: null;
  note: string;
}>;

function normalizeNumbers(input: unknown, code: "INVALID_SELECTION" | "INVALID_OUTCOME"): number[] {
  if (!Array.isArray(input)) {
    throw new ResolverInputError(code, "Expected an array of Keno numbers.");
  }
  if (
    input.some((value) => !Number.isInteger(value) || value < 1 || value > 80) ||
    new Set(input).size !== input.length
  ) {
    throw new ResolverInputError(code, "Keno numbers must be unique integers from 1 through 80.");
  }
  return [...input] as number[];
}

export function normalizeKenoSelection(input: unknown): KenoSelection {
  let values: unknown;
  if (typeof input === "string") {
    const match = /^(?:pick|picks):(\d+(?:,\d+)*)$/.exec(input);
    if (!match) {
      throw new ResolverInputError("INVALID_SELECTION", "Use picks:N,N with no empty or ignored fields.");
    }
    values = match[1].split(",").map(Number);
  } else {
    values = input;
  }
  const picks = normalizeNumbers(values, "INVALID_SELECTION");
  if (picks.length < 1 || picks.length > 10) {
    throw new ResolverInputError("INVALID_SELECTION", "A Keno ticket must contain 1 through 10 picks.");
  }
  picks.sort((left, right) => left - right);
  return Object.freeze({
    kind: "picks",
    picks: Object.freeze(picks),
    canonical: `picks:${picks.join(",")}`,
  });
}

export function kenoStake(input: unknown): number {
  // Source evidence conflicts between minimum 1 and 5 and does not prove the
  // maximum.  This checks only the ledger's virtual-point representation.
  return virtualPointStake(input);
}

/**
 * Review-envelope validator only. The 1..80/20-draw shape mirrors the current
 * reconstructed Unity table and is useful for inspection vectors; it does not
 * prove the authoritative client/server result payload or draw cardinality.
 */
export function validateKenoOutcome(input: unknown): KenoOutcome {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ResolverInputError("INVALID_OUTCOME", "Keno outcome must be a drawn-numbers object.");
  }
  const record = input as Record<string, unknown>;
  exactKeys(record, ["drawn"], "INVALID_OUTCOME");
  const drawn = normalizeNumbers(record.drawn, "INVALID_OUTCOME");
  if (drawn.length !== 20) {
    throw new ResolverInputError("INVALID_OUTCOME", "Keno requires exactly 20 drawn numbers.");
  }
  return Object.freeze({ kind: "keno_80_of_20", drawn: Object.freeze(drawn) });
}

export function inspectKenoOutcome(outcome: KenoOutcome, selection: KenoSelection): KenoInspection {
  const drawSet = new Set(outcome.drawn);
  const matched = selection.picks.filter((pick) => drawSet.has(pick));
  return Object.freeze({
    hits: matched.length,
    matched_numbers: Object.freeze(matched),
    payout_points: null,
    note: "Hit count is exact, but the client's pick-count/hit-count paytable and Take settlement are unobserved.",
  });
}

/**
 * MyDGP declared Keno paytable, ruleset v1.  Indexed `[picks][hits]`; every
 * value is a TOTAL_RETURN multiple of the ticket stake (a `1` returns the
 * stake, a `0` keeps it).  Fractional rungs are floored at settlement so the
 * house never over-pays a fraction.
 *
 * EVERY pick-count column returns exactly 0.900 of stake — the operator's
 * declared 10.0% house edge, applied uniformly so no ticket size is a better
 * or worse bet than any other, and so Keno sits level with the rest of the
 * catalogue instead of draining a balance several times faster.  Each column
 * keeps the exact shape it had before: one per-column constant k multiplies
 * every rung in it, which leaves that column's hit frequency and volatility
 * untouched and scales only its return.
 *
 * The ten-pick column's SHAPE is evidence-based: it is the ladder the shipped
 * client prints in its own help strings —
 *   "No match Bet x 4, Four match Bet x 1, Five match Bet x 2, Six match Bet x 10"
 *   "Seven match Bet x 50, Eight match Bet x 250, Nine match Bet x 500, Ten match Bet x 2000"
 *   (recovered/ReadableResources/UnityTextAssets/Languages.txt, strMsg038/strMsg039).
 * Unscaled that column returned only 0.66583, far the meanest of the ten, so
 * its k is much the largest.  The one-through-nine-pick columns are NOT
 * evidence — the shipped strings only ever describe the ten-number ticket —
 * and their shapes remain MyDGP house values.
 *
 * Hit probabilities are hypergeometric on the 20-of-80 draw:
 *   P(hits = h | picks = n) = C(n,h)*C(80-n,20-h)/C(80,20)
 * and depend only on how many numbers are picked, never on which, so one
 * column figure prices every ticket of that size.  Per-column arithmetic,
 * "P(h) x multiplier = contribution":
 *
 *   1 pick    k = 0.960000  (column returned 0.93750 before scaling)
 *      1 hit   0.25000000 x 3.6           = 0.90000000
 *                                           total 0.90000000
 *   2 picks   k = 0.977320  (was 0.92089)
 *      1 hit   0.37974684 x 0.97732       = 0.37113418
 *      2 hits  0.06012658 x 8.795876      = 0.52886596
 *                                           total 0.90000014
 *   3 picks   k = 0.953132  (was 0.94426)
 *      1 hit   0.43086660 x 0.953132      = 0.41067275
 *      2 hits  0.13875365 x 1.906265      = 0.26450123
 *      3 hits  0.01387537 x 16.203248     = 0.22482598
 *                                           total 0.89999996
 *   4 picks   k = 0.952233  (was 0.94515)
 *      2 hits  0.21263547 x 1.904466      = 0.40495702
 *      3 hits  0.04324789 x 5.713399      = 0.24709246
 *      4 hits  0.00306339 x 80.939822     = 0.24795043
 *                                           total 0.89999990
 *   5 picks   k = 0.952600  (was 0.94478)
 *      2 hits  0.27045739 x 0.9526        = 0.25763771
 *      3 hits  0.08393505 x 3.810399      = 0.31982604
 *      4 hits  0.01209234 x 19.051993     = 0.23038314
 *      5 hits  0.00064492 x 142.889945    = 0.09215325
 *                                           total 0.90000014
 *   6 picks   k = 0.949594  (was 0.94777)
 *      3 hits  0.12981955 x 1.899187      = 0.24655160
 *      4 hits  0.02853792 x 11.395125     = 0.32519314
 *      5 hits  0.00309564 x 66.471561     = 0.20577193
 *      6 hits  0.00012898 x 949.593724    = 0.12248329
 *                                           total 0.89999995
 *   7 picks   k = 0.940495  (was 0.95694)
 *      3 hits  0.17499324 x 0.940495      = 0.16458027
 *      4 hits  0.05219097 x 4.702476      = 0.24542677
 *      5 hits  0.00863850 x 23.512381     = 0.20311182
 *      6 hits  0.00073208 x 235.123809    = 0.17212866
 *      7 hits  0.00002440 x 4702.476178   = 0.11475244
 *                                           total 0.89999995
 *   8 picks   k = 0.948503  (was 0.94886)
 *      4 hits  0.08150370 x 1.897007      = 0.15461309
 *      5 hits  0.01830259 x 14.22755      = 0.26040095
 *      6 hits  0.00236671 x 113.820399    = 0.26938029
 *      7 hits  0.00016046 x 1138.203988   = 0.18263071
 *      8 hits  0.00000435 x 7588.026589   = 0.03297499
 *                                           total 0.90000003
 *   9 picks   k = 0.960582  (was 0.93693)
 *      4 hits  0.11410518 x 0.960582      = 0.10960738
 *      5 hits  0.03260148 x 5.763491      = 0.18789834
 *      6 hits  0.00571956 x 38.423272     = 0.21976413
 *      7 hits  0.00059168 x 432.261808    = 0.25575998
 *      8 hits  0.00003259 x 3362.036287   = 0.10957702
 *      9 hits  0.00000072 x 24014.544904  = 0.01739318
 *                                           total 0.90000003
 *  10 picks   k = 1.351701  (was 0.66583, the client-printed ladder)
 *      0 hits  0.04579070 x 5.406804      = 0.24758134
 *      4 hits  0.14731890 x 1.351701      = 0.19913110
 *      5 hits  0.05142769 x 2.703402      = 0.13902971
 *      6 hits  0.01147939 x 13.517009     = 0.15516708
 *      7 hits  0.00161114 x 67.585046     = 0.10888918
 *      8 hits  0.00013542 x 337.92523     = 0.04576162
 *      9 hits  0.00000612 x 675.85046     = 0.00413664
 *     10 hits  0.00000011 x 2703.401839   = 0.00030335
 *                                           total 0.90000003
 *
 * Every column lands within 1.5e-7 of 0.900 — none of them at or above 1.0,
 * so no ticket size is a player-positive bet; the residual is only the
 * six-decimal-place rounding of the rungs.  Realized return sits a shade lower
 * again because `settleKeno` floors each payout to a whole point.
 */
const KENO_PAYTABLE: readonly (readonly number[])[] = Object.freeze([
  Object.freeze([]), // no zero-pick ticket exists
  Object.freeze([0, 3.6]),
  Object.freeze([0, 0.97732, 8.795876]),
  Object.freeze([0, 0.953132, 1.906265, 16.203248]),
  Object.freeze([0, 0, 1.904466, 5.713399, 80.939822]),
  Object.freeze([0, 0, 0.9526, 3.810399, 19.051993, 142.889945]),
  Object.freeze([0, 0, 0, 1.899187, 11.395125, 66.471561, 949.593724]),
  Object.freeze([0, 0, 0, 0.940495, 4.702476, 23.512381, 235.123809, 4702.476178]),
  Object.freeze([0, 0, 0, 0, 1.897007, 14.22755, 113.820399, 1138.203988, 7588.026589]),
  Object.freeze([0, 0, 0, 0, 0.960582, 5.763491, 38.423272, 432.261808, 3362.036287, 24014.544904]),
  Object.freeze([
    5.406804,
    0,
    0,
    0,
    1.351701,
    2.703402,
    13.517009,
    67.585046,
    337.92523,
    675.85046,
    2703.401839,
  ]),
]);

export function generateKenoOutcome(entropy: ServerEntropy): KenoOutcome {
  const pool = Array.from({ length: 80 }, (_value, index) => index + 1);
  const drawn: number[] = [];
  for (let ball = 0; ball < 20; ball++) {
    const index = entropyIndex(entropy, pool.length, "keno ball");
    drawn.push(pool.splice(index, 1)[0]);
  }
  // Round-tripped through the module's own validator so a generated draw can
  // never be looser than a draw arriving off the wire.
  return validateKenoOutcome({ drawn });
}

export function settleKeno(
  selection: KenoSelection,
  stakePoints: number,
  outcome: KenoOutcome,
): SettlementResult {
  const stake = virtualPointStake(stakePoints);
  const drawSet = new Set(outcome.drawn);
  const hits = selection.picks.filter((pick) => drawSet.has(pick)).length;
  const column = KENO_PAYTABLE[selection.picks.length] ?? [];
  const multiplier = column[hits] ?? 0;
  const payout = Math.floor(stake * multiplier);
  return Object.freeze({
    stake_points: stake,
    payout_points: payout,
    net_points: payout - stake,
  });
}

export const KENO_RESOLVER: ReviewResolverModule<KenoSelection, KenoOutcome, KenoInspection> = Object.freeze({
  manifest: Object.freeze({
    catalog_slug: "keno",
    module_id: "keno-review-v1",
    live_resolver_id: "keno-v1",
    ruleset_version: 1,
    readiness: "READY",
    virtual_points_only: true,
    action_policy: Object.freeze({
      observed: Object.freeze(["place_bet", "repeat_bets", "collect_full"]),
      executable: Object.freeze(["place_bet", "repeat_bets", "collect_full"]),
    }),
    timing: Object.freeze({
      status: "VERIFIED",
      mode: "CLOCKED_SHARED",
      bet_seconds: 30,
      lock_seconds: 5,
      reveal_seconds: 6,
      result_seconds: 5,
      note:
        "MyDGP declared ruleset v1 shared-clock schedule: 30s betting, 5s lock, 6s reveal, 5s result. The six-second reveal keeps the measured twenty-seat/0.3-second ball-pipe cadence; the remaining boundaries are MyDGP's own declared values, not recovered original-client timings.",
    }),
    settlement: Object.freeze({
      status: "VERIFIED",
      unit: "VIRTUAL_POINTS",
      payout_semantics: "TOTAL_RETURN",
      note:
        "MyDGP declared ruleset v1. payout_points is the full virtual-point amount credited back, stake included, floored to a whole point. Every pick-count column from 1 through 10 returns exactly 0.900 (10.0% house edge), so no ticket size is a better bet than any other and Keno sits level with the rest of the catalogue. The ten-pick column keeps the shape of the ladder the shipped client prints for itself (Languages.txt strMsg038/039, which returned only 0.66583) scaled by 1.351701; the one-through-nine-pick shapes are MyDGP house values, each scaled by its own per-column constant from the ~0.92-0.96 they returned before. This is MyDGP's declared paytable, not a reproduction of the original cabinet's unpublished ladders.",
    }),
    blockers: Object.freeze([]),
    evidence: Object.freeze([
      "recovered/ReadableResources/UnityTextAssets/Languages.txt#strMsg038-strMsg039",
      "chakri-unity/docs/prep/keno-observation.md",
      "chakri-unity/docs/evidence/fixnotes/keno.md",
      "chakri-unity/Assets/Scripts/Engines/Tables.cs#Keno",
    ]),
  }),
  normalizeSelection: normalizeKenoSelection,
  validateOutcome: validateKenoOutcome,
  inspectOutcome: inspectKenoOutcome,
  generateOutcome: generateKenoOutcome,
  settle: settleKeno,
  deterministicVectors: Object.freeze([
    Object.freeze({
      name: "ticket-canonicalization-and-hit-count",
      input: Object.freeze({
        selection: "picks:80,1,4",
        drawn: Object.freeze([80, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]),
      }),
      expected: Object.freeze({ canonical: "picks:1,4,80", hits: 2, matched_numbers: Object.freeze([4, 80]) }),
    }),
    Object.freeze({
      name: "draw-order-is-not-sorted-away",
      input: Object.freeze({ drawn_prefix: Object.freeze([80, 1, 40]) }),
      expected: Object.freeze({ reveal_prefix: Object.freeze([80, 1, 40]), payout_points: null }),
    }),
  ]),
});
