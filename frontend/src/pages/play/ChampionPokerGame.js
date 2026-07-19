import { useState, useEffect, useRef } from "react";
import { useLiveRound } from "@/lib/useLiveRound";
import { sfx } from "@/lib/sound";
import { PlayShell, HistoryStrip } from "@/components/play/PlayShell";
import { LiveBar, LiveBetPanel, LastResults, ResultPill } from "@/components/play/LiveBar";
import { FlipCard } from "@/components/play/FlipCard";
import { ResultBanner } from "@/components/play/ResultBanner";

/**
 * Champion Poker with a REAL hold-and-draw flow on the universal clock:
 * 1) five cards are dealt and flipped one by one,
 * 2) the house marks its HOLDs,
 * 3) discarded cards flip face-down and are redrawn one at a time,
 * 4) the final hand is announced.
 */
export default function ChampionPokerGame({ game }) {
  const { state, countdown, balance, betting, phase, outcome, result, history, placeBet, clearBets, myTotal, lastResults, placing, myBets } =
    useLiveRound(game.slug, {
      formatResult: (s) => ({
        title: s.outcome.hand === "NO WIN" ? "No win" : s.outcome.hand,
        subtitle: s.outcome.multiplier > 0 ? `Pays ${s.outcome.multiplier}x` : "The dealer drew a cold hand",
      }),
    });
  const [amount, setAmount] = useState(50);

  /* ---------- universal dealing timeline ---------- */
  const revealSecs = state?.timings?.reveal || 14;
  const elapsed = phase === "RESULT" ? 999 : phase === "REVEAL" ? Math.max(0, revealSecs - countdown) : 0;
  const DEAL = 0.7;
  const holds = outcome?.holds || [];
  const drawIdx = holds.map((h, i) => (h ? null : i)).filter((v) => v !== null);
  const holdsAt = 0.2 + 5 * DEAL + 0.7; // house marks holds
  const swapAt = holdsAt + 1.6; // discards flip face-down
  const redrawTime = (i) => swapAt + 0.9 + drawIdx.indexOf(i) * 0.65;
  const handAt = swapAt + 0.9 + drawIdx.length * 0.65 + 0.5;

  const dealt = (i) => !!outcome && elapsed >= 0.2 + i * DEAL;
  const showHolds = !!outcome && elapsed >= holdsAt;
  const showHand = !!outcome && elapsed >= handAt;
  const cardCode = (i) => {
    if (!outcome) return null;
    if (holds[i]) return outcome.initial[i];
    return elapsed >= redrawTime(i) ? outcome.cards[i] : outcome.initial[i];
  };
  const cardFlipped = (i) => {
    if (!outcome) return false;
    if (elapsed < 0.2 + i * DEAL + 0.4) return false;
    if (!holds[i] && elapsed >= swapAt && elapsed < redrawTime(i)) return false; // discarded, waiting for the redraw
    return true;
  };

  // sounds: flick per dealt/redrawn card, tick when holds appear
  const dealtCount = !outcome ? 0 : [0, 1, 2, 3, 4].filter((i) => dealt(i)).length;
  const redrawnCount = !outcome ? 0 : drawIdx.filter((i) => elapsed >= redrawTime(i)).length;
  const prevRef = useRef({ d: 0, r: 0, h: false });
  useEffect(() => {
    if (phase !== "REVEAL") {
      prevRef.current = { d: 0, r: 0, h: false };
      return;
    }
    const p = prevRef.current;
    if (dealtCount > p.d || redrawnCount > p.r) sfx.flick();
    if (showHolds && !p.h) sfx.hold();
    prevRef.current = { d: dealtCount, r: redrawnCount, h: showHolds };
  }, [dealtCount, redrawnCount, showHolds, phase]);

  return (
    <PlayShell game={game} balance={balance}>
      <LiveBar state={state} countdown={countdown} labels={{ REVEAL: "HOLD & DRAW…" }} />

      <div className="rounded-2xl bg-card/55 border border-white/10 p-4">
        <div className="flex gap-1.5 justify-center">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="flex flex-col items-center gap-1">
              <FlipCard code={cardCode(i)} dealt={dealt(i)} flipped={cardFlipped(i)} highlight={showHolds && !showHand && holds[i]} />
              <span className={`text-[9px] font-bold tracking-wider min-h-[12px] ${showHolds && !showHand ? (holds[i] ? "text-primary" : "text-white/35") : "text-transparent"}`}>
                {showHolds && !showHand ? (holds[i] ? "HELD" : "DRAW") : "·"}
              </span>
            </div>
          ))}
        </div>
        {showHand && (
          <p className="text-center text-sm font-bold text-white/85 mt-1" data-testid="champion-hand">
            {outcome.hand}
            {outcome.multiplier > 0 ? ` — ${outcome.multiplier}x` : ""}
          </p>
        )}
        <p className="text-[11px] text-white/45 text-center mt-2">
          Universal live deal — the house holds the best cards, discards and redraws. Same cards for every player, in real time.
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
