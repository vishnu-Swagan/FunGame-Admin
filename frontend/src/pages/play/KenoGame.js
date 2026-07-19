import { useState } from "react";
import { useGamePlay } from "@/lib/useGamePlay";
import { PlayShell, HistoryStrip } from "@/components/play/PlayShell";
import { BetPanel } from "@/components/play/BetPanel";
import { ResultBanner } from "@/components/play/ResultBanner";

export default function KenoGame({ game }) {
  const { balance, busy, play, history, loadHistory } = useGamePlay(game.slug);
  const [picks, setPicks] = useState([]);
  const [bet, setBet] = useState(50);
  const [drawn, setDrawn] = useState([]);
  const [matches, setMatches] = useState([]);
  const [result, setResult] = useState(null);

  const toggle = (n) => {
    setDrawn([]);
    setMatches([]);
    setPicks((p) => (p.includes(n) ? p.filter((x) => x !== n) : p.length < 10 ? [...p, n] : p));
  };

  const doPlay = async () => {
    if (picks.length === 0) return;
    setResult(null);
    const data = await play(bet, { picks });
    if (data) {
      const o = data.round.outcome;
      setDrawn(o.drawn);
      setMatches(o.matches);
      setResult({
        key: data.round.id, win: data.round.payout > 0,
        title: data.round.payout > 0 ? `${o.matches.length} matches — ${o.multiplier}x!` : `${o.matches.length} matches`,
        subtitle: data.round.payout > 0 ? "Nice picking!" : "Not enough matches this draw",
        payout: data.round.payout,
      });
      loadHistory();
    }
  };

  return (
    <PlayShell game={game} balance={balance}>
      <div className="rounded-2xl bg-card/55 border border-white/10 p-3">
        <div className="flex items-center justify-between mb-2">
          <p className="text-[11px] font-semibold text-white/50">Pick up to 10 numbers · 20 are drawn</p>
          <button data-testid="keno-clear-button" onClick={() => { setPicks([]); setDrawn([]); setMatches([]); }} className="text-[11px] font-bold text-primary hover:underline">
            Clear ({picks.length}/10)
          </button>
        </div>
        <div className="grid grid-cols-10 gap-1">
          {Array.from({ length: 80 }, (_, i) => i + 1).map((n) => {
            const picked = picks.includes(n);
            const isDrawn = drawn.includes(n);
            const isMatch = matches.includes(n);
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
      </div>

      <ResultBanner result={result} />
      <BetPanel bet={bet} setBet={setBet} onPlay={doPlay} busy={busy} disabled={picks.length === 0} playLabel={picks.length === 0 ? "Pick numbers first" : `Draw with ${picks.length} pick${picks.length > 1 ? "s" : ""}`} />
      <HistoryStrip history={history} />
    </PlayShell>
  );
}
