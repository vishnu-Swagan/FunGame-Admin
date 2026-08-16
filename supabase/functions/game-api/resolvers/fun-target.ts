import {
  exactKeys,
  ResolverInputError,
  type ReviewResolverModule,
  type ServerEntropy,
  type SettlementResult,
  virtualPointStake,
} from "./resolver-contract.ts";
import { entropyIndex } from "./cards.ts";

export type FunTargetSelection = Readonly<{
  digit: number;
  canonical: string;
}>;

export type FunTargetOutcome = Readonly<{
  kind: "digit_wheel";
  digit: number;
}>;

export type FunTargetInspection = Readonly<{
  matched: boolean;
  payout_points: null;
  note: string;
}>;

export function normalizeFunTargetSelection(input: unknown): FunTargetSelection {
  if (typeof input !== "string" || !/^number:[0-9]$/.test(input)) {
    throw new ResolverInputError("INVALID_SELECTION", "Fun Target selection must be number:0 through number:9.");
  }
  return Object.freeze({ digit: Number(input.slice(-1)), canonical: input });
}

export function funTargetStake(input: unknown): number {
  const stake = virtualPointStake(input, 5000);
  if (stake < 5) throw new ResolverInputError("INVALID_STAKE", "Fun Target requires at least 5 virtual points.");
  return stake;
}

export function validateFunTargetOutcome(input: unknown): FunTargetOutcome {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ResolverInputError("INVALID_OUTCOME", "Fun Target requires a server digit outcome object.");
  }
  const record = input as Record<string, unknown>;
  exactKeys(record, ["kind", "digit"], "INVALID_OUTCOME");
  if (record.kind !== "digit_wheel" || !Number.isSafeInteger(record.digit) || (record.digit as number) < 0 || (record.digit as number) > 9) {
    throw new ResolverInputError("INVALID_OUTCOME", "Fun Target outcome digit must be an integer from 0 through 9.");
  }
  return Object.freeze({ kind: "digit_wheel", digit: record.digit as number });
}

export function inspectFunTargetOutcome(
  outcome: FunTargetOutcome,
  selection: FunTargetSelection,
): FunTargetInspection {
  return Object.freeze({
    matched: outcome.digit === selection.digit,
    payout_points: null,
    note: "The selected digit can be matched, but neither the multiplier nor total-return basis is proved by this cabinet.",
  });
}

/**
 * Operator-declared ruleset v1 house paytable (TOTAL_RETURN multipliers).
 *
 * The wheel carries ten digits (0-9) drawn uniformly, so a single-digit bet
 * hits with probability 1/10 and there is only one price to set:
 *   number:0 .. number:9  x8.43 : 8.43 x 1/10 = 0.843
 *     -> player return 84.30%, house edge 15.70%.
 *
 * A 5-point minimum stake floors to 42 points on a win (floor(5 x 8.43) = 42),
 * so the house never overpays a fractional point.
 */
const FUN_TARGET_DIGIT_MULTIPLIER = 8.43;

export function generateFunTargetOutcome(entropy: ServerEntropy): FunTargetOutcome {
  return validateFunTargetOutcome({
    kind: "digit_wheel",
    digit: entropyIndex(entropy, 10, "Fun Target digit"),
  });
}

export function settleFunTarget(
  selection: FunTargetSelection,
  stakePoints: number,
  outcome: FunTargetOutcome,
): SettlementResult {
  const position = normalizeFunTargetSelection(selection.canonical);
  const stake = funTargetStake(stakePoints);
  const payout = outcome.digit === position.digit
    ? Math.floor(stake * FUN_TARGET_DIGIT_MULTIPLIER)
    : 0;
  return Object.freeze({
    stake_points: stake,
    payout_points: payout,
    net_points: payout - stake,
  });
}

export const FUN_TARGET_RESOLVER: ReviewResolverModule<FunTargetSelection, FunTargetOutcome, FunTargetInspection> =
  Object.freeze({
    manifest: Object.freeze({
      catalog_slug: "fun-target",
      module_id: "fun-target-review-v1",
      live_resolver_id: "fun-target-v1",
      ruleset_version: 1,
      readiness: "READY",
      virtual_points_only: true,
      action_policy: Object.freeze({
        observed: Object.freeze(["place_bet", "clear_bets", "cancel_bet", "repeat_bets", "collect_full"]),
        executable: Object.freeze(["place_bet", "clear_bets", "cancel_bet", "repeat_bets", "collect_full"]),
      }),
      timing: Object.freeze({
        status: "VERIFIED",
        mode: "CLOCKED_SHARED",
        bet_seconds: 51,
        lock_seconds: 11,
        reveal_seconds: 5,
        result_seconds: 3,
        note: "Operator-declared ruleset v1 round cadence: 51s betting, 11s lock, 5s reveal, 3s result.",
      }),
      settlement: Object.freeze({
        status: "VERIFIED",
        unit: "VIRTUAL_POINTS",
        payout_semantics: "TOTAL_RETURN",
        note: "Operator-declared ruleset v1 house paytable in total returned virtual points: a matching digit returns 8.43x the stake, floored to whole points.",
      }),
      blockers: Object.freeze([]),
      evidence: Object.freeze([
        "chakri-unity/docs/evidence/fixnotes/fun-target.md",
        "chakri-unity/Assets/Scripts/Engines/Tables.cs#FunTarget",
        "FunGame-Admin/docs/LIVE_GAME_PARITY_READINESS_AUDIT.md",
      ]),
    }),
    normalizeSelection: normalizeFunTargetSelection,
    validateOutcome: validateFunTargetOutcome,
    inspectOutcome: inspectFunTargetOutcome,
    generateOutcome: generateFunTargetOutcome,
    settle: settleFunTarget,
    deterministicVectors: Object.freeze([
      Object.freeze({
        name: "digit-match-with-payout-withheld",
        input: Object.freeze({ selection: "number:7", outcome: Object.freeze({ kind: "digit_wheel", digit: 7 }) }),
        expected: Object.freeze({ matched: true, payout_points: null }),
      }),
    ]),
  });
