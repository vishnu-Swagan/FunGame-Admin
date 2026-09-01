export const ANDAR_BAHAR_STAGE = Object.freeze({
  x: 264,
  y: 166,
  width: 1072,
  height: 410,
  centerX: 800,
});

export const ANDAR_BAHAR_TABLE_CARD = Object.freeze({
  width: 68,
  height: 96,
  step: 58,
  maxPerLane: 8,
  y: Object.freeze({ andar: 236, bahar: 414 }),
});

export const ANDAR_BAHAR_JOKER_SLOT = Object.freeze({
  x: 1160,
  y: 316,
  width: 78,
  height: 110,
});

export const ANDAR_BAHAR_CARD_RELEASE = Object.freeze({ x: 1268, y: 506 });

export const ANDAR_BAHAR_MOTION = Object.freeze({
  cardFlightMaxSeconds: 0.28,
  jokerFlightSeconds: 0.28,
  settleHaloSeconds: 0.18,
  reducedFadeSeconds: 0.16,
});

const clamp01 = (value) => Math.min(1, Math.max(0, Number(value) || 0));
const easeInOutQuart = (value) => {
  const progress = clamp01(value);
  return progress < 0.5
    ? 8 * progress ** 4
    : 1 - ((-2 * progress + 2) ** 4) / 2;
};

export function cardFlightDuration(duration) {
  return Math.min(
    ANDAR_BAHAR_MOTION.cardFlightMaxSeconds,
    Math.max(0.001, Number(duration) || 0.001)
  );
}

export function formatProfitOdds(totalReturn) {
  return `${Math.max(0, Number(totalReturn || 1) - 1).toFixed(1)}:1`;
}

export function cardMotionProgress(elapsed, releaseAt, flightDuration, reducedMotion = false) {
  if (Number(elapsed) < Number(releaseAt || 0)) return 0;
  if (reducedMotion) return 1;
  return clamp01(
    (Number(elapsed) - Number(releaseAt || 0)) / Math.max(0.001, Number(flightDuration) || 0.001)
  );
}

export function layoutLaneCards(rows, arrivalProgress = 1) {
  const allRows = rows || [];
  const shown = allRows.slice(-ANDAR_BAHAR_TABLE_CARD.maxPerLane);
  const count = shown.length;
  if (!count) return [];

  const finalWidth = ANDAR_BAHAR_TABLE_CARD.width + (count - 1) * ANDAR_BAHAR_TABLE_CARD.step;
  const finalStart = ANDAR_BAHAR_STAGE.centerX - finalWidth / 2;
  const saturated = allRows.length > ANDAR_BAHAR_TABLE_CARD.maxPerLane;
  const previousCount = saturated
    ? count
    : Math.max(0, count - 1);
  const previousWidth = previousCount
    ? ANDAR_BAHAR_TABLE_CARD.width + (previousCount - 1) * ANDAR_BAHAR_TABLE_CARD.step
    : 0;
  const previousStart = ANDAR_BAHAR_STAGE.centerX - previousWidth / 2;
  const shift = count === 1 ? 1 : easeInOutQuart(arrivalProgress);
  const start = previousStart + (finalStart - previousStart) * shift;

  return shown.map((entry, laneIndex) => {
    const incoming = laneIndex === count - 1;
    const saturatedOffset = saturated && !incoming ? (1 - shift) * ANDAR_BAHAR_TABLE_CARD.step : 0;
    return {
      ...entry,
      laneIndex,
      targetX: start + laneIndex * ANDAR_BAHAR_TABLE_CARD.step + saturatedOffset,
    };
  });
}

export function cardFlightFrame({
  elapsed,
  releaseAt,
  flightDuration,
  targetX,
  targetY,
  arc = 0,
  reducedMotion = false,
}) {
  const visible = Number(elapsed) >= Number(releaseAt || 0);
  if (!visible) {
    return {
      visible: false,
      progress: 0,
      eased: 0,
      opacity: 0,
      x: ANDAR_BAHAR_CARD_RELEASE.x,
      y: ANDAR_BAHAR_CARD_RELEASE.y,
      trail: false,
    };
  }

  if (reducedMotion) {
    return {
      visible: true,
      progress: 1,
      eased: 1,
      opacity: clamp01(
        (Number(elapsed) - Number(releaseAt || 0)) / ANDAR_BAHAR_MOTION.reducedFadeSeconds
      ),
      x: targetX,
      y: targetY,
      trail: false,
    };
  }

  const progress = cardMotionProgress(elapsed, releaseAt, flightDuration, reducedMotion);
  const eased = 1 - Math.pow(1 - progress, 4);
  return {
    visible: true,
    progress,
    eased,
    opacity: eased,
    x: ANDAR_BAHAR_CARD_RELEASE.x + (targetX - ANDAR_BAHAR_CARD_RELEASE.x) * eased,
    y: ANDAR_BAHAR_CARD_RELEASE.y + (targetY - ANDAR_BAHAR_CARD_RELEASE.y) * eased
      - Math.sin(progress * Math.PI) * Number(arc || 0),
    trail: !reducedMotion && progress < 1,
  };
}
