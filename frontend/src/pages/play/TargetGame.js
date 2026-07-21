import { useState, useEffect, useRef } from "react";
import { useLiveRound } from "@/lib/useLiveRound";
import { sfx } from "@/lib/sound";
import { HistoryStrip } from "@/components/play/PlayShell";
import { LiveBetPanel, LastResults, ResultPill } from "@/components/play/LiveBar";
import { ResultBanner } from "@/components/play/ResultBanner";
import { GameStage } from "@/components/play/GameStage";
import { CoinShower, WinBurst } from "@/pages/play/slots/slotFx";
import { formatChips } from "@/components/common";

const SEG = 36; // 10 numbers → 36° each
const COLORS = ["#c42130", "#15181f"]; // dartboard red/black alternating
const polar = (cx, cy, r, deg) => {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
};
const wedge = (cx, cy, r0, r1, a0, a1) => {
  const [x0, y0] = polar(cx, cy, r1, a0);
  const [x1, y1] = polar(cx, cy, r1, a1);
  const [x2, y2] = polar(cx, cy, r0, a1);
  const [x3, y3] = polar(cx, cy, r0, a0);
  return `M ${x0} ${y0} A ${r1} ${r1} 0 0 1 ${x1} ${y1} L ${x2} ${y2} A ${r0} ${r0} 0 0 0 ${x3} ${y3} Z`;
};

// Static target face (0..9), rotates as a unit. Winning wedge lights up.
const TargetFace = ({ landedNum }) => (
  <svg viewBox="0 0 200 200" className="w-full h-full">
    <circle cx="100" cy="100" r="97" fill="none" stroke="#c9a227" strokeWidth="4" />
    <circle cx="100" cy="100" r="93" fill="#0b0f18" />
    {Array.from({ length: 10 }, (_, n) => {
      const a0 = n * SEG - SEG / 2;
      const mid = n * SEG;
      const [tx, ty] = polar(100, 100, 66, mid);
      const win = landedNum === n;
      return (
        <g key={n}>
          <path d={wedge(100, 100, 30, 92, a0, a0 + SEG)} fill={win ? "#ffd447" : COLORS[n % 2]} stroke="#e8c86a" strokeWidth="0.8" opacity={win ? 1 : 0.95} style={win ? { filter: "brightness(1.4)" } : undefined} />
          <text x={tx} y={ty} fill={win ? "#3a2a00" : "#fff"} fontSize="15" fontWeight="800" textAnchor="middle" dominantBaseline="central" transform={`rotate(${mid}, ${tx}, ${ty})`}>{n}</text>
        </g>
      );
    })}
    {/* bullseye hub */}
    <circle cx="100" cy="100" r="30" fill="url(#tgHub)" stroke="#c9a227" strokeWidth="1.5" />
    <circle cx="100" cy="100" r="14" fill="#c42130" stroke="#7a0f18" strokeWidth="1.5" />
    <circle cx="100" cy="100" r="6" fill="#ffd447" />
    <defs>
      <radialGradient id="tgHub" cx="42%" cy="34%" r="70%">
        <stop offset="0%" stopColor="#fff4cf" /><stop offset="55%" stopColor="#d8b34a" /><stop offset="100%" stopColor="#8a6a14" />
      </radialGradient>
    </defs>
  </svg>
);

export default function TargetGame({ game }) {
  const { state, countdown, balance, betting, phase, outcome, result, history, placeBet, clearBets, myBets, myTotal, lastResults, placing } =
    useLiveRound(game.slug, {
      formatResult: (s) => ({
        title: s.payout > 0 ? "★ BULLSEYE! 7× ★" : "Missed",
        subtitle: `The target landed on ${s.outcome.result}`,
        big: s.payout > 0,
      }),
    });
  const [pick, setPick] = useState(null);
  const [amount, setAmount] = useState(50);
  const [rot, setRot] = useState(0);
  const [spinning, setSpinning] = useState(false);
  const [blur, setBlur] = useState(false);
  const [landedNum, setLandedNum] = useState(null);
  const rotRef = useRef(0);
  const spunRef = useRef(null);
  const landTimerRef = useRef(null);
  const blurTimerRef = useRef(null);
  const roundNo = state?.round_number;

  useEffect(() => {
    if (phase === "BETTING") { setSpinning(false); setLandedNum(null); return; }
    if (!outcome || outcome.result == null || spunRef.current === roundNo) return;
    spunRef.current = roundNo;
    const num = outcome.result;
    const a = num * SEG; // wedge centre
    const targetMod = (((-a) % 360) + 360) % 360;
    const prev = rotRef.current;
    const prevMod = ((prev % 360) + 360) % 360;
    let delta = targetMod - prevMod;
    if (delta <= 0) delta += 360;
    delta += 360 * (5 + Math.floor(Math.random() * 4));
    const next = prev + delta;
    rotRef.current = next;
    const dur = Math.max(2.4, (state?.timings?.reveal || 4) - 0.3);
    setSpinning(true); setRot(next); setBlur(true);
    sfx.ballSpin ? sfx.ballSpin() : (sfx.spin && sfx.spin());
    clearTimeout(blurTimerRef.current);
    blurTimerRef.current = setTimeout(() => setBlur(false), dur * 1000 * 0.55);
    clearTimeout(landTimerRef.current);
    landTimerRef.current = setTimeout(() => {
      setSpinning(false); setLandedNum(num);
      sfx.reelStop && sfx.reelStop();
      if (navigator.vibrate) navigator.vibrate(45);
    }, dur * 1000 + 150);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, outcome, roundNo]);

  useEffect(() => () => { clearTimeout(landTimerRef.current); clearTimeout(blurTimerRef.current); }, []);

  const landed = landedNum != null;
  const isWin = landed && result && result.win;
  const spinDur = Math.max(2.4, (state?.timings?.reveal || 4) - 0.3);
  const pickTotals = {};
  myBets.forEach((b) => { pickTotals[b.selection] = (pickTotals[b.selection] || 0) + b.amount; });

  return (
    <GameStage
      game={game}
      balance={balance}
      live={{ phase, countdown, timings: state?.timings, roundNumber: roundNo }}
      labels={{ REVEAL: "FIRING…" }}
      betDock={
        <div className="space-y-2">
          <div className="grid grid-cols-5 gap-2">
            {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
              <button key={n} data-testid={`target-pick-${n}`} onClick={() => setPick(n)} disabled={!betting}
                className={`relative rounded-xl border py-3 min-h-[48px] font-display text-xl transition-[background-color,border-color] duration-150 ${pick === n ? "bg-primary/15 border-primary/50 text-primary" : "bg-white/5 border-white/10 text-white/80 hover:bg-white/10"} ${!betting ? "opacity-70" : ""}`}>
                {n}
                {pickTotals[n] > 0 && (
                  <span className="absolute -top-1.5 -right-1.5 h-5 min-w-5 px-1 rounded-full bg-primary text-primary-foreground text-[9px] font-extrabold flex items-center justify-center border border-yellow-200 shadow tabular-nums">{formatChips(pickTotals[n])}</span>
                )}
              </button>
            ))}
          </div>
          <LiveBetPanel amount={amount} setAmount={setAmount} onPlace={() => pick !== null && placeBet(pick, amount)} betting={betting} placing={placing} disabled={pick === null} label={pick === null ? "Pick a number first" : `Fire at ${pick}`} myTotal={myTotal} />
          {betting && myBets.length > 0 && (
            <button data-testid="live-clear-bets" onClick={clearBets} className="w-full text-[11px] font-bold text-red-400/85 hover:text-red-400">Clear my bets (refund)</button>
          )}
        </div>
      }
      extras={<HistoryStrip history={history} />}
    >
      <div className="rounded-2xl bg-card/55 border border-white/10 p-5 flex flex-col items-center gap-3 overflow-hidden relative">
        <div className="relative h-[240px] w-[240px]">
          <div aria-hidden className="absolute inset-0 rounded-full pointer-events-none" style={{ boxShadow: spinning ? "0 0 40px rgba(255,199,64,0.45)" : landed ? "0 0 26px rgba(255,199,64,0.3)" : "none", transition: "box-shadow 400ms" }} />
          {/* pointer */}
          <div className="absolute left-1/2 -top-1 -translate-x-1/2 z-20 w-0 h-0 border-l-[10px] border-r-[10px] border-t-[18px] border-l-transparent border-r-transparent border-t-[#ffd447] drop-shadow-[0_2px_3px_rgba(0,0,0,0.6)]" />
          <div className="absolute inset-1" style={{ transform: `rotate(${rot}deg)`, transition: spinning ? `transform ${spinDur}s cubic-bezier(0.15,0.85,0.2,1)` : "none", filter: blur ? "blur(1.2px)" : "none", willChange: "transform" }}>
            <TargetFace landedNum={landedNum} />
          </div>
          <div className="absolute inset-0 flex items-center justify-center z-10 pointer-events-none">
            {landed && <span className="font-display text-2xl" style={{ color: "#ffd447", textShadow: "0 0 10px rgba(0,0,0,0.7)" }} data-testid="target-result">{landedNum}</span>}
          </div>
          {isWin && <WinBurst mult={7} color="#ffd447" showAt={0} />}
          {isWin && <CoinShower />}
        </div>
        <p className="text-[11px] text-white/50">Exact hit pays 7× — one universal number per round</p>
        <LastResults items={lastResults} render={(r) => <ResultPill label={r.result} tone="gold" />} />
      </div>

      <ResultBanner result={result} />
    </GameStage>
  );
}
