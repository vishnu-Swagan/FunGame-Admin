import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Fish, Snowflake } from "lucide-react";
import { useLiveRound } from "@/lib/useLiveRound";
import { sfx } from "@/lib/sound";
import { HistoryStrip } from "@/components/play/PlayShell";
import { LastResults, ResultPill } from "@/components/play/LiveBar";
import { ResultBanner } from "@/components/play/ResultBanner";
import { GameStage } from "@/components/play/GameStage";
import { CoinShower } from "@/pages/play/slots/slotFx";
import { formatChips } from "@/components/common";

/* ---- palette ---- */
const SEG = {
  leaf1:   { fill: "#e6f1fb", stroke: "#b9d6ef", text: "#123", label: "" },
  leaf2:   { fill: "#a7c9e8", stroke: "#7fabd4", text: "#0a223a", label: "" },
  blank:   { fill: "#54718c", stroke: "#3d566d", text: "#cfe3f5", label: "" },
  blues:   { fill: "#2f7fe0", stroke: "#1e5fb0", text: "#eaf3ff", label: "LIL" },
  oranges: { fill: "#ef9a1e", stroke: "#c47708", text: "#3a1e00", label: "BIG" },
  reds:    { fill: "#d62f2f", stroke: "#a01e1e", text: "#fff", label: "HUGE" },
};
const SPOT_META = {
  leaf1:  { label: "Leaf 1", sub: "1:1", c: "#e6f1fb", fg: "#0a223a" },
  leaf2:  { label: "Leaf 2", sub: "1:1", c: "#a7c9e8", fg: "#0a223a" },
  blues:  { label: "Lil' Blues", sub: "3–100×", c: "#2f7fe0", fg: "#fff" },
  oranges:{ label: "Big Oranges", sub: "4–200×", c: "#ef9a1e", fg: "#241200" },
  reds:   { label: "Huge Reds", sub: "10–500×", c: "#d62f2f", fg: "#fff" },
  "all-bonuses": { label: "All Bonuses", sub: "cover all fish", c: "#8b5cf6", fg: "#fff" },
};
const CHIPS = [
  { v: 10, bg: "#e2e8f0", fg: "#0f172a" }, { v: 50, bg: "#22d3ee", fg: "#083344" },
  { v: 100, bg: "#ffc740", fg: "#3a2a00" }, { v: 500, bg: "#f472b6", fg: "#500724" },
  { v: 1000, bg: "#4ade80", fg: "#052e16" },
];

const polar = (cx, cy, r, deg) => { const a = ((deg - 90) * Math.PI) / 180; return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; };
const wedge = (cx, cy, r0, r1, a0, a1) => {
  const [x0, y0] = polar(cx, cy, r1, a0), [x1, y1] = polar(cx, cy, r1, a1);
  const [x2, y2] = polar(cx, cy, r0, a1), [x3, y3] = polar(cx, cy, r0, a0);
  return `M ${x0} ${y0} A ${r1} ${r1} 0 0 1 ${x1} ${y1} L ${x2} ${y2} A ${r0} ${r0} 0 0 0 ${x3} ${y3} Z`;
};

/* ---- 53-segment ice wheel ---- */
function IceWheel({ layout, rot, spinMs, spinning, leafMult, boost }) {
  const n = layout.length || 53;
  const step = 360 / n;
  return (
    <div className="relative mx-auto" style={{ width: "100%", maxWidth: 340, aspectRatio: "1/1" }}>
      {/* pointer */}
      <div className="absolute left-1/2 -top-0.5 -translate-x-1/2 z-30 w-0 h-0 border-l-[10px] border-r-[10px] border-t-[16px] border-l-transparent border-r-transparent border-t-primary drop-shadow-[0_2px_3px_rgba(0,0,0,0.6)]" />
      <div className="absolute inset-0" style={{ transform: `rotate(${rot}deg)`, transition: spinning ? `transform ${spinMs}ms cubic-bezier(0.16,0.84,0.24,1) 3500ms` : "none", willChange: "transform" }}>
        <svg viewBox="0 0 220 220" className="w-full h-full">
          <defs>
            <radialGradient id="ifRim" cx="50%" cy="34%" r="70%"><stop offset="0%" stopColor="#bfe6ff" /><stop offset="60%" stopColor="#4f86b8" /><stop offset="100%" stopColor="#173049" /></radialGradient>
            <radialGradient id="ifHub" cx="42%" cy="34%" r="70%"><stop offset="0%" stopColor="#eaf6ff" /><stop offset="55%" stopColor="#7fb2d8" /><stop offset="100%" stopColor="#2d5474" /></radialGradient>
          </defs>
          <circle cx="110" cy="110" r="109" fill="url(#ifRim)" />
          <circle cx="110" cy="110" r="104" fill="none" stroke="#0b1c2c" strokeWidth="2" />
          {layout.map((t, i) => {
            const a0 = i * step - step / 2, a1 = a0 + step, mid = i * step;
            const s = SEG[t] || SEG.blank;
            const [tx, ty] = polar(110, 110, 84, mid);
            const hasLeafMult = leafMult && leafMult.index === i;
            const hasBoost = boost && boost.type === t;
            return (
              <g key={i}>
                <path d={wedge(110, 110, 40, 103, a0, a1)} fill={s.fill} stroke={s.stroke} strokeWidth="0.5" />
                {s.label && (
                  <text x={tx} y={ty} fill={s.text} fontSize="4.2" fontWeight="800" textAnchor="middle" dominantBaseline="central" transform={`rotate(${mid}, ${tx}, ${ty})`}>{s.label}</text>
                )}
                {(hasLeafMult || hasBoost) && (() => {
                  const [mx, my] = polar(110, 110, 68, mid);
                  return (
                    <g transform={`rotate(${mid}, ${mx}, ${my})`}>
                      <circle cx={mx} cy={my} r="7.5" fill="#ffd447" stroke="#7a5200" strokeWidth="0.8" className="fg-marquee-fast" />
                      <text x={mx} y={my} fill="#3a2a00" fontSize="5.5" fontWeight="900" textAnchor="middle" dominantBaseline="central">{(hasLeafMult ? leafMult.mult : boost.mult)}×</text>
                    </g>
                  );
                })()}
              </g>
            );
          })}
          <circle cx="110" cy="110" r="40" fill="url(#ifHub)" stroke="#0b1c2c" strokeWidth="1.5" />
          <circle cx="110" cy="110" r="14" fill="#0b1c2c" opacity="0.35" />
        </svg>
      </div>
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <Snowflake className="h-7 w-7 text-white/85" strokeWidth={1.6} />
      </div>
    </div>
  );
}

/* ---- cinematic fish bonus reveal ---- */
function BonusReveal({ type, fishFinal }) {
  const meta = SPOT_META[type];
  const [reeled, setReeled] = useState(false);
  useEffect(() => { const t = setTimeout(() => setReeled(true), 3400); return () => clearTimeout(t); }, []);
  useEffect(() => { sfx.ballSpin && sfx.ballSpin(); }, []);
  useEffect(() => { if (reeled) { sfx.gong && sfx.gong(); sfx.coinShower && sfx.coinShower(); if (navigator.vibrate) navigator.vibrate([0, 80, 40, 140]); } }, [reeled]);
  return (
    <motion.div
      className="absolute inset-0 z-40 rounded-2xl overflow-hidden flex flex-col items-center justify-end pb-6"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      style={{ background: "linear-gradient(180deg, #0a2038 0%, #0e3457 40%, #0a2740 70%, #061626 100%)" }}
      data-testid="ice-bonus-reveal"
    >
      {/* ice surface + hole */}
      <div aria-hidden className="absolute inset-x-0 top-0 h-1/3" style={{ background: "linear-gradient(180deg, #dCEBFA, #a7c9e8 70%, transparent)" }} />
      <div aria-hidden className="absolute left-1/2 top-[30%] -translate-x-1/2 h-8 w-40 rounded-[50%]" style={{ background: "radial-gradient(circle, #0a2740, #06121f)", boxShadow: "0 0 0 4px rgba(191,230,255,0.5)" }} />
      <p className="absolute top-3 left-0 right-0 text-center font-tech font-black uppercase tracking-wide text-lg" style={{ color: meta.c, textShadow: "0 2px 10px rgba(0,0,0,0.6)" }}>{meta.label} Bonus</p>

      {/* rising fish */}
      <motion.div
        initial={{ y: 220, rotate: -8, opacity: 0.2 }}
        animate={{ y: reeled ? 0 : 60, rotate: reeled ? 0 : -4, opacity: 1 }}
        transition={{ duration: reeled ? 0.7 : 3.4, ease: reeled ? "backOut" : "easeIn" }}
        className="relative flex flex-col items-center"
      >
        <Fish className="h-24 w-24" style={{ color: meta.c, filter: "drop-shadow(0 8px 20px rgba(0,0,0,0.5))" }} strokeWidth={1.4} fill={meta.c} />
        <AnimatePresence>
          {reeled && (
            <motion.div initial={{ scale: 0.3, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: "spring", stiffness: 260, damping: 14 }}
              className="mt-1 font-tech font-black text-4xl" style={{ color: "#ffd447", textShadow: "0 3px 16px rgba(0,0,0,0.7), 0 0 24px rgba(255,199,64,0.5)" }}>
              {fishFinal}×
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
      {!reeled && <p className="relative mt-3 font-gaming text-[11px] tracking-[0.3em] uppercase text-white/60">Reeling it in…</p>}
      {reeled && <CoinShower />}
    </motion.div>
  );
}

export default function IceFishingGame({ game }) {
  const { state, countdown, balance, betting, phase, outcome, result, history, placeBet, clearBets, myBets, myTotal, lastResults, placing } =
    useLiveRound(game.slug, {
      formatResult: (s) => {
        const wt = s.outcome.win_type;
        const win = s.payout > 0;
        const nice = { leaf1: "Leaf 1", leaf2: "Leaf 2", blank: "Frost", blues: "Lil' Blues", oranges: "Big Oranges", reds: "Huge Reds" }[wt] || wt;
        return {
          title: win ? `${nice} — you win!` : `${nice}`,
          subtitle: s.outcome.fish_final ? `${nice} bonus caught ${s.outcome.fish_final}×` : "Instant leaf result",
          big: win && s.payout >= (s.total_bet || 1) * 20,
        };
      },
    });

  const opts = state?.options || {};
  const layout = opts.layout || [];
  const n = layout.length || 53;
  const [chip, setChip] = useState(100);
  const [rot, setRot] = useState(0);
  const [spinning, setSpinning] = useState(false);
  const [landed, setLanded] = useState(false);
  const rotRef = useRef(0);
  const spunRef = useRef(null);
  const landTimer = useRef(null);
  const roundNo = state?.round_number;
  const spinMs = 7000;

  const isBonus = outcome && ["blues", "oranges", "reds"].includes(outcome.win_type);
  const showBonus = phase === "RESULT" && isBonus;

  // spin the wheel once per round when the outcome arrives (after the multiplier drop)
  useEffect(() => {
    if (phase === "BETTING") { setSpinning(false); setLanded(false); return; }
    if (!outcome || outcome.win_index == null || spunRef.current === roundNo) return;
    spunRef.current = roundNo;
    const step = 360 / n;
    const target = (360 - outcome.win_index * step) % 360;
    const prev = rotRef.current;
    const prevMod = ((prev % 360) + 360) % 360;
    let delta = (target - prevMod + 360) % 360;
    delta += 360 * 6; // full spins
    const next = prev + delta;
    rotRef.current = next;
    setSpinning(true); setLanded(false); setRot(next);
    sfx.spin && sfx.spin();
    clearTimeout(landTimer.current);
    landTimer.current = setTimeout(() => { setLanded(true); sfx.reelStop && sfx.reelStop(); if (navigator.vibrate) navigator.vibrate(40); }, 3500 + spinMs + 150);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, outcome, roundNo, n]);
  useEffect(() => () => clearTimeout(landTimer.current), []);

  const spotTotals = {};
  myBets.forEach((b) => { spotTotals[b.selection] = (spotTotals[b.selection] || 0) + b.amount; });
  const place = (spot) => betting && placeBet(spot, chip);

  const Spot = ({ id, big }) => {
    const m = SPOT_META[id];
    const tot = spotTotals[id] || 0;
    return (
      <button
        data-testid={`ice-spot-${id}`}
        onClick={() => place(id)}
        disabled={!betting}
        className={`relative rounded-xl border-2 min-h-[52px] px-2 py-2 flex flex-col items-center justify-center transition-[filter,transform] duration-100 ${betting ? "hover:brightness-110 active:scale-[0.97]" : "opacity-70"} ${big ? "col-span-3" : ""}`}
        style={{ background: `${m.c}22`, borderColor: `${m.c}99` }}
      >
        <span className="font-gaming font-bold text-sm leading-none" style={{ color: m.c }}>{m.label}</span>
        <span className="text-[9px] text-white/55 mt-0.5">{m.sub}</span>
        {tot > 0 && (
          <span className="absolute -top-1.5 -right-1.5 h-5 min-w-5 px-1 rounded-full bg-primary text-primary-foreground text-[9px] font-extrabold flex items-center justify-center border border-yellow-200 shadow tabular-nums">{formatChips(tot)}</span>
        )}
      </button>
    );
  };

  const nice = (wt) => ({ leaf1: "LEAF 1", leaf2: "LEAF 2", blank: "FROST", blues: "LIL' BLUES", oranges: "BIG ORANGES", reds: "HUGE REDS" }[wt] || wt);

  return (
    <GameStage
      game={game}
      balance={balance}
      live={{ phase, countdown, timings: state?.timings, roundNumber: roundNo }}
      labels={{ REVEAL: "NO MORE BETS" }}
      betDock={
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <Spot id="leaf1" /><Spot id="leaf2" />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <Spot id="blues" /><Spot id="oranges" /><Spot id="reds" />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <Spot id="all-bonuses" big />
          </div>
          <div className="flex items-center gap-1.5 flex-wrap pt-0.5">
            {CHIPS.map((c) => (
              <button key={c.v} data-testid={`ice-chip-${c.v}`} onClick={() => setChip(c.v)} aria-label={`Chip ${c.v}`}
                className={`h-10 w-10 rounded-full font-extrabold text-[10px] tabular-nums border-4 border-dashed shadow transition-transform duration-100 ${chip === c.v ? "scale-110 ring-2 ring-primary" : "opacity-80 hover:opacity-100"}`}
                style={{ background: c.bg, color: c.fg, borderColor: "rgba(255,255,255,0.55)" }}>
                {c.v >= 1000 ? `${c.v / 1000}k` : c.v}
              </button>
            ))}
            <div className="flex-1" />
            <p className="text-[11px] text-white/60">Staked <span className="tabular-nums font-bold text-primary">{formatChips(myTotal)}</span></p>
          </div>
          {betting && myBets.length > 0 && (
            <button data-testid="live-clear-bets" onClick={clearBets} className="w-full text-[11px] font-bold text-red-400/85 hover:text-red-400">Clear my bets (refund)</button>
          )}
        </div>
      }
      extras={
        <div className="space-y-3">
          <div className="rounded-2xl border p-3.5" style={{ borderColor: "#4aa3d933", background: "rgba(10,42,68,0.4)" }}>
            <p className="text-xs font-extrabold tracking-wider mb-2" style={{ color: "#bfe6ff" }}>HOW IT PAYS</p>
            <div className="space-y-1 text-[11px] text-white/60">
              <p><span className="text-white/80 font-bold">Leaf 1 / Leaf 2</span> — instant 1:1 (boosted up to 10:1 by a wheel multiplier).</p>
              <p><span className="text-white/80 font-bold">Bonuses</span> — hook the fish for its multiplier. A wheel boost (2–10×) supercharges every fish. Max 5000×.</p>
              <p><span className="text-white/80 font-bold">All Bonuses</span> covers all three fish spots — the balanced way to chase a bonus.</p>
            </div>
          </div>
          <HistoryStrip history={history} />
        </div>
      }
    >
      {/* ---- ice wheel stage ---- */}
      <div className="relative rounded-2xl border-2 p-4 overflow-hidden" style={{ borderColor: "#4aa3d955", background: "radial-gradient(120% 100% at 50% 20%, #123a5c 0%, #0a2740 55%, #061626 100%)" }} data-testid="ice-wheel">
        <IceWheel layout={layout} rot={rot} spinMs={spinMs} spinning={spinning} leafMult={phase !== "BETTING" ? outcome?.leaf_mult : null} boost={phase !== "BETTING" ? outcome?.boost : null} />

        {/* result plate */}
        <div className="mt-3 rounded-lg border text-center py-1.5" style={{ borderColor: "#4aa3d944", background: "rgba(0,0,0,0.3)" }}>
          <p className="text-xs font-extrabold tracking-wider" style={{ color: landed || phase === "RESULT" ? "#bfe6ff" : "#7fb2d8" }} data-testid="ice-result-label">
            {phase === "BETTING" ? "PLACE YOUR BETS · ONE WHEEL, EVERYONE" :
             !landed ? "NO MORE BETS — SPINNING…" :
             outcome ? `${nice(outcome.win_type)}${outcome.fish_final ? ` · ${outcome.fish_final}×` : ""}` : "…"}
          </p>
        </div>
        <div className="flex justify-center mt-2">
          <LastResults items={lastResults} render={(r) => (
            <ResultPill label={r.fish ? `${r.fish}×` : (r.win_type || "").slice(0, 1).toUpperCase()} tone={["blues", "oranges", "reds"].includes(r.win_type) ? "gold" : "neutral"} />
          )} />
        </div>

        {/* cinematic bonus reveal overlays the wheel during RESULT */}
        <AnimatePresence>
          {showBonus && landed && <BonusReveal type={outcome.win_type} fishFinal={outcome.fish_final} />}
        </AnimatePresence>
      </div>

      <ResultBanner result={result} />
    </GameStage>
  );
}
