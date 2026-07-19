import { useState, useEffect } from "react";
import { Target } from "lucide-react";
import { motion } from "framer-motion";
import { useLiveRound } from "@/lib/useLiveRound";
import { PlayShell, HistoryStrip } from "@/components/play/PlayShell";
import { LiveBar, LiveBetPanel, LastResults, ResultPill } from "@/components/play/LiveBar";
import { ResultBanner } from "@/components/play/ResultBanner";
import { formatChips } from "@/components/common";

export default function TargetGame({ game }) {
  const { state, countdown, balance, betting, phase, outcome, result, history, placeBet, clearBets, myBets, myTotal, lastResults, placing } =
    useLiveRound(game.slug, {
      revealSound: "spin",
      formatResult: (s) => ({
        title: s.payout > 0 ? "Bullseye! 9x" : "Missed",
        subtitle: `The target landed on ${s.outcome.result}`,
      }),
    });
  const [pick, setPick] = useState(null);
  const [amount, setAmount] = useState(50);
  const [anim, setAnim] = useState("?");

  useEffect(() => {
    if (phase !== "REVEAL") return;
    const t = setInterval(() => setAnim(String(Math.floor(Math.random() * 10))), 80);
    return () => clearInterval(t);
  }, [phase]);

  const showFinal = !!outcome && (phase === "RESULT" || (phase === "REVEAL" && countdown < 1.2));
  const display = showFinal ? String(outcome.result) : phase === "REVEAL" ? anim : "?";
  const spinning = phase === "REVEAL" && !showFinal;

  const pickTotals = {};
  myBets.forEach((b) => {
    pickTotals[b.selection] = (pickTotals[b.selection] || 0) + b.amount;
  });

  return (
    <PlayShell game={game} balance={balance}>
      <LiveBar state={state} countdown={countdown} labels={{ REVEAL: "FIRING…" }} />

      <div className="rounded-2xl bg-card/55 border border-white/10 p-6 flex flex-col items-center gap-2">
        <Target className="h-6 w-6 text-[hsl(var(--magenta))]" />
        <motion.div
          animate={spinning ? { scale: [1, 1.06, 1] } : {}}
          transition={{ repeat: spinning ? Infinity : 0, duration: 0.3 }}
          className="h-24 w-24 rounded-full border-4 border-primary/50 bg-black/30 flex items-center justify-center"
        >
          <span className="font-display text-5xl text-primary" data-testid="target-result">{display}</span>
        </motion.div>
        <p className="text-[11px] text-white/50">Exact hit pays 9x — one universal number per round</p>
        <LastResults items={lastResults} render={(r) => <ResultPill label={r.result} tone="gold" />} />
      </div>

      <div className="grid grid-cols-5 gap-2">
        {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
          <button
            key={n}
            data-testid={`target-pick-${n}`}
            onClick={() => setPick(n)}
            disabled={!betting}
            className={`relative rounded-xl border py-3 min-h-[48px] font-display text-xl transition-[background-color,border-color] duration-150 ${
              pick === n ? "bg-primary/15 border-primary/50 text-primary" : "bg-white/5 border-white/10 text-white/80 hover:bg-white/10"
            } ${!betting ? "opacity-70" : ""}`}
          >
            {n}
            {pickTotals[n] > 0 && (
              <span className="absolute -top-1.5 -right-1.5 h-5 min-w-5 px-1 rounded-full bg-primary text-primary-foreground text-[9px] font-extrabold flex items-center justify-center border border-yellow-200 shadow tabular-nums">
                {formatChips(pickTotals[n])}
              </span>
            )}
          </button>
        ))}
      </div>

      <ResultBanner result={result} />
      <LiveBetPanel
        amount={amount}
        setAmount={setAmount}
        onPlace={() => pick !== null && placeBet(pick, amount)}
        betting={betting}
        placing={placing}
        disabled={pick === null}
        label={pick === null ? "Pick a number first" : `Fire at ${pick}`}
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
