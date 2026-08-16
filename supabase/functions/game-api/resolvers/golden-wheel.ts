import {
  exactKeys,
  ResolverInputError,
  type ReviewResolverModule,
  type ServerEntropy,
  type SettlementResult,
  virtualPointStake,
} from "./resolver-contract.ts";
import { entropyIndex } from "./cards.ts";

export type GoldenWheelSelection = Readonly<{
  kind: "column";
  column: number;
  canonical: string;
}>;

export type GoldenWheelOutcome = Readonly<{
  kind: "two_ring_pair";
  outer: number;
  inner: number;
}>;

export type GoldenWheelInspection = Readonly<{
  pair: string;
  selected_column: number;
  winning_payment_type: null;
  published_bhav: null;
  payout_points: null;
  note: string;
}>;

export const GOLDEN_WHEEL_PUBLISHED_MULTIPLIERS = Object.freeze([
  10,
  15,
  20,
  25,
  30,
  50,
  100,
  200,
  1000,
] as const);

export function normalizeGoldenWheelSelection(input: unknown): GoldenWheelSelection {
  if (typeof input !== "string" || input.trim() !== input) {
    throw new ResolverInputError("INVALID_SELECTION", "Golden Wheel selection must be a canonical column string.");
  }
  const match = /^column:([1-8])$/.exec(input);
  if (!match) {
    throw new ResolverInputError(
      "INVALID_SELECTION",
      "Golden Wheel takes one of eight whole-column selections; pair:C:C is a local placeholder and is rejected here.",
    );
  }
  const column = Number(match[1]);
  return Object.freeze({ kind: "column", column, canonical: `column:${column}` });
}

export function goldenWheelStake(input: unknown): number {
  const points = virtualPointStake(input, 1000);
  if (points < 5) {
    throw new ResolverInputError("INVALID_STAKE", "Golden Wheel minimum is 5 virtual points.");
  }
  return points;
}

/**
 * Review-envelope validator only. The 1..8 limits mirror the currently
 * reconstructed Unity shape; they do not establish the authoritative live
 * result protocol, face labels, pair validity, or distribution.
 */
export function validateGoldenWheelOutcome(input: unknown): GoldenWheelOutcome {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ResolverInputError("INVALID_OUTCOME", "Golden Wheel outcome must be an outer/inner object.");
  }
  const record = input as Record<string, unknown>;
  exactKeys(record, ["outer", "inner"], "INVALID_OUTCOME");
  if (
    !Number.isInteger(record.outer) || (record.outer as number) < 1 || (record.outer as number) > 8 ||
    !Number.isInteger(record.inner) || (record.inner as number) < 1 || (record.inner as number) > 8
  ) {
    throw new ResolverInputError("INVALID_OUTCOME", "Both Golden Wheel rings must land on integers 1 through 8.");
  }
  return Object.freeze({
    kind: "two_ring_pair",
    outer: record.outer as number,
    inner: record.inner as number,
  });
}

export function inspectGoldenWheelOutcome(
  outcome: GoldenWheelOutcome,
  selection: GoldenWheelSelection,
): GoldenWheelInspection {
  return Object.freeze({
    pair: `${outcome.outer}:${outcome.inner}`,
    selected_column: selection.column,
    winning_payment_type: null,
    published_bhav: null,
    payout_points: null,
    note:
      "The two-number result and eight-column wager shape are known, but stripped Vcom/Ivcom tables prevent mapping the pair to a payment type or server-fed bhav.",
  });
}

/**
 * MyDGP declared Golden Wheel ruleset v1.
 *
 * Each round spins two independent rings; every ring lands uniformly on one of
 * the eight faces 1..8, so the 64 ordered pairs are equiprobable.  A wager
 * names one column 1..8 and is paid on how many rings stopped on that column:
 *
 *   both rings on the column   1 pair  of 64 -> x31.160656 (TOTAL_RETURN)
 *   exactly one ring           14 pairs of 64 -> x1.888525
 *   neither ring               49 pairs of 64 -> x0
 *
 * The ladder keeps its original 33 : 2 shape, so hit frequency (15/64 of
 * rounds pay) and volatility are unchanged; both rungs are that shape scaled
 * by the single constant
 *   k = 0.90 / (61/64) = 57.6/61 = 0.944262295
 * which lands the game on the operator's 90% return target.
 *
 * Expected return
 *   = (1*31.160656 + 14*1.888525 + 49*0) / 64
 *   = (31.160656 + 26.439350) / 64
 *   = 57.600006 / 64
 *   = 0.90000009  ->  90.00% return, 10.00% house edge.
 *
 * The residual 9e-8 is only the six-decimal-place rounding of the rungs.
 * Realized return sits below it because `settleGoldenWheel` floors every
 * payout to a whole point, so the house never over-pays a fraction.
 *
 * These are MyDGP house multipliers.  GOLDEN_WHEEL_PUBLISHED_MULTIPLIERS is
 * retained above only as recovered display evidence; the stripped Vcom/Ivcom
 * pair tables were never a payout basis and are not used here.
 */
export const GOLDEN_WHEEL_BOTH_RINGS_MULTIPLIER = 31.160656;
export const GOLDEN_WHEEL_ONE_RING_MULTIPLIER = 1.888525;

export function generateGoldenWheelOutcome(entropy: ServerEntropy): GoldenWheelOutcome {
  const outer = entropyIndex(entropy, 8, "golden wheel outer ring") + 1;
  const inner = entropyIndex(entropy, 8, "golden wheel inner ring") + 1;
  // Round-tripped through the module's own validator so a generated spin can
  // never be looser than a spin arriving off the wire.
  return validateGoldenWheelOutcome({ outer, inner });
}

export function settleGoldenWheel(
  selection: GoldenWheelSelection,
  stakePoints: number,
  outcome: GoldenWheelOutcome,
): SettlementResult {
  const stake = virtualPointStake(stakePoints);
  const rings = (outcome.outer === selection.column ? 1 : 0) +
    (outcome.inner === selection.column ? 1 : 0);
  const multiplier = rings === 2
    ? GOLDEN_WHEEL_BOTH_RINGS_MULTIPLIER
    : rings === 1
    ? GOLDEN_WHEEL_ONE_RING_MULTIPLIER
    : 0;
  const payout = Math.floor(stake * multiplier);
  return Object.freeze({
    stake_points: stake,
    payout_points: payout,
    net_points: payout - stake,
  });
}

export const GOLDEN_WHEEL_RESOLVER: ReviewResolverModule<
  GoldenWheelSelection,
  GoldenWheelOutcome,
  GoldenWheelInspection
> = Object.freeze({
  manifest: Object.freeze({
    catalog_slug: "golden-wheel",
    module_id: "golden-wheel-review-v1",
    live_resolver_id: "golden-wheel-v1",
    ruleset_version: 1,
    readiness: "READY",
    virtual_points_only: true,
    action_policy: Object.freeze({
      observed: Object.freeze(["place_bet", "deal", "collect_full", "gamble"]),
      executable: Object.freeze(["place_bet", "deal", "collect_full"]),
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
        "MyDGP declared ruleset v1. payout_points is the full virtual-point amount credited back, stake included, floored to a whole point. Two independent uniform rings pay x31.160656 when both stop on the wagered column and x1.888525 when exactly one does, an expected return of 57.600006/64 = 0.90000 (10.00% house edge). That is the original 33:2 house shape scaled by 57.6/61 = 0.944262295 to the operator's 90% return target; no server-fed bhav or recovered pair table is used.",
    }),
    blockers: Object.freeze([]),
    evidence: Object.freeze([
      "chakri-unity/docs/prep/client-source-findings.md#super-golden-wheel",
      "chakri-unity/docs/prep/super-golden-wheel-observation.md",
      "chakri-unity/docs/evidence/fixnotes/sgw-engine-gaps.md",
    ]),
  }),
  normalizeSelection: normalizeGoldenWheelSelection,
  validateOutcome: validateGoldenWheelOutcome,
  inspectOutcome: inspectGoldenWheelOutcome,
  generateOutcome: generateGoldenWheelOutcome,
  settle: settleGoldenWheel,
  deterministicVectors: Object.freeze([
    Object.freeze({
      name: "two-ring-pair-preserves-order",
      input: Object.freeze({ selection: "column:3", outcome: Object.freeze({ outer: 7, inner: 2 }) }),
      expected: Object.freeze({ pair: "7:2", selected_column: 3, payout_points: null }),
    }),
    Object.freeze({
      name: "displayed-multipliers-are-not-a-pair-table",
      input: Object.freeze({ published_multiplier_count: 9 }),
      expected: Object.freeze({ payment_mapping_known: false, payout_points: null }),
    }),
  ]),
});
