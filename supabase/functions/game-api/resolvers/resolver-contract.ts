/**
 * Stable, fail-closed contract for game-specific server resolvers.
 *
 * A review module is useful before it is eligible for live play: it can own
 * strict wire validation, transcribe client-backed result structure, and
 * carry deterministic evidence vectors.  It is *not* a live resolver until
 * both `generateOutcome` and `settle` exist and the manifest has no blockers.
 * This distinction prevents a partially recovered paytable from becoming a
 * production points rule by accident.
 */

export type ResolverReadiness = "READY" | "BLOCKED";
export type EvidenceStatus = "VERIFIED" | "PARTIAL" | "UNVERIFIED";
export type RuntimeMode = "CLOCKED_SHARED" | "PLAYER_PACED" | "UNKNOWN";

export type ResolverBlockerArea =
  | "ACTION"
  | "TIMING"
  | "OUTCOME"
  | "PAYOUT"
  | "SETTLEMENT"
  | "MULTIPLAYER";

export type ResolverBlocker = Readonly<{
  code: string;
  area: ResolverBlockerArea;
  detail: string;
  evidence: readonly string[];
}>;

export type TimingEvidence = Readonly<{
  status: EvidenceStatus;
  mode: RuntimeMode;
  bet_seconds: number | null;
  lock_seconds: number | null;
  reveal_seconds: number | null;
  result_seconds: number | null;
  note: string;
}>;

export type SettlementEvidence = Readonly<{
  status: EvidenceStatus;
  unit: "VIRTUAL_POINTS";
  payout_semantics: "TOTAL_RETURN" | "PROFIT_PLUS_STAKE" | "UNKNOWN";
  note: string;
}>;

export type ResolverManifest = Readonly<{
  catalog_slug: string;
  module_id: string;
  live_resolver_id: string | null;
  ruleset_version: number | null;
  readiness: ResolverReadiness;
  virtual_points_only: true;
  action_policy: Readonly<{
    observed: readonly string[];
    executable: readonly string[];
  }>;
  timing: TimingEvidence;
  settlement: SettlementEvidence;
  blockers: readonly ResolverBlocker[];
  evidence: readonly string[];
}>;

export type ServerEntropy = (exclusiveMax: number) => number;

export type DeterministicVector = Readonly<{
  name: string;
  input: Readonly<Record<string, unknown>>;
  expected: Readonly<Record<string, unknown>>;
}>;

export type SettlementResult = Readonly<{
  stake_points: number;
  payout_points: number;
  net_points: number;
}>;

export type ReviewResolverModule<Selection, Outcome, Inspection> = Readonly<{
  manifest: ResolverManifest;
  normalizeSelection: (input: unknown) => Selection;
  validateOutcome: (input: unknown) => Outcome;
  inspectOutcome: (outcome: Outcome, selection: Selection) => Inspection;
  /** Null until the authoritative distribution/protocol is client-backed. */
  generateOutcome: ((entropy: ServerEntropy) => Outcome) | null;
  /** Null until payout basis and complete settlement semantics are verified. */
  settle: ((selection: Selection, stakePoints: number, outcome: Outcome) => SettlementResult) | null;
  deterministicVectors: readonly DeterministicVector[];
}>;

export class ResolverInputError extends Error {
  readonly code:
    | "INVALID_SELECTION"
    | "INVALID_OUTCOME"
    | "INVALID_STAKE"
    | "NON_VIRTUAL_VALUE";

  constructor(code: ResolverInputError["code"], message: string) {
    super(message);
    this.name = "ResolverInputError";
    this.code = code;
  }
}

export class ResolverNotReadyError extends Error {
  readonly code = "RESOLVER_NOT_READY";
  readonly catalog_slug: string;
  readonly blocker_codes: readonly string[];

  constructor(manifest: ResolverManifest) {
    super(`${manifest.catalog_slug} has no production-approved resolver.`);
    this.name = "ResolverNotReadyError";
    this.catalog_slug = manifest.catalog_slug;
    this.blocker_codes = Object.freeze(manifest.blockers.map((blocker) => blocker.code));
  }
}

export function plainRecord(value: unknown, code: "INVALID_SELECTION" | "INVALID_OUTCOME"): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ResolverInputError(code, "Expected an object payload.");
  }
  return value as Record<string, unknown>;
}

export function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  code: "INVALID_SELECTION" | "INVALID_OUTCOME",
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new ResolverInputError(code, `Expected only: ${expected.join(", ")}.`);
  }
}

/**
 * Point ledgers use positive safe integers.  Currency/deposit/payment objects
 * are deliberately not accepted by this layer.
 */
export function virtualPointStake(value: unknown, maximum?: number): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new ResolverInputError("INVALID_STAKE", "Stake must be a positive whole number of virtual points.");
  }
  const points = value as number;
  if (maximum !== undefined && points > maximum) {
    throw new ResolverInputError("INVALID_STAKE", `Stake exceeds the verified ${maximum}-point ceiling.`);
  }
  return points;
}

export function rejectCashLikeFields(payload: unknown): void {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return;
  const forbidden = new Set([
    "cash",
    "currency",
    "deposit",
    "fiat",
    "inr",
    "money",
    "payment",
    "rupees",
    "withdrawal",
  ]);
  for (const key of Object.keys(payload as Record<string, unknown>)) {
    if (forbidden.has(key.toLowerCase())) {
      throw new ResolverInputError("NON_VIRTUAL_VALUE", "Resolvers accept virtual points only.");
    }
  }
}

export function assertFailClosedResolver(module: ReviewResolverModule<unknown, unknown, unknown>): void {
  const { manifest } = module;
  if (
    manifest.readiness !== "BLOCKED" ||
    manifest.live_resolver_id !== null ||
    manifest.ruleset_version !== null ||
    manifest.blockers.length === 0 ||
    manifest.action_policy.executable.length !== 0 ||
    module.generateOutcome !== null ||
    module.settle !== null
  ) {
    throw new Error(`${manifest.catalog_slug} review module is not fail-closed.`);
  }
}

export function requireExecutableResolver<Selection, Outcome, Inspection>(
  module: ReviewResolverModule<Selection, Outcome, Inspection>,
): asserts module is ReviewResolverModule<Selection, Outcome, Inspection> & {
  generateOutcome: (entropy: ServerEntropy) => Outcome;
  settle: (selection: Selection, stakePoints: number, outcome: Outcome) => SettlementResult;
} {
  const { manifest } = module;
  const validIdentifier = (value: unknown): value is string =>
    typeof value === "string" && /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(value);
  const executableActionsAreValid =
    manifest.action_policy.executable.length > 0 &&
    manifest.action_policy.executable.every((action) =>
      validIdentifier(action) && manifest.action_policy.observed.includes(action)
    );

  if (
    manifest.readiness !== "READY" ||
    !validIdentifier(manifest.catalog_slug) ||
    !validIdentifier(manifest.module_id) ||
    !validIdentifier(manifest.live_resolver_id) ||
    !Number.isSafeInteger(manifest.ruleset_version) ||
    (manifest.ruleset_version as number) < 1 ||
    manifest.virtual_points_only !== true ||
    manifest.timing.status !== "VERIFIED" ||
    manifest.settlement.status !== "VERIFIED" ||
    manifest.settlement.unit !== "VIRTUAL_POINTS" ||
    manifest.settlement.payout_semantics === "UNKNOWN" ||
    manifest.blockers.length > 0 ||
    !executableActionsAreValid ||
    typeof module.generateOutcome !== "function" ||
    typeof module.settle !== "function"
  ) {
    throw new ResolverNotReadyError(manifest);
  }
}
