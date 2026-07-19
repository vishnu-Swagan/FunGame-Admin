import { useState } from "react";
import { Crown } from "lucide-react";
import { motion } from "framer-motion";
import { useLiveRound } from "@/lib/useLiveRound";
import { PlayShell, HistoryStrip } from "@/components/play/PlayShell";
import { LiveBar, LiveBetPanel, LastResults, ResultPill } from "@/components/play/LiveBar";
import { ResultBanner } from "@/components/play/ResultBanner";

export default function CheckerGame({ game }) {
  const { state, countdown, balance, betting, phase, outcome, result, history, placeBet, clearBets, myBets, myTotal, lastResults, placing, revealProgress } =
    useLiveRound(game.slug, {
      formatResult: (s) => ({
        title: s.payout > 0 ? `${s.outcome.winner.toUpperCase()} takes the board!` : `${s.outcome.winner.toUpperCase()} wins the duel`,
        subtitle: `Captures — Gold ${s.outcome.gold} : Steel ${s.outcome.steel}`,
      }),
    });
  const [side, setSide] = useState(null);
  const [amount, setAmount] = useState(50);

  const rounds = outcome?.rounds || [];
  const shownCount = phase === "RESULT" ? rounds.length : Math.floor(revealProgress * rounds.length);
  const shown = rounds.slice(0, shownCount);

  const sideTotals = {};
  myBets.forEach((b) => {
    sideTotals[b.selection] = (sideTotals[b.selection] || 0) + b.amount;
  });

  return (
    <PlayShell game={game} balance={balance}>
      <LiveBar state={state} countdown={countdown} labels={{ REVEAL: "CAPTURING…" }} />

      <div className="rounded-2xl bg-card/55 border border-white/10 p-5">
        <div
          className="mx-auto h-28 w-28 rounded-xl border border-white/15 mb-4"
          style={{ background: "conic-gradient(rgba(224,170,95,0.35) 90deg, rgba(255,255,255,0.06) 90deg 180deg, rgba(224,170,95,0.35) 180deg 270deg, rgba(255,255,255,0.06) 270deg)", backgroundSize: "28px 28px" }}
        />
        <div className="flex justify-center gap-1.5 min-h-[36px] flex-wrap" data-testid="checker-captures">
          {shown.map((w, i) => (
            <motion.div
              key={i}
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              className={`h-8 w-8 rounded-full border-2 flex items-center justify-center ${w === "gold" ? "bg-primary/25 border-primary" : "bg-white/10 border-white/40"}`}
            >
              <Crown className={`h-3.5 w-3.5 ${w === "gold" ? "text-primary" : "text-white/70"}`} />
            </motion.div>
          ))}
        </div>
        <p className="text-[11px] text-white/45 text-center mt-2">Best of 7 captures — winning side pays 1.9x · universal duel every round</p>
        <div className="flex justify-center mt-2">
          <LastResults items={lastResults} render={(r) => <ResultPill label={r.winner === "gold" ? "G" : "S"} tone={r.winner === "gold" ? "gold" : "neutral"} />} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {[
          { id: "gold", label: "Gold", cls: "text-primary" },
          { id: "steel", label: "Steel", cls: "text-white/85" },
        ].map((s) => (
          <button
            key={s.id}
            data-testid={`checker-side-${s.id}`}
            onClick={() => setSide(s.id)}
            disabled={!betting}
            className={`relative rounded-xl border p-3.5 min-h-[56px] transition-[background-color,border-color] duration-150 ${side === s.id ? "bg-primary/12 border-primary/50" : "bg-white/5 border-white/10 hover:bg-white/10"} ${!betting ? "opacity-70" : ""}`}
          >
            <p className={`font-display text-lg ${s.cls}`}>{s.label}</p>
            <p className="text-[10px] text-white/45">pays 1.9x</p>
            {sideTotals[s.id] > 0 && (
              <span className="absolute -top-1.5 -right-1.5 h-5 min-w-5 px-1 rounded-full bg-primary text-primary-foreground text-[9px] font-extrabold flex items-center justify-center border border-yellow-200 shadow tabular-nums">
                {sideTotals[s.id]}
              </span>
            )}
          </button>
        ))}
      </div>

      <ResultBanner result={result} />
      <LiveBetPanel
        amount={amount}
        setAmount={setAmount}
        onPlace={() => side && placeBet(side, amount)}
        betting={betting}
        placing={placing}
        disabled={!side}
        label={side ? `Bet ${side.toUpperCase()}` : "Pick a side first"}
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
