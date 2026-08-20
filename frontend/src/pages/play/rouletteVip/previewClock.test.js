import { roulettePreviewState } from "./previewClock";

test.each([
  [0, "BETTING", 30, 60, null],
  [29900, "BETTING", 0.1, 30.1, null],
  [30000, "SPINNING", 20, 30, "17"],
  [49900, "SPINNING", 0.1, 10.1, "17"],
  [50000, "RESULT", 10, 10, "17"],
  [59900, "RESULT", 0.1, 0.1, "17"],
  [60000, "BETTING", 30, 60, null],
])("preview clock at %ims", (elapsed, phase, phaseLeft, roundLeft, winner) => {
  const state = roulettePreviewState(elapsed, ["17", "00"]);
  expect(state.phase).toBe(phase);
  expect(state.secondsLeft).toBeCloseTo(phaseLeft, 6);
  expect(state.roundSecondsLeft).toBeCloseTo(roundLeft, 6);
  expect(state.winningNumber).toBe(winner);
});

test("preview advances winner only after a complete 60-second round", () => {
  expect(roulettePreviewState(90000, ["17", "00"]).winningNumber).toBe("00");
});
