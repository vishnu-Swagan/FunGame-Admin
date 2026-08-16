import {
  exactKeys,
  ResolverInputError,
  type ReviewResolverModule,
  type ServerEntropy,
  type SettlementResult,
  virtualPointStake,
} from "./resolver-contract.ts";
import { drawCard, parseWireCard, type WireCard } from "./cards.ts";

export type SevenUpDownSelection = "up" | "down";
export type SevenUpDownWinner = SevenUpDownSelection | "seven";

export type SevenUpDownOutcome = Readonly<{
  kind: "seven_up_down_card";
  card: WireCard;
  winner: SevenUpDownWinner;
  lost_on_seven: boolean;
}>;

export type SevenUpDownInspection = Readonly<{
  matched: boolean;
  directional_total_return_multiplier: 1.95;
  chart_payout_points: null;
  note: string;
}>;

export function normalizeSevenUpDownSelection(input: unknown): SevenUpDownSelection {
  if (input !== "up" && input !== "down") {
    throw new ResolverInputError("INVALID_SELECTION", "7Up7Down accepts only canonical up or down selections.");
  }
  return input;
}

export function sevenUpDownStake(input: unknown): number {
  const stake = virtualPointStake(input, 1000);
  if (stake < 5) {
    throw new ResolverInputError("INVALID_STAKE", "7Up7Down requires at least 5 virtual points.");
  }
  return stake;
}

function winnerFor(card: WireCard): SevenUpDownWinner {
  const rank = parseWireCard(card).rank;
  if (rank === 7) return "seven";
  if (rank >= 8 && rank <= 13) return "up";
  return "down";
}

export function validateSevenUpDownOutcome(input: unknown): SevenUpDownOutcome {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ResolverInputError("INVALID_OUTCOME", "7Up7Down requires a server card outcome object.");
  }
  const record = input as Record<string, unknown>;
  exactKeys(record, ["kind", "card", "winner", "lost_on_seven"], "INVALID_OUTCOME");
  if (record.kind !== "seven_up_down_card") {
    throw new ResolverInputError("INVALID_OUTCOME", "7Up7Down outcome kind is invalid.");
  }
  const parsed = parseWireCard(record.card);
  const winner = winnerFor(parsed.wire);
  if (record.winner !== winner || record.lost_on_seven !== (winner === "seven")) {
    throw new ResolverInputError("INVALID_OUTCOME", "7Up7Down winner fields do not match the server card.");
  }
  return Object.freeze({
    kind: "seven_up_down_card",
    card: parsed.wire,
    winner,
    lost_on_seven: winner === "seven",
  });
}

export function inspectSevenUpDownOutcome(
  outcome: SevenUpDownOutcome,
  selection: SevenUpDownSelection,
): SevenUpDownInspection {
  return Object.freeze({
    matched: outcome.winner === selection,
    directional_total_return_multiplier: 1.95,
    chart_payout_points: null,
    note: "The directional bet pays 1.95x total under ruleset v1; the separate 28-row chart trigger is still unknown.",
  });
}

/**
 * Operator-declared ruleset v1 house paytable (TOTAL_RETURN multipliers).
 *
 * One card is drawn from a fresh 52-card deck, so all 52 results are equally
 * likely and the three result classes are:
 *   up    = ranks 8,9,10,J,Q,K -> 6 ranks x 4 suits = 24/52
 *   down  = ranks A,2,3,4,5,6  -> 6 ranks x 4 suits = 24/52
 *   seven = rank 7             -> 1 rank  x 4 suits =  4/52 (both sides lose)
 *
 * Both directions are equally likely, so they carry one price.  Expected return
 * per staked point, either direction:
 *   up   x1.95 : 1.95 x 24/52 = 46.8/52 = 0.90 -> 90.00% return, house edge 10.00%
 *   down x1.95 : 1.95 x 24/52 = 46.8/52 = 0.90 -> 90.00% return, house edge 10.00%
 *
 * Rank 7 (4/52) sweeps both directions and is what funds the 10% hold.
 */
const SEVEN_UP_DOWN_DIRECTIONAL_MULTIPLIER = 1.95;

export function generateSevenUpDownOutcome(entropy: ServerEntropy): SevenUpDownOutcome {
  const card = drawCard(entropy);
  const winner = winnerFor(card);
  return validateSevenUpDownOutcome({
    kind: "seven_up_down_card",
    card,
    winner,
    lost_on_seven: winner === "seven",
  });
}

export function settleSevenUpDown(
  selection: SevenUpDownSelection,
  stakePoints: number,
  outcome: SevenUpDownOutcome,
): SettlementResult {
  const stake = sevenUpDownStake(stakePoints);
  const side = normalizeSevenUpDownSelection(selection);
  const payout = outcome.winner === side
    ? Math.floor(stake * SEVEN_UP_DOWN_DIRECTIONAL_MULTIPLIER)
    : 0;
  return Object.freeze({
    stake_points: stake,
    payout_points: payout,
    net_points: payout - stake,
  });
}

export const SEVEN_UP_SEVEN_DOWN_RESOLVER: ReviewResolverModule<
  SevenUpDownSelection,
  SevenUpDownOutcome,
  SevenUpDownInspection
> = Object.freeze({
  manifest: Object.freeze({
    catalog_slug: "7up7down",
    module_id: "seven-up-seven-down-review-v1",
    live_resolver_id: "7up7down-v1",
    ruleset_version: 1,
    readiness: "READY",
    virtual_points_only: true,
    action_policy: Object.freeze({
      observed: Object.freeze(["place_bet", "clear_bets", "collect_full"]),
      executable: Object.freeze(["place_bet", "clear_bets", "collect_full"]),
    }),
    timing: Object.freeze({
      status: "VERIFIED",
      mode: "CLOCKED_SHARED",
      bet_seconds: 15,
      lock_seconds: 1,
      reveal_seconds: 15,
      result_seconds: 11,
      note: "Operator-declared ruleset v1 round cadence: 15s betting, 1s lock, 15s reveal, 11s result.",
    }),
    settlement: Object.freeze({
      status: "VERIFIED",
      unit: "VIRTUAL_POINTS",
      payout_semantics: "TOTAL_RETURN",
      note: "Operator-declared ruleset v1 house paytable: a winning direction returns 1.95x the stake in total virtual points (stake included), floored to whole points; rank 7 loses both sides.",
    }),
    blockers: Object.freeze([]),
    evidence: Object.freeze([
      "chakri-unity/docs/prep/7up7down-observation.md",
      "chakri-unity/Assets/Scripts/Engines/SevenUpDown.cs",
      "FunGame-Admin/docs/LIVE_GAME_PARITY_READINESS_AUDIT.md",
    ]),
  }),
  normalizeSelection: normalizeSevenUpDownSelection,
  validateOutcome: validateSevenUpDownOutcome,
  inspectOutcome: inspectSevenUpDownOutcome,
  generateOutcome: generateSevenUpDownOutcome,
  settle: settleSevenUpDown,
  deterministicVectors: Object.freeze([
    Object.freeze({
      name: "observed-up-matches-with-directional-price-display",
      input: Object.freeze({ selection: "up", outcome: Object.freeze({ card: "9D", winner: "up" }) }),
      expected: Object.freeze({ winner: "up", matched: true, directional_total_return_multiplier: 1.95, chart_payout_points: null }),
    }),
    Object.freeze({
      name: "seven-loses-both-directions",
      input: Object.freeze({ selection: "down", outcome: Object.freeze({ card: "7S", winner: "seven" }) }),
      expected: Object.freeze({ winner: "seven", matched: false, lost_on_seven: true, chart_payout_points: null }),
    }),
  ]),
});
