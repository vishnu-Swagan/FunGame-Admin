import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  estimatedReturnBps,
  ParimutuelError,
  type ParimutuelWager,
  planParimutuelRound,
} from "./parimutuel.ts";

function wager(id: string, player: string, stake: number, winner: boolean): ParimutuelWager {
  return { wager_id: id, player_id: player, stake_points: stake, winner };
}

// A counter-based generator so a seeded, bet-independent stream of winners can
// be produced without Math.random — proving the payout math is deterministic.
function counterWinners(seed: number, n: number, winRate: number): boolean[] {
  const out: boolean[] = [];
  let x = seed >>> 0;
  for (let i = 0; i < n; i++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    out.push((x % 1000) < winRate * 1000);
  }
  return out;
}

Deno.test("distribution never exceeds the 90% ceiling, over many random books", () => {
  for (let trial = 0; trial < 2000; trial++) {
    const winFlags = counterWinners(trial + 1, 12, 0.4);
    const wagers = winFlags.map((w, i) => wager(`w${i}`, `p${i % 5}`, 1 + ((trial * 7 + i) % 997), w));
    const plan = planParimutuelRound(wagers);

    // Invariant 2: maximum_distribution === floor(pool * 9000/10000) <= floor(pool*0.9).
    assertEquals(plan.maximum_distribution, Math.floor((plan.round_pool * 9000) / 10000));
    assert(plan.maximum_distribution <= Math.floor(plan.round_pool * 0.9) + 0); // 9000/10000 == 0.9 exactly

    // Invariant 1: sum(payouts) === distributed <= maximum_distribution.
    const summed = plan.payouts.reduce((t, p) => t + p.payout_points, 0);
    assertEquals(summed, plan.distributed_points);
    assert(summed <= plan.maximum_distribution, `sum ${summed} > cap ${plan.maximum_distribution}`);

    // Invariant 10: the remainder is exactly what was not distributed, and never negative.
    assertEquals(plan.remainder_points, plan.maximum_distribution - plan.distributed_points);
    assert(plan.remainder_points >= 0);

    // A losing wager is never paid.
    for (const p of plan.payouts) {
      const src = wagers.find((w) => w.wager_id === p.wager_id)!;
      if (!src.winner) assertEquals(p.payout_points, 0);
    }
  }
});

Deno.test("winning_stake_pool zero pays nothing and keeps the whole pool", () => {
  const plan = planParimutuelRound([
    wager("a", "p1", 100, false),
    wager("b", "p2", 250, false),
  ]);
  assertEquals(plan.no_winner, true);
  assertEquals(plan.winning_stake_pool, 0);
  assertEquals(plan.distributed_points, 0);
  assertEquals(plan.payouts.every((p) => p.payout_points === 0), true);
  // The house keeps everything distributable as remainder (requirement 8/10).
  assertEquals(plan.remainder_points, plan.maximum_distribution);
});

Deno.test("proportional shares are exact and integer for a mixed book", () => {
  // Pool 1000, 90% distributable = 900. Winners staked 300 total (100 + 200).
  const plan = planParimutuelRound([
    wager("w1", "p1", 100, true),
    wager("w2", "p2", 200, true),
    wager("w3", "p3", 700, false),
  ]);
  assertEquals(plan.round_pool, 1000);
  assertEquals(plan.maximum_distribution, 900);
  assertEquals(plan.winning_stake_pool, 300);
  // floor(900 * 100 / 300) = 300 ; floor(900 * 200 / 300) = 600 ; total 900, no remainder.
  assertEquals(plan.payouts.find((p) => p.wager_id === "w1")!.payout_points, 300);
  assertEquals(plan.payouts.find((p) => p.wager_id === "w2")!.payout_points, 600);
  assertEquals(plan.distributed_points, 900);
  assertEquals(plan.remainder_points, 0);
});

Deno.test("rounding remainder is retained, never over-paid", () => {
  // Pool 1000 -> 900 distributable. Three equal winners of 100 each (300 total).
  // floor(900 * 100 / 300) = 300 each -> 900, remainder 0. Make it uneven:
  // winners 1,1,1 of stake -> floor(900*1/3)=300 each... use a pool that leaves a remainder.
  const plan = planParimutuelRound([
    wager("w1", "p1", 1, true),
    wager("w2", "p2", 1, true),
    wager("w3", "p3", 1, true),
    wager("w4", "p4", 7, false),
  ]);
  // Pool 10 -> floor(10*9000/10000)=9. Winners stake 3. floor(9*1/3)=3 each -> 9, remainder 0.
  // Now an odd split:
  const plan2 = planParimutuelRound([
    wager("a", "p1", 2, true),
    wager("b", "p2", 1, true),
    wager("c", "p3", 7, false),
  ]);
  // Pool 10 -> 9 distributable, winners stake 3. floor(9*2/3)=6, floor(9*1/3)=3 -> 9, remainder 0.
  // Force a genuine remainder: pool 10, single winner stake 1 of a 1+9 book with the 9 losing.
  const plan3 = planParimutuelRound([
    wager("x", "p1", 1, true),
    wager("y", "p2", 9, false),
  ]);
  // Pool 10 -> 9 distributable, winning pool 1, floor(9*1/1)=9 -> distributed 9, remainder 0.
  // A real remainder needs floor to drop points: winners 2 of unequal stake into an indivisible cap.
  const plan4 = planParimutuelRound([
    wager("m", "p1", 1, true),
    wager("n", "p2", 1, true),
    wager("o", "p3", 1, false),
  ]);
  // Pool 3 -> floor(3*9000/10000)=2 distributable. Winners stake 2. floor(2*1/2)=1 each -> 2, remainder 0.
  // The cleanest remainder case: cap not divisible by winner count.
  const plan5 = planParimutuelRound([
    wager("s", "p1", 1, true),
    wager("t", "p2", 1, true),
    wager("u", "p3", 1, true),
    wager("v", "p4", 7, false),
  ]);
  // Pool 10 -> 9 distributable, winners stake 3, floor(9*1/3)=3 each -> 9, remainder 0.
  for (const pl of [plan, plan2, plan3, plan4, plan5]) {
    const summed = pl.payouts.reduce((t, p) => t + p.payout_points, 0);
    assertEquals(summed, pl.distributed_points);
    assert(summed <= pl.maximum_distribution);
    assertEquals(pl.remainder_points, pl.maximum_distribution - summed);
    assert(pl.remainder_points >= 0);
  }

  // A guaranteed non-zero remainder: cap 9, three winners of equal stake where
  // 9 divides evenly is 0; use a cap that does not divide. Pool 11 -> cap 9,
  // three equal winners -> floor(9*1/3)=3 -> 9, remainder 0. Pool 13 -> cap 11,
  // three equal winners -> floor(11*1/3)=3 each -> 9, remainder 2.
  const remainderPlan = planParimutuelRound([
    wager("r1", "p1", 1, true),
    wager("r2", "p2", 1, true),
    wager("r3", "p3", 1, true),
    wager("r4", "p4", 10, false),
  ]);
  // Pool 13 -> floor(13*9000/10000)=11. Winners stake 3. floor(11*1/3)=3 each = 9. Remainder 2.
  assertEquals(remainderPlan.maximum_distribution, 11);
  assertEquals(remainderPlan.distributed_points, 9);
  assertEquals(remainderPlan.remainder_points, 2);
});

Deno.test("payout math is independent of player identity ordering", () => {
  // The same book in two different player orderings settles identically per wager.
  const a = planParimutuelRound([
    wager("w1", "alice", 100, true),
    wager("w2", "bob", 200, true),
    wager("w3", "carol", 700, false),
  ]);
  const b = planParimutuelRound([
    wager("w3", "zzz", 700, false),
    wager("w2", "aaa", 200, true),
    wager("w1", "mmm", 100, true),
  ]);
  const byId = (plan: typeof a, id: string) => plan.payouts.find((p) => p.wager_id === id)!.payout_points;
  assertEquals(byId(a, "w1"), byId(b, "w1"));
  assertEquals(byId(a, "w2"), byId(b, "w2"));
  assertEquals(a.distributed_points, b.distributed_points);
});

Deno.test("malformed and duplicate wagers are rejected", () => {
  let threw = false;
  try { planParimutuelRound([wager("w", "p", 0, true)]); } catch (e) { threw = e instanceof ParimutuelError; }
  assert(threw, "zero stake must be rejected");

  threw = false;
  try {
    planParimutuelRound([wager("dup", "p1", 5, true), wager("dup", "p2", 5, false)]);
  } catch (e) { threw = e instanceof ParimutuelError && e.code === "DUPLICATE_WAGER"; }
  assert(threw, "duplicate wager id must be rejected");
});

Deno.test("estimated return is display-only and falls as a selection fills", () => {
  // Pool 1000 -> 900 distributable. First point on a selection sees the ceiling.
  assertEquals(estimatedReturnBps(1000, 0), Math.floor((900 * 10000) / 1));
  // As the selection's own stake grows, the estimate drops.
  const light = estimatedReturnBps(1000, 100); // floor(900*10000/100) = 90000 => 9.0x
  const heavy = estimatedReturnBps(1000, 900); // floor(900*10000/900) = 10000 => 1.0x
  assert(light > heavy, "a more-backed selection must show a lower estimate");
  assertEquals(heavy, 10000);
});

Deno.test("empty round settles to nothing", () => {
  const plan = planParimutuelRound([]);
  assertEquals(plan.round_pool, 0);
  assertEquals(plan.maximum_distribution, 0);
  assertEquals(plan.no_winner, true);
  assertEquals(plan.payouts.length, 0);
  assertEquals(plan.remainder_points, 0);
});
