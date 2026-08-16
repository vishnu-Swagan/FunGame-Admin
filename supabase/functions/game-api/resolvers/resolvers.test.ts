import {
  assertFailClosedResolver,
  GIANT_JACKPOT_RESOLVER,
  giantJackpotStake,
  GOLDEN_WHEEL_PUBLISHED_MULTIPLIERS,
  GOLDEN_WHEEL_RESOLVER,
  goldenWheelStake,
  inspectGiantJackpotOutcome,
  inspectGoldenWheelOutcome,
  inspectKenoOutcome,
  inspectLucky8Outcome,
  inspectTripleFunOutcome,
  KENO_RESOLVER,
  LUCKY_8_LINE_RESOLVER,
  normalizeGiantJackpotSelection,
  normalizeGoldenWheelSelection,
  normalizeKenoSelection,
  normalizeLucky8Selection,
  normalizeTripleFunSelection,
  rejectCashLikeFields,
  requireExecutableResolver,
  ResolverInputError,
  ResolverNotReadyError,
  type ReviewResolverModule,
  TRIPLE_FUN_RESOLVER,
  tripleFunStake,
  validateGiantJackpotOutcome,
  validateGoldenWheelOutcome,
  validateKenoOutcome,
  validateLucky8Outcome,
  validateTripleFunOutcome,
  virtualPointStake,
  WHEEL_DRAW_REVIEW_RESOLVERS,
  wheelDrawReviewResolverFor,
} from "./index.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function throwsInput(callback: () => unknown, code: ResolverInputError["code"]): boolean {
  try {
    callback();
    return false;
  } catch (error) {
    return error instanceof ResolverInputError && error.code === code;
  }
}

Deno.test("wheel/draw resolver review map is isolated and all five titles fail closed", () => {
  const slugs = Object.keys(WHEEL_DRAW_REVIEW_RESOLVERS).sort();
  assert(
    JSON.stringify(slugs) === JSON.stringify([
      "giant-jackpot",
      "golden-wheel",
      "keno",
      "lucky-8-line",
      "triple-fun",
    ]),
    "review map must contain exactly the assigned five titles",
  );
  for (const resolver of Object.values(WHEEL_DRAW_REVIEW_RESOLVERS)) {
    requireExecutableResolver(resolver as never);
    assert(resolver.manifest.virtual_points_only, `${resolver.manifest.catalog_slug} must be points-only`);
    assert(resolver.deterministicVectors.length >= 2, `${resolver.manifest.catalog_slug} needs deterministic vectors`);
    assert(resolver.manifest.evidence.length >= 2, `${resolver.manifest.catalog_slug} needs evidence citations`);
    // These titles are live on ruleset v1, so the blocker list must be empty.
    // requireExecutableResolver above already refuses a non-empty one; this
    // states the intent plainly so a re-added blocker fails here with a clear
    // message rather than deep inside the gate.
    assert(resolver.manifest.blockers.length === 0, `${resolver.manifest.catalog_slug} must carry no blockers`);
  }
  assert(wheelDrawReviewResolverFor("keno") === KENO_RESOLVER, "lookup must return Keno review module");
  assert(wheelDrawReviewResolverFor("unknown") === null, "unknown resolver must not acquire a fallback");
  assert(wheelDrawReviewResolverFor("toString") === null, "prototype keys must not resolve as review modules");
  assert(wheelDrawReviewResolverFor("constructor") === null, "constructor must not resolve as a review module");
  assert(wheelDrawReviewResolverFor("__proto__") === null, "__proto__ must not resolve as a review module");
});

Deno.test("a module carrying a blocker is refused and names itself", () => {
  // The refusal path is the safety net for any future re-blocked title, so it
  // must keep working now that every shipped module is READY. Synthesise the
  // blocked state from each live module rather than deleting the coverage.
  for (const resolver of Object.values(WHEEL_DRAW_REVIEW_RESOLVERS)) {
    const blocked = {
      ...resolver,
      manifest: {
        ...resolver.manifest,
        readiness: "BLOCKED",
        blockers: Object.freeze([
          { code: "TEST_REBLOCKED", area: "PAYOUT", detail: "synthetic", evidence: ["test"] },
        ]),
      },
    };
    let thrown: unknown;
    try {
      requireExecutableResolver(blocked as never);
    } catch (error) {
      thrown = error;
    }
    assert(thrown instanceof ResolverNotReadyError, `${resolver.manifest.catalog_slug} must throw RESOLVER_NOT_READY`);
    assert(thrown.catalog_slug === resolver.manifest.catalog_slug, "blocked error must name the title");
    assert(thrown.blocker_codes.length === 1, "blocked error must retain blocker codes");
  }
});

Deno.test("READY admission requires the complete evidence and execution gate", () => {
  const ready = {
    manifest: {
      catalog_slug: "review-fixture",
      module_id: "review-fixture-v1",
      live_resolver_id: "review-fixture-v1",
      ruleset_version: 1,
      readiness: "READY",
      virtual_points_only: true,
      action_policy: { observed: ["place_bet"], executable: ["place_bet"] },
      timing: {
        status: "VERIFIED",
        mode: "CLOCKED_SHARED",
        bet_seconds: 10,
        lock_seconds: 1,
        reveal_seconds: 1,
        result_seconds: 1,
        note: "test fixture",
      },
      settlement: {
        status: "VERIFIED",
        unit: "VIRTUAL_POINTS",
        payout_semantics: "TOTAL_RETURN",
        note: "test fixture",
      },
      blockers: [],
      evidence: ["test fixture"],
    },
    normalizeSelection: (input: unknown) => input,
    validateOutcome: (input: unknown) => input,
    inspectOutcome: () => Object.freeze({}),
    generateOutcome: () => Object.freeze({ value: 1 }),
    settle: (_selection: unknown, stakePoints: number) => Object.freeze({
      stake_points: stakePoints,
      payout_points: stakePoints,
      net_points: 0,
    }),
    deterministicVectors: [],
  } as unknown as ReviewResolverModule<unknown, unknown, unknown>;

  requireExecutableResolver(ready);

  const candidate = (
    manifestOverrides: Readonly<Record<string, unknown>> = {},
    moduleOverrides: Readonly<Record<string, unknown>> = {},
  ): ReviewResolverModule<unknown, unknown, unknown> => ({
    ...ready,
    ...moduleOverrides,
    manifest: { ...ready.manifest, ...manifestOverrides },
  }) as unknown as ReviewResolverModule<unknown, unknown, unknown>;
  const refuses = (module: ReviewResolverModule<unknown, unknown, unknown>): boolean => {
    try {
      requireExecutableResolver(module);
      return false;
    } catch (error) {
      return error instanceof ResolverNotReadyError;
    }
  };

  const invalidCandidates = [
    candidate({ module_id: "bad id" }),
    candidate({ live_resolver_id: "" }),
    candidate({ ruleset_version: 0 }),
    candidate({ virtual_points_only: false }),
    candidate({ timing: { ...ready.manifest.timing, status: "PARTIAL" } }),
    candidate({ settlement: { ...ready.manifest.settlement, status: "PARTIAL" } }),
    candidate({ settlement: { ...ready.manifest.settlement, payout_semantics: "UNKNOWN" } }),
    candidate({ action_policy: { observed: ["place_bet"], executable: [] } }),
    candidate({ action_policy: { observed: ["place_bet"], executable: ["unobserved_action"] } }),
    candidate({ blockers: [{ code: "TEST_BLOCKER", area: "SETTLEMENT", detail: "fixture", evidence: ["fixture"] }] }),
    candidate({}, { generateOutcome: null }),
    candidate({}, { settle: null }),
  ];
  invalidCandidates.forEach((module, index) =>
    assert(refuses(module), `incomplete READY candidate ${index} must fail admission`)
  );
});

Deno.test("resolver contract accepts only whole virtual points and rejects cash-like fields", () => {
  assert(virtualPointStake(10) === 10, "whole virtual points should validate");
  assert(throwsInput(() => virtualPointStake(0), "INVALID_STAKE"), "zero point stake must fail");
  assert(throwsInput(() => virtualPointStake(1.5), "INVALID_STAKE"), "fractional point stake must fail");
  assert(throwsInput(() => virtualPointStake(Number.MAX_SAFE_INTEGER + 1), "INVALID_STAKE"), "unsafe stake must fail");
  assert(
    throwsInput(() => rejectCashLikeFields({ currency: "INR", amount: 10 }), "NON_VIRTUAL_VALUE"),
    "currency payload must fail",
  );
});

Deno.test("Triple Fun preserves fixed-width selection identities and class ceilings", () => {
  const single = normalizeTripleFunSelection("single:0");
  const double = normalizeTripleFunSelection("double:04");
  const triple = normalizeTripleFunSelection("triple:007");
  assert(single.value === 0 && single.verified_max_stake_points === 5000, "single contract is wrong");
  assert(double.value === 4 && double.digits === "04" && double.verified_max_stake_points === 1000, "double contract is wrong");
  assert(triple.value === 7 && triple.digits === "007" && triple.verified_max_stake_points === 100, "triple contract is wrong");
  assert(throwsInput(() => normalizeTripleFunSelection("double:4"), "INVALID_SELECTION"), "short double must fail");
  assert(throwsInput(() => normalizeTripleFunSelection("triple:007:ignored"), "INVALID_SELECTION"), "suffix must fail");
  assert(tripleFunStake(100, triple) === 100, "verified class ceiling should accept exact bound");
  assert(throwsInput(() => tripleFunStake(101, triple), "INVALID_STAKE"), "triple ceiling must be enforced");
});

Deno.test("Triple Fun validates captured digit order but never converts bhav into payout", () => {
  const outcome = validateTripleFunOutcome("592");
  assert(outcome.triple === "592" && outcome.double === "92" && outcome.single === "2", "digit projection is wrong");
  const triple = inspectTripleFunOutcome(outcome, normalizeTripleFunSelection("triple:592"));
  const single = inspectTripleFunOutcome(outcome, normalizeTripleFunSelection("single:2"));
  assert(triple.matched && triple.published_bhav === 900 && triple.payout_points === null, "triple inspection is wrong");
  assert(single.matched && single.published_bhav === 9 && single.payout_points === null, "single inspection is wrong");
  assert(
    throwsInput(() => validateTripleFunOutcome({ digits: [5, 9, 2], payout: 900 }), "INVALID_OUTCOME"),
    "client-supplied payout must not be accepted in an outcome",
  );
});

Deno.test("Giant Jackpot validates exactly four known windows and source-backed ladder rows", () => {
  const selection = normalizeGiantJackpotSelection("__stake__");
  const bars = validateGiantJackpotOutcome({ windows: ["bar", "BAR", "bar", "bar"] });
  const inspected = inspectGiantJackpotOutcome(bars, selection);
  assert(inspected.best_candidate_row === "all_bar", "four bars must select AllBar");
  assert(inspected.published_base_amount === 250 && inspected.payout_points === null, "base amount must not become payout");
  const cap = inspectGiantJackpotOutcome(
    validateGiantJackpotOutcome({ windows: ["gameking", "gameking", "gameking", "orange"] }),
    selection,
  );
  assert(cap.best_candidate_row === "three_cap" && !cap.row_is_priced_in_client_source, "three cap must remain unpriced");
  assert(throwsInput(() => validateGiantJackpotOutcome({ windows: ["bar", "bar", "bar"] }), "INVALID_OUTCOME"), "three windows must fail");
  assert(
    throwsInput(() => validateGiantJackpotOutcome({ windows: ["bar", "bar", "bar", "diamond"] }), "INVALID_OUTCOME"),
    "invented symbol must fail",
  );
  assert(giantJackpotStake(1000) === 1000, "client max should validate");
  assert(throwsInput(() => giantJackpotStake(1001), "INVALID_STAKE"), "client max must be enforced");
});

Deno.test("Golden Wheel review envelope accepts current-Unity columns/pairs without asserting a live protocol", () => {
  const selection = normalizeGoldenWheelSelection("column:8");
  assert(selection.column === 8, "column selection is wrong");
  assert(
    throwsInput(() => normalizeGoldenWheelSelection("pair:8:8"), "INVALID_SELECTION"),
    "local pair placeholder must not cross the resolver boundary",
  );
  const outcome = validateGoldenWheelOutcome({ outer: 8, inner: 1 });
  const inspected = inspectGoldenWheelOutcome(outcome, selection);
  assert(inspected.pair === "8:1" && inspected.winning_payment_type === null, "unknown pair map must remain null");
  assert(GOLDEN_WHEEL_PUBLISHED_MULTIPLIERS.length === 9, "nine displayed multipliers should be retained as evidence");
  assert(goldenWheelStake(5) === 5, "observed minimum should validate");
  assert(throwsInput(() => goldenWheelStake(4), "INVALID_STAKE"), "below-minimum stake must fail");
  assert(throwsInput(() => goldenWheelStake(1001), "INVALID_STAKE"), "above-max stake must fail");
  assert(
    throwsInput(() => validateGoldenWheelOutcome({ outer: 1, inner: 9 }), "INVALID_OUTCOME"),
    "ring result outside the explicitly provisional review envelope must fail",
  );
});

Deno.test("Keno review envelope preserves current-Unity draw order without asserting live cardinality", () => {
  const selection = normalizeKenoSelection("picks:80,1,4");
  assert(selection.canonical === "picks:1,4,80", "ticket identity must be canonical");
  const drawn = [80, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
  const outcome = validateKenoOutcome({ drawn });
  assert(outcome.drawn[0] === 80 && outcome.drawn[3] === 4, "server reveal order must be retained");
  const inspected = inspectKenoOutcome(outcome, selection);
  assert(inspected.hits === 2, "Keno hit count is wrong");
  assert(JSON.stringify(inspected.matched_numbers) === JSON.stringify([4, 80]), "matched picks should follow canonical ticket order");
  assert(inspected.payout_points === null, "unobserved Keno paytable must not settle");
  assert(throwsInput(() => normalizeKenoSelection("picks:1,1"), "INVALID_SELECTION"), "duplicate pick must fail");
  assert(
    throwsInput(() => normalizeKenoSelection("picks:1,2,3,4,5,6,7,8,9,10,11"), "INVALID_SELECTION"),
    "more than ten picks must fail",
  );
  assert(
    throwsInput(() => validateKenoOutcome({ drawn: drawn.slice(0, 19) }), "INVALID_OUTCOME"),
    "19-ball result must fail the explicitly provisional current-Unity review envelope",
  );
});

Deno.test("Lucky 8 uses the client line order and reports chart components without combining them", () => {
  const selection = normalizeLucky8Selection({ line_stakes: [5, 0, 0, 0, 0, 0, 0, 0] });
  const outcome = validateLucky8Outcome({
    grid: [
      ["orange", "jj", "banana"],
      ["mango", "jj", "apple"],
      ["cherry", "jj", "coconut"],
    ],
  });
  const inspected = inspectLucky8Outcome(outcome, selection);
  const lineOne = inspected.line_components.find((component) => component.line === 1);
  assert(lineOne?.symbol === "jj" && lineOne.published_multiplier === 94.7323, "line one must be the middle row at the scaled X100 chart value");
  assert(lineOne.staked_points === 5, "line stake identity must be retained");
  assert(inspected.payout_points === null, "published strip must not become settlement");
  assert(
    throwsInput(() => normalizeLucky8Selection({ line_stakes: [5, 0, 0] }), "INVALID_SELECTION"),
    "wrong line count must fail",
  );
  assert(
    throwsInput(() => validateLucky8Outcome({ grid: [["jj"], ["jj"], ["jj"]] }), "INVALID_OUTCOME"),
    "wrong grid shape must fail",
  );
});

Deno.test("Lucky 8 keeps all-nine, line and Funrep components independent", () => {
  const everyLine = normalizeLucky8Selection({ line_stakes: [1, 1, 1, 1, 1, 1, 1, 1] });
  const cherries = validateLucky8Outcome({
    grid: [
      ["cherry", "cherry", "cherry"],
      ["cherry", "cherry", "cherry"],
      ["cherry", "cherry", "cherry"],
    ],
  });
  const cherryInspection = inspectLucky8Outcome(cherries, everyLine);
  assert(cherryInspection.all_nine_symbol === "cherry", "all-nine symbol is wrong");
  assert(cherryInspection.published_all_nine_multiplier === 47.3662, "all-nine chart value is wrong (the 50x chart row scaled by 0.9473231)");
  assert(cherryInspection.line_components.length === 8, "all eight cherry lines must remain visible as components");
  assert(cherryInspection.line_components.every((component) => component.published_multiplier === 7.5786), "line chart value is wrong (the 8x chart row scaled by 0.9473231)");

  const funrep = validateLucky8Outcome({
    grid: [
      ["funrep", "orange", "banana"],
      ["mango", "funrep", "apple"],
      ["cherry", "jj", "coconut"],
    ],
  });
  const funrepInspection = inspectLucky8Outcome(funrep, everyLine);
  assert(funrepInspection.funrep_count === 2 && funrepInspection.published_funrep_multiplier === 1.8946, "Funrep chart is wrong (the 2x chart row scaled by 0.9473231)");
  assert(funrepInspection.payout_points === null, "Funrep evidence must remain non-settling");
});

Deno.test("live manifests carry no blockers and only execute observed actions", () => {
  for (const resolver of Object.values(WHEEL_DRAW_REVIEW_RESOLVERS)) {
    const slug = resolver.manifest.catalog_slug;
    assert(resolver.manifest.blockers.length === 0, `${slug} still carries blockers`);
    assert(resolver.manifest.action_policy.executable.length > 0, `${slug} must admit an action`);
    assert(
      resolver.manifest.action_policy.executable.every((action) =>
        resolver.manifest.action_policy.observed.includes(action)
      ),
      `${slug} may only execute actions it also observes`,
    );
    assert(
      typeof resolver.generateOutcome === "function" && typeof resolver.settle === "function",
      `${slug} must generate and settle`,
    );
  }
  for (
    const resolver of [
      TRIPLE_FUN_RESOLVER,
      GIANT_JACKPOT_RESOLVER,
      GOLDEN_WHEEL_RESOLVER,
      LUCKY_8_LINE_RESOLVER,
    ]
  ) {
    assert(resolver.manifest.readiness === "READY", `${resolver.manifest.catalog_slug} must be READY`);
    assert(resolver.manifest.ruleset_version === 1, `${resolver.manifest.catalog_slug} must be ruleset v1`);
  }
});
