import { useState } from "react";
import { motion } from "framer-motion";
import { useLiveRound } from "@/lib/useLiveRound";
import { PlayShell, HistoryStrip } from "@/components/play/PlayShell";
import { LiveBar, LiveBetPanel, LastResults, ResultPill } from "@/components/play/LiveBar";
import { PlayingCard } from "@/components/play/PlayingCard";
import { ResultBanner } from "@/components/play/ResultBanner";
import { formatChips } from "@/components/common";

export default function AndarBaharGame({ game }) {
  const { state, countdown, balance, betting, phase, outcome, result, history, placeBet, clearBets, myBets, myTotal, lastResults, placing, revealProgress } =
    useLiveRound(game.slug, {
      revealSound: "deal",
      formatResult: (s) => ({
        title: s.payout > 0 ? `${s.outcome.winner.toUpperCase()} wins — you called it!` : `${s.outcome.winner.toUpperCase()} wins`,
        subtitle: `Match found after ${s.outcome.sequence.length} card${s.outcome.sequence.length > 1 ? "s" : ""}`,
      }),
    });
  const [side, setSide] = useState(null);
  const [amount, setAmount] = useState(50);

  const sequence = outcome?.sequence || [];
  const shownCount = phase === "RESULT" ? sequence.length : Math.ceil(revealProgress * sequence.length);
  const shown = sequence.slice(0, shownCount);
  const reveal = !!outcome && phase !== "BETTING";

  const sideCards = (s) => shown.filter((c) => c.side === s);
  const sideTotals = {};
  myBets.forEach((b) => {
    sideTotals[b.selection] = (sideTotals[b.selection] || 0) + b.amount;
  });

  return (
    <PlayShell game={game} balance={balance}>
      <LiveBar state={state} countdown={countdown} labels={{ REVEAL: "DEALING…" }} />

      <div className="rounded-2xl bg-card/55 border border-white/10 p-4 space-y-3">
        <div className="flex items-center justify-center gap-3">
          <p className="text-[11px] font-semibold text-white/50">JOKER CARD</p>
          <PlayingCard code={reveal ? outcome.joker : null} size="sm" faceDown={!reveal} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          {["andar", "bahar"].map((s) => (
            <div key={s} className={`rounded-xl border p-2.5 min-h-[110px] ${phase === "RESULT" && outcome?.winner === s ? "border-primary/50 bg-primary/8" : "border-white/10 bg-white/4"}`}>
              <p className={`text-xs font-bold mb-1.5 ${s === "andar" ? "text-[hsl(var(--cyan))]" : "text-[hsl(var(--magenta))]"}`}>{s.toUpperCase()}</p>
              <div className="flex flex-wrap gap-1">
                {sideCards(s).slice(-8).map((c, i) => (
                  <motion.div key={`${s}-${i}-${c.card}`} initial={{ opacity: 0, scale: 0.7 }} animate={{ opacity: 1, scale: 1 }}>
                    <PlayingCard code={c.card} size="sm" />
                  </motion.div>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="flex justify-center">
          <LastResults items={lastResults} render={(r) => <ResultPill label={r.winner === "andar" ? "A" : "B"} tone={r.winner === "andar" ? "cyan" : "magenta"} />} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {[
          { id: "andar", label: "Andar", cls: "text-[hsl(var(--cyan))]" },
          { id: "bahar", label: "Bahar", cls: "text-[hsl(var(--magenta))]" },
        ].map((s) => (
          <button
            key={s.id}
            data-testid={`andar-bahar-side-${s.id}`}
            onClick={() => setSide(s.id)}
            disabled={!betting}
            className={`relative rounded-xl border p-3.5 min-h-[56px] transition-[background-color,border-color] duration-150 ${
              side === s.id ? "bg-primary/12 border-primary/50" : "bg-white/5 border-white/10 hover:bg-white/10"
            } ${!betting ? "opacity-70" : ""}`}
          >
            <p className={`font-display text-lg ${s.cls}`}>{s.label}</p>
            <p className="text-[10px] text-white/45">pays 1.9x</p>
            {sideTotals[s.id] > 0 && (
              <span className="absolute -top-1.5 -right-1.5 h-5 min-w-5 px-1 rounded-full bg-primary text-primary-foreground text-[9px] font-extrabold flex items-center justify-center border border-yellow-200 shadow tabular-nums">
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
        hint="One universal joker + deal per round for all players"
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
