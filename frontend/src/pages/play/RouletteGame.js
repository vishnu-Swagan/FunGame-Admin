import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "sonner";
import { Timer, RotateCcw, Repeat, Undo2 } from "lucide-react";
import { FitWidth } from "@/components/FitWidth";
import { api, errMsg } from "@/lib/api";
import { sfx } from "@/lib/sound";
import { PlayShell } from "@/components/play/PlayShell";
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
      <radialGradient id="rimWood" cx="50%" cy="30%" r="72%">
        <stop offset="0%" stopColor="#8a5f1c" />
        <stop offset="52%" stopColor="#573a0e" />
        <stop offset="100%" stopColor="#221606" />
      </radialGradient>
      <radialGradient id="trackWell" cx="50%" cy="46%" r="55%">
        <stop offset="72%" stopColor="#0c0904" />
        <stop offset="100%" stopColor="#000000" />
      </radialGradient>
      <linearGradient id="fret" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stopColor="#fbf3d6" />
        <stop offset="45%" stopColor="#c3ad70" />
        <stop offset="100%" stopColor="#6b5626" />
      </linearGradient>
      <radialGradient id="hubMetal" cx="40%" cy="34%" r="72%">
        <stop offset="0%" stopColor="#fff2c8" />
        <stop offset="52%" stopColor="#c9a227" />
        <stop offset="100%" stopColor="#6b4f10" />
      </radialGradient>
      <radialGradient id="coneMetal" cx="42%" cy="36%" r="70%">
        <stop offset="0%" stopColor="#3b2c0d" />
        <stop offset="60%" stopColor="#241a06" />
        <stop offset="100%" stopColor="#120c03" />
      </radialGradient>
      <filter id="numSh" x="-40%" y="-40%" width="180%" height="180%">
        <feDropShadow dx="0" dy="0.35" stdDeviation="0.35" floodColor="#000" floodOpacity="0.8" />
      </filter>
    </defs>

    {/* polished wooden rim + chrome ring */}
    <circle cx="110" cy="110" r="109" fill="url(#rimWood)" />
    <circle cx="110" cy="110" r="105" fill="none" stroke="#f0d488" strokeWidth="1.6" opacity="0.9" />
    <circle cx="110" cy="110" r="102" fill="none" stroke="#2e2109" strokeWidth="2" />

    {/* recessed ball track */}
    <circle cx="110" cy="110" r="99" fill="url(#trackWell)" />
    <circle cx="110" cy="110" r="99" fill="none" stroke="#000" strokeWidth="2.5" opacity="0.55" />
    <circle cx="110" cy="110" r="94" fill="none" stroke="#e8c86a" strokeWidth="0.6" opacity="0.45" />

    {/* deflector diamonds */}
    {[22.5, 67.5, 112.5, 157.5, 202.5, 247.5, 292.5, 337.5].map((a) => {
      const [dx, dy] = polar(110, 110, 96, a);
      return <rect key={a} x={dx - 2.2} y={dy - 2.2} width="4.4" height="4.4" rx="1" transform={`rotate(${a} ${dx} ${dy})`} fill="url(#hubMetal)" stroke="#2e2109" strokeWidth="0.4" />;
    })}

    {/* number pockets — deep casino colours */}
    {EURO_ORDER.map((n, i) => {
      const a0 = i * SEG - SEG / 2;
      const a1 = a0 + SEG;
      const fill = n === 0 ? "#0b7a3b" : RED.has(n) ? "#b0121c" : "#0e1015";
      const mid = i * SEG;
      const [tx, ty] = polar(110, 110, 83, mid);
      return (
        <g key={n}>
          <path d={wedgePath(110, 110, 52, 92, a0, a1)} fill={fill} />
          <text
            x={tx}
            y={ty}
            fill="#f7f2e4"
            fontSize="8.4"
            fontWeight="700"
            textAnchor="middle"
            dominantBaseline="central"
            transform={`rotate(${mid}, ${tx}, ${ty})`}
            filter="url(#numSh)"
          >
            {n}
          </text>
        </g>
      );
    })}

    {/* metallic frets separating every pocket */}
    {EURO_ORDER.map((_, i) => {
      const a = i * SEG - SEG / 2;
      const [x0, y0] = polar(110, 110, 52, a);
      const [x1, y1] = polar(110, 110, 92, a);
      return <line key={`fr-${i}`} x1={x0} y1={y0} x2={x1} y2={y1} stroke="url(#fret)" strokeWidth="1.1" strokeLinecap="round" />;
    })}
    <circle cx="110" cy="110" r="92" fill="none" stroke="#e8c86a" strokeWidth="0.8" opacity="0.55" />
    <circle cx="110" cy="110" r="52" fill="none" stroke="#e8c86a" strokeWidth="0.8" opacity="0.55" />

    {/* metallic cone centre */}
    <circle cx="110" cy="110" r="52" fill="url(#coneMetal)" stroke="#c9a227" strokeWidth="1.3" />
    <circle cx="110" cy="110" r="38" fill="url(#coneMetal)" />
    {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => {
      const [x1, y1] = polar(110, 110, 24, a);
      const [x2, y2] = polar(110, 110, 50, a);
      return <line key={a} x1={x1} y1={y1} x2={x2} y2={y2} stroke="url(#fret)" strokeWidth="1.8" opacity="0.85" />;
    })}
    <circle cx="110" cy="110" r="24" fill="url(#coneMetal)" stroke="#c9a227" strokeWidth="0.9" />

    {/* golden turret */}
    <circle cx="110" cy="110" r="10" fill="url(#hubMetal)" stroke="#5c440d" strokeWidth="0.5" />
    <circle cx="107" cy="107" r="3" fill="#fff4d2" opacity="0.9" />
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
  const [landed, setLanded] = useState(false);   // wheel has visually stopped this round
  const [spinMs, setSpinMs] = useState(5200);     // dynamic: syncs the spin to the server phase

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
  const spinParamsRef = useRef({ ballTurns: 6, bounceAmp: 2.6, bounceFreq: 55, dropAt: 0.55, hopStart: 0.62, hopEnd: 0.92 });
  const [spinBlur, setSpinBlur] = useState(false); // motion blur during the fast part of the spin
  const blurTimerRef = useRef(null);
  const betSeqRef = useRef(0);                    // latest bet request wins the reconcile
  const inFlightRef = useRef(0);                  // # bets awaiting the server (poll won't clobber optimistic state)
  const spinDurRef = useRef(5200);                // ball animation duration (mirrors spinMs)
  const landTimerRef = useRef(null);

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
    const DURATION = spinDurRef.current; // matches the wheel deceleration (synced to the round)
    // Per-spin randomized physics (anti-botting): the ball's revolution count,
    // deflector-bounce pattern and drop point differ every spin, so the journey
    // is never a repeatable visual loop — yet it always seats in the SAME final
    // pocket (an integer number of turns ends exactly at the top pointer).
    const pp = spinParamsRef.current;
    const TOTAL = pp.ballTurns * 360; // clockwise revolutions (opposite to the wheel)
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
      if (p > pp.dropAt) {
        const q = Math.min(1, (p - pp.dropAt) / (0.92 - pp.dropAt));
        r = R_TRACK - (R_TRACK - R_POCKET) * q;
        z = Z_TRACK - (Z_TRACK - Z_POCKET) * q;
        if (p > pp.hopStart && p < pp.hopEnd) {
          const hop = Math.sin(p * pp.bounceFreq) * (1 - p);
          r += hop * pp.bounceAmp; // randomized deflector bounces
          z += Math.abs(hop) * 5; // little vertical hops
        }
      }
      if (ballRef.current) ballRef.current.style.transform = `rotate(${ang}deg) translateY(-${r}px) translateZ(${z}px)`;
      if (p < 1) {
        ballAnimRef.current = requestAnimationFrame(frame);
      } else {
        sfx.ballLand();
        // NOTE: the reveal itself is fired by the land timer in spinTo (dur + settle
        // buffer) so the number never appears until the wheel has fully come to rest.
      }
    };
    ballAnimRef.current = requestAnimationFrame(frame);
  }, []);

  const spinTo = useCallback(
    (winning, durMs) => {
      const idx = EURO_ORDER.indexOf(winning);
      if (idx < 0) return;
      // long, dramatic spin — clamp raised so the full 10s server spin plays out
      const dur = Math.max(2600, Math.min(10500, durMs || 9500));
      spinDurRef.current = dur;
      setSpinMs(dur);
      setLanded(false);
      // Randomized per-spin physics (variable wheel speed Wv + ball launch Bv +
      // bounce jitter). Integer turn counts keep the exact landing pocket, but the
      // journey is unique every time — no visual loop for bots to lock onto.
      const wheelTurns = 5 + Math.floor(Math.random() * 5); // 5..9 CCW turns
      spinParamsRef.current = {
        ballTurns: 7 + Math.floor(Math.random() * 5), // 7..11 CW revolutions (Bv)
        bounceAmp: 2.0 + Math.random() * 1.8, // deflector kick strength
        bounceFreq: 42 + Math.random() * 28, // bounce cadence
        dropAt: 0.5 + Math.random() * 0.12, // when the ball spirals off the track
        hopStart: 0.6 + Math.random() * 0.05,
        hopEnd: 0.9 + Math.random() * 0.04,
      };
      const prev = wheelRotRef.current;
      const targetMod = (360 - idx * SEG) % 360;
      // counterclockwise: randomized full turns (Wv), ending with the winning pocket at the top
      const delta = wheelTurns * 360 + (((((prev % 360) + 360) % 360) - targetMod + 360) % 360);
      const next = prev - delta;
      wheelRotRef.current = next;
      setSpinningAnim(true);
      // motion blur while the wheel is at speed, easing off over the first ~55%
      setSpinBlur(true);
      clearTimeout(blurTimerRef.current);
      blurTimerRef.current = setTimeout(() => setSpinBlur(false), dur * 0.55);
      // cinematic camera: dolly in for the spin, pull back once the ball lands
      setCameraZoom(true);
      clearTimeout(camTimerRef.current);
      camTimerRef.current = setTimeout(() => setCameraZoom(false), dur + 400);
      setWheelRot(next);
      sfx.ballSpin();
      animateBall();
      // reveal the number a clear beat AFTER the wheel's transition fully settles,
      // so it can never flash while the wheel is still visibly moving.
      clearTimeout(landTimerRef.current);
      landTimerRef.current = setTimeout(() => setLanded(true), dur + 300);
    },
    [animateBall]
  );

  const applyState = useCallback(
    (data) => {
      stateRef.current = data;
      // While a bet is awaiting the server, keep the optimistic bets/balance so a
      // poll landing mid-request can't make the just-placed chip flicker away.
      setState((prev) =>
        inFlightRef.current > 0 && prev
          ? { ...data, my_bets: prev.my_bets, my_total: prev.my_total }
          : data
      );
      if (inFlightRef.current === 0) setBalance(data.balance);
      deadlineRef.current = Date.now() + data.phase_ends_in * 1000;

      if (data.my_bets && data.my_bets.length > 0) lastBetsRef.current = data.my_bets;

      // Trigger the wheel animation once per round. Sync its duration to the time
      // left in the server SPIN phase so the ball lands exactly as the phase ends;
      // the number is revealed only after the wheel has visually stopped (landed).
      if (data.phase !== "BETTING" && data.winning_number != null && spunRoundRef.current !== data.round_number) {
        spunRoundRef.current = data.round_number;
        const durMs = data.phase === "SPINNING" ? Math.round((data.phase_ends_in || 0) * 1000) : 2600;
        setResult(null);
        spinTo(data.winning_number, durMs);
      }
      if (data.phase === "BETTING") {
        setSpinningAnim(false);
        setCameraZoom(false);
        setLanded(false);
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
    pollRef.current = setInterval(poll, 1000);
    tickRef.current = setInterval(() => {
      setCountdown(Math.max(0, (deadlineRef.current - Date.now()) / 1000));
    }, 100);
    return () => {
      clearInterval(pollRef.current);
      clearInterval(tickRef.current);
      clearTimeout(camTimerRef.current);
      clearTimeout(landTimerRef.current);
      clearTimeout(blurTimerRef.current);
      cancelAnimationFrame(ballAnimRef.current);
    };
  }, [poll, loadHistory]);

  // Optimistic: the chip and sound land instantly on tap; the server response
  // reconciles the authoritative totals a moment later. Rapid taps are never
  // dropped — only the latest request's response is applied (the backend is
  // cumulative, so it always carries every bet).
  const placeBet = (bet_type, value, amt) => {
    if (!state || state.phase !== "BETTING") {
      toast.info("Bets are closed — wait for the next round");
      return;
    }
    const amount = amt || chip;
    sfx.chip();
    setBalance((b) => (b == null ? b : b - amount));
    setState((s) =>
      s
        ? {
            ...s,
            my_bets: [...(s.my_bets || []), { bet_type, value, amount }],
            my_total: (s.my_total || 0) + amount,
          }
        : s
    );
    const seq = ++betSeqRef.current;
    inFlightRef.current += 1;
    api
      .post("/games/fun-roulette/bets", { bet_type, value, amount })
      .then(({ data }) => {
        if (seq !== betSeqRef.current) return; // a newer tap already owns the truth
        setState((s) => (s ? { ...s, my_bets: data.my_bets, my_total: data.my_total } : s));
        setBalance(data.balance);
        lastBetsRef.current = data.my_bets;
      })
      .catch((e) => {
        toast.error(errMsg(e));
        poll(); // reconcile to server truth on failure
      })
      .finally(() => {
        inFlightRef.current = Math.max(0, inFlightRef.current - 1);
      });
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

  const undoBet = async () => {
    try {
      const { data } = await api.post("/games/fun-roulette/bets/undo");
      setBalance(data.balance);
      setState((s) => (s ? { ...s, my_bets: data.my_bets, my_total: data.my_total } : s));
      sfx.chip();
      if (data.refunded > 0) toast.success(`Undid last chip — ${formatChips(data.refunded)} back`);
    } catch (e) {
      toast.error(errMsg(e));
    }
  };

  const rebet = () => {
    const bets = lastBetsRef.current;
    if (!bets.length) return;
    bets.forEach((b) => placeBet(b.bet_type, b.value, b.amount));
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
            {betting ? "PLACE YOUR BETS" : state?.phase === "SPINNING" && !landed ? "NO MORE BETS" : "RESULT"}
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
                  transition: spinningAnim ? `transform ${spinMs}ms cubic-bezier(0.12, 0.8, 0.2, 1)` : "none",
                  willChange: "transform",
                }}
              >
                {/* motion blur on the 2D number face only (keeps the 3D turret crisp) */}
                <div style={{ filter: spinBlur ? "blur(1.4px)" : "blur(0)", transition: "filter 500ms ease-out", height: "100%", width: "100%" }}>
                  <WheelSVG />
                </div>
                <Turret3D />
              </div>
              {/* fixed ambient light + rim vignette — stays put while the wheel spins,
                  so the highlight reads like real light instead of a flat cartoon fill */}
              <div
                aria-hidden="true"
                className="absolute inset-0 rounded-full pointer-events-none"
                style={{
                  transform: "translateZ(3px)",
                  background:
                    "radial-gradient(58% 48% at 50% 22%, rgba(255,246,220,0.30), rgba(255,255,255,0.05) 40%, rgba(0,0,0,0) 64%, rgba(0,0,0,0.42) 100%)",
                }}
              />
              {/* pearl ball — launched clockwise, spirals down into the winning pocket */}
              <div className="absolute inset-0 pointer-events-none flex items-center justify-center" style={{ transformStyle: "preserve-3d" }}>
                <div
                  ref={ballRef}
                  className="h-3.5 w-3.5 rounded-full shadow-[0_2px_4px_rgba(0,0,0,0.55),0_0_8px_rgba(255,255,255,0.8),inset_-1px_-1.5px_2px_rgba(0,0,0,0.28),inset_1px_1px_1.5px_rgba(255,255,255,0.9)]"
                  style={{
                    transform: "rotate(0deg) translateY(-75px) translateZ(5px)",
                    background: "radial-gradient(circle at 35% 30%, #ffffff, #eae7dd 68%, #c9c4b6)",
                  }}
                />
              </div>
            </div>
          </div>
          {/* landed number — shown only after the wheel has visually stopped */}
          {!betting && winning != null && landed && (
            <div className="absolute inset-0 z-20 flex items-center justify-center">
              <ResultDot n={winning} big />
            </div>
          )}
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
      </div>

      {/* Chip selector + actions */}
      <div className="rounded-2xl bg-card/55 border border-white/10 p-4 space-y-3" data-testid="roulette-chip-tray">
        <div className="flex items-center justify-end">
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
            <Repeat className="h-3.5 w-3.5" /> Repeat
          </button>
          <button
            data-testid="roulette-undo-bet"
            onClick={undoBet}
            disabled={!betting || (state?.my_bets || []).length === 0}
            className="h-10 px-3 rounded-xl border border-white/15 bg-white/5 hover:bg-white/10 text-xs font-bold text-white/75 disabled:opacity-40 flex items-center gap-1.5"
          >
            <Undo2 className="h-3.5 w-3.5" /> Undo
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
      </div>
    </PlayShell>
  );
}
