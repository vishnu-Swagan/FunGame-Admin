import { useState } from "react";
import { motion } from "framer-motion";
import { useLiveRound } from "@/lib/useLiveRound";
import { PlayShell, HistoryStrip } from "@/components/play/PlayShell";
import { LiveBar, LiveBetPanel, LastResults, ResultPill } from "@/components/play/LiveBar";
import { ResultBanner } from "@/components/play/ResultBanner";

const SEGMENTS = [0, 1.5, 2, 3, 5, 10, 20, 50];

export default function WheelGame({ game }) {
  const { state, countdown, balance, betting, phase, outcome, result, history, placeBet, clearBets, myTotal, lastResults, placing, myBets } =
    useLiveRound(game.slug, {
      revealSound: "spin",
      formatResult: (s) => ({
        title: s.outcome.multiplier > 0 ? `Golden ${s.outcome.multiplier}x!` : "Blank segment",
        subtitle: s.outcome.multiplier > 0 ? "The wheel shines on you" : "Join the next spin for the gold",
      }),
    });
  const [amount, setAmount] = useState(50);

  const showFinal = !!outcome && (phase === "RESULT" || (phase === "REVEAL" && countdown < 1.4));
  const spinning = phase === "REVEAL" && !showFinal;
  const landed = showFinal ? outcome.multiplier : null;

  return (
    <PlayShell game={game} balance={balance}>
      <LiveBar state={state} countdown={countdown} labels={{ REVEAL: "SPINNING…" }} />

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
        <LastResults items={lastResults} render={(r) => <ResultPill label={`${r.multiplier}x`} tone={r.multiplier > 0 ? "gold" : "neutral"} />} />
      </div>

      <ResultBanner result={result} />
      <LiveBetPanel
        amount={amount}
        setAmount={setAmount}
        onPlace={() => placeBet(null, amount)}
        betting={betting}
        placing={placing}
        label="Join this spin"
        myTotal={myTotal}
        hint="One universal wheel spin per round — your stake pays the landed multiplier"
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
