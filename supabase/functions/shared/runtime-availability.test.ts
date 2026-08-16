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
  // All four gates satisfied, including a registered ruleset v1 resolver.
  assert(isPubliclyPlayableRuntime("ENABLED", verified), "a fully gated registered title must be playable");
  // Each gate must still independently close the title.
  assert(!isPubliclyPlayableRuntime("DISABLED", verified), "catalogue disable must hide a runtime");
  assert(
    !isPubliclyPlayableRuntime("ENABLED", { ...verified, availability: "DISABLED" }),
    "runtime switch must be respected",
  );
  assert(
    !isPubliclyPlayableRuntime("ENABLED", { ...verified, parity_state: "DERIVED" }),
    "unverified parity must never reach a player",
  );
  // A registration is per exact ruleset: a version drift must close the title
  // even when every operational switch says otherwise.
  assert(
    !isPubliclyPlayableRuntime("ENABLED", { ...verified, ruleset_version: 2 }),
    "a ruleset the compiled resolver does not implement must never reach a player",
  );
  assert(
    !isPubliclyPlayableRuntime("ENABLED", { ...verified, catalog_slug: "not-a-real-game" }),
    "an unregistered slug must stay closed",
  );
});

Deno.test("the resolver registry registers all fifteen titles at ruleset v1", () => {
  const entries = Object.values(LIVE_RESOLVER_REGISTRY);
  assert(entries.length === 15, "registry must cover the complete live catalog");
  assert(
    entries.every((entry) => entry.resolver_id !== null && entry.ruleset_version === 1),
    "every title ships on ruleset v1 with a compiled resolver",
  );
  assert(
    new Set(entries.map((entry) => entry.resolver_id)).size === 15,
    "each title must carry its own distinct resolver id",
  );
  assert(hasRegisteredLiveResolver("fun-roulette", 1), "a registered title must pass code registration");
  // The registration is still the binding key: a database row claiming another
  // ruleset cannot borrow this one's approval.
  assert(!hasRegisteredLiveResolver("fun-roulette", 2), "a database label cannot substitute for code registration");
  assert(!hasRegisteredLiveResolver("not-a-real-game", 1), "an unknown slug must never register");
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
