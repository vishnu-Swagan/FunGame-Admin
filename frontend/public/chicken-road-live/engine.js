/*
 * Chicken Road - hop math (single source of truth for the cabinet).
 *
 * Discrete lanes, not an Aviator climb curve. The Canvas client and the
 * (optional) jest invariants both load this file.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.ChickenRoadEngine = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var SIDEWALK = 0;

  function formatMult(mult) {
    var m = Number(mult);
    if (!isFinite(m) || m <= 0) m = 1;
    return m.toFixed(2) + "x";
  }

  function cashoutAmount(bet, mult) {
    return Math.round((Number(bet) || 0) * (Number(mult) || 0));
  }

  function hopEase(t) {
    var x = Math.max(0, Math.min(1, Number(t) || 0));
    return x * x * (3 - 2 * x);
  }

  function hopArc(t) {
    var x = Math.max(0, Math.min(1, Number(t) || 0));
    return Math.sin(x * Math.PI);
  }

  function laneWorldX(lane, sidewalkW, laneW) {
    var l = Number(lane) || 0;
    if (l <= SIDEWALK) return sidewalkW * 0.55;
    return sidewalkW + (l - 0.5) * laneW;
  }

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function difficultySpec(name, table) {
    var key = String(name || "easy").toLowerCase();
    if (table && table[key]) return table[key];
    return { label: "Easy", traffic: 0.55, speed: 1, multipliers: [] };
  }

  /* Frame ~3 hop-lanes in the portrait view. On the sidewalk, pin cam to 0
   * so grass + curb stay in shot. On the road, sit the chicken in the left
   * third so the next manhole reads as the centre lane. */
  function frameCameraX(chickenX, viewW, onRoad) {
    var x = Number(chickenX) || 0;
    var w = Number(viewW) || 0;
    if (!onRoad) return 0;
    return x - w * 0.17;
  }

  function manholeRadius(laneW) {
    var w = Number(laneW) || 96;
    return Math.max(26, Math.min(42, w * 0.30));
  }

  return {
    SIDEWALK: SIDEWALK,
    formatMult: formatMult,
    cashoutAmount: cashoutAmount,
    hopEase: hopEase,
    hopArc: hopArc,
    laneWorldX: laneWorldX,
    clamp: clamp,
    difficultySpec: difficultySpec,
    frameCameraX: frameCameraX,
    manholeRadius: manholeRadius,
  };
});
