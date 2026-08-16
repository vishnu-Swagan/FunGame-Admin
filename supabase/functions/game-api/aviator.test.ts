import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  AVIATOR_MAX_CENTIS,
  AVIATOR_MIN_CENTIS,
  generateAviatorCrashCentis,
  settleAviator,
} from "./aviator.ts";

// A seeded splitmix64-based entropy for reproducible statistical tests. Uniform
// enough across a 1e9 range that quantisation, not the generator, dominates —
// unlike a bare LCG whose low bits are visibly patterned. Production uses
// WebCrypto with rejection sampling; this only has to be flat, not secure.
function counterEntropy(seed: number): (max: number) => number {
  let state = BigInt(seed) * 0x9e3779b97f4a7c15n + 0x1234567890abcdefn;
  const MASK = (1n << 64n) - 1n;
  return (max: number) => {
    state = (state + 0x9e3779b97f4a7c15n) & MASK;
    let z = state;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK;
    z = z ^ (z >> 31n);
    return Number(z % BigInt(max));
  };
}

// True uniform source for the RTP/rate proofs, so a statistical failure can only
// mean the distribution math is wrong, never a weak test PRNG.
function cryptoEntropy(): (max: number) => number {
  return (max: number) => {
    const range = 0x1_0000_0000;
    const limit = range - (range % max);
    const b = new Uint32Array(1);
    do { crypto.getRandomValues(b); } while (b[0] >= limit);
    return b[0] % max;
  };
}

Deno.test("every crash multiplier is a whole centis value within bounds", () => {
  const e = counterEntropy(1);
  for (let i = 0; i < 100000; i++) {
    const c = generateAviatorCrashCentis(e);
    assert(Number.isSafeInteger(c), "crash must be an integer");
    assert(c >= AVIATOR_MIN_CENTIS && c <= AVIATOR_MAX_CENTIS, `out of bounds: ${c}`);
  }
});

Deno.test("instant-bust rate is about the 10% house edge", () => {
  const e = cryptoEntropy();
  const n = 500000;
  let bust = 0;
  for (let i = 0; i < n; i++) {
    if (generateAviatorCrashCentis(e) === AVIATOR_MIN_CENTIS) bust++;
  }
  const rate = bust / n;
  // Instant bust is the 10% edge floor; the tail can only add tiny extra mass
  // exactly at 1.00x, so ~0.099..0.101 is expected.
  assert(rate > 0.095 && rate < 0.106, `instant-bust rate ${rate.toFixed(4)} off 0.10`);
});

Deno.test("fixed cash-out targets all return ~90%, independent of the target", () => {
  const n = 1000000;
  for (const target of [150, 200, 500, 1000, 5000]) { // 1.5x, 2x, 5x, 10x, 50x
    const e = cryptoEntropy();
    let staked = 0, returned = 0;
    for (let i = 0; i < n; i++) {
      const crash = generateAviatorCrashCentis(e);
      const s = settleAviator(target, 10000, crash); // large stake, small floor bias
      staked += s.stake_points;
      returned += s.payout_points;
    }
    const rtp = returned / staked;
    // Uniform house edge is the whole point: every target lands near 0.90.
    assert(rtp > 0.87 && rtp < 0.93, `cash-out ${target}: RTP ${rtp.toFixed(4)} off 0.90`);
  }
});

Deno.test("a cash-out above the crash pays nothing", () => {
  // Crash at 2.00x; a claimed cash-out at 3.00x did not beat the crash.
  const s = settleAviator(300, 100, 200);
  assertEquals(s.payout_points, 0);
  assertEquals(s.won, false);
});

Deno.test("no cash-out loses the stake", () => {
  const s = settleAviator(null, 100, 500);
  assertEquals(s.payout_points, 0);
  assertEquals(s.net_points, -100);
  assertEquals(s.won, false);
});

Deno.test("a valid cash-out pays stake x multiplier, integer, total-return", () => {
  // Cash out at 2.50x on a crash at 4.00x, stake 40 -> floor(40 * 250 / 100) = 100.
  const s = settleAviator(250, 40, 400);
  assertEquals(s.payout_points, 100);
  assertEquals(s.net_points, 60);
  assertEquals(s.won, true);
  // net === payout - stake always.
  assertEquals(s.net_points, s.payout_points - s.stake_points);
});

Deno.test("exact-at-crash cash-out is a win, one centi above is a loss", () => {
  assertEquals(settleAviator(200, 100, 200).won, true); // cashed out exactly at crash
  assertEquals(settleAviator(201, 100, 200).won, false); // a centi too greedy
});

Deno.test("generation is a pure function of the entropy stream", () => {
  const first = counterEntropy(99);
  const second = counterEntropy(99);
  for (let i = 0; i < 1000; i++) {
    assertEquals(generateAviatorCrashCentis(first), generateAviatorCrashCentis(second));
  }
});
