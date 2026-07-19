import { motion, AnimatePresence } from "framer-motion";
import { formatChips } from "@/components/common";

const CONFETTI_COLORS = ["#ffd447", "#34d399", "#22d3ee", "#e879f9", "#f87171", "#a78bfa"];

/** Celebratory burst on wins - confetti flecks, plus gold coins on big wins.
    Deterministic per index (same look for a given result), animates only
    transform/opacity, and respects prefers-reduced-motion. */
const ConfettiBurst = ({ big }) => {
  const reduced =
    typeof window !== "undefined" && window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduced) return null;
  const n = big ? 32 : 18;
  const pieces = Array.from({ length: n }, (_, i) => {
    const angle = (i / n) * Math.PI * 2 + (i % 3) * 0.35;
    const dist = 70 + ((i * 37) % 90) + (big ? 30 : 0);
    return {
      dx: Math.cos(angle) * dist,
      dy: Math.sin(angle) * dist * 0.55 + 80 + ((i * 53) % 60),
      rot: (((i * 97) % 360) + 180) * (i % 2 ? 1 : -1),
      color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
      coin: big && i % 3 === 0,
      dur: 1.0 + ((i * 29) % 50) / 100,
    };
  });
  return (
    <div className="pointer-events-none absolute inset-0" aria-hidden="true" data-testid="win-confetti">
      {pieces.map((p, i) => (
        <motion.span
          key={i}
          initial={{ x: 0, y: 0, opacity: 1, rotate: 0 }}
          animate={{ x: p.dx, y: p.dy, opacity: 0, rotate: p.rot }}
          transition={{ duration: p.dur, ease: "easeOut" }}
          className="absolute left-1/2 top-1/3"
          style={
            p.coin
              ? { width: 11, height: 11, borderRadius: "50%", background: "radial-gradient(circle at 35% 30%, #ffe08a, #b45309)", boxShadow: "0 0 6px rgba(255,212,71,0.8)" }
              : { width: 7, height: 11, borderRadius: 2, background: p.color }
          }
        />
      ))}
    </div>
  );
};

export const ResultBanner = ({ result }) => {
  // result: null | { win: bool, big?: bool, push?: bool, title, subtitle?, payout }
  return (
    <AnimatePresence>
      {result && (
        <motion.div
          key={result.key || result.title}
          initial={{ opacity: 0, scale: 0.9, y: 8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.25 }}
          data-testid="result-banner"
          className={`relative overflow-visible rounded-2xl border p-4 text-center ${
            result.push
              ? "border-white/20 bg-white/5"
              : result.win
              ? "border-[hsl(var(--emerald)/0.45)] bg-[hsl(var(--emerald)/0.12)]"
              : "border-destructive/40 bg-destructive/10"
          }`}
        >
          {result.win && !result.push && <ConfettiBurst big={!!result.big} />}
          <p className={`font-display text-2xl ${result.push ? "text-white/85" : result.win ? "text-[hsl(var(--emerald))]" : "text-red-400"}`}>
            {result.title}
          </p>
          {result.subtitle && <p className="text-xs text-white/60 mt-1">{result.subtitle}</p>}
          {result.payout > 0 && (
            <p className="tabular-nums text-lg font-extrabold text-primary mt-1" data-testid="result-payout">
              +{formatChips(result.payout)} chips
            </p>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
};
