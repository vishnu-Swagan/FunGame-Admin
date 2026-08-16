/**
 * Production admission and planning for server-authoritative clocked rounds.
 *
 * This module deliberately knows no title rules. A game-specific resolver is
 * the only component allowed to generate an outcome or calculate a payout.
 * The database remains the wallet/receipt authority and re-validates every
 * settlement against the immutable stored round before applying it.
 */
import {
  liveResolverFor,
  type ResolverRegistration,
} from "../shared/live-resolver-registry.ts";
import {
  reviewResolverFor,
  type ReviewResolver,
} from "./resolvers/review-registry.ts";
import {
  requireExecutableResolver,
  type ReviewResolverModule,
  type ServerEntropy,
  type SettlementResult,
} from "./resolvers/resolver-contract.ts";
import { planParimutuelRound, type ParimutuelWager } from "./parimutuel.ts";

export type RuntimeSettlementIdentity = Readonly<{
  catalog_slug: string;
  ruleset_version: number;
  runtime_mode: "CLOCKED_SHARED" | "PLAYER_PACED";
}>;

export type StoredClockedRound = Readonly<{
  id: string;
  catalog_slug: string;
  ruleset_version: number;
  runtime_mode: "CLOCKED_SHARED";
  session_id: null;
  outcome_commitment: string;
  outcome: unknown;
}>;

export type OpenClockedWager = Readonly<{
  id: string;
  selection: string;
  amount: number | string;
  status: "OPEN";
}>;

export type ClockedSettlementPlan = Readonly<{
  wager_id: string;
  payout_points: number;
  outcome: unknown;
  outcome_commitment: string;
  resolver_id: string;
  ruleset_version: number;
}>;

type ErasedResolver = ReviewResolverModule<unknown, unknown, unknown>;
type ExecutableClockedResolver = ErasedResolver & {
  generateOutcome: (entropy: ServerEntropy) => unknown;
  settle: (selection: unknown, stakePoints: number, outcome: unknown) => SettlementResult;
};
export type ExecutableClockedResolverLookup = (
  runtime: RuntimeSettlementIdentity,
) => ExecutableClockedResolver;

// Matches the existing wallet RPC guard; this is an infrastructure bound, not
// a title paytable or inferred game cap.
const MAX_LEDGER_PAYOUT_POINTS = 1_000_000_000;

export class SettlementLifecycleError extends Error {
  constructor(
    readonly code:
      | "RESOLVER_NOT_EXECUTABLE"
      | "RESOLVER_IDENTITY_MISMATCH"
      | "PLAYER_PACED_NOT_CLOCKED"
      | "CLOCKED_NOT_PLAYER_PACED"
      | "ROUND_IDENTITY_MISMATCH"
      | "INVALID_STORED_WAGER"
      | "INVALID_RESOLVER_SETTLEMENT",
    message: string,
  ) {
    super(message);
    this.name = "SettlementLifecycleError";
  }
}

function erased(resolver: ReviewResolver): ErasedResolver {
  return resolver as unknown as ErasedResolver;
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function storedPoints(value: number | string): number {
  const parsed = typeof value === "number"
    ? value
    : /^\d+$/.test(value) ? Number(value) : NaN;
  if (!positiveSafeInteger(parsed)) {
    throw new SettlementLifecycleError("INVALID_STORED_WAGER", "Stored wager points are invalid.");
  }
  return parsed;
}

function validSettlement(result: SettlementResult, stakePoints: number): boolean {
  return Boolean(result && typeof result === "object") &&
    Number.isSafeInteger(result.stake_points) &&
    Number.isSafeInteger(result.payout_points) &&
    Number.isSafeInteger(result.net_points) &&
    result.stake_points === stakePoints &&
    result.payout_points >= 0 &&
    result.payout_points <= MAX_LEDGER_PAYOUT_POINTS &&
    result.net_points === result.payout_points - stakePoints;
}

/**
 * Validate the complete two-key production gate: executable evidence module
 * plus the independent live registration for this exact ruleset.
 *
 * The dependency arguments are exported for deterministic gate tests. Runtime
 * code uses `executableClockedResolverFor`, which resolves the compiled maps.
 */
export function assertExecutableClockedResolver(
  runtime: RuntimeSettlementIdentity,
  resolver: ErasedResolver,
  registration: ResolverRegistration,
): ErasedResolver & {
  generateOutcome: (entropy: ServerEntropy) => unknown;
  settle: (selection: unknown, stakePoints: number, outcome: unknown) => SettlementResult;
} {
  if (runtime.runtime_mode !== "CLOCKED_SHARED" || resolver.manifest.timing.mode === "PLAYER_PACED") {
    throw new SettlementLifecycleError(
      "PLAYER_PACED_NOT_CLOCKED",
      "Player-paced games cannot use the shared clocked-round lifecycle.",
    );
  }
  try {
    requireExecutableResolver(resolver);
  } catch {
    throw new SettlementLifecycleError(
      "RESOLVER_NOT_EXECUTABLE",
      "The game has no complete production-approved resolver.",
    );
  }
  if (
    resolver.manifest.timing.mode !== "CLOCKED_SHARED" ||
    resolver.manifest.catalog_slug !== runtime.catalog_slug ||
    resolver.manifest.ruleset_version !== runtime.ruleset_version ||
    registration.catalog_slug !== runtime.catalog_slug ||
    registration.resolver_id !== resolver.manifest.live_resolver_id ||
    registration.ruleset_version !== runtime.ruleset_version
  ) {
    throw new SettlementLifecycleError(
      "RESOLVER_IDENTITY_MISMATCH",
      "The executable resolver does not match the active runtime and live registration.",
    );
  }
  return resolver;
}

export function executableClockedResolverFor(
  runtime: RuntimeSettlementIdentity,
): ReturnType<typeof assertExecutableClockedResolver> {
  const resolver = reviewResolverFor(runtime.catalog_slug);
  const registration = liveResolverFor(runtime.catalog_slug);
  if (!resolver || !registration) {
    throw new SettlementLifecycleError(
      "RESOLVER_NOT_EXECUTABLE",
      "The game has no compiled production resolver registration.",
    );
  }
  return assertExecutableClockedResolver(runtime, erased(resolver), registration);
}

/** Unbiased WebCrypto entropy supplied to a reviewed resolver. */
export function secureResolverEntropy(exclusiveMax: number): number {
  if (!Number.isInteger(exclusiveMax) || exclusiveMax < 1 || exclusiveMax > 0x1_0000_0000) {
    throw new Error("exclusiveMax must be a positive 32-bit integer.");
  }
  const range = 0x1_0000_0000;
  const limit = range - (range % exclusiveMax);
  const bytes = new Uint32Array(1);
  do crypto.getRandomValues(bytes); while (bytes[0] >= limit);
  return bytes[0] % exclusiveMax;
}

export function generateClockedRoundOutcome(
  runtime: RuntimeSettlementIdentity,
  entropy: ServerEntropy = secureResolverEntropy,
  resolverLookup: ExecutableClockedResolverLookup = executableClockedResolverFor,
): Readonly<{ outcome: unknown; resolver_id: string; ruleset_version: number }> {
  const resolver = resolverLookup(runtime);
  const generated = resolver.generateOutcome(entropy);
  const outcome = resolver.validateOutcome(generated);
  return Object.freeze({
    outcome,
    resolver_id: resolver.manifest.live_resolver_id as string,
    ruleset_version: runtime.ruleset_version,
  });
}

/**
 * Convert immutable OPEN wager rows into resolver-backed settlement intents.
 * The complete batch is validated before the caller performs any database RPC,
 * so a malformed row cannot cause a partially planned round.
 */
export function planClockedSettlements(
  runtime: RuntimeSettlementIdentity,
  round: StoredClockedRound,
  wagers: readonly OpenClockedWager[],
  resolverLookup: ExecutableClockedResolverLookup = executableClockedResolverFor,
): readonly ClockedSettlementPlan[] {
  const resolver = resolverLookup(runtime);
  if (
    round.runtime_mode !== "CLOCKED_SHARED" ||
    round.session_id !== null ||
    round.catalog_slug !== runtime.catalog_slug ||
    round.ruleset_version !== runtime.ruleset_version ||
    !/^[0-9a-f]{64}$/.test(round.outcome_commitment)
  ) {
    throw new SettlementLifecycleError(
      "ROUND_IDENTITY_MISMATCH",
      "The stored round does not match the clocked runtime identity.",
    );
  }
  const outcome = resolver.validateOutcome(round.outcome);
  const seen = new Set<string>();
  const plans = wagers.map((wager) => {
    if (
      wager.status !== "OPEN" ||
      typeof wager.id !== "string" ||
      wager.id.length === 0 ||
      seen.has(wager.id) ||
      typeof wager.selection !== "string"
    ) {
      throw new SettlementLifecycleError("INVALID_STORED_WAGER", "Stored OPEN wager identity is invalid.");
    }
    seen.add(wager.id);
    const stakePoints = storedPoints(wager.amount);
    const selection = resolver.normalizeSelection(wager.selection);
    const settlement = resolver.settle(selection, stakePoints, outcome);
    if (!validSettlement(settlement, stakePoints)) {
      throw new SettlementLifecycleError(
        "INVALID_RESOLVER_SETTLEMENT",
        "Resolver returned an invalid virtual-point settlement.",
      );
    }
    return Object.freeze({
      wager_id: wager.id,
      payout_points: settlement.payout_points,
      outcome,
      outcome_commitment: round.outcome_commitment,
      resolver_id: resolver.manifest.live_resolver_id as string,
      ruleset_version: runtime.ruleset_version,
    });
  });
  return Object.freeze(plans);
}

/* ---------------------------------------------------------------------------
 * Pari-mutuel settlement for shared clocked tables
 *
 * The house does not bank a fixed multiplier on these tables. The whole round
 * pool is redistributed: 90% goes to the players who backed the winning
 * outcome, in proportion to their winning stake. WHO wins is decided exactly as
 * fixed-odds decides it — a selection wins iff its resolver would have paid it —
 * so this never re-derives game rules; it changes only how much a winner gets.
 *
 * The plan is computed from the ENTIRE round book (every wager, every player,
 * every status), because the pool and the winning-stake pool depend on all of
 * them. Betting is closed before settlement, so the book is fixed and the
 * per-wager payout is deterministic — which is what makes settling the same
 * round twice (two players polling) idempotent: both compute identical payouts,
 * and the per-wager RPC no-ops an already-settled wager.
 * ------------------------------------------------------------------------ */

export type ClockedRoundWager = Readonly<{
  id: string;
  player_id: string;
  selection: string;
  amount: number | string;
  status: string;
}>;

export type ParimutuelClockedPlan = Readonly<{
  outcome: unknown;
  outcome_commitment: string;
  resolver_id: string;
  ruleset_version: number;
  round_pool: number;
  maximum_distribution: number;
  winning_stake_pool: number;
  remainder_points: number;
  no_winner: boolean;
  payouts: readonly { wager_id: string; payout_points: number }[];
}>;

export function planParimutuelClockedRound(
  runtime: RuntimeSettlementIdentity,
  round: StoredClockedRound,
  wagers: readonly ClockedRoundWager[],
  resolverLookup: ExecutableClockedResolverLookup = executableClockedResolverFor,
): ParimutuelClockedPlan {
  const resolver = resolverLookup(runtime);
  if (
    round.runtime_mode !== "CLOCKED_SHARED" ||
    round.session_id !== null ||
    round.catalog_slug !== runtime.catalog_slug ||
    round.ruleset_version !== runtime.ruleset_version ||
    !/^[0-9a-f]{64}$/.test(round.outcome_commitment)
  ) {
    throw new SettlementLifecycleError(
      "ROUND_IDENTITY_MISMATCH",
      "The stored round does not match the clocked runtime identity.",
    );
  }
  const outcome = resolver.validateOutcome(round.outcome);
  const seen = new Set<string>();
  const pm: ParimutuelWager[] = wagers.map((wager) => {
    if (
      typeof wager.id !== "string" || wager.id.length === 0 || seen.has(wager.id) ||
      typeof wager.player_id !== "string" || wager.player_id.length === 0 ||
      typeof wager.selection !== "string"
    ) {
      throw new SettlementLifecycleError("INVALID_STORED_WAGER", "Stored round wager identity is invalid.");
    }
    seen.add(wager.id);
    const stakePoints = storedPoints(wager.amount);
    const selection = resolver.normalizeSelection(wager.selection);
    // Win determination only: a selection wins iff the fixed resolver would
    // have paid it. The amount it returns is discarded; pari-mutuel sets the
    // payout. This is status-independent, so an already-settled wager still
    // contributes correctly to the pool.
    const settlement = resolver.settle(selection, stakePoints, outcome);
    if (
      !Number.isSafeInteger(settlement.payout_points) || settlement.payout_points < 0
    ) {
      throw new SettlementLifecycleError(
        "INVALID_RESOLVER_SETTLEMENT",
        "Resolver returned an invalid win determination.",
      );
    }
    return {
      wager_id: wager.id,
      player_id: wager.player_id,
      stake_points: stakePoints,
      winner: settlement.payout_points > 0,
    };
  });
  const plan = planParimutuelRound(pm);
  return Object.freeze({
    outcome,
    outcome_commitment: round.outcome_commitment,
    resolver_id: resolver.manifest.live_resolver_id as string,
    ruleset_version: runtime.ruleset_version,
    round_pool: plan.round_pool,
    maximum_distribution: plan.maximum_distribution,
    winning_stake_pool: plan.winning_stake_pool,
    remainder_points: plan.remainder_points,
    no_winner: plan.no_winner,
    payouts: plan.payouts.map((p) => ({ wager_id: p.wager_id, payout_points: p.payout_points })),
  });
}

/* ---------------------------------------------------------------------------
 * Single-player (PLAYER_PACED) lifecycle
 *
 * A shared clocked round has many players betting into one common result
 * inside a timed window. A player-paced hand has none of that: one player, one
 * stake, a result produced on the button press, settled immediately.
 *
 * It gets its own admission and planning rather than a relaxed version of the
 * clocked pair, so neither mode can ever be settled by the other's rules. The
 * two gates are deliberate mirror images: each admits exactly one mode and
 * refuses the other.
 * ------------------------------------------------------------------------ */

export type StoredPlayerPacedHand = Readonly<{
  session_id: string;
  catalog_slug: string;
  ruleset_version: number;
  runtime_mode: "PLAYER_PACED";
  /** A token on most cabinets; a structured object on the reel machine. */
  selection: unknown;
  stake_points: number | string;
  outcome: unknown;
}>;

export type PlayerPacedSettlementPlan = Readonly<{
  session_id: string;
  stake_points: number;
  payout_points: number;
  outcome: unknown;
  resolver_id: string;
  ruleset_version: number;
}>;

export type ExecutablePlayerPacedResolverLookup = (
  runtime: RuntimeSettlementIdentity,
) => ErasedResolver & {
  generateOutcome: (entropy: ServerEntropy) => unknown;
  settle: (selection: unknown, stakePoints: number, outcome: unknown) => SettlementResult;
};

/**
 * The player-paced twin of `assertExecutableClockedResolver`, holding the same
 * two-key gate: an executable evidence module AND an independent live
 * registration for this exact ruleset. A clocked cabinet is refused here
 * exactly as a player-paced one is refused by the clocked gate.
 */
export function assertExecutablePlayerPacedResolver(
  runtime: RuntimeSettlementIdentity,
  resolver: ErasedResolver,
  registration: ResolverRegistration,
): ErasedResolver & {
  generateOutcome: (entropy: ServerEntropy) => unknown;
  settle: (selection: unknown, stakePoints: number, outcome: unknown) => SettlementResult;
} {
  if (
    runtime.runtime_mode !== "PLAYER_PACED" ||
    resolver.manifest.timing.mode === "CLOCKED_SHARED"
  ) {
    throw new SettlementLifecycleError(
      "CLOCKED_NOT_PLAYER_PACED",
      "Shared clocked games cannot use the single-player lifecycle.",
    );
  }
  try {
    requireExecutableResolver(resolver);
  } catch {
    throw new SettlementLifecycleError(
      "RESOLVER_NOT_EXECUTABLE",
      "The game has no complete production-approved resolver.",
    );
  }
  if (
    resolver.manifest.timing.mode !== "PLAYER_PACED" ||
    resolver.manifest.catalog_slug !== runtime.catalog_slug ||
    resolver.manifest.ruleset_version !== runtime.ruleset_version ||
    registration.catalog_slug !== runtime.catalog_slug ||
    registration.resolver_id !== resolver.manifest.live_resolver_id ||
    registration.ruleset_version !== runtime.ruleset_version
  ) {
    throw new SettlementLifecycleError(
      "RESOLVER_IDENTITY_MISMATCH",
      "The executable resolver does not match the active runtime and live registration.",
    );
  }
  return resolver;
}

export function executablePlayerPacedResolverFor(
  runtime: RuntimeSettlementIdentity,
): ReturnType<typeof assertExecutablePlayerPacedResolver> {
  const resolver = reviewResolverFor(runtime.catalog_slug);
  const registration = liveResolverFor(runtime.catalog_slug);
  if (!resolver || !registration) {
    throw new SettlementLifecycleError(
      "RESOLVER_NOT_EXECUTABLE",
      "The game has no compiled production resolver registration.",
    );
  }
  return assertExecutablePlayerPacedResolver(runtime, erased(resolver), registration);
}

export function generatePlayerPacedOutcome(
  runtime: RuntimeSettlementIdentity,
  entropy: ServerEntropy = secureResolverEntropy,
  resolverLookup: ExecutablePlayerPacedResolverLookup = executablePlayerPacedResolverFor,
): Readonly<{ outcome: unknown; resolver_id: string; ruleset_version: number }> {
  const resolver = resolverLookup(runtime);
  const generated = resolver.generateOutcome(entropy);
  const outcome = resolver.validateOutcome(generated);
  return Object.freeze({
    outcome,
    resolver_id: resolver.manifest.live_resolver_id as string,
    ruleset_version: runtime.ruleset_version,
  });
}

/**
 * Turn one stored hand into the settlement to apply. Fully validated before the
 * caller performs any database work, so a malformed hand cannot half-settle.
 */
export function planPlayerPacedSettlement(
  runtime: RuntimeSettlementIdentity,
  hand: StoredPlayerPacedHand,
  resolverLookup: ExecutablePlayerPacedResolverLookup = executablePlayerPacedResolverFor,
): PlayerPacedSettlementPlan {
  const resolver = resolverLookup(runtime);
  if (
    hand.runtime_mode !== "PLAYER_PACED" ||
    typeof hand.session_id !== "string" ||
    hand.session_id.length === 0 ||
    hand.catalog_slug !== runtime.catalog_slug ||
    hand.ruleset_version !== runtime.ruleset_version ||
    hand.selection === undefined || hand.selection === null
  ) {
    throw new SettlementLifecycleError(
      "ROUND_IDENTITY_MISMATCH",
      "The stored hand does not match the player-paced runtime identity.",
    );
  }
  const stakePoints = storedPoints(hand.stake_points);
  const outcome = resolver.validateOutcome(hand.outcome);
  const selection = resolver.normalizeSelection(hand.selection);
  const settlement = resolver.settle(selection, stakePoints, outcome);
  if (!validSettlement(settlement, stakePoints)) {
    throw new SettlementLifecycleError(
      "INVALID_RESOLVER_SETTLEMENT",
      "Resolver returned an invalid virtual-point settlement.",
    );
  }
  return Object.freeze({
    session_id: hand.session_id,
    stake_points: stakePoints,
    payout_points: settlement.payout_points,
    outcome,
    resolver_id: resolver.manifest.live_resolver_id as string,
    ruleset_version: runtime.ruleset_version,
  });
}
