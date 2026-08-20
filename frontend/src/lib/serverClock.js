const finiteNumber = (value) => {
  if (value == null || value === "") return Number.NaN;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
};

/**
 * Translate an absolute server deadline onto the browser clock. New servers
 * return receive/send timestamps, so the NTP offset formula removes both
 * network latency and handler time. Older responses fall back to a request
 * midpoint estimate, then finally to receipt time plus the remaining seconds.
 */
export function serverSyncedDeadline({
  serverNowSeconds,
  serverSampledAtSeconds,
  serverDeadlineSeconds,
  secondsLeft,
  requestStartedAtMs,
  receivedAtMs,
}) {
  const received = Number.isFinite(receivedAtMs) ? receivedAtMs : Date.now();
  const started = Number.isFinite(requestStartedAtMs) ? requestStartedAtMs : received;
  const remainingMs = Math.max(0, Number(secondsLeft) || 0) * 1000;
  const serverNowMs = finiteNumber(serverNowSeconds) * 1000;
  if (!Number.isFinite(serverNowMs)) return received + remainingMs;

  const serverSampledAtMs = finiteNumber(serverSampledAtSeconds) * 1000;
  const midpoint = started + Math.max(0, received - started) / 2;
  // When the API provides both receive/sample (t1) and send (t2) timestamps,
  // use the standard NTP offset equation. It cancels handler processing time;
  // the midpoint fallback is retained for older servers.
  const clockOffset = Number.isFinite(serverSampledAtMs)
    ? ((serverSampledAtMs - started) + (serverNowMs - received)) / 2
    : serverNowMs - midpoint;
  const absoluteDeadlineMs = finiteNumber(serverDeadlineSeconds) * 1000;
  const serverDeadline = Number.isFinite(absoluteDeadlineMs)
    ? absoluteDeadlineMs
    : (Number.isFinite(serverSampledAtMs) ? serverSampledAtMs : serverNowMs) + remainingMs;
  return serverDeadline - clockOffset;
}

export function secondsUntil(deadlineMs, nowMs = Date.now()) {
  return Math.max(0, (Number(deadlineMs) - nowMs) / 1000);
}

// The backend refuses mutations below 0.4s. The extra tenth gives the request
// time to reach it instead of showing a control that is virtually guaranteed
// to be rejected.
export const CLIENT_BETTING_GUARD_SECONDS = 0.5;

/** Reactive UI predicate matching the stricter client-side betting cutoff. */
export function bettingControlsOpen(
  phase,
  secondsLeft,
  guardSeconds = CLIENT_BETTING_GUARD_SECONDS
) {
  return phase === "BETTING"
    && Number(secondsLeft) > Math.max(0, Number(guardSeconds) || 0);
}
