import { useState, useEffect, useRef } from "react";
import { useLiveRound } from "@/lib/useLiveRound";
import { sfx } from "@/lib/sound";
import { HistoryStrip } from "@/components/play/PlayShell";
import { LiveBetPanel } from "@/components/play/LiveBar";
import { ResultBanner } from "@/components/play/ResultBanner";
import { GameStage } from "@/components/play/GameStage";

export default function KenoGame({ game }) {
  const { state, countdown, balance, betting, phase, outcome, result, history, placeBet, clearBets, myBets, myTotal, placing, revealProgress } =
    useLiveRound(game.slug, {
      revealSound: "draw",
      formatResult: (s) => {
        const b = s.bets[0] || {};
        const m = (b.matches || []).length;
        return {
          title: s.payout > 0 ? `${m} matches — ${b.multiplier}x!` : `${m} match${m === 1 ? "" : "es"}`,
          subtitle: s.payout > 0 ? "Nice picking!" : "Not enough matches this draw",
        };
      },
    });
  const [picks, setPicks] = useState([]);
  const [amount, setAmount] = useState(50);

  const drawnAll = outcome?.drawn || [];
  const shownCount = phase === "RESULT" ? drawnAll.length : Math.floor(revealProgress * drawnAll.length);
  const drawn = drawnAll.slice(0, shownCount);

  const myPicks = myBets.length > 0 ? myBets[0].selection || [] : picks;
  const matchCount = drawn.filter((n) => myPicks.includes(n)).length;

  // ball pop as each of the 20 is drawn; a bright ding when one of your picks hits
  const prevShownRef = useRef(0);
  const prevMatchRef = useRef(0);
  useEffect(() => {
    if (phase !== "REVEAL") { prevShownRef.current = 0; prevMatchRef.current = 0; return; }
    if (shownCount > prevShownRef.current) {
      if (matchCount > prevMatchRef.current) sfx.slotBell();
      else sfx.chip();
    }
    prevShownRef.current = shownCount;
    prevMatchRef.current = matchCount;
  }, [shownCount, matchCount, phase]);

  const toggle = (n) => {
    if (!betting) return;
    setPicks((p) => (p.includes(n) ? p.filter((x) => x !== n) : p.length < 10 ? [...p, n] : p));
  };

  return (
    <GameStage
      game={game}
      balance={balance}
      live={{ phase, countdown, timings: state?.timings, roundNumber: state?.round_number }}
      labels={{ REVEAL: "DRAWING 20 BALLS…" }}
      betDock={
        <div className="space-y-2">
          <LiveBetPanel
            amount={amount}
            setAmount={setAmount}
            onPlace={() => picks.length > 0 && placeBet(picks, amount)}
            betting={betting}
            placing={placing}
            disabled={picks.length === 0}
            label={picks.length === 0 ? "Pick numbers first" : `Play ${picks.length} pick${picks.length > 1 ? "s" : ""}`}
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
      <div
        className="relative rounded-2xl border-2 p-3 overflow-hidden"
        style={{
          borderColor: "#c9a22766",
          background: "radial-gradient(130% 100% at 50% 0%, #10224a 0%, #0a1430 55%, #060b1c 100%)",
          boxShadow: "0 14px 34px rgba(0,0,0,0.45), inset 0 0 50px rgba(0,0,0,0.35)",
        }}
        data-testid="keno-board"
      >
        <div aria-hidden="true" className="absolute inset-1.5 rounded-xl pointer-events-none" style={{ border: "1px solid rgba(201,162,39,0.3)" }} />
        <div className="flex items-center justify-between mb-2 relative">
          <p className="text-[11px] font-semibold text-white/60">Pick up to 10 · 20 universal balls per round</p>
          <button data-testid="keno-clear-button" onClick={() => setPicks([])} disabled={!betting} className="text-[11px] font-bold text-primary hover:underline disabled:opacity-50">
            Clear ({picks.length}/10)
          </button>
        </div>
        {/* live draw rack + match counter */}
        {phase !== "BETTING" && (
          <div className="relative mb-2 rounded-lg px-2 py-1.5 flex items-center gap-2" style={{ background: "rgba(0,0,0,0.3)", border: "1px solid rgba(201,162,39,0.25)" }}>
            <span className="text-[9px] font-bold tracking-widest text-white/45 shrink-0">DRAWN</span>
            <div className="flex-1 flex gap-1 overflow-hidden">
              {drawn.slice(-12).map((n, i, arr) => {
                const hit = myPicks.includes(n);
                const newest = i === arr.length - 1 && shownCount < 20;
                return (
                  <span
                    key={`${n}-${i}`}
                    className={`shrink-0 h-6 w-6 rounded-full grid place-items-center text-[9px] font-bold tabular-nums ${newest ? "fg-line-flash scale-110" : ""}`}
                    style={{
                      color: hit ? "#3a2a00" : "#0a1430",
                      background: hit ? "radial-gradient(circle at 35% 30%, #fff6c8, #ffd447 60%, #b8860b)" : "radial-gradient(circle at 35% 30%, #eef4ff, #a9bce0 65%, #6b7ea0)",
                      boxShadow: hit ? "0 0 10px rgba(255,212,71,0.85)" : "0 0 5px rgba(255,255,255,0.25)",
                    }}
                  >
                    {n}
                  </span>
                );
              })}
            </div>
            {myPicks.length > 0 && (
              <span className="shrink-0 text-[10px] font-extrabold tabular-nums px-2 py-0.5 rounded-full" style={{ color: "#ffd447", background: "rgba(255,212,71,0.12)", border: "1px solid rgba(255,212,71,0.35)" }} data-testid="keno-match-count">
                {matchCount} HIT{matchCount === 1 ? "" : "S"}
              </span>
            )}
          </div>
        )}
        <div className="grid grid-cols-10 gap-1 relative">
          {Array.from({ length: 80 }, (_, i) => i + 1).map((n) => {
            const picked = picks.includes(n) || (myBets.length > 0 && myPicks.includes(n));
            const isDrawn = drawn.includes(n);
            const isMatch = picked && isDrawn;
            return (
              <button
                key={n}
                data-testid={`keno-number-${n}`}
                onClick={() => toggle(n)}
                className={`rounded-full text-[10px] font-bold py-1.5 min-h-[26px] tabular-nums border transition-[background-color,box-shadow,transform] duration-150 ${
                  isMatch
                    ? "bg-primary text-primary-foreground border-yellow-200 scale-110 shadow-[0_0_12px_rgba(255,199,64,0.9)] fg-line-flash"
                    : picked
                    ? "bg-[hsl(var(--cyan)/0.25)] border-[hsl(var(--cyan)/0.6)] text-[hsl(var(--cyan))] shadow-[0_0_6px_hsl(var(--cyan)/0.4)]"
                    : isDrawn
                    ? "bg-white/20 border-white/40 text-white shadow-[0_0_8px_rgba(255,255,255,0.35)]"
                    : "bg-white/5 border-white/10 text-white/55 hover:bg-white/10"
                }`}
              >
                {n}
              </button>
            );
          })}
        </div>
        {phase !== "BETTING" && (
          <p className="text-[11px] text-white/50 mt-2 tabular-nums" data-testid="keno-drawn-count">
            Balls drawn: {drawn.length}/20
          </p>
        )}
      </div>

      <ResultBanner result={result} />
    </GameStage>
  );
}
