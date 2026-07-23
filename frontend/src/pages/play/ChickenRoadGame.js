import { useState, useEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "sonner";
import { ChevronRight, RotateCcw } from "lucide-react";
import { api, errMsg } from "@/lib/api";
import { sfx } from "@/lib/sound";
import { PlayShell } from "@/components/play/PlayShell";
import { CoinShower } from "@/pages/play/slots/slotFx";
import { formatChips } from "@/components/common";

const REQ = { timeout: 22000 };
const LANE_W = 84;      // px per lane cell
const ANCHOR = 58;      // chicken's fixed x on screen; world scrolls under it
const CHIPS = [
  { v: 10, bg: "#e2e8f0", fg: "#0f172a" }, { v: 50, bg: "#22d3ee", fg: "#083344" },
  { v: 100, bg: "#ffc740", fg: "#3a2a00" }, { v: 500, bg: "#f472b6", fg: "#500724" },
  { v: 1000, bg: "#4ade80", fg: "#052e16" },
];
const DIFFS = ["easy", "medium", "hard", "hardcore"];
const DIFF_LABEL = { easy: "Easy", medium: "Medium", hard: "Hard", hardcore: "Hardcore" };

/* ---- crisp vector logo (resolution-independent) ---- */
export function ChickenRoadLogo({ height = 30 }) {
  return (
    <span className="inline-flex items-center gap-1.5 select-none" style={{ height }}>
      <svg width={height} height={height} viewBox="0 0 40 40" aria-hidden>
        {/* egg */}
        <ellipse cx="20" cy="22" rx="12" ry="15" fill="url(#crEgg)" stroke="#c99a12" strokeWidth="1.4" />
        <path d="M12 20 Q20 12 28 20" fill="none" stroke="#fff6cf" strokeWidth="1.6" opacity="0.7" />
        <defs>
          <linearGradient id="crEgg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#fff2c0" /><stop offset="55%" stopColor="#ffd447" /><stop offset="100%" stopColor="#e0a500" />
          </linearGradient>
        </defs>
      </svg>
      <span className="font-tech font-black tracking-tight leading-none" style={{ fontSize: height * 0.5 }}>
        <span className="text-white">CHICKEN</span> <span style={{ color: "#ffd447" }}>ROAD</span>
      </span>
    </span>
  );
}

/* ---- chicken sprite ---- */
function Chicken({ dead, hopping, size = 52 }) {
  return (
    <motion.svg
      width={size} height={size} viewBox="0 0 60 60"
      animate={dead ? { rotate: 90, y: 6, opacity: 0.75 } : hopping ? { y: [0, -14, 0] } : { y: [0, -2, 0] }}
      transition={dead ? { duration: 0.3 } : hopping ? { duration: 0.32 } : { duration: 1.6, repeat: Infinity }}
      style={{ filter: "drop-shadow(0 6px 8px rgba(0,0,0,0.5))" }}
    >
      {/* body */}
      <ellipse cx="30" cy="38" rx="17" ry="15" fill="#fff" stroke="#e6e6e6" strokeWidth="1" />
      {/* wing */}
      <path d="M22 34 Q30 30 38 36 Q30 44 22 40 Z" fill="#eef1f6" />
      {/* head */}
      <circle cx="38" cy="24" r="11" fill="#fff" stroke="#e6e6e6" strokeWidth="1" />
      {/* comb */}
      <path d="M34 15 q3 -5 6 -1 q3 -4 5 1 q2 -2 3 2 l-2 4 h-11 Z" fill="#e23b3b" />
      {/* wattle */}
      <path d="M40 31 q3 4 0 7 q-3 -1 -3 -5 Z" fill="#e23b3b" />
      {/* beak */}
      <path d="M48 24 l8 2 l-8 3 Z" fill="#f5a623" stroke="#c47f10" strokeWidth="0.6" />
      {/* eye */}
      <circle cx="41" cy="22" r="3.4" fill="#fff" stroke="#222" strokeWidth="0.8" />
      <circle cx={dead ? 41.8 : 42} cy="22" r="1.7" fill="#111" />
      {!dead && <circle cx="41.2" cy="21" r="0.7" fill="#fff" />}
      {dead && <path d="M39 20 l4 4 M43 20 l-4 4" stroke="#111" strokeWidth="1.1" />}
      {/* legs */}
      <path d="M26 52 l0 5 M34 52 l0 5" stroke="#f5a623" strokeWidth="2.2" strokeLinecap="round" />
    </motion.svg>
  );
}

/* ---- little truck for a lane ---- */
const Truck = ({ color = "#8892c4", size = 40 }) => (
  <svg width={size} height={size * 0.7} viewBox="0 0 50 34" aria-hidden style={{ filter: "drop-shadow(0 4px 6px rgba(0,0,0,0.45))" }}>
    <rect x="2" y="8" width="30" height="16" rx="3" fill={color} />
    <rect x="30" y="12" width="14" height="12" rx="2.5" fill={color} opacity="0.85" />
    <rect x="33" y="14" width="8" height="6" rx="1" fill="#cfe0ff" opacity="0.7" />
    <circle cx="12" cy="27" r="4.5" fill="#1a1f2e" stroke="#3a4472" strokeWidth="1" />
    <circle cx="12" cy="27" r="1.8" fill="#556" />
    <circle cx="36" cy="27" r="4.5" fill="#1a1f2e" />
    <circle cx="36" cy="27" r="1.8" fill="#556" />
  </svg>
);

export default function ChickenRoadGame({ game }) {
  const [state, setState] = useState(null);
  const [difficulty, setDifficulty] = useState("easy");
  const [amount, setAmount] = useState(50);
  const [chip, setChip] = useState(50);
  const [busy, setBusy] = useState(false);
  const [hopping, setHopping] = useState(false);

  const refresh = useCallback(async () => {
    try { const { data } = await api.get("/chicken-road/state", REQ); setState(data); if (data.difficulty) setDifficulty(data.difficulty); } catch { /* */ }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const status = state?.status;
  const running = status === "running";
  const lost = status === "lost";
  const cashed = status === "cashed";
  const done = lost || cashed;
  const idle = !state || status === "idle";
  const balance = state?.balance;
  const config = state?.config || {};
  const pos = state?.position || 0;

  // multipliers to render on the board: live run's list, else the picked difficulty's
  const mults = running || done ? (state?.multipliers || []) : (config[difficulty]?.multipliers || []);
  const collisionPct = config[difficulty]?.collision_pct;

  // auto-return to idle a few seconds after a run ends
  const reset = useCallback(() => setState((s) => ({ status: "idle", balance: s?.balance, config: s?.config, min_bet: s?.min_bet })), []);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(reset, lost ? 2600 : 3400);
    return () => clearTimeout(t);
  }, [done, lost, reset]);

  useEffect(() => {
    if (cashed) { sfx.winCelebration ? sfx.winCelebration() : sfx.slotBell && sfx.slotBell(); }
    else if (lost) { sfx.lose ? sfx.lose() : sfx.diceLand && sfx.diceLand(); if (navigator.vibrate) navigator.vibrate([0, 60, 40, 120]); }
  }, [cashed, lost]);

  const play = async () => {
    if (amount <= 0) { toast.info("Set a bet first"); return; }
    setBusy(true); sfx.chip && sfx.chip();
    try { const { data } = await api.post("/chicken-road/start", { bet: amount, difficulty }, REQ); setState(data); }
    catch (e) { toast.error(errMsg(e, "Could not start — try again.")); }
    finally { setBusy(false); }
  };
  const step = async () => {
    if (busy) return;
    setBusy(true); setHopping(true); sfx.flick && sfx.flick();
    setTimeout(() => setHopping(false), 340);
    try { const { data } = await api.post("/chicken-road/step", {}, REQ); setState(data); }
    catch (e) { toast.error(errMsg(e)); }
    finally { setBusy(false); }
  };
  const cashout = async () => {
    if (busy) return;
    setBusy(true);
    try { const { data } = await api.post("/chicken-road/cashout", {}, REQ); setState(data); }
    catch (e) { toast.error(errMsg(e)); }
    finally { setBusy(false); }
  };

  // world scroll so the chicken stays anchored while the road moves under it
  const stripX = ANCHOR - (pos + 0.5) * LANE_W;
  const crashLane = done ? state?.crash_at : null;

  return (
    <PlayShell game={game} balance={balance}>
      {/* ---- header logo ---- */}
      <div className="flex items-center justify-between px-0.5">
        <ChickenRoadLogo height={26} />
        {running && (
          <span className="text-[11px] font-bold tabular-nums px-2 py-0.5 rounded-full" style={{ color: "#ffe08a", background: "rgba(255,212,71,0.14)", border: "1px solid rgba(255,212,71,0.35)" }}>
            {DIFF_LABEL[difficulty]} · {collisionPct}% risk
          </span>
        )}
      </div>

      {/* ---- road ---- */}
      <div className="relative rounded-2xl overflow-hidden border-2" style={{ height: 236, borderColor: "#3b4a8666", background: "linear-gradient(180deg,#20263f 0%,#171c30 100%)" }} data-testid="chicken-road-board">
        {/* scrolling strip */}
        <motion.div className="absolute top-0 bottom-0 flex" animate={{ x: stripX }} transition={{ type: "spring", stiffness: 260, damping: 30 }} style={{ left: 0 }}>
          {/* start coop */}
          <div className="relative shrink-0 h-full" style={{ width: LANE_W }}>
            <div className="absolute inset-y-6 left-2 right-1 rounded-lg" style={{ background: "linear-gradient(180deg,#2b3252,#1a1f36)", border: "1px solid #3b4a86" }} />
            <div className="absolute left-1/2 -translate-x-1/2 rounded-t-full" style={{ top: 46, width: 40, height: 120, background: "radial-gradient(60% 40% at 50% 8%, #10131f, #05060c)" }} />
          </div>
          {/* lanes */}
          {mults.map((m, i) => {
            const lane = i + 1;                       // 1-based
            const crossed = lane <= pos;
            const isCurrent = lane === pos;
            const isCrash = crashLane === lane && lost;
            return (
              <div key={i} className="relative shrink-0 h-full" style={{ width: LANE_W }}>
                {/* dashed lane divider */}
                <div className="absolute inset-y-0 left-0" style={{ borderLeft: "3px dashed rgba(255,255,255,0.14)" }} />
                {/* multiplier coin */}
                <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 grid place-items-center rounded-full font-tech font-black tabular-nums"
                  style={{
                    width: 60, height: 60, fontSize: m >= 100 ? 12 : 14,
                    color: crossed ? "#0a1020" : "#c8d2f0",
                    background: crossed ? "radial-gradient(circle at 38% 30%, #fff2c0, #ffd447 60%, #c99013)" : "radial-gradient(circle at 38% 30%, #3a4472, #2b3352 55%, #222842)",
                    border: `2px solid ${crossed ? "#fff6cf" : "#454f78"}`,
                    boxShadow: isCurrent ? "0 0 0 3px rgba(255,212,71,0.55), 0 6px 16px rgba(0,0,0,0.5)" : crossed ? "0 4px 12px rgba(255,199,64,0.4)" : "0 4px 10px rgba(0,0,0,0.4)",
                  }}>
                  {m}x
                </div>
                {/* ambient parked truck */}
                {!crossed && (i % 3 === 1) && (
                  <div className="absolute left-1/2 -translate-x-1/2" style={{ bottom: 12, opacity: 0.5 }}><Truck /></div>
                )}
                {/* collision truck */}
                <AnimatePresence>
                  {isCrash && (
                    <motion.div className="absolute left-1/2 -translate-x-1/2 z-20" initial={{ top: -60 }} animate={{ top: "42%" }} transition={{ duration: 0.32, ease: "easeIn" }}>
                      <Truck color="#e2554f" size={52} />
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            );
          })}
        </motion.div>

        {/* chicken anchored over the current lane */}
        <div className="absolute z-30 top-1/2 -translate-y-1/2" style={{ left: ANCHOR - 26 }}>
          <Chicken dead={lost} hopping={hopping} />
        </div>

        {/* running HUD */}
        {running && (
          <div className="absolute top-2 left-1/2 -translate-x-1/2 text-center">
            <span className="text-[10px] font-bold tracking-[0.2em] text-white/45">STEP TO CROSS →</span>
          </div>
        )}

        {/* result flash */}
        <AnimatePresence>
          {done && (
            <motion.div className="absolute inset-0 z-40 grid place-items-center pointer-events-none" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} style={{ background: "rgba(6,8,16,0.35)" }}>
              {cashed && <CoinShower />}
              <motion.div initial={{ scale: 0.7 }} animate={{ scale: 1 }} transition={{ type: "spring", stiffness: 300, damping: 16 }}
                className="px-5 py-2.5 rounded-2xl font-tech font-black text-center"
                style={{ color: cashed ? "#052e16" : "#fff", background: cashed ? "linear-gradient(180deg,#fde68a,#f5b312)" : "rgba(150,30,36,0.85)", border: `2px solid ${cashed ? "#fff3c4" : "rgba(255,255,255,0.35)"}`, boxShadow: cashed ? "0 8px 26px rgba(245,179,18,0.6)" : "0 8px 22px rgba(0,0,0,0.6)" }}>
                {cashed ? (<><div className="text-xl">CASHED OUT</div><div className="text-2xl tabular-nums">+{formatChips(state.payout)}</div></>) : (<><div className="text-xl">CRASHED!</div><div className="text-xs opacity-80 mt-0.5">a truck got the chicken</div></>)}
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* ---- controls ---- */}
      {running ? (
        <div className="grid grid-cols-2 gap-2">
          <button onClick={step} disabled={busy} data-testid="chicken-step"
            className="rounded-xl bg-[hsl(var(--emerald))] text-black font-extrabold text-base py-3.5 min-h-[52px] active:scale-[0.98] disabled:opacity-50 flex items-center justify-center gap-1">
            STEP <ChevronRight className="h-5 w-5" />
          </button>
          <button onClick={cashout} disabled={busy || pos < 1} data-testid="chicken-cashout"
            className="rounded-xl font-extrabold text-base py-3.5 min-h-[52px] active:scale-[0.98] disabled:opacity-40"
            style={{ background: "linear-gradient(180deg,#fde68a,#f5b312)", color: "#3a2a00", boxShadow: "0 8px 22px rgba(245,179,18,0.4)" }}>
            CASH OUT {pos >= 1 ? `${formatChips(state.cashout_value)}` : ""}
          </button>
        </div>
      ) : done ? (
        <button onClick={reset} className="w-full rounded-xl bg-primary text-primary-foreground font-extrabold text-base uppercase py-3.5 min-h-[52px] active:scale-[0.98]">
          New Round
        </button>
      ) : (
        <div className="space-y-2.5">
          {/* difficulty */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-[11px] font-bold text-white/60">Difficulty</span>
              <span className="text-[11px] text-white/50">Chance of collision <span className="font-bold" style={{ color: "#ffbfae" }}>{collisionPct}%</span></span>
            </div>
            <div className="grid grid-cols-4 gap-1.5">
              {DIFFS.map((d) => (
                <button key={d} data-testid={`chicken-diff-${d}`} onClick={() => setDifficulty(d)}
                  className={`rounded-lg py-2 text-[11px] font-bold capitalize transition-colors ${difficulty === d ? "text-black" : "text-white/70 bg-white/6 hover:bg-white/10"}`}
                  style={difficulty === d ? { background: "linear-gradient(180deg,#fde68a,#f5b312)" } : {}}>
                  {DIFF_LABEL[d]}
                </button>
              ))}
            </div>
          </div>
          {/* chips + bet */}
          <div className="flex items-center gap-1.5 flex-wrap">
            {CHIPS.map((c) => (
              <button key={c.v} onClick={() => { setChip(c.v); setAmount(c.v); }} aria-label={`Chip ${c.v}`}
                className={`h-10 w-10 rounded-full font-extrabold text-[10px] tabular-nums border-4 border-dashed shadow transition-transform duration-100 ${chip === c.v ? "scale-110 ring-2 ring-primary" : "opacity-80 hover:opacity-100"}`}
                style={{ background: c.bg, color: c.fg, borderColor: "rgba(255,255,255,0.55)" }}>
                {c.v >= 1000 ? `${c.v / 1000}k` : c.v}
              </button>
            ))}
            <div className="flex-1" />
            <div className="flex items-center gap-1">
              <button onClick={() => setAmount((a) => Math.max(10, a - chip))} className="h-9 w-9 rounded-lg border border-white/15 bg-white/5 text-white font-bold">−</button>
              <span className="min-w-[60px] text-center font-extrabold tabular-nums text-primary">{formatChips(amount)}</span>
              <button onClick={() => setAmount((a) => a + chip)} className="h-9 w-9 rounded-lg border border-white/15 bg-white/5 text-white font-bold">+</button>
            </div>
          </div>
          <button onClick={play} disabled={busy || amount <= 0} data-testid="chicken-play"
            className="w-full rounded-xl font-extrabold text-base uppercase py-3.5 min-h-[52px] active:scale-[0.98] disabled:opacity-50"
            style={{ background: "linear-gradient(180deg,#5ee08a,#28b463)", color: "#04210f", boxShadow: "0 8px 24px rgba(40,180,99,0.4)" }}>
            Play · {formatChips(amount)}
          </button>
          <p className="text-[10px] text-white/40 text-center">Each lane crossed raises the multiplier — cash out before a truck hits.</p>
        </div>
      )}
    </PlayShell>
  );
}
