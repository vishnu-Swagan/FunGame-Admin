import { GAME_SPECS } from "./game-core.ts";
import {
  assertExecutableClockedResolver,
  executableClockedResolverFor,
  executablePlayerPacedResolverFor,
  generateClockedRoundOutcome,
  planClockedSettlements,
  SettlementLifecycleError,
  type RuntimeSettlementIdentity,
} from "./settlement-lifecycle.ts";
import type {
  ReviewResolverModule,
  SettlementResult,
} from "./resolvers/resolver-contract.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function throwsCode(callback: () => unknown, code: SettlementLifecycleError["code"]): boolean {
  try {
    callback();
    return false;
  } catch (error) {
    return error instanceof SettlementLifecycleError && error.code === code;
  }
}

const runtime: RuntimeSettlementIdentity = Object.freeze({
  catalog_slug: "test-clocked",
  ruleset_version: 7,
  runtime_mode: "CLOCKED_SHARED",
});

const readyResolver: ReviewResolverModule<string, { kind: "test"; winning: string }, { won: boolean }> = Object.freeze({
  manifest: Object.freeze({
    catalog_slug: runtime.catalog_slug,
    module_id: "test-clocked.review",
    live_resolver_id: "test-clocked.live-v7",
    ruleset_version: runtime.ruleset_version,
    readiness: "READY",
    virtual_points_only: true,
    action_policy: Object.freeze({ observed: Object.freeze(["place_bet"]), executable: Object.freeze(["place_bet"]) }),
    timing: Object.freeze({
      status: "VERIFIED",
      mode: "CLOCKED_SHARED",
      bet_seconds: 10,
      lock_seconds: 1,
      reveal_seconds: 2,
      result_seconds: 3,
      note: "Synthetic lifecycle contract used only by this unit test.",
    }),
    settlement: Object.freeze({
      status: "VERIFIED",
      unit: "VIRTUAL_POINTS",
      payout_semantics: "TOTAL_RETURN",
      note: "Synthetic lifecycle contract used only by this unit test.",
    }),
    blockers: Object.freeze([]),
    evidence: Object.freeze(["unit-test-fixture"]),
  }),
  normalizeSelection: (input) => {
    if (input !== "left" && input !== "right") throw new Error("invalid selection");
    return input;
  },
  validateOutcome: (input) => {
    const outcome = input as { kind?: unknown; winning?: unknown };
    if (outcome?.kind !== "test" || (outcome.winning !== "left" && outcome.winning !== "right")) {
      throw new Error("invalid outcome");
    }
    return { kind: "test", winning: outcome.winning };
  },
  inspectOutcome: (outcome, selection) => ({ won: outcome.winning === selection }),
  generateOutcome: (entropy) => ({ kind: "test", winning: entropy(2) === 0 ? "left" : "right" }),
  settle: (selection, stakePoints, outcome): SettlementResult => {
    const payoutPoints = outcome.winning === selection ? stakePoints * 2 : 0;
    return { stake_points: stakePoints, payout_points: payoutPoints, net_points: payoutPoints - stakePoints };
  },
  deterministicVectors: Object.freeze([]),
});

const registration = Object.freeze({
  catalog_slug: runtime.catalog_slug,
  resolver_id: readyResolver.manifest.live_resolver_id,
  ruleset_version: runtime.ruleset_version,
});

function testLookup(identity: RuntimeSettlementIdentity) {
  return assertExecutableClockedResolver(identity, readyResolver as never, registration);
}

Deno.test("clocked lifecycle requires both READY evidence and an exact live registration", () => {
  assertExecutableClockedResolver(runtime, readyResolver as never, registration);
  assert(
    throwsCode(
      () => assertExecutableClockedResolver(
        { ...runtime, ruleset_version: 8 },
        readyResolver as never,
        registration,
      ),
      "RESOLVER_IDENTITY_MISMATCH",
    ),
    "ruleset drift must fail the resolver identity gate",
  );
  assert(
    throwsCode(
      () => assertExecutableClockedResolver(
        { ...runtime, runtime_mode: "PLAYER_PACED" },
        readyResolver as never,
        registration,
      ),
      "PLAYER_PACED_NOT_CLOCKED",
    ),
    "player-paced runtime must never enter the shared clock lifecycle",
  );
});

Deno.test("every title is admitted by its own lifecycle and refused by the other", () => {
  for (const spec of GAME_SPECS) {
    const identity: RuntimeSettlementIdentity = {
      catalog_slug: spec.catalog_slug,
      ruleset_version: 1,
      runtime_mode: spec.runtime_mode,
    };
    if (spec.runtime_mode === "PLAYER_PACED") {
      // The two lifecycles are mirror images: a player-paced title must be
      // refused by the shared clocked path and admitted by its own.
      assert(
        throwsCode(() => executableClockedResolverFor(identity), "PLAYER_PACED_NOT_CLOCKED"),
        `${spec.catalog_slug} must never enter the shared clocked lifecycle`,
      );
      assert(
        executablePlayerPacedResolverFor(identity).manifest.catalog_slug === spec.catalog_slug,
        `${spec.catalog_slug} was refused by its own player-paced lifecycle`,
      );
    } else {
      assert(
        executableClockedResolverFor(identity).manifest.catalog_slug === spec.catalog_slug,
        `${spec.catalog_slug} was refused by its own clocked lifecycle`,
      );
      assert(
        throwsCode(() => executablePlayerPacedResolverFor(identity), "CLOCKED_NOT_PLAYER_PACED"),
        `${spec.catalog_slug} must never enter the single-player lifecycle`,
      );
    }
    // A ruleset the compiled resolver does not implement is refused either way.
    assert(
      throwsCode(
        () =>
          spec.runtime_mode === "PLAYER_PACED"
            ? executablePlayerPacedResolverFor({ ...identity, ruleset_version: 2 })
            : executableClockedResolverFor({ ...identity, ruleset_version: 2 }),
        "RESOLVER_IDENTITY_MISMATCH",
      ),
      `${spec.catalog_slug} accepted an unimplemented ruleset version`,
    );
  }
});

Deno.test("only the admitted resolver generates and validates a clocked outcome", () => {
  const generated = generateClockedRoundOutcome(runtime, () => 1, testLookup);
  assert(generated.resolver_id === "test-clocked.live-v7", "resolver identity was not retained");
  assert(generated.ruleset_version === 7, "ruleset identity was not retained");
  assert((generated.outcome as { winning: string }).winning === "right", "resolver outcome was not used");
});

Deno.test("settlement planning covers every supplied OPEN wager and validates accounting", () => {
  const outcome = { kind: "test" as const, winning: "left" };
  const round = {
    id: "11111111-1111-4111-8111-111111111111",
    catalog_slug: runtime.catalog_slug,
    ruleset_version: runtime.ruleset_version,
    runtime_mode: "CLOCKED_SHARED" as const,
    session_id: null,
    outcome_commitment: "a".repeat(64),
    outcome,
  };
  const plans = planClockedSettlements(runtime, round, [
    { id: "wager-left", selection: "left", amount: "10", status: "OPEN" },
    { id: "wager-right", selection: "right", amount: 20, status: "OPEN" },
  ], testLookup);
  assert(plans.length === 2, "every open wager must receive one settlement plan");
  assert(plans[0].payout_points === 20 && plans[1].payout_points === 0, "resolver payouts were not retained");
  assert(plans.every((plan) => plan.outcome === outcome || (plan.outcome as { winning: string }).winning === "left"),
    "the authoritative stored outcome must drive each wager");
  assert(
    throwsCode(
      () => planClockedSettlements(runtime, round, [
        { id: "same", selection: "left", amount: 10, status: "OPEN" },
        { id: "same", selection: "right", amount: 10, status: "OPEN" },
      ], testLookup),
      "INVALID_STORED_WAGER",
    ),
    "duplicate wager rows must fail the whole plan before persistence",
  );
});

Deno.test("a resolver cannot return inconsistent ledger arithmetic", () => {
  const invalid = Object.freeze({
    ...readyResolver,
    settle: (_selection: string, stakePoints: number) => ({
      stake_points: stakePoints,
      payout_points: 20,
      net_points: 999,
    }),
  });
  const invalidLookup = (identity: RuntimeSettlementIdentity) =>
    assertExecutableClockedResolver(identity, invalid as never, registration);
  assert(
    throwsCode(
      () => planClockedSettlements(runtime, {
        id: "11111111-1111-4111-8111-111111111111",
        catalog_slug: runtime.catalog_slug,
        ruleset_version: runtime.ruleset_version,
        runtime_mode: "CLOCKED_SHARED",
        session_id: null,
        outcome_commitment: "b".repeat(64),
        outcome: { kind: "test", winning: "left" },
      }, [{ id: "wager", selection: "left", amount: 10, status: "OPEN" }], invalidLookup),
      "INVALID_RESOLVER_SETTLEMENT",
    ),
    "inconsistent resolver arithmetic must be rejected before an RPC",
  );
});
