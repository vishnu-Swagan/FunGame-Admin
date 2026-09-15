// Preview and pre-state display defaults only. Live phases and deadlines remain
// authoritative on the server and may override these values during a rollout.
export const ROULETTE_DEFAULT_TIMING = Object.freeze({
  bettingSeconds: 50,
  spinSeconds: 10,
  resultSeconds: 10,
  roundSeconds: 70,
});
