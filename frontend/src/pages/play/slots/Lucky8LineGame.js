import { useState, useEffect, useRef } from "react";
import { Flower2, Gem, Coins, Fish, Flame } from "lucide-react";
import { useLiveRound } from "@/lib/useLiveRound";
import { sfx } from "@/lib/sound";
import { HistoryStrip } from "@/components/play/PlayShell";
import { LiveBetPanel } from "@/components/play/LiveBar";
import { ResultBanner } from "@/components/play/ResultBanner";
import { GameStage } from "@/components/play/GameStage";
import { CoinShower, WinBurst } from "@/pages/play/slots/slotFx";

const SYM = {
  blossom: { Icon: Flower2, color: "#ff6b9d" },
  ingot: { Icon: Gem, color: "#e0aa5f" },
  coin: { Icon: Coins, color: "#ffd447" },
  fish: { Icon: Fish, color: "#5ab9ea" },
  eight: { text: "8", color: "#ff5964" },
  dragon: { Icon: Flame, color: "#ffa04d", tag: "WILD" },
};
const IDS = Object.keys(SYM);
// 8 lines over a 3-reel x 3-row grid as (reel,row) — matches the backend.
const L8_LINES = [
  [[0, 0], [1, 0], [2, 0]], [[0, 1], [1, 1], [2, 1]], [[0, 2], [1, 2], [2, 2]],
  [[0, 0], [0, 1], [0, 2]], [[1, 0], [1, 1], [1, 2]], [[2, 0], [2, 1], [2, 2]],
  [[0, 0], [1, 1], [2, 2]], [[0, 2], [1, 1], [2, 0]],
];

const Sym = ({ id, size = 32, win }) => {
  const s = SYM[id] || SYM.blossom;
  const style = { color: s.color, filter: win ? "drop-shadow(0 0 7px currentColor)" : undefined };
  if (s.text) return <span className="font-display font-extrabold" style={{ ...style, fontSize: size * 0.66 }}>{s.text}</span>;
  const I = s.Icon;
  return <I style={{ ...style, width: size, height: size }} strokeWidth={1.9} />;
};

export default function Lucky8LineGame({ game }) {
  const { state, countdown, balance, betting, phase, outcome, result, history, placeBet, clearBets, myTotal, placing, myBets } =
    useLiveRound(game.slug, {
      formatResult: (s) => ({
        title: s.outcome.multiplier > 0 ? `${s.outcome.lines} line${s.outcome.lines > 1 ? "s" : ""} — ${s.outcome.multiplier}×` : "No line this spin",
        subtitle: s.outcome.lines >= 4 ? "The dragon smiles on you!" : s.outcome.multiplier > 0 ? "Lucky lines pay!" : "Spin again for the eight",
        big: s.outcome.lines >= 4 || s.outcome.multiplier >= 15,
      }),
    });
  const [amount, setAmount] = useState(50);
  const [stopCount, setStopCount] = useState(3);
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
    for (let i = 0; i < 3; i++) {
      timers.push(setTimeout(() => {
        setStopCount(i + 1);
        if (i === 2 && (outcome.lines || 0) >= 4) { sfx.gong && sfx.gong(); sfx.coinShower && sfx.coinShower(); }
        else { sfx.reelStop && sfx.reelStop(); }
        if (navigator.vibrate) navigator.vibrate(i === 2 ? 40 : 18);
      }, 500 + i * 620));
    }
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, outcome, roundNo]);

  const landed = stopCount >= 3 && !!outcome && !!outcome.grid && phase !== "BETTING";
  const grid = outcome?.grid;
  const isWin = landed && outcome.multiplier > 0;
  const bigWin = landed && (outcome.lines || 0) >= 4;

  const winCells = new Set();
  if (landed && outcome.win_lines) {
    outcome.win_lines.forEach((wl) => (L8_LINES[wl.line] || []).forEach(([r, c]) => winCells.add(`${r}-${c}`)));
  }
  const cellFor = (reel, row) => (stopCount > reel && grid ? grid[reel][row] : IDS[(reel * 5 + row * 2 + tick) % IDS.length]);

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
            <p className="font-bold text-white/80">Lucky 8 Line — 3×3 · 8 paylines</p>
            <p>All 8 lines active: 3 rows + 3 columns + 2 diagonals. 3-of-a-kind on a line pays. <span className="text-[#ffa04d] font-bold">Dragon</span> is Wild.</p>
            <p className="text-[#ff5964] font-bold">Golden <span className="font-display">8</span>s pay big — light up the dragon's fortune.</p>
          </div>
          <HistoryStrip history={history} />
        </div>
      }
    >
      <div style={{ perspective: "1000px" }}>
        <div className={`relative rounded-2xl overflow-hidden border-2 ${bigWin ? "fg-jackpot-pulse" : ""}`}
          style={{ borderColor: "#e0aa5faa", background: "linear-gradient(180deg, #33120b 0%, #200a06 55%, #170703 100%)", transform: "rotateX(5deg)", transformStyle: "preserve-3d", boxShadow: "0 18px 40px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.08)" }}
          data-testid="lucky8-cabinet">
          {isWin && <WinBurst mult={outcome.multiplier} color="#ffd447" showAt={10} />}
          {isWin && <CoinShower />}
          {bigWin && <div aria-hidden className="absolute inset-0 z-20 pointer-events-none" style={{ background: "radial-gradient(circle at 50% 45%, rgba(255,160,77,0.42), transparent 60%)", animation: "fg-win-flash 0.8s ease-out 2" }} />}
          <span aria-hidden className="absolute left-0 top-0 bottom-0 w-1.5" style={{ background: "linear-gradient(90deg, #ffe08a, #b8860b)" }} />
          <span aria-hidden className="absolute right-0 top-0 bottom-0 w-1.5" style={{ background: "linear-gradient(270deg, #ffe08a, #b8860b)" }} />

          <div className="text-center pt-2.5 pb-1.5" style={{ borderBottom: "1px solid #e0aa5f33" }}>
            <p className="font-display text-2xl fg-neon" style={{ color: "#ffd447" }}>Lucky 8 Line</p>
            <p className="text-[9px] font-extrabold tracking-[0.35em]" style={{ color: "#ffb37a" }}>★ 8 PAYLINES ★</p>
          </div>

          <div className="p-3">
            <div className="rounded-xl p-1.5 mx-auto w-fit" style={{ background: "linear-gradient(180deg, #f0d8a8, #94703f 45%, #c0975a)" }}>
              <div className="rounded-lg p-2 flex gap-1.5" style={{ background: "#160803" }} data-testid="l8-reels">
                {[0, 1, 2].map((reel) => {
                  const spinning = stopCount <= reel && phase === "REVEAL";
                  return (
                    <div key={reel} className="flex flex-col gap-1.5">
                      {[0, 1, 2].map((row) => {
                        const id = cellFor(reel, row);
                        const s = SYM[id] || SYM.blossom;
                        const won = winCells.has(`${reel}-${row}`);
                        return (
                          <div key={row} className={`relative h-16 w-16 rounded-md flex items-center justify-center ${spinning ? "fg-reel-spinning" : ""}`}
                            style={{ background: won ? "linear-gradient(180deg, rgba(255,212,71,0.3), rgba(255,212,71,0.08))" : "linear-gradient(180deg, #2a1408, #1c0d05 50%, #2a1408)", boxShadow: won ? "0 0 14px rgba(255,212,71,0.6), inset 0 0 0 1px rgba(255,212,71,0.7)" : "inset 0 3px 6px rgba(0,0,0,0.5)", filter: spinning ? "blur(1.1px)" : "none" }}>
                            <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-1/3 rounded-t-md" style={{ background: "linear-gradient(180deg, rgba(255,255,255,0.16), transparent)" }} />
                            <Sym id={id} size={32} win={won} />
                            {!spinning && s.tag && <span className="absolute bottom-0.5 right-1 text-[7px] font-extrabold tracking-wider" style={{ color: s.color }}>{s.tag}</span>}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="px-3 pb-3">
            <div className="rounded-lg border text-center py-1.5" style={{ borderColor: "#e0aa5f33", background: "rgba(0,0,0,0.3)" }}>
              <p className="text-xs font-extrabold tracking-wider" style={{ color: isWin ? "#ffd447" : "rgba(255,179,122,0.7)" }} data-testid="l8-label">
                {landed ? (outcome.label + (outcome.multiplier > 0 ? ` · ${outcome.multiplier}×` : "")) : phase === "REVEAL" ? "GOOD LUCK…" : "8 LINES · 3-OF-A-KIND PAYS · DRAGON WILD"}
              </p>
            </div>
          </div>
        </div>
      </div>

      <ResultBanner result={result} />
    </GameStage>
  );
}
