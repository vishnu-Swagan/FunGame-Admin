/*
 * Chicken Road - shared renderer math (single source of truth).
 *
 * This is the ONE progress function for the whole cabinet: the multiplier, the
 * chicken's position, its hop pitch/squash, and the gold trail are all derived
 * from these functions so they can never drift out of step. It is written as a
 * UMD module so the Canvas cabinet loads it as a browser global AND the jest
 * renderer-invariant tests can require it directly.
 *
 * multiplierAt() replicates the backend flight/climb curve byte-for-byte
 * (game_engines.aviator_multiplier, shared verbatim by Chicken Road), so the
 * number the client animates equals the number the server would settle.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.ChickenRoadEngine = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Matches game_engines.aviator_multiplier / chicken_road_multiplier exactly.
  function multiplierAt(elapsedSeconds) {
    var s = Math.max(0, Number(elapsedSeconds) || 0);
    var g = 0.06 * s;
    var h = 0.04 * s;
    var value = 1 + g + g * g - h * h * h + h * h * h * h;
    return Math.max(1, Math.floor(value * 100) / 100);
  }

  // Chicken road progress is a strictly increasing function of the multiplier,
  // so a given multiplier ALWAYS maps to the same position on the highway.
  // 0 at 1.00x, asymptotic to 1 as the multiplier grows.
  function progressForMultiplier(mult) {
    var m = Math.max(1, Number(mult) || 1);
    return 1 - 1 / m;
  }

  // Discrete lane the chicken has reached (for hop cadence / lane markers).
  function laneForMultiplier(mult, laneCount) {
    var lanes = laneCount || 6;
    return Math.min(lanes - 1, Math.floor(progressForMultiplier(mult) * lanes));
  }

  // Horizontal screen position (0..1) of the chicken, locked to the multiplier
  // so the sprite and the number can never disagree. Kept inside [0.12, 0.78]
  // so the chicken stays on screen as the multiplier grows unbounded.
  function chickenXFraction(mult) {
    return 0.12 + progressForMultiplier(mult) * 0.66;
  }

  // Vertical hop offset (0..1) for a continuous run cycle at the given time.
  // Only affects presentation; the horizontal position stays locked to mult.
  function hopPhase(timeSeconds, hopsPerSecond) {
    var rate = hopsPerSecond || 3.2;
    var frac = (Number(timeSeconds) || 0) * rate;
    return Math.abs(Math.sin(frac * Math.PI));
  }

  // Squash factor (1 = round, <1 = squashed on landing) locked to the hop.
  function squashForHop(hop) {
    return 1 - 0.35 * (1 - Math.max(0, Math.min(1, hop)));
  }

  function formatMult(mult) {
    var m = Math.max(1, Number(mult) || 1);
    return m.toFixed(2) + "x";
  }

  // A settled round is history: green for a modest crash, gold for a big one,
  // and always the HIT (crash) colour language, never a "flew" state.
  function historyTone(crashPoint) {
    var c = Number(crashPoint) || 1;
    if (c < 2) return "low";
    if (c < 10) return "mid";
    return "high";
  }

  return {
    multiplierAt: multiplierAt,
    progressForMultiplier: progressForMultiplier,
    laneForMultiplier: laneForMultiplier,
    chickenXFraction: chickenXFraction,
    hopPhase: hopPhase,
    squashForHop: squashForHop,
    formatMult: formatMult,
    historyTone: historyTone,
  };
});