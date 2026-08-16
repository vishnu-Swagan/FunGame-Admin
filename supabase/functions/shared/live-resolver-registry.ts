/**
 * Compile-time admission registry for live game resolvers.
 *
 * A database QA flag is an operational approval, not executable evidence that
 * the deployed Edge bundle can run a complete result/settlement lifecycle.
 * Every title therefore needs an explicit source-code registration tied to a
 * ruleset version before it may be advertised or opened.
 *
 * All fifteen titles are registered at ruleset v1. Each runs the operator's own
 * declared paytable; none claims to reproduce another product's rules.
 *
 * When a title changes, change exactly that row in the same change set as its
 * resolver, settlement tests, and compiled runtime-contract version.
 */

export type ResolverRegistration = {
  readonly catalog_slug: string;
  readonly resolver_id: string | null;
  readonly ruleset_version: number | null;
};

/**
 * Ruleset v1 registrations. Every title runs on the operator's own declared
 * paytable, implemented in the matching resolver module and covered by that
 * module's settlement tests. A row here is the second of the two keys: the
 * resolver must independently declare the same `live_resolver_id` and
 * `ruleset_version`, and `assertReviewResolverRegistryIntegrity` fails the
 * build if the two ever disagree.
 *
 * To retire or re-price a title, change its resolver and this row together, in
 * one change set, and bump the ruleset version.
 */
const REGISTRATIONS = [
  ["7up7down", "7up7down-v1", 1],
  ["fun-ab", "fun-ab-v1", 1],
  ["triple-fun", "triple-fun-v1", 1],
  ["fun-roulette", "fun-roulette-v1", 1],
  ["fun-target", "fun-target-v1", 1],
  ["bingo", "bingo-v1", 1],
  ["joker-bonus", "joker-bonus-v1", 1],
  ["giant-jackpot", "giant-jackpot-v1", 1],
  ["golden-wheel", "golden-wheel-v1", 1],
  ["keno", "keno-v1", 1],
  ["checker", "checker-v1", 1],
  ["lucky-8-line", "lucky-8-line-v1", 1],
  ["fever-joker-bonus", "fever-joker-bonus-v1", 1],
  ["no-hold", "no-hold-v1", 1],
  ["champion-poker", "champion-poker-v1", 1],
  ["aviator", "aviator-v1", 1],
] as const satisfies readonly (readonly [string, string, number])[];

export const LIVE_RESOLVER_REGISTRY: Readonly<Record<string, ResolverRegistration>> =
  Object.freeze(
    Object.fromEntries(
      REGISTRATIONS.map(([catalog_slug, resolver_id, ruleset_version]) => [
        catalog_slug,
        Object.freeze({ catalog_slug, resolver_id, ruleset_version }),
      ]),
    ),
  );

export function liveResolverFor(
  catalogSlug: string | null | undefined,
): ResolverRegistration | null {
  if (!catalogSlug) return null;
  return LIVE_RESOLVER_REGISTRY[catalogSlug] || null;
}

export function hasRegisteredLiveResolver(
  catalogSlug: string | null | undefined,
  rulesetVersion: number | string | null | undefined,
): boolean {
  const registration = liveResolverFor(catalogSlug);
  const parsedVersion = typeof rulesetVersion === "number"
    ? rulesetVersion
    : typeof rulesetVersion === "string" && /^\d+$/.test(rulesetVersion)
    ? Number(rulesetVersion)
    : NaN;
  return Boolean(
    registration?.resolver_id &&
      Number.isSafeInteger(parsedVersion) && parsedVersion > 0 &&
      registration.ruleset_version === parsedVersion,
  );
}

export function liveResolverReadinessMessage(
  catalogSlug: string | null | undefined,
  rulesetVersion: number | string | null | undefined,
): string {
  const registration = liveResolverFor(catalogSlug);
  if (!registration) {
    return "No compiled live resolver is registered for this game.";
  }
  if (!registration.resolver_id) {
    return "No reviewed server resolver is registered for this game; it must remain unavailable.";
  }
  if (!hasRegisteredLiveResolver(catalogSlug, rulesetVersion)) {
    return "The deployed resolver does not match this game runtime's ruleset version.";
  }
  return "The compiled server resolver matches this game runtime.";
}
