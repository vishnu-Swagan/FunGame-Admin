import {
  requireExecutableResolver,
  type ReviewResolverModule,
  type ServerEntropy,
  type SettlementResult,
} from "./resolver-contract.ts";
import { BINGO_RESOLVER } from "./bingo.ts";
import { GIANT_JACKPOT_RESOLVER } from "./giant-jackpot.ts";
import { GOLDEN_WHEEL_RESOLVER } from "./golden-wheel.ts";
import { JOKER_BONUS_RESOLVER } from "./joker-bonus.ts";
import { KENO_RESOLVER } from "./keno.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/**
 * Deterministic counter-based entropy: an incrementing counter run through a
 * fixed 32-bit avalanche mix.  Same seed always replays the same sequence, no
 * call ever reaches Math.random, and the returned value is always a whole
 * number in [0, exclusiveMax).
 */
function seededEntropy(seed: number): ServerEntropy {
  let counter = seed >>> 0;
  return (exclusiveMax: number): number => {
    counter = (counter + 1) >>> 0;
    let mixed = counter;
    mixed = Math.imul(mixed ^ (mixed >>> 16), 2246822507) >>> 0;
    mixed = Math.imul(mixed ^ (mixed >>> 13), 3266489909) >>> 0;
    mixed = (mixed ^ (mixed >>> 16)) >>> 0;
    return mixed % exclusiveMax;
  };
}

const LIVE_MODULES = Object.freeze([
  BINGO_RESOLVER,
  JOKER_BONUS_RESOLVER,
  GIANT_JACKPOT_RESOLVER,
  GOLDEN_WHEEL_RESOLVER,
  KENO_RESOLVER,
]);

function executable<Selection, Outcome, Inspection>(
  module: ReviewResolverModule<Selection, Outcome, Inspection>,
): ReviewResolverModule<Selection, Outcome, Inspection> & {
  generateOutcome: (entropy: ServerEntropy) => Outcome;
  settle: (selection: Selection, stakePoints: number, outcome: Outcome) => SettlementResult;
} {
  requireExecutableResolver(module);
  return module;
}

function assertSettlement(result: SettlementResult, stake: number, label: string): void {
  assert(result.stake_points === stake, `${label} must echo the staked points`);
  assert(Number.isSafeInteger(result.payout_points), `${label} payout must be a whole number`);
  assert(result.payout_points >= 0, `${label} payout must never be negative`);
  assert(
    result.net_points === result.payout_points - result.stake_points,
    `${label} net must equal payout minus stake`,
  );
}

Deno.test("all five wheel/draw live modules pass the executable-resolver gate", () => {
  for (const module of LIVE_MODULES) {
    requireExecutableResolver(module as never);
    assert(module.manifest.readiness === "READY", `${module.manifest.catalog_slug} must be READY`);
    assert(module.manifest.ruleset_version === 1, `${module.manifest.catalog_slug} must be ruleset v1`);
    assert(module.manifest.blockers.length === 0, `${module.manifest.catalog_slug} must carry no blockers`);
    // Joker Bonus is the one single-player cabinet in this batch: level5 ships
    // no timer object, so it has no betting window to share. The mode must
    // match GAME_SPECS exactly, because the clocked and single-player
    // settlement lifecycles each admit one mode and refuse the other — a
    // disagreement leaves the title unsettleable by either.
    const expectedMode = module.manifest.catalog_slug === "joker-bonus"
      ? "PLAYER_PACED"
      : "CLOCKED_SHARED";
    assert(
      module.manifest.timing.mode === expectedMode,
      `${module.manifest.catalog_slug} must declare ${expectedMode}`,
    );
    assert(
      module.manifest.settlement.payout_semantics === "TOTAL_RETURN",
      `${module.manifest.catalog_slug} must settle as a total return`,
    );
    // Reveal and result are pinned for every mode. Betting and lock windows
    // exist only on a shared clock; a single-player cabinet deals on the
    // player's press, so those are legitimately null there and asserting a
    // positive number would force a fictitious betting window into the
    // manifest.
    const alwaysPinned = [
      module.manifest.timing.reveal_seconds,
      module.manifest.timing.result_seconds,
    ];
    const clockOnly = [
      module.manifest.timing.bet_seconds,
      module.manifest.timing.lock_seconds,
    ];
    for (const seconds of alwaysPinned) {
      assert(typeof seconds === "number" && seconds > 0, `${module.manifest.catalog_slug} timing must be pinned`);
    }
    for (const seconds of clockOnly) {
      if (module.manifest.timing.mode === "CLOCKED_SHARED") {
        assert(typeof seconds === "number" && seconds > 0, `${module.manifest.catalog_slug} clocked timing must be pinned`);
      } else {
        assert(seconds === null, `${module.manifest.catalog_slug} single-player timing must not claim a betting window`);
      }
    }
    assert(
      module.manifest.action_policy.executable.length > 0 &&
        module.manifest.action_policy.executable.every((action) =>
          module.manifest.action_policy.observed.includes(action)
        ),
      `${module.manifest.catalog_slug} executable actions must be observed actions`,
    );
  }
});

/**
 * Keno, Golden Wheel and Giant Jackpot validate the compact wire payload and
 * derive the `kind` discriminator themselves, so the wire form of their
 * outcomes drops that derived field.  Bingo and Joker Bonus carry `kind` on the
 * wire already and need no adapter.
 */
const WIRE_ADAPTERS: Readonly<Record<string, (outcome: Record<string, unknown>) => unknown>> = Object
  .freeze({
    "keno": ({ drawn }) => ({ drawn }),
    "golden-wheel": ({ outer, inner }) => ({ outer, inner }),
    "giant-jackpot": ({ windows }) => ({ windows }),
  });

Deno.test("generated outcomes always survive their own validator", () => {
  for (const module of LIVE_MODULES) {
    const live = executable(module as never) as ReviewResolverModule<unknown, unknown, unknown> & {
      generateOutcome: (entropy: ServerEntropy) => unknown;
    };
    const toWire = WIRE_ADAPTERS[module.manifest.catalog_slug] ?? ((outcome: unknown) => outcome);
    const entropy = seededEntropy(0x5eed_1234);
    for (let round = 0; round < 250; round++) {
      const outcome = live.generateOutcome(entropy);
      const wire = JSON.parse(JSON.stringify(toWire(outcome as Record<string, unknown>)));
      const validated = live.validateOutcome(wire);
      assert(
        JSON.stringify(validated) === JSON.stringify(outcome),
        `${module.manifest.catalog_slug} round ${round} must round-trip through validateOutcome`,
      );
    }
  }
});

Deno.test("Bingo draws fifteen distinct balls and settles line wins and losses", () => {
  const live = executable(BINGO_RESOLVER);
  const entropy = seededEntropy(11);
  for (let round = 0; round < 250; round++) {
    const outcome = live.generateOutcome(entropy);
    live.validateOutcome(outcome);
    assert(outcome.drawn.length === 15, "the declared ruleset draws fifteen balls");
    assert(new Set(outcome.drawn).size === 15, "balls must be distinct");
    assert(
      outcome.drawn.every((ball) => typeof ball === "number" && ball >= 1 && ball <= 25),
      "declared draws never emit the G marker",
    );
  }

  const selection = live.normalizeSelection("card:1");
  // Rows 1, 2 and 3 of card one, so three lines complete at x28.324568.
  const winning = live.validateOutcome({
    kind: "bingo_draw",
    drawn: [5, 1, 9, 25, 3, 8, 22, 10, 19, 7, 6, 18, 16, 11, 17],
  });
  const win = live.settle(selection, 20, winning);
  assertSettlement(win, 20, "bingo win");
  assert(
    win.payout_points === 566,
    "three completed lines must pay floor(20 * 28.324568) as a total return",
  );

  // A fifteen-ball draw whose ten missing numbers break every one of the twelve lines.
  const losing = live.validateOutcome({
    kind: "bingo_draw",
    drawn: [2, 4, 7, 10, 11, 13, 14, 15, 16, 17, 18, 19, 20, 21, 23],
  });
  const loss = live.settle(selection, 20, losing);
  assertSettlement(loss, 20, "bingo loss");
  assert(loss.payout_points === 0 && loss.net_points === -20, "a no-line draw must lose the stake");
});

Deno.test("Keno draws twenty distinct numbers and settles the declared ladder", () => {
  const live = executable(KENO_RESOLVER);
  const entropy = seededEntropy(22);
  for (let round = 0; round < 250; round++) {
    const outcome = live.generateOutcome(entropy);
    live.validateOutcome({ drawn: [...outcome.drawn] });
    assert(outcome.drawn.length === 20, "keno draws exactly twenty numbers");
    assert(new Set(outcome.drawn).size === 20, "keno numbers must be distinct");
    assert(
      outcome.drawn.every((ball) => Number.isInteger(ball) && ball >= 1 && ball <= 80),
      "keno numbers live in 1..80",
    );
  }

  const drawn = Array.from({ length: 20 }, (_value, index) => index + 1);
  const outcome = live.validateOutcome({ drawn });

  const winner = live.normalizeSelection("picks:1,2,3,4,5");
  const win = live.settle(winner, 10, outcome);
  assertSettlement(win, 10, "keno win");
  assert(
    win.payout_points === 1428,
    "five of five hits pays floor(10 * 142.889945) on the declared house rung",
  );

  const loser = live.normalizeSelection("picks:71,72,73,74,75");
  const loss = live.settle(loser, 10, outcome);
  assertSettlement(loss, 10, "keno loss");
  assert(loss.payout_points === 0 && loss.net_points === -10, "a five-pick blank must lose the stake");

  // The ten-pick column keeps the client-printed shape, scaled by 1.351701:
  // x2703.401839 on ten hits and x5.406804 on none.
  const tenHit = live.normalizeSelection("picks:1,2,3,4,5,6,7,8,9,10");
  assert(
    live.settle(tenHit, 5, outcome).payout_points === 13517,
    "ten of ten must pay floor(5 * 2703.401839) on the scaled client ladder",
  );
  const tenBlank = live.normalizeSelection("picks:71,72,73,74,75,76,77,78,79,80");
  assert(
    live.settle(tenBlank, 5, outcome).payout_points === 27,
    "no match on ten picks must pay floor(5 * 5.406804) on the scaled client ladder",
  );
});

Deno.test("Golden Wheel spins two independent rings and settles both/one/neither", () => {
  const live = executable(GOLDEN_WHEEL_RESOLVER);
  const entropy = seededEntropy(33);
  const seen = new Set<string>();
  for (let round = 0; round < 250; round++) {
    const outcome = live.generateOutcome(entropy);
    live.validateOutcome({ outer: outcome.outer, inner: outcome.inner });
    assert(outcome.outer >= 1 && outcome.outer <= 8, "outer ring must land 1..8");
    assert(outcome.inner >= 1 && outcome.inner <= 8, "inner ring must land 1..8");
    seen.add(`${outcome.outer}:${outcome.inner}`);
  }
  assert(seen.size > 16, "the two rings must vary independently, not move as a locked pair");

  const selection = live.normalizeSelection("column:3");
  const both = live.settle(selection, 50, live.validateOutcome({ outer: 3, inner: 3 }));
  assertSettlement(both, 50, "golden wheel both-ring win");
  assert(
    both.payout_points === 1558,
    "both rings on the column pay floor(50 * 31.160656)",
  );

  const one = live.settle(selection, 50, live.validateOutcome({ outer: 3, inner: 6 }));
  assertSettlement(one, 50, "golden wheel one-ring win");
  assert(one.payout_points === 94, "one ring on the column pays floor(50 * 1.888525)");

  const loss = live.settle(selection, 50, live.validateOutcome({ outer: 1, inner: 6 }));
  assertSettlement(loss, 50, "golden wheel loss");
  assert(loss.payout_points === 0 && loss.net_points === -50, "neither ring must lose the stake");
});

Deno.test("Giant Jackpot spins four weighted windows and settles the best row only", () => {
  const live = executable(GIANT_JACKPOT_RESOLVER);
  const entropy = seededEntropy(44);
  for (let round = 0; round < 250; round++) {
    const outcome = live.generateOutcome(entropy);
    live.validateOutcome({ windows: [...outcome.windows] });
    assert(outcome.windows.length === 4, "four windows per spin");
  }

  const selection = live.normalizeSelection("__stake__");
  const bars = live.validateOutcome({ windows: ["bar", "bar", "bar", "bar"] });
  const win = live.settle(selection, 40, bars);
  assertSettlement(win, 40, "giant jackpot win");
  assert(win.payout_points === 2429, "four bars pay floor(40 * 250 / 4.115297)");

  // Client-unpriced cap row, declared by MyDGP at base 250.
  const caps = live.validateOutcome({ windows: ["gameking", "gameking", "gameking", "orange"] });
  assert(live.settle(selection, 40, caps).payout_points === 2429, "three GameKing uses the declared cap price");

  const blank = live.validateOutcome({ windows: ["bar", "watermelon", "bell", "brinjal"] });
  const loss = live.settle(selection, 40, blank);
  assertSettlement(loss, 40, "giant jackpot loss");
  assert(loss.payout_points === 0 && loss.net_points === -40, "no matching row must lose the stake");
});

Deno.test("Joker Bonus deals a single 53-card deck and settles the displayed ladder", () => {
  const live = executable(JOKER_BONUS_RESOLVER);
  const entropy = seededEntropy(55);
  const selection = live.normalizeSelection("hand");
  let win: ReturnType<typeof live.generateOutcome> | null = null;
  let lose: ReturnType<typeof live.generateOutcome> | null = null;

  for (let round = 0; round < 250; round++) {
    const outcome = live.generateOutcome(entropy);
    live.validateOutcome(outcome);
    assert(outcome.initial.length === 5 && outcome.final.length === 5, "five cards in and five cards out");
    assert(outcome.holds.length === 5, "five hold flags");
    assert(
      outcome.initial.filter((card) => card === "JOKER").length <= 1,
      "the declared deck carries exactly one joker",
    );
    if (outcome.payout_multiplier > 0 && win === null) win = outcome;
    if (outcome.payout_multiplier === 0 && lose === null) lose = outcome;
  }

  assert(win !== null, "250 seeded rounds must contain at least one paying hand");
  assert(lose !== null, "250 seeded rounds must contain at least one losing hand");

  const paid = live.settle(selection, 25, win);
  assertSettlement(paid, 25, "joker bonus win");
  assert(
    paid.payout_points === Math.floor(25 * win.payout_multiplier),
    "payout must be the scaled total-return multiple, floored to a whole point",
  );
  assert(paid.payout_points > 0, "a paying category must credit points");

  const lost = live.settle(selection, 25, lose);
  assertSettlement(lost, 25, "joker bonus loss");
  assert(lost.payout_points === 0 && lost.net_points === -25, "a no-win hand must lose the stake");
});
