import {
  clockState,
  compiledRuntimeContractFor,
  GAME_SPECS,
  GameRuleError,
  gameSpec,
  isRoundActionPrecondition,
  matchesPersistedGameActionReplay,
  matchesRoundActionPrecondition,
  normalizePlayerAction,
  normalizedActionRequest,
  publicClockWire,
  roundActionPrecondition,
  rouletteMultiplier,
  runtimeContractIssue,
  snapshotRevealSeconds,
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

Deno.test("canonical catalog has all 16 client-to-Unity mappings", () => {
  assert(GAME_SPECS.length === 16, "catalog must contain exactly sixteen cabinets");
  const roulette = gameSpec("fun-roulette");
  assert(roulette.unity_lobby_slug === "roulette", "roulette tile mapping is wrong");
  assert(roulette.unity_scene === "fun-roulette", "roulette scene mapping is wrong");
  assert(roulette.engine_slug === "fun-roulette", "roulette engine mapping is wrong");
  assert(gameSpec("fun-ab").unity_scene === "andar-bahar", "Fun AB scene mapping is wrong");
  assert(gameSpec("golden-wheel").engine_slug === "super-golden-wheel", "Golden Wheel engine mapping is wrong");
  assert(gameSpec("joker-bonus").unity_scene === "fever-joker", "Joker Bonus cross-over mapping is wrong");
  assert(gameSpec("fever-joker-bonus").unity_lobby_slug === "fever-joker", "Fever Joker tile mapping is wrong");
});

Deno.test("every database runtime must exactly match the compiled timing, outcome, ruleset, and stake contract", () => {
  for (const spec of GAME_SPECS) {
    const expected = compiledRuntimeContractFor(spec);
    assert(runtimeContractIssue(spec, expected) === null, `${spec.catalog_slug} static contract should be self-consistent`);
  }
  const roulette = gameSpec("fun-roulette");
  const expected = compiledRuntimeContractFor(roulette);
  assert(
    runtimeContractIssue(roulette, { ...expected, ruleset_version: 2 }) === "ruleset_version",
    "a database ruleset label cannot outrun the deployed resolver contract",
  );
  assert(
    runtimeContractIssue(roulette, { ...expected, min_bet: 1 }) === "min_bet",
    "a database stake limit cannot undercut the compiled game limit",
  );
  assert(
    runtimeContractIssue(roulette, {
      ...expected,
      outcome_contract: { type: "american_roulette", pockets: 37, selection: "type:value" },
    }) === "outcome_contract",
    "a payout/outcome shape drift must close the runtime",
  );
  const checker = gameSpec("checker");
  const checkerContract = compiledRuntimeContractFor(checker);
  assert(
    runtimeContractIssue(checker, {
      ...checkerContract,
      timing: { ...checkerContract.timing, result_seconds: 3 },
    }) === "timing",
    "the known Checker player-paced timing drift must fail closed",
  );
});

Deno.test("roulette clock preserves open/lock/reveal/result boundaries", () => {
  const roulette = gameSpec("fun-roulette");
  const open = clockState(roulette, 33_999);
  assert(open.phase === "BETTING" && open.bets_open, "roulette should accept at 00:34");
  const openWire = publicClockWire(open);
  assert(openWire.bets_open === true && typeof openWire.bets_open === "boolean", "Unity must receive a strict server bets_open boolean");
  assert(
    openWire.server_time_unix_ms === 33_999 &&
      openWire.phase_ends_at_unix_ms > openWire.server_time_unix_ms &&
      Number.isSafeInteger(openWire.phase_ends_at_unix_ms),
    "Unity must receive numeric server time and an absolute phase deadline in epoch milliseconds",
  );
  const locked = clockState(roulette, 34_000);
  assert(locked.phase === "BETTING" && !locked.bets_open, "roulette must lock while its betting phase remains visible");
  assert(publicClockWire(locked).bets_open === false, "the wire flag must close exactly at the server lock boundary");
  const reveal = clockState(roulette, 45_000);
  assert(reveal.phase === "REVEAL", "roulette reveal must start after 45 seconds");
  const result = clockState(roulette, 56_000);
  assert(result.phase === "RESULT", "roulette result must start after 56 seconds");
  const next = clockState(roulette, 60_000);
  assert(next.round_number === 1 && next.phase === "BETTING", "roulette must begin a new 60-second shared round");
});

Deno.test("snapshot reveal duration stays fixed while phase time counts down", () => {
  const roulette = gameSpec("fun-roulette");
  const early = clockState(roulette, 45_100);
  const late = clockState(roulette, 54_900);
  assert(early.phase === "REVEAL" && late.phase === "REVEAL", "test samples must be inside reveal");
  assert(early.phase_ends_in_ms > late.phase_ends_in_ms, "phase clock should count down");
  assert(snapshotRevealSeconds(roulette) === 11, "roulette reveal needs its full approved duration");
  assert(snapshotRevealSeconds(roulette) !== early.phase_ends_in_ms / 1000
    && snapshotRevealSeconds(roulette) !== late.phase_ends_in_ms / 1000,
  "polling must not turn reveal duration into remaining time");
});

Deno.test("roulette validates only Unity-whitelisted review positions", () => {
  const roulette = gameSpec("fun-roulette");
  const normalized = validateSelection(roulette, "split:3-2");
  assert(normalized === "split:2-3", "split must be canonicalized before persistence");
  assert(rouletteMultiplier(normalized, "2") === 18, "split should return 18x total");
  assert(
    throwsCode(() => validateSelection(roulette, "split:1-36"), "INVALID_SELECTION"),
    "an impossible split must fail closed",
  );
  assert(
    throwsCode(() => validateSelection(roulette, "straight:17:ignored"), "INVALID_SELECTION"),
    "a roulette selection may not contain ignored suffix fields",
  );
  assert(
    throwsCode(() => rouletteMultiplier("split:2-3:ignored", "2"), "INVALID_SELECTION"),
    "settlement must reject an ignored roulette suffix too",
  );
  assert(
    throwsCode(() => validateSelection(roulette, "split:2-3-"), "INVALID_SELECTION"),
    "empty roulette number segments must not be ignored",
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

Deno.test("unobserved Fun Target and Keno selections remain validation-only", () => {
  const target = gameSpec("fun-target");
  const keno = gameSpec("keno");
  assert(validateSelection(target, "number:7") === "number:7", "Fun Target digit validation should remain available for review");
  assert(validateSelection(keno, "pick:1,4,80") === "picks:1,4,80", "Keno picks should normalize to one wire form");
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
    throwsCode(() => normalizePlayerAction(roulette, "place_bet", { selection: "straight:17", amount: 4 }), "INVALID_STAKE"),
    "a stake below the cabinet minimum must be rejected",
  );
  assert(
    throwsCode(() => normalizePlayerAction(roulette, "place_bet", { selection: "straight:17", amount: 5001 }), "INVALID_STAKE"),
    "a stake above the cabinet maximum must be rejected",
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

Deno.test("an accepted idempotent action matches before current-round admission", () => {
  const roulette = gameSpec("fun-roulette");
  const normalized = normalizePlayerAction(roulette, "place_bet", {
    selection: "split:3-2",
    amount: 10,
  });
  const request = normalizedActionRequest(normalized);
  const roundId = "2d2e4055-7f7a-4c88-a64d-436d273aaf56";
  const precondition = roundActionPrecondition(roundId);
  assert(request.selection === "split:2-3", "the persisted replay request must use the canonical marker");
  assert(
    matchesPersistedGameActionReplay(
      {
        session_id: "session-1",
        round_id: roundId,
        kind: "STAKE",
        status: "APPLIED",
        request: { amount: 10, selection: "split:2-3", action: "place_bet" },
      },
      "session-1",
      normalized.internal_action,
      request,
      precondition,
    ),
    "JSON key order must not prevent replaying the original immutable receipt",
  );
  assert(
    !matchesPersistedGameActionReplay(
      { session_id: "session-2", round_id: roundId, kind: "STAKE", status: "APPLIED", request },
      "session-1",
      normalized.internal_action,
      request,
      precondition,
    ),
    "a key from another session must remain a conflict",
  );
  assert(
    !matchesPersistedGameActionReplay(
      {
        session_id: "session-1",
        round_id: roundId,
        kind: "STAKE",
        status: "APPLIED",
        request: { ...request, amount: 20 },
      },
      "session-1",
      normalized.internal_action,
      request,
      precondition,
    ),
    "a key with a different canonical intent must remain a conflict",
  );
  assert(
    !matchesPersistedGameActionReplay(
      { session_id: "session-1", round_id: roundId, kind: "STAKE", status: "REJECTED", request },
      "session-1",
      normalized.internal_action,
      request,
      precondition,
    ),
    "a rejected action must never be acknowledged as an applied replay",
  );
});

Deno.test("round action preconditions reject stale first delivery but retain applied replay identity", () => {
  const firstRound = "2d2e4055-7f7a-4c88-a64d-436d273aaf56";
  const laterRound = "7cd77315-0eb5-4bc7-b939-d415601cc7f2";
  const precondition = roundActionPrecondition(firstRound);
  assert(isRoundActionPrecondition(precondition), "a server-issued round token must be wire-valid");
  assert(matchesRoundActionPrecondition(precondition, firstRound), "the issuing round must accept its token");
  assert(
    !matchesRoundActionPrecondition(precondition, laterRound),
    "an uncommitted retry must not acquire a later round",
  );
  assert(
    !isRoundActionPrecondition("round-v1_not-a-round"),
    "an invented token must fail request validation",
  );
  assert(
    !isRoundActionPrecondition("round-v1_7CD77315-0EB5-4BC7-B939-D415601CC7F2"),
    "the wire token must retain the server's canonical casing",
  );

  const request = { action: "place_bet", selection: "straight:17", amount: 10 };
  assert(
    matchesPersistedGameActionReplay(
      {
        session_id: "session-1",
        round_id: firstRound,
        kind: "STAKE",
        status: "APPLIED",
        request,
      },
      "session-1",
      "stake",
      request,
      precondition,
    ),
    "the original APPLIED receipt must reconcile after the clock advances",
  );
  assert(
    !matchesPersistedGameActionReplay(
      {
        session_id: "session-1",
        round_id: laterRound,
        kind: "STAKE",
        status: "APPLIED",
        request,
      },
      "session-1",
      "stake",
      request,
      precondition,
    ),
    "the same idempotency key cannot be rebound to another round receipt",
  );
});

Deno.test("typed player-paced selections survive canonical replay construction", () => {
  const champion = gameSpec("champion-poker");
  const hold = normalizedActionRequest(normalizePlayerAction(champion, "hold", { selection: "2" }));
  assert(hold.action === "hold" && hold.selection === "2", "hold replay must retain the validated card index");
});
