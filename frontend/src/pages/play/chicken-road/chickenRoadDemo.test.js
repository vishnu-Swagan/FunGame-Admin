import {
  cashOutCents,
  createDemoState,
  currentMultiplier,
  DIFFICULTIES,
  MAX_STAKE_CENTS,
  MEDIUM_MULTIPLIERS,
  MIN_STAKE_CENTS,
  transitionDemoState,
} from "./chickenRoadDemo";

const play = (state, stakeCents = 300, difficulty = "medium") => transitionDemoState(state, {
  type: "PLAY", stakeCents, difficulty,
});
const hop = (state) => transitionDemoState(state, { type: "HOP" });
const cashOut = (state) => transitionDemoState(state, { type: "CASH_OUT" });
const reset = (state) => transitionDemoState(state, { type: "RESET" });

function finishRound(state) {
  let next = state;
  while (next.phase === "playing") next = hop(next);
  return next;
}

function freezeDeep(value) {
  Object.values(value).forEach((child) => {
    if (child && typeof child === "object") freezeDeep(child);
  });
  return Object.freeze(value);
}

test("initial balance is converted to integer demo-credit hundredths", () => {
  expect(createDemoState()).toMatchObject({
    phase: "idle", balanceCents: 100000, stakeCents: 0, payoutCents: 0,
    lane: 0, roundNumber: 0, history: [],
  });
  expect(createDemoState(25.75).balanceCents).toBe(2575);
  expect(currentMultiplier(createDemoState())).toBe(1);
  expect(cashOutCents(createDemoState())).toBe(0);
});

test.each([-1, NaN, Infinity, "1000", Symbol("balance"), Number.MAX_VALUE])("invalid starting balance %p is rejected", (balance) => {
  expect(() => createDemoState(balance)).toThrow(RangeError);
});

test("PLAY deducts one stake and attempts the first lane immediately", () => {
  const state = play(createDemoState());
  expect(state).toMatchObject({ phase: "playing", balanceCents: 99700, stakeCents: 300, lane: 1, roundNumber: 1 });
  expect(currentMultiplier(state)).toBe(1.12);
  expect(cashOutCents(state)).toBe(336);
  expect(play(state)).toBe(state);
  expect(hop(state).balanceCents).toBe(99700);
});

test("cash-out credits the full payout exactly once and records one result", () => {
  const result = cashOut(play(createDemoState()));
  expect(result).toMatchObject({ phase: "cashed_out", balanceCents: 100036, payoutCents: 336, lane: 1 });
  expect(result.history).toEqual([{
    roundNumber: 1, phase: "cashed_out", difficulty: "medium", lane: 1,
    stakeCents: 300, payoutCents: 336, multiplier: 1.12,
  }]);
  expect(cashOut(result)).toBe(result);
  expect(cashOutCents(result)).toBe(0);
});

test("payout floors fractional hundredths with exact integer multiplier arithmetic", () => {
  let state = play(createDemoState(), 101);
  expect(cashOutCents(state)).toBe(113);
  state = hop(hop(hop(state)));
  expect(state.lane).toBe(4);
  expect(currentMultiplier(state)).toBe(1.70);
  expect(cashOutCents(state)).toBe(171);
  expect(cashOut(state).payoutCents).toBe(171);
});

test("scripted collision forfeits the stake without subtracting it again", () => {
  const result = finishRound(play(createDemoState()));
  expect(result).toMatchObject({ phase: "crashed", lane: 6, balanceCents: 99700, payoutCents: 0 });
  expect(result.history).toHaveLength(1);
  expect(result.history[0]).toMatchObject({ phase: "crashed", lane: 6, payoutCents: 0, multiplier: 0 });
  expect(currentMultiplier(result)).toBe(0);
  expect(cashOutCents(result)).toBe(0);
});

test.each(["crashed", "cashed_out"])("%s rounds ignore further PLAY, HOP, and CASH_OUT actions", (phase) => {
  const active = play(createDemoState());
  const terminal = phase === "crashed" ? finishRound(active) : cashOut(active);
  expect(play(terminal)).toBe(terminal);
  expect(hop(terminal)).toBe(terminal);
  expect(cashOut(terminal)).toBe(terminal);
});

test.each([-300, 0, MIN_STAKE_CENTS - 1, 100.5, NaN, Infinity, "300", Symbol("stake"), null, undefined, MAX_STAKE_CENTS + 1])(
  "invalid stake %p leaves the exact state unchanged",
  (stakeCents) => {
    const state = createDemoState(20000);
    expect(transitionDemoState(state, { type: "PLAY", stakeCents, difficulty: "medium" })).toBe(state);
  },
);

test("stakes above the balance are rejected and the exact available balance can be staked", () => {
  const state = createDemoState(3);
  expect(play(state, 301)).toBe(state);
  expect(play(state, 300).balanceCents).toBe(0);
  expect(play(createDemoState(20000), MAX_STAKE_CENTS).stakeCents).toBe(MAX_STAKE_CENTS);
  expect(play(createDemoState(1), MIN_STAKE_CENTS).stakeCents).toBe(MIN_STAKE_CENTS);
});

test.each(["easy", "hard", "hardcore", "unknown", "Medium", undefined])("unsupported difficulty %p cannot start a round", (difficulty) => {
  const state = createDemoState();
  expect(transitionDemoState(state, { type: "PLAY", stakeCents: 300, difficulty })).toBe(state);
});

test("only the captured Medium difficulty is supported", () => {
  expect(DIFFICULTIES.map(({ id }) => id)).toEqual(["easy", "medium", "hard", "hardcore"]);
  expect(DIFFICULTIES.filter(({ supported }) => supported).map(({ id }) => id)).toEqual(["medium"]);
  expect(MEDIUM_MULTIPLIERS).toEqual([1.12, 1.28, 1.47, 1.70, 1.98, 2.33, 2.76, 3.32, 4.03, 4.96, 6.20, 6.91, 8.90]);
});

test("the explicit collision script repeats and round four auto-cashes the final captured lane", () => {
  let state = createDemoState();
  const outcomes = [];
  for (let round = 1; round <= 5; round += 1) {
    state = finishRound(play(state));
    outcomes.push({ phase: state.phase, lane: state.lane, payoutCents: state.payoutCents });
    expect(state.roundNumber).toBe(round);
    expect(state.history).toHaveLength(round);
    state = reset(state);
  }
  expect(outcomes).toEqual([
    { phase: "crashed", lane: 6, payoutCents: 0 },
    { phase: "crashed", lane: 1, payoutCents: 0 },
    { phase: "crashed", lane: 4, payoutCents: 0 },
    { phase: "cashed_out", lane: MEDIUM_MULTIPLIERS.length, payoutCents: 2670 },
    { phase: "crashed", lane: 6, payoutCents: 0 },
  ]);
  expect(state.balanceCents).toBe(100000 - 5 * 300 + 2670);
});

test("RESET cannot abandon an active round or mint credits on repeated resets", () => {
  const initial = createDemoState();
  expect(reset(initial)).toBe(initial);
  const active = play(initial);
  expect(reset(active)).toBe(active);
  const result = cashOut(active);
  const cleared = reset(result);
  expect(cleared).toMatchObject({ phase: "idle", lane: 0, stakeCents: 0, payoutCents: 0, balanceCents: 100036, roundNumber: 1 });
  expect(cleared.history).toBe(result.history);
  expect(reset(cleared)).toBe(cleared);
  const nextRound = play(cleared);
  expect(nextRound).toMatchObject({ phase: "crashed", lane: 1, balanceCents: 99736, roundNumber: 2 });
});

test("idle and unknown actions are harmless no-ops", () => {
  const state = createDemoState();
  expect(hop(state)).toBe(state);
  expect(cashOut(state)).toBe(state);
  expect(transitionDemoState(state, { type: "UNKNOWN" })).toBe(state);
  expect(transitionDemoState(state, null)).toBe(state);
});

test("transitions never mutate input state, history, or earlier results", () => {
  const initial = freezeDeep(createDemoState());
  const active = freezeDeep(play(initial));
  const result = freezeDeep(cashOut(active));
  const cleared = freezeDeep(reset(result));
  const nextResult = play(cleared);
  expect(initial).toMatchObject({ balanceCents: 100000, lane: 0, history: [] });
  expect(active).toMatchObject({ phase: "playing", balanceCents: 99700, history: [] });
  expect(result.history).toHaveLength(1);
  expect(cleared.history).toHaveLength(1);
  expect(nextResult.history).toHaveLength(2);
  expect(nextResult.history).not.toBe(cleared.history);
  expect(createDemoState().history).not.toBe(initial.history);
});
