import { useState, useEffect, useRef } from "react";
import { useLiveRound } from "@/lib/useLiveRound";
import { sfx } from "@/lib/sound";
import { PlayShell, HistoryStrip } from "@/components/play/PlayShell";
import { LiveBar, LiveBetPanel, LastResults, ResultPill } from "@/components/play/LiveBar";
import { FlipCard } from "@/components/play/FlipCard";
import { ResultBanner } from "@/components/play/ResultBanner";

const PAYTABLE = [
  ["Royal Flush", "300x"], ["Straight Flush", "60x"], ["Four of a Kind", "30x"], ["Full House", "10x"],
  ["Flush", "7x"], ["Straight", "5x"], ["Three of a Kind", "4x"], ["Two Pair", "3x"], ["Jacks or Better", "2x"],
];

/**
 * No Hold - five cards dealt and flipped one at a time on the universal
 * clock, then the hand is announced. No rushing, real table pace.
 */
export default function VideoPokerGame({ game }) {
  const { state, countdown, balance, betting, phase, outcome, result, history, placeBet, clearBets, myTotal, lastResults, placing, myBets } =
    useLiveRound(game.slug, {
      formatResult: (s) => ({
        title: s.outcome.hand === "NO WIN" ? "No win" : s.outcome.hand,
        subtitle: s.outcome.multiplier > 0 ? `Pays ${s.outcome.multiplier}x` : "Join the next deal for a paying hand",
      }),
    });
  const [amount, setAmount] = useState(50);

  /* ---------- universal dealing timeline ---------- */
  const revealSecs = state?.timings?.reveal || 8;
  const elapsed = phase === "RESULT" ? 999 : phase === "REVEAL" ? Math.max(0, revealSecs - countdown) : 0;
  const DEAL = 0.75;
  const dealt = (i) => !!outcome && elapsed >= 0.2 + i * DEAL;
  const flipped = (i) => !!outcome && elapsed >= 0.2 + i * DEAL + 0.4;
  const showHand = !!outcome && elapsed >= 0.2 + 5 * DEAL + 0.7;

  const dealtCount = !outcome ? 0 : [0, 1, 2, 3, 4].filter((i) => dealt(i)).length;
  const prevRef = useRef(0);
  useEffect(() => {
    if (phase !== "REVEAL") {
      prevRef.current = 0;
      return;
    }
    if (dealtCount > prevRef.current) sfx.flick();
    prevRef.current = dealtCount;
  }, [dealtCount, phase]);

  return (
    <PlayShell game={game} balance={balance}>
      <LiveBar state={state} countdown={countdown} labels={{ REVEAL: "DEALING…" }} />

      <div className="rounded-2xl bg-card/55 border border-white/10 p-4">
        <div className="flex gap-1.5 justify-center">
          {[0, 1, 2, 3, 4].map((i) => (
            <FlipCard key={i} code={outcome ? outcome.cards[i] : null} dealt={dealt(i)} flipped={flipped(i)} />
          ))}
        </div>
        {showHand && (
          <p className="text-center text-sm font-bold text-white/85 mt-2" data-testid="nohold-hand">
            {outcome.hand}
            {outcome.multiplier > 0 ? ` — ${outcome.multiplier}x` : ""}
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
