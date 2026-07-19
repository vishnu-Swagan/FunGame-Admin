import { useState } from "react";
import { motion } from "framer-motion";
import { useGamePlay } from "@/lib/useGamePlay";
import { PlayShell, HistoryStrip } from "@/components/play/PlayShell";
import { BetPanel } from "@/components/play/BetPanel";
import { ResultBanner } from "@/components/play/ResultBanner";

const SEGMENTS = [0, 1.5, 2, 3, 5, 10, 20, 50];

export default function WheelGame({ game }) {
  const { balance, busy, play, history, loadHistory } = useGamePlay(game.slug);
  const [bet, setBet] = useState(50);
  const [spinning, setSpinning] = useState(false);
  const [landed, setLanded] = useState(null);
  const [result, setResult] = useState(null);

  const doPlay = async () => {
    setResult(null);
    setSpinning(true);
    setLanded(null);
    const data = await play(bet, {});
    setTimeout(() => {
      setSpinning(false);
      if (data) {
        const o = data.round.outcome;
        setLanded(o.multiplier);
        setResult({
          key: data.round.id, win: o.multiplier > 0,
          title: o.multiplier > 0 ? `Golden ${o.multiplier}x!` : "Blank segment",
          subtitle: o.multiplier > 0 ? "The wheel shines on you" : "Spin again for the gold",
          payout: data.round.payout,
        });
        loadHistory();
      }
    }, 1400);
  };

  return (
    <PlayShell game={game} balance={balance}>
      <div className="rounded-2xl bg-card/55 border border-white/10 p-6 flex flex-col items-center gap-3">
        <motion.div
          animate={spinning ? { rotate: 360 } : { rotate: 0 }}
          transition={spinning ? { repeat: Infinity, duration: 0.5, ease: "linear" } : { duration: 0.5 }}
          className="h-36 w-36 rounded-full border-4 border-primary/60 shadow-[0_0_30px_rgba(255,199,64,0.25)] flex items-center justify-center"
          style={{ background: "repeating-conic-gradient(rgba(255,199,64,0.4) 0 22.5deg, rgba(255,255,255,0.06) 22.5deg 45deg)" }}
        >
          <div className="h-20 w-20 rounded-full bg-black/60 border border-primary/40 flex items-center justify-center">
            <span className="font-display text-2xl text-primary" data-testid="wheel-result">
              {spinning ? "…" : landed !== null ? `${landed}x` : "SPIN"}
            </span>
          </div>
        </motion.div>
        <div className="flex flex-wrap justify-center gap-1.5">
          {SEGMENTS.map((m) => (
            <span key={m} className={`rounded-full border px-2.5 py-1 text-[10px] font-bold tabular-nums ${landed === m ? "bg-primary text-primary-foreground border-primary" : "bg-white/5 border-white/10 text-white/55"}`}>
              {m}x
            </span>
          ))}
        </div>
      </div>

      <ResultBanner result={result} />
      <BetPanel bet={bet} setBet={setBet} onPlay={doPlay} busy={busy || spinning} playLabel="Spin the golden wheel" />
      <HistoryStrip history={history} />
    </PlayShell>
  );
}
