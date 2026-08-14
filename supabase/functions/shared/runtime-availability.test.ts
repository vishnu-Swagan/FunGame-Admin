import {
  isPubliclyPlayableRuntime,
  runtimeReadinessMessage,
} from "./runtime-availability.ts";
import {
  hasRegisteredLiveResolver,
  LIVE_RESOLVER_REGISTRY,
} from "./live-resolver-registry.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const verified = {
  catalog_slug: "fun-roulette",
  availability: "ENABLED",
  parity_state: "QA_VERIFIED",
  ruleset_version: 1,
} as const;

Deno.test("a public cabinet requires catalogue, runtime, parity, and a compiled resolver", () => {
  assert(!isPubliclyPlayableRuntime("ENABLED", verified), "an unregistered resolver must keep a title closed");
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

Deno.test("the resolver registry explicitly keeps all fifteen current titles closed", () => {
  const entries = Object.values(LIVE_RESOLVER_REGISTRY);
  assert(entries.length === 15, "registry must cover the complete live catalog");
  assert(entries.every((entry) => entry.resolver_id === null && entry.ruleset_version === null),
    "no title may be implicitly promoted before its resolver is implemented");
  assert(!hasRegisteredLiveResolver("fun-roulette", 1), "a database label cannot substitute for code registration");
});

Deno.test("administrator readiness text explains the blocking layer", () => {
  assert(
    runtimeReadinessMessage("ENABLED", {
      catalog_slug: "fun-roulette",
      availability: "DISABLED",
      parity_state: "BLOCKED",
      ruleset_version: 1,
      disabled_reason: "Observed payout path is incomplete.",
    }) === "Observed payout path is incomplete.",
    "recorded parity reason should remain visible to administrators",
  );
  assert(
    runtimeReadinessMessage("DISABLED", verified).includes("catalogue status"),
    "a disabled catalogue needs a distinct operator explanation",
  );
});
