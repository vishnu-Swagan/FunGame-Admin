import {
  requireExecutableResolver,
  type ReviewResolverModule,
  type ServerEntropy,
  type SettlementResult,
} from "./resolver-contract.ts";
import {
  generateSevenUpDownOutcome,
  normalizeSevenUpDownSelection,
  SEVEN_UP_SEVEN_DOWN_RESOLVER,
  settleSevenUpDown,
  validateSevenUpDownOutcome,
} from "./seven-up-seven-down.ts";
import {
  FUN_AB_RESOLVER,
  generateFunAbOutcome,
  normalizeFunAbSelection,
  settleFunAb,
  validateFunAbOutcome,
} from "./fun-ab.ts";
import {
  generateTripleFunOutcome,
  normalizeTripleFunSelection,
  settleTripleFun,
  TRIPLE_FUN_RESOLVER,
  validateTripleFunOutcome,
} from "./triple-fun.ts";
import {
  FUN_ROULETTE_RESOLVER,
  generateFunRouletteOutcome,
  normalizeFunRouletteSelection,
  settleFunRoulette,
  validateFunRouletteOutcome,
} from "./fun-roulette.ts";
import {
  FUN_TARGET_RESOLVER,
  generateFunTargetOutcome,
  normalizeFunTargetSelection,
  settleFunTarget,
  validateFunTargetOutcome,
} from "./fun-target.ts";

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
 * Feeds every generated outcome back through the module's own validateOutcome.
 * `toWire` exists only for Triple Fun, whose validator accepts the compact wire
 * form and derives the projected triple/double/single fields itself.
 */
function assertGeneratesValidOutcomes(
  label: string,
  generate: (entropy: ServerEntropy) => unknown,
  validate: (input: unknown) => unknown,
  toWire: (outcome: unknown) => unknown = (outcome) => outcome,
): void {
  const entropy = seededEntropy(0x5eed);
  for (let round = 0; round < ITERATIONS; round++) {
    const outcome = generate(entropy);
    // A structural violation raises ResolverInputError out of validateOutcome.
    const revalidated = validate(JSON.parse(JSON.stringify(toWire(outcome))));
    assert(
      JSON.stringify(revalidated) === JSON.stringify(outcome),
      `${label} round ${round} must revalidate to an identical outcome`,
    );
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

Deno.test("7Up7Down generates validator-clean cards and settles both directions", () => {
  assertGeneratesValidOutcomes(
    "7up7down",
    generateSevenUpDownOutcome,
    validateSevenUpDownOutcome,
  );

  const upCard = validateSevenUpDownOutcome({
    kind: "seven_up_down_card",
    card: "9D",
    winner: "up",
    lost_on_seven: false,
  });
  const win = settleSevenUpDown(normalizeSevenUpDownSelection("up"), 100, upCard);
  assertSettlementShape("7up7down win", win, 100);
  assert(win.payout_points === 195, "a winning direction returns 1.95x total");
  assert(win.net_points === 95, "a 100-point win nets 95 points");

  const loss = settleSevenUpDown(normalizeSevenUpDownSelection("down"), 100, upCard);
  assertSettlementShape("7up7down loss", loss, 100);
  assert(loss.payout_points === 0, "a losing direction credits nothing");

  requireExecutableResolver(SEVEN_UP_SEVEN_DOWN_RESOLVER as ReviewResolverModule<unknown, unknown, unknown>);
});

Deno.test("Fun AB generates legal Andar-first deals and settles the ruleset v1 table", () => {
  assertGeneratesValidOutcomes("fun-ab", generateFunAbOutcome, validateFunAbOutcome);

  const outcome = validateFunAbOutcome({
    kind: "andar_bahar",
    joker: "7H",
    sequence: [
      { card: "3C", side: "andar" },
      { card: "7D", side: "bahar" },
    ],
    winner: "bahar",
  });

  const sideWin = settleFunAb(normalizeFunAbSelection("bahar"), 100, outcome);
  assertSettlementShape("fun-ab side win", sideWin, 100);
  assert(sideWin.payout_points === 185, "Bahar returns 1.8556x total under ruleset v1");

  const sideLoss = settleFunAb(normalizeFunAbSelection("andar"), 100, outcome);
  assertSettlementShape("fun-ab side loss", sideLoss, 100);
  assert(sideLoss.payout_points === 0, "the losing side credits nothing");

  const rankWin = settleFunAb(normalizeFunAbSelection("rank-7"), 100, outcome);
  assert(rankWin.payout_points === 1170, "a matching rank returns 11.7x total");
  const sevenMarker = settleFunAb(normalizeFunAbSelection("seven"), 100, outcome);
  assert(sevenMarker.payout_points === 1170, "the card-7 marker returns 11.7x total");
  const suitWin = settleFunAb(normalizeFunAbSelection("heart"), 100, outcome);
  assert(suitWin.payout_points === 360, "a matching suit returns 3.6x total");
  const colourWin = settleFunAb(normalizeFunAbSelection("red"), 100, outcome);
  assert(colourWin.payout_points === 180, "a matching colour returns 1.8x total");
  const bandWin = settleFunAb(normalizeFunAbSelection("8-k"), 100, outcome);
  assert(bandWin.payout_points === 0, "an 8-K marker loses against a rank-7 joker");
  const smallBand = settleFunAb(normalizeFunAbSelection("a-6"), 100, outcome);
  assert(smallBand.payout_points === 0, "an A-6 marker loses against a rank-7 joker");
  assert(
    settleFunAb(normalizeFunAbSelection("spade"), 100, outcome).payout_points === 0,
    "a non-matching suit credits nothing",
  );
  // Fractional multipliers must floor rather than emit fractional points.
  assert(settleFunAb(normalizeFunAbSelection("bahar"), 11, outcome).payout_points === 20,
    "1.8556x on 11 points floors to 20");

  requireExecutableResolver(FUN_AB_RESOLVER as ReviewResolverModule<unknown, unknown, unknown>);
});

Deno.test("Triple Fun generates three-digit draws and settles every class", () => {
  assertGeneratesValidOutcomes(
    "triple-fun",
    generateTripleFunOutcome,
    validateTripleFunOutcome,
    (outcome) => (outcome as { triple: string }).triple,
  );

  const outcome = validateTripleFunOutcome("592");

  const tripleWin = settleTripleFun(normalizeTripleFunSelection("triple:592"), 100, outcome);
  assertSettlementShape("triple-fun triple win", tripleWin, 100);
  assert(tripleWin.payout_points === 90000, "a triple returns 900x total");

  const doubleWin = settleTripleFun(normalizeTripleFunSelection("double:92"), 100, outcome);
  assert(doubleWin.payout_points === 9000, "a double returns 90x total");

  const singleWin = settleTripleFun(normalizeTripleFunSelection("single:2"), 100, outcome);
  assertSettlementShape("triple-fun single win", singleWin, 100);
  assert(singleWin.payout_points === 900, "a single returns 9x total");
  // Every Triple Fun multiplier is a whole number, so no stake can floor away a point.
  assert(
    settleTripleFun(normalizeTripleFunSelection("single:2"), 5, outcome).payout_points === 45,
    "9x on 5 points is exact at 45",
  );

  const loss = settleTripleFun(normalizeTripleFunSelection("triple:000"), 100, outcome);
  assertSettlementShape("triple-fun loss", loss, 100);
  assert(loss.payout_points === 0, "a non-matching triple credits nothing");

  requireExecutableResolver(TRIPLE_FUN_RESOLVER as ReviewResolverModule<unknown, unknown, unknown>);
});

Deno.test("Fun Roulette generates wheel pockets and settles inside, outside and sector bets", () => {
  assertGeneratesValidOutcomes("fun-roulette", generateFunRouletteOutcome, validateFunRouletteOutcome);

  const two = validateFunRouletteOutcome({ kind: "american_roulette", pocket: "2", color: "black" });

  const straight = settleFunRoulette(normalizeFunRouletteSelection("straight:2"), 100, two);
  assertSettlementShape("fun-roulette straight win", straight, 100);
  assert(straight.payout_points === 3420, "a straight returns 34.2x total");

  const split = settleFunRoulette(normalizeFunRouletteSelection("split:3-2"), 100, two);
  assert(split.payout_points === 1710, "a split returns 17.1x total");
  const street = settleFunRoulette(normalizeFunRouletteSelection("street:1-2-3"), 100, two);
  assert(street.payout_points === 1140, "a street returns 11.4x total");
  const corner = settleFunRoulette(normalizeFunRouletteSelection("corner:1-2-4-5"), 100, two);
  assert(corner.payout_points === 855, "a corner returns 8.55x total");
  const sixline = settleFunRoulette(normalizeFunRouletteSelection("sixline:1-2-3-4-5-6"), 100, two);
  assert(sixline.payout_points === 570, "a sixline returns 5.7x total");
  const basket = settleFunRoulette(normalizeFunRouletteSelection("basket:0-00-1-2-3"), 100, two);
  assert(basket.payout_points === 684, "a basket returns 6.84x total");
  const dozen = settleFunRoulette(normalizeFunRouletteSelection("dozen:1"), 100, two);
  assert(dozen.payout_points === 285, "a dozen returns 2.85x total");
  const column = settleFunRoulette(normalizeFunRouletteSelection("column:2"), 100, two);
  assert(column.payout_points === 285, "a column returns 2.85x total");
  const parity = settleFunRoulette(normalizeFunRouletteSelection("parity:even"), 100, two);
  assert(parity.payout_points === 190, "an 18-pocket outside bet returns 1.9x total");
  const sector = settleFunRoulette(normalizeFunRouletteSelection("sector:dzeroside"), 100, two);
  assertSettlementShape("fun-roulette sector win", sector, 100);
  assert(sector.payout_points === 180, "a 19-pocket sector returns 1.8x total");
  const neighbours = settleFunRoulette(normalizeFunRouletteSelection("sector:zeroneighbours"), 100, two);
  assert(neighbours.payout_points === 570, "a 6-pocket sector returns 5.7x total");

  const loss = settleFunRoulette(normalizeFunRouletteSelection("color:red"), 100, two);
  assertSettlementShape("fun-roulette loss", loss, 100);
  assert(loss.payout_points === 0, "black pocket 2 must not pay a red bet");

  requireExecutableResolver(FUN_ROULETTE_RESOLVER as ReviewResolverModule<unknown, unknown, unknown>);
});

Deno.test("Fun Target generates wheel digits and settles a hit and a miss", () => {
  assertGeneratesValidOutcomes("fun-target", generateFunTargetOutcome, validateFunTargetOutcome);

  const seven = validateFunTargetOutcome({ kind: "digit_wheel", digit: 7 });

  const win = settleFunTarget(normalizeFunTargetSelection("number:7"), 100, seven);
  assertSettlementShape("fun-target win", win, 100);
  assert(win.payout_points === 843, "a matching digit returns 8.43x total");
  assert(
    settleFunTarget(normalizeFunTargetSelection("number:7"), 5, seven).payout_points === 42,
    "8.43x on 5 points floors to 42",
  );

  const loss = settleFunTarget(normalizeFunTargetSelection("number:3"), 100, seven);
  assertSettlementShape("fun-target loss", loss, 100);
  assert(loss.payout_points === 0, "a missed digit credits nothing");

  requireExecutableResolver(FUN_TARGET_RESOLVER as ReviewResolverModule<unknown, unknown, unknown>);
});

Deno.test("every live table resolver produces integer-consistent settlements across generated rounds", () => {
  const entropy = seededEntropy(0xc0ffee);
  const stake = 25;
  for (let round = 0; round < ITERATIONS; round++) {
    const cases: readonly SettlementResult[] = [
      settleSevenUpDown(normalizeSevenUpDownSelection("up"), stake, generateSevenUpDownOutcome(entropy)),
      settleFunAb(normalizeFunAbSelection("andar"), stake, generateFunAbOutcome(entropy)),
      settleTripleFun(normalizeTripleFunSelection("single:4"), stake, generateTripleFunOutcome(entropy)),
      settleFunRoulette(normalizeFunRouletteSelection("color:red"), stake, generateFunRouletteOutcome(entropy)),
      settleFunTarget(normalizeFunTargetSelection("number:9"), stake, generateFunTargetOutcome(entropy)),
    ];
    for (const result of cases) {
      assertSettlementShape(`round ${round}`, result, stake);
    }
  }
});
