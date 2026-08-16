import { GAME_SPECS } from "../game-core.ts";
import {
  liveResolverFor,
  LIVE_RESOLVER_REGISTRY,
} from "../../shared/live-resolver-registry.ts";
import {
  assertFailClosedResolver,
  requireExecutableResolver,
  type ReviewResolverModule,
} from "./resolver-contract.ts";
import { SEVEN_UP_SEVEN_DOWN_RESOLVER } from "./seven-up-seven-down.ts";
import { FUN_AB_RESOLVER } from "./fun-ab.ts";
import { FUN_ROULETTE_RESOLVER } from "./fun-roulette.ts";
import { FUN_TARGET_RESOLVER } from "./fun-target.ts";
import { BINGO_RESOLVER } from "./bingo.ts";
import { TRIPLE_FUN_RESOLVER } from "./triple-fun.ts";
import { GIANT_JACKPOT_RESOLVER } from "./giant-jackpot.ts";
import { GOLDEN_WHEEL_RESOLVER } from "./golden-wheel.ts";
import { KENO_RESOLVER } from "./keno.ts";
import { LUCKY_8_LINE_RESOLVER } from "./lucky-8-line.ts";
import { JOKER_BONUS_RESOLVER } from "./joker-bonus.ts";
import { CHECKER_RESOLVER } from "./checker.ts";
import { FEVER_JOKER_BONUS_RESOLVER } from "./fever-joker-bonus.ts";
import { NO_HOLD_RESOLVER } from "./no-hold.ts";
import { CHAMPION_POKER_RESOLVER } from "./champion-poker.ts";
import { AVIATOR_RESOLVER } from "./aviator.ts";

/**
 * Review evidence for every public cabinet.  This map is deliberately distinct
 * from LIVE_RESOLVER_REGISTRY: a BLOCKED module may validate captured payloads
 * in tests, but cannot generate an outcome, settle a wager, or advertise a
 * cabinet.
 */
export const REVIEW_RESOLVER_REGISTRY = Object.freeze({
  "7up7down": SEVEN_UP_SEVEN_DOWN_RESOLVER,
  "fun-ab": FUN_AB_RESOLVER,
  "triple-fun": TRIPLE_FUN_RESOLVER,
  "fun-roulette": FUN_ROULETTE_RESOLVER,
  "fun-target": FUN_TARGET_RESOLVER,
  "bingo": BINGO_RESOLVER,
  "joker-bonus": JOKER_BONUS_RESOLVER,
  "giant-jackpot": GIANT_JACKPOT_RESOLVER,
  "golden-wheel": GOLDEN_WHEEL_RESOLVER,
  "keno": KENO_RESOLVER,
  "checker": CHECKER_RESOLVER,
  "lucky-8-line": LUCKY_8_LINE_RESOLVER,
  "fever-joker-bonus": FEVER_JOKER_BONUS_RESOLVER,
  "no-hold": NO_HOLD_RESOLVER,
  "champion-poker": CHAMPION_POKER_RESOLVER,
  "aviator": AVIATOR_RESOLVER,
});

export type ReviewResolver =
  typeof REVIEW_RESOLVER_REGISTRY[keyof typeof REVIEW_RESOLVER_REGISTRY];

type ErasedReviewResolver = ReviewResolverModule<unknown, unknown, unknown>;

function erased(resolver: ReviewResolver): ErasedReviewResolver {
  return resolver as unknown as ErasedReviewResolver;
}

export function reviewResolverFor(catalogSlug: string | null | undefined): ReviewResolver | null {
  if (!catalogSlug || !Object.hasOwn(REVIEW_RESOLVER_REGISTRY, catalogSlug)) return null;
  return (REVIEW_RESOLVER_REGISTRY as Readonly<Record<string, ReviewResolver>>)[catalogSlug];
}

export function hasExecutableReviewResolver(
  catalogSlug: string | null | undefined,
  rulesetVersion: number | string | null | undefined,
): boolean {
  const resolver = reviewResolverFor(catalogSlug);
  if (!resolver) return false;
  const parsedVersion = typeof rulesetVersion === "number"
    ? rulesetVersion
    : typeof rulesetVersion === "string" && /^\d+$/.test(rulesetVersion)
    ? Number(rulesetVersion)
    : NaN;
  try {
    requireExecutableResolver(erased(resolver));
  } catch {
    return false;
  }
  return resolver.manifest.ruleset_version === parsedVersion;
}

/**
 * A startup/build invariant: the catalog, evidence registry and live registry
 * must describe the same fifteen titles.  A blocked title must be absent from
 * the live registry; a ready title must have an exact ID/version registration.
 */
export function assertReviewResolverRegistryIntegrity(): void {
  const expected = GAME_SPECS.map((spec) => spec.catalog_slug).sort();
  const reviewed = Object.keys(REVIEW_RESOLVER_REGISTRY).sort();
  const registered = Object.keys(LIVE_RESOLVER_REGISTRY).sort();
  if (JSON.stringify(reviewed) !== JSON.stringify(expected) ||
      JSON.stringify(registered) !== JSON.stringify(expected)) {
    throw new Error("The compiled game, review and live resolver catalogs differ.");
  }

  const moduleIds = new Set<string>();
  for (const catalogSlug of expected) {
    const resolver = reviewResolverFor(catalogSlug);
    const registration = liveResolverFor(catalogSlug);
    if (!resolver || !registration || resolver.manifest.catalog_slug !== catalogSlug ||
        moduleIds.has(resolver.manifest.module_id)) {
      throw new Error(`${catalogSlug} has an invalid review resolver registration.`);
    }
    moduleIds.add(resolver.manifest.module_id);

    if (resolver.manifest.readiness === "BLOCKED") {
      assertFailClosedResolver(erased(resolver));
      if (registration.resolver_id !== null || registration.ruleset_version !== null) {
        throw new Error(`${catalogSlug} is blocked but appears in the live resolver registry.`);
      }
      continue;
    }

    requireExecutableResolver(erased(resolver));
    if (registration.resolver_id !== resolver.manifest.live_resolver_id ||
        registration.ruleset_version !== resolver.manifest.ruleset_version) {
      throw new Error(`${catalogSlug} executable resolver does not match its live registration.`);
    }
  }
}

assertReviewResolverRegistryIntegrity();
