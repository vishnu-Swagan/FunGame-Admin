import * as sevenUpDown from "./seven-up-seven-down.ts";
import * as funAb from "./fun-ab.ts";
import * as tripleFun from "./triple-fun.ts";
import * as funRoulette from "./fun-roulette.ts";
import * as funTarget from "./fun-target.ts";
import * as bingo from "./bingo.ts";
import * as jokerBonus from "./joker-bonus.ts";
import * as giantJackpot from "./giant-jackpot.ts";
import * as goldenWheel from "./golden-wheel.ts";
import * as keno from "./keno.ts";
import * as checker from "./checker.ts";
import * as lucky8Line from "./lucky-8-line.ts";
import * as feverJokerBonus from "./fever-joker-bonus.ts";
import * as noHold from "./no-hold.ts";
import * as championPoker from "./champion-poker.ts";
import * as aviator from "./aviator.ts";
import { REVIEW_RESOLVER_REGISTRY } from "./review-registry.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

type TestFunction = () => void | Promise<void>;
const deno = (globalThis as unknown as { Deno?: { test: (name: string, callback: TestFunction) => void } }).Deno;
const test = deno?.test.bind(deno) || ((name: string, callback: TestFunction): void => {
  const result = callback();
  if (result instanceof Promise) {
    throw new Error(`Node fallback only supports synchronous test '${name}'.`);
  }
  console.log(`PASS ${name}`);
});

const TITLE_MODULES = Object.freeze({
  "7up7down": sevenUpDown,
  "fun-ab": funAb,
  "triple-fun": tripleFun,
  "fun-roulette": funRoulette,
  "fun-target": funTarget,
  bingo,
  "joker-bonus": jokerBonus,
  "giant-jackpot": giantJackpot,
  "golden-wheel": goldenWheel,
  keno,
  checker,
  "lucky-8-line": lucky8Line,
  "fever-joker-bonus": feverJokerBonus,
  "no-hold": noHold,
  "champion-poker": championPoker,
  aviator,
});

const SETTLEMENT_EXPORT = /(settle|payout|price|award|credit|refund|ledger|winningpoint)/i;

function assertNoLedgerShapedExpected(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoLedgerShapedExpected(item, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== "object") return;

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = `${path}.${key}`;
    assert(key !== "net_points", `${childPath} exposes ledger-ready net points`);
    if (key.endsWith("payout_points") || key.endsWith("credit_points")) {
      assert(child === null, `${childPath} must remain null while the title is blocked`);
    }
    assertNoLedgerShapedExpected(child, childPath);
  }
}

test("all fifteen titles settle only through the reviewed module contract", () => {
  assert(Object.keys(TITLE_MODULES).length === 16, "surface audit must cover all sixteen titles");

  // Every title is live on ruleset v1, so settlement is expected to exist. The
  // invariant is that there is exactly ONE of it: a module may export its
  // settle implementation under a descriptive name, but that export must be
  // the very function the registered module settles through. A second,
  // different points-computing function would be reachable without the
  // manifest and live-registration gate the lifecycle enforces.
  for (const [slug, module] of Object.entries(TITLE_MODULES)) {
    const resolver =
      (REVIEW_RESOLVER_REGISTRY as Record<string, { settle: unknown }>)[slug];
    assert(resolver !== undefined, `${slug} must be registered for review`);
    const settle = resolver.settle;
    const bypass = Object.entries(module)
      .filter(([name, value]) =>
        typeof value === "function" && SETTLEMENT_EXPORT.test(name) && value !== settle
      )
      .map(([name]) => name);
    assert(bypass.length === 0, `${slug} exports a settlement bypass: ${bypass.join(", ")}`);
  }
});

test("review vectors describe evidence without pre-computed ledger results", () => {
  for (const [slug, resolver] of Object.entries(REVIEW_RESOLVER_REGISTRY)) {
    assert(resolver.manifest.readiness === "READY", `${slug} is unexpectedly blocked`);
    assert(typeof resolver.settle === "function", `${slug} must be able to settle`);
    // Vectors are review evidence about outcome shape, not settlement fixtures.
    // A vector carrying ledger-ready points would let a reader take a payout
    // from documentation rather than from the priced paytable.
    for (const vector of resolver.deterministicVectors) {
      assertNoLedgerShapedExpected(vector.expected, `${slug}.${vector.name}.expected`);
    }
  }
});
