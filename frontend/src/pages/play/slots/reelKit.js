import { motion } from "framer-motion";

/** Deterministic PRNG (mulberry32) - decorative reel symbols stay identical for every player. */
export function seededRand(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const pickSeeded = (arr, seed) => arr[Math.floor(seededRand(seed)() * arr.length)];

/** Staggered reel stop times (seconds into the reveal window) - reel 1 first, like a real cabinet. */
export const reelStopTimes = (revealSecs, n = 3) => {
  const start = revealSecs * 0.42;
  const gap = revealSecs * 0.2;
  return Array.from({ length: n }, (_, i) => start + i * gap);
};

/** Endless scrolling strip shown while a reel is spinning (symbols doubled for a seamless loop). */
export const SpinStrip = ({ ids, render, cellH, rows = 1 }) => (
  <div className="overflow-hidden" style={{ height: cellH * rows }} aria-hidden="true">
    <div className="fg-reel-spin-strip">
      {[...ids, ...ids].map((id, i) => (
        <div key={i} style={{ height: cellH }} className="flex items-center justify-center">
          {render(id)}
        </div>
      ))}
    </div>
  </div>
);

/** A settled symbol dropping in with a mechanical bounce. */
export const SettledCell = ({ children, cellH, k }) => (
  <motion.div
    key={k}
    initial={{ y: -cellH * 0.55, opacity: 0.3 }}
    animate={{ y: 0, opacity: 1 }}
    transition={{ type: "spring", stiffness: 430, damping: 24 }}
    style={{ height: cellH }}
    className="flex items-center justify-center"
  >
    {children}
  </motion.div>
);
