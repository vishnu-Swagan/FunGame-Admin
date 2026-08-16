import {
  assertFailClosedResolver,
  rejectCashLikeFields,
  ResolverInputError,
  ResolverNotReadyError,
  requireExecutableResolver,
  type ReviewResolverModule,
} from "./resolver-contract.ts";
import {
  SEVEN_UP_SEVEN_DOWN_RESOLVER,
  normalizeSevenUpDownSelection,
  sevenUpDownStake,
  validateSevenUpDownOutcome,
} from "./seven-up-seven-down.ts";
import {
  FUN_AB_RESOLVER,
  funAbStake,
  inspectFunAbOutcome,
  normalizeFunAbSelection,
  validateFunAbOutcome,
} from "./fun-ab.ts";
import {
  FUN_ROULETTE_RESOLVER,
  funRouletteStake,
  inspectFunRouletteOutcome,
  normalizeFunRouletteSelection,
  validateFunRouletteOutcome,
} from "./fun-roulette.ts";
import {
  FUN_TARGET_RESOLVER,
  funTargetStake,
  inspectFunTargetOutcome,
  normalizeFunTargetSelection,
  validateFunTargetOutcome,
} from "./fun-target.ts";
import {
  BINGO_CARDS,
  BINGO_RESOLVER,
  bingoStake,
  countBingoLines,
  inspectBingoOutcome,
  normalizeBingoSelection,
  validateBingoOutcome,
} from "./bingo.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function throwsInputCode(callback: () => unknown, code: ResolverInputError["code"]): boolean {
  try {
    callback();
    return false;
  } catch (error) {
    return error instanceof ResolverInputError && error.code === code;
  }
}

const TABLE_RESOLVERS = [
  SEVEN_UP_SEVEN_DOWN_RESOLVER,
  FUN_AB_RESOLVER,
  FUN_ROULETTE_RESOLVER,
  FUN_TARGET_RESOLVER,
  BINGO_RESOLVER,
] as const;

Deno.test("five table modules are virtual-point-only and executable", () => {
  for (const resolver of TABLE_RESOLVERS) {
    const slug = resolver.manifest.catalog_slug;
    const erased = resolver as unknown as ReviewResolverModule<unknown, unknown, unknown>;
    // Must pass the live gate outright: READY, registered id, ruleset v1,
    // verified timing and settlement, no blockers, both functions present.
    requireExecutableResolver(erased);
    assert(resolver.manifest.virtual_points_only === true, `${slug} must be virtual only`);
    assert(resolver.manifest.settlement.unit === "VIRTUAL_POINTS", "settlement unit must be points");
    assert(
      resolver.manifest.settlement.payout_semantics === "TOTAL_RETURN",
      `${slug} must settle as a total return`,
    );
    assert(resolver.manifest.action_policy.executable.length > 0, `${slug} must expose an executable action`);
    assert(
      resolver.manifest.action_policy.executable.every((action) =>
        resolver.manifest.action_policy.observed.includes(action)
      ),
      `${slug} may only execute actions it also observes`,
    );
    assert(resolver.deterministicVectors.length > 0, "every resolver needs deterministic vectors");
    // The gate must still refuse an unregistered module. Ruleset-to-registry
    // agreement is a separate key, checked in review-registry.test.ts; here we
    // prove the gate itself rejects a missing live identity rather than
    // waving a READY manifest through.
    let refusedUnregistered = false;
    try {
      requireExecutableResolver({
        ...erased,
        manifest: { ...resolver.manifest, live_resolver_id: null },
      } as ReviewResolverModule<unknown, unknown, unknown>);
    } catch (error) {
      refusedUnregistered = error instanceof ResolverNotReadyError;
    }
    assert(refusedUnregistered, `${slug} must refuse a module with no live resolver id`);
  }
});

Deno.test("resolver contract rejects cash, deposit, payment and currency fields", () => {
  for (const key of ["cash", "deposit", "payment", "currency", "INR", "withdrawal"]) {
    assert(
      throwsInputCode(() => rejectCashLikeFields({ [key]: 10 }), "NON_VIRTUAL_VALUE"),
      `${key} must be rejected`,
    );
  }
  rejectCashLikeFields({ stake_points: 10, selection: "up" });
});

Deno.test("7Up7Down validates the one-card result and only inspects the 1.95x direction price", () => {
  assert(normalizeSevenUpDownSelection("up") === "up", "up should normalize");
  assert(throwsInputCode(() => normalizeSevenUpDownSelection("seven"), "INVALID_SELECTION"), "seven is not a wager");
  assert(sevenUpDownStake(5) === 5, "minimum stake should pass");
  assert(throwsInputCode(() => sevenUpDownStake(4), "INVALID_STAKE"), "below-minimum stake must fail");

  const up = validateSevenUpDownOutcome({
    kind: "seven_up_down_card",
    card: "9D",
    winner: "up",
    lost_on_seven: false,
  });
  const upInspection = SEVEN_UP_SEVEN_DOWN_RESOLVER.inspectOutcome(up, "up");
  assert(upInspection.matched && upInspection.directional_total_return_multiplier === 1.95,
    "the directional price must surface as inspection evidence only");

  const seven = validateSevenUpDownOutcome({
    kind: "seven_up_down_card",
    card: "7S",
    winner: "seven",
    lost_on_seven: true,
  });
  assert(!SEVEN_UP_SEVEN_DOWN_RESOLVER.inspectOutcome(seven, "down").matched,
    "seven must lose both directions without exposing a settlement helper");
  assert(
    throwsInputCode(
      () => validateSevenUpDownOutcome({ kind: "seven_up_down_card", card: "7S", winner: "down", lost_on_seven: false }),
      "INVALID_OUTCOME",
    ),
    "client-supplied winner fields cannot contradict the card",
  );
});

Deno.test("Fun AB enforces deck uniqueness, Andar-first alternation and terminal rank match", () => {
  const outcome = validateFunAbOutcome({
    kind: "andar_bahar",
    joker: "7H",
    sequence: [
      { card: "3C", side: "andar" },
      { card: "7D", side: "bahar" },
    ],
    winner: "bahar",
  });
  const bahar = normalizeFunAbSelection("bahar");
  const inspection = inspectFunAbOutcome(outcome, bahar);
  assert(inspection.matched && inspection.local_review_total_return_multiplier === 1.8556,
    "Bahar must report its own ruleset v1 side price of 1.8556, distinct from Andar's 1.7476");
  assert(funAbStake(10000, bahar) === 10000, "whole-point review stake should validate");
  const rank = normalizeFunAbSelection("rank-7");
  assert(funAbStake(1001, rank) === 1001, "an unproved rank ceiling must not be invented");
  assert(throwsInputCode(() => funAbStake(10, "unknown"), "INVALID_SELECTION"),
    "stake validation must normalize its selection at runtime");
  assert(inspectFunAbOutcome(outcome, rank).matched, "joker rank should match the rank selection");
  assert(
    throwsInputCode(
      () => validateFunAbOutcome({
        kind: "andar_bahar",
        joker: "7H",
        sequence: [{ card: "7D", side: "andar" }, { card: "9S", side: "bahar" }],
        winner: "bahar",
      }),
      "INVALID_OUTCOME",
    ),
    "a matching rank before the final card must be rejected",
  );
});

Deno.test("Fun Roulette canonicalizes legal coverage and refuses unresolved zero-end placements", () => {
  const split = normalizeFunRouletteSelection("split:3-2");
  assert(split.canonical === "split:2-3", "split must have one canonical persistence key");
  assert(split.covered_pockets.length === 2, "split must cover exactly two pockets");
  const outcome = validateFunRouletteOutcome({ kind: "american_roulette", pocket: "2", color: "black" });
  assert(inspectFunRouletteOutcome(outcome, split).matched, "winning split coverage must match");
  assert(funRouletteStake(5) === 5, "roulette minimum stake should pass");
  assert(throwsInputCode(() => funRouletteStake(5001), "INVALID_STAKE"), "roulette maximum must be enforced");
  assert(
    throwsInputCode(() => normalizeFunRouletteSelection("split:00-3"), "INVALID_SELECTION"),
    "the disputed 00/3 physical edge must stay withheld",
  );
  assert(
    throwsInputCode(() => normalizeFunRouletteSelection("split:1-36"), "INVALID_SELECTION"),
    "nonadjacent split must be rejected",
  );
  assert(
    throwsInputCode(() => normalizeFunRouletteSelection("sector:toString"), "INVALID_SELECTION") &&
      throwsInputCode(() => normalizeFunRouletteSelection("toString:any"), "INVALID_SELECTION"),
    "prototype properties must not become roulette bet types or sectors",
  );
  assert(
    throwsInputCode(
      () => validateFunRouletteOutcome({ kind: "american_roulette", pocket: "2", color: "red" }),
      "INVALID_OUTCOME",
    ),
    "outcome color cannot contradict the pocket",
  );
});

Deno.test("Fun Target validates digit intent and outcome but keeps payout unavailable", () => {
  const selection = normalizeFunTargetSelection("number:7");
  const outcome = validateFunTargetOutcome({ kind: "digit_wheel", digit: 7 });
  const inspection = inspectFunTargetOutcome(outcome, selection);
  assert(inspection.matched && inspection.payout_points === null, "digit match may not invent the 9x payout");
  assert(funTargetStake(5000) === 5000, "target maximum should pass");
  assert(throwsInputCode(() => normalizeFunTargetSelection("number:10"), "INVALID_SELECTION"), "digit 10 must fail");
  assert(
    throwsInputCode(() => validateFunTargetOutcome({ kind: "digit_wheel", digit: 1, payout: 9 }), "INVALID_OUTCOME"),
    "client payout fields must not enter the authoritative outcome",
  );
});

Deno.test("Bingo owns the six fixed cards and line inspection without pricing unknown rules", () => {
  assert(BINGO_CARDS.length === 6, "client has six fixed cards");
  for (const card of BINGO_CARDS) {
    const values = card.flat();
    assert(values.length === 25 && new Set(values).size === 25, "each fixed card must contain 1..25 once");
    assert(Math.min(...values) === 1 && Math.max(...values) === 25, "fixed card range is wrong");
  }
  const selection = normalizeBingoSelection("card:1");
  const outcome = validateBingoOutcome({ kind: "bingo_draw", drawn: [5, 1, 9, 25, 3] });
  const inspection = inspectBingoOutcome(outcome, selection);
  assert(inspection.completed_lines === 1 && inspection.payout_points === null, "one row must inspect without payout");
  assert(countBingoLines(1, [5, 1, 9, 25, 3]) === 1, "line helper must agree");
  assert(bingoStake(5) === 5, "bingo minimum should pass");
  assert(bingoStake(5001) === 5001, "a disputed Bingo maximum must not be invented by review code");
  const withG = validateBingoOutcome({ kind: "bingo_draw", drawn: [12, 19, 18, "G", 4] });
  assert(inspectBingoOutcome(withG, selection).contains_unresolved_g_ball, "G must be preserved but not priced");
  assert(
    throwsInputCode(() => validateBingoOutcome({ kind: "bingo_draw", drawn: [1, 1] }), "INVALID_OUTCOME"),
    "duplicate bingo balls must fail",
  );
  assert(throwsInputCode(() => normalizeBingoSelection("card:7"), "INVALID_SELECTION"), "seventh card must fail");
});
