import { useState, useEffect, useRef } from "react";
import { useLiveRound } from "@/lib/useLiveRound";
import { sfx } from "@/lib/sound";
import { HistoryStrip } from "@/components/play/PlayShell";
import { LiveBetPanel, LastResults, ResultPill } from "@/components/play/LiveBar";
import { ResultBanner } from "@/components/play/ResultBanner";
import { GameStage } from "@/components/play/GameStage";
import { CoinShower, WinBurst } from "@/pages/play/slots/slotFx";

// 24-segment wheel face — every possible multiplier appears at least once so the
// wheel can visibly land on the server's chosen result (blanks are the commonest).
const WHEEL_FACE = [0, 2, 0, 5, 0, 1.5, 3, 0, 10, 0, 1.5, 2, 0, 3, 0, 20, 1.5, 0, 5, 2, 0, 1.5, 3, 50];
const N = WHEEL_FACE.length;
const SEG = 360 / N;

// colour per multiplier tier
const segColor = (m) =>
  m === 0 ? "#161c2b" :
  m >= 50 ? "#ffd447" :
  m >= 20 ? "#e0533f" :
  m >= 10 ? "#8b5cf6" :
  m >= 5 ? "#2a7de1" :
  m >= 3 ? "#0ea5a3" : "#1f9d55";
const segText = (m) => (m >= 50 ? "#3a2a00" : "#ffffff");

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

// The wheel face (rotates as a unit). Winning wedge lights up once landed.
const WheelFace = ({ landedIdx }) => (
  <svg viewBox="0 0 240 240" className="w-full h-full">
    <defs>
      <radialGradient id="wheelHub" cx="42%" cy="34%" r="70%">
        <stop offset="0%" stopColor="#fff4cf" />
        <stop offset="55%" stopColor="#d8b34a" />
        <stop offset="100%" stopColor="#8a6a14" />
      </radialGradient>
      <filter id="wsh" x="-40%" y="-40%" width="180%" height="180%">
        <feDropShadow dx="0" dy="0.4" stdDeviation="0.5" floodColor="#000" floodOpacity="0.85" />
      </filter>
    </defs>
    {WHEEL_FACE.map((m, i) => {
      const a0 = i * SEG;
      const a1 = a0 + SEG;
      const mid = a0 + SEG / 2;
      const [tx, ty] = polar(120, 120, 86, mid);
      const win = landedIdx === i;
      return (
        <g key={i}>
          <path
            d={wedge(120, 120, 40, 116, a0, a1)}
            fill={segColor(m)}
            stroke={win ? "#fff7d6" : "rgba(0,0,0,0.35)"}
            strokeWidth={win ? 2.4 : 0.8}
            style={win ? { filter: "brightness(1.5)" } : undefined}
          />
          <text
            x={tx} y={ty}
            fill={segText(m)} fontSize={m >= 10 ? "11" : "10"} fontWeight="800"
            textAnchor="middle" dominantBaseline="central"
            transform={`rotate(${mid}, ${tx}, ${ty})`}
            filter="url(#wsh)"
          >
            {m === 0 ? "—" : `${m}x`}
          </text>
        </g>
      );
    })}
    {/* rim + hub */}
    <circle cx="120" cy="120" r="116" fill="none" stroke="#c9a227" strokeWidth="4" />
    <circle cx="120" cy="120" r="112" fill="none" stroke="#5c440d" strokeWidth="1" />
    <circle cx="120" cy="120" r="40" fill="url(#wheelHub)" stroke="#5c440d" strokeWidth="1.5" />
    <circle cx="120" cy="120" r="12" fill="url(#wheelHub)" stroke="#8a6a14" strokeWidth="1" />
  </svg>
);

export default function WheelGame({ game }) {
  const { state, countdown, balance, betting, phase, outcome, result, history, placeBet, clearBets, myTotal, lastResults, placing, myBets } =
    useLiveRound(game.slug, {
      formatResult: (s) => ({
        title: s.outcome.multiplier > 0 ? `Golden ${s.outcome.multiplier}× hit!` : "Blank — no multiplier",
        subtitle: s.outcome.multiplier > 0 ? "The wheel shines on you" : "Spin again next round for the gold",
        big: s.outcome.multiplier >= 10,
      }),
    });
  const [amount, setAmount] = useState(50);
  const [rot, setRot] = useState(0);
  const [spinning, setSpinning] = useState(false);
  const [blur, setBlur] = useState(false);
  const [landedIdx, setLandedIdx] = useState(null);
  const rotRef = useRef(0);
  const spunRoundRef = useRef(null);
  const landTimerRef = useRef(null);
  const blurTimerRef = useRef(null);
  const roundNo = state?.round_number;

  // Trigger one dramatic, decelerating spin per round that LANDS on the winning
  // segment; the multiplier is only revealed after the wheel has fully stopped.
  useEffect(() => {
    if (phase === "BETTING") {
      setSpinning(false);
      setLandedIdx(null);
      return;
    }
    if (outcome == null || outcome.multiplier == null || spunRoundRef.current === roundNo) return;
    spunRoundRef.current = roundNo;

    const mult = outcome.multiplier;
    const matches = WHEEL_FACE.map((m, i) => (m === mult ? i : -1)).filter((i) => i >= 0);
    const idx = matches.length ? matches[roundNo % matches.length] : 0;

    // land the winning wedge centre under the top pointer, after several turns
    const a = idx * SEG + SEG / 2;
    const targetMod = (((-a) % 360) + 360) % 360;
    const prev = rotRef.current;
    const prevMod = ((prev % 360) + 360) % 360;
    let delta = targetMod - prevMod;
    if (delta <= 0) delta += 360;
    const spins = 5 + Math.floor(Math.random() * 4); // 5–8 full turns
    delta += 360 * spins;
    const next = prev + delta;
    rotRef.current = next;

    const dur = Math.max(2.6, (state?.timings?.reveal || 5) - 0.2);
    setSpinning(true);
    setRot(next);
    setBlur(true);
    sfx.luckySpin && sfx.luckySpin();
    clearTimeout(blurTimerRef.current);
    blurTimerRef.current = setTimeout(() => setBlur(false), dur * 1000 * 0.55);
    clearTimeout(landTimerRef.current);
    landTimerRef.current = setTimeout(() => {
      setSpinning(false);
      setLandedIdx(idx);
      (mult >= 10 ? sfx.slotBell : sfx.reelStop) && (mult >= 10 ? sfx.slotBell() : sfx.reelStop());
    }, dur * 1000 + 120);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, outcome, roundNo]);

  useEffect(() => () => { clearTimeout(landTimerRef.current); clearTimeout(blurTimerRef.current); }, []);

  const landedMult = landedIdx != null ? WHEEL_FACE[landedIdx] : null;
  const isWin = result && result.win;
  const spinDur = Math.max(2.6, (state?.timings?.reveal || 5) - 0.2);

  return (
    <GameStage
      game={game}
      balance={balance}
      live={{ phase, countdown, timings: state?.timings, roundNumber: state?.round_number }}
      labels={{ REVEAL: "SPINNING…" }}
      betDock={
        <div className="space-y-2">
          <LiveBetPanel
            amount={amount}
            setAmount={setAmount}
            onPlace={() => placeBet(null, amount)}
            betting={betting}
            placing={placing}
            label="Join this spin"
            myTotal={myTotal}
            hint="One universal wheel spin per round — your stake pays the landed multiplier"
          />
          {betting && myBets.length > 0 && (
            <button data-testid="live-clear-bets" onClick={clearBets} className="w-full text-[11px] font-bold text-red-400/85 hover:text-red-400">
              Clear my bets (refund)
            </button>
          )}
        </div>
      }
      extras={<HistoryStrip history={history} />}
    >
      <div className="rounded-2xl bg-card/55 border border-white/10 p-5 flex flex-col items-center gap-3 overflow-hidden relative">
        {/* wheel stage */}
        <div className="relative h-[248px] w-[248px]" data-testid="wheel-stage">
          {/* glow */}
          <div
            aria-hidden="true"
            className="absolute inset-0 rounded-full pointer-events-none"
            style={{ boxShadow: spinning ? "0 0 44px rgba(255,199,64,0.5)" : landedMult ? "0 0 30px rgba(255,199,64,0.35)" : "0 0 18px rgba(255,199,64,0.15)", transition: "box-shadow 400ms" }}
          />
          {/* blinking rim bulbs */}
          {Array.from({ length: 16 }, (_, i) => {
            const [bx, by] = polar(124, 124, 121, i * (360 / 16));
            return (
              <span
                key={i}
                aria-hidden="true"
                className="absolute h-2 w-2 rounded-full"
                style={{
                  left: bx, top: by, marginLeft: -4, marginTop: -4,
                  background: "radial-gradient(circle at 40% 35%, #fff3c0, #ffce54 55%, #a9801e)",
                  boxShadow: "0 0 6px rgba(255,206,84,0.9)",
                  animation: `fg-bulb-blink ${spinning ? 0.4 : 1.1}s ease-in-out ${i * 0.07}s infinite`,
                }}
              />
            );
          })}
          {/* rotating wheel face */}
          <div
            className="absolute inset-2"
            style={{
              transform: `rotate(${rot}deg)`,
              transition: spinning ? `transform ${spinDur}s cubic-bezier(0.15, 0.85, 0.2, 1)` : "none",
              filter: blur ? "blur(1.3px)" : "blur(0)",
              willChange: "transform",
            }}
            data-testid="wheel-face"
          >
            <WheelFace landedIdx={landedIdx} />
          </div>
          {/* fixed pointer/flapper at top */}
          <div className="absolute left-1/2 -top-0.5 -translate-x-1/2 z-20" aria-hidden="true">
            <div className="w-0 h-0 border-l-[10px] border-r-[10px] border-t-[18px] border-l-transparent border-r-transparent border-t-[#ffd447] drop-shadow-[0_2px_3px_rgba(0,0,0,0.6)]" />
          </div>
          {/* centre readout */}
          <div className="absolute inset-0 flex items-center justify-center z-10 pointer-events-none">
            <span className="font-display text-2xl" style={{ color: landedMult ? "#ffd447" : "#ffe08a" }} data-testid="wheel-result">
              {spinning ? "" : landedMult != null ? (landedMult === 0 ? "—" : `${landedMult}×`) : "SPIN"}
            </span>
          </div>
          {/* win effects */}
          {landedMult != null && landedMult > 0 && <WinBurst mult={landedMult} color="#ffd447" showAt={10} />}
          {isWin && <CoinShower />}
        </div>

        {/* paytable chips */}
        <div className="flex flex-wrap justify-center gap-1.5">
          {[1.5, 2, 3, 5, 10, 20, 50].map((m) => (
            <span key={m} className={`rounded-full border px-2.5 py-1 text-[10px] font-bold tabular-nums ${landedMult === m ? "fg-neon" : "text-white/55"}`}
              style={{ borderColor: segColor(m) + "88", background: landedMult === m ? segColor(m) : "rgba(255,255,255,0.04)", color: landedMult === m ? segText(m) : undefined }}>
              {m}×
            </span>
          ))}
        </div>
        <LastResults items={lastResults} render={(r) => <ResultPill label={r.multiplier > 0 ? `${r.multiplier}×` : "—"} tone={r.multiplier >= 10 ? "gold" : r.multiplier > 0 ? "emerald" : "neutral"} />} />
      </div>

      <ResultBanner result={result} />
    </GameStage>
  );
}
