import { useState } from "react";
import { useLiveRound } from "@/lib/useLiveRound";
import { PlayShell, HistoryStrip } from "@/components/play/PlayShell";
import { LiveBar, LiveBetPanel } from "@/components/play/LiveBar";
import { ResultBanner } from "@/components/play/ResultBanner";

export default function BingoGame({ game }) {
  const { state, countdown, balance, betting, phase, outcome, result, history, placeBet, clearBets, myBets, myTotal, placing, revealProgress } =
    useLiveRound(game.slug, {
      revealSound: "draw",
      formatResult: (s) => {
        const b = s.bets[0] || {};
        const lines = b.lines || 0;
        return {
          title: lines > 0 ? `${lines} line${lines > 1 ? "s" : ""} — ${b.multiplier}x!` : "No lines",
          subtitle: "30 universal balls drawn from 75",
        };
      },
    });
  const [amount, setAmount] = useState(50);

  const drawnAll = outcome?.drawn || [];
  const shownCount = phase === "RESULT" ? drawnAll.length : Math.floor(revealProgress * drawnAll.length);
  const drawn = new Set(drawnAll.slice(0, shownCount));

  const card = myBets.length > 0 ? myBets[0].card : null;
  const grid = card || Array.from({ length: 5 }, (_, r) => Array.from({ length: 5 }, (_, c) => (r === 2 && c === 2 ? 0 : "?")));

  return (
    <PlayShell game={game} balance={balance}>
      <LiveBar state={state} countdown={countdown} labels={{ REVEAL: "DRAWING 30 BALLS…" }} />

      <div className="rounded-2xl bg-card/55 border border-white/10 p-4">
        <div className="grid grid-cols-5 gap-1 mb-2">
          {["B", "I", "N", "G", "O"].map((l) => (
            <div key={l} className="text-center font-display text-lg text-primary">{l}</div>
          ))}
        </div>
        <div className="grid grid-cols-5 gap-1" data-testid="bingo-card">
          {grid.flat().map((v, i) => {
            const free = v === 0;
            const marked = free || (typeof v === "number" && drawn.has(v));
            return (
              <div
                key={i}
                className={`rounded-lg border py-3 min-h-[44px] flex items-center justify-center text-sm font-bold tabular-nums ${
                  marked ? "bg-primary/20 border-primary/50 text-primary" : "bg-white/5 border-white/10 text-white/70"
                }`}
              >
                {free ? "✦" : v}
              </div>
            );
          })}
        </div>
        {!card && <p className="text-[11px] text-white/50 mt-2 text-center">Buy a card during betting to join this universal draw</p>}
        {phase !== "BETTING" && (
          <p className="text-[11px] text-white/50 mt-2 text-center tabular-nums" data-testid="bingo-drawn-count">
            Balls drawn: {shownCount}/30
          </p>
        )}
        <p className="text-[11px] text-white/45 mt-2 text-center">1 line 2x · 2 lines 5x · 3 lines 10x · 4 lines 25x · 5+ lines 50x</p>
      </div>

      <ResultBanner result={result} />
      <LiveBetPanel
        amount={amount}
        setAmount={setAmount}
        onPlace={() => placeBet(null, amount)}
        betting={betting}
        placing={placing}
        disabled={myBets.length > 0}
        label={myBets.length > 0 ? "Card bought for this round" : "Buy a card"}
        myTotal={myTotal}
        hint="Everyone shares the same 30 balls — your card is yours alone"
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
