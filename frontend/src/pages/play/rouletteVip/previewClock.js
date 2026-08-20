export const ROULETTE_PREVIEW_TIMING = {
  bettingSeconds: 30,
  spinSeconds: 20,
  resultSeconds: 10,
  roundSeconds: 60,
};

const DEFAULT_WINNERS = ["17", "00", "32", "5", "21", "0", "14", "29", "8", "35"];

/** Pure repeating preview clock, kept identical to the production 30/20/10 cycle. */
export function roulettePreviewState(elapsedMs, winners = DEFAULT_WINNERS) {
  const elapsedSeconds = Math.max(0, Number(elapsedMs) || 0) / 1000;
  const roundIndex = Math.floor(elapsedSeconds / ROULETTE_PREVIEW_TIMING.roundSeconds);
  const inRound = elapsedSeconds % ROULETTE_PREVIEW_TIMING.roundSeconds;
  let phase;
  let phaseEndsAt;
  if (inRound < ROULETTE_PREVIEW_TIMING.bettingSeconds) {
    phase = "BETTING";
    phaseEndsAt = ROULETTE_PREVIEW_TIMING.bettingSeconds;
  } else if (inRound < ROULETTE_PREVIEW_TIMING.bettingSeconds + ROULETTE_PREVIEW_TIMING.spinSeconds) {
    phase = "SPINNING";
    phaseEndsAt = ROULETTE_PREVIEW_TIMING.bettingSeconds + ROULETTE_PREVIEW_TIMING.spinSeconds;
  } else {
    phase = "RESULT";
    phaseEndsAt = ROULETTE_PREVIEW_TIMING.roundSeconds;
  }
  const sequence = winners && winners.length ? winners : DEFAULT_WINNERS;
  return {
    phase,
    roundIndex,
    roundNumber: `PREVIEW-${roundIndex + 1}`,
    secondsLeft: phaseEndsAt - inRound,
    roundSecondsLeft: ROULETTE_PREVIEW_TIMING.roundSeconds - inRound,
    winningNumber: phase === "BETTING" ? null : String(sequence[roundIndex % sequence.length]),
  };
}
