import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "sonner";
import { Timer, RotateCcw, Repeat } from "lucide-react";
import { FitWidth } from "@/components/FitWidth";
import { api, errMsg } from "@/lib/api";
import { sfx } from "@/lib/sound";
import { PlayShell, HistoryStrip } from "@/components/play/PlayShell";
import { ResultBanner } from "@/components/play/ResultBanner";
import { formatChips } from "@/components/common";

const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const EURO_ORDER = [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26];
const SEG = 360 / 37;
const CHIPS = [
  { v: 10, bg: "#e2e8f0", fg: "#0f172a" },
  { v: 50, bg: "#22d3ee", fg: "#083344" },
  { v: 100, bg: "#ffc740", fg: "#3a2a00" },
  { v: 500, bg: "#f472b6", fg: "#500724" },
  { v: 1000, bg: "#4ade80", fg: "#052e16" },
];

// ---------------- SVG European wheel ----------------
function polar(cx, cy, r, deg) {
  const rad = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

function wedgePath(cx, cy, r0, r1, a0, a1) {
  const [x0, y0] = polar(cx, cy, r1, a0);
  const [x1, y1] = polar(cx, cy, r1, a1);
  const [x2, y2] = polar(cx, cy, r0, a1);
  const [x3, y3] = polar(cx, cy, r0, a0);
  return `M ${x0} ${y0} A ${r1} ${r1} 0 0 1 ${x1} ${y1} L ${x2} ${y2} A ${r0} ${r0} 0 0 0 ${x3} ${y3} Z`;
}

const WheelSVG = () => (
  <svg viewBox="0 0 220 220" className="w-full h-full">
    <defs>
      <radialGradient id="rimWood" cx="50%" cy="42%" r="62%">
        <stop offset="0%" stopColor="#6b4a12" />
        <stop offset="70%" stopColor="#4a320c" />
        <stop offset="100%" stopColor="#2c1d06" />
      </radialGradient>
      <radialGradient id="hubMetal" cx="45%" cy="40%" r="65%">
        <stop offset="0%" stopColor="#f4d67a" />
        <stop offset="55%" stopColor="#c9a227" />
        <stop offset="100%" stopColor="#7a5c12" />
      </radialGradient>
    </defs>
    {/* wooden rim */}
    <circle cx="110" cy="110" r="109" fill="url(#rimWood)" />
    <circle cx="110" cy="110" r="106" fill="none" stroke="#e8c86a" strokeWidth="1.2" opacity="0.8" />
    <circle cx="110" cy="110" r="103" fill="none" stroke="#c9a227" strokeWidth="2.4" />
    {/* ball track */}
    <circle cx="110" cy="110" r="99" fill="#1c1408" />
    <circle cx="110" cy="110" r="95" fill="none" stroke="#00000055" strokeWidth="6" />
    {/* deflector studs */}
    {[22.5, 67.5, 112.5, 157.5, 202.5, 247.5, 292.5, 337.5].map((a) => {
      const [dx, dy] = polar(110, 110, 97, a);
      return <circle key={a} cx={dx} cy={dy} r="2" fill="#e8c86a" />;
    })}
    {EURO_ORDER.map((n, i) => {
      const a0 = i * SEG - SEG / 2;
      const a1 = a0 + SEG;
      const fill = n === 0 ? "#0a7a3c" : RED.has(n) ? "#b3282d" : "#15181f";
      const mid = i * SEG;
      const [tx, ty] = polar(110, 110, 84, mid);
      return (
        <g key={n}>
          <path d={wedgePath(110, 110, 54, 92, a0, a1)} fill={fill} stroke="#c9a227" strokeWidth="0.7" />
          <text
            x={tx}
            y={ty}
            fill="#fff"
            fontSize="8"
            fontWeight="700"
            textAnchor="middle"
            dominantBaseline="central"
            transform={`rotate(${mid}, ${tx}, ${ty})`}
          >
            {n}
          </text>
        </g>
      );
    })}
    {/* pocket separators glint */}
    <circle cx="110" cy="110" r="92" fill="none" stroke="#e8c86a" strokeWidth="0.8" opacity="0.7" />
    {/* cone centre */}
    <circle cx="110" cy="110" r="54" fill="#1a1408" stroke="#c9a227" strokeWidth="1.5" />
    <circle cx="110" cy="110" r="40" fill="#241a06" />
    <circle cx="110" cy="110" r="28" fill="#2b2005" stroke="#c9a227" strokeWidth="1" />
    {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => {
      const [x1, y1] = polar(110, 110, 28, a);
      const [x2, y2] = polar(110, 110, 52, a);
      return <line key={a} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#c9a227" strokeWidth="2" opacity="0.9" />;
    })}
    {/* turret */}
    <circle cx="110" cy="110" r="9" fill="url(#hubMetal)" />
    <circle cx="110" cy="110" r="3.5" fill="#f8e6ae" />
  </svg>
);

/* ---------------- 3D wheel pieces (CSS transforms) ---------------- */

/** Extruded wooden bowl wall - stacked rings below the wheel face fake a
    solid cylinder once the scene is tilted in perspective. */
const RimWall3D = () => (
  <>
    {Array.from({ length: 12 }, (_, i) => (
      <div
        key={i}
        aria-hidden="true"
        className="absolute inset-0 rounded-full"
        style={{
          transform: `translateZ(${-(i + 1) * 2}px)`,
          background:
            i === 11
              ? "#160f04"
              : "radial-gradient(circle at 50% 30%, #5b3f0e 0%, #3a290a 62%, #241806 100%)",
        }}
      />
    ))}
    {/* soft elliptical ground shadow */}
    <div
      aria-hidden="true"
      className="absolute rounded-full"
      style={{
        inset: -16,
        transform: "translateZ(-30px)",
        background: "radial-gradient(circle, rgba(0,0,0,0.6) 0%, rgba(0,0,0,0.25) 55%, transparent 75%)",
        filter: "blur(7px)",
      }}
    />
  </>
);

/** Raised golden turret with cross handles - spins with the wheel head. */
const Turret3D = () => (
  <div className="absolute inset-0 pointer-events-none" style={{ transformStyle: "preserve-3d" }} aria-hidden="true">
    {Array.from({ length: 8 }, (_, i) => (
      <div
        key={i}
        className="absolute left-1/2 top-1/2 h-[22px] w-[22px] -ml-[11px] -mt-[11px] rounded-full"
        style={{
          transform: `translateZ(${(i + 1) * 2.4}px)`,
          background: "radial-gradient(circle at 38% 32%, #f4d67a, #b8901f 60%, #7a5c12)",
        }}
      />
    ))}
    <div
      className="absolute left-1/2 top-1/2 h-[7px] w-[92px] -ml-[46px] -mt-[3.5px] rounded-full"
      style={{ transform: "translateZ(20px)", background: "linear-gradient(90deg, #7a5c12, #f4d67a 50%, #7a5c12)", boxShadow: "0 0 5px rgba(0,0,0,0.4)" }}
    />
    <div
      className="absolute left-1/2 top-1/2 h-[92px] w-[7px] -ml-[3.5px] -mt-[46px] rounded-full"
      style={{ transform: "translateZ(20px)", background: "linear-gradient(180deg, #7a5c12, #f4d67a 50%, #7a5c12)", boxShadow: "0 0 5px rgba(0,0,0,0.4)" }}
    />
    <div
      className="absolute left-1/2 top-1/2 h-[13px] w-[13px] -ml-[6.5px] -mt-[6.5px] rounded-full"
      style={{ transform: "translateZ(24px)", background: "radial-gradient(circle at 35% 30%, #ffe9ad, #c9a227 70%, #8a6a14)" }}
    />
  </div>
);

// Small colored result chip
const ResultDot = ({ n, big = false }) => (
  <span
    className={`inline-flex items-center justify-center rounded-full font-bold tabular-nums border ${
      big ? "h-10 w-10 text-base border-2" : "h-6 w-6 text-[10px]"
    } ${n === 0 ? "bg-[#0a7a3c] border-[#12a355]" : RED.has(n) ? "bg-[#b3282d] border-[#e05a5f]" : "bg-[#15181f] border-white/40"} text-white`}
  >
    {n}
  </span>
);

/* ---- Module-level board pieces (stable identity = no remount flicker) ---- */
const FELT_CELL = "border border-white/60 bg-[#127a43] text-white flex items-center justify-center";

/** Pick the chip colour that matches the staked total (largest denom <= total). */
const chipLook = (v) => CHIPS.reduce((acc, c) => (v >= c.v ? c : acc), CHIPS[0]);

/** A staked chip sitting dead-centre on its bet spot - drops in with a springy
    casino "toss" and pops away when bets are cleared. */
const BetChip = ({ total }) => {
  const c = chipLook(total);
  return (
    <motion.span
      initial={{ scale: 2.2, y: -34, opacity: 0 }}
      animate={{ scale: 1, y: 0, opacity: 1 }}
      exit={{ scale: 0.4, opacity: 0 }}
      transition={{ type: "spring", stiffness: 480, damping: 26 }}
      className="pointer-events-none absolute left-1/2 top-1/2 z-20 h-7 w-7 -ml-3.5 -mt-3.5 rounded-full border-2 border-dashed flex items-center justify-center text-[9px] font-extrabold tabular-nums shadow-[0_3px_7px_rgba(0,0,0,0.5)]"
      style={{ background: c.bg, color: c.fg, borderColor: "rgba(255,255,255,0.8)" }}
      data-testid="board-chip"
    >
      {total >= 1000 ? `${total / 1000}k` : total}
    </motion.span>
  );
};

const NumberSpot = ({ n }) => (
  <span
    className={`pointer-events-none inline-flex items-center justify-center w-[26px] h-[32px] rounded-[50%] text-white text-[13px] font-bold tabular-nums ${
      RED.has(n) ? "bg-[#c22c31]" : "bg-[#101318]"
    }`}
  >
    {n}
  </span>
);

const Diamond = ({ color }) => (
  <span className="pointer-events-none inline-block h-4 w-4 rotate-45 border border-white/80" style={{ background: color === "red" ? "#c22c31" : "#101318" }} />
);

const BoardCell = ({ type, value, label, className = "", style, testId, betting, onPlace, chipTotal }) => (
  <button
    data-testid={testId || `roulette-cell-${type}-${value}`}
    onClick={() => onPlace(type, value)}
    disabled={!betting}
    style={style}
    className={`relative font-bold transition-[filter] duration-100 ${betting ? "hover:brightness-125 active:scale-[0.97]" : "opacity-85"} ${className}`}
  >
    {label}
    <AnimatePresence>{chipTotal ? <BetChip total={chipTotal} /> : null}</AnimatePresence>
  </button>
);

/** Invisible hit zone straddling a line (split) or a cross (corner) between
    numbers - exactly like placing a chip on the felt lines in a real casino. */
const BetSpot = ({ type, nums, pos, style, betting, onPlace, chipTotal }) => (
  <button
    data-testid={`roulette-spot-${type}-${nums.join("-")}`}
    aria-label={`${type} bet on ${nums.join(", ")}`}
    onClick={() => onPlace(type, nums.join("-"))}
    disabled={!betting}
    style={style}
    className={`relative z-10 h-7 w-7 rounded-full ${pos} ${betting ? "active:scale-110" : ""}`}
  >
    <AnimatePresence>{chipTotal ? <BetChip total={chipTotal} /> : null}</AnimatePresence>
  </button>
);

export default function RouletteGame({ game }) {
  const [state, setState] = useState(null);
  const [balance, setBalance] = useState(null);
  const [chip, setChip] = useState(100);
  const [countdown, setCountdown] = useState(0);
  const [wheelRot, setWheelRot] = useState(0);
  const [spinningAnim, setSpinningAnim] = useState(false);
  const [cameraZoom, setCameraZoom] = useState(false);
  const camTimerRef = useRef(null);
  const [result, setResult] = useState(null);
  const [history, setHistory] = useState([]);
  const [placing, setPlacing] = useState(false);

  const pollRef = useRef(null);
  const tickRef = useRef(null);
  const deadlineRef = useRef(0);
  const spunRoundRef = useRef(null);
  const settledShownRef = useRef(null);
  const lastBetsRef = useRef([]);
  const wheelRotRef = useRef(0);
  const stateRef = useRef(null);
  const ballRef = useRef(null);
  const ballAnimRef = useRef(null);

  const loadHistory = useCallback(async () => {
    try {
      const { data } = await api.get("/games/fun-roulette/history");
      setHistory(data.rounds || []);
    } catch (e) {
      /* silent */
    }
  }, []);

  /* Real European roulette physics: the wheel spins COUNTERCLOCKWISE while the
     ball is launched CLOCKWISE on the outer track. The ball circles the track,
     decelerates, spirals down past the deflectors with small bounces and
     finally settles into the winning pocket as the wheel slows. In 3D the
     ball also drops in height (translateZ) from the upper rim into the bowl. */
  const animateBall = useCallback(() => {
    const DURATION = 5200; // matches the wheel deceleration
    const TOTAL = 6 * 360; // clockwise revolutions (opposite to the wheel)
    const R_TRACK = 101;
    const R_POCKET = 75;
    const Z_TRACK = 20; // height on the outer rim edge
    const Z_POCKET = 5; // height once seated in a pocket
    const start = performance.now();
    cancelAnimationFrame(ballAnimRef.current);
    const frame = (now) => {
      const p = Math.min(1, (now - start) / DURATION);
      const ease = 1 - Math.pow(1 - p, 3); // decelerating
      const ang = TOTAL * ease; // ends exactly at the top pointer
      let r = R_TRACK;
      let z = Z_TRACK;
      if (p > 0.55) {
        const q = Math.min(1, (p - 0.55) / 0.35);
        r = R_TRACK - (R_TRACK - R_POCKET) * q;
        z = Z_TRACK - (Z_TRACK - Z_POCKET) * q;
        if (p > 0.62 && p < 0.92) {
          const hop = Math.sin(p * 55) * (1 - p);
          r += hop * 2.6; // deflector bounces
          z += Math.abs(hop) * 5; // little vertical hops
        }
      }
      if (ballRef.current) ballRef.current.style.transform = `rotate(${ang}deg) translateY(-${r}px) translateZ(${z}px)`;
      if (p < 1) {
        ballAnimRef.current = requestAnimationFrame(frame);
      } else {
        sfx.ballLand();
      }
    };
    ballAnimRef.current = requestAnimationFrame(frame);
  }, []);

  const spinTo = useCallback(
    (winning) => {
      const idx = EURO_ORDER.indexOf(winning);
      if (idx < 0) return;
      const prev = wheelRotRef.current;
      const targetMod = (360 - idx * SEG) % 360;
      // counterclockwise: at least 5 full turns, ending with the winning pocket at the top
      const delta = 5 * 360 + (((((prev % 360) + 360) % 360) - targetMod + 360) % 360);
      const next = prev - delta;
      wheelRotRef.current = next;
      setSpinningAnim(true);
      // cinematic camera: dolly in on the numbers for the spin, pull back
      // once the ball has landed and the result is showing
      setCameraZoom(true);
      clearTimeout(camTimerRef.current);
      camTimerRef.current = setTimeout(() => setCameraZoom(false), 5600);
      setWheelRot(next);
      sfx.ballSpin();
      animateBall();
    },
    [animateBall]
  );

  const applyState = useCallback(
    (data) => {
      stateRef.current = data;
      setState(data);
      setBalance(data.balance);
      deadlineRef.current = Date.now() + data.phase_ends_in * 1000;

      if (data.my_bets && data.my_bets.length > 0) lastBetsRef.current = data.my_bets;

      // Trigger the wheel animation once per round when spinning starts
      if (data.phase !== "BETTING" && data.winning_number !== null && spunRoundRef.current !== data.round_number) {
        spunRoundRef.current = data.round_number;
        spinTo(data.winning_number);
        setResult(null);
      }
      if (data.phase === "BETTING") {
        setSpinningAnim(false);
        setCameraZoom(false);
      }
      // Show settlement result once
      if (data.settled && settledShownRef.current !== data.settled.round_number) {
        settledShownRef.current = data.settled.round_number;
        const s = data.settled;
        const win = s.payout > 0;
        setResult({
          key: `r-${s.round_number}`,
          win,
          title: win ? `Winner — number ${s.winning_number}!` : `Number ${s.winning_number} (${s.color})`,
          subtitle: win ? `You staked ${formatChips(s.total_bet)}` : `You staked ${formatChips(s.total_bet)} — better luck next spin`,
          payout: s.payout,
        });
        if (win) (s.payout >= s.total_bet * 5 ? sfx.bigWinCelebration : sfx.winCelebration)();
        else {
          sfx.lose();
          sfx.aww();
        }
        loadHistory();
      }
    },
    [spinTo, loadHistory]
  );

  const poll = useCallback(async () => {
    try {
      const { data } = await api.get("/games/fun-roulette/state");
      applyState(data);
    } catch (e) {
      /* transient */
    }
  }, [applyState]);

  useEffect(() => {
    poll();
    loadHistory();
    pollRef.current = setInterval(poll, 2000);
    tickRef.current = setInterval(() => {
      setCountdown(Math.max(0, (deadlineRef.current - Date.now()) / 1000));
    }, 100);
    return () => {
      clearInterval(pollRef.current);
      clearInterval(tickRef.current);
      clearTimeout(camTimerRef.current);
      cancelAnimationFrame(ballAnimRef.current);
    };
  }, [poll, loadHistory]);

  const placeBet = async (bet_type, value) => {
    if (!state || state.phase !== "BETTING") {
      toast.info("Bets are closed — wait for the next round");
      return;
    }
    if (placing) return;
    setPlacing(true);
    try {
      const { data } = await api.post("/games/fun-roulette/bets", { bet_type, value, amount: chip });
      setState((s) => (s ? { ...s, my_bets: data.my_bets, my_total: data.my_total } : s));
      setBalance(data.balance);
      lastBetsRef.current = data.my_bets;
      sfx.chip();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setPlacing(false);
    }
  };

  const clearBets = async () => {
    try {
      const { data } = await api.post("/games/fun-roulette/bets/clear");
      setBalance(data.balance);
      setState((s) => (s ? { ...s, my_bets: [], my_total: 0 } : s));
      sfx.chip();
      toast.success(`Refunded ${formatChips(data.refunded)} chips`);
    } catch (e) {
      toast.error(errMsg(e));
    }
  };

  const rebet = async () => {
    const bets = lastBetsRef.current;
    if (!bets.length) return;
    for (const b of bets) {
      // eslint-disable-next-line no-await-in-loop
      await placeBet(b.bet_type, b.value);
    }
  };

  // Aggregate my bets per spot for chip display
  const spotTotals = {};
  (state?.my_bets || []).forEach((b) => {
    const k = `${b.bet_type}:${b.value}`;
    spotTotals[k] = (spotTotals[k] || 0) + b.amount;
  });

  const betting = state?.phase === "BETTING";
  const isResult = state?.phase === "RESULT";
  const winning = state?.winning_number;
  const cellCommon = { betting, onPlace: placeBet };

  return (
    <PlayShell game={game} balance={balance}>
      {/* Phase + universal timer */}
      <div
        data-testid="roulette-phase-bar"
        className={`rounded-2xl border p-3 flex items-center justify-between gap-3 ${
          betting ? "border-[hsl(var(--emerald)/0.4)] bg-[hsl(var(--emerald)/0.08)]" : "border-[hsl(var(--magenta)/0.4)] bg-[hsl(var(--magenta)/0.08)]"
        }`}
      >
        <div className="flex items-center gap-2">
          <Timer className={`h-4 w-4 ${betting ? "text-[hsl(var(--emerald))]" : "text-[hsl(var(--magenta))]"}`} />
          <span data-testid="roulette-phase" className={`text-xs font-extrabold tracking-wider ${betting ? "text-[hsl(var(--emerald))]" : "text-[hsl(var(--magenta))]"}`}>
            {betting ? "PLACE YOUR BETS" : state?.phase === "SPINNING" ? "NO MORE BETS" : "RESULT"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-white/45">round #{state?.round_number ?? "…"}</span>
          <span data-testid="roulette-timer" className={`tabular-nums font-display text-2xl ${betting ? "text-[hsl(var(--emerald))]" : "text-[hsl(var(--magenta))]"}`}>
            {Math.ceil(countdown)}
          </span>
        </div>
      </div>
      {betting && (
        <div className="h-1.5 rounded-full bg-white/5 overflow-hidden -mt-2">
          <div
            className="h-full bg-[hsl(var(--emerald))] rounded-full transition-[width] duration-200"
            style={{ width: `${Math.min(100, (countdown / (state?.betting_seconds || 20)) * 100)}%` }}
          />
        </div>
      )}

      {/* 3D Wheel with cinematic camera: dollies in on the numbers while the
          ball is spinning, pulls back out once the result lands */}
      <div className="rounded-2xl bg-card/55 border border-white/10 p-4 flex flex-col items-center gap-2 overflow-hidden">
        <div
          className="relative h-[212px] w-[264px] z-10"
          data-testid="roulette-wheel"
          style={{
            transform: cameraZoom ? "scale(1.34)" : "scale(1)",
            transformOrigin: "50% 34%",
            transition: "transform 1.6s cubic-bezier(0.3, 0.7, 0.25, 1)",
            willChange: "transform",
          }}
        >
          {/* screen-space pointer above the far edge of the tilted wheel */}
          <div className="absolute left-1/2 top-[18px] -translate-x-1/2 z-30 w-0 h-0 border-l-[7px] border-r-[7px] border-t-[11px] border-l-transparent border-r-transparent border-t-primary drop-shadow" />
          {/* perspective scene */}
          <div className="absolute inset-0" style={{ perspective: "860px" }}>
            <div
              className="absolute left-1/2 top-1/2 h-[230px] w-[230px] -ml-[115px] -mt-[112px]"
              style={{
                transform: `rotateX(${cameraZoom ? 45 : 52}deg)`,
                transformStyle: "preserve-3d",
                transition: "transform 1.6s cubic-bezier(0.3, 0.7, 0.25, 1)",
              }}
            >
              {/* extruded wooden bowl + ground shadow */}
              <RimWall3D />
              {/* wheel head — spins counterclockwise like a real European wheel */}
              <div
                className="absolute inset-0"
                style={{
                  transform: `rotateZ(${wheelRot}deg)`,
                  transformStyle: "preserve-3d",
                  transition: spinningAnim ? "transform 5.2s cubic-bezier(0.12, 0.8, 0.2, 1)" : "none",
                  willChange: "transform",
                }}
              >
                <WheelSVG />
                <Turret3D />
              </div>
              {/* white ball — launched clockwise, spirals down into the winning pocket */}
              <div className="absolute inset-0 pointer-events-none flex items-center justify-center" style={{ transformStyle: "preserve-3d" }}>
                <div
                  ref={ballRef}
                  className="h-3.5 w-3.5 rounded-full bg-white shadow-[0_0_10px_rgba(255,255,255,0.95),inset_-1px_-1px_2px_rgba(0,0,0,0.25)]"
                  style={{ transform: "rotate(0deg) translateY(-75px) translateZ(5px)" }}
                />
              </div>
            </div>
          </div>
          {/* landed number — screen-space overlay */}
          {!betting && winning !== null && !spinningAnimActive(countdown, state) && (
            <div className="absolute inset-0 z-20 flex items-center justify-center">
              <ResultDot n={winning} big />
            </div>
          )}
        </div>
        {/* last results */}
        <div className="flex items-center gap-1.5 flex-wrap justify-center" data-testid="roulette-last-results">
          <span className="text-[10px] text-white/40 mr-1">LAST</span>
          {(state?.last_results || []).map((r) => (
            <ResultDot key={r.round_number} n={r.winning_number} />
          ))}
        </div>
      </div>

      <ResultBanner result={result} />

      {/* Classic European table — auto-fits any screen width */}
      <div
        className="rounded-2xl border-2 border-[#c9a227]/50 p-2.5"
        style={{ background: "radial-gradient(130% 140% at 50% 0%, #1d8a4f 0%, #14713e 55%, #0c5a2f 100%)" }}
        data-testid="roulette-board"
      >
        <FitWidth>
          <div className="w-[600px] select-none">
          <div className="grid gap-0" style={{ gridTemplateColumns: "42px repeat(12, minmax(0, 1fr)) 46px", gridTemplateRows: "44px 44px 44px 42px 42px" }}>
            {/* zero wedge */}
            <BoardCell
              {...cellCommon}
              type="straight"
              value={0}
              chipTotal={spotTotals["straight:0"]}
              label={<span className="pointer-events-none font-display text-xl">0</span>}
              testId="roulette-cell-straight-0"
              style={{ gridColumn: 1, gridRow: "1 / span 3" }}
              className={`${FELT_CELL} rounded-l-[24px] ${isResult && winning === 0 ? "ring-2 ring-primary z-10" : ""}`}
            />
            {/* number grid — classic layout, top row 3..36 */}
            {[0, 1, 2].map((row) =>
              Array.from({ length: 12 }, (_, j) => {
                const n = 3 * (j + 1) - row;
                return (
                  <BoardCell
                    {...cellCommon}
                    key={n}
                    type="straight"
                    value={n}
                    chipTotal={spotTotals[`straight:${n}`]}
                    label={<NumberSpot n={n} />}
                    style={{ gridColumn: j + 2, gridRow: row + 1 }}
                    className={`${FELT_CELL} ${isResult && winning === n ? "ring-2 ring-primary z-10" : ""}`}
                  />
                );
              })
            )}
            {/* 2 to 1 column bets (top row = column 3) */}
            {[0, 1, 2].map((row) => (
              <BoardCell
                {...cellCommon}
                key={`col-${row}`}
                type="column"
                value={3 - row}
                chipTotal={spotTotals[`column:${3 - row}`]}
                label={<span className="pointer-events-none text-[10px] font-extrabold tracking-tight">2 to 1</span>}
                style={{ gridColumn: 14, gridRow: row + 1 }}
                className={FELT_CELL}
              />
            ))}
            {/* split + corner hit zones — chips land on the lines between numbers */}
            {[0, 1, 2].map((row) =>
              Array.from({ length: 12 }, (_, j) => {
                const n = 3 * (j + 1) - row;
                const spots = [];
                if (j < 11) spots.push({ type: "split", nums: [n, n + 3], pos: "justify-self-end self-center translate-x-1/2" });
                if (row < 2) spots.push({ type: "split", nums: [n - 1, n], pos: "self-end justify-self-center translate-y-1/2" });
                if (j < 11 && row < 2)
                  spots.push({ type: "corner", nums: [n - 1, n, n + 2, n + 3], pos: "justify-self-end self-end translate-x-1/2 translate-y-1/2" });
                return spots.map((s) => (
                  <BetSpot
                    key={`${s.type}-${s.nums.join("-")}`}
                    type={s.type}
                    nums={s.nums}
                    pos={s.pos}
                    betting={betting}
                    onPlace={placeBet}
                    chipTotal={spotTotals[`${s.type}:${s.nums.join("-")}`]}
                    style={{ gridColumn: j + 2, gridRow: row + 1 }}
                  />
                ));
              })
            )}
            {/* zero splits on the 0 wedge boundary */}
            {[3, 2, 1].map((z, row) => (
              <BetSpot
                key={`zero-split-${z}`}
                type="split"
                nums={[0, z]}
                pos="justify-self-start self-center -translate-x-1/2"
                betting={betting}
                onPlace={placeBet}
                chipTotal={spotTotals[`split:0-${z}`]}
                style={{ gridColumn: 2, gridRow: row + 1 }}
              />
            ))}
            {/* dozens */}
            {[1, 2, 3].map((d) => (
              <BoardCell
                {...cellCommon}
                key={`dozen-${d}`}
                type="dozen"
                value={d}
                chipTotal={spotTotals[`dozen:${d}`]}
                label={<span className="pointer-events-none text-[12px] font-extrabold tracking-wide">{d === 1 ? "1st 12" : d === 2 ? "2nd 12" : "3rd 12"}</span>}
                style={{ gridColumn: `${2 + (d - 1) * 4} / span 4`, gridRow: 4 }}
                className={FELT_CELL}
              />
            ))}
            {/* outside bets */}
            <BoardCell {...cellCommon} type="range" value="low" chipTotal={spotTotals["range:low"]} label={<span className="pointer-events-none text-[11px] font-extrabold">1 to 18</span>} style={{ gridColumn: "2 / span 2", gridRow: 5 }} className={FELT_CELL} />
            <BoardCell {...cellCommon} type="parity" value="even" chipTotal={spotTotals["parity:even"]} label={<span className="pointer-events-none text-[11px] font-extrabold">EVEN</span>} style={{ gridColumn: "4 / span 2", gridRow: 5 }} className={FELT_CELL} />
            <BoardCell {...cellCommon} type="color" value="red" chipTotal={spotTotals["color:red"]} label={<Diamond color="red" />} style={{ gridColumn: "6 / span 2", gridRow: 5 }} className={FELT_CELL} />
            <BoardCell {...cellCommon} type="color" value="black" chipTotal={spotTotals["color:black"]} label={<Diamond color="black" />} style={{ gridColumn: "8 / span 2", gridRow: 5 }} className={FELT_CELL} />
            <BoardCell {...cellCommon} type="parity" value="odd" chipTotal={spotTotals["parity:odd"]} label={<span className="pointer-events-none text-[11px] font-extrabold">ODD</span>} style={{ gridColumn: "10 / span 2", gridRow: 5 }} className={FELT_CELL} />
            <BoardCell {...cellCommon} type="range" value="high" chipTotal={spotTotals["range:high"]} label={<span className="pointer-events-none text-[11px] font-extrabold">19 to 36</span>} style={{ gridColumn: "12 / span 2", gridRow: 5 }} className={FELT_CELL} />
          </div>
          </div>
        </FitWidth>
        <p className="text-[10px] text-white/50 mt-1.5">The table auto-fits your screen — every bet is always reachable</p>
      </div>

      {/* Chip selector + actions */}
      <div className="rounded-2xl bg-card/55 border border-white/10 p-4 space-y-3" data-testid="roulette-chip-tray">
        <div className="flex items-center justify-between">
          <p className="text-xs font-semibold text-white/60">Select chip, then tap the board</p>
          <p className="text-xs text-white/60">
            My bets: <span data-testid="roulette-my-total" className="tabular-nums font-bold text-primary">{formatChips(state?.my_total || 0)}</span>
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {CHIPS.map((c) => (
            <button
              key={c.v}
              data-testid={`roulette-chip-${c.v}`}
              onClick={() => setChip(c.v)}
              aria-label={`Chip ${c.v}`}
              className={`h-12 w-12 rounded-full font-extrabold text-[11px] tabular-nums border-4 border-dashed shadow-md transition-transform duration-100 ${chip === c.v ? "scale-110 ring-2 ring-primary" : "opacity-85 hover:opacity-100"}`}
              style={{ background: c.bg, color: c.fg, borderColor: "rgba(255,255,255,0.55)" }}
            >
              {c.v >= 1000 ? `${c.v / 1000}k` : c.v}
            </button>
          ))}
          <div className="flex-1" />
          <button
            data-testid="roulette-rebet-button"
            onClick={rebet}
            disabled={!betting || (state?.my_bets || []).length > 0 || lastBetsRef.current.length === 0}
            className="h-10 px-3 rounded-xl border border-white/15 bg-white/5 hover:bg-white/10 text-xs font-bold text-white/75 disabled:opacity-40 flex items-center gap-1.5"
          >
            <Repeat className="h-3.5 w-3.5" /> Rebet
          </button>
          <button
            data-testid="roulette-clear-bets"
            onClick={clearBets}
            disabled={!betting || (state?.my_bets || []).length === 0}
            className="h-10 px-3 rounded-xl border border-destructive/40 bg-destructive/10 hover:bg-destructive/20 text-xs font-bold text-red-400 disabled:opacity-40 flex items-center gap-1.5"
          >
            <RotateCcw className="h-3.5 w-3.5" /> Clear
          </button>
        </div>
        <p className="text-[11px] text-white/40">
          Straight 36x · Split 18x · Corner 9x · Dozen/Column 3x · Red/Black/Odd/Even/1-18/19-36 2x
        </p>
        <p className="text-[10px] text-white/35">
          Tap a number for straight-up · tap the line between two numbers for a split · tap the cross where four numbers meet for a corner
        </p>
      </div>

      <HistoryStrip history={history} />
    </PlayShell>
  );
}

// Ball/wheel animation lasts ~5.2s of the 6s spin phase; show the landed number
// once the spin phase is nearly over or during the result phase.
function spinningAnimActive(countdown, state) {
  if (!state) return false;
  if (state.phase === "SPINNING") return countdown > 0.7;
  return false;
}
