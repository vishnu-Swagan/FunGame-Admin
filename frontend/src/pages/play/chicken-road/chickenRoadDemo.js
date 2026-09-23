/**
 * LOCAL PREVIEW ONLY — no wallet, API, random outcomes, or probability model.
 * All tables are design-only copies of the UNAPPROVED live-rules proposal;
 * Medium also follows the labels in the supplied reference recording.
 * Neither the tables nor scripted collisions claim odds or certification.
 * Each difficulty repeats its explicit presentation script below. A zero
 * means full traversal, not a probability; harder scripts catch earlier.
 */
export const DEMO_MULTIPLIER_HUNDREDTHS = Object.freeze({
  easy: Object.freeze([106, 113, 120, 127, 134, 142, 151, 160, 169, 180, 190, 202, 214]),
  medium: Object.freeze([112, 128, 147, 170, 198, 233, 276, 332, 403, 496, 620, 691, 890]),
  hard: Object.freeze([135, 183, 247, 333, 449, 606, 818, 1104, 1490, 2011, 2715, 3665, 4947]),
  hardcore: Object.freeze([150, 225, 338, 507, 760, 1140, 1709, 2563, 3845, 5767, 8650, 12975, 19462]),
});

const DEMO_MULTIPLIERS = Object.freeze(Object.fromEntries(
  Object.entries(DEMO_MULTIPLIER_HUNDREDTHS).map(([difficulty, ladder]) => [
    difficulty, Object.freeze(ladder.map((hundredths) => hundredths / 100)),
  ]),
));
const EMPTY_LADDER = Object.freeze([]);

/** Display-only ladder; use the selected ID when idle and the round ID in play. */
export function getDemoMultipliers(difficulty) {
  return typeof difficulty === "string" && Object.prototype.hasOwnProperty.call(DEMO_MULTIPLIERS, difficulty)
    ? DEMO_MULTIPLIERS[difficulty] : EMPTY_LADDER;
}

// Preserve the reference-preview import while consumers adopt selected ladders.
export const MEDIUM_MULTIPLIERS = getDemoMultipliers("medium");

export const DIFFICULTIES = Object.freeze([
  Object.freeze({ id: "easy", label: "Easy", supported: true }),
  Object.freeze({ id: "medium", label: "Medium", supported: true }),
  Object.freeze({ id: "hard", label: "Hard", supported: true }),
  Object.freeze({ id: "hardcore", label: "Hardcore", supported: true }),
]);

export const MIN_STAKE_CENTS = 100;
export const MAX_STAKE_CENTS = 1000000;

export const SCRIPTED_COLLISION_LANES = Object.freeze({
  easy: Object.freeze([10, 4, 7, 0]),
  medium: Object.freeze([6, 1, 4, 0]),
  hard: Object.freeze([4, 1, 2, 0]),
  hardcore: Object.freeze([2, 1, 1, 0]),
});

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
  return getDemoMultipliers(state.difficulty)[state.lane - 1] || 1;
}

/** Only an active round has an available cash-out; settled payout is on state. */
export function cashOutCents(state) {
  if (state.phase !== "playing" || state.lane < 1) return 0;
  // Multiply integer hundredths before division to avoid decimal multiplier drift.
  return Math.floor(state.stakeCents * DEMO_MULTIPLIER_HUNDREDTHS[state.difficulty][state.lane - 1] / 100);
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
  if (next.lane === getDemoMultipliers(next.difficulty).length) return settle(next, "cashed_out");
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
        || getDemoMultipliers(difficulty).length === 0
        || !Number.isSafeInteger(stakeCents)
        || stakeCents < MIN_STAKE_CENTS
        || stakeCents > MAX_STAKE_CENTS
        || stakeCents > state.balanceCents) {
        return state;
      }
      const ladder = DEMO_MULTIPLIER_HUNDREDTHS[difficulty];
      const script = SCRIPTED_COLLISION_LANES[difficulty];
      const largestPayout = Math.floor(stakeCents * ladder[ladder.length - 1] / 100);
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
        collisionLane: script[state.roundNumber % script.length],
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
