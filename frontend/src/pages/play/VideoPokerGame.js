import { useState } from "react";
import { motion } from "framer-motion";
import { useGamePlay } from "@/lib/useGamePlay";
import { PlayShell, HistoryStrip } from "@/components/play/PlayShell";
import { BetPanel } from "@/components/play/BetPanel";
import { PlayingCard } from "@/components/play/PlayingCard";
import { ResultBanner } from "@/components/play/ResultBanner";

const PAYTABLE = [
  ["Royal Flush", "300x"], ["Straight Flush", "60x"], ["Four of a Kind", "30x"], ["Full House", "10x"],
  ["Flush", "7x"], ["Straight", "5x"], ["Three of a Kind", "4x"], ["Two Pair", "3x"], ["Jacks or Better", "2x"],
];

export default function VideoPokerGame({ game }) {
  const { balance, busy, play, history, loadHistory } = useGamePlay(game.slug);
  const [bet, setBet] = useState(50);
  const [cards, setCards] = useState(null);
  const [result, setResult] = useState(null);

  const doPlay = async () => {
    setResult(null);
    setCards(null);
    const data = await play(bet, {});
    if (data) {
      const o = data.round.outcome;
      setCards(o.cards);
      setResult({
        key: data.round.id, win: data.round.payout > 0,
        title: o.hand === "NO WIN" ? "No win" : o.hand,
        subtitle: o.multiplier > 0 ? `Pays ${o.multiplier}x` : "Deal again for a paying hand",
        payout: data.round.payout,
      });
      loadHistory();
    }
  };

  return (
    <PlayShell game={game} balance={balance}>
      <div className="rounded-2xl bg-card/55 border border-white/10 p-4">
        <div className="flex gap-1.5 justify-center">
          {(cards || Array(5).fill(null)).map((c, i) => (
            <motion.div key={`${i}-${c || "x"}`} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.07 }}>
              <PlayingCard code={c} />
            </motion.div>
          ))}
        </div>
        <p className="text-[11px] text-white/45 text-center mt-3">Instant 5-card draw — no holds, straight to the showdown</p>
      </div>

      <ResultBanner result={result} />
      <BetPanel bet={bet} setBet={setBet} onPlay={doPlay} busy={busy} playLabel="Deal 5 cards" />

      <div className="rounded-2xl bg-card/55 border border-white/10 p-3.5">
        <p className="text-xs font-semibold text-white/60 mb-2">Paytable</p>
        <div className="grid grid-cols-3 gap-x-3 gap-y-1">
          {PAYTABLE.map(([h, p]) => (
            <div key={h} className="flex items-center justify-between text-[11px]">
              <span className="text-white/55">{h}</span>
              <span className="tabular-nums font-bold text-primary">{p}</span>
            </div>
          ))}
        </div>
      </div>
      <HistoryStrip history={history} />
    </PlayShell>
  );
}
