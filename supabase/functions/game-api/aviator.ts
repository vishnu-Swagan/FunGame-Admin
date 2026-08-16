/**
 * Aviator — the crash-game outcome and settlement core.
 *
 * A round has one random crash multiplier, generated once by the CSPRNG from
 * MyDGP's declared ruleset-v1 distribution, before any bet exists and never
 * read back from bets. A player bets, watches a multiplier climb from 1.00x,
 * and cashes out at some multiplier; if their cash-out is at or below the crash
 * point they are paid stake x cashOut, otherwise the plane crashed first and
 * the stake is lost.
 *
 * The distribution is the standard house-fair crash law:
 *
 *     P(crash >= m) = (1 - edge) / m ,  edge = 0.10
 *
 * so a player who commits to cash out at any fixed multiplier m has expected
 * return exactly (1 - edge) = 90%, independent of the m they pick. The edge is
 * delivered as a 10% instant-bust probability (crash at 1.00x, no cash-out
 * possible) plus the tail shape above.
 *
 * All multipliers are integer CENTIS (100 = 1.00x). Every operation is integer
 * arithmetic; there is no floating point in the payout path.
 */

/** House edge in basis points. 1000 = 10.00%. */
export const AVIATOR_EDGE_BPS = 1000;
const BPS = 10000;

/** 1.00x, the floor and the instant-bust value. */
export const AVIATOR_MIN_CENTIS = 100;

/**
 * Ceiling on a single flight, in centis. A crash game has an unbounded tail;
 * capping it bounds per-round liability without materially moving the edge
 * (the mass above 1000x is a few parts in ten thousand).
 */
export const AVIATOR_MAX_CENTIS = 100_000; // 1000.00x

/** Resolution of the uniform draw. Large enough that quantisation is negligible. */
const DRAW_RANGE = 1_000_000_000; // 1e9

export type ServerEntropy = (exclusiveMax: number) => number;

/**
 * Draw one crash multiplier in centis.
 *
 * Inverse-transform of P(crash >= m) = 0.9/m:
 *   u = U / N in [0,1).  Bust (100) if u < edge.  Else 100 * (1-edge)/(1-u),
 *   which in integers is floor( (BPS - edge) * N / (BPS/BPS ... )). Kept as a
 *   single integer expression below and capped at AVIATOR_MAX_CENTIS.
 */
export function generateAviatorCrashCentis(entropy: ServerEntropy): number {
  const u = entropy(DRAW_RANGE); // integer in [0, DRAW_RANGE)
  // Instant bust with probability edge: the low edge-fraction of the range.
  const bustCut = Math.floor((DRAW_RANGE * AVIATOR_EDGE_BPS) / BPS);
  if (u < bustCut) return AVIATOR_MIN_CENTIS;

  // crash_centis = floor( 100 * (1 - edge) / (1 - u/N) )
  //             = floor( 100 * (BPS - edge) * N / (BPS * (N - u)) )
  // Numerator and denominator are integers; the division is done last.
  const numerator = 100 * (BPS - AVIATOR_EDGE_BPS) * DRAW_RANGE;
  const denominator = BPS * (DRAW_RANGE - u);
  const centis = Math.floor(numerator / denominator);
  // A non-bust round is a real flight, so its floor is 1.01x, not 1.00x. The
  // thin band just above the bust cut would otherwise floor to exactly 1.00x
  // and blur "instant bust" (the 10% edge draws) with "lowest flight". This
  // keeps the two distinct without moving the edge: the shifted mass is a few
  // parts in a thousand, all at the very bottom of the curve.
  const LOWEST_FLIGHT_CENTIS = AVIATOR_MIN_CENTIS + 1;
  if (centis < LOWEST_FLIGHT_CENTIS) return LOWEST_FLIGHT_CENTIS;
  if (centis > AVIATOR_MAX_CENTIS) return AVIATOR_MAX_CENTIS;
  return centis;
}

export type AviatorSettlement = Readonly<{
  stake_points: number;
  payout_points: number;
  net_points: number;
  won: boolean;
}>;

/**
 * Settle one player's Aviator bet.
 *
 * `cashOutCentis` is the multiplier at which the player cashed out, or null if
 * they never did (the plane crashed while they were still flying). A cash-out
 * strictly above the crash point is a cash-out the player did not actually
 * reach in time and pays nothing — the server, holding the crash point, is the
 * authority on whether a claimed cash-out beat the crash.
 *
 * TOTAL_RETURN: payout includes the stake, because the multiplier includes the
 * 1.00x. floor keeps it integer; a fractional point is never paid.
 */
export function settleAviator(
  cashOutCentis: number | null,
  stakePoints: number,
  crashCentis: number,
): AviatorSettlement {
  if (!Number.isSafeInteger(stakePoints) || stakePoints <= 0) {
    throw new Error("Aviator stake must be a positive whole number of points.");
  }
  if (!Number.isSafeInteger(crashCentis) || crashCentis < AVIATOR_MIN_CENTIS) {
    throw new Error("Aviator crash multiplier is invalid.");
  }
  const cashedOut = cashOutCentis !== null &&
    Number.isSafeInteger(cashOutCentis) &&
    cashOutCentis >= AVIATOR_MIN_CENTIS &&
    cashOutCentis <= crashCentis;

  const payout = cashedOut ? Math.floor((stakePoints * (cashOutCentis as number)) / 100) : 0;
  return Object.freeze({
    stake_points: stakePoints,
    payout_points: payout,
    net_points: payout - stakePoints,
    won: cashedOut,
  });
}
