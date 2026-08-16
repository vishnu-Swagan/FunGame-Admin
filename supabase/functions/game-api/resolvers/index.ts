export * from "./resolver-contract.ts";
export * from "./triple-fun.ts";
export * from "./giant-jackpot.ts";
export * from "./golden-wheel.ts";
export * from "./keno.ts";
export * from "./lucky-8-line.ts";

import { GIANT_JACKPOT_RESOLVER } from "./giant-jackpot.ts";
import { GOLDEN_WHEEL_RESOLVER } from "./golden-wheel.ts";
import { KENO_RESOLVER } from "./keno.ts";
import { LUCKY_8_LINE_RESOLVER } from "./lucky-8-line.ts";
import { TRIPLE_FUN_RESOLVER } from "./triple-fun.ts";

export type WheelDrawReviewResolver =
  | typeof TRIPLE_FUN_RESOLVER
  | typeof GIANT_JACKPOT_RESOLVER
  | typeof GOLDEN_WHEEL_RESOLVER
  | typeof KENO_RESOLVER
  | typeof LUCKY_8_LINE_RESOLVER;

/**
 * Review-only map.  It is intentionally separate from the live resolver
 * registry: importing this file cannot advertise or open a cabinet.
 */
export const WHEEL_DRAW_REVIEW_RESOLVERS = Object.freeze({
  "triple-fun": TRIPLE_FUN_RESOLVER,
  "giant-jackpot": GIANT_JACKPOT_RESOLVER,
  "golden-wheel": GOLDEN_WHEEL_RESOLVER,
  "keno": KENO_RESOLVER,
  "lucky-8-line": LUCKY_8_LINE_RESOLVER,
});

export function wheelDrawReviewResolverFor(catalogSlug: string): WheelDrawReviewResolver | null {
  if (!Object.hasOwn(WHEEL_DRAW_REVIEW_RESOLVERS, catalogSlug)) return null;
  return (WHEEL_DRAW_REVIEW_RESOLVERS as Readonly<Record<string, WheelDrawReviewResolver>>)[catalogSlug];
}
