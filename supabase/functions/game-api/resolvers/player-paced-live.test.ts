import {
  requireExecutableResolver,
  type ReviewResolverModule,
  type ServerEntropy,
  type SettlementResult,
} from "./resolver-contract.ts";
import {
  CHECKER_RESOLVER,
  generateCheckerOutcome,
  normalizeCheckerSelection,
  settleChecker,
  validateCheckerOutcome,
} from "./checker.ts";
import {
  generateLucky8Outcome,
  LUCKY_8_LINE_RESOLVER,
  normalizeLucky8Selection,
  settleLucky8,
  validateLucky8Outcome,
} from "./lucky-8-line.ts";
import {
  FEVER_JOKER_BONUS_RESOLVER,
  generateFeverJokerBonusOutcome,
  normalizeFeverJokerBonusSelection,
  settleFeverJokerBonus,
  validateFeverJokerBonusOutcome,
} from "./fever-joker-bonus.ts";
import {
  generateNoHoldOutcome,
  NO_HOLD_RESOLVER,
  normalizeNoHoldSelection,
  settleNoHold,
  validateNoHoldOutcome,
} from "./no-hold.ts";
import {
  CHAMPION_POKER_RESOLVER,
  generateChampionPokerOutcome,
  normalizeChampionPokerSelection,
  settleChampionPoker,
  validateChampionPokerOutcome,
} from "./champion-poker.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/**
 * Deterministic counter-based entropy: an incrementing counter run through a
 * fixed 32-bit avalanche mix.  Same seed always replays the same sequence, and
 * no call ever reaches Math.random.
 */
function seededEntropy(seed: number): ServerEntropy {
  let counter = seed >>> 0;
  return (exclusiveMax: number) => {
    counter = (counter + 1) >>> 0;
    let mixed = counter;
    mixed = Math.imul(mixed ^ (mixed >>> 16), 2246822507) >>> 0;
    mixed = Math.imul(mixed ^ (mixed >>> 13), 3266489909) >>> 0;
    mixed = (mixed ^ (mixed >>> 16)) >>> 0;
    return mixed % exclusiveMax;
  };
}

const ITERATIONS = 200;

/**
 * `toWire` projects a generated outcome back onto the payload shape its own
 * `validateOutcome` accepts.  Every module here round-trips its whole outcome
 * except Lucky 8 Line, whose validator accepts the bare `{ grid }` wire payload
 * and adds the `kind` discriminator itself.
 */
function assertGeneratesValidOutcomes(
  label: string,
  generate: (entropy: ServerEntropy) => unknown,
  validate: (input: unknown) => unknown,
  toWire: (outcome: unknown) => unknown = (outcome) => outcome,
): void {
  const entropy = seededEntropy(0x51ab);
  for (let round = 0; round < ITERATIONS; round++) {
    const outcome = generate(entropy);
    // A structural violation raises ResolverInputError out of validateOutcome.
    validate(JSON.parse(JSON.stringify(toWire(outcome))));
  }
  assert(true, `${label} generated ${ITERATIONS} valid outcomes`);
}

function assertSettlementShape(label: string, result: SettlementResult, stake: number): void {
  assert(result.stake_points === stake, `${label} must echo the staked points`);
  assert(Number.isSafeInteger(result.payout_points), `${label} payout must be a whole number of points`);
  assert(result.payout_points >= 0, `${label} payout must never be negative`);
  assert(
    result.net_points === result.payout_points - result.stake_points,
    `${label} net must equal payout minus stake`,
  );
}

Deno.test("Checker generates two-ring draws and settles a matched and a missed cell", () => {
  assertGeneratesValidOutcomes("checker", generateCheckerOutcome, validateCheckerOutcome);

  const doubledTwentyFive = validateCheckerOutcome({
    kind: "checker_two_ring",
    outer: 3,
    inner: 4,
    multiplier: 25,
    doubled: true,
  });

  const win = settleChecker(normalizeCheckerSelection("cell:3-4"), 100, doubledTwentyFive);
  assertSettlementShape("checker win", win, 100);
  assert(win.payout_points === 4736, "the 25x face pays its house-scaled 23.6842x, doubled by the D flag");
  assert(win.net_points === 4636, "a 100-point 47.3684x win nets 4636 points after flooring");

  const loss = settleChecker(normalizeCheckerSelection("cell:1-1"), 100, doubledTwentyFive);
  assertSettlementShape("checker loss", loss, 100);
  assert(loss.payout_points === 0, "an unmatched cell credits nothing");

  const plainFace = validateCheckerOutcome({
    kind: "checker_two_ring",
    outer: 5,
    inner: 5,
    multiplier: 15,
    doubled: false,
  });
  assert(
    settleChecker(normalizeCheckerSelection("cell:5-5"), 7, plainFace).payout_points === 99,
    "the 15x face pays its house-scaled 14.2105x, floored to 99 points on a 7-point chip",
  );

  requireExecutableResolver(CHECKER_RESOLVER as ReviewResolverModule<unknown, unknown, unknown>);
});

Deno.test("Lucky 8 Line generates strip grids and settles line, scatter and losing rounds", () => {
  assertGeneratesValidOutcomes(
    "lucky-8-line",
    generateLucky8Outcome,
    validateLucky8Outcome,
    (outcome) => ({ grid: (outcome as { grid: unknown }).grid }),
  );

  const selection = normalizeLucky8Selection({ line_stakes: [10, 10, 10, 10, 10, 10, 10, 10] });
  assert(selection.total_stake_points === 80, "eight ten-point lines total 80 points");

  // Line 1 is the middle row: three jj pay 94.7323x that line's ten points.
  const middleRowJj = validateLucky8Outcome({
    grid: [
      ["orange", "jj", "banana"],
      ["mango", "jj", "apple"],
      ["watermelon", "jj", "coconut"],
    ],
  });
  const lineWin = settleLucky8(selection, 80, middleRowJj);
  assertSettlementShape("lucky-8 line win", lineWin, 80);
  assert(lineWin.payout_points === 947, "three jj on line 1 return 94.7323x that line's ten points, floored");

  // A single Funrep scatter returns 0.9473x the round total.
  const oneScatter = validateLucky8Outcome({
    grid: [
      ["funrep", "orange", "banana"],
      ["mango", "apple", "watermelon"],
      ["coconut", "jj", "orange"],
    ],
  });
  const scatter = settleLucky8(selection, 80, oneScatter);
  assertSettlementShape("lucky-8 scatter", scatter, 80);
  assert(scatter.payout_points === 75, "one Funrep returns 0.9473x the 80-point round total, floored");
  assert(scatter.net_points === -5, "a single Funrep now returns just under the round total");

  const blank = validateLucky8Outcome({
    grid: [
      ["orange", "banana", "apple"],
      ["mango", "watermelon", "coconut"],
      ["jj", "orange", "banana"],
    ],
  });
  const loss = settleLucky8(selection, 80, blank);
  assertSettlementShape("lucky-8 loss", loss, 80);
  assert(loss.payout_points === 0, "a grid with no line, cherry or Funrep component credits nothing");

  requireExecutableResolver(LUCKY_8_LINE_RESOLVER as ReviewResolverModule<unknown, unknown, unknown>);
});

Deno.test("Fever Joker Bonus generates legal two-deal rounds and settles the recovered ladder", () => {
  assertGeneratesValidOutcomes(
    "fever-joker-bonus",
    generateFeverJokerBonusOutcome,
    validateFeverJokerBonusOutcome,
  );

  const starFlush = validateFeverJokerBonusOutcome({
    kind: "fever_joker_bonus_hand",
    initial: ["5C", "6C", "7C", "8C", "2D"],
    holds: [true, true, true, true, false],
    final: ["5C", "6C", "7C", "8C", "9C"],
    category: "star_flush",
    payout_multiplier: 142.5885,
  });
  const win = settleFeverJokerBonus(normalizeFeverJokerBonusSelection("hand"), 100, starFlush);
  assertSettlementShape("fever star flush", win, 100);
  assert(win.payout_points === 14258, "the STAR FLUSH row returns its house-scaled 142.5885x total, floored");

  const noWin = validateFeverJokerBonusOutcome({
    kind: "fever_joker_bonus_hand",
    initial: ["2S", "5H", "9D", "JC", "4S"],
    holds: [false, false, false, false, false],
    final: ["3S", "6H", "10D", "QC", "7S"],
    category: "no_win",
    payout_multiplier: 0,
  });
  const loss = settleFeverJokerBonus(normalizeFeverJokerBonusSelection("hand"), 100, noWin);
  assertSettlementShape("fever loss", loss, 100);
  assert(loss.payout_points === 0, "a no-win hand credits nothing");

  requireExecutableResolver(FEVER_JOKER_BONUS_RESOLVER as ReviewResolverModule<unknown, unknown, unknown>);
});

Deno.test("No Hold generates single-deal hands and settles the eleven-row ladder", () => {
  assertGeneratesValidOutcomes("no-hold", generateNoHoldOutcome, validateNoHoldOutcome);

  const quads = validateNoHoldOutcome({
    kind: "no_hold_hand",
    cards: ["9S", "9H", "9D", "9C", "2S"],
    category: "four_of_a_kind",
    payout_multiplier: 38.0559,
  });
  const win = settleNoHold(normalizeNoHoldSelection("hand"), 25, quads);
  assertSettlementShape("no-hold quads", win, 25);
  assert(win.payout_points === 951, "four of a kind returns its house-scaled 38.0559x total, floored");
  assert(win.net_points === 926, "a 25-point 38.0559x win nets 926 points after flooring");

  const noWin = validateNoHoldOutcome({
    kind: "no_hold_hand",
    cards: ["2S", "5H", "9D", "10C", "4S"],
    category: "no_win",
    payout_multiplier: 0,
  });
  const loss = settleNoHold(normalizeNoHoldSelection("hand"), 25, noWin);
  assertSettlementShape("no-hold loss", loss, 25);
  assert(loss.payout_points === 0, "a no-win hand credits nothing");

  requireExecutableResolver(NO_HOLD_RESOLVER as ReviewResolverModule<unknown, unknown, unknown>);
});

Deno.test("Champion Poker generates legal deal/draw rounds and settles the recovered ladder", () => {
  assertGeneratesValidOutcomes(
    "champion-poker",
    generateChampionPokerOutcome,
    validateChampionPokerOutcome,
  );

  const highPair = validateChampionPokerOutcome({
    kind: "champion_poker_hand",
    initial: ["JS", "JH", "3D", "7C", "9S"],
    holds: [true, true, false, false, false],
    final: ["JS", "JH", "4D", "8C", "10S"],
    category: "high_pair",
    payout_multiplier: 0.9528,
  });
  const push = settleChampionPoker(normalizeChampionPokerSelection("hand"), 100, highPair);
  assertSettlementShape("champion high pair", push, 100);
  assert(push.payout_points === 95, "the high-pair row returns its house-scaled 0.9528x of the stake");
  assert(push.net_points === -5, "the once-even high-pair row now returns just under the stake");

  const fullHouse = validateChampionPokerOutcome({
    kind: "champion_poker_hand",
    initial: ["5S", "5H", "5D", "KC", "KS"],
    holds: [true, true, true, true, true],
    final: ["5S", "5H", "5D", "KC", "KS"],
    category: "full_house",
    payout_multiplier: 9.5277,
  });
  const win = settleChampionPoker(normalizeChampionPokerSelection("hand"), 100, fullHouse);
  assertSettlementShape("champion full house", win, 100);
  assert(win.payout_points === 952, "the full-house row returns its house-scaled 9.5277x total, floored");

  const noWin = validateChampionPokerOutcome({
    kind: "champion_poker_hand",
    initial: ["2S", "5H", "9D", "JC", "4S"],
    holds: [false, false, false, false, false],
    final: ["3S", "6H", "10D", "QC", "7S"],
    category: "no_win",
    payout_multiplier: 0,
  });
  const loss = settleChampionPoker(normalizeChampionPokerSelection("hand"), 100, noWin);
  assertSettlementShape("champion loss", loss, 100);
  assert(loss.payout_points === 0, "a no-win hand credits nothing");

  requireExecutableResolver(CHAMPION_POKER_RESOLVER as ReviewResolverModule<unknown, unknown, unknown>);
});

Deno.test("every player-paced resolver settles generated rounds with integer-consistent points", () => {
  const entropy = seededEntropy(0xd1ce);
  const stake = 40;
  const lucky8 = normalizeLucky8Selection({ line_stakes: [5, 5, 5, 5, 5, 5, 5, 5] });
  for (let round = 0; round < ITERATIONS; round++) {
    const cases: readonly SettlementResult[] = [
      settleChecker(normalizeCheckerSelection("cell:2-3"), stake, generateCheckerOutcome(entropy)),
      settleLucky8(lucky8, stake, generateLucky8Outcome(entropy)),
      settleFeverJokerBonus(
        normalizeFeverJokerBonusSelection("hand"),
        stake,
        generateFeverJokerBonusOutcome(entropy),
      ),
      settleNoHold(normalizeNoHoldSelection("hand"), stake, generateNoHoldOutcome(entropy)),
      settleChampionPoker(
        normalizeChampionPokerSelection("hand"),
        stake,
        generateChampionPokerOutcome(entropy),
      ),
    ];
    for (const result of cases) {
      assertSettlementShape(`round ${round}`, result, stake);
    }
  }
});
