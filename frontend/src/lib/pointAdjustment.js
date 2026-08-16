const MAX_PLAY_POINT_ADJUSTMENT = 1_000_000;
const POINT_ADJUSTMENT_KEY_PATTERN = /^admin-points-[A-Za-z0-9-]{16,147}$/;

/**
 * Validate a deliberate administrator correction before it is sent to the
 * immutable virtual-point ledger.  The Edge API repeats this validation; this
 * version only prevents an avoidable typo in the operator console.
 */
export function validatePointAdjustment({ amount, note }) {
  const rawAmount = String(amount ?? "").trim();
  if (!/^-?[0-9]+$/.test(rawAmount)) {
    return { error: "Enter a whole positive or negative play-point amount." };
  }
  const delta = Number(rawAmount);
  if (!Number.isSafeInteger(delta) || delta === 0 || Math.abs(delta) > MAX_PLAY_POINT_ADJUSTMENT) {
    return { error: "Amount must be a non-zero whole number between -1,000,000 and 1,000,000." };
  }
  const normalizedNote = String(note ?? "").trim();
  if (normalizedNote.length < 3 || normalizedNote.length > 500) {
    return { error: "Enter a ledger note between 3 and 500 characters." };
  }
  return { delta, note: normalizedNote };
}

/**
 * One correction may be retried safely after a lost network response.  The
 * key is held only in page memory and is sent both with the action and the
 * server's ledger receipt; it is never persisted in browser storage.
 */
export function newPointAdjustmentKey(cryptoApi = globalThis.crypto) {
  const id = cryptoApi?.randomUUID?.();
  if (id) return `admin-points-${id}`;
  if (!cryptoApi?.getRandomValues) {
    // A retry key that can collide is worse than refusing a privileged balance
    // correction. Modern browsers provide one of these Web Crypto APIs.
    throw new Error("Secure randomness is unavailable for this point adjustment.");
  }
  const bytes = new Uint8Array(16);
  cryptoApi.getRandomValues(bytes);
  return `admin-points-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Build the privileged request headers from the key created when the operator
 * opened the correction. This helper never invents a missing key at submit
 * time: a retry without the original key must fail closed.
 */
export function pointAdjustmentHeaders(key) {
  const stableKey = String(key ?? "").trim();
  if (!POINT_ADJUSTMENT_KEY_PATTERN.test(stableKey)) {
    throw new Error("A stable point-adjustment retry key is required.");
  }
  return { "X-Idempotency-Key": stableKey };
}
