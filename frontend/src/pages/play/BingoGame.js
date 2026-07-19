import { useState } from "react";
import { useGamePlay } from "@/lib/useGamePlay";
import { PlayShell, HistoryStrip } from "@/components/play/PlayShell";
import { BetPanel } from "@/components/play/BetPanel";
import { ResultBanner } from "@/components/play/ResultBanner";

export default function BingoGame({ game }) {
  const { balance, busy, play, history, loadHistory } = useGamePlay(game.slug);
  const [bet, setBet] = useState(50);
  const [grid, setGrid] = useState(null);
  const [drawn, setDrawn] = useState(new Set());
  const [result, setResult] = useState(null);

  const doPlay = async () => {
    setResult(null);
    const data = await play(bet, {});
    if (data) {
      const o = data.round.outcome;
      setGrid(o.grid);
      setDrawn(new Set(o.drawn));
      setResult({
        key: data.round.id, win: data.round.payout > 0,
        title: o.lines > 0 ? `${o.lines} line${o.lines > 1 ? "s" : ""} — ${o.multiplier}x!` : "No lines",
        subtitle: "30 balls drawn from 75",
        payout: data.round.payout,
      });
      loadHistory();
    }
  };

  return (
    <PlayShell game={game} balance={balance}>
      <div className="rounded-2xl bg-card/55 border border-white/10 p-4">
        <div className="grid grid-cols-5 gap-1 mb-2">
          {["B", "I", "N", "G", "O"].map((l) => (
            <div key={l} className="text-center font-display text-lg text-primary">{l}</div>
          ))}
        </div>
        <div className="grid grid-cols-5 gap-1" data-testid="bingo-card">
          {(grid || Array.from({ length: 5 }, (_, r) => Array.from({ length: 5 }, (_, c) => (r === 2 && c === 2 ? 0 : "?")))).flat().map((v, i) => {
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
        <p className="text-[11px] text-white/45 mt-2 text-center">1 line 2x · 2 lines 5x · 3 lines 10x · 4 lines 25x · 5+ lines 50x</p>
      </div>

      <ResultBanner result={result} />
      <BetPanel bet={bet} setBet={setBet} onPlay={doPlay} busy={busy} playLabel="Play a card" />
      <HistoryStrip history={history} />
    </PlayShell>
  );
}
