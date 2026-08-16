import {
  exactKeys,
  ResolverInputError,
  type ReviewResolverModule,
  type ServerEntropy,
  type SettlementResult,
  virtualPointStake,
} from "./resolver-contract.ts";
import { entropyIndex } from "./cards.ts";

export type TripleFunSelectionKind = "single" | "double" | "triple";

export type TripleFunSelection = Readonly<{
  kind: TripleFunSelectionKind;
  digits: string;
  value: number;
  verified_max_stake_points: number;
}>;

export type TripleFunOutcome = Readonly<{
  kind: "three_digit_draw";
  digits: readonly [number, number, number];
  triple: string;
  double: string;
  single: string;
}>;

export type TripleFunInspection = Readonly<{
  matched: boolean;
  published_bhav: 9 | 90 | 900;
  payout_points: null;
  note: string;
}>;

const BHAV = Object.freeze({ single: 9, double: 90, triple: 900 } as const);
const MAX_STAKE = Object.freeze({ single: 5000, double: 1000, triple: 100 } as const);

export function normalizeTripleFunSelection(input: unknown): TripleFunSelection {
  if (typeof input !== "string" || input.trim() !== input) {
    throw new ResolverInputError("INVALID_SELECTION", "Triple Fun selection must be a canonical string.");
  }
  const match = /^(single):(\d)$|^(double):(\d{2})$|^(triple):(\d{3})$/.exec(input);
  if (!match) {
    throw new ResolverInputError(
      "INVALID_SELECTION",
      "Use single:N, double:NN, or triple:NNN with leading zeroes preserved.",
    );
  }
  const kind = (match[1] || match[3] || match[5]) as TripleFunSelectionKind;
  const digits = match[2] || match[4] || match[6];
  return Object.freeze({
    kind,
    digits,
    value: Number(digits),
    verified_max_stake_points: MAX_STAKE[kind],
  });
}

export function tripleFunStake(input: unknown, selection: TripleFunSelection): number {
  return virtualPointStake(input, selection.verified_max_stake_points);
}

export function validateTripleFunOutcome(input: unknown): TripleFunOutcome {
  let digits: unknown;
  if (typeof input === "string") {
    if (!/^\d{3}$/.test(input)) {
      throw new ResolverInputError("INVALID_OUTCOME", "Triple Fun outcome must contain exactly three digits.");
    }
    digits = [...input].map(Number);
  } else {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      throw new ResolverInputError("INVALID_OUTCOME", "Triple Fun outcome must be a three-digit string or digits object.");
    }
    const record = input as Record<string, unknown>;
    exactKeys(record, ["digits"], "INVALID_OUTCOME");
    digits = record.digits;
  }
  if (
    !Array.isArray(digits) || digits.length !== 3 ||
    digits.some((digit) => !Number.isInteger(digit) || digit < 0 || digit > 9)
  ) {
    throw new ResolverInputError("INVALID_OUTCOME", "Triple Fun requires three integer digits from 0 through 9.");
  }
  const [hundreds, tens, units] = digits as [number, number, number];
  const triple = `${hundreds}${tens}${units}`;
  return Object.freeze({
    kind: "three_digit_draw",
    digits: Object.freeze([hundreds, tens, units]) as readonly [number, number, number],
    triple,
    double: `${tens}${units}`,
    single: `${units}`,
  });
}

export function inspectTripleFunOutcome(
  outcome: TripleFunOutcome,
  selection: TripleFunSelection,
): TripleFunInspection {
  const actual = selection.kind === "single"
    ? outcome.single
    : selection.kind === "double"
    ? outcome.double
    : outcome.triple;
  return Object.freeze({
    matched: selection.digits === actual,
    published_bhav: BHAV[selection.kind],
    payout_points: null,
    note:
      "The client constants prove 9/90/900 bhav; ruleset v1 settles that bhav as total return, so call settle() for the credited points.",
  });
}

/**
 * Operator-declared ruleset v1 house paytable (TOTAL_RETURN multipliers).
 *
 * Each of the three result digits is drawn independently and uniformly from
 * 0-9, so the three selection classes hit with:
 *   single (last digit)      1/10   = 0.1
 *   double (last two digits) 1/100  = 0.01
 *   triple (all three)       1/1000 = 0.001
 *
 * Ruleset v1 prices every class at a uniform 90% return, which is exactly the
 * published client bhav of 9 / 90 / 900:
 *   single x9    :   9   x 1/10   = 0.90 -> 90.00% return, 10.00% house edge
 *   double x90   :  90   x 1/100  = 0.90 -> 90.00% return, 10.00% house edge
 *   triple x900  : 900   x 1/1000 = 0.90 -> 90.00% return, 10.00% house edge
 *
 * All three multipliers are whole numbers, so a whole-point stake always pays a
 * whole number of points and the floor below never has a fraction to discard.
 */
const TRIPLE_FUN_HOUSE_MULTIPLIERS: Readonly<Record<TripleFunSelectionKind, number>> = Object.freeze({
  single: 9,
  double: 90,
  triple: 900,
});

export function generateTripleFunOutcome(entropy: ServerEntropy): TripleFunOutcome {
  const digits = [
    entropyIndex(entropy, 10, "Triple Fun hundreds digit"),
    entropyIndex(entropy, 10, "Triple Fun tens digit"),
    entropyIndex(entropy, 10, "Triple Fun units digit"),
  ];
  return validateTripleFunOutcome({ digits });
}

export function settleTripleFun(
  selection: TripleFunSelection,
  stakePoints: number,
  outcome: TripleFunOutcome,
): SettlementResult {
  const position = normalizeTripleFunSelection(`${selection.kind}:${selection.digits}`);
  const stake = tripleFunStake(stakePoints, position);
  const actual = position.kind === "single"
    ? outcome.single
    : position.kind === "double"
    ? outcome.double
    : outcome.triple;
  const payout = position.digits === actual
    ? Math.floor(stake * TRIPLE_FUN_HOUSE_MULTIPLIERS[position.kind])
    : 0;
  return Object.freeze({
    stake_points: stake,
    payout_points: payout,
    net_points: payout - stake,
  });
}

export const TRIPLE_FUN_RESOLVER: ReviewResolverModule<
  TripleFunSelection,
  TripleFunOutcome,
  TripleFunInspection
> = Object.freeze({
  manifest: Object.freeze({
    catalog_slug: "triple-fun",
    module_id: "triple-fun-review-v1",
    live_resolver_id: "triple-fun-v1",
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
      reveal_seconds: 5,
      result_seconds: 5,
      note: "Operator-declared ruleset v1 round cadence: 30s betting, 5s lock, 5s reveal, 5s result.",
    }),
    settlement: Object.freeze({
      status: "VERIFIED",
      unit: "VIRTUAL_POINTS",
      payout_semantics: "TOTAL_RETURN",
      note: "Operator-declared ruleset v1 house paytable in total returned virtual points: single 9x, double 90x, triple 900x, each floored to whole points.",
    }),
    blockers: Object.freeze([]),
    evidence: Object.freeze([
      "chakri-unity/docs/prep/client-source-findings.md#triple-fun",
      "chakri-unity/docs/prep/triple-fun-observation.md",
      "chakri-unity/Assets/Scripts/Engines/Tables.cs#TripleFun",
    ]),
  }),
  normalizeSelection: normalizeTripleFunSelection,
  validateOutcome: validateTripleFunOutcome,
  inspectOutcome: inspectTripleFunOutcome,
  generateOutcome: generateTripleFunOutcome,
  settle: settleTripleFun,
  deterministicVectors: Object.freeze([
    Object.freeze({
      name: "captured-592-exact-triple",
      input: Object.freeze({ selection: "triple:592", outcome: "592" }),
      expected: Object.freeze({ matched: true, bhav: 900, single: "2", double: "92", triple: "592" }),
    }),
    Object.freeze({
      name: "leading-zero-double-is-distinct",
      input: Object.freeze({ selection: "double:04", outcome: "404" }),
      expected: Object.freeze({ matched: true, bhav: 90, normalized_selection: "double:04" }),
    }),
  ]),
});
