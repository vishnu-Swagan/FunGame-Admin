import { useState, useEffect } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { Globe } from "lucide-react";

/* A short themed "opening" shown when you enter a game — the game's key art
   spins/glows up with a LIVE · synced-worldwide badge, then dissolves into the
   live table. Reinforces that every player worldwide shares this exact round. */

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
    case "wheel": return { initial: { rotate: -220, scale: 0.6, opacity: 0 }, animate: { rotate: 0, scale: 1, opacity: 1 } };
    case "slot": return { initial: { y: -40, scale: 0.8, opacity: 0 }, animate: { y: 0, scale: 1, opacity: 1 } };
    case "card": return { initial: { rotateY: 90, scale: 0.8, opacity: 0 }, animate: { rotateY: 0, scale: 1, opacity: 1 } };
    case "fly": return { initial: { x: -60, y: 30, scale: 0.7, opacity: 0 }, animate: { x: 0, y: 0, scale: 1, opacity: 1 } };
    default: return { initial: { scale: 0.6, opacity: 0 }, animate: { scale: 1, opacity: 1 } };
  }
};

// Show the full opening once per game per browser session — after that, jump
// straight into the live table so a realtime round is never re-gated.
const seenKey = (slug) => `fg_intro_${slug}`;
const alreadySeen = (slug) => {
  try { return sessionStorage.getItem(seenKey(slug)) === "1"; } catch { return false; }
};

export const GameIntro = ({ game }) => {
  const reduced = useReducedMotion();
  const [show, setShow] = useState(() => !alreadySeen(game.slug));
  useEffect(() => {
    if (alreadySeen(game.slug)) return;
    try { sessionStorage.setItem(seenKey(game.slug), "1"); } catch { /* ignore */ }
    const t = setTimeout(() => setShow(false), reduced ? 500 : 1700);
    return () => clearTimeout(t);
  }, [reduced, game.slug]);

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
          className="fixed inset-0 z-[60] flex flex-col items-center justify-center px-6 cursor-pointer"
          initial={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.45 } }}
          style={{ background: "radial-gradient(120% 90% at 50% 30%, #14213f 0%, #0a1226 55%, #05070f 100%)" }}
        >
          {/* soft radial glow behind the art */}
          <motion.div
            aria-hidden="true"
            className="absolute h-64 w-64 rounded-full"
            initial={{ opacity: 0, scale: 0.6 }}
            animate={{ opacity: 0.6, scale: 1.15 }}
            transition={{ duration: 1.2, ease: "easeOut" }}
            style={{ background: "radial-gradient(circle, rgba(255,199,64,0.25), transparent 65%)", filter: "blur(6px)" }}
          />
          <motion.img
            src={`/game-art/${game.slug}.png`}
            alt=""
            draggable="false"
            className="relative h-40 w-auto max-w-[70%] object-contain drop-shadow-[0_10px_30px_rgba(0,0,0,0.6)]"
            initial={anim.initial}
            animate={anim.animate}
            transition={{ type: reduced ? "tween" : "spring", stiffness: 120, damping: 14, duration: reduced ? 0.3 : undefined }}
            onError={(e) => { e.currentTarget.style.display = "none"; }}
          />
          <motion.h1
            className="relative font-display text-3xl text-white mt-4 text-center"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2, duration: 0.4 }}
          >
            {game.name}
          </motion.h1>
          <motion.div
            className="relative mt-3 flex items-center gap-2 rounded-full border border-[hsl(var(--emerald)/0.4)] bg-[hsl(var(--emerald)/0.1)] px-3 py-1"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.35, duration: 0.4 }}
          >
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full rounded-full bg-[hsl(var(--emerald))] opacity-70 animate-ping" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-[hsl(var(--emerald))]" />
            </span>
            <span className="text-[11px] font-extrabold tracking-widest text-[hsl(var(--emerald))]">LIVE</span>
            <Globe className="h-3.5 w-3.5 text-white/55" />
            <span className="text-[11px] text-white/65">synced worldwide</span>
          </motion.div>
          <motion.p
            className="relative mt-4 text-[11px] tracking-wider text-white/45"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.5 }}
          >
            {VERB[fam] || "Joining the table"}…
          </motion.p>
          {/* shimmer join bar */}
          {!reduced && (
            <div className="relative mt-3 h-1 w-40 rounded-full overflow-hidden bg-white/8">
              <motion.div
                className="h-full rounded-full"
                initial={{ width: "0%" }}
                animate={{ width: "100%" }}
                transition={{ duration: 1.5, ease: "easeInOut" }}
                style={{ background: "linear-gradient(90deg, hsl(var(--emerald)), #ffd447)" }}
              />
            </div>
          )}
          {!reduced && (
            <motion.span
              className="absolute bottom-8 text-[10px] tracking-wider text-white/30"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.9 }}
            >
              tap to skip
            </motion.span>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
};
