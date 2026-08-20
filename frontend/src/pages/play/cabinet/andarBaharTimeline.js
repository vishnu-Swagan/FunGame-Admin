/* Frame-verified at 24fps. Each window begins with a card acquired at the
 * shoe, releases only after the hand clears it, and ends at the reset pose. */
export const DEAL_SOURCE_MARKERS = Object.freeze([
  Object.freeze({ sourceStart: 0, sourceReleaseAt: 1.75, sourceEnd: 2.417 }),
  Object.freeze({ sourceStart: 2.708, sourceReleaseAt: 4.5, sourceEnd: 5.083 }),
  Object.freeze({ sourceStart: 5.833, sourceReleaseAt: 7.958, sourceEnd: 8.5 }),
  Object.freeze({ sourceStart: 9.583, sourceReleaseAt: 11.542, sourceEnd: 12 }),
]);

/*
 * These are deliberately isolated, non-hair gestures from dealer-ambient.mp4.
 * The hair take is a separate asset and is only scheduled by the cabinet's
 * twenty-minute timer. Keeping the source windows here makes each round's
 * action program deterministic and prevents the full ambient take replaying.
 */
export const AMBIENT_GESTURES = Object.freeze({
  "warm-smile": Object.freeze({ id: "warm-smile", start: 0.08, end: 1.72, playbackRate: 0.94 }),
  "calm-center": Object.freeze({ id: "calm-center", start: 1.78, end: 3.02, playbackRate: 0.9 }),
  "firm-address": Object.freeze({ id: "firm-address", start: 3.08, end: 4.32, playbackRate: 0.94 }),
  "bright-smile": Object.freeze({ id: "bright-smile", start: 4.4, end: 6.16, playbackRate: 0.92 }),
  // CSS mirrors the plate, so this becomes her displayed left/off-shoe hand.
  "left-invite": Object.freeze({ id: "left-invite", start: 6.28, end: 7.92, playbackRate: 0.96 }),
  // This compound window must remain continuous: right-hand shoe presentation
  // flows into the two-hand emphasis and returns to rest without a hand pop.
  "right-shoe-explain": Object.freeze({ id: "right-shoe-explain", start: 8.4, end: 11.18, playbackRate: 0.9 }),
  "calm-rest": Object.freeze({ id: "calm-rest", start: 11.22, end: 11.96, playbackRate: 0.82 }),
});

const profile = ({
  id,
  ambientProgram,
  setupGesture,
  finishGesture,
  dealCycleOffset,
  maxStep,
  tempo,
  arc,
  drift,
}) => Object.freeze({
  id,
  ambientProgram: Object.freeze(ambientProgram),
  setupGesture,
  finishGesture,
  dealCycleOffset,
  maxStep,
  tempo: Object.freeze(tempo),
  arc,
  drift,
});

/*
 * Ten genuinely different programs made from the visible gesture windows.
 * A universal round number selects one, so every player sees the same order.
 * Deal motion is intentionally not faked here: REVEAL always switches to the
 * physical throw cycles in dealer-loop.mp4.
 */
export const DEALER_ACTION_PROFILES = Object.freeze([
  profile({ id: "royal-welcome", ambientProgram: ["warm-smile", "left-invite", "calm-center"], setupGesture: "right-shoe-explain", finishGesture: "bright-smile", dealCycleOffset: 1, maxStep: 3.0, tempo: [1, 0.96, 1.04], arc: 25, drift: -5 }),
  profile({ id: "open-palms", ambientProgram: ["right-shoe-explain", "bright-smile", "calm-rest"], setupGesture: "calm-center", finishGesture: "right-shoe-explain", dealCycleOffset: 1, maxStep: 2.85, tempo: [0.94, 1.06, 1], arc: 29, drift: 6 }),
  profile({ id: "soft-nod", ambientProgram: ["calm-center", "firm-address", "warm-smile"], setupGesture: "calm-rest", finishGesture: "warm-smile", dealCycleOffset: 2, maxStep: 2.95, tempo: [1.05, 0.96, 0.99], arc: 22, drift: 2 }),
  profile({ id: "right-hand-invite", ambientProgram: ["left-invite", "warm-smile", "right-shoe-explain"], setupGesture: "right-shoe-explain", finishGesture: "calm-center", dealCycleOffset: 3, maxStep: 2.8, tempo: [0.92, 1, 1.08], arc: 31, drift: -7 }),
  profile({ id: "measured-present", ambientProgram: ["right-shoe-explain", "firm-address", "calm-rest"], setupGesture: "right-shoe-explain", finishGesture: "firm-address", dealCycleOffset: 1, maxStep: 2.9, tempo: [1, 1.07, 0.93], arc: 24, drift: 8 }),
  profile({ id: "two-hand-explain", ambientProgram: ["right-shoe-explain", "bright-smile", "calm-center"], setupGesture: "calm-center", finishGesture: "right-shoe-explain", dealCycleOffset: 3, maxStep: 2.82, tempo: [1.05, 0.92, 1.03], arc: 28, drift: -3 }),
  profile({ id: "calm-table-sweep", ambientProgram: ["firm-address", "right-shoe-explain", "left-invite"], setupGesture: "calm-rest", finishGesture: "bright-smile", dealCycleOffset: 2, maxStep: 2.88, tempo: [0.97, 1.06, 0.97], arc: 26, drift: 5 }),
  profile({ id: "confident-smile", ambientProgram: ["bright-smile", "warm-smile", "firm-address"], setupGesture: "firm-address", finishGesture: "warm-smile", dealCycleOffset: 2, maxStep: 2.92, tempo: [1.07, 0.94, 0.99], arc: 23, drift: -6 }),
  profile({ id: "graceful-pause", ambientProgram: ["calm-rest", "left-invite", "bright-smile"], setupGesture: "calm-center", finishGesture: "calm-rest", dealCycleOffset: 1, maxStep: 3.0, tempo: [1, 0.91, 1.09], arc: 30, drift: 4 }),
  profile({ id: "warm-finale", ambientProgram: ["warm-smile", "right-shoe-explain", "bright-smile"], setupGesture: "right-shoe-explain", finishGesture: "bright-smile", dealCycleOffset: 2, maxStep: 2.86, tempo: [0.95, 1.02, 1.03], arc: 27, drift: -2 }),
]);

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const ROUND_ACTION_ORDER = Object.freeze([0, 7, 3, 9, 2, 6, 1, 8, 4, 5]);

export function dealerActionForRound(roundNumber) {
  const parsed = Number(roundNumber);
  const round = Number.isFinite(parsed) ? Math.abs(Math.trunc(parsed)) : 0;
  // The cycle contains every action once and its ends differ, so any ten
  // consecutive rounds stay unique and adjacent rounds never repeat.
  return DEALER_ACTION_PROFILES[ROUND_ACTION_ORDER[round % ROUND_ACTION_ORDER.length]];
}

function gestureKeys(profileValue, mode) {
  if (mode === "setup") return [profileValue.setupGesture];
  if (mode === "finish") return [profileValue.finishGesture];
  return profileValue.ambientProgram;
}

/** Return the exact isolated ambient source pose for a round-program clock. */
export function ambientFrameAt(profileValue, elapsed, mode = "betting") {
  const selected = profileValue || DEALER_ACTION_PROFILES[0];
  const keys = gestureKeys(selected, mode).filter((key) => AMBIENT_GESTURES[key]);
  const segments = (keys.length ? keys : ["calm-rest"]).map((key) => AMBIENT_GESTURES[key]);
  const durations = segments.map((segment) => (segment.end - segment.start) / segment.playbackRate);
  const programDuration = durations.reduce((sum, duration) => sum + duration, 0);
  let cursor = ((Math.max(0, Number(elapsed) || 0) % programDuration) + programDuration) % programDuration;
  let index = 0;
  while (index < durations.length - 1 && cursor >= durations[index]) {
    cursor -= durations[index];
    index += 1;
  }
  const segment = segments[index];
  const sourceTime = Math.min(segment.end - 0.002, segment.start + cursor * segment.playbackRate);
  return {
    mode,
    segmentId: segment.id,
    segmentIndex: index,
    sourceStart: segment.start,
    sourceEnd: segment.end,
    sourceTime,
    playbackRate: segment.playbackRate,
    programDuration,
  };
}

export function buildDealTimeline(cardCount, revealDuration, profileValue) {
  const action = profileValue || DEALER_ACTION_PROFILES[0];
  const count = Math.max(0, Math.trunc(Number(cardCount) || 0));
  const duration = Math.max(1, Number(revealDuration) || 1);
  const finishHold = 1.2;
  const earliestStart = 0.5;

  if (!count) {
    return { profile: action, cards: [], dealStart: duration, dealEnd: duration, finishHold };
  }

  const weights = Array.from({ length: count }, (_, index) => action.tempo[index % action.tempo.length]);
  const weightTotal = weights.reduce((sum, value) => sum + value, 0);
  const available = Math.max(0.1, duration - finishHold - earliestStart);
  const baseStep = Math.min(action.maxStep, available / Math.max(1, weightTotal));
  const steps = weights.map((weight) => baseStep * weight);
  const dealDuration = steps.reduce((sum, value) => sum + value, 0);
  // Short outcomes spend the opening reveal on a setup gesture. Long outcomes
  // begin promptly so even the 49-card tail and its final flight fit in 24s.
  const dealStart = Math.max(earliestStart, duration - finishHold - dealDuration);
  let cursor = dealStart;
  const cards = steps.map((step, index) => {
    const start = cursor;
    const end = start + step;
    cursor = end;
    const sourceCycleIndex = (action.dealCycleOffset + index) % DEAL_SOURCE_MARKERS.length;
    const marker = DEAL_SOURCE_MARKERS[sourceCycleIndex];
    const sourceSpan = marker.sourceEnd - marker.sourceStart;
    const sourceReleaseRatio = (marker.sourceReleaseAt - marker.sourceStart) / sourceSpan;
    const releaseAt = start + step * sourceReleaseRatio;
    const timeAfterRelease = Math.max(0, end - releaseAt);
    const flightDuration = Math.min(0.36, timeAfterRelease * 0.88);
    return {
      index,
      start,
      end,
      step,
      sourceCycleIndex,
      sourceStart: marker.sourceStart,
      sourceEnd: marker.sourceEnd,
      sourceReleaseAt: marker.sourceReleaseAt,
      sourceReleaseRatio,
      releaseAt,
      flightDuration,
      flightEndsAt: releaseAt + flightDuration,
    };
  });

  return {
    profile: action,
    cards,
    dealStart,
    dealEnd: cards[cards.length - 1].end,
    finishHold,
  };
}

export function dealerFrameAt(timeline, elapsed, sourceDuration = 12.041667) {
  const time = Math.max(0, Number(elapsed) || 0);
  if (!timeline.cards.length || time < timeline.dealStart) {
    return { mode: "setup", visibleCount: 0, cycleIndex: -1, playbackRate: 1, sourceTime: 0 };
  }

  let visibleCount = 0;
  for (const card of timeline.cards) {
    if (time >= card.releaseAt) visibleCount += 1;
    else break;
  }

  if (time >= timeline.dealEnd) {
    return {
      mode: "finish",
      visibleCount: timeline.cards.length,
      cycleIndex: timeline.cards.length - 1,
      playbackRate: 1,
      sourceTime: 0,
    };
  }

  const cycleIndex = Math.max(0, timeline.cards.findIndex((card) => time < card.end));
  const card = timeline.cards[cycleIndex];
  const progress = clamp((time - card.start) / Math.max(0.01, card.step), 0, 1);
  const sourceSpan = card.sourceEnd - card.sourceStart;
  const safeDuration = Math.max(sourceSpan, Number(sourceDuration) || 0);
  const sourceTime = Math.min(
    safeDuration - 0.002,
    card.sourceStart + progress * sourceSpan
  );
  return {
    mode: "deal",
    visibleCount,
    cycleIndex,
    playbackRate: clamp(sourceSpan / card.step, 0.35, 8),
    sourceStart: card.sourceStart,
    sourceEnd: card.sourceEnd,
    sourceTime,
  };
}

export function bettingOpenAt(phase, countdown, guardSeconds) {
  return phase === "BETTING" && Number(countdown) > Math.max(0, Number(guardSeconds) || 0);
}

export function roundSecondsRemaining(phase, phaseCountdown, timings) {
  const countdown = Math.max(0, Number(phaseCountdown) || 0);
  const reveal = Math.max(0, Number(timings?.reveal) || 0);
  const result = Math.max(0, Number(timings?.result) || 0);
  if (phase === "BETTING") return countdown + reveal + result;
  if (phase === "REVEAL") return countdown + result;
  if (phase === "RESULT") return countdown;
  return Math.max(0, Number(timings?.total) || 0);
}

export function formatRoundClock(seconds) {
  const total = Math.max(0, Math.ceil(Number(seconds) || 0));
  const minutes = Math.floor(total / 60);
  return `${String(minutes).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}
