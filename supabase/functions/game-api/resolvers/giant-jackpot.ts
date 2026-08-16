import {
  exactKeys,
  ResolverInputError,
  type ReviewResolverModule,
  type ServerEntropy,
  type SettlementResult,
  virtualPointStake,
} from "./resolver-contract.ts";
import { entropyIndex } from "./cards.ts";

export const GIANT_JACKPOT_SYMBOLS = Object.freeze([
  "gameking",
  "bar",
  "watermelon",
  "bell",
  "brinjal",
  "orange",
  "cherry",
] as const);

export type GiantJackpotSymbol = typeof GIANT_JACKPOT_SYMBOLS[number];

export type GiantJackpotSelection = Readonly<{ kind: "stake" }>;
export type GiantJackpotOutcome = Readonly<{
  kind: "four_window_ladder";
  windows: readonly [GiantJackpotSymbol, GiantJackpotSymbol, GiantJackpotSymbol, GiantJackpotSymbol];
}>;

type GiantJackpotRow =
  | "gameking"
  | "all_bar"
  | "all_watermelon"
  | "all_bell"
  | "all_brinjal"
  | "all_orange"
  | "all_cherry"
  | "three_cap"
  | "three_bar"
  | "three_watermelon"
  | "three_bell"
  | "three_brinjal"
  | "three_orange"
  | "three_cherry"
  | "two_cap"
  | "two_cherry"
  | "one_cherry"
  | "one_cap";

export type GiantJackpotInspection = Readonly<{
  matching_rows: readonly GiantJackpotRow[];
  best_candidate_row: GiantJackpotRow | null;
  published_base_amount: number | null;
  row_is_priced_in_client_source: boolean;
  payout_points: null;
  note: string;
}>;

const ROW_RANK: Readonly<Record<GiantJackpotRow, number>> = Object.freeze({
  gameking: 1,
  all_bar: 2,
  all_watermelon: 3,
  all_bell: 4,
  all_brinjal: 5,
  all_orange: 6,
  all_cherry: 7,
  three_cap: 8,
  three_bar: 9,
  three_watermelon: 10,
  three_bell: 11,
  three_brinjal: 12,
  three_orange: 13,
  three_cherry: 14,
  two_cap: 15,
  two_cherry: 16,
  one_cherry: 17,
  one_cap: 18,
});

const PUBLISHED_BASE_AMOUNTS: Readonly<Partial<Record<GiantJackpotRow, number>>> = Object.freeze({
  gameking: 500,
  all_bar: 250,
  all_watermelon: 100,
  all_bell: 50,
  all_brinjal: 40,
  all_orange: 30,
  all_cherry: 25,
  three_bar: 20,
  three_watermelon: 20,
  three_bell: 18,
  three_brinjal: 14,
  three_orange: 10,
  three_cherry: 8,
  two_cherry: 5,
  one_cherry: 2,
});

const symbolSet = new Set<string>(GIANT_JACKPOT_SYMBOLS);

export function normalizeGiantJackpotSelection(input: unknown): GiantJackpotSelection {
  if (input !== "__stake__") {
    throw new ResolverInputError(
      "INVALID_SELECTION",
      "Giant Jackpot exposes one internal stake selection; side-game controls are not main wagers.",
    );
  }
  return Object.freeze({ kind: "stake" });
}

export function giantJackpotStake(input: unknown): number {
  return virtualPointStake(input, 1000);
}

export function validateGiantJackpotOutcome(input: unknown): GiantJackpotOutcome {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ResolverInputError("INVALID_OUTCOME", "Giant Jackpot outcome must be a windows object.");
  }
  const record = input as Record<string, unknown>;
  exactKeys(record, ["windows"], "INVALID_OUTCOME");
  if (!Array.isArray(record.windows) || record.windows.length !== 4) {
    throw new ResolverInputError("INVALID_OUTCOME", "Giant Jackpot requires exactly four windows.");
  }
  const normalized = record.windows.map((symbol) =>
    typeof symbol === "string" ? symbol.toLowerCase() : symbol
  );
  if (normalized.some((symbol) => typeof symbol !== "string" || !symbolSet.has(symbol))) {
    throw new ResolverInputError("INVALID_OUTCOME", "Giant Jackpot contains an unknown reel symbol.");
  }
  return Object.freeze({
    kind: "four_window_ladder",
    windows: Object.freeze(normalized) as GiantJackpotOutcome["windows"],
  });
}

function rowFor(symbol: GiantJackpotSymbol, count: number): GiantJackpotRow | null {
  const allRows: Record<GiantJackpotSymbol, GiantJackpotRow> = {
    gameking: "gameking",
    bar: "all_bar",
    watermelon: "all_watermelon",
    bell: "all_bell",
    brinjal: "all_brinjal",
    orange: "all_orange",
    cherry: "all_cherry",
  };
  const threeRows: Record<GiantJackpotSymbol, GiantJackpotRow> = {
    gameking: "three_cap",
    bar: "three_bar",
    watermelon: "three_watermelon",
    bell: "three_bell",
    brinjal: "three_brinjal",
    orange: "three_orange",
    cherry: "three_cherry",
  };
  if (count === 4) return allRows[symbol];
  if (count === 3) return threeRows[symbol];
  if (count === 2) return symbol === "gameking" ? "two_cap" : symbol === "cherry" ? "two_cherry" : null;
  if (count === 1) return symbol === "gameking" ? "one_cap" : symbol === "cherry" ? "one_cherry" : null;
  return null;
}

export function inspectGiantJackpotOutcome(
  outcome: GiantJackpotOutcome,
  _selection: GiantJackpotSelection,
): GiantJackpotInspection {
  const rows: GiantJackpotRow[] = [];
  for (const symbol of GIANT_JACKPOT_SYMBOLS) {
    const count = outcome.windows.filter((window) => window === symbol).length;
    const row = rowFor(symbol, count);
    if (row) rows.push(row);
  }
  rows.sort((left, right) => ROW_RANK[left] - ROW_RANK[right]);
  const best = rows[0] ?? null;
  const amount = best ? PUBLISHED_BASE_AMOUNTS[best] ?? null : null;
  return Object.freeze({
    matching_rows: Object.freeze(rows),
    best_candidate_row: best,
    published_base_amount: amount,
    row_is_priced_in_client_source: best !== null && amount !== null,
    payout_points: null,
    note:
      "The ladder can classify four supplied windows, but source does not prove reel weights, payout scaling, cap prices, or multi-row precedence.",
  });
}

/**
 * MyDGP declared Giant Jackpot ruleset v1.
 *
 * The fifteen amounts in PUBLISHED_BASE_AMOUNTS are real client constants and
 * are kept verbatim as the base ladder.  Three rows were priced at runtime by
 * the original server and survive nowhere, so MyDGP declares them here as
 * house values: three_cap 250, two_cap 25, one_cap 3.
 *
 * Declared reel weights, one independent draw per window, in the
 * GIANT_JACKPOT_SYMBOLS order (gameking rarest, cherry commonest):
 *   gameking 1, bar 2, watermelon 3, bell 4, brinjal 5, orange 6, cherry 7
 *   (28 weight units per window, four independent windows).
 *
 * Settlement pays the best matching row only, using the precedence already
 * encoded in ROW_RANK:
 *   payout_points = floor(stake_points * base_amount / GIANT_JACKPOT_STAKE_SCALE).
 *
 * Enumerating all 7^4 weighted window combinations under best-row precedence
 * (weights out of 28^4 = 614,656) gives, per round:
 *   gameking         1/614656 -> 0.00000163 x 500 = 0.00081346
 *   three_cap      108/614656 -> 0.00017571 x 250 = 0.04392701
 *   all_bar         16/614656 -> 0.00002603 x 250 = 0.00650771
 *   all_watermelon  81/614656 -> 0.00013178 x 100 = 0.01317810
 *   all_bell       256/614656 -> 0.00041649 x  50 = 0.02082466
 *   all_brinjal    625/614656 -> 0.00101683 x  40 = 0.04067316
 *   all_orange    1296/614656 -> 0.00210850 x  30 = 0.06325489
 *   two_cap       4374/614656 -> 0.00711618 x  25 = 0.17790439
 *   all_cherry    2401/614656 -> 0.00390625 x  25 = 0.09765625
 *   three_bar      832/614656 -> 0.00135360 x  20 = 0.02707205
 *   three_waterm. 2700/614656 -> 0.00439270 x  20 = 0.08785402
 *   three_bell    6144/614656 -> 0.00999584 x  18 = 0.17992503
 *   three_brinjal 11500/614656 -> 0.01870965 x 14 = 0.26193513
 *   three_orange  19008/614656 -> 0.03092461 x 10 = 0.30924615
 *   three_cherry  28812/614656 -> 0.04687500 x  8 = 0.37500000
 *   two_cherry   129360/614656 -> 0.21045918 x  5 = 1.05229592
 *   one_cap       30240/614656 -> 0.04919825 x  3 = 0.14759475
 *   one_cherry   245280/614656 -> 0.39905248 x  2 = 0.79810496
 *   no row       131622/614656 -> 0.21413929 x  0 = 0
 *   expected base amount                            = 3.70376764
 * Any round with a matching row occurs with probability 0.78586071.
 *
 * The eighteen base amounts are NOT rescaled — fifteen of them are real client
 * constants and must stay verbatim.  The whole ladder is instead scaled by the
 * one house-declared divisor, which is mathematically identical to scaling
 * every row by the same k and leaves hit frequency and volatility untouched:
 *   GIANT_JACKPOT_STAKE_SCALE = 3.70376764 / 0.90 = 4.115297  (was 4)
 * Expected return
 *   = 3.70376764 / 4.115297
 *   = 0.90000008  ->  90.00% return, 10.00% house edge
 * (the residual 8e-8 is the six-decimal-place rounding of the divisor; realized
 * return is a shade lower again because the per-round floor discards
 * fractions).
 */
export const GIANT_JACKPOT_REEL_WEIGHTS: readonly number[] = Object.freeze([1, 2, 3, 4, 5, 6, 7]);

export const GIANT_JACKPOT_STAKE_SCALE = 4.115297;

const DECLARED_BASE_AMOUNTS: Readonly<Record<GiantJackpotRow, number>> = Object.freeze({
  ...PUBLISHED_BASE_AMOUNTS,
  // Client-unpriced cap rows, declared by MyDGP for ruleset v1.
  three_cap: 250,
  two_cap: 25,
  one_cap: 3,
} as Record<GiantJackpotRow, number>);

export function generateGiantJackpotOutcome(entropy: ServerEntropy): GiantJackpotOutcome {
  const total = GIANT_JACKPOT_REEL_WEIGHTS.reduce((sum, weight) => sum + weight, 0);
  const spin = (): GiantJackpotSymbol => {
    let roll = entropyIndex(entropy, total, "giant jackpot window");
    for (let index = 0; index < GIANT_JACKPOT_SYMBOLS.length; index++) {
      roll -= GIANT_JACKPOT_REEL_WEIGHTS[index];
      if (roll < 0) return GIANT_JACKPOT_SYMBOLS[index];
    }
    return GIANT_JACKPOT_SYMBOLS[GIANT_JACKPOT_SYMBOLS.length - 1];
  };
  // Round-tripped through the module's own validator so a generated spin can
  // never be looser than a spin arriving off the wire.
  return validateGiantJackpotOutcome({ windows: [spin(), spin(), spin(), spin()] });
}

export function settleGiantJackpot(
  selection: GiantJackpotSelection,
  stakePoints: number,
  outcome: GiantJackpotOutcome,
): SettlementResult {
  const stake = virtualPointStake(stakePoints);
  const best = inspectGiantJackpotOutcome(outcome, selection).best_candidate_row;
  const base = best === null ? 0 : DECLARED_BASE_AMOUNTS[best] ?? 0;
  const payout = Math.floor((stake * base) / GIANT_JACKPOT_STAKE_SCALE);
  return Object.freeze({
    stake_points: stake,
    payout_points: payout,
    net_points: payout - stake,
  });
}

export const GIANT_JACKPOT_RESOLVER: ReviewResolverModule<
  GiantJackpotSelection,
  GiantJackpotOutcome,
  GiantJackpotInspection
> = Object.freeze({
  manifest: Object.freeze({
    catalog_slug: "giant-jackpot",
    module_id: "giant-jackpot-review-v1",
    live_resolver_id: "giant-jackpot-v1",
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
        "MyDGP declared ruleset v1. payout_points is the full virtual-point amount credited back, stake included: floor(stake * base_amount / 4.115297) on the best matching row only. The fifteen base amounts are real client constants and stay verbatim; the three GameKing cap rows (250/25/3), the 1..7 reel weights and the 4.115297-point stake scale are MyDGP house values. The stake scale is the tuned quantity — it was 4, and dividing the same ladder by 3.70376764/0.90 instead moves the whole table to the operator's target without touching a client constant. Expected return 3.70376764/4.115297 = 0.90000 (10.00% house edge).",
    }),
    blockers: Object.freeze([]),
    evidence: Object.freeze([
      "chakri-unity/Assets/Scripts/Engines/GiantJackpotLadder.cs",
      "chakri-unity/docs/evidence/fixnotes/giant-jackpot.md",
      "chakri-unity/docs/prep/giant-jackpot-observation.md",
    ]),
  }),
  normalizeSelection: normalizeGiantJackpotSelection,
  validateOutcome: validateGiantJackpotOutcome,
  inspectOutcome: inspectGiantJackpotOutcome,
  generateOutcome: generateGiantJackpotOutcome,
  settle: settleGiantJackpot,
  deterministicVectors: Object.freeze([
    Object.freeze({
      name: "four-bars-use-published-row",
      input: Object.freeze({ windows: Object.freeze(["bar", "bar", "bar", "bar"]) }),
      expected: Object.freeze({ best_candidate_row: "all_bar", published_base_amount: 250, payout_points: null }),
    }),
    Object.freeze({
      name: "three-gameking-is-explicitly-unpriced",
      input: Object.freeze({ windows: Object.freeze(["gameking", "gameking", "gameking", "orange"]) }),
      expected: Object.freeze({ best_candidate_row: "three_cap", published_base_amount: null, payout_points: null }),
    }),
  ]),
});
