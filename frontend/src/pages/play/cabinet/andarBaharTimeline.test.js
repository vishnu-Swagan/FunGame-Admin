import { CLIENT_BETTING_GUARD_SECONDS } from "@/lib/serverClock";
import {
  AMBIENT_GESTURES,
  ambientFrameAt,
  bettingOpenAt,
  buildDealTimeline,
  DEAL_SOURCE_MARKERS,
  DEALER_ACTION_PROFILES,
  dealerActionForRound,
  dealerFrameAt,
  formatRoundClock,
  roundSecondsRemaining,
} from "./andarBaharTimeline";

test("all ten deterministic round programs are visibly distinct with no adjacent repeat", () => {
  expect(DEALER_ACTION_PROFILES).toHaveLength(10);
  expect(new Set(DEALER_ACTION_PROFILES.map((item) => item.id)).size).toBe(10);
  expect(new Set(DEALER_ACTION_PROFILES.map((item) => item.ambientProgram.join("→"))).size).toBe(10);

  // Start near a cycle boundary to prove both the wrap and the ten-round set.
  const rounds = Array.from({ length: 30 }, (_, index) => dealerActionForRound(1480905967 + index));
  for (let start = 0; start <= rounds.length - 10; start += 1) {
    expect(new Set(rounds.slice(start, start + 10).map((item) => item.id)).size).toBe(10);
  }
  rounds.slice(1).forEach((item, index) => expect(item.id).not.toBe(rounds[index].id));
});

test("ambient programs stay inside their isolated non-hair source windows", () => {
  expect(AMBIENT_GESTURES["right-shoe-explain"]).toMatchObject({ start: 8.4, end: 11.18 });
  DEALER_ACTION_PROFILES.forEach((action) => {
    [...action.ambientProgram, action.setupGesture, action.finishGesture].forEach((key) => {
      expect(AMBIENT_GESTURES[key]).toBeDefined();
    });
    [0, 0.37, 1.91, 7.25, 18.4, 29.9].forEach((elapsed) => {
      const frame = ambientFrameAt(action, elapsed, "betting");
      expect(action.ambientProgram).toContain(frame.segmentId);
      expect(frame.sourceTime).toBeGreaterThanOrEqual(AMBIENT_GESTURES[frame.segmentId].start);
      expect(frame.sourceTime).toBeLessThan(AMBIENT_GESTURES[frame.segmentId].end);
    });
    expect(ambientFrameAt(action, 3.2, "setup").segmentId).toBe(action.setupGesture);
    expect(ambientFrameAt(action, 2.1, "finish").segmentId).toBe(action.finishGesture);
  });
});

test.each([1, 7, 21, 49])(
  "real hand markers and every canvas flight fit a 24-second reveal for %i cards",
  (count) => {
    DEALER_ACTION_PROFILES.forEach((action) => {
      const timeline = buildDealTimeline(count, 24, action);
      expect(timeline.cards).toHaveLength(count);
      expect(timeline.dealStart).toBeGreaterThanOrEqual(0.5);
      expect(timeline.dealEnd).toBeLessThanOrEqual(24 - timeline.finishHold + 1e-8);

      timeline.cards.forEach((card, index) => {
        const marker = DEAL_SOURCE_MARKERS[(action.dealCycleOffset + index) % DEAL_SOURCE_MARKERS.length];
        expect(card.sourceStart).toBe(marker.sourceStart);
        expect(card.sourceReleaseAt).toBe(marker.sourceReleaseAt);
        expect(card.sourceEnd).toBe(marker.sourceEnd);
        expect(card.releaseAt).toBeGreaterThan(card.start);
        expect(card.releaseAt).toBeLessThan(card.end);
        expect(card.flightEndsAt).toBeLessThanOrEqual(card.end + 1e-8);
        expect(card.flightEndsAt).toBeLessThanOrEqual(timeline.dealEnd + 1e-8);
        if (index) expect(card.start).toBeCloseTo(timeline.cards[index - 1].end, 8);

        // The Canvas visibility edge and source-video release frame are the
        // same normalized point, within one 24fps source frame.
        const sourceFrame = dealerFrameAt(timeline, card.releaseAt);
        expect(sourceFrame.cycleIndex).toBe(index);
        expect(sourceFrame.sourceTime).toBeCloseTo(marker.sourceReleaseAt, 6);
        expect(Math.abs(sourceFrame.sourceTime - marker.sourceReleaseAt)).toBeLessThanOrEqual(1 / 24);
        expect(sourceFrame.visibleCount).toBe(index + 1);
      });

      const finalCard = timeline.cards[timeline.cards.length - 1];
      expect(finalCard.flightEndsAt).toBeLessThanOrEqual(timeline.dealEnd + 1e-8);
      expect(timeline.dealEnd + timeline.finishHold).toBeLessThanOrEqual(24 + 1e-8);
      expect(dealerFrameAt(timeline, timeline.dealEnd).mode).toBe("finish");
    });
  }
);

test("the first throw begins with a visible front-of-shoe pickup", () => {
  DEALER_ACTION_PROFILES.forEach((action) => expect(action.dealCycleOffset).not.toBe(0));
  // Markers 2-4 begin on the last empty-hand frame, immediately before the
  // source card appears at the front of the shoe.
  expect(DEAL_SOURCE_MARKERS.slice(1).map((marker) => marker.sourceStart)).toEqual([2.708, 5.833, 9.583]);
});

test("the shared 0.5-second client guard locks every betting mutation", () => {
  expect(CLIENT_BETTING_GUARD_SECONDS).toBe(0.5);
  expect(bettingOpenAt("BETTING", 0.501, CLIENT_BETTING_GUARD_SECONDS)).toBe(true);
  expect(bettingOpenAt("BETTING", 0.5, CLIENT_BETTING_GUARD_SECONDS)).toBe(false);
  expect(bettingOpenAt("BETTING", 0.001, CLIENT_BETTING_GUARD_SECONDS)).toBe(false);
  expect(bettingOpenAt("REVEAL", 24, CLIENT_BETTING_GUARD_SECONDS)).toBe(false);
});

test("visible round clock covers all phases of the one-minute schedule", () => {
  const timings = { bet: 30, reveal: 24, result: 6, total: 60 };
  expect(roundSecondsRemaining("BETTING", 30, timings)).toBe(60);
  expect(roundSecondsRemaining("BETTING", 1, timings)).toBe(31);
  expect(roundSecondsRemaining("REVEAL", 24, timings)).toBe(30);
  expect(roundSecondsRemaining("RESULT", 6, timings)).toBe(6);
  expect(formatRoundClock(60)).toBe("01:00");
  expect(formatRoundClock(5.2)).toBe("00:06");
});
