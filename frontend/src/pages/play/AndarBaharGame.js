import { useState, useRef, useEffect } from "react";
import { motion } from "framer-motion";
import { useGamePlay } from "@/lib/useGamePlay";
import { PlayShell, HistoryStrip } from "@/components/play/PlayShell";
import { BetPanel } from "@/components/play/BetPanel";
import { PlayingCard } from "@/components/play/PlayingCard";
import { ResultBanner } from "@/components/play/ResultBanner";

export default function AndarBaharGame({ game }) {
  const { balance, busy, play, history, loadHistory } = useGamePlay(game.slug);
  const [side, setSide] = useState(null);
  const [bet, setBet] = useState(50);
  const [joker, setJoker] = useState(null);
  const [shown, setShown] = useState([]); // dealt cards progressively
  const [dealing, setDealing] = useState(false);
  const [result, setResult] = useState(null);
  const timer = useRef(null);

  useEffect(() => () => clearInterval(timer.current), []);

  const doPlay = async () => {
    if (!side) return;
    setResult(null);
    setShown([]);
    setJoker(null);
    const data = await play(bet, { side });
    if (!data) return;
    const o = data.round.outcome;
    setJoker(o.joker);
    setDealing(true);
    let i = 0;
    timer.current = setInterval(() => {
      i += 1;
      setShown(o.sequence.slice(0, i));
      if (i >= o.sequence.length) {
        clearInterval(timer.current);
        setDealing(false);
        setResult({
          key: data.round.id, win: o.won,
          title: o.won ? `${o.winner.toUpperCase()} wins — you called it!` : `${o.winner.toUpperCase()} wins`,
          subtitle: `Match found after ${o.sequence.length} card${o.sequence.length > 1 ? "s" : ""}`,
          payout: data.round.payout,
        });
        loadHistory();
      }
    }, 220);
  };

  const sideCards = (s) => shown.filter((c) => c.side === s);

  return (
    <PlayShell game={game} balance={balance}>
      <div className="rounded-2xl bg-card/55 border border-white/10 p-4 space-y-3">
        <div className="flex items-center justify-center gap-3">
          <p className="text-[11px] font-semibold text-white/50">JOKER CARD</p>
          <PlayingCard code={joker} size="sm" faceDown={!joker} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          {["andar", "bahar"].map((s) => (
            <div key={s} className={`rounded-xl border p-2.5 min-h-[110px] ${result && shown.length && shown[shown.length - 1].side === s ? "border-primary/50 bg-primary/8" : "border-white/10 bg-white/4"}`}>
              <p className={`text-xs font-bold mb-1.5 ${s === "andar" ? "text-[hsl(var(--cyan))]" : "text-[hsl(var(--magenta))]"}`}>{s.toUpperCase()}</p>
              <div className="flex flex-wrap gap-1">
                {sideCards(s).slice(-8).map((c, i) => (
                  <motion.div key={`${s}-${i}-${c.card}`} initial={{ opacity: 0, scale: 0.7 }} animate={{ opacity: 1, scale: 1 }}>
                    <PlayingCard code={c.card} size="sm" />
                  </motion.div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {[
          { id: "andar", label: "Andar", cls: "text-[hsl(var(--cyan))]" },
          { id: "bahar", label: "Bahar", cls: "text-[hsl(var(--magenta))]" },
        ].map((s) => (
          <button
            key={s.id}
            data-testid={`andar-bahar-side-${s.id}`}
            onClick={() => setSide(s.id)}
            className={`rounded-xl border p-3.5 min-h-[56px] transition-[background-color,border-color] duration-150 ${
              side === s.id ? "bg-primary/12 border-primary/50" : "bg-white/5 border-white/10 hover:bg-white/10"
            }`}
          >
            <p className={`font-display text-lg ${s.cls}`}>{s.label}</p>
            <p className="text-[10px] text-white/45">pays 1.9x</p>
          </button>
        ))}
      </div>

      <ResultBanner result={result} />
      <BetPanel bet={bet} setBet={setBet} onPlay={doPlay} busy={busy || dealing} disabled={!side} playLabel={side ? `Deal — betting ${side.toUpperCase()}` : "Pick a side first"} />
      <HistoryStrip history={history} />
    </PlayShell>
  );
}
