import { useState, useEffect } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { Globe } from "lucide-react";

/* Cinematic opening shown EVERY time you enter a game (3–5s, tap to skip).
   The game's key art animates up over a scanlit stage with a LIVE · synced-
   worldwide badge and a "catching the live round" sync bar, then dissolves into
   the table. The live game is already mounted and polling underneath the intro,
   so when it clears you drop straight into the round in progress — no re-sync. */

// per-game family → how the hero art animates in
const FAMILY = {
  "fun-roulette": "wheel", "super-golden-wheel": "wheel",
  "triple-fun": "slot", "lucky-8-line": "slot", "giant-jackpot": "slot", "joker-bonus": "slot", "fever-joker-bonus": "slot",
  "teen-patti": "card", "poker": "card", "champion-poker": "card", "andar-bahar": "card",
  "seven-up-down": "dice", keno: "ball", bingo: "ball",
  aviator: "fly", checker: "drop", "fun-target": "drop", "no-hold": "card",
};
const VERB = {
  wheel: "Spinning up the wheel", slot: "Warming up the reels", card: "Shuffling the deck",
  dice: "Loading the dice", ball: "Loading the draw", fly: "Cleared for takeoff", drop: "Setting the board",
};
const heroAnim = (fam, reduced) => {
  if (reduced) return { initial: { opacity: 0 }, animate: { opacity: 1 } };
  switch (fam) {
    case "wheel": return { initial: { rotate: -260, scale: 0.55, opacity: 0 }, animate: { rotate: 0, scale: 1, opacity: 1 } };
    case "slot": return { initial: { y: -48, scale: 0.75, opacity: 0 }, animate: { y: 0, scale: 1, opacity: 1 } };
    case "card": return { initial: { rotateY: 100, scale: 0.75, opacity: 0 }, animate: { rotateY: 0, scale: 1, opacity: 1 } };
    case "fly": return { initial: { x: -70, y: 36, scale: 0.65, opacity: 0 }, animate: { x: 0, y: 0, scale: 1, opacity: 1 } };
    default: return { initial: { scale: 0.55, opacity: 0 }, animate: { scale: 1, opacity: 1 } };
  }
};

// Drifting gold sparks — the ambient 4DX layer.
const Sparks = () => (
  <div aria-hidden="true" className="absolute inset-0 overflow-hidden pointer-events-none">
    {[10, 26, 42, 58, 71, 84, 93].map((left, idx) => (
      <span
        key={left}
        className="fg-home-float absolute bottom-4 h-1.5 w-1.5 rounded-full"
        style={{
          left: `${left}%`,
          background: idx % 3 === 0 ? "#fff2c8" : "#ffd447",
          boxShadow: "0 0 6px rgba(255,212,71,0.9)",
          animationDelay: `${(idx % 5) * 0.7}s`,
          animationDuration: `${3.6 + (idx % 4) * 0.6}s`,
        }}
      />
    ))}
  </div>
);

export const GameIntro = ({ game }) => {
  const reduced = useReducedMotion();
  const [show, setShow] = useState(true);
  const DURATION = reduced ? 700 : 4000; // ~4s cinematic (within the 3–5s ask)

  // Play the full opening every time a game is entered. The table is already
  // live underneath, so skipping/finishing always lands on the current round.
  useEffect(() => {
    setShow(true);
    const t = setTimeout(() => setShow(false), DURATION);
    return () => clearTimeout(t);
  }, [game.slug, DURATION]);

  const fam = FAMILY[game.slug] || "drop";
  const anim = heroAnim(fam, reduced);

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          data-testid="game-intro"
          onClick={() => setShow(false)}
          role="button"
          aria-label="Skip intro"
          className="fixed inset-0 z-[70] flex flex-col items-center justify-center px-6 cursor-pointer overflow-hidden"
          initial={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.5 } }}
          style={{ background: "radial-gradient(120% 90% at 50% 28%, #14213f 0%, #0a1226 55%, #05070f 100%)" }}
        >
          {/* cinematic texture layers */}
          <div aria-hidden="true" className="fg-scanlines absolute inset-0 opacity-40 pointer-events-none" />
          {!reduced && (
            <div aria-hidden="true" className="fg-home-sheen-el absolute inset-y-0 -left-1/3 w-1/3 pointer-events-none" style={{ background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.08), transparent)" }} />
          )}
          {!reduced && <Sparks />}

          {/* brand wordmark */}
          <motion.span
            className="absolute top-[13%] font-tech tracking-[0.3em] text-sm text-white/85 drop-shadow-[0_1px_6px_rgba(0,0,0,0.8)]"
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
          >
            FUN<span className="text-primary">GAME</span>
          </motion.span>

          {/* soft radial glow behind the art */}
          <motion.div
            aria-hidden="true"
            className="absolute h-72 w-72 rounded-full"
            initial={{ opacity: 0, scale: 0.6 }}
            animate={{ opacity: 0.6, scale: 1.15 }}
            transition={{ duration: 1.4, ease: "easeOut" }}
            style={{ background: "radial-gradient(circle, rgba(255,199,64,0.25), transparent 65%)", filter: "blur(6px)" }}
          />
          <motion.img
            src={`/game-art/${game.slug}.png`}
            alt=""
            draggable="false"
            className="relative h-40 w-auto max-w-[70%] object-contain drop-shadow-[0_12px_34px_rgba(0,0,0,0.65)]"
            initial={anim.initial}
            animate={anim.animate}
            transition={{ type: reduced ? "tween" : "spring", stiffness: 110, damping: 15, duration: reduced ? 0.3 : undefined }}
            onError={(e) => { e.currentTarget.style.display = "none"; }}
          />
          <motion.h1
            className="relative font-tech font-black uppercase text-[2rem] leading-tight tracking-tight text-white mt-4 text-center"
            style={{ textShadow: "0 3px 20px rgba(0,0,0,0.7), 0 0 26px rgba(255,199,64,0.2)" }}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.25, duration: 0.5 }}
          >
            {game.name}
          </motion.h1>
          <motion.div
            className="relative mt-3 flex items-center gap-2 rounded-full border border-[hsl(var(--emerald)/0.4)] bg-[hsl(var(--emerald)/0.1)] px-3 py-1"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.45, duration: 0.4 }}
          >
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full rounded-full bg-[hsl(var(--emerald))] opacity-70 animate-ping" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-[hsl(var(--emerald))]" />
            </span>
            <span className="font-gaming text-[11px] font-bold tracking-widest text-[hsl(var(--emerald))]">LIVE</span>
            <Globe className="h-3.5 w-3.5 text-white/55" />
            <span className="text-[11px] text-white/65">synced worldwide</span>
          </motion.div>
          <motion.p
            className="relative mt-4 font-gaming text-[11px] tracking-[0.25em] uppercase text-white/50"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.6 }}
          >
            {VERB[fam] || "Joining the table"} · catching the live round…
          </motion.p>
          {/* sync bar timed to the full intro */}
          {!reduced && (
            <div className="relative mt-3 h-1.5 w-48 rounded-full overflow-hidden bg-white/10">
              <motion.div
                className="h-full rounded-full"
                initial={{ width: "0%" }}
                animate={{ width: "100%" }}
                transition={{ duration: DURATION / 1000 - 0.35, ease: "easeInOut" }}
                style={{ background: "linear-gradient(90deg, hsl(var(--emerald)), #ffd447)" }}
              />
            </div>
          )}
          {!reduced && (
            <motion.span
              className="absolute bottom-8 font-gaming text-[10px] tracking-wider uppercase text-white/30"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 1.0 }}
            >
              tap to skip
            </motion.span>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
};
