/**
 * Request validation for the administrator runtime-promotion route.
 *
 * The two runtime enums live in PostgreSQL. Rejecting an unknown label here
 * rather than at the database boundary keeps the operator's error a sentence
 * about the field they typed instead of a raw enum-cast failure, and stops an
 * arbitrary caller-supplied string from ever reaching the privileged RPC.
 *
 * This is deliberately a separate module from index.ts, which opens a listening
 * server on import and so cannot be exercised by a unit test.
 */
import { AdminRequestError, type JsonObject } from "./request-security.ts";

export const RUNTIME_PARITY_STATES = [
  "BLOCKED",
  "DERIVED",
  "QA_VERIFIED",
] as const;
export const RUNTIME_AVAILABILITIES = [
  "DISABLED",
  "MAINTENANCE",
  "ENABLED",
] as const;

export type RuntimeParityState = (typeof RUNTIME_PARITY_STATES)[number];
export type RuntimeAvailability = (typeof RUNTIME_AVAILABILITIES)[number];

export type RuntimePromotionPatch = {
  parity_state: RuntimeParityState | null;
  availability: RuntimeAvailability | null;
};

function enumValue<T extends string>(
  body: JsonObject,
  key: string,
  allowed: readonly T[],
): T | null {
  const raw = body[key];
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") {
    throw new AdminRequestError(400, `${key} must be text`, "INVALID_RUNTIME_STATE");
  }
  const value = raw.trim().toUpperCase();
  if (!(allowed as readonly string[]).includes(value)) {
    throw new AdminRequestError(
      400,
      `${key} must be one of ${allowed.join(", ")}`,
      "INVALID_RUNTIME_STATE",
    );
  }
  return value as T;
}

/**
 * Read the promotion fields from an already size-bounded JSON object. Absent
 * fields stay null so the RPC leaves the stored value untouched; a request that
 * names neither field is a mistake rather than a no-op, because an operator who
 * meant to change something would otherwise see a success response.
 */
export function parseRuntimePromotion(body: JsonObject): RuntimePromotionPatch {
  const patch: RuntimePromotionPatch = {
    parity_state: enumValue(body, "parity_state", RUNTIME_PARITY_STATES),
    availability: enumValue(body, "availability", RUNTIME_AVAILABILITIES),
  };
  if (patch.parity_state === null && patch.availability === null) {
    throw new AdminRequestError(
      400,
      "parity_state or availability is required",
      "NO_RUNTIME_FIELDS",
    );
  }
  // The database CHECK and the RPC both enforce this ordering. Refusing the
  // pair before the round trip means the console can explain it without having
  // written an audit row for an attempt that could never have applied.
  if (patch.availability === "ENABLED" && patch.parity_state !== null &&
    patch.parity_state !== "QA_VERIFIED") {
    throw new AdminRequestError(
      400,
      "A game runtime cannot be ENABLED until its client-rule parity is QA_VERIFIED",
      "RUNTIME_PARITY_REQUIRED",
    );
  }
  return patch;
}
