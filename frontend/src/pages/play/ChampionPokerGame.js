import { useState } from "react";
import { motion } from "framer-motion";
import { useLiveRound } from "@/lib/useLiveRound";
import { PlayShell, HistoryStrip } from "@/components/play/PlayShell";
import { LiveBar, LiveBetPanel, LastResults, ResultPill } from "@/components/play/LiveBar";
import { PlayingCard } from "@/components/play/PlayingCard";
import { ResultBanner } from "@/components/play/ResultBanner";

export default function ChampionPokerGame({ game }) {
  const { state, countdown, balance, betting, phase, outcome, result, history, placeBet, clearBets, myTotal, lastResults, placing, revealProgress, myBets } =
    useLiveRound(game.slug, {
      revealSound: "deal",
      formatResult: (s) => ({
        title: s.outcome.hand === "NO WIN" ? "No win" : s.outcome.hand,
        subtitle: s.outcome.multiplier > 0 ? `Pays ${s.outcome.multiplier}x` : "The dealer drew a cold hand",
      }),
    });
  const [amount, setAmount] = useState(50);

  const reveal = !!outcome && phase !== "BETTING";
  const showFinal = reveal && (phase === "RESULT" || revealProgress > 0.55);
  const cards = showFinal ? outcome.cards : reveal ? outcome.initial : Array(5).fill(null);
  const holds = outcome?.holds || [];

  return (
    <PlayShell game={game} balance={balance}>
      <LiveBar state={state} countdown={countdown} labels={{ REVEAL: "HOLD & DRAW…" }} />

      <div className="rounded-2xl bg-card/55 border border-white/10 p-4">
        <div className="flex gap-1.5 justify-center">
          {cards.map((c, i) => (
            <div key={`${i}-${c || "x"}-${showFinal}`} className="flex flex-col items-center gap-1">
              <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.08 }}>
                <PlayingCard code={c} selected={reveal && !showFinal && holds[i]} />
              </motion.div>
              {reveal && !showFinal && (
                <span className={`text-[9px] font-bold tracking-wider ${holds[i] ? "text-primary" : "text-white/30"}`}>{holds[i] ? "HELD" : "DRAW"}</span>
              )}
            </div>
          ))}
        </div>
        {showFinal && phase === "RESULT" && (
          <p className="text-center text-sm font-bold text-white/85 mt-2" data-testid="champion-hand">
            {outcome.hand}{outcome.multiplier > 0 ? ` — ${outcome.multiplier}x` : ""}
          </p>
        )}
        <p className="text-[11px] text-white/45 text-center mt-2">
          Universal deal — the house auto-holds the best cards, then draws. Same result for every player.
        </p>
        <div className="flex justify-center mt-2">
          <LastResults items={lastResults} render={(r) => <ResultPill label={`${r.multiplier}x`} tone={r.multiplier > 0 ? "gold" : "neutral"} />} />
        </div>
      </div>

      <ResultBanner result={result} />
      <LiveBetPanel
        amount={amount}
        setAmount={setAmount}
        onPlace={() => placeBet(null, amount)}
        betting={betting}
        placing={placing}
        label="Join this hand"
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
