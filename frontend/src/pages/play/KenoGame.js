import { useState } from "react";
import { useLiveRound } from "@/lib/useLiveRound";
import { PlayShell, HistoryStrip } from "@/components/play/PlayShell";
import { LiveBar, LiveBetPanel } from "@/components/play/LiveBar";
import { ResultBanner } from "@/components/play/ResultBanner";

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

  const toggle = (n) => {
    if (!betting) return;
    setPicks((p) => (p.includes(n) ? p.filter((x) => x !== n) : p.length < 10 ? [...p, n] : p));
  };

  return (
    <PlayShell game={game} balance={balance}>
      <LiveBar state={state} countdown={countdown} labels={{ REVEAL: "DRAWING 20 BALLS…" }} />

      <div className="rounded-2xl bg-card/55 border border-white/10 p-3">
        <div className="flex items-center justify-between mb-2">
          <p className="text-[11px] font-semibold text-white/50">Pick up to 10 · 20 universal balls per round</p>
          <button data-testid="keno-clear-button" onClick={() => setPicks([])} disabled={!betting} className="text-[11px] font-bold text-primary hover:underline disabled:opacity-50">
            Clear ({picks.length}/10)
          </button>
        </div>
        <div className="grid grid-cols-10 gap-1">
          {Array.from({ length: 80 }, (_, i) => i + 1).map((n) => {
            const picked = picks.includes(n) || (myBets.length > 0 && myPicks.includes(n));
            const isDrawn = drawn.includes(n);
            const isMatch = picked && isDrawn;
            return (
              <button
                key={n}
                data-testid={`keno-number-${n}`}
                onClick={() => toggle(n)}
                className={`rounded-md text-[10px] font-bold py-1.5 min-h-[26px] tabular-nums border transition-[background-color] duration-100 ${
                  isMatch
                    ? "bg-primary text-primary-foreground border-primary"
                    : picked
                    ? "bg-[hsl(var(--cyan)/0.25)] border-[hsl(var(--cyan)/0.5)] text-[hsl(var(--cyan))]"
                    : isDrawn
                    ? "bg-white/15 border-white/25 text-white/85"
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
      <HistoryStrip history={history} />
    </PlayShell>
  );
}
