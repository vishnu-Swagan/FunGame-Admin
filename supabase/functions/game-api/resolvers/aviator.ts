import {
  exactKeys,
  plainRecord,
  ResolverInputError,
  type ReviewResolverModule,
  type ServerEntropy,
  type SettlementResult,
  virtualPointStake,
} from "./resolver-contract.ts";
import {
  AVIATOR_MAX_CENTIS,
  AVIATOR_MIN_CENTIS,
  generateAviatorCrashCentis,
  settleAviator,
} from "../aviator.ts";

/**
 * The lowest auto cash-out a player may set, in centis. A target of exactly
 * 1.00x is excluded on purpose: settleAviator counts a cash-out at or below the
 * crash as reached, and an instant bust IS a crash at 1.00x, so a 1.00x target
 * would be paid back on every single round — a risk-free 100% return that would
 * void the house edge. The lowest real flight the generator produces is 1.01x,
 * so 1.01x is the lowest target that carries genuine bust risk.
 */
export const AVIATOR_MIN_CASH_OUT_CENTIS = AVIATOR_MIN_CENTIS + 1; // 101 = 1.01x

export type AviatorSelection = Readonly<{
  kind: "auto_cash_out";
  /** The multiplier, in centis (100 = 1.00x), the player auto-cashes out at. */
  cash_out_centis: number;
}>;

export type AviatorOutcome = Readonly<{
  kind: "crash_flight";
  /** The multiplier the flight crashed at, in centis. */
  crash_centis: number;
}>;

export type AviatorInspection = Readonly<{
  cash_out_centis: number;
  crash_centis: number;
  /** True when the auto cash-out was at or below the crash and therefore paid. */
  reached: boolean;
  published_multiplier: number;
  payout_points: null;
  note: string;
}>;

/**
 * Accept the player's auto cash-out target.
 *
 * The wire form is `{ cash_out_centis: N }`. A bare string is also accepted so a
 * client that sends "150", "1.50x", or the older "panelN:150" still resolves to
 * a target rather than bricking the hand — the trailing whole-centis group is
 * read out and validated. The value must be a real flight target between 1.01x
 * and the 1000.00x ceiling; 1.00x is rejected (see AVIATOR_MIN_CASH_OUT_CENTIS).
 */
export function normalizeAviatorSelection(input: unknown): AviatorSelection {
  let centis: number | null = null;
  if (typeof input === "string") {
    const match = input.match(/(\d+)\s*$/);
    if (match) centis = Number(match[1]);
  } else {
    const record = plainRecord(input, "INVALID_SELECTION");
    exactKeys(record, ["cash_out_centis"], "INVALID_SELECTION");
    if (Number.isSafeInteger(record.cash_out_centis)) {
      centis = record.cash_out_centis as number;
    }
  }
  if (
    centis === null || !Number.isSafeInteger(centis) ||
    centis < AVIATOR_MIN_CASH_OUT_CENTIS || centis > AVIATOR_MAX_CENTIS
  ) {
    throw new ResolverInputError(
      "INVALID_SELECTION",
      `Aviator auto cash-out must be a whole-centis multiplier between ${AVIATOR_MIN_CASH_OUT_CENTIS} (1.01x) and ${AVIATOR_MAX_CENTIS} (1000.00x).`,
    );
  }
  return Object.freeze({ kind: "auto_cash_out", cash_out_centis: centis });
}

export function validateAviatorOutcome(input: unknown): AviatorOutcome {
  const record = plainRecord(input, "INVALID_OUTCOME");
  // Accept the validator's own projection (which carries kind) as well as the
  // compact wire form, because the paced settlement path validates twice.
  if (Object.hasOwn(record, "kind")) {
    if (record.kind !== "crash_flight") {
      throw new ResolverInputError("INVALID_OUTCOME", "Aviator outcome kind is invalid.");
    }
    exactKeys(record, ["kind", "crash_centis"], "INVALID_OUTCOME");
  } else {
    exactKeys(record, ["crash_centis"], "INVALID_OUTCOME");
  }
  const centis = record.crash_centis;
  if (
    !Number.isSafeInteger(centis) ||
    (centis as number) < AVIATOR_MIN_CENTIS || (centis as number) > AVIATOR_MAX_CENTIS
  ) {
    throw new ResolverInputError("INVALID_OUTCOME", "Aviator crash multiplier is out of range.");
  }
  return Object.freeze({ kind: "crash_flight", crash_centis: centis as number });
}

export function inspectAviatorOutcome(
  outcome: AviatorOutcome,
  selection: AviatorSelection,
): AviatorInspection {
  const reached = selection.cash_out_centis <= outcome.crash_centis;
  return Object.freeze({
    cash_out_centis: selection.cash_out_centis,
    crash_centis: outcome.crash_centis,
    reached,
    published_multiplier: selection.cash_out_centis / 100,
    payout_points: null,
    note:
      "Ruleset v1: the flight crashes at a CSPRNG-drawn multiplier from P(crash>=m)=0.9/m; the player's auto cash-out pays stake x its multiplier (total return) when it is at or below the crash, otherwise the stake is lost. Any fixed target returns 90%.",
  });
}

export function generateAviatorOutcome(entropy: ServerEntropy): AviatorOutcome {
  return validateAviatorOutcome({ crash_centis: generateAviatorCrashCentis(entropy) });
}

export function settleAviatorHand(
  selection: AviatorSelection,
  stakePoints: number,
  outcome: AviatorOutcome,
): SettlementResult {
  const stake = virtualPointStake(stakePoints);
  const settled = settleAviator(selection.cash_out_centis, stake, outcome.crash_centis);
  return Object.freeze({
    stake_points: settled.stake_points,
    payout_points: settled.payout_points,
    net_points: settled.net_points,
  });
}

export const AVIATOR_RESOLVER: ReviewResolverModule<
  AviatorSelection,
  AviatorOutcome,
  AviatorInspection
> = Object.freeze({
  manifest: Object.freeze({
    catalog_slug: "aviator",
    module_id: "aviator-review-v1",
    live_resolver_id: "aviator-v1",
    ruleset_version: 1,
    readiness: "READY",
    virtual_points_only: true,
    action_policy: Object.freeze({
      observed: Object.freeze(["place_bet", "cash_out", "clear_bets", "collect_full"]),
      executable: Object.freeze(["place_bet", "collect_full"]),
    }),
    timing: Object.freeze({
      status: "VERIFIED",
      mode: "PLAYER_PACED",
      bet_seconds: null,
      lock_seconds: null,
      reveal_seconds: 4,
      result_seconds: 4,
      note:
        "Operator-declared ruleset v1 cadence: player-paced with no betting clock. The stake and its auto cash-out target are committed in one press; the crash multiplier is drawn once by the CSPRNG and the hand settles in the same request. The client animates the flight to the drawn crash point.",
    }),
    settlement: Object.freeze({
      status: "VERIFIED",
      unit: "VIRTUAL_POINTS",
      payout_semantics: "TOTAL_RETURN",
      note:
        "Operator-declared ruleset v1: crash multiplier drawn from P(crash>=m)=(1-edge)/m with edge=0.10, delivered as a 10% instant-bust at 1.00x plus the tail. A fixed auto cash-out at multiplier m returns exactly 90% of stake for every m, floored to whole points (total return, includes stake). A 1.00x target is disallowed so the edge cannot be voided.",
    }),
    blockers: Object.freeze([]),
    evidence: Object.freeze([
      "chakri-unity/Assets/Scripts/Engines/AviatorTable.cs",
      "chakri-unity/Assets/Scripts/Engines/Tables.cs#Aviator",
      "supabase/functions/game-api/aviator.ts",
      "supabase/functions/game-api/aviator.test.ts",
    ]),
  }),
  normalizeSelection: normalizeAviatorSelection,
  validateOutcome: validateAviatorOutcome,
  inspectOutcome: inspectAviatorOutcome,
  generateOutcome: generateAviatorOutcome,
  settle: settleAviatorHand,
  deterministicVectors: Object.freeze([
    Object.freeze({
      name: "cash-out-at-or-below-crash-is-reached",
      input: Object.freeze({ cash_out_centis: 250, crash_centis: 400 }),
      expected: Object.freeze({ reached: true, cash_out_multiplier: "2.50x" }),
    }),
    Object.freeze({
      name: "cash-out-above-crash-is-not-reached",
      input: Object.freeze({ cash_out_centis: 300, crash_centis: 200 }),
      expected: Object.freeze({ reached: false }),
    }),
    Object.freeze({
      name: "instant-bust-is-not-reached-even-at-the-lowest-target",
      input: Object.freeze({ cash_out_centis: 101, crash_centis: 100 }),
      expected: Object.freeze({ reached: false, note: "a 1.00x crash beats every valid target" }),
    }),
  ]),
});
