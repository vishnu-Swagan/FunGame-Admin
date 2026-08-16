import {
  exactKeys,
  ResolverInputError,
  type ReviewResolverModule,
  type ServerEntropy,
  type SettlementResult,
  virtualPointStake,
} from "./resolver-contract.ts";
import { entropyIndex } from "./cards.ts";

export type RouletteBetType =
  | "straight"
  | "sector"
  | "split"
  | "street"
  | "corner"
  | "sixline"
  | "basket"
  | "color"
  | "parity"
  | "range"
  | "dozen"
  | "column";

export type RouletteSelection = Readonly<{
  type: RouletteBetType;
  value: string;
  canonical: string;
  covered_pockets: readonly string[];
}>;

export type RouletteOutcome = Readonly<{
  kind: "american_roulette";
  pocket: string;
  color: "red" | "black" | "green";
}>;

export type RouletteInspection = Readonly<{
  matched: boolean;
  payout_points: null;
  note: string;
}>;

export const ROULETTE_WHEEL_ORDER = Object.freeze([
  "0", "28", "9", "26", "30", "11", "7", "20", "32", "17", "5", "22", "34", "15", "3", "24", "36", "13", "1",
  "00", "27", "10", "25", "29", "12", "8", "19", "31", "18", "6", "21", "33", "16", "4", "23", "35", "14", "2",
]);
const POCKETS = new Set(ROULETTE_WHEEL_ORDER);
const REDS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const GRID = Object.freeze([
  Object.freeze([3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 33, 36]),
  Object.freeze([2, 5, 8, 11, 14, 17, 20, 23, 26, 29, 32, 35]),
  Object.freeze([1, 4, 7, 10, 13, 16, 19, 22, 25, 28, 31, 34]),
]);

function pocketNumber(label: string): number {
  if (label === "00") return 100;
  if (!/^(?:0|[1-9]|[12][0-9]|3[0-6])$/.test(label)) {
    throw new ResolverInputError("INVALID_SELECTION", "Roulette pocket is invalid.");
  }
  return Number(label);
}

export function canonicalRoulettePocketList(value: string): string {
  const labels = value.split("-");
  if (labels.length < 1 || labels.some((label) => label.length === 0)) {
    throw new ResolverInputError("INVALID_SELECTION", "Roulette bet numbers are required.");
  }
  labels.forEach(pocketNumber);
  if (new Set(labels).size !== labels.length) {
    throw new ResolverInputError("INVALID_SELECTION", "Roulette bet numbers must be distinct.");
  }
  return labels.sort((a, b) => pocketNumber(a) - pocketNumber(b)).join("-");
}

type InsideShape = Readonly<{ size: number; legal: ReadonlySet<string> }>;

function buildInsideShapes(): Readonly<Record<string, InsideShape>> {
  const split = new Set<string>();
  const street = new Set<string>();
  const corner = new Set<string>();
  const sixline = new Set<string>();
  const key = (values: readonly number[]) => canonicalRoulettePocketList(values.join("-"));
  for (let row = 0; row < 3; row++) {
    for (let column = 0; column < 12; column++) {
      const number = GRID[row][column];
      if (column > 0) split.add(key([GRID[row][column - 1], number]));
      if (row < 2) split.add(key([number, GRID[row + 1][column]]));
      if (column > 0 && row < 2) {
        corner.add(key([
          GRID[row][column - 1], number,
          GRID[row + 1][column - 1], GRID[row + 1][column],
        ]));
      }
    }
  }
  for (let column = 0; column < 12; column++) {
    street.add(key([GRID[0][column], GRID[1][column], GRID[2][column]]));
    if (column > 0) {
      sixline.add(key([
        GRID[0][column - 1], GRID[1][column - 1], GRID[2][column - 1],
        GRID[0][column], GRID[1][column], GRID[2][column],
      ]));
    }
  }
  // Only zero-end placements whose meaning is invariant under the unresolved
  // 0/00 vertical ordering are admitted by this review validator.
  split.add(canonicalRoulettePocketList("0-00"));
  split.add(canonicalRoulettePocketList("0-2"));
  split.add(canonicalRoulettePocketList("00-2"));
  return Object.freeze({
    split: Object.freeze({ size: 2, legal: split }),
    street: Object.freeze({ size: 3, legal: street }),
    corner: Object.freeze({ size: 4, legal: corner }),
    sixline: Object.freeze({ size: 6, legal: sixline }),
    basket: Object.freeze({
      size: 5,
      legal: new Set([canonicalRoulettePocketList("0-00-1-2-3")]),
    }),
  });
}

const INSIDE = buildInsideShapes();
const AMBIGUOUS_ZERO_END = new Set([
  ["split", "0-3"], ["split", "00-3"], ["split", "0-1"], ["split", "00-1"],
  ["street", "0-2-3"], ["street", "00-2-3"], ["street", "0-1-2"], ["street", "00-1-2"],
].map(([type, value]) => `${type}:${canonicalRoulettePocketList(value)}`));
const SECTORS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  zeroside: Object.freeze(ROULETTE_WHEEL_ORDER.slice(0, 19)),
  dzeroside: Object.freeze(ROULETTE_WHEEL_ORDER.slice(19)),
  zeroneighbours: Object.freeze(["0", "00", "2", "28", "1", "27"]),
});

function colorFor(pocket: string): "red" | "black" | "green" {
  if (!POCKETS.has(pocket)) throw new ResolverInputError("INVALID_OUTCOME", "Roulette outcome pocket is invalid.");
  if (pocket === "0" || pocket === "00") return "green";
  return REDS.has(Number(pocket)) ? "red" : "black";
}

function outsidePockets(type: RouletteBetType, value: string): readonly string[] {
  const numbered = Array.from({ length: 36 }, (_, index) => index + 1);
  switch (type) {
    case "color":
      if (value !== "red" && value !== "black") break;
      return numbered.filter((number) => (REDS.has(number) ? "red" : "black") === value).map(String);
    case "parity":
      if (value !== "odd" && value !== "even") break;
      return numbered.filter((number) => (number % 2 === 0 ? "even" : "odd") === value).map(String);
    case "range":
      if (value === "low") return numbered.slice(0, 18).map(String);
      if (value === "high") return numbered.slice(18).map(String);
      break;
    case "dozen":
      if (/^[123]$/.test(value)) {
        const start = (Number(value) - 1) * 12 + 1;
        return Array.from({ length: 12 }, (_, index) => String(start + index));
      }
      break;
    case "column":
      if (/^[123]$/.test(value)) {
        const column = Number(value);
        return numbered.filter((number) => ((number - 1) % 3) + 1 === column).map(String);
      }
      break;
  }
  throw new ResolverInputError("INVALID_SELECTION", "Roulette outside bet is invalid.");
}

export function normalizeFunRouletteSelection(input: unknown): RouletteSelection {
  if (typeof input !== "string" || input.trim() !== input) {
    throw new ResolverInputError("INVALID_SELECTION", "Roulette selection must be a canonical type:value string.");
  }
  const separator = input.indexOf(":");
  if (separator < 1 || separator !== input.lastIndexOf(":") || separator === input.length - 1) {
    throw new ResolverInputError("INVALID_SELECTION", "Roulette selection needs exactly one type and value.");
  }
  const type = input.slice(0, separator) as RouletteBetType;
  const rawValue = input.slice(separator + 1);
  if (type === "straight") {
    if (!POCKETS.has(rawValue)) throw new ResolverInputError("INVALID_SELECTION", "Roulette straight pocket is invalid.");
    return Object.freeze({ type, value: rawValue, canonical: input, covered_pockets: Object.freeze([rawValue]) });
  }
  if (type === "sector") {
    if (!Object.hasOwn(SECTORS, rawValue)) {
      throw new ResolverInputError("INVALID_SELECTION", "Roulette sector is invalid.");
    }
    const pockets = SECTORS[rawValue];
    return Object.freeze({ type, value: rawValue, canonical: input, covered_pockets: pockets });
  }
  if (Object.hasOwn(INSIDE, type)) {
    const value = canonicalRoulettePocketList(rawValue);
    const canonical = `${type}:${value}`;
    if (AMBIGUOUS_ZERO_END.has(canonical)) {
      throw new ResolverInputError("INVALID_SELECTION", "This zero-end placement is withheld until 0/00 geometry is reconciled.");
    }
    const shape = INSIDE[type];
    const pockets = value.split("-");
    if (pockets.length !== shape.size || !shape.legal.has(value)) {
      throw new ResolverInputError("INVALID_SELECTION", `That is not a verified ${type} placement.`);
    }
    return Object.freeze({ type, value, canonical, covered_pockets: Object.freeze(pockets) });
  }
  if (["color", "parity", "range", "dozen", "column"].includes(type)) {
    const pockets = outsidePockets(type, rawValue);
    return Object.freeze({ type, value: rawValue, canonical: input, covered_pockets: Object.freeze(pockets) });
  }
  throw new ResolverInputError("INVALID_SELECTION", "Roulette bet type is invalid.");
}

export function funRouletteStake(input: unknown): number {
  const stake = virtualPointStake(input, 5000);
  if (stake < 5) throw new ResolverInputError("INVALID_STAKE", "Fun Roulette requires at least 5 virtual points.");
  return stake;
}

export function validateFunRouletteOutcome(input: unknown): RouletteOutcome {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ResolverInputError("INVALID_OUTCOME", "Roulette requires a server pocket outcome object.");
  }
  const record = input as Record<string, unknown>;
  exactKeys(record, ["kind", "pocket", "color"], "INVALID_OUTCOME");
  if (record.kind !== "american_roulette" || typeof record.pocket !== "string") {
    throw new ResolverInputError("INVALID_OUTCOME", "Roulette outcome kind or pocket is invalid.");
  }
  const color = colorFor(record.pocket);
  if (record.color !== color) {
    throw new ResolverInputError("INVALID_OUTCOME", "Roulette outcome color does not match its pocket.");
  }
  return Object.freeze({ kind: "american_roulette", pocket: record.pocket, color });
}

export function inspectFunRouletteOutcome(
  outcome: RouletteOutcome,
  selection: RouletteSelection,
): RouletteInspection {
  return Object.freeze({
    matched: selection.covered_pockets.includes(outcome.pocket),
    payout_points: null,
    note: "Coverage is deterministic, but the client server-driven payout ladder and rounding protocol are not recovered.",
  });
}

/**
 * Operator-declared ruleset v1 house paytable (TOTAL_RETURN multipliers).
 *
 * The American wheel has 38 equally likely pockets (0, 00, 1-36), so for any
 * position the expected return is  multiplier x covered_pockets / 38.  Every
 * price below is m = 0.90 x 38 / n, which puts the whole felt on one 90%
 * return and leaves no position better value than another.
 *
 *   straight  1 pocket   x34.2  : 34.2 x  1/38 = 0.90 -> 90.00% (edge 10.00%)
 *   split     2 pockets  x17.1  : 17.1 x  2/38 = 0.90 -> 90.00% (edge 10.00%)
 *   street    3 pockets  x11.4  : 11.4 x  3/38 = 0.90 -> 90.00% (edge 10.00%)
 *   corner    4 pockets  x8.55  :  8.55 x 4/38 = 0.90 -> 90.00% (edge 10.00%)
 *   basket    5 pockets  x6.84  :  6.84 x 5/38 = 0.90 -> 90.00% (edge 10.00%)
 *   sixline   6 pockets  x5.7   :  5.7 x  6/38 = 0.90 -> 90.00% (edge 10.00%)
 *   dozen    12 pockets  x2.85  :  2.85 x 12/38 = 0.90 -> 90.00% (edge 10.00%)
 *   column   12 pockets  x2.85  :  2.85 x 12/38 = 0.90 -> 90.00% (edge 10.00%)
 *   color    18 pockets  x1.9   :  1.9 x 18/38 = 0.90 -> 90.00% (edge 10.00%)
 *   parity   18 pockets  x1.9   :  1.9 x 18/38 = 0.90 -> 90.00% (edge 10.00%)
 *   range    18 pockets  x1.9   :  1.9 x 18/38 = 0.90 -> 90.00% (edge 10.00%)
 *
 * The three wheel sectors are priced from their own covered-pocket count with
 * the same formula:
 *   sector zeroneighbours      6 pockets x5.7 : 5.7 x  6/38 = 0.90 -> 90.00%
 *   sector zeroside/dzeroside 19 pockets x1.8 : 1.8 x 19/38 = 0.90 -> 90.00%
 *
 * Note the classic 5-number basket is repriced from the traditional 7x down to
 * 6.84x so that it holds the same 10% as the rest of the felt.
 */
const ROULETTE_HOUSE_MULTIPLIERS: Readonly<Record<Exclude<RouletteBetType, "sector">, number>> = Object.freeze({
  straight: 34.2,
  split: 17.1,
  street: 11.4,
  corner: 8.55,
  basket: 6.84,
  sixline: 5.7,
  dozen: 2.85,
  column: 2.85,
  color: 1.9,
  parity: 1.9,
  range: 1.9,
});

const ROULETTE_SECTOR_MULTIPLIERS: Readonly<Record<number, number>> = Object.freeze({
  6: 5.7,
  19: 1.8,
});

export function funRouletteHouseMultiplier(selection: RouletteSelection): number {
  if (selection.type === "sector") {
    const multiplier = ROULETTE_SECTOR_MULTIPLIERS[selection.covered_pockets.length];
    if (multiplier === undefined) {
      throw new ResolverInputError("INVALID_SELECTION", "Roulette sector has no ruleset v1 price.");
    }
    return multiplier;
  }
  return ROULETTE_HOUSE_MULTIPLIERS[selection.type];
}

export function generateFunRouletteOutcome(entropy: ServerEntropy): RouletteOutcome {
  const pocket = ROULETTE_WHEEL_ORDER[
    entropyIndex(entropy, ROULETTE_WHEEL_ORDER.length, "roulette pocket")
  ];
  return validateFunRouletteOutcome({
    kind: "american_roulette",
    pocket,
    color: colorFor(pocket),
  });
}

export function settleFunRoulette(
  selection: RouletteSelection,
  stakePoints: number,
  outcome: RouletteOutcome,
): SettlementResult {
  const position = normalizeFunRouletteSelection(selection.canonical);
  const stake = funRouletteStake(stakePoints);
  const payout = position.covered_pockets.includes(outcome.pocket)
    ? Math.floor(stake * funRouletteHouseMultiplier(position))
    : 0;
  return Object.freeze({
    stake_points: stake,
    payout_points: payout,
    net_points: payout - stake,
  });
}

export const FUN_ROULETTE_RESOLVER: ReviewResolverModule<RouletteSelection, RouletteOutcome, RouletteInspection> =
  Object.freeze({
    manifest: Object.freeze({
      catalog_slug: "fun-roulette",
      module_id: "fun-roulette-review-v1",
      live_resolver_id: "fun-roulette-v1",
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
        bet_seconds: 45,
        lock_seconds: 11,
        reveal_seconds: 11,
        result_seconds: 4,
        note: "Operator-declared ruleset v1 round cadence: 45s betting, 11s lock, 11s reveal, 4s result.",
      }),
      settlement: Object.freeze({
        status: "VERIFIED",
        unit: "VIRTUAL_POINTS",
        payout_semantics: "TOTAL_RETURN",
        note: "Operator-declared ruleset v1 house paytable in total returned virtual points: straight 34.2x, split 17.1x, street 11.4x, corner 8.55x, basket 6.84x, sixline 5.7x, dozen/column 2.85x, colour/parity/range 1.9x, 6-pocket sector 5.7x, 19-pocket sector 1.8x, each floored to whole points.",
      }),
      blockers: Object.freeze([]),
      evidence: Object.freeze([
        "chakri-unity/docs/prep/roulette-observation.md",
        "chakri-unity/Assets/Scripts/Engines/Roulette.cs",
        "FunGame-Admin/docs/LIVE_GAME_PARITY_READINESS_AUDIT.md",
      ]),
    }),
    normalizeSelection: normalizeFunRouletteSelection,
    validateOutcome: validateFunRouletteOutcome,
    inspectOutcome: inspectFunRouletteOutcome,
    generateOutcome: generateFunRouletteOutcome,
    settle: settleFunRoulette,
    deterministicVectors: Object.freeze([
      Object.freeze({
        name: "regular-grid-split-coverage",
        input: Object.freeze({ selection: "split:3-2", outcome: Object.freeze({ pocket: "2", color: "black" }) }),
        expected: Object.freeze({ canonical: "split:2-3", matched: true, payout_points: null }),
      }),
      Object.freeze({
        name: "double-zero-pocket-is-distinct",
        input: Object.freeze({ selection: "straight:00", outcome: Object.freeze({ pocket: "0", color: "green" }) }),
        expected: Object.freeze({ matched: false, payout_points: null }),
      }),
    ]),
  });
