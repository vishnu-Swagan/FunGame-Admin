import {
  ANDAR_BAHAR_CARD_RELEASE,
  ANDAR_BAHAR_JOKER_SLOT,
  ANDAR_BAHAR_MOTION,
  ANDAR_BAHAR_STAGE,
  ANDAR_BAHAR_TABLE_CARD,
  cardFlightDuration,
  cardFlightFrame,
  formatProfitOdds,
  layoutLaneCards,
} from "./andarBaharPresentation";

const rows = (count, offset = 0) => Array.from({ length: count }, (_, index) => ({
  card: `${index + 2}S`,
  index: offset + index,
}));

test("the royal reveal stage uses large cards centered on the table", () => {
  expect(ANDAR_BAHAR_STAGE.centerX).toBe(800);
  expect(ANDAR_BAHAR_TABLE_CARD).toMatchObject({ width: 68, height: 96, step: 58, maxPerLane: 8 });
  expect(ANDAR_BAHAR_JOKER_SLOT).toMatchObject({ width: 78, height: 110 });

  [1, 2, 8].forEach((count) => {
    const layout = layoutLaneCards(rows(count), 1);
    const left = layout[0].targetX;
    const right = layout[layout.length - 1].targetX + ANDAR_BAHAR_TABLE_CARD.width;
    expect((left + right) / 2).toBeCloseTo(ANDAR_BAHAR_STAGE.centerX, 8);
    expect(left).toBeGreaterThan(ANDAR_BAHAR_STAGE.x);
    expect(right).toBeLessThan(ANDAR_BAHAR_STAGE.x + ANDAR_BAHAR_STAGE.width);
  });

  expect(ANDAR_BAHAR_TABLE_CARD.y.bahar + ANDAR_BAHAR_TABLE_CARD.height).toBeLessThan(532);
});

test("a new card recenters a lane smoothly without changing global timeline indices", () => {
  const before = layoutLaneCards(rows(4), 0);
  const after = layoutLaneCards(rows(4), 1);
  expect(after[0].targetX).toBeLessThan(before[0].targetX);
  expect(after.map((entry) => entry.index)).toEqual([0, 1, 2, 3]);

  const beforeSaturation = layoutLaneCards(rows(8, 20), 1);
  const saturatedStart = layoutLaneCards(rows(9, 20), 0);
  beforeSaturation.slice(1).forEach((previousEntry) => {
    expect(saturatedStart.find((entry) => entry.index === previousEntry.index)?.targetX)
      .toBe(previousEntry.targetX);
  });

  const saturated = layoutLaneCards(rows(10, 20), 0.25);
  expect(saturated).toHaveLength(8);
  expect(saturated.map((entry) => entry.index)).toEqual([22, 23, 24, 25, 26, 27, 28, 29]);
  expect(saturated[0].targetX).toBeGreaterThan(layoutLaneCards(rows(10, 20), 1)[0].targetX);
});

test("reduced motion preserves reveal timing but places released cards immediately", () => {
  const base = {
    releaseAt: 2,
    flightDuration: 0.4,
    targetX: 760,
    targetY: ANDAR_BAHAR_TABLE_CARD.y.andar,
    arc: 28,
    reducedMotion: true,
  };
  const hidden = cardFlightFrame({ ...base, elapsed: 1.999 });
  expect(hidden).toMatchObject({ visible: false, progress: 0, trail: false });
  expect(hidden.x).toBe(ANDAR_BAHAR_CARD_RELEASE.x);

  const placed = cardFlightFrame({ ...base, elapsed: 2 });
  expect(placed).toMatchObject({ visible: true, progress: 1, eased: 1, opacity: 0, trail: false, x: 760 });
  expect(placed.y).toBe(ANDAR_BAHAR_TABLE_CARD.y.andar);

  const fadedIn = cardFlightFrame({
    ...base,
    elapsed: 2 + ANDAR_BAHAR_MOTION.reducedFadeSeconds,
  });
  expect(fadedIn).toMatchObject({ x: 760, y: ANDAR_BAHAR_TABLE_CARD.y.andar, opacity: 1 });
});

test("standard card flight is arced, eased, and still interruptible frame by frame", () => {
  const frame = cardFlightFrame({
    elapsed: 2.2,
    releaseAt: 2,
    flightDuration: 0.4,
    targetX: 760,
    targetY: ANDAR_BAHAR_TABLE_CARD.y.bahar,
    arc: 28,
  });
  expect(frame.visible).toBe(true);
  expect(frame.progress).toBeCloseTo(0.5, 8);
  expect(frame.eased).toBeCloseTo(0.9375, 8);
  expect(frame.opacity).toBe(frame.eased);
  expect(frame.x).toBeGreaterThan(760);
  expect(frame.x).toBeLessThan(ANDAR_BAHAR_CARD_RELEASE.x);
  expect(frame.y).toBeLessThan(ANDAR_BAHAR_TABLE_CARD.y.bahar);
  expect(frame.trail).toBe(true);
});

test("presentation flight duration is capped without changing release order", () => {
  expect(cardFlightDuration(0.36)).toBe(ANDAR_BAHAR_MOTION.cardFlightMaxSeconds);
  expect(cardFlightDuration(0.12)).toBe(0.12);
});

test("card-count prices display profit odds while settlement retains the stake", () => {
  expect(formatProfitOdds(4.5)).toBe("3.5:1");
  expect(formatProfitOdds(15)).toBe("14.0:1");
});
