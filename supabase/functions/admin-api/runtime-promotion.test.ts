import { AdminRequestError } from "./request-security.ts";
import {
  parseRuntimePromotion,
  RUNTIME_AVAILABILITIES,
  RUNTIME_PARITY_STATES,
} from "./runtime-promotion.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function expectRequestError(
  action: () => unknown,
  status: number,
  code: string,
): void {
  try {
    action();
  } catch (error) {
    assert(error instanceof AdminRequestError, "expected AdminRequestError");
    assert(error.status === status, `expected status ${status}, received ${error.status}`);
    assert(error.code === code, `expected code ${code}, received ${error.code}`);
    return;
  }
  throw new Error(`expected ${code} failure`);
}

Deno.test("every runtime enum label the database accepts is accepted here", () => {
  for (const parity of RUNTIME_PARITY_STATES) {
    const patch = parseRuntimePromotion({ parity_state: parity });
    assert(patch.parity_state === parity, `${parity} must be preserved exactly`);
    assert(patch.availability === null, "an absent field must stay null");
  }
  for (const availability of RUNTIME_AVAILABILITIES) {
    // ENABLED is only valid alongside a verified parity, so it is paired here.
    const body = availability === "ENABLED"
      ? { availability, parity_state: "QA_VERIFIED" }
      : { availability };
    const patch = parseRuntimePromotion(body);
    assert(
      patch.availability === availability,
      `${availability} must be preserved exactly`,
    );
  }
});

Deno.test("both fields may be promoted in one request", () => {
  const patch = parseRuntimePromotion({
    parity_state: "QA_VERIFIED",
    availability: "ENABLED",
  });
  assert(patch.parity_state === "QA_VERIFIED", "parity_state must be read");
  assert(patch.availability === "ENABLED", "availability must be read");
});

Deno.test("lowercase and padded labels normalise rather than fail", () => {
  const patch = parseRuntimePromotion({
    parity_state: " qa_verified ",
    availability: "enabled",
  });
  assert(patch.parity_state === "QA_VERIFIED", "parity_state must be normalised");
  assert(patch.availability === "ENABLED", "availability must be normalised");
});

Deno.test("an explicit null leaves the stored value untouched", () => {
  const patch = parseRuntimePromotion({
    parity_state: "DERIVED",
    availability: null,
  });
  assert(patch.parity_state === "DERIVED", "parity_state must be read");
  assert(patch.availability === null, "an explicit null must not become a value");
});

Deno.test("labels outside the database enums are rejected", () => {
  for (
    const body of [
      { parity_state: "VERIFIED" },
      { parity_state: "" },
      { parity_state: "QA_VERIFIED; drop table games" },
      { availability: "LIVE" },
      { availability: "ON" },
    ]
  ) {
    expectRequestError(
      () => parseRuntimePromotion(body),
      400,
      "INVALID_RUNTIME_STATE",
    );
  }
});

Deno.test("non-text field values are rejected before the database sees them", () => {
  for (
    const body of [
      { parity_state: 1 },
      { parity_state: true },
      { parity_state: ["QA_VERIFIED"] },
      { availability: { value: "ENABLED" } },
    ]
  ) {
    expectRequestError(
      () => parseRuntimePromotion(body),
      400,
      "INVALID_RUNTIME_STATE",
    );
  }
});

Deno.test("a request naming neither field is refused rather than silently succeeding", () => {
  expectRequestError(() => parseRuntimePromotion({}), 400, "NO_RUNTIME_FIELDS");
  expectRequestError(
    () => parseRuntimePromotion({ parity_state: null, availability: null }),
    400,
    "NO_RUNTIME_FIELDS",
  );
  expectRequestError(
    () => parseRuntimePromotion({ status: "ENABLED" }),
    400,
    "NO_RUNTIME_FIELDS",
  );
});

Deno.test("ENABLED cannot be paired with an unverified parity in one request", () => {
  for (const parity of ["BLOCKED", "DERIVED"]) {
    expectRequestError(
      () => parseRuntimePromotion({ availability: "ENABLED", parity_state: parity }),
      400,
      "RUNTIME_PARITY_REQUIRED",
    );
  }
  // Enabling without naming a parity is left to the RPC, which reads the stored
  // parity under a row lock; the client cannot know it from the request alone.
  const patch = parseRuntimePromotion({ availability: "ENABLED" });
  assert(patch.availability === "ENABLED", "availability must be read");
  assert(patch.parity_state === null, "parity_state must be left to the RPC");
});
