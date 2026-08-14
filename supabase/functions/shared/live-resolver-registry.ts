/**
 * Compile-time admission registry for live game resolvers.
 *
 * A database QA flag is an operational approval, not executable evidence that
 * the deployed Edge bundle can run a complete result/settlement lifecycle.
 * Every title therefore needs an explicit source-code registration tied to a
 * ruleset version before it may be advertised or opened.  The registry is
 * intentionally all-null today: no cabinet has a reviewed server resolver.
 *
 * When a title is implemented, change exactly that row in the same change set
 * as its resolver, settlement tests, and compiled runtime-contract version.
 */

export type ResolverRegistration = {
  readonly catalog_slug: string;
  readonly resolver_id: string | null;
  readonly ruleset_version: number | null;
};

const CATALOG_SLUGS = [
  "7up7down",
  "fun-ab",
  "triple-fun",
  "fun-roulette",
  "fun-target",
  "bingo",
  "joker-bonus",
  "giant-jackpot",
  "golden-wheel",
  "keno",
  "checker",
  "lucky-8-line",
  "fever-joker-bonus",
  "no-hold",
  "champion-poker",
] as const;

export const LIVE_RESOLVER_REGISTRY: Readonly<Record<string, ResolverRegistration>> =
  Object.freeze(
    Object.fromEntries(
      CATALOG_SLUGS.map((catalog_slug) => [catalog_slug, Object.freeze({
        catalog_slug,
        resolver_id: null,
        ruleset_version: null,
      })]),
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
