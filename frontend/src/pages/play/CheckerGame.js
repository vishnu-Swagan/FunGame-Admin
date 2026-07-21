import { useState } from "react";
import { Crown } from "lucide-react";
import { useLiveRound } from "@/lib/useLiveRound";
import { HistoryStrip } from "@/components/play/PlayShell";
import { LiveBetPanel, LastResults, ResultPill } from "@/components/play/LiveBar";
import { ResultBanner } from "@/components/play/ResultBanner";
import { GameStage } from "@/components/play/GameStage";

export default function CheckerGame({ game }) {
  const { state, countdown, balance, betting, phase, outcome, result, history, placeBet, clearBets, myBets, myTotal, lastResults, placing, revealProgress } =
    useLiveRound(game.slug, {
      revealSound: "draw",
      formatResult: (s) => ({
        title: s.payout > 0 ? `${s.outcome.winner.toUpperCase()} takes the board!` : `${s.outcome.winner.toUpperCase()} wins the duel`,
        subtitle: `Captures — Gold ${s.outcome.gold} : Steel ${s.outcome.steel}`,
      }),
    });
  const [side, setSide] = useState(null);
  const [amount, setAmount] = useState(50);

  const rounds = outcome?.rounds || [];
  const shownCount = phase === "RESULT" ? rounds.length : Math.floor(revealProgress * rounds.length);
  const shown = rounds.slice(0, shownCount);

  const sideTotals = {};
  myBets.forEach((b) => {
    sideTotals[b.selection] = (sideTotals[b.selection] || 0) + b.amount;
  });

  return (
    <GameStage
      game={game}
      balance={balance}
      live={{ phase, countdown, timings: state?.timings, roundNumber: state?.round_number }}
      labels={{ REVEAL: "CAPTURING…" }}
      betDock={
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            {[
              { id: "gold", label: "Gold", cls: "text-primary" },
              { id: "steel", label: "Steel", cls: "text-white/85" },
            ].map((s) => (
              <button
                key={s.id}
                data-testid={`checker-side-${s.id}`}
                onClick={() => setSide(s.id)}
                disabled={!betting}
                className={`relative rounded-xl border p-3.5 min-h-[56px] transition-[background-color,border-color] duration-150 ${side === s.id ? "bg-primary/12 border-primary/50" : "bg-white/5 border-white/10 hover:bg-white/10"} ${!betting ? "opacity-70" : ""}`}
              >
                <p className={`font-display text-lg ${s.cls}`}>{s.label}</p>
                <p className="text-[10px] text-white/45">pays 1.4x</p>
                {sideTotals[s.id] > 0 && (
                  <span className="absolute -top-1.5 -right-1.5 h-5 min-w-5 px-1 rounded-full bg-primary text-primary-foreground text-[9px] font-extrabold flex items-center justify-center border border-yellow-200 shadow tabular-nums">
                    {sideTotals[s.id]}
                  </span>
                )}
              </button>
            ))}
          </div>
          <LiveBetPanel
            amount={amount}
            setAmount={setAmount}
            onPlace={() => side && placeBet(side, amount)}
            betting={betting}
            placing={placing}
            disabled={!side}
            label={side ? `Bet ${side.toUpperCase()}` : "Pick a side first"}
            myTotal={myTotal}
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
      {/* ---- cinematic casino felt table (3D tilt + gold rail) ---- */}
      <div style={{ perspective: "1200px" }}>
      <div
        className="relative mx-auto rounded-2xl border-2 p-5 overflow-hidden"
        style={{
          borderColor: "#c9a22788",
          background: "radial-gradient(120% 95% at 50% 25%, #167d3e 0%, #0f5f2e 48%, #093c1e 100%)",
          transform: "rotateX(5deg)",
          transformStyle: "preserve-3d",
          boxShadow: "0 20px 44px rgba(0,0,0,0.5), inset 0 0 70px rgba(0,0,0,0.4)",
        }}
        data-testid="checker-table"
      >
        <div aria-hidden="true" className="fg-noise absolute inset-0 rounded-2xl pointer-events-none" style={{ opacity: 0.06 }} />
        <div aria-hidden="true" className="absolute inset-1.5 rounded-xl pointer-events-none" style={{ border: "1px solid rgba(201,162,39,0.35)" }} />
        {(() => {
          const goldCount = shown.filter((w) => w === "gold").length;
          const steelCount = shown.filter((w) => w === "steel").length;
          const showWinner = phase === "RESULT" && !!outcome;
          const winner = outcome?.winner;
          const Medallion = ({ gold, count, win }) => (
            <div className={`flex flex-col items-center justify-self-center gap-1.5 rounded-2xl px-3 py-2 transition-[background-color,box-shadow] duration-300 ${win ? (gold ? "bg-primary/10 shadow-[0_0_24px_rgba(255,199,64,0.4)]" : "bg-white/10 shadow-[0_0_24px_rgba(255,255,255,0.25)]") : ""}`} data-testid={`checker-${gold ? "gold" : "steel"}`}>
              <div
                className="relative h-16 w-16 rounded-full flex items-center justify-center"
                style={{
                  background: gold ? "radial-gradient(circle at 35% 30%, #ffe9ad, #ffca3a 55%, #a9781a)" : "radial-gradient(circle at 35% 30%, #eef2f7, #9aa7b8 55%, #566173)",
                  boxShadow: "0 5px 14px rgba(0,0,0,0.5), inset 0 -3px 6px rgba(0,0,0,0.3), inset 0 3px 5px rgba(255,255,255,0.5)",
                  border: gold ? "3px solid #b8860b" : "3px solid #47505f",
                }}
              >
                <Crown className="h-6 w-6" style={{ color: gold ? "#7a5200" : "#2b3240" }} />
                {win && <span className="absolute -top-2 -right-2 text-[8px] font-extrabold px-1.5 py-0.5 rounded-full" style={{ background: "hsl(var(--emerald))", color: "#000" }}>WIN</span>}
              </div>
              <p className="text-[11px] font-extrabold tracking-wider" style={{ color: gold ? "#ffd447" : "#cbd5e1" }}>{gold ? "GOLD" : "STEEL"}</p>
              <p className="font-display text-2xl tabular-nums leading-none" style={{ color: gold ? "#ffd447" : "#e2e8f0" }}>{count}</p>
            </div>
          );
          return (
            <div className="relative grid grid-cols-[1fr_auto_1fr] items-center gap-1">
              <Medallion gold count={goldCount} win={showWinner && winner === "gold"} />
              <div className="flex flex-col items-center gap-2">
                <p className="text-[9px] font-bold tracking-[0.3em] text-white/45">BEST OF 7</p>
                <div className="flex gap-1.5" data-testid="checker-track">
                  {Array.from({ length: 7 }, (_, i) => {
                    const w = shown[i];
                    const justFell = i === shownCount - 1 && phase === "REVEAL";
                    return (
                      <span
                        key={i}
                        className={`h-6 w-6 rounded-full border-2 transition-[background-color,box-shadow,transform] duration-200 ${justFell ? "scale-125" : ""}`}
                        style={{
                          borderColor: w ? (w === "gold" ? "#ffca3a" : "#9aa7b8") : "rgba(255,255,255,0.15)",
                          background: w ? (w === "gold" ? "radial-gradient(circle at 35% 30%, #ffe9ad, #ffca3a)" : "radial-gradient(circle at 35% 30%, #eef2f7, #9aa7b8)") : "rgba(0,0,0,0.25)",
                          boxShadow: w ? `0 0 9px ${w === "gold" ? "rgba(255,202,58,0.7)" : "rgba(154,167,184,0.55)"}` : "none",
                        }}
                      />
                    );
                  })}
                </div>
                <p className="text-[10px] text-white/50 tabular-nums min-h-[14px]">
                  {showWinner ? `${winner.toUpperCase()} takes the board` : shownCount > 0 ? `Capture ${shownCount} of ${rounds.length || 7}` : "Duel begins…"}
                </p>
              </div>
              <Medallion count={steelCount} win={showWinner && winner === "steel"} />
            </div>
          );
        })()}
        <p className="text-[11px] text-white/45 text-center mt-3 relative">Winning side pays 1.4x · one universal duel every round</p>
        <div className="flex justify-center mt-2 relative">
          <LastResults items={lastResults} render={(r) => <ResultPill label={r.winner === "gold" ? "G" : "S"} tone={r.winner === "gold" ? "gold" : "neutral"} />} />
        </div>
      </div>
      </div>

      <ResultBanner result={result} />
    </GameStage>
  );
}
