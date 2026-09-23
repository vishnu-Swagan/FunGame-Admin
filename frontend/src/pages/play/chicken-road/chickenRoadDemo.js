/**
 * REFERENCE DEMO ONLY — no wallet, API, random outcomes, or probability model.
 * These multipliers reproduce the Medium ladder visible in the supplied
 * recording. They do not describe verified odds or a production game engine.
 * Collision lanes repeat the explicit presentation script [6, 1, 4, 0];
 * zero means the chicken can traverse the entire captured ladder.
 */
export const MEDIUM_MULTIPLIERS = Object.freeze([
  1.12, 1.28, 1.47, 1.70, 1.98, 2.33, 2.76, 3.32, 4.03, 4.96, 6.20, 6.91, 8.90,
]);

export const DIFFICULTIES = Object.freeze([
  Object.freeze({ id: "easy", label: "Easy", supported: false }),
  Object.freeze({ id: "medium", label: "Medium", supported: true }),
  Object.freeze({ id: "hard", label: "Hard", supported: false }),
  Object.freeze({ id: "hardcore", label: "Hardcore", supported: false }),
]);

export const MIN_STAKE_CENTS = 100;
export const MAX_STAKE_CENTS = 1000000;

const SCRIPTED_COLLISION_LANES = Object.freeze([6, 1, 4, 0]);
const MULTIPLIER_HUNDREDTHS = MEDIUM_MULTIPLIERS.map((value) => Math.round(value * 100));

/** Initial balance is in demo credits; all stored amounts are integer hundredths. */
export function createDemoState(initialBalance = 1000) {
  const balanceCents = Number.isFinite(initialBalance) ? Math.round(initialBalance * 100) : NaN;
  if (!Number.isFinite(initialBalance) || initialBalance < 0 || !Number.isSafeInteger(balanceCents)) {
    throw new RangeError("Initial demo balance must be a finite, non-negative number of credits.");
  }
  return {
    phase: "idle",
    balanceCents,
    stakeCents: 0,
    payoutCents: 0,
    lane: 0,
    difficulty: "medium",
    roundNumber: 0,
    collisionLane: 0,
    history: [],
  };
}

export function currentMultiplier(state) {
  if (state.phase === "crashed") return 0;
  return MEDIUM_MULTIPLIERS[state.lane - 1] || 1;
}

/** Only an active round has an available cash-out; settled payout is on state. */
export function cashOutCents(state) {
  if (state.phase !== "playing" || state.lane < 1) return 0;
  // Multiply integer hundredths before division to avoid decimal multiplier drift.
  return Math.floor(state.stakeCents * MULTIPLIER_HUNDREDTHS[state.lane - 1] / 100);
}

function settle(state, phase) {
  const payoutCents = phase === "cashed_out" ? cashOutCents(state) : 0;
  const multiplier = phase === "cashed_out" ? currentMultiplier(state) : 0;
  return {
    ...state,
    phase,
    balanceCents: state.balanceCents + payoutCents,
    payoutCents,
    history: [...state.history, {
      roundNumber: state.roundNumber,
      phase,
      difficulty: state.difficulty,
      lane: state.lane,
      stakeCents: state.stakeCents,
      payoutCents,
      multiplier,
    }],
  };
}

function hop(state) {
  const next = { ...state, lane: state.lane + 1 };
  if (next.lane === next.collisionLane) return settle(next, "crashed");
  if (next.lane === MEDIUM_MULTIPLIERS.length) return settle(next, "cashed_out");
  return next;
}

/**
 * Pure reducer. Invalid/unsupported actions return the same state object.
 * PLAY performs the first crossing immediately. RESET only clears a completed
 * board: it never refunds a stake, replenishes credits, or rewinds the script.
 */
export function transitionDemoState(state, action) {
  switch (action?.type) {
    case "PLAY": {
      const { stakeCents, difficulty } = action;
      if (state.phase !== "idle"
        || difficulty !== "medium"
        || !Number.isSafeInteger(stakeCents)
        || stakeCents < MIN_STAKE_CENTS
        || stakeCents > MAX_STAKE_CENTS
        || stakeCents > state.balanceCents) {
        return state;
      }
      const largestPayout = Math.floor(stakeCents * MULTIPLIER_HUNDREDTHS[MULTIPLIER_HUNDREDTHS.length - 1] / 100);
      if (!Number.isSafeInteger(state.balanceCents - stakeCents + largestPayout)) return state;
      return hop({
        ...state,
        phase: "playing",
        balanceCents: state.balanceCents - stakeCents,
        stakeCents,
        payoutCents: 0,
        lane: 0,
        difficulty,
        roundNumber: state.roundNumber + 1,
        collisionLane: SCRIPTED_COLLISION_LANES[state.roundNumber % SCRIPTED_COLLISION_LANES.length],
      });
    }
    case "HOP":
      return state.phase === "playing" ? hop(state) : state;
    case "CASH_OUT":
      return state.phase === "playing" ? settle(state, "cashed_out") : state;
    case "RESET":
      if (state.phase !== "crashed" && state.phase !== "cashed_out") return state;
      return {
        ...state,
        phase: "idle",
        stakeCents: 0,
        payoutCents: 0,
        lane: 0,
        collisionLane: 0,
      };
    default:
      return state;
  }
}
