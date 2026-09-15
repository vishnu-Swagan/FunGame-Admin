import { ROULETTE_PREVIEW_TIMING, roulettePreviewState } from "./previewClock";

test("roulette has a 70-second cycle with a complete 10-second result buffer", () => {
  expect(ROULETTE_PREVIEW_TIMING).toEqual({ bettingSeconds: 50, spinSeconds: 10, resultSeconds: 10, roundSeconds: 70 });
  expect(ROULETTE_PREVIEW_TIMING.bettingSeconds + ROULETTE_PREVIEW_TIMING.spinSeconds + ROULETTE_PREVIEW_TIMING.resultSeconds)
    .toBe(ROULETTE_PREVIEW_TIMING.roundSeconds);
});

test.each([
  [0, "BETTING", 50, 70, null],
  [49999, "BETTING", 0.001, 20.001, null],
  [50000, "SPINNING", 10, 20, "17"],
  [59999, "SPINNING", 0.001, 10.001, "17"],
  [60000, "RESULT", 10, 10, "17"],
  [69999, "RESULT", 0.001, 0.001, "17"],
  [70000, "BETTING", 50, 70, null],
])("preview clock at %ims", (elapsed, phase, phaseLeft, roundLeft, winner) => {
  const state = roulettePreviewState(elapsed, ["17", "00"]);
  expect(state.phase).toBe(phase);
  expect(state.secondsLeft).toBeCloseTo(phaseLeft, 6);
  expect(state.roundSecondsLeft).toBeCloseTo(roundLeft, 6);
  expect(state.winningNumber).toBe(winner);
});

test("preview rolls over after 70 seconds and hides the next winner until betting closes", () => {
  expect(roulettePreviewState(69999, ["17", "00"]).roundNumber).toBe("PREVIEW-1");
  expect(roulettePreviewState(70000, ["17", "00"])).toMatchObject({ roundNumber: "PREVIEW-2", roundIndex: 1, winningNumber: null });
  expect(roulettePreviewState(90000, ["17", "00"]).winningNumber).toBeNull();
  expect(roulettePreviewState(120000, ["17", "00"])).toMatchObject({ phase: "SPINNING", winningNumber: "00" });
});
