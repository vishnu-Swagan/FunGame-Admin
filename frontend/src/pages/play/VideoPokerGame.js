import { useState } from "react";
import { motion } from "framer-motion";
import { useLiveRound } from "@/lib/useLiveRound";
import { PlayShell, HistoryStrip } from "@/components/play/PlayShell";
import { LiveBar, LiveBetPanel, LastResults, ResultPill } from "@/components/play/LiveBar";
import { PlayingCard } from "@/components/play/PlayingCard";
import { ResultBanner } from "@/components/play/ResultBanner";

const PAYTABLE = [
  ["Royal Flush", "300x"], ["Straight Flush", "60x"], ["Four of a Kind", "30x"], ["Full House", "10x"],
  ["Flush", "7x"], ["Straight", "5x"], ["Three of a Kind", "4x"], ["Two Pair", "3x"], ["Jacks or Better", "2x"],
];

export default function VideoPokerGame({ game }) {
  const { state, countdown, balance, betting, phase, outcome, result, history, placeBet, clearBets, myTotal, lastResults, placing, myBets } =
    useLiveRound(game.slug, {
      revealSound: "deal",
      formatResult: (s) => ({
        title: s.outcome.hand === "NO WIN" ? "No win" : s.outcome.hand,
        subtitle: s.outcome.multiplier > 0 ? `Pays ${s.outcome.multiplier}x` : "Join the next deal for a paying hand",
      }),
    });
  const [amount, setAmount] = useState(50);

  const reveal = !!outcome && phase !== "BETTING";

  return (
    <PlayShell game={game} balance={balance}>
      <LiveBar state={state} countdown={countdown} labels={{ REVEAL: "DEALING…" }} />

      <div className="rounded-2xl bg-card/55 border border-white/10 p-4">
        <div className="flex gap-1.5 justify-center">
          {(reveal ? outcome.cards : Array(5).fill(null)).map((c, i) => (
            <motion.div key={`${i}-${c || "x"}`} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.12 }}>
              <PlayingCard code={c} />
            </motion.div>
          ))}
        </div>
        {reveal && phase === "RESULT" && (
          <p className="text-center text-sm font-bold text-white/85 mt-2" data-testid="nohold-hand">
            {outcome.hand}{outcome.multiplier > 0 ? ` — ${outcome.multiplier}x` : ""}
          </p>
        )}
        <p className="text-[11px] text-white/45 text-center mt-2">One universal 5-card deal per round — no holds, straight to the showdown</p>
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
        label="Join this deal"
        myTotal={myTotal}
      />
      {betting && myBets.length > 0 && (
        <button data-testid="live-clear-bets" onClick={clearBets} className="w-full text-[11px] font-bold text-red-400/85 hover:text-red-400">
          Clear my bets (refund)
        </button>
      )}

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
