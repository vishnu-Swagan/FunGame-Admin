import {
  clockState,
  GAME_SPECS,
  GameRuleError,
  gameSpec,
  generateServerOutcome,
  normalizePlayerAction,
  rouletteMultiplier,
  settleReviewedWager,
  validateSelection,
} from "./game-core.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function throwsCode(callback: () => unknown, code: string): boolean {
  try {
    callback();
    return false;
  } catch (error) {
    return error instanceof GameRuleError && error.code === code;
  }
}

Deno.test("canonical catalog has all 15 client-to-Unity mappings", () => {
  assert(GAME_SPECS.length === 15, "catalog must contain exactly fifteen cabinets");
  const roulette = gameSpec("fun-roulette");
  assert(roulette.unity_lobby_slug === "roulette", "roulette tile mapping is wrong");
  assert(roulette.unity_scene === "fun-roulette", "roulette scene mapping is wrong");
  assert(roulette.engine_slug === "fun-roulette", "roulette engine mapping is wrong");
  assert(gameSpec("fun-ab").unity_scene === "andar-bahar", "Fun AB scene mapping is wrong");
  assert(gameSpec("golden-wheel").engine_slug === "super-golden-wheel", "Golden Wheel engine mapping is wrong");
  assert(gameSpec("joker-bonus").unity_scene === "fever-joker", "Joker Bonus cross-over mapping is wrong");
  assert(gameSpec("fever-joker-bonus").unity_lobby_slug === "fever-joker", "Fever Joker tile mapping is wrong");
});

Deno.test("roulette clock preserves open/lock/reveal/result boundaries", () => {
  const roulette = gameSpec("fun-roulette");
  const open = clockState(roulette, 33_999);
  assert(open.phase === "BETTING" && open.bets_open, "roulette should accept at 00:34");
  const locked = clockState(roulette, 34_000);
  assert(locked.phase === "BETTING" && !locked.bets_open, "roulette must lock while its betting phase remains visible");
  const reveal = clockState(roulette, 45_000);
  assert(reveal.phase === "REVEAL", "roulette reveal must start after 45 seconds");
  const result = clockState(roulette, 56_000);
  assert(result.phase === "RESULT", "roulette result must start after 56 seconds");
  const next = clockState(roulette, 60_000);
  assert(next.round_number === 1 && next.phase === "BETTING", "roulette must begin a new 60-second shared round");
});

Deno.test("roulette validates and settles only Unity-whitelisted positions", () => {
  const roulette = gameSpec("fun-roulette");
  const normalized = validateSelection(roulette, "split:3-2");
  assert(normalized === "split:2-3", "split must be canonicalized before persistence");
  assert(rouletteMultiplier(normalized, "2") === 18, "split should return 18x total");
  const payout = settleReviewedWager(
    roulette,
    normalized,
    5,
    { kind: "american_roulette", pocket: "2", color: "black" },
  );
  assert(payout === 90, "roulette payout must use the server-stored pocket");
  assert(
    throwsCode(() => validateSelection(roulette, "split:1-36"), "INVALID_SELECTION"),
    "an impossible split must fail closed",
  );
});

Deno.test("the known zero-end mismatch is not silently reinterpreted", () => {
  const roulette = gameSpec("fun-roulette");
  // This is the engine whitelist's documented shape.  A UI geometry mismatch
  // is a parity blocker in the catalog, not a reason to relabel a player bet.
  assert(validateSelection(roulette, "split:00-0") === "split:0-00", "0/00 split must normalize safely");
  assert(
    throwsCode(() => validateSelection(roulette, "split:00-3"), "INVALID_SELECTION"),
    "unwhitelisted zero-end split must not be guessed into another bet",
  );
});

Deno.test("unobserved Fun Target and Keno payout rules cannot settle", () => {
  const target = gameSpec("fun-target");
  const keno = gameSpec("keno");
  assert(validateSelection(target, "number:7") === "number:7", "Fun Target digit validation should remain available for review");
  assert(validateSelection(keno, "pick:1,4,80") === "picks:1,4,80", "Keno picks should normalize to one wire form");
  assert(
    throwsCode(
      () => settleReviewedWager(target, "number:7", 5, { kind: "digit_wheel", digit: 7 }),
      "RULES_NOT_VERIFIED",
    ),
    "Fun Target cannot pay an inferred multiplier",
  );
  assert(
    throwsCode(
      () => settleReviewedWager(keno, "picks:1,4,80", 5, { kind: "keno_80_of_20", drawn: [1, 4, 80] }),
      "RULES_NOT_VERIFIED",
    ),
    "Keno cannot pay an unobserved paytable",
  );
});

Deno.test("server outcome generators use only server-supplied entropy", () => {
  const sequence = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const random = (max: number) => {
    const value = sequence.shift();
    assert(value !== undefined && value >= 0 && value < max, "test entropy is invalid");
    return value;
  };
  const roulette = generateServerOutcome(gameSpec("fun-roulette"), random);
  assert(roulette.kind === "american_roulette" && roulette.pocket === "0", "roulette outcome source is wrong");
  const keno = generateServerOutcome(gameSpec("keno"), random);
  assert(keno.kind === "keno_80_of_20" && keno.drawn.length === 20, "Keno draw shape is wrong");
  assert(new Set(keno.drawn).size === 20, "Keno draw must be without replacement");
});

Deno.test("Unity wire action normalization refuses outcome and balance semantics", () => {
  const roulette = gameSpec("fun-roulette");
  const stake = normalizePlayerAction(roulette, "place_bet", { selection: "straight:17", amount: 10 });
  assert(stake.selection === "straight:17" && stake.amount === 10, "stake intent should be normalized");
  assert(stake.internal_action === "stake", "wire action must map to the server stake intent");
  assert(
    throwsCode(() => normalizePlayerAction(roulette, "place_bet", { selection: "straight:17", amount: 0 }), "INVALID_STAKE"),
    "zero stake must be rejected",
  );
  assert(
    throwsCode(() => normalizePlayerAction(roulette, "deal", {}), "UNSUPPORTED_ACTION"),
    "clocked roulette cannot accept a client deal command",
  );
});

Deno.test("Unity hold, release, and cash-out aliases retain server-only semantics", () => {
  const champion = gameSpec("champion-poker");
  const hold = normalizePlayerAction(champion, "hold", { selection: "2" });
  const release = normalizePlayerAction(champion, "release", { selection: "2" });
  assert(hold.internal_action === "set_hold" && hold.held && hold.hold_index === 2, "hold alias is wrong");
  assert(release.internal_action === "set_hold" && !release.held && release.hold_index === 2, "release alias is wrong");
  assert(
    throwsCode(() => normalizePlayerAction(champion, "cash_out", { selection: "panel1" }), "UNSUPPORTED_ACTION"),
    "a non-Aviator cabinet cannot acquire cash-out from a client request",
  );
});
