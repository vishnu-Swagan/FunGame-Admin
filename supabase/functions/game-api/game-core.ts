/**
 * Pure game-runtime contract shared by the `game-api` Edge Function and its
 * focused tests.  It deliberately has no database, HTTP, privileged key, or
 * player-balance dependency.
 *
 * Source of truth for this map is the Unity cabinet implementation:
 *   - Assets/Scripts/Runtime/GameScenes.cs
 *   - Assets/Scripts/Engines/Rounds.cs
 *   - Assets/Scripts/Engines/Roulette.cs
 *   - Assets/Scripts/Engines/Tables.cs
 *
 * A deterministic helper does not mean that a game is eligible to launch.
 * `parity_state` and `blocked_reason` are enforced by the database/Edge layer;
 * the helpers below refuse settlement when the exact client payment rule is
 * not available.
 */

export type RuntimeMode = "CLOCKED_SHARED" | "PLAYER_PACED";
export type ParityState = "BLOCKED" | "DERIVED" | "QA_VERIFIED";
/**
 * Verbs exposed on the Unity wire.  These names are intentionally distinct
 * from the database action enum: a client never needs to know an internal
 * ledger-operation name such as `STAKE` or `UNDO`.
 */
export type PlayerAction =
  | "place_bet"
  | "clear_bets"
  | "cancel_bet"
  | "repeat_bets"
  | "collect_full"
  | "collect_half"
  | "deal"
  | "hold"
  | "release"
  | "cash_out"
  | "gamble";
export type InternalAction =
  | "stake"
  | "clear"
  | "undo"
  | "repeat"
  | "collect"
  | "deal"
  | "set_hold"
  | "cash_out"
  | "gamble";
export type PublicPhase = "BETTING" | "REVEAL" | "RESULT";

export type Timing = {
  kind: string;
  bet_seconds: number | null;
  lock_seconds: number | null;
  reveal_seconds: number | null;
  result_seconds: number | null;
  hold_on_win?: boolean;
  idle_variant?: {
    reveal_seconds: number;
    result_seconds: number;
  };
};

export type GameSpec = {
  catalog_slug: string;
  unity_lobby_slug: string;
  unity_scene: string;
  engine_slug: string;
  runtime_mode: RuntimeMode;
  parity_state: ParityState;
  timing: Timing;
  actions: readonly PlayerAction[];
  min_bet: number;
  max_bet: number;
  outcome_kind: string;
  rule_source: string;
  blocked_reason: string | null;
};

export class GameRuleError extends Error {
  readonly code:
    | "UNKNOWN_GAME"
    | "UNSUPPORTED_ACTION"
    | "INVALID_SELECTION"
    | "INVALID_STAKE"
    | "RULES_NOT_VERIFIED"
    | "OUTCOME_NOT_IMPLEMENTED"
    | "INVALID_OUTCOME";

  constructor(
    code: GameRuleError["code"],
    message: string,
  ) {
    super(message);
    this.code = code;
  }
}

const CLOCKED = (timing: Timing) => timing;
const PLAYER_PACED = (revealSeconds = 4): Timing => ({
  kind: "player_paced",
  bet_seconds: null,
  lock_seconds: null,
  reveal_seconds: revealSeconds,
  result_seconds: null,
});

/** The public catalog is intentionally exactly 16 entries. */
export const GAME_SPECS: readonly GameSpec[] = Object.freeze([
  {
    catalog_slug: "7up7down",
    unity_lobby_slug: "seven-up-down",
    unity_scene: "seven-up-down",
    engine_slug: "seven-up-down",
    runtime_mode: "CLOCKED_SHARED",
    parity_state: "DERIVED",
    timing: CLOCKED({
      kind: "sides",
      bet_seconds: 15,
      lock_seconds: 1,
      reveal_seconds: 15,
      result_seconds: 11,
      hold_on_win: true,
      idle_variant: { reveal_seconds: 0, result_seconds: 10 },
    }),
    actions: ["place_bet", "clear_bets", "cancel_bet", "repeat_bets", "collect_full", "collect_half"],
    min_bet: 5,
    max_bet: 1000,
    outcome_kind: "card_window",
    rule_source: "Unity Rounds.cs + SevenUpDown.cs",
    blocked_reason:
      "Shared-round launch requires review of client-specific idle cadence and held-win collection.",
  },
  {
    catalog_slug: "fun-ab",
    unity_lobby_slug: "fun-ab",
    unity_scene: "andar-bahar",
    engine_slug: "andar-bahar",
    runtime_mode: "CLOCKED_SHARED",
    parity_state: "BLOCKED",
    timing: CLOCKED({
      kind: "sides",
      bet_seconds: 36,
      lock_seconds: 6,
      reveal_seconds: 2,
      result_seconds: 5,
    }),
    actions: ["place_bet", "clear_bets", "cancel_bet", "repeat_bets", "collect_full", "collect_half"],
    min_bet: 10,
    max_bet: 10000,
    outcome_kind: "andar_bahar",
    rule_source: "Unity GameScenes.cs + Rounds.cs + Tables.cs (AndarBahar)",
    blocked_reason: "Side/rank payouts are not completely observed.",
  },
  {
    catalog_slug: "triple-fun",
    unity_lobby_slug: "triple-fun",
    unity_scene: "triple-fun",
    engine_slug: "triple-fun",
    runtime_mode: "CLOCKED_SHARED",
    parity_state: "BLOCKED",
    timing: CLOCKED({
      kind: "three_digits",
      bet_seconds: 60,
      lock_seconds: 5,
      reveal_seconds: 5,
      result_seconds: 3,
    }),
    actions: ["place_bet", "clear_bets", "cancel_bet", "repeat_bets", "collect_full", "collect_half"],
    min_bet: 5,
    max_bet: 5000,
    outcome_kind: "three_digit_draw",
    rule_source: "Unity Rounds.cs + Tables.cs (TripleFun)",
    blocked_reason: "The client round cadence was not recovered from the source.",
  },
  {
    catalog_slug: "fun-roulette",
    unity_lobby_slug: "roulette",
    unity_scene: "fun-roulette",
    engine_slug: "fun-roulette",
    runtime_mode: "CLOCKED_SHARED",
    parity_state: "DERIVED",
    timing: CLOCKED({
      kind: "board",
      bet_seconds: 45,
      lock_seconds: 11,
      reveal_seconds: 11,
      result_seconds: 4,
      hold_on_win: true,
    }),
    actions: ["place_bet", "clear_bets", "cancel_bet", "repeat_bets", "collect_full", "collect_half"],
    min_bet: 5,
    max_bet: 5000,
    outcome_kind: "american_roulette",
    rule_source: "Unity Roulette.cs + Rounds.cs + RouletteFeltTargets.cs",
    blocked_reason:
      "Zero-end touch geometry and the current engine whitelist conflict for two physical splits.",
  },
  {
    catalog_slug: "fun-target",
    unity_lobby_slug: "fun-target",
    unity_scene: "fun-target",
    engine_slug: "fun-target",
    runtime_mode: "CLOCKED_SHARED",
    parity_state: "BLOCKED",
    timing: CLOCKED({
      kind: "pick",
      bet_seconds: 51,
      lock_seconds: 11,
      reveal_seconds: 5,
      result_seconds: 3,
    }),
    actions: ["place_bet", "clear_bets", "cancel_bet", "repeat_bets", "collect_full", "collect_half"],
    min_bet: 5,
    max_bet: 5000,
    outcome_kind: "digit_wheel",
    rule_source: "Unity Rounds.cs + Tables.cs (FunTarget)",
    blocked_reason: "The client payout is explicitly unobserved; Unity's 9x is an inference.",
  },
  {
    catalog_slug: "bingo",
    unity_lobby_slug: "bingo",
    unity_scene: "bingo",
    engine_slug: "bingo",
    runtime_mode: "CLOCKED_SHARED",
    parity_state: "BLOCKED",
    timing: CLOCKED({
      kind: "stake",
      bet_seconds: 60,
      lock_seconds: 5,
      reveal_seconds: 6,
      result_seconds: 4,
    }),
    actions: ["place_bet", "clear_bets", "cancel_bet", "repeat_bets", "collect_full", "collect_half"],
    min_bet: 5,
    max_bet: 1000,
    outcome_kind: "fixed_six_cards",
    rule_source: "Unity Rounds.cs + Tables.cs (Bingo)",
    blocked_reason: "The payout behavior is not complete enough for production settlement.",
  },
  {
    catalog_slug: "joker-bonus",
    unity_lobby_slug: "joker-bonus",
    unity_scene: "fever-joker",
    engine_slug: "joker-bonus",
    runtime_mode: "PLAYER_PACED",
    parity_state: "BLOCKED",
    timing: PLAYER_PACED(),
    actions: ["place_bet", "clear_bets", "deal", "hold", "release", "collect_full", "collect_half", "gamble"],
    min_bet: 5,
    max_bet: 1000,
    outcome_kind: "joker_poker",
    rule_source: "Unity GameScenes.cs + ChampionTable.cs",
    blocked_reason: "Double-up and hold settlement need complete client evidence.",
  },
  {
    catalog_slug: "giant-jackpot",
    unity_lobby_slug: "giant-jackpot",
    unity_scene: "giant-jackpot",
    engine_slug: "giant-jackpot",
    runtime_mode: "CLOCKED_SHARED",
    parity_state: "BLOCKED",
    timing: CLOCKED({
      kind: "stake",
      bet_seconds: 60,
      lock_seconds: 5,
      reveal_seconds: 5,
      result_seconds: 3,
    }),
    actions: ["place_bet", "clear_bets", "cancel_bet", "repeat_bets", "collect_full", "collect_half"],
    min_bet: 10,
    max_bet: 1000,
    outcome_kind: "four_window_ladder",
    rule_source: "Unity GiantJackpotLadder.cs + Rounds.cs",
    blocked_reason: "Reel weights, payout scale, and cap-row behavior are incomplete.",
  },
  {
    catalog_slug: "golden-wheel",
    unity_lobby_slug: "golden-wheel",
    unity_scene: "super-golden-wheel",
    engine_slug: "super-golden-wheel",
    runtime_mode: "CLOCKED_SHARED",
    parity_state: "BLOCKED",
    timing: CLOCKED({
      kind: "stake",
      bet_seconds: 60,
      lock_seconds: 5,
      reveal_seconds: 5,
      result_seconds: 3,
    }),
    actions: ["place_bet", "clear_bets", "cancel_bet", "repeat_bets", "collect_full", "collect_half"],
    min_bet: 5,
    max_bet: 1000,
    outcome_kind: "multiplier_wheel",
    rule_source: "Unity Rounds.cs + Tables.cs (GoldenWheel)",
    blocked_reason: "Segment weights/multiplier distribution need client-server parity confirmation.",
  },
  {
    catalog_slug: "keno",
    unity_lobby_slug: "keno",
    unity_scene: "keno",
    engine_slug: "keno",
    runtime_mode: "CLOCKED_SHARED",
    parity_state: "BLOCKED",
    timing: CLOCKED({
      kind: "picks",
      bet_seconds: 60,
      lock_seconds: 5,
      reveal_seconds: 6,
      result_seconds: 4,
    }),
    actions: ["place_bet", "clear_bets", "cancel_bet", "repeat_bets", "collect_full", "collect_half"],
    min_bet: 5,
    max_bet: 1000,
    outcome_kind: "keno_80_of_20",
    rule_source: "Unity Rounds.cs + Tables.cs (Keno)",
    blocked_reason: "The client paytable is explicitly unobserved.",
  },
  {
    catalog_slug: "checker",
    unity_lobby_slug: "checker",
    unity_scene: "checker",
    engine_slug: "checker",
    runtime_mode: "PLAYER_PACED",
    parity_state: "DERIVED",
    timing: PLAYER_PACED(6),
    actions: ["place_bet", "clear_bets", "cancel_bet", "deal", "collect_full", "collect_half", "gamble"],
    min_bet: 5,
    max_bet: 1000,
    outcome_kind: "two_ring_checker",
    rule_source: "Unity CheckerTable.cs + Tables.cs (Checker)",
    blocked_reason: "The ODD/EVEN double-up branch must remain closed until confirmed.",
  },
  {
    catalog_slug: "lucky-8-line",
    unity_lobby_slug: "lucky8line",
    unity_scene: "lucky-8-line",
    engine_slug: "lucky-8-line",
    // Single-player, not a shared clocked round: level10 ships no timer
    // object, so there is no betting window to share. The 60/5/5/3 schedule
    // here was a shared default, never a measurement. This must stay in step
    // with the resolver manifest, which also declares PLAYER_PACED; the two
    // lifecycles are mutually exclusive, so a disagreement leaves the title
    // unsettleable by either path.
    runtime_mode: "PLAYER_PACED",
    parity_state: "BLOCKED",
    timing: PLAYER_PACED(5),
    actions: ["place_bet", "clear_bets", "cancel_bet", "repeat_bets", "collect_full", "collect_half"],
    min_bet: 10,
    max_bet: 1000,
    outcome_kind: "eight_line_reel",
    rule_source: "Unity Reels.cs + Rounds.cs",
    blocked_reason: "Reel-weight and payout verification remain incomplete.",
  },
  {
    catalog_slug: "fever-joker-bonus",
    unity_lobby_slug: "fever-joker",
    unity_scene: "fever-joker-bonus",
    engine_slug: "fever-joker-bonus",
    runtime_mode: "PLAYER_PACED",
    parity_state: "BLOCKED",
    timing: PLAYER_PACED(),
    actions: ["place_bet", "clear_bets", "deal", "hold", "release", "collect_full", "collect_half", "gamble"],
    min_bet: 5,
    max_bet: 1000,
    outcome_kind: "joker_poker",
    rule_source: "Unity GameScenes.cs + ChampionTable.cs",
    blocked_reason: "Double-up and hold settlement need complete client evidence.",
  },
  {
    catalog_slug: "no-hold",
    unity_lobby_slug: "no-hold",
    unity_scene: "no-hold",
    engine_slug: "no-hold",
    runtime_mode: "PLAYER_PACED",
    parity_state: "DERIVED",
    timing: PLAYER_PACED(),
    actions: ["place_bet", "clear_bets", "deal", "collect_full", "collect_half"],
    min_bet: 5,
    max_bet: 1000,
    outcome_kind: "five_card_no_hold",
    rule_source: "Unity ChampionTable.cs + SevenUpDown.cs (NoHold)",
    blocked_reason: "Independent live settlement capture is required before launch.",
  },
  {
    catalog_slug: "champion-poker",
    unity_lobby_slug: "champion-poker",
    unity_scene: "champion-poker",
    engine_slug: "champion-poker",
    runtime_mode: "PLAYER_PACED",
    parity_state: "BLOCKED",
    timing: PLAYER_PACED(),
    actions: ["place_bet", "clear_bets", "deal", "hold", "release", "collect_full", "collect_half", "gamble"],
    min_bet: 5,
    max_bet: 1000,
    outcome_kind: "five_card_draw_poker",
    rule_source: "Unity ChampionTable.cs + SevenUpDown.cs (ChampionPoker)",
    blocked_reason: "The client double-up result is unobserved.",
  },
  {
    catalog_slug: "aviator",
    unity_lobby_slug: "aviator",
    unity_scene: "aviator",
    engine_slug: "aviator",
    runtime_mode: "PLAYER_PACED",
    parity_state: "DERIVED",
    timing: PLAYER_PACED(),
    actions: ["place_bet", "clear_bets", "collect_full"],
    min_bet: 5,
    max_bet: 1000,
    outcome_kind: "crash_flight",
    rule_source: "Unity Engines/AviatorTable.cs + Tables.cs (Aviator)",
    blocked_reason: null,
  },
]);

const gameBySlug = new Map(GAME_SPECS.map((spec) => [spec.catalog_slug, spec]));

/**
 * The static Edge bundle owns the complete runtime contract.  A database row
 * may carry operational state, but it must never be allowed to silently
 * redefine a cabinet's timing, outcome shape, stake limits, or ruleset.
 */
export const COMPILED_RUNTIME_RULESET_VERSION = 1;

export type RuntimeContractCandidate = {
  catalog_slug?: unknown;
  unity_lobby_slug?: unknown;
  unity_scene?: unknown;
  engine_slug?: unknown;
  runtime_mode?: unknown;
  timing?: unknown;
  action_contract?: unknown;
  outcome_contract?: unknown;
  ruleset_version?: unknown;
  min_bet?: unknown;
  max_bet?: unknown;
};

export type CompiledRuntimeContract = {
  catalog_slug: string;
  unity_lobby_slug: string;
  unity_scene: string;
  engine_slug: string;
  runtime_mode: RuntimeMode;
  timing: Timing;
  action_contract: readonly PlayerAction[];
  outcome_contract: Readonly<Record<string, string | number>>;
  ruleset_version: number;
  min_bet: number;
  max_bet: number;
};

const OUTCOME_CONTRACTS: Readonly<Record<string, Readonly<Record<string, string | number>>>> = Object.freeze({
  "7up7down": Object.freeze({ type: "card_window", selection: "seven|up|down" }),
  "fun-ab": Object.freeze({ type: "andar_bahar", selection: "named side or rank" }),
  "triple-fun": Object.freeze({ type: "three_digit_draw", selection: "single:N|double:NN|triple:NNN" }),
  "fun-roulette": Object.freeze({ type: "american_roulette", pockets: 38, selection: "type:value" }),
  "fun-target": Object.freeze({ type: "digit_wheel", selection: "number:0..9" }),
  "bingo": Object.freeze({ type: "fixed_six_cards", draw_count: 15 }),
  "joker-bonus": Object.freeze({ type: "joker_poker" }),
  "giant-jackpot": Object.freeze({ type: "four_window_ladder" }),
  "golden-wheel": Object.freeze({ type: "multiplier_wheel" }),
  "keno": Object.freeze({ type: "keno", pool: 80, draw_count: 20, max_picks: 10 }),
  "checker": Object.freeze({ type: "two_ring_checker", cells: 25 }),
  "lucky-8-line": Object.freeze({ type: "eight_line_reel" }),
  "fever-joker-bonus": Object.freeze({ type: "joker_poker" }),
  "no-hold": Object.freeze({ type: "five_card_no_hold" }),
  "champion-poker": Object.freeze({ type: "five_card_draw_poker" }),
  "aviator": Object.freeze({ type: "crash_flight" }),
});

function canonicalRuntimeJson(value: unknown): string | null {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? JSON.stringify(value) : null;
  }
  if (Array.isArray(value)) {
    const entries = value.map(canonicalRuntimeJson);
    return entries.some((entry) => entry === null) ? null : `[${entries.join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record).sort().map((key) => {
      const rendered = canonicalRuntimeJson(record[key]);
      return rendered === null ? null : `${JSON.stringify(key)}:${rendered}`;
    });
    return entries.some((entry) => entry === null) ? null : `{${entries.join(",")}}`;
  }
  return null;
}

function contractInteger(value: unknown): number | null {
  const parsed = typeof value === "number" ? value
    : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** Build the only runtime representation this deployed Edge bundle accepts. */
export function compiledRuntimeContractFor(spec: GameSpec): CompiledRuntimeContract {
  const outcome = OUTCOME_CONTRACTS[spec.catalog_slug];
  if (!outcome) throw new Error(`Missing static outcome contract for ${spec.catalog_slug}.`);
  return {
    catalog_slug: spec.catalog_slug,
    unity_lobby_slug: spec.unity_lobby_slug,
    unity_scene: spec.unity_scene,
    engine_slug: spec.engine_slug,
    runtime_mode: spec.runtime_mode,
    timing: spec.timing,
    action_contract: spec.actions,
    outcome_contract: outcome,
    ruleset_version: COMPILED_RUNTIME_RULESET_VERSION,
    min_bet: spec.min_bet,
    max_bet: spec.max_bet,
  };
}

/**
 * Return the first unsafe runtime field, or null only when the database row
 * exactly matches the compiled client/server contract.  JSON object key order
 * is intentionally irrelevant; array order (the Unity wire action order) is
 * intentionally significant.
 */
export function runtimeContractIssue(
  spec: GameSpec,
  runtime: RuntimeContractCandidate,
): string | null {
  const expected = compiledRuntimeContractFor(spec);
  if (runtime.catalog_slug !== expected.catalog_slug) return "catalog_slug";
  if (runtime.unity_lobby_slug !== expected.unity_lobby_slug) return "unity_lobby_slug";
  if (runtime.unity_scene !== expected.unity_scene) return "unity_scene";
  if (runtime.engine_slug !== expected.engine_slug) return "engine_slug";
  if (runtime.runtime_mode !== expected.runtime_mode) return "runtime_mode";
  if (canonicalRuntimeJson(runtime.timing) !== canonicalRuntimeJson(expected.timing)) return "timing";
  if (canonicalRuntimeJson(runtime.action_contract) !== canonicalRuntimeJson(expected.action_contract)) {
    return "action_contract";
  }
  if (canonicalRuntimeJson(runtime.outcome_contract) !== canonicalRuntimeJson(expected.outcome_contract)) {
    return "outcome_contract";
  }
  if (contractInteger(runtime.ruleset_version) !== expected.ruleset_version) return "ruleset_version";
  if (contractInteger(runtime.min_bet) !== expected.min_bet) return "min_bet";
  if (contractInteger(runtime.max_bet) !== expected.max_bet) return "max_bet";
  return null;
}

export function gameSpec(catalogSlug: string): GameSpec {
  const spec = gameBySlug.get(catalogSlug);
  if (!spec) throw new GameRuleError("UNKNOWN_GAME", "Unknown game catalog slug.");
  return spec;
}

export function assertGameMapIntegrity(): void {
  if (GAME_SPECS.length !== 16) {
    throw new Error(`Expected 16 game catalog entries, got ${GAME_SPECS.length}`);
  }
  const values = <K extends keyof GameSpec>(key: K) =>
    GAME_SPECS.map((spec) => String(spec[key]));
  for (const key of ["catalog_slug", "unity_lobby_slug", "unity_scene", "engine_slug"] as const) {
    const entries = values(key);
    if (new Set(entries).size !== entries.length) {
      throw new Error(`Game mapping contains a duplicate ${key}.`);
    }
  }
  for (const spec of GAME_SPECS) {
    if (
      !Number.isSafeInteger(spec.min_bet) || !Number.isSafeInteger(spec.max_bet) ||
      spec.min_bet < 1 || spec.max_bet < spec.min_bet || spec.max_bet > 2_147_483_647
    ) {
      throw new Error(`Invalid UI stake limits for ${spec.catalog_slug}.`);
    }
    if (spec.runtime_mode === "CLOCKED_SHARED") {
      const timing = spec.timing;
      if (
        !Number.isInteger(timing.bet_seconds) ||
        !Number.isInteger(timing.lock_seconds) ||
        !Number.isInteger(timing.reveal_seconds) ||
        !Number.isInteger(timing.result_seconds) ||
        (timing.bet_seconds || 0) < (timing.lock_seconds || 0)
      ) {
        throw new Error(`Invalid clocked timing for ${spec.catalog_slug}.`);
      }
    }
  }
}

export type ClockState = {
  round_number: number;
  phase: PublicPhase;
  phase_ends_at: string;
  server_time_unix_ms: number;
  phase_ends_at_unix_ms: number;
  phase_ends_in_ms: number;
  bets_open: boolean;
  starts_at: string;
  betting_closes_at: string;
  reveal_starts_at: string;
  result_starts_at: string;
  ends_at: string;
};

/**
 * Stable server clock fields consumed by Unity. The absolute timestamps are
 * epoch milliseconds generated by the server; clients must not derive either
 * one from a local timer or from the rounded remaining value.
 */
export type PublicClockWire = {
  phase: PublicPhase;
  bets_open: boolean;
  server_time_unix_ms: number;
  phase_ends_at_unix_ms: number;
  phase_ends_in: number;
};

export function publicClockWire(clock: ClockState): PublicClockWire {
  return {
    phase: clock.phase,
    bets_open: clock.bets_open === true,
    server_time_unix_ms: clock.server_time_unix_ms,
    phase_ends_at_unix_ms: clock.phase_ends_at_unix_ms,
    phase_ends_in: Math.max(0, Math.round((clock.phase_ends_in_ms / 1000) * 1000) / 1000),
  };
}

/**
 * Derive one global clock from server Unix time.  It is used only for a game
 * that has passed the database availability gate; a client clock is never an
 * input.  `epochMs` makes the pure logic deterministic for tests.
 */
export function clockState(
  spec: GameSpec,
  nowMs: number,
  epochMs = 0,
): ClockState {
  if (spec.runtime_mode !== "CLOCKED_SHARED") {
    throw new GameRuleError("OUTCOME_NOT_IMPLEMENTED", "This cabinet is player paced.");
  }
  const timing = spec.timing;
  const bet = timing.bet_seconds! * 1000;
  const reveal = timing.reveal_seconds! * 1000;
  const result = timing.result_seconds! * 1000;
  const cycle = bet + reveal + result;
  if (!Number.isFinite(nowMs) || !Number.isFinite(epochMs) || cycle <= 0) {
    throw new Error("A valid server time and cycle are required.");
  }
  const round = Math.floor((nowMs - epochMs) / cycle);
  const startsAt = epochMs + round * cycle;
  const bettingClosesAt = startsAt + bet - timing.lock_seconds! * 1000;
  const revealStartsAt = startsAt + bet;
  const resultStartsAt = revealStartsAt + reveal;
  const endsAt = resultStartsAt + result;
  const phase: PublicPhase = nowMs < revealStartsAt
    ? "BETTING"
    : nowMs < resultStartsAt
    ? "REVEAL"
    : "RESULT";
  const phaseEnd = phase === "BETTING"
    ? revealStartsAt
    : phase === "REVEAL"
    ? resultStartsAt
    : endsAt;
  return {
    round_number: round,
    phase,
    phase_ends_at: new Date(phaseEnd).toISOString(),
    server_time_unix_ms: nowMs,
    phase_ends_at_unix_ms: phaseEnd,
    phase_ends_in_ms: Math.max(0, phaseEnd - nowMs),
    bets_open: phase === "BETTING" && nowMs < bettingClosesAt,
    starts_at: new Date(startsAt).toISOString(),
    betting_closes_at: new Date(bettingClosesAt).toISOString(),
    reveal_starts_at: new Date(revealStartsAt).toISOString(),
    result_starts_at: new Date(resultStartsAt).toISOString(),
    ends_at: new Date(endsAt).toISOString(),
  };
}

/**
 * The renderer needs the full approved reveal duration for the whole round,
 * not the changing time remaining in the current REVEAL phase.  The latter is
 * supplied separately as `phase_ends_in`; returning it here would restart or
 * accelerate a Unity animation after every poll.
 */
export function snapshotRevealSeconds(spec: GameSpec): number {
  const seconds = spec.timing.reveal_seconds;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
    throw new GameRuleError("OUTCOME_NOT_IMPLEMENTED", "This cabinet has no approved reveal duration.");
  }
  return seconds;
}

function asSafePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new GameRuleError("INVALID_STAKE", `${label} must be a positive whole number.`);
  }
  return value;
}

function stakeWithinGameLimits(spec: GameSpec, value: unknown, label = "amount"): number {
  const amount = asSafePositiveInteger(value, label);
  if (amount < spec.min_bet || amount > spec.max_bet) {
    throw new GameRuleError(
      "INVALID_STAKE",
      `${label} must be between ${spec.min_bet} and ${spec.max_bet} for this game.`,
    );
  }
  return amount;
}

function asText(value: unknown, label: string, max = 160): string {
  if (typeof value !== "string" || value.trim().length < 1 || value.trim().length > max) {
    throw new GameRuleError("INVALID_SELECTION", `${label} is invalid.`);
  }
  return value.trim();
}

export type NormalizedAction = {
  action: PlayerAction;
  internal_action: InternalAction;
  selection?: string;
  amount?: number;
  hold_index?: number;
  held?: boolean;
  panel?: number;
};

export type PersistedGameActionReplay = {
  session_id: string;
  round_id: string;
  kind: string;
  status: string;
  request: unknown;
};

const ROUND_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ROUND_ACTION_PRECONDITION_PREFIX = "round-v1_";

/**
 * The client receives this opaque value with every authoritative snapshot and
 * must echo it with an action.  It binds a delayed first delivery to the round
 * the player actually saw without accepting a client-authored round number.
 */
export function roundActionPrecondition(roundId: string): string {
  return `${ROUND_ACTION_PRECONDITION_PREFIX}${roundId.toLowerCase()}`;
}

export function isRoundActionPrecondition(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith(ROUND_ACTION_PRECONDITION_PREFIX)) return false;
  const roundId = value.slice(ROUND_ACTION_PRECONDITION_PREFIX.length);
  return roundId === roundId.toLowerCase() && ROUND_ID_RE.test(roundId);
}

export function matchesRoundActionPrecondition(value: unknown, roundId: string): boolean {
  return ROUND_ID_RE.test(roundId) &&
    isRoundActionPrecondition(value) &&
    value === roundActionPrecondition(roundId);
}

/**
 * Build the exact intent persisted by the game RPCs.  Keeping this separate
 * from the HTTP body matters for normalized selections (Roulette marker order)
 * and for future player-paced controls whose wire selection is represented by
 * a typed field after validation.
 */
export function normalizedActionRequest(action: NormalizedAction): Record<string, string | number> {
  const request: Record<string, string | number> = { action: action.action };
  if (action.selection !== undefined) {
    request.selection = action.selection;
  } else if (action.hold_index !== undefined) {
    request.selection = String(action.hold_index);
  } else if (action.panel !== undefined) {
    request.selection = `panel${action.panel}`;
  }
  if (action.amount !== undefined) request.amount = action.amount;
  return request;
}

/**
 * An accepted retry belongs to the original immutable receipt even if the
 * server clock has already entered lock/reveal or advanced to another round.
 * The client never supplies a round id, so replay identity is the authenticated
 * player lookup performed by the caller plus session, persisted round, action
 * kind, key, action precondition and canonical request checked here. A
 * mismatch is an idempotency conflict.
 */
export function matchesPersistedGameActionReplay(
  persisted: PersistedGameActionReplay,
  sessionId: string,
  internalAction: InternalAction,
  request: Record<string, string | number>,
  actionPrecondition: string,
): boolean {
  return persisted.status === "APPLIED" &&
    persisted.session_id === sessionId &&
    matchesRoundActionPrecondition(actionPrecondition, persisted.round_id) &&
    persisted.kind === internalAction.toUpperCase() &&
    canonicalRuntimeJson(persisted.request) === canonicalRuntimeJson(request);
}

/**
 * Validate only the player intent.  This is not settlement validation: outcome,
 * payout and balance are deliberately absent from the input and return value.
 */
export function normalizePlayerAction(
  spec: GameSpec,
  action: string,
  payload: Record<string, unknown>,
): NormalizedAction {
  if (!spec.actions.includes(action as PlayerAction)) {
    throw new GameRuleError("UNSUPPORTED_ACTION", "This action is not available for this cabinet.");
  }
  const wireAction = action as PlayerAction;
  const actionMap: Record<PlayerAction, InternalAction> = {
    place_bet: "stake",
    clear_bets: "clear",
    cancel_bet: "undo",
    repeat_bets: "repeat",
    collect_full: "collect",
    collect_half: "collect",
    deal: "deal",
    hold: "set_hold",
    release: "set_hold",
    cash_out: "cash_out",
    gamble: "gamble",
  };
  const normalized: NormalizedAction = {
    action: wireAction,
    internal_action: actionMap[wireAction],
  };
  if (wireAction === "place_bet") {
    normalized.amount = stakeWithinGameLimits(spec, payload.amount);
    const selection = asText(payload.selection ?? "__stake__", "selection");
    normalized.selection = validateSelection(spec, selection);
  } else if (wireAction === "cancel_bet") {
    normalized.selection = validateSelection(spec, asText(payload.selection, "selection"));
  } else if (wireAction === "hold" || wireAction === "release") {
    const rawIndex = asText(payload.selection, "selection", 2);
    if (!/^[0-4]$/.test(rawIndex)) {
      throw new GameRuleError("INVALID_SELECTION", "Card hold index must be 0 through 4.");
    }
    normalized.hold_index = Number(rawIndex);
    normalized.held = wireAction === "hold";
  } else if (wireAction === "cash_out") {
    const panel = payload.selection;
    if (panel !== "panel1" && panel !== "panel2") {
      throw new GameRuleError("INVALID_SELECTION", "Cash out panel must be 1 or 2.");
    }
    normalized.panel = panel === "panel1" ? 1 : 2;
  }
  return normalized;
}

// -- Roulette: direct, conservative transcription of Unity Roulette.cs ------

export const ROULETTE_WHEEL: readonly string[] = Object.freeze([
  "0", "28", "9", "26", "30", "11", "7", "20", "32", "17", "5", "22", "34", "15", "3", "24", "36", "13", "1",
  "00", "27", "10", "25", "29", "12", "8", "19", "31", "18", "6", "21", "33", "16", "4", "23", "35", "14", "2",
]);
export const ROULETTE_POCKETS = new Set(ROULETTE_WHEEL);
const ROULETTE_REDS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const ROULETTE_GRID = [
  [3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 33, 36],
  [2, 5, 8, 11, 14, 17, 20, 23, 26, 29, 32, 35],
  [1, 4, 7, 10, 13, 16, 19, 22, 25, 28, 31, 34],
];

function rouletteNumber(label: string): number {
  if (label === "00") return 100;
  if (!/^(?:0|[1-9]|[12][0-9]|3[0-6])$/.test(label)) {
    throw new GameRuleError("INVALID_SELECTION", "Roulette number is invalid.");
  }
  return Number(label);
}

export function canonicalRouletteNumbers(value: string): string {
  const labels = value.split("-");
  if (!labels.length || labels.some((label) => !label)) {
    throw new GameRuleError("INVALID_SELECTION", "Roulette numbers are required.");
  }
  const numeric = labels.map((label) => ({ label, number: rouletteNumber(label) }));
  if (new Set(numeric.map((entry) => entry.label)).size !== numeric.length) {
    throw new GameRuleError("INVALID_SELECTION", "Roulette bet numbers must be distinct.");
  }
  return numeric.sort((a, b) => a.number - b.number).map((entry) => entry.label).join("-");
}

type RouletteInside = { legal: Set<string>; size: number };
function rouletteInsideBets(): Record<string, RouletteInside> {
  const splits = new Set<string>();
  const streets = new Set<string>();
  const corners = new Set<string>();
  const sixlines = new Set<string>();
  const key = (numbers: number[]) => canonicalRouletteNumbers(numbers.join("-"));
  for (let row = 0; row < 3; row++) {
    for (let column = 0; column < 12; column++) {
      const number = ROULETTE_GRID[row][column];
      if (column > 0) splits.add(key([ROULETTE_GRID[row][column - 1], number]));
      if (row < 2) splits.add(key([number, ROULETTE_GRID[row + 1][column]]));
      if (column > 0 && row < 2) {
        corners.add(key([
          ROULETTE_GRID[row][column - 1], number,
          ROULETTE_GRID[row + 1][column - 1], ROULETTE_GRID[row + 1][column],
        ]));
      }
    }
  }
  for (let column = 0; column < 12; column++) {
    streets.add(key([ROULETTE_GRID[0][column], ROULETTE_GRID[1][column], ROULETTE_GRID[2][column]]));
    if (column > 0) {
      sixlines.add(key([
        ROULETTE_GRID[0][column - 1], ROULETTE_GRID[1][column - 1], ROULETTE_GRID[2][column - 1],
        ROULETTE_GRID[0][column], ROULETTE_GRID[1][column], ROULETTE_GRID[2][column],
      ]));
    }
  }
  const zeroKey = (...labels: string[]) => canonicalRouletteNumbers(labels.join("-"));
  splits.add(zeroKey("0", "00"));
  splits.add(zeroKey("0", "3"));
  splits.add(zeroKey("0", "2"));
  splits.add(zeroKey("00", "2"));
  splits.add(zeroKey("00", "1"));
  streets.add(zeroKey("0", "2", "3"));
  streets.add(zeroKey("00", "1", "2"));
  return {
    split: { legal: splits, size: 2 },
    street: { legal: streets, size: 3 },
    corner: { legal: corners, size: 4 },
    sixline: { legal: sixlines, size: 6 },
    basket: { legal: new Set([zeroKey("0", "00", "1", "2", "3")]), size: 5 },
  };
}
const ROULETTE_INSIDE = rouletteInsideBets();
const ROULETTE_SECTORS: Record<string, ReadonlySet<string>> = {
  zeroside: new Set(ROULETTE_WHEEL.slice(0, 19)),
  dzeroside: new Set(ROULETTE_WHEEL.slice(19, 38)),
  zeroneighbours: new Set(["0", "00", "2", "28", "1", "27"]),
};

export function rouletteColor(pocket: string): "red" | "black" | "green" {
  if (!ROULETTE_POCKETS.has(pocket)) throw new GameRuleError("INVALID_OUTCOME", "Unknown roulette pocket.");
  if (pocket === "0" || pocket === "00") return "green";
  return ROULETTE_REDS.has(Number(pocket)) ? "red" : "black";
}

function parseRouletteSelection(selection: string): { type: string; rawValue: string } {
  if (typeof selection !== "string" || selection.trim() !== selection) {
    throw new GameRuleError("INVALID_SELECTION", "Roulette bet format is invalid.");
  }
  const separator = selection.indexOf(":");
  if (
    separator < 1 || separator !== selection.lastIndexOf(":") ||
    separator === selection.length - 1
  ) {
    throw new GameRuleError("INVALID_SELECTION", "A roulette bet needs exactly one type and value.");
  }
  return { type: selection.slice(0, separator), rawValue: selection.slice(separator + 1) };
}

export function rouletteMultiplier(selection: string, winningPocket: string): number {
  if (!ROULETTE_POCKETS.has(winningPocket)) {
    throw new GameRuleError("INVALID_OUTCOME", "Unknown roulette pocket.");
  }
  const { type, rawValue } = parseRouletteSelection(selection);
  const zero = winningPocket === "0" || winningPocket === "00";
  const number = zero ? -1 : Number(winningPocket);
  switch (type) {
    case "straight":
      if (!ROULETTE_POCKETS.has(rawValue)) throw new GameRuleError("INVALID_SELECTION", "Unknown roulette pocket.");
      return rawValue === winningPocket ? 36 : 0;
    case "sector": {
      const sector = ROULETTE_SECTORS[rawValue];
      if (!sector) throw new GameRuleError("INVALID_SELECTION", "Unknown roulette wheel sector.");
      return sector.has(winningPocket) ? 36 / sector.size : 0;
    }
    case "split":
    case "street":
    case "corner":
    case "sixline":
    case "basket": {
      const inside = ROULETTE_INSIDE[type];
      const key = canonicalRouletteNumbers(rawValue);
      const labels = key.split("-");
      if (labels.length !== inside.size || !inside.legal.has(key)) {
        throw new GameRuleError("INVALID_SELECTION", `That is not a legal ${type} on this layout.`);
      }
      return labels.includes(winningPocket) ? 36 / inside.size : 0;
    }
    case "color":
      if (rawValue !== "red" && rawValue !== "black") {
        throw new GameRuleError("INVALID_SELECTION", "Color must be red or black.");
      }
      return rouletteColor(winningPocket) === rawValue ? 2 : 0;
    case "parity":
      if (rawValue !== "odd" && rawValue !== "even") {
        throw new GameRuleError("INVALID_SELECTION", "Parity must be odd or even.");
      }
      return !zero && ((number % 2 === 1) === (rawValue === "odd")) ? 2 : 0;
    case "range":
      if (rawValue !== "low" && rawValue !== "high") {
        throw new GameRuleError("INVALID_SELECTION", "Range must be low or high.");
      }
      return !zero && (rawValue === "low" ? number >= 1 && number <= 18 : number >= 19 && number <= 36) ? 2 : 0;
    case "dozen": {
      const dozen = Number(rawValue);
      if (!/^[123]$/.test(rawValue)) throw new GameRuleError("INVALID_SELECTION", "Dozen must be 1, 2 or 3.");
      return !zero && Math.floor((number - 1) / 12) + 1 === dozen ? 3 : 0;
    }
    case "column": {
      const column = Number(rawValue);
      if (!/^[123]$/.test(rawValue)) throw new GameRuleError("INVALID_SELECTION", "Column must be 1, 2 or 3.");
      return !zero && ((number - 1) % 3) + 1 === column ? 3 : 0;
    }
    default:
      throw new GameRuleError("INVALID_SELECTION", "Invalid roulette bet type.");
  }
}

export function validateSelection(spec: GameSpec, selection: string): string {
  if (spec.catalog_slug === "fun-roulette") {
    // Calling the multiplier with a valid fixed pocket validates the bet shape
    // without making a client-selected result part of the decision.
    rouletteMultiplier(selection, "0");
    const { type, rawValue } = parseRouletteSelection(selection);
    return type === "split" || type === "street" || type === "corner" ||
        type === "sixline" || type === "basket"
      ? `${type}:${canonicalRouletteNumbers(rawValue)}`
      : selection;
  }
  if (spec.catalog_slug === "fun-target") {
    if (!/^number:[0-9]$/.test(selection)) {
      throw new GameRuleError("INVALID_SELECTION", "Pick a number from 0 to 9.");
    }
    return selection;
  }
  if (spec.catalog_slug === "keno") {
    const raw = selection.replace(/^(?:picks|pick):/, "");
    const picks = raw.split(",").filter(Boolean).map((entry) => Number(entry));
    if (
      picks.length < 1 || picks.length > 10 ||
      picks.some((pick) => !Number.isInteger(pick) || pick < 1 || pick > 80) ||
      new Set(picks).size !== picks.length
    ) {
      throw new GameRuleError("INVALID_SELECTION", "Pick 1-10 unique numbers from 1 through 80.");
    }
    return `picks:${picks.join(",")}`;
  }
  // Stake-only tables use a server-normalized sentinel.  Other parity-blocked
  // cabinets retain their literal Unity selection until their separate ruleset
  // becomes available; this path never performs a payout.
  return selection;
}

assertGameMapIntegrity();
