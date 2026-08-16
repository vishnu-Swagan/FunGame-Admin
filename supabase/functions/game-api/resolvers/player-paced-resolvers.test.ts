import {
  assertFailClosedResolver,
  ResolverInputError,
  ResolverNotReadyError,
  requireExecutableResolver,
  type ReviewResolverModule,
} from "./resolver-contract.ts";
import {
  CHAMPION_POKER_RESOLVER,
  classifyChampionPokerHand,
  inspectChampionPokerOutcome,
  validateChampionPokerOutcome,
} from "./champion-poker.ts";
import {
  JOKER_BONUS_RESOLVER,
  classifyJokerBonusHand,
  inspectJokerBonusOutcome,
  validateJokerBonusOutcome,
} from "./joker-bonus.ts";
import {
  FEVER_JOKER_BONUS_RESOLVER,
  classifyFeverJokerBonusHand,
  inspectFeverJokerBonusOutcome,
  validateFeverJokerBonusOutcome,
} from "./fever-joker-bonus.ts";
import {
  NO_HOLD_RESOLVER,
  classifyNoHoldHand,
  inspectNoHoldOutcome,
  validateNoHoldOutcome,
} from "./no-hold.ts";
import {
  CHECKER_BASE_SELECTION_LADDER,
  CHECKER_FACE_LADDER,
  CHECKER_RESOLVER,
  inspectCheckerOutcome,
  validateCheckerOutcome,
} from "./checker.ts";

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

type TestFunction = () => void | Promise<void>;
const deno = (globalThis as unknown as { Deno?: { test: (name: string, callback: TestFunction) => void } }).Deno;
const test = deno?.test.bind(deno) || ((name: string, callback: TestFunction): void => {
  const result = callback();
  if (result instanceof Promise) {
    throw new Error(`Node fallback only supports synchronous test '${name}'.`);
  }
  console.log(`PASS ${name}`);
});

const PLAYER_PACED_RESOLVERS = [
  CHAMPION_POKER_RESOLVER,
  JOKER_BONUS_RESOLVER,
  FEVER_JOKER_BONUS_RESOLVER,
  NO_HOLD_RESOLVER,
  CHECKER_RESOLVER,
] as const;

test("five single-player resolvers are virtual-point-only and executable", () => {
  for (const resolver of PLAYER_PACED_RESOLVERS) {
    const slug = resolver.manifest.catalog_slug;
    const erased = resolver as unknown as ReviewResolverModule<unknown, unknown, unknown>;
    // Must pass the live gate outright: READY, registered id, ruleset v1,
    // verified timing and settlement, no blockers, both functions present.
    requireExecutableResolver(erased);
    assert(resolver.manifest.virtual_points_only, `${slug} must use virtual points only`);
    assert(resolver.manifest.settlement.unit === "VIRTUAL_POINTS", `${slug} settlement unit must be points`);
    assert(resolver.manifest.timing.mode === "PLAYER_PACED", `${slug} must be single-player`);
    assert(resolver.manifest.action_policy.executable.length > 0, `${slug} must expose an executable action`);
    assert(
      resolver.manifest.action_policy.executable.every((action) =>
        resolver.manifest.action_policy.observed.includes(action)
      ),
      `${slug} may only execute actions it also observes`,
    );
    // The two draw cabinets price the server's own reference draw. Advertising
    // hold election as executable while settle() does not price it would make
    // the game player-positive under optimal play.
    assert(
      !resolver.manifest.action_policy.executable.includes("hold"),
      `${slug} must not advertise player-elected holds as executable`,
    );
    assert(resolver.deterministicVectors.length > 0, "every title needs review vectors");
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

test("Champion Poker recomputes category and rejects impossible hold/deck claims", () => {
  const outcome = validateChampionPokerOutcome({
    kind: "champion_poker_hand",
    initial: ["JS", "JH", "3D", "7C", "9S"],
    holds: [true, true, true, true, true],
    final: ["JS", "JH", "3D", "7C", "9S"],
    category: "high_pair",
    payout_multiplier: 0.9528,
  });
  assert(outcome.category === "high_pair", "jacks must classify as the visible high-pair row");
  const inspection = inspectChampionPokerOutcome(outcome, "hand");
  assert(inspection.recovered_paytable_multiplier === 0.9528, "recovered high-pair display row drifted (the cabinet's 1x shape scaled by 0.9527671)");
  assert(inspection.payout_points === null, "blocked Champion Poker must not calculate a points payout");
  assert(classifyChampionPokerHand(["JOKER", "JOKER", "JOKER", "JOKER", "JOKER"]) === "fun_game", "five jokers must be Fun Game");
  assert(
    throwsInputCode(() => validateChampionPokerOutcome({
      ...outcome,
      final: ["QS", "JH", "3D", "7C", "9S"],
      category: "no_win",
      payout_multiplier: 0,
    }), "INVALID_OUTCOME"),
    "a held card replacement must fail",
  );
});

test("Joker Bonus validates the ten-row cabinet without inventing a five-kind row", () => {
  assert(classifyJokerBonusHand(["5H", "6H", "7H", "8H", "9H"]) === "straight_flush", "straight flush classification failed");
  assert(classifyJokerBonusHand(["4S", "4H", "7D", "9C", "KS"]) === "no_win", "low pair must not be Jacks Better");
  const outcome = validateJokerBonusOutcome({
    kind: "joker_bonus_hand",
    initial: ["5H", "6H", "7H", "8H", "9H"],
    holds: [true, true, true, true, true],
    final: ["5H", "6H", "7H", "8H", "9H"],
    category: "straight_flush",
    payout_multiplier: 141.773171,
  });
  const inspection = inspectJokerBonusOutcome(outcome, "hand");
  assert(
    inspection.recovered_paytable_multiplier === 141.773171,
    "Joker Bonus display row drifted (the cabinet's 150x shape scaled by 0.945154471)",
  );
  assert(inspection.payout_points === null, "blocked Joker Bonus must not calculate a points payout");
  assert(
    throwsInputCode(() => validateJokerBonusOutcome({
      kind: "joker_bonus_hand",
      initial: ["5H", "6H", "7H", "8H", "9H"],
      holds: [true, true, true, true, true],
      final: ["5H", "6H", "7H", "8H", "9H"],
      category: "straight_flush",
      payout_multiplier: 100,
    }), "INVALID_OUTCOME"),
    "client multiplier claims cannot override the recovered row",
  );
});

test("Fever Joker Bonus preserves STAR FLUSH as the cabinet's scaled 150x row", () => {
  assert(classifyFeverJokerBonusHand(["5C", "6C", "7C", "8C", "9C"]) === "star_flush", "STAR FLUSH classification failed");
  const outcome = validateFeverJokerBonusOutcome({
    kind: "fever_joker_bonus_hand",
    initial: ["5C", "6C", "7C", "8C", "9C"],
    holds: [true, true, true, true, true],
    final: ["5C", "6C", "7C", "8C", "9C"],
    category: "star_flush",
    payout_multiplier: 142.5885,
  });
  const inspection = inspectFeverJokerBonusOutcome(outcome, "hand");
  assert(inspection.recovered_paytable_multiplier === 142.5885, "Fever Joker Bonus row drifted (the cabinet's 150x shape scaled by 0.9505901)");
  assert(inspection.payout_points === null, "blocked Fever Joker Bonus must not calculate a points payout");
});

test("No Hold uses one drawless hand and its independently recovered ladder", () => {
  const outcome = validateNoHoldOutcome({
    kind: "no_hold_hand",
    cards: ["9S", "9H", "9D", "9C", "2S"],
    category: "four_of_a_kind",
    payout_multiplier: 38.0559,
  });
  assert(classifyNoHoldHand(outcome.cards) === "four_of_a_kind", "No Hold four-kind classification failed");
  const inspection = inspectNoHoldOutcome(outcome, "hand");
  assert(inspection.recovered_paytable_multiplier === 38.0559, "No Hold recovered display row drifted (the cabinet's 40x shape scaled by 0.9513978)");
  assert(inspection.payout_points === null, "blocked No Hold must not calculate a points payout");
  assert(
    throwsInputCode(() => validateNoHoldOutcome({ ...outcome, cards: ["9S", "9S", "9D", "9C", "2S"] }), "INVALID_OUTCOME"),
    "a standard card cannot be drawn twice",
  );
});

test("Checker pins the base ladders and observed D-suffix evidence but not server settlement", () => {
  assert(CHECKER_FACE_LADDER.length === 47, "ChBhavArray length drifted");
  assert(CHECKER_BASE_SELECTION_LADDER.length === 128, "base ChSCBhavArray length drifted");
  const doubled = validateCheckerOutcome({
    kind: "checker_two_ring",
    outer: 1,
    inner: 3,
    multiplier: 25,
    doubled: true,
  });
  const matched = inspectCheckerOutcome(doubled, "cell:1-3");
  assert(matched.matched && matched.observed_total_return_multiplier === 50, "D suffix evidence must preserve twice the belly face");
  assert(matched.payout_points === null, "blocked Checker must not calculate a points payout");
  const unmatched = inspectCheckerOutcome(doubled, "cell:2-2");
  assert(!unmatched.matched && unmatched.payout_points === null, "unmatched evidence must remain unpriced");
  assert(
    throwsInputCode(() => validateCheckerOutcome({
      kind: "checker_two_ring",
      outer: 1,
      inner: 1,
      multiplier: 500,
      doubled: true,
    }), "INVALID_OUTCOME"),
    "an outcome absent from the recovered base ladder must fail",
  );
});
