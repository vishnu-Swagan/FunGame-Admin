import { useState } from "react";
import { motion } from "framer-motion";
import { useLiveRound } from "@/lib/useLiveRound";
import { PlayShell, HistoryStrip } from "@/components/play/PlayShell";
import { LiveBar, LiveBetPanel, LastResults, ResultPill } from "@/components/play/LiveBar";
import { PlayingCard } from "@/components/play/PlayingCard";
import { ResultBanner } from "@/components/play/ResultBanner";
import { formatChips } from "@/components/common";

export default function CardDuelGame({ game }) {
  const { state, countdown, balance, betting, phase, outcome, result, history, placeBet, clearBets, myBets, myTotal, lastResults, placing } =
    useLiveRound(game.slug, {
      formatResult: (s) => {
        const push = s.bets.length > 0 && s.bets.every((b) => b.result === "push");
        return {
          push,
          title: push ? "Push — stake returned" : s.payout > 0 ? `${s.outcome.winner.toUpperCase()} wins — you called it!` : `${s.outcome.winner.toUpperCase()} wins`,
          subtitle: `Player: ${s.outcome.player_hand} · Dealer: ${s.outcome.dealer_hand}`,
        };
      },
    });
  const [side, setSide] = useState(null);
  const [amount, setAmount] = useState(50);
  const nCards = game.slug === "teen-patti" ? 3 : 5;
  const options = state?.options || { player: 1.95, dealer: 1.95, tie: game.slug === "teen-patti" ? 8 : 20 };

  const reveal = !!outcome && phase !== "BETTING";

  const sideTotals = {};
  myBets.forEach((b) => {
    sideTotals[b.selection] = (sideTotals[b.selection] || 0) + b.amount;
  });

  const Row = ({ label, cards, hand, highlight }) => (
    <div>
      <p className="text-[11px] font-semibold text-white/50 mb-1.5">{label}{hand ? ` — ${hand}` : ""}</p>
      <div className="flex gap-1.5">
        {(cards || Array(nCards).fill(null)).map((c, i) => (
          <motion.div key={`${label}-${i}-${c || "x"}`} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.1 }}>
            <PlayingCard code={c} size={nCards === 3 ? "lg" : "md"} dimmed={highlight === false} />
          </motion.div>
        ))}
      </div>
    </div>
  );

  return (
    <PlayShell game={game} balance={balance}>
      <LiveBar state={state} countdown={countdown} labels={{ REVEAL: "DEALING…" }} />

      <div className="rounded-2xl bg-card/55 border border-white/10 p-4 space-y-4">
        <Row label="Dealer" cards={reveal ? outcome.dealer : null} hand={reveal ? outcome.dealer_hand : null} highlight={reveal ? outcome.winner === "dealer" : undefined} />
        <div className="border-t border-white/8" />
        <Row label="Player" cards={reveal ? outcome.player : null} hand={reveal ? outcome.player_hand : null} highlight={reveal ? outcome.winner === "player" : undefined} />
        <div className="flex items-center justify-between">
          <p className="text-[11px] text-white/45">Back player, dealer or tie — one universal deal per round</p>
          <LastResults
            items={lastResults.slice(0, 6)}
            render={(r) => (
              <ResultPill
                label={r.winner === "player" ? "P" : r.winner === "dealer" ? "D" : "T"}
                tone={r.winner === "player" ? "cyan" : r.winner === "dealer" ? "magenta" : "gold"}
              />
            )}
          />
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2">
        {[
          { id: "player", label: "Player", cls: "text-[hsl(var(--cyan))]" },
          { id: "tie", label: "Tie", cls: "text-primary" },
          { id: "dealer", label: "Dealer", cls: "text-[hsl(var(--magenta))]" },
        ].map((s) => (
          <button
            key={s.id}
            data-testid={`duel-side-${s.id}`}
            onClick={() => setSide(s.id)}
            disabled={!betting}
            className={`relative rounded-xl border p-3 min-h-[60px] transition-[background-color,border-color] duration-150 ${side === s.id ? "bg-primary/12 border-primary/50" : "bg-white/5 border-white/10 hover:bg-white/10"} ${!betting ? "opacity-70" : ""}`}
          >
            <p className={`font-display text-base ${s.cls}`}>{s.label}</p>
            <p className="text-[10px] text-white/45">pays {options[s.id]}x</p>
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
        hint="Player/Dealer side bets push on a tie"
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
