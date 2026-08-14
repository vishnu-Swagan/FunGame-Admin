import {
  isPubliclyPlayableRuntime,
  runtimeReadinessMessage,
} from "./runtime-availability.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const verified = { availability: "ENABLED", parity_state: "QA_VERIFIED" } as const;

Deno.test("a public cabinet requires catalogue, runtime, and parity agreement", () => {
  assert(isPubliclyPlayableRuntime("ENABLED", verified), "all three gates should allow a game");
  assert(!isPubliclyPlayableRuntime("DISABLED", verified), "catalogue disable must hide a runtime");
  assert(
    !isPubliclyPlayableRuntime("ENABLED", { availability: "DISABLED", parity_state: "QA_VERIFIED" }),
    "runtime switch must be respected",
  );
  assert(
    !isPubliclyPlayableRuntime("ENABLED", { availability: "ENABLED", parity_state: "DERIVED" }),
    "unverified parity must never reach a player",
  );
});

Deno.test("administrator readiness text explains the blocking layer", () => {
  assert(
    runtimeReadinessMessage("ENABLED", {
      availability: "DISABLED",
      parity_state: "BLOCKED",
      disabled_reason: "Observed payout path is incomplete.",
    }) === "Observed payout path is incomplete.",
    "recorded parity reason should remain visible to administrators",
  );
  assert(
    runtimeReadinessMessage("DISABLED", verified).includes("catalogue status"),
    "a disabled catalogue needs a distinct operator explanation",
  );
});
