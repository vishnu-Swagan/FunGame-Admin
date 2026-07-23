import { useState, useEffect, useRef } from "react";
import { Flame } from "lucide-react";
import { useLiveRound } from "@/lib/useLiveRound";
import { sfx } from "@/lib/sound";
import { HistoryStrip } from "@/components/play/PlayShell";
import { LiveBetPanel } from "@/components/play/LiveBar";
import { ResultBanner } from "@/components/play/ResultBanner";
import { GameStage } from "@/components/play/GameStage";
import { CoinShower, WinBurst } from "@/pages/play/slots/slotFx";
import { SlotSymbol } from "@/pages/play/slots/SlotSymbols";

const SYM = {
  cherry: { color: "#ff5964" },
  lemon: { color: "#ffd447" },
  bell: { color: "#ffb347" },
  star: { color: "#ffe08a" },
  seven: { color: "#ff4f9a" },
  joker: { color: "#c084fc", tag: "WILD" },
};
const IDS = Object.keys(SYM);
const GJ_LINES = [
  [1, 1, 1, 1, 1], [0, 0, 0, 0, 0], [2, 2, 2, 2, 2],
  [0, 1, 2, 1, 0], [2, 1, 0, 1, 2],
  [0, 0, 1, 2, 2], [2, 2, 1, 0, 0],
  [1, 0, 0, 0, 1], [1, 2, 2, 2, 1], [1, 2, 1, 0, 1],
];

const Sym = ({ id, size = 26, win }) => <SlotSymbol id={id} size={size * 1.35} win={win} />;

const Bulbs = ({ live, n = 13 }) => (
  <div className="flex justify-between px-1" aria-hidden="true">
    {Array.from({ length: n }, (_, i) => (
      <span key={i} className={live ? "fg-marquee-fast" : "fg-marquee"} style={{ width: 5, height: 5, borderRadius: "50%", background: "radial-gradient(circle at 35% 30%, #fff6c8, #ffd447 60%, #b8860b)", boxShadow: "0 0 5px rgba(255,212,71,0.9)", animationDelay: `${(i % 3) * 0.25}s` }} />
    ))}
  </div>
);

export default function FeverJokerGame({ game }) {
  const { state, countdown, balance, betting, phase, outcome, result, history, placeBet, clearBets, myTotal, placing, myBets } =
    useLiveRound(game.slug, {
      formatResult: (s) => ({
        title: s.outcome.fever > 1 ? `★ JOKER FEVER ${s.outcome.fever}× ★` : s.outcome.multiplier > 0 ? `${s.outcome.label} — ${s.outcome.multiplier}×` : "No win this spin",
        subtitle: s.outcome.fever > 1 ? `${s.outcome.jokers} jokers ignite the Fever!` : s.outcome.multiplier > 0 ? "The reels pay!" : "Spin again for the joker",
        big: s.outcome.fever >= 3 || s.outcome.multiplier >= 20,
      }),
    });
  const [amount, setAmount] = useState(50);
  const [stopCount, setStopCount] = useState(5);
  const [tick, setTick] = useState(0);
  const spunRef = useRef(null);
  const roundNo = state?.round_number;

  useEffect(() => {
    if (phase !== "REVEAL") return;
    const id = setInterval(() => setTick((t) => t + 1), 80);
    return () => clearInterval(id);
  }, [phase]);

  useEffect(() => {
    if (phase === "BETTING") { setStopCount(0); return; }
    if (!outcome || !outcome.grid || spunRef.current === roundNo) return;
    spunRef.current = roundNo;
    setStopCount(0);
    sfx.reel && sfx.reel();
    const timers = [];
    for (let i = 0; i < 5; i++) {
      timers.push(setTimeout(() => {
        setStopCount(i + 1);
        if (i === 4 && outcome.fever > 1) { sfx.jokerLaugh ? sfx.jokerLaugh() : sfx.gong && sfx.gong(); sfx.coinShower && sfx.coinShower(); }
        else { sfx.reelStop && sfx.reelStop(); }
        if (navigator.vibrate) navigator.vibrate(i >= 3 ? 40 : 18);
      }, 480 + i * 560));
    }
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, outcome, roundNo]);

  const landed = stopCount >= 5 && !!outcome && !!outcome.grid && phase !== "BETTING";
  const grid = outcome?.grid;
  const isWin = landed && outcome.multiplier > 0;
  const fever = landed ? outcome.fever : 1;
  const feverOn = fever > 1;
  const jokersNow = landed ? outcome.jokers : 0;

  const winCells = new Set();
  if (landed && outcome.win_lines) {
    outcome.win_lines.forEach((wl) => {
      const pat = GJ_LINES[wl.line];
      for (let r = 0; r < wl.count; r++) winCells.add(`${r}-${pat[r]}`);
    });
  }
  const cellFor = (reel, row) => (stopCount > reel && grid ? grid[reel][row] : IDS[(reel * 7 + row * 3 + tick) % IDS.length]);

  return (
    <GameStage
      game={game}
      balance={balance}
      live={{ phase, countdown, timings: state?.timings, roundNumber: roundNo }}
      labels={{ REVEAL: "SPINNING…" }}
      betDock={
        <div className="space-y-2">
          <LiveBetPanel amount={amount} setAmount={setAmount} onPlace={() => placeBet(null, amount)} betting={betting} placing={placing} label="Spin the reels" myTotal={myTotal} />
          {betting && myBets.length > 0 && (
            <button data-testid="live-clear-bets" onClick={clearBets} className="w-full text-[11px] font-bold text-red-400/85 hover:text-red-400">Clear my bets (refund)</button>
          )}
        </div>
      }
      extras={
        <div className="space-y-3">
          <div className="rounded-xl border border-white/10 bg-black/25 p-3 text-[11px] text-white/60 space-y-1">
            <p className="font-bold text-white/80">Fever Joker — 5 reels · 10 lines</p>
            <p>3/4/5 matching left→right on any line pays. <span className="text-[#c084fc] font-bold">Joker</span> is Wild.</p>
            <p className="text-[#ff4f9a] font-bold">3 / 4 / 5 Jokers ignite JOKER FEVER — the whole win ×2 / ×3 / ×5.</p>
          </div>
          <HistoryStrip history={history} />
        </div>
      }
    >
      {/* FEVER meter */}
      <div className={`rounded-2xl border-2 p-2 mb-2 text-center relative overflow-hidden ${feverOn ? "fg-jackpot-pulse" : ""}`}
        style={{ borderColor: feverOn ? "#ff4f9a" : "#7b2fbe", background: "linear-gradient(180deg, #2a0f33, #170920)" }}>
        <div className="flex items-center justify-center gap-2 relative">
          <Flame className="h-4 w-4" style={{ color: feverOn ? "#ff4f9a" : "#7b2fbe" }} />
          <p className="text-[10px] font-extrabold tracking-[0.35em]" style={{ color: "#e9b8ff" }}>JOKER FEVER</p>
          <div className="flex gap-1">
            {[0, 1, 2, 3, 4].map((j) => (
              <span key={j} className="h-2 w-2 rounded-full transition-all" style={{ background: j < jokersNow ? "#ff4f9a" : "rgba(255,255,255,0.15)", boxShadow: j < jokersNow ? "0 0 6px #ff4f9a" : "none" }} />
            ))}
          </div>
          {feverOn && <span className="font-display text-lg fg-neon" style={{ color: "#ff4f9a" }}>{fever}×</span>}
        </div>
      </div>

      {/* 5x3 reel cabinet */}
      <div style={{ perspective: "1100px" }}>
        <div className={`relative rounded-2xl overflow-hidden border-2 ${feverOn ? "fg-jackpot-pulse" : ""}`}
          style={{ borderColor: "#c084fcaa", background: "linear-gradient(180deg, #2a1240 0%, #1a0b2e 55%, #120820 100%)", transform: "rotateX(5deg)", transformStyle: "preserve-3d", boxShadow: "0 18px 40px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.08)" }}
          data-testid="fever-joker-cabinet">
          {isWin && <WinBurst mult={outcome.multiplier} color="#ff4f9a" showAt={12} />}
          {isWin && <CoinShower color="#ff9ad0" dark="#c02f7a" />}
          {feverOn && <div aria-hidden className="absolute inset-0 z-20 pointer-events-none" style={{ background: "radial-gradient(circle at 50% 45%, rgba(255,79,154,0.4), transparent 60%)", animation: "fg-win-flash 0.8s ease-out 2" }} />}
          <span aria-hidden className="absolute left-0 top-0 bottom-0 w-1.5" style={{ background: "linear-gradient(90deg, #ff9ad0, #7b2fbe)" }} />
          <span aria-hidden className="absolute right-0 top-0 bottom-0 w-1.5" style={{ background: "linear-gradient(270deg, #ff9ad0, #7b2fbe)" }} />

          <div className="p-2.5">
            <div className="rounded-xl p-2 space-y-1.5" style={{ background: "linear-gradient(180deg, #ffe8a0, #b8860b 46%, #8a6a14)", boxShadow: "0 6px 16px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.55), inset 0 -2px 4px rgba(0,0,0,0.4)" }}>
              <Bulbs live={phase === "REVEAL" || isWin || feverOn} />
              <div className="rounded-lg p-1.5 flex gap-1" style={{ background: "#0e0620", boxShadow: "inset 0 0 16px rgba(0,0,0,0.85), inset 0 2px 6px rgba(0,0,0,0.7)" }} data-testid="fj-reels">
                {[0, 1, 2, 3, 4].map((reel) => {
                  const spinning = stopCount <= reel && phase === "REVEAL";
                  return (
                    <div key={reel} className="flex-1 flex flex-col gap-1">
                      {[0, 1, 2].map((row) => {
                        const id = cellFor(reel, row);
                        const s = SYM[id] || SYM.cherry;
                        const won = winCells.has(`${reel}-${row}`);
                        return (
                          <div key={row} className={`relative rounded-md flex items-center justify-center aspect-square ${spinning ? "fg-reel-spinning" : ""}`}
                            style={{ background: won ? "linear-gradient(180deg, rgba(255,79,154,0.28), rgba(255,79,154,0.08))" : "linear-gradient(180deg, #1e1440, #140d2c 50%, #1e1440)", boxShadow: won ? "0 0 12px rgba(255,79,154,0.55), inset 0 0 0 1px rgba(255,79,154,0.65)" : "inset 0 3px 6px rgba(0,0,0,0.5)", filter: spinning ? "blur(1.1px)" : "none" }}>
                            <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-1/3 rounded-t-md" style={{ background: "linear-gradient(180deg, rgba(255,255,255,0.18), transparent)" }} />
                            <Sym id={id} size={26} win={won} />
                            {!spinning && s.tag && <span className="absolute bottom-0.5 right-0.5 text-[6px] font-extrabold tracking-wider" style={{ color: s.color }}>{s.tag}</span>}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
              <Bulbs live={phase === "REVEAL" || isWin || feverOn} />
            </div>
          </div>

          <div className="px-2.5 pb-2.5">
            <div className="rounded-lg border text-center py-1.5" style={{ borderColor: "#c084fc33", background: "rgba(0,0,0,0.3)" }}>
              <p className="text-xs font-extrabold tracking-wider" style={{ color: feverOn ? "#ff4f9a" : isWin ? "#ffd447" : "rgba(196,181,253,0.7)" }} data-testid="fj-label">
                {landed ? (outcome.label + (outcome.multiplier > 0 ? ` · ${outcome.multiplier}×` : "")) : phase === "REVEAL" ? "GOOD LUCK…" : "5 REELS · 10 LINES · 3+ JOKERS = FEVER"}
              </p>
            </div>
          </div>
        </div>
      </div>

      <ResultBanner result={result} />
    </GameStage>
  );
}
