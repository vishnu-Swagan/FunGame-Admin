import { useState } from "react";
import { motion } from "framer-motion";
import { useGamePlay } from "@/lib/useGamePlay";
import { PlayShell, HistoryStrip } from "@/components/play/PlayShell";
import { BetPanel } from "@/components/play/BetPanel";
import { PlayingCard } from "@/components/play/PlayingCard";
import { ResultBanner } from "@/components/play/ResultBanner";

export default function CardDuelGame({ game }) {
  const { balance, busy, play, history, loadHistory } = useGamePlay(game.slug);
  const [bet, setBet] = useState(50);
  const [round, setRound] = useState(null);
  const [result, setResult] = useState(null);
  const nCards = game.slug === "teen-patti" ? 3 : 5;

  const doPlay = async () => {
    setResult(null);
    setRound(null);
    const data = await play(bet, {});
    if (data) {
      const o = data.round.outcome;
      setRound(o);
      setResult({
        key: data.round.id,
        win: o.result === "win", push: o.result === "push",
        title: o.result === "win" ? "You beat the dealer!" : o.result === "push" ? "Push — stake returned" : "Dealer wins",
        subtitle: `You: ${o.player_hand} · Dealer: ${o.dealer_hand}`,
        payout: o.result === "win" ? data.round.payout : 0,
      });
      loadHistory();
    }
  };

  const Row = ({ label, cards, hand, highlight }) => (
    <div>
      <p className="text-[11px] font-semibold text-white/50 mb-1.5">{label}{hand ? ` — ${hand}` : ""}</p>
      <div className="flex gap-1.5">
        {(cards || Array(nCards).fill(null)).map((c, i) => (
          <motion.div key={`${label}-${i}-${c || "x"}`} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.08 }}>
            <PlayingCard code={c} size={nCards === 3 ? "lg" : "md"} dimmed={highlight === false} />
          </motion.div>
        ))}
      </div>
    </div>
  );

  return (
    <PlayShell game={game} balance={balance}>
      <div className="rounded-2xl bg-card/55 border border-white/10 p-4 space-y-4">
        <Row label="Dealer" cards={round?.dealer} hand={round?.dealer_hand} highlight={round ? round.result === "lose" : undefined} />
        <div className="border-t border-white/8" />
        <Row label="Your hand" cards={round?.player} hand={round?.player_hand} highlight={round ? round.result === "win" : undefined} />
        <p className="text-[11px] text-white/45">Beat the dealer to win 1.95x · ties push your stake back</p>
      </div>

      <ResultBanner result={result} />
      <BetPanel bet={bet} setBet={setBet} onPlay={doPlay} busy={busy} playLabel="Deal the cards" />
      <HistoryStrip history={history} />
    </PlayShell>
  );
}
