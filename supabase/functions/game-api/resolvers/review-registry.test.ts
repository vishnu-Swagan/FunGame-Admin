import {
  assertReviewResolverRegistryIntegrity,
  hasExecutableReviewResolver,
  REVIEW_RESOLVER_REGISTRY,
  reviewResolverFor,
} from "./review-registry.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("review registry covers all fifteen cabinets and is internally consistent", () => {
  assertReviewResolverRegistryIntegrity();
  const resolvers = Object.values(REVIEW_RESOLVER_REGISTRY);
  assert(resolvers.length === 15, "review registry must contain exactly fifteen cabinets");
  assert(new Set(resolvers.map((resolver) => resolver.manifest.module_id)).size === 15,
    "review module IDs must be unique");
  assert(resolvers.every((resolver) => resolver.manifest.virtual_points_only),
    "every cabinet must remain virtual-points-only");
});

Deno.test("review registry lookup has no prototype fallback", () => {
  assert(reviewResolverFor("fun-ab")?.manifest.catalog_slug === "fun-ab", "known resolver is missing");
  assert(reviewResolverFor("toString") === null, "prototype properties must not resolve");
  assert(reviewResolverFor("") === null, "empty resolver key must not resolve");
});

Deno.test("every review module is executable for its own production ruleset", () => {
  for (const resolver of Object.values(REVIEW_RESOLVER_REGISTRY)) {
    const slug = resolver.manifest.catalog_slug;
    assert(resolver.manifest.readiness === "READY", `${slug} is unexpectedly blocked`);
    assert(resolver.manifest.blockers.length === 0, `${slug} still carries blockers`);
    assert(typeof resolver.generateOutcome === "function", `${slug} cannot generate an outcome`);
    assert(typeof resolver.settle === "function", `${slug} cannot settle`);
    assert(hasExecutableReviewResolver(slug, 1), `${slug} must pass executable admission at v1`);
    // Admission is per exact ruleset, so a version the module does not
    // implement must still be refused.
    assert(!hasExecutableReviewResolver(slug, 2), `${slug} must refuse an unimplemented ruleset`);
  }
});
