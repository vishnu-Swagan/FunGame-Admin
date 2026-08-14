/**
 * A small, dependency-free policy shared by the administrator and player
 * Edge functions.  A cabinet is publicly playable only when all four layers
 * agree: the operator-visible game record, the server runtime switch, the
 * client-parity review, and a compiled resolver for the exact ruleset.
 *
 * Keeping this rule in one module avoids an especially dangerous split where
 * an admin dashboard says "enabled" while the session API refuses the same
 * player at the game boundary.
 */

import {
  hasRegisteredLiveResolver,
  liveResolverReadinessMessage,
} from "./live-resolver-registry.ts";

export type RuntimeAvailability = "DISABLED" | "MAINTENANCE" | "ENABLED";
export type RuntimeParityState = "BLOCKED" | "DERIVED" | "QA_VERIFIED";

export type RuntimeAvailabilityRecord = {
  catalog_slug?: string | null;
  unity_lobby_slug?: unknown;
  unity_scene?: unknown;
  engine_slug?: unknown;
  runtime_mode?: unknown;
  availability: RuntimeAvailability;
  parity_state: RuntimeParityState;
  timing?: unknown;
  action_contract?: unknown;
  outcome_contract?: unknown;
  ruleset_version?: number | string | null;
  min_bet?: number | string | null;
  max_bet?: number | string | null;
  disabled_reason?: string | null;
};

export function isPubliclyPlayableRuntime(
  gameStatus: string | null | undefined,
  runtime: RuntimeAvailabilityRecord | null | undefined,
): boolean {
  return gameStatus === "ENABLED" && runtime?.availability === "ENABLED" &&
    runtime.parity_state === "QA_VERIFIED" &&
    hasRegisteredLiveResolver(runtime.catalog_slug, runtime.ruleset_version);
}

/** A safe administrator-facing explanation; never send this detail to players. */
export function runtimeReadinessMessage(
  gameStatus: string | null | undefined,
  runtime: RuntimeAvailabilityRecord | null | undefined,
): string {
  if (gameStatus !== "ENABLED") {
    return "Set the game catalogue status to ENABLED only after its server runtime has passed review.";
  }
  if (!runtime) return "No server runtime is configured for this game.";
  if (!hasRegisteredLiveResolver(runtime.catalog_slug, runtime.ruleset_version)) {
    return runtime.disabled_reason ||
      liveResolverReadinessMessage(runtime.catalog_slug, runtime.ruleset_version);
  }
  if (runtime.parity_state !== "QA_VERIFIED") {
    return runtime.disabled_reason ||
      "Client-rule parity has not been verified for this game runtime.";
  }
  if (runtime.availability !== "ENABLED") {
    return runtime.disabled_reason ||
      "The verified game runtime is not enabled for live sessions.";
  }
  return "This game is verified and available for live sessions.";
}
