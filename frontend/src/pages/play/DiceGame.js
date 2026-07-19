import { useState, useEffect } from "react";
import { Dice1, Dice2, Dice3, Dice4, Dice5, Dice6 } from "lucide-react";
import { motion } from "framer-motion";
import { useLiveRound } from "@/lib/useLiveRound";
import { PlayShell, HistoryStrip } from "@/components/play/PlayShell";
import { LiveBar, LiveBetPanel, LastResults, ResultPill } from "@/components/play/LiveBar";
import { ResultBanner } from "@/components/play/ResultBanner";
import { formatChips } from "@/components/common";

const DICE = [null, Dice1, Dice2, Dice3, Dice4, Dice5, Dice6];
const SIDES = [
  { id: "down", label: "Down (2-6)", pays: "2.3x" },
  { id: "seven", label: "Lucky 7", pays: "5.8x" },
  { id: "up", label: "Up (8-12)", pays: "2.3x" },
];

export default function DiceGame({ game }) {
  const { state, countdown, balance, betting, phase, outcome, result, history, placeBet, clearBets, myBets, myTotal, lastResults, placing } =
    useLiveRound(game.slug, {
      formatResult: (s) => ({
        title: s.payout > 0 ? "You won!" : "Not this time",
        subtitle: `Rolled ${s.outcome.dice[0]} + ${s.outcome.dice[1]} = ${s.outcome.total} — ${s.outcome.winner.toUpperCase()}`,
      }),
    });
  const [side, setSide] = useState(null);
  const [amount, setAmount] = useState(50);
  const [anim, setAnim] = useState([3, 4]);

  useEffect(() => {
    if (phase !== "REVEAL") return;
    const t = setInterval(() => setAnim([Math.ceil(Math.random() * 6), Math.ceil(Math.random() * 6)]), 90);
    return () => clearInterval(t);
  }, [phase]);

  const showFinal = !!outcome && (phase === "RESULT" || (phase === "REVEAL" && countdown < 1.2));
  const dice = showFinal ? outcome.dice : phase === "REVEAL" ? anim : [3, 4];
  const [D1, D2] = [DICE[dice[0]], DICE[dice[1]]];
  const rolling = phase === "REVEAL" && !showFinal;

  const sideTotals = {};
  myBets.forEach((b) => {
    sideTotals[b.selection] = (sideTotals[b.selection] || 0) + b.amount;
  });

  return (
    <PlayShell game={game} balance={balance}>
      <LiveBar state={state} countdown={countdown} labels={{ REVEAL: "ROLLING…" }} />

      <div className="rounded-2xl bg-card/55 border border-white/10 p-6 flex flex-col items-center gap-3">
        <div className="flex items-center justify-center gap-5">
          <motion.div animate={rolling ? { rotate: [0, 15, -15, 0] } : {}} transition={{ repeat: rolling ? Infinity : 0, duration: 0.3 }}>
            <D1 className="h-20 w-20 text-primary" strokeWidth={1.4} />
          </motion.div>
          <motion.div animate={rolling ? { rotate: [0, -15, 15, 0] } : {}} transition={{ repeat: rolling ? Infinity : 0, duration: 0.3 }}>
            <D2 className="h-20 w-20 text-[hsl(var(--cyan))]" strokeWidth={1.4} />
          </motion.div>
        </div>
        {showFinal && (
          <p className="text-sm font-bold text-white/80 tabular-nums" data-testid="dice-total">
            {outcome.total} — {outcome.winner.toUpperCase()}
          </p>
        )}
        <LastResults
          items={lastResults}
          render={(r) => <ResultPill label={r.total} tone={r.winner === "seven" ? "gold" : r.winner === "up" ? "magenta" : "cyan"} />}
        />
      </div>

      <div className="grid grid-cols-3 gap-2">
        {SIDES.map((s) => (
          <button
            key={s.id}
            data-testid={`dice-side-${s.id}`}
            onClick={() => setSide(s.id)}
            disabled={!betting}
            className={`relative rounded-xl border p-3 min-h-[64px] text-center transition-[background-color,border-color] duration-150 ${
              side === s.id ? "bg-primary/15 border-primary/50" : "bg-white/5 border-white/10 hover:bg-white/10"
            } ${!betting ? "opacity-70" : ""}`}
          >
            <p className={`text-sm font-bold ${side === s.id ? "text-primary" : "text-white/85"}`}>{s.label}</p>
            <p className="text-[11px] text-white/50 mt-0.5">pays {s.pays}</p>
            {sideTotals[s.id] > 0 && (
              <span className="absolute -top-1.5 -right-1.5 h-6 min-w-6 px-1 rounded-full bg-primary text-primary-foreground text-[9px] font-extrabold flex items-center justify-center border-2 border-yellow-200 shadow-md tabular-nums">
                {formatChips(sideTotals[s.id])}
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
        hint="Universal dice — everyone sees the same roll"
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
