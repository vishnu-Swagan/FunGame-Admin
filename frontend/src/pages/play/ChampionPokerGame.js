import { useState } from "react";
import { toast } from "sonner";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { api, errMsg } from "@/lib/api";
import { useGamePlay } from "@/lib/useGamePlay";
import { PlayShell, HistoryStrip } from "@/components/play/PlayShell";
import { BetPanel } from "@/components/play/BetPanel";
import { PlayingCard } from "@/components/play/PlayingCard";
import { ResultBanner } from "@/components/play/ResultBanner";

export default function ChampionPokerGame({ game }) {
  const { balance, setBalance, busy, setBusy, play, history, loadHistory } = useGamePlay(game.slug);
  const [bet, setBet] = useState(50);
  const [phase, setPhase] = useState("bet"); // bet | hold
  const [roundId, setRoundId] = useState(null);
  const [cards, setCards] = useState(null);
  const [holds, setHolds] = useState([false, false, false, false, false]);
  const [result, setResult] = useState(null);

  const deal = async () => {
    setResult(null);
    const data = await play(bet, {});
    if (data) {
      setRoundId(data.round_id);
      setCards(data.cards);
      setHolds([false, false, false, false, false]);
      setPhase("hold");
    }
  };

  const draw = async () => {
    setBusy(true);
    try {
      const { data } = await api.post("/games/champion-poker/draw", { round_id: roundId, holds });
      setCards(data.cards);
      setBalance(data.balance);
      setResult({
        key: roundId, win: data.payout > 0,
        title: data.hand === "NO WIN" ? "No win" : data.hand,
        subtitle: data.multiplier > 0 ? `Pays ${data.multiplier}x` : "Hold smarter next deal",
        payout: data.payout,
      });
      setPhase("bet");
      loadHistory();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <PlayShell game={game} balance={balance}>
      <div className="rounded-2xl bg-card/55 border border-white/10 p-4">
        <div className="flex gap-1.5 justify-center">
          {(cards || Array(5).fill(null)).map((c, i) => (
            <div key={`${i}-${c || "x"}`} className="flex flex-col items-center gap-1">
              <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.07 }}>
                <PlayingCard
                  code={c}
                  selected={phase === "hold" && holds[i]}
                  onClick={phase === "hold" ? () => setHolds((h) => h.map((v, j) => (j === i ? !v : v))) : undefined}
                />
              </motion.div>
              {phase === "hold" && (
                <span className={`text-[9px] font-bold tracking-wider ${holds[i] ? "text-primary" : "text-white/30"}`}>{holds[i] ? "HELD" : "TAP TO HOLD"}</span>
              )}
            </div>
          ))}
        </div>
        <p className="text-[11px] text-white/45 text-center mt-3">
          {phase === "hold" ? "Tap cards to hold, then draw replacements" : "Deal 5 cards, hold your best, draw the rest"}
        </p>
      </div>

      <ResultBanner result={result} />

      {phase === "hold" ? (
        <Button data-testid="champion-draw-button" onClick={draw} disabled={busy} className="w-full h-12 rounded-xl text-base font-bold hover:brightness-110 active:scale-[0.98] transition-[filter,transform] duration-150">
          {busy ? "Drawing…" : `Draw (holding ${holds.filter(Boolean).length})`}
        </Button>
      ) : (
        <BetPanel bet={bet} setBet={setBet} onPlay={deal} busy={busy} playLabel="Deal" />
      )}
      <HistoryStrip history={history} />
    </PlayShell>
  );
}
