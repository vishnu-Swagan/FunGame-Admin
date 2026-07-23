import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Fish } from "lucide-react";
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

/* ---- realistic 53-segment ice money wheel ---- */
const C = 110; // svg center
const BONUS_SET = new Set(["blues", "oranges", "reds"]);
// variable-width segments — bonus wedges are much wider so their colour and
// label read clearly. Cumulative angles from the top (0deg), clockwise.
function buildGeo(layout) {
  const weights = layout.map((t) => (BONUS_SET.has(t) ? 2.7 : 1));
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  let acc = 0;
  return layout.map((t, i) => {
    const w = (weights[i] / total) * 360;
    const a0 = acc; acc += w;
    return { type: t, a0, a1: acc, mid: a0 + w / 2 };
  });
}
function IceWheel({ geo, rot, spinMs, spinning, leafMult, boost }) {
  const R0 = 34, R1 = 96, R_PEG = 99, R_LBL = 74, R_MULT = 55;
  return (
    <div className="relative mx-auto" style={{ width: "100%", maxWidth: 360, aspectRatio: "1/1", filter: "drop-shadow(0 16px 32px rgba(0,0,0,0.55))" }} data-testid="ice-wheel-viz">
      {/* fixed metal frame */}
      <div className="absolute inset-0 rounded-full" style={{ background: "conic-gradient(#e8f4ff, #6f9fc4, #cfe6fa, #4d769b, #e8f4ff)", boxShadow: "inset 0 3px 8px rgba(255,255,255,0.5), inset 0 -4px 10px rgba(0,0,0,0.5), 0 0 0 2px #0b1c2c" }} />
      <div className="absolute rounded-full" style={{ inset: "4.5%", background: "#0a1a2a", boxShadow: "inset 0 2px 8px rgba(0,0,0,0.7)" }} />

      {/* rotating wheel */}
      <div className="absolute" style={{ inset: "5.5%", transform: `rotate(${rot}deg)`, transition: spinning ? `transform ${spinMs}ms cubic-bezier(0.16,0.84,0.24,1) 3500ms` : "none", willChange: "transform" }}>
        <svg viewBox="0 0 220 220" className="w-full h-full">
          <defs>
            {["leaf1", "leaf2", "blank", "blues", "oranges", "reds"].map((t) => (
              <radialGradient key={t} id={`ifg-${t}`} gradientUnits="userSpaceOnUse" cx={C} cy={C} r={R1} fx={C} fy={C}>
                <stop offset="0%" stopColor={SEG[t].fill} />
                <stop offset="72%" stopColor={SEG[t].fill} />
                <stop offset="100%" stopColor={SEG[t].stroke} />
              </radialGradient>
            ))}
            <radialGradient id="ifGloss" cx="50%" cy="30%" r="75%">
              <stop offset="0%" stopColor="rgba(255,255,255,0.35)" />
              <stop offset="45%" stopColor="rgba(255,255,255,0.05)" />
              <stop offset="100%" stopColor="rgba(0,0,0,0.28)" />
            </radialGradient>
          </defs>

          {/* segments (variable width) */}
          {geo.map((g, i) => {
            const s = SEG[g.type] || SEG.blank;
            const isBonus = BONUS_SET.has(g.type);
            const [lx, ly] = polar(C, C, R_LBL, g.mid);
            const hasLeafMult = leafMult && leafMult.index === i;
            const hasBoost = boost && boost.type === g.type;
            return (
              <g key={i}>
                <path d={wedge(C, C, R0, R1, g.a0, g.a1)} fill={`url(#ifg-${g.type})`} />
                {isBonus && <path d={wedge(C, C, R0, R1, g.a0, g.a1)} fill="none" stroke="#fff" strokeWidth="0.8" opacity="0.65" />}
                {s.label && (
                  <text x={lx} y={ly} fill={s.text} fontSize="7.5" fontWeight="900" textAnchor="middle" dominantBaseline="central"
                    transform={`rotate(${g.mid - 90}, ${lx}, ${ly})`} stroke="rgba(0,0,0,0.4)" strokeWidth="0.5" paintOrder="stroke" style={{ letterSpacing: 0.5 }}>{s.label}</text>
                )}
                {(hasLeafMult || hasBoost) && (() => {
                  const [mx, my] = polar(C, C, R_MULT, g.mid);
                  return (
                    <g className="fg-marquee-fast">
                      <circle cx={mx} cy={my} r="8" fill="#ffd447" stroke="#7a5200" strokeWidth="1" />
                      <circle cx={mx} cy={my} r="8" fill="none" stroke="#fff" strokeWidth="0.5" opacity="0.6" />
                      <text x={mx} y={my} fill="#3a2a00" fontSize="6" fontWeight="900" textAnchor="middle" dominantBaseline="central">{(hasLeafMult ? leafMult.mult : boost.mult)}×</text>
                    </g>
                  );
                })()}
              </g>
            );
          })}
          {/* separators + pegs at every boundary */}
          {geo.map((g, i) => {
            const [x0, y0] = polar(C, C, R0, g.a0), [x1, y1] = polar(C, C, R1, g.a0);
            const [px, py] = polar(C, C, R_PEG, g.a0);
            return (
              <g key={`b${i}`}>
                <line x1={x0} y1={y0} x2={x1} y2={y1} stroke="#0b1c2c" strokeWidth="0.5" opacity="0.5" />
                <circle cx={px} cy={py} r="2.1" fill="#eaf6ff" stroke="#38617f" strokeWidth="0.6" />
              </g>
            );
          })}
          {/* gloss + rings */}
          <circle cx={C} cy={C} r={R1} fill="url(#ifGloss)" style={{ mixBlendMode: "soft-light" }} pointerEvents="none" />
          <circle cx={C} cy={C} r={R1} fill="none" stroke="#0b1c2c" strokeWidth="1.5" />
          <circle cx={C} cy={C} r={R0} fill="none" stroke="#0b1c2c" strokeWidth="1" />
        </svg>
      </div>

      {/* fixed hub */}
      <div className="absolute rounded-full flex items-center justify-center" style={{ inset: "35%", background: "radial-gradient(circle at 40% 32%, #eaf6ff, #7fb2d8 55%, #24506f)", boxShadow: "0 3px 10px rgba(0,0,0,0.55), inset 0 2px 5px rgba(255,255,255,0.6), inset 0 -3px 6px rgba(0,0,0,0.4)", border: "2px solid #123049" }}>
        <Fish className="h-1/2 w-1/2 text-[#0a2a44]" strokeWidth={1.6} />
      </div>

      {/* fixed flapper at the top */}
      <div className="absolute left-1/2 -translate-x-1/2 z-30" style={{ top: "-1%" }}>
        <svg width="34" height="40" viewBox="0 0 34 40">
          <circle cx="17" cy="7" r="6" fill="url(#ifFlapPin)" stroke="#5c440d" strokeWidth="1" />
          <defs><radialGradient id="ifFlapPin" cx="40%" cy="32%" r="70%"><stop offset="0%" stopColor="#fff2c8" /><stop offset="60%" stopColor="#ffca3a" /><stop offset="100%" stopColor="#8a6a14" /></radialGradient></defs>
          <path d="M11 8 L23 8 L18 38 L16 38 Z" fill="#c62828" stroke="#7f1010" strokeWidth="1" />
          <path d="M15.5 8 L18.5 8 L17.5 34 L16.5 34 Z" fill="#ff8a80" opacity="0.6" />
        </svg>
      </div>
    </div>
  );
}

/* ---- realistic fish (faces right) ---- */
const FishArt = ({ color, dark, size = 150 }) => {
  const uid = color.replace("#", "");
  return (
    <svg width={size} height={size * 0.66} viewBox="0 0 140 92" style={{ filter: "drop-shadow(0 12px 26px rgba(0,0,0,0.6))" }}>
      <defs>
        <linearGradient id={`fbg-${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.65" />
          <stop offset="30%" stopColor={color} />
          <stop offset="78%" stopColor={color} />
          <stop offset="100%" stopColor={dark} />
        </linearGradient>
      </defs>
      {/* forked tail */}
      <path d="M20 46 C8 30 5 24 2 20 L28 40 C26 44 26 48 28 52 L2 72 C5 68 8 62 20 46 Z" fill={dark} />
      {/* dorsal + pelvic fins */}
      <path d="M54 22 Q72 4 94 18 L86 31 Q70 23 57 31 Z" fill={dark} opacity="0.92" />
      <path d="M60 66 Q72 86 92 70 L84 60 Q70 67 62 60 Z" fill={dark} opacity="0.85" />
      {/* body */}
      <path d="M22 46 C34 22 66 16 96 24 C118 30 133 40 138 46 C133 52 118 62 96 68 C66 76 34 70 22 46 Z" fill={`url(#fbg-${uid})`} stroke="rgba(0,0,0,0.28)" strokeWidth="1" />
      {/* belly sheen */}
      <path d="M42 56 C66 68 98 66 122 55 C100 63 66 68 42 56 Z" fill="#ffffff" opacity="0.25" />
      {/* scales */}
      {[46, 60, 74, 88, 102].map((x, i) => (
        <path key={x} d={`M${x} ${36 + (i % 2) * 2} Q${x + 8} 46 ${x} ${56 - (i % 2) * 2}`} fill="none" stroke="rgba(0,0,0,0.14)" strokeWidth="1.2" />
      ))}
      {/* gill */}
      <path d="M104 30 Q98 46 104 62" fill="none" stroke="rgba(0,0,0,0.3)" strokeWidth="2.5" />
      {/* eye */}
      <circle cx="120" cy="38" r="6.2" fill="#fff" /><circle cx="121.6" cy="38" r="3.1" fill="#101827" /><circle cx="120.2" cy="36.4" r="1.1" fill="#fff" />
      {/* mouth */}
      <path d="M136 46 Q140 48.5 136.5 51" fill="none" stroke="rgba(0,0,0,0.4)" strokeWidth="1.6" />
    </svg>
  );
};

/* ---- cinematic fish bonus reveal ---- */
const FISH_COLOR = { blues: ["#3b90f0", "#12467e"], oranges: ["#ffa62a", "#b4560a"], reds: ["#f04747", "#8f1414"] };
function BonusReveal({ type, fishFinal }) {
  const meta = SPOT_META[type];
  const [reeled, setReeled] = useState(false);
  const [c1, c2] = FISH_COLOR[type] || FISH_COLOR.blues;
  useEffect(() => { const t = setTimeout(() => setReeled(true), 3600); return () => clearTimeout(t); }, []);
  useEffect(() => { sfx.ballSpin && sfx.ballSpin(); }, []);
  useEffect(() => { if (reeled) { sfx.gong && sfx.gong(); sfx.coinShower && sfx.coinShower(); if (navigator.vibrate) navigator.vibrate([0, 80, 40, 160]); } }, [reeled]);
  return (
    <motion.div
      className="absolute inset-0 z-40 rounded-2xl overflow-hidden"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      style={{ background: "linear-gradient(180deg, #123f66 0%, #0e3457 35%, #0a2740 68%, #05121f 100%)" }}
      data-testid="ice-bonus-reveal"
    >
      {/* light rays */}
      <div aria-hidden className="absolute inset-0 pointer-events-none" style={{ background: "conic-gradient(from 200deg at 50% -10%, transparent, rgba(191,230,255,0.14) 8%, transparent 18%, transparent 40%, rgba(191,230,255,0.1) 50%, transparent 62%)", opacity: 0.8 }} />
      {/* rising bubbles */}
      {[14, 30, 46, 60, 72, 86].map((l, i) => (
        <span key={l} aria-hidden className="fg-home-float absolute bottom-2 rounded-full" style={{ left: `${l}%`, width: 4 + (i % 3) * 2, height: 4 + (i % 3) * 2, background: "rgba(210,238,255,0.5)", animationDelay: `${(i % 4) * 0.8}s`, animationDuration: `${3 + (i % 3)}s` }} />
      ))}
      {/* ice surface + hole */}
      <div aria-hidden className="absolute inset-x-0 top-0 h-[26%]" style={{ background: "linear-gradient(180deg, #e6f1fb, #b9d6ef 60%, rgba(167,201,232,0))" }} />
      <div aria-hidden className="absolute left-1/2 top-[23%] -translate-x-1/2 h-7 w-36 rounded-[50%]" style={{ background: "radial-gradient(circle, #0a2740, #061a2c)", boxShadow: "0 0 0 4px rgba(230,241,251,0.6), inset 0 3px 6px rgba(0,0,0,0.5)" }} />
      {/* rod line */}
      <div aria-hidden className="absolute left-1/2 top-0 -translate-x-1/2 w-[1.5px] bg-white/45" style={{ height: reeled ? "40%" : "58%", transition: "height 0.6s" }} />

      <p className="absolute top-2 left-0 right-0 text-center font-tech font-black uppercase tracking-wide text-lg" style={{ color: meta.c, textShadow: "0 2px 10px rgba(0,0,0,0.7)" }}>{meta.label}</p>

      {/* rising fish */}
      <motion.div
        className="absolute left-1/2 -translate-x-1/2 flex flex-col items-center"
        initial={{ top: "100%", rotate: -10, opacity: 0.25 }}
        animate={reeled ? { top: "34%", rotate: 0, opacity: 1 } : { top: "56%", rotate: [-6, 4, -6], opacity: 1 }}
        transition={reeled ? { duration: 0.7, ease: "backOut" } : { top: { duration: 3.6, ease: "easeIn" }, rotate: { duration: 1.4, repeat: Infinity } }}
      >
        <FishArt color={c1} dark={c2} size={140} />
        <AnimatePresence>
          {reeled && (
            <motion.div initial={{ scale: 0.3, opacity: 0, y: 6 }} animate={{ scale: 1, opacity: 1, y: 0 }} transition={{ type: "spring", stiffness: 240, damping: 13 }}
              className="mt-2 px-4 py-1.5 rounded-xl font-tech font-black text-4xl"
              style={{ color: "#3a2a00", background: "linear-gradient(180deg,#fff2c8,#ffca3a 55%,#e0a500)", boxShadow: "0 6px 20px rgba(0,0,0,0.5), 0 0 24px rgba(255,199,64,0.6)", border: "2px solid #fff6d6" }}>
              {fishFinal}×
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>

      {!reeled && <p className="absolute bottom-5 left-0 right-0 text-center font-gaming text-[11px] tracking-[0.3em] uppercase text-white/60">Reeling it in…</p>}
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
  const geo = layout.length ? buildGeo(layout) : [];
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
    const seg = geo[outcome.win_index];
    if (!seg) return;
    const target = (360 - seg.mid + 360) % 360;
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
  }, [phase, outcome, roundNo]);
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
        <IceWheel geo={geo} rot={rot} spinMs={spinMs} spinning={spinning} leafMult={phase !== "BETTING" ? outcome?.leaf_mult : null} boost={phase !== "BETTING" ? outcome?.boost : null} />

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
