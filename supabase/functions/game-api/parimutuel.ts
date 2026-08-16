/**
 * Pari-mutuel settlement for shared clocked tables.
 *
 * The house does not bank a fixed multiplier. Every accepted stake for one
 * game/round forms that round's pool; 90% of the pool is distributed among the
 * players who backed the winning outcome, in proportion to their winning stake;
 * the house keeps the other 10% plus the integer rounding remainder.
 *
 * The model only makes sense where many players bet different selections into
 * one shared result, so it applies to the ten shared clocked tables. The five
 * single-player cabinets keep fixed-odds settlement: a lone player has no pool
 * to share, so pari-mutuel would return at most 90% of their own stake on a win
 * and could never let them come out ahead.
 *
 * WHO WINS is decided exactly as fixed-odds decides it — a selection wins iff
 * its resolver would have paid it — so this file never re-derives game rules.
 * It changes only HOW MUCH a winner is paid. The result itself is generated and
 * committed elsewhere, from the published probability table via the CSPRNG,
 * before any bet exists, and is never read back into this calculation as
 * anything but "did this selection win".
 *
 * Every value here is a non-negative safe integer and every operation is
 * integer arithmetic. There is no floating-point step anywhere in the payout
 * path: `Math.floor` is applied only to an integer product over an integer
 * divisor, which is exact.
 */

/** The distributable share of a round pool, in basis points. 9000 = 90.00%. */
export const PARIMUTUEL_DISTRIBUTION_BPS = 9000;
const BPS_DENOMINATOR = 10000;

export type ParimutuelWager = Readonly<{
  wager_id: string;
  /** Whichever player owns this wager; distinct players may share a selection. */
  player_id: string;
  stake_points: number;
  /** True iff this selection wins under the committed result. */
  winner: boolean;
}>;

export type ParimutuelPayout = Readonly<{
  wager_id: string;
  player_id: string;
  stake_points: number;
  payout_points: number;
}>;

export type ParimutuelPlan = Readonly<{
  round_pool: number;
  maximum_distribution: number;
  winning_stake_pool: number;
  distributed_points: number;
  /** maximum_distribution - distributed_points; goes to the game's reserve. */
  remainder_points: number;
  no_winner: boolean;
  payouts: readonly ParimutuelPayout[];
}>;

export class ParimutuelError extends Error {
  constructor(readonly code: "INVALID_WAGER" | "DUPLICATE_WAGER", message: string) {
    super(message);
    this.name = "ParimutuelError";
  }
}

function safeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Compute one round's pari-mutuel settlement.
 *
 * Guarantees, each asserted by the test suite:
 *   - sum(payouts) === distributed_points <= maximum_distribution
 *   - maximum_distribution === floor(round_pool * 9000 / 10000) <= floor(pool*0.9)
 *   - remainder_points === maximum_distribution - distributed_points >= 0
 *   - winning_stake_pool === 0  =>  every payout 0, no_winner true, house keeps pool
 *   - a losing wager is never paid
 *   - integer arithmetic throughout; product-then-floor is exact
 */
export function planParimutuelRound(
  wagers: readonly ParimutuelWager[],
): ParimutuelPlan {
  const seen = new Set<string>();
  let roundPool = 0;
  let winningStakePool = 0;

  for (const wager of wagers) {
    if (
      typeof wager.wager_id !== "string" || wager.wager_id.length === 0 ||
      typeof wager.player_id !== "string" || wager.player_id.length === 0 ||
      !safeInteger(wager.stake_points) || wager.stake_points <= 0 ||
      typeof wager.winner !== "boolean"
    ) {
      throw new ParimutuelError("INVALID_WAGER", "A pari-mutuel wager is malformed.");
    }
    if (seen.has(wager.wager_id)) {
      throw new ParimutuelError("DUPLICATE_WAGER", `Wager ${wager.wager_id} appears twice.`);
    }
    seen.add(wager.wager_id);
    roundPool += wager.stake_points;
    if (wager.winner) winningStakePool += wager.stake_points;
  }

  // Basis-point ceiling. floor(pool * 9000 / 10000) is by construction
  // <= floor(pool * 0.90), and equals it because 9000/10000 = 0.9 exactly.
  const maximumDistribution = Math.floor((roundPool * PARIMUTUEL_DISTRIBUTION_BPS) / BPS_DENOMINATOR);

  // No player backed the winning outcome: nobody is paid, the whole pool is the
  // house's under the published no-winner policy, and nothing is distributed.
  if (winningStakePool === 0) {
    return Object.freeze({
      round_pool: roundPool,
      maximum_distribution: maximumDistribution,
      winning_stake_pool: 0,
      distributed_points: 0,
      remainder_points: maximumDistribution,
      no_winner: true,
      payouts: Object.freeze([]),
    });
  }

  let distributed = 0;
  const payouts: ParimutuelPayout[] = [];
  for (const wager of wagers) {
    // Each winner's share is a proportion of the distributable amount by their
    // winning stake. Product before division keeps it exact; floor sends every
    // fractional point to the remainder rather than to a player, so the sum can
    // never exceed maximum_distribution.
    const payout = wager.winner
      ? Math.floor((maximumDistribution * wager.stake_points) / winningStakePool)
      : 0;
    if (payout > 0) distributed += payout;
    payouts.push(Object.freeze({
      wager_id: wager.wager_id,
      player_id: wager.player_id,
      stake_points: wager.stake_points,
      payout_points: payout,
    }));
  }

  return Object.freeze({
    round_pool: roundPool,
    maximum_distribution: maximumDistribution,
    winning_stake_pool: winningStakePool,
    distributed_points: distributed,
    remainder_points: maximumDistribution - distributed,
    no_winner: false,
    payouts: Object.freeze(payouts),
  });
}

/**
 * The estimated total return per point staked on a selection, for display only.
 *
 * This is what requirement 11 mandates showing instead of a fixed multiplier:
 * a live, changing estimate, not a guarantee. It is expressed in basis points
 * (10000 = 1.00x total return) so the caller renders it without floating point.
 * If nothing yet backs the selection, the estimate is the whole distributable
 * pool over one hypothetical point — a ceiling that falls as others join.
 */
export function estimatedReturnBps(
  roundPool: number,
  selectionStakePool: number,
): number {
  if (!safeInteger(roundPool) || !safeInteger(selectionStakePool)) return 0;
  const maximumDistribution = Math.floor((roundPool * PARIMUTUEL_DISTRIBUTION_BPS) / BPS_DENOMINATOR);
  const denominator = selectionStakePool > 0 ? selectionStakePool : 1;
  return Math.floor((maximumDistribution * BPS_DENOMINATOR) / denominator);
}
