import { useState, useEffect, useRef, useCallback } from "react";
import { toast } from "sonner";
import { Timer, RotateCcw, Repeat } from "lucide-react";
import { api, errMsg } from "@/lib/api";
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

const numColor = (n) => (n === 0 ? "green" : RED.has(n) ? "red" : "black");
const cellBg = (n) =>
  n === 0
    ? "bg-[#0a7a3c] hover:bg-[#0c8a44] border-[#12a355]/60"
    : RED.has(n)
    ? "bg-[#b3282d] hover:bg-[#c22f35] border-[#e05a5f]/50"
    : "bg-[#15181f] hover:bg-[#20242e] border-white/25";

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
    <circle cx="110" cy="110" r="108" fill="#3a2a08" />
    <circle cx="110" cy="110" r="103" fill="none" stroke="#c9a227" strokeWidth="3" />
    {EURO_ORDER.map((n, i) => {
      const a0 = i * SEG - SEG / 2;
      const a1 = a0 + SEG;
      const fill = n === 0 ? "#0a7a3c" : RED.has(n) ? "#b3282d" : "#15181f";
      const mid = i * SEG;
      const [tx, ty] = polar(110, 110, 88, mid);
      return (
        <g key={n}>
          <path d={wedgePath(110, 110, 58, 100, a0, a1)} fill={fill} stroke="#c9a227" strokeWidth="0.6" />
          <text
            x={tx}
            y={ty}
            fill="#fff"
            fontSize="8.5"
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
    <circle cx="110" cy="110" r="58" fill="#1a1408" stroke="#c9a227" strokeWidth="1.5" />
    <circle cx="110" cy="110" r="30" fill="#2b2005" stroke="#c9a227" strokeWidth="1" />
    {[0, 90, 180, 270].map((a) => {
      const [x1, y1] = polar(110, 110, 30, a);
      const [x2, y2] = polar(110, 110, 56, a);
      return <line key={a} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#c9a227" strokeWidth="2.5" />;
    })}
    <circle cx="110" cy="110" r="7" fill="#c9a227" />
  </svg>
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

export default function RouletteGame({ game }) {
  const [state, setState] = useState(null);
  const [balance, setBalance] = useState(null);
  const [chip, setChip] = useState(100);
  const [countdown, setCountdown] = useState(0);
  const [wheelRot, setWheelRot] = useState(0);
  const [ballRot, setBallRot] = useState(0);
  const [spinningAnim, setSpinningAnim] = useState(false);
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

  const loadHistory = useCallback(async () => {
    try {
      const { data } = await api.get("/games/fun-roulette/history");
      setHistory(data.rounds || []);
    } catch (e) {
      /* silent */
    }
  }, []);

  const spinTo = useCallback((winning) => {
    const idx = EURO_ORDER.indexOf(winning);
    if (idx < 0) return;
    const prev = wheelRotRef.current;
    const targetMod = (360 - idx * SEG) % 360;
    const delta = 4 * 360 + ((targetMod - ((prev % 360) + 360) % 360) + 360) % 360;
    const next = prev + delta;
    wheelRotRef.current = next;
    setSpinningAnim(true);
    setWheelRot(next);
    setBallRot((b) => b - 3 * 360);
  }, []);

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

  const SpotChip = ({ k }) =>
    spotTotals[k] ? (
      <span className="absolute -top-1.5 -right-1.5 z-10 h-6 min-w-6 px-1 rounded-full bg-primary text-primary-foreground text-[9px] font-extrabold flex items-center justify-center border-2 border-yellow-200 shadow-md tabular-nums">
        {spotTotals[k] >= 1000 ? `${spotTotals[k] / 1000}k` : spotTotals[k]}
      </span>
    ) : null;

  const Cell = ({ type, value, label, className = "", testId }) => (
    <button
      data-testid={testId || `roulette-cell-${type}-${value}`}
      onClick={() => placeBet(type, value)}
      disabled={!betting}
      className={`relative rounded-md border font-bold transition-[filter] duration-100 ${betting ? "hover:brightness-125 active:scale-[0.97]" : "opacity-80"} ${className}`}
    >
      {label}
      <SpotChip k={`${type}:${value}`} />
    </button>
  );

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
            style={{ width: `${Math.min(100, (countdown / (state?.betting_seconds || 17)) * 100)}%` }}
          />
        </div>
      )}

      {/* Wheel */}
      <div className="rounded-2xl bg-card/55 border border-white/10 p-4 flex flex-col items-center gap-3">
        <div className="relative h-[200px] w-[200px]" data-testid="roulette-wheel">
          {/* pointer */}
          <div className="absolute left-1/2 -top-1 -translate-x-1/2 z-20 w-0 h-0 border-l-[7px] border-r-[7px] border-t-[11px] border-l-transparent border-r-transparent border-t-primary drop-shadow" />
          {/* wheel */}
          <div
            className="absolute inset-0"
            style={{ transform: `rotate(${wheelRot}deg)`, transition: spinningAnim ? "transform 4.2s cubic-bezier(0.12, 0.8, 0.2, 1)" : "none" }}
          >
            <WheelSVG />
          </div>
          {/* white ball orbit */}
          <div
            className="absolute inset-0 z-10 pointer-events-none"
            style={{ transform: `rotate(${ballRot}deg)`, transition: spinningAnim ? "transform 4.2s cubic-bezier(0.22, 0.9, 0.3, 1)" : "none" }}
          >
            <div className="absolute left-1/2 top-[22px] -translate-x-1/2 h-3.5 w-3.5 rounded-full bg-white shadow-[0_0_8px_rgba(255,255,255,0.9)]" />
          </div>
          {/* landed number */}
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

      {/* Green felt board */}
      <div className="rounded-2xl border-2 border-[#c9a227]/50 p-3 space-y-1.5" style={{ background: "radial-gradient(140% 120% at 50% 0%, #0d6b36 0%, #094d27 55%, #073d1f 100%)" }} data-testid="roulette-board">
        {/* zero */}
        <Cell type="straight" value={0} label="0" className={`w-full py-3 min-h-[44px] text-white text-lg ${cellBg(0)} ${isResult && winning === 0 ? "ring-2 ring-primary" : ""}`} testId="roulette-cell-straight-0" />
        {/* numbers 1-36 */}
        <div className="grid grid-cols-3 gap-1.5">
          {Array.from({ length: 36 }, (_, i) => i + 1).map((n) => (
            <Cell
              key={n}
              type="straight"
              value={n}
              label={n}
              className={`py-2.5 min-h-[40px] text-white text-base tabular-nums ${cellBg(n)} ${isResult && winning === n ? "ring-2 ring-primary" : ""}`}
            />
          ))}
        </div>
        {/* column bets */}
        <div className="grid grid-cols-3 gap-1.5">
          {[1, 2, 3].map((c) => (
            <Cell key={c} type="column" value={c} label="2 : 1" className="py-2 min-h-[38px] text-[11px] text-[#ffe08a] bg-[#0a5c2d] border-[#c9a227]/40" />
          ))}
        </div>
        {/* dozens */}
        <div className="grid grid-cols-3 gap-1.5">
          {[1, 2, 3].map((d) => (
            <Cell key={d} type="dozen" value={d} label={d === 1 ? "1st 12" : d === 2 ? "2nd 12" : "3rd 12"} className="py-2.5 min-h-[40px] text-xs text-[#ffe08a] bg-[#0a5c2d] border-[#c9a227]/40" />
          ))}
        </div>
        {/* outside bets */}
        <div className="grid grid-cols-6 gap-1.5">
          <Cell type="range" value="low" label="1-18" className="py-2.5 min-h-[40px] text-[10px] text-[#ffe08a] bg-[#0a5c2d] border-[#c9a227]/40" />
          <Cell type="parity" value="even" label="EVEN" className="py-2.5 min-h-[40px] text-[10px] text-[#ffe08a] bg-[#0a5c2d] border-[#c9a227]/40" />
          <Cell type="color" value="red" label="RED" className="py-2.5 min-h-[40px] text-[10px] text-white bg-[#b3282d] border-[#e05a5f]/50" />
          <Cell type="color" value="black" label="BLACK" className="py-2.5 min-h-[40px] text-[10px] text-white bg-[#15181f] border-white/25" />
          <Cell type="parity" value="odd" label="ODD" className="py-2.5 min-h-[40px] text-[10px] text-[#ffe08a] bg-[#0a5c2d] border-[#c9a227]/40" />
          <Cell type="range" value="high" label="19-36" className="py-2.5 min-h-[40px] text-[10px] text-[#ffe08a] bg-[#0a5c2d] border-[#c9a227]/40" />
        </div>
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
        <p className="text-[11px] text-white/40">Straight 36x · Dozen/Column 3x · Red/Black/Odd/Even/1-18/19-36 2x · Live rounds every 25s, synced worldwide</p>
      </div>

      <HistoryStrip history={history} />
    </PlayShell>
  );
}

// Ball/wheel animation lasts ~4.2s of the 5s spin phase; show the landed number
// once the spin phase is nearly over or during the result phase.
function spinningAnimActive(countdown, state) {
  if (!state) return false;
  if (state.phase === "SPINNING") return countdown > 0.6;
  return false;
}
