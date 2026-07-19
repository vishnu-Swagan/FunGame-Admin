import { useState } from "react";
import { Target } from "lucide-react";
import { motion } from "framer-motion";
import { useGamePlay } from "@/lib/useGamePlay";
import { PlayShell, HistoryStrip } from "@/components/play/PlayShell";
import { BetPanel } from "@/components/play/BetPanel";
import { ResultBanner } from "@/components/play/ResultBanner";

export default function TargetGame({ game }) {
  const { balance, busy, play, history, loadHistory } = useGamePlay(game.slug);
  const [pick, setPick] = useState(null);
  const [bet, setBet] = useState(50);
  const [display, setDisplay] = useState("?");
  const [spinning, setSpinning] = useState(false);
  const [result, setResult] = useState(null);

  const doPlay = async () => {
    if (pick === null) return;
    setResult(null);
    setSpinning(true);
    const t = setInterval(() => setDisplay(String(Math.floor(Math.random() * 10))), 80);
    const data = await play(bet, { number: pick });
    setTimeout(() => {
      clearInterval(t);
      setSpinning(false);
      if (data) {
        const o = data.round.outcome;
        setDisplay(String(o.result));
        setResult({
          key: data.round.id, win: o.won,
          title: o.won ? "Bullseye! 9x" : "Missed",
          subtitle: `The wheel landed on ${o.result}`,
          payout: data.round.payout,
        });
        loadHistory();
      }
    }, 900);
  };

  return (
    <PlayShell game={game} balance={balance}>
      <div className="rounded-2xl bg-card/55 border border-white/10 p-6 flex flex-col items-center gap-2">
        <Target className="h-6 w-6 text-[hsl(var(--magenta))]" />
        <motion.div
          animate={spinning ? { scale: [1, 1.06, 1] } : {}}
          transition={{ repeat: spinning ? Infinity : 0, duration: 0.3 }}
          className="h-24 w-24 rounded-full border-4 border-primary/50 bg-black/30 flex items-center justify-center"
        >
          <span className="font-display text-5xl text-primary" data-testid="target-result">{display}</span>
        </motion.div>
        <p className="text-[11px] text-white/50">Exact hit pays 9x</p>
      </div>

      <div className="grid grid-cols-5 gap-2">
        {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
          <button
            key={n}
            data-testid={`target-pick-${n}`}
            onClick={() => setPick(n)}
            className={`rounded-xl border py-3 min-h-[48px] font-display text-xl transition-[background-color,border-color] duration-150 ${
              pick === n ? "bg-primary/15 border-primary/50 text-primary" : "bg-white/5 border-white/10 text-white/80 hover:bg-white/10"
            }`}
          >
            {n}
          </button>
        ))}
      </div>

      <ResultBanner result={result} />
      <BetPanel bet={bet} setBet={setBet} onPlay={doPlay} busy={busy || spinning} disabled={pick === null} playLabel={pick === null ? "Pick a number first" : `Fire at ${pick}`} />
      <HistoryStrip history={history} />
    </PlayShell>
  );
}
