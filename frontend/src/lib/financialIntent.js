import { createIdempotencyKey } from "@/lib/api";

const STORAGE_PREFIX = "cc_financial_intent_v1";

function storageForIntent() {
  try {
    return globalThis.sessionStorage || null;
  } catch (_error) {
    return null;
  }
}

function storageKey(kind, userId) {
  const subject = String(userId || "anonymous").replace(/[^A-Za-z0-9_.-]/g, "_");
  const operation = String(kind || "payment").replace(/[^A-Za-z0-9_.-]/g, "_");
  return `${STORAGE_PREFIX}:${subject}:${operation}`;
}

/**
 * Keep one server idempotency key for one form intent. A lost response can then
 * be retried after a reload without creating a second deposit or withdrawal.
 * Changing the amount or payout method creates a new intent and therefore a new
 * key. Session storage deliberately avoids carrying an abandoned payment into a
 * future browser session.
 */
export function financialIntentKey(kind, userId, signature, storage = storageForIntent()) {
  const key = storageKey(kind, userId);
  const normalizedSignature = String(signature || "");
  if (storage) {
    try {
      const saved = JSON.parse(storage.getItem(key) || "null");
      if (saved?.signature === normalizedSignature && typeof saved?.idempotencyKey === "string") {
        return saved.idempotencyKey;
      }
    } catch (_error) {
      // A corrupt/private-mode storage entry is replaced with a fresh intent.
    }
  }

  const idempotencyKey = createIdempotencyKey(kind || "payment");
  if (storage) {
    try {
      storage.setItem(key, JSON.stringify({ signature: normalizedSignature, idempotencyKey }));
    } catch (_error) {
      // The in-flight request still carries a safe key when storage is blocked.
    }
  }
  return idempotencyKey;
}

export function clearFinancialIntent(kind, userId, idempotencyKey, storage = storageForIntent()) {
  if (!storage) return;
  const key = storageKey(kind, userId);
  try {
    const saved = JSON.parse(storage.getItem(key) || "null");
    // Do not let an older response clear a newer intent from the same form.
    if (!idempotencyKey || saved?.idempotencyKey === idempotencyKey) storage.removeItem(key);
  } catch (_error) {
    storage.removeItem(key);
  }
}
