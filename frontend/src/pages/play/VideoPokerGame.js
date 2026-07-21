import { useState, useEffect, useRef } from "react";
import { useLiveRound } from "@/lib/useLiveRound";
import { sfx } from "@/lib/sound";
import { HistoryStrip } from "@/components/play/PlayShell";
import { LiveBetPanel, LastResults, ResultPill } from "@/components/play/LiveBar";
import { FlipCard } from "@/components/play/FlipCard";
import { FitWidth } from "@/components/FitWidth";
import { ResultBanner } from "@/components/play/ResultBanner";
import { GameStage } from "@/components/play/GameStage";
import { CoinShower, WinBurst } from "@/pages/play/slots/slotFx";

// Matches the backend NH_PAYTABLE (house-favorable, ~72% RTP).
const PAYTABLE = [
  ["Royal Flush", "400×"], ["Straight Flush", "90×"], ["Four of a Kind", "45×"], ["Full House", "11×"],
  ["Flush", "7×"], ["Straight", "5×"], ["Three of a Kind", "3×"], ["Two Pair", "2×"], ["Pair", "1.2×"],
];

/**
 * No Hold — five cards dealt and flipped one at a time on the universal clock,
 * then the hand is announced. No holds, no draws: one straight showdown.
 */
export default function VideoPokerGame({ game }) {
  const { state, countdown, balance, betting, phase, outcome, result, history, placeBet, clearBets, myTotal, lastResults, placing, myBets, revealElapsed } =
    useLiveRound(game.slug, {
      formatResult: (s) => ({
        title: s.outcome.hand === "NO WIN" ? "No win" : s.outcome.hand,
        subtitle: s.outcome.multiplier > 0 ? `Pays ${s.outcome.multiplier}×` : "Join the next deal for a paying hand",
        big: (s.outcome.rank ?? 0) >= 6,
      }),
    });
  const [amount, setAmount] = useState(50);

  /* ---------- universal dealing timeline (monotonic server clock) ---------- */
  const elapsed = revealElapsed;
  const DEAL = 0.75;
  const dealt = (i) => !!outcome && elapsed >= 0.2 + i * DEAL;
  const flipped = (i) => !!outcome && elapsed >= 0.2 + i * DEAL + 0.4;
  const showHand = !!outcome && elapsed >= 0.2 + 5 * DEAL + 0.7;

  const dealtCount = !outcome ? 0 : [0, 1, 2, 3, 4].filter((i) => dealt(i)).length;
  const prevRef = useRef(0);
  useEffect(() => {
    if (phase !== "REVEAL") { prevRef.current = 0; return; }
    if (dealtCount > prevRef.current) { sfx.flick && sfx.flick(); if (navigator.vibrate) navigator.vibrate(12); }
    prevRef.current = dealtCount;
  }, [dealtCount, phase]);

  // win celebration once per round when the showdown lands a paying hand
  const isWin = showHand && !!outcome && outcome.multiplier > 0;
  const bigWin = showHand && !!outcome && (outcome.rank ?? 0) >= 6;
  const celebRef = useRef(null);
  const roundNo = state?.round_number;
  useEffect(() => {
    if (!isWin || celebRef.current === roundNo) return;
    celebRef.current = roundNo;
    if (bigWin) { sfx.gong && sfx.gong(); sfx.coinShower && sfx.coinShower(); if (navigator.vibrate) navigator.vibrate([0, 90, 40, 140]); }
    else { sfx.slotBell && sfx.slotBell(); if (navigator.vibrate) navigator.vibrate(50); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isWin, bigWin, roundNo]);

  return (
    <GameStage
      game={game}
      balance={balance}
      live={{ phase, countdown, timings: state?.timings, roundNumber: roundNo }}
      labels={{ REVEAL: "DEALING…" }}
      betDock={
        <div className="space-y-2">
          <LiveBetPanel amount={amount} setAmount={setAmount} onPlace={() => placeBet(null, amount)} betting={betting} placing={placing} label="Join this deal" myTotal={myTotal} />
          {betting && myBets.length > 0 && (
            <button data-testid="live-clear-bets" onClick={clearBets} className="w-full text-[11px] font-bold text-red-400/85 hover:text-red-400">Clear my bets (refund)</button>
          )}
        </div>
      }
      extras={
        <div className="space-y-3">
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
        </div>
      }
    >
      {/* premium felt showdown table */}
      <div
        className={`relative rounded-2xl border-2 p-4 overflow-hidden ${bigWin ? "fg-jackpot-pulse" : ""}`}
        style={{ borderColor: "#c9a227aa", background: "radial-gradient(130% 130% at 50% 0%, #1d8a4f 0%, #14713e 55%, #0c5a2f 100%)", boxShadow: "0 16px 36px rgba(0,0,0,0.5), inset 0 2px 10px rgba(0,0,0,0.3)" }}
        data-testid="nohold-table"
      >
        {isWin && <WinBurst mult={outcome.multiplier} color="#ffd447" showAt={9} />}
        {bigWin && <CoinShower />}
        <p className="text-center text-[9px] font-extrabold tracking-[0.35em] text-[#f0d488] mb-2">★ NO HOLD · SHOWDOWN ★</p>
        <FitWidth>
          <div className="flex gap-1.5">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="rounded-lg" style={{ boxShadow: isWin ? "0 0 14px rgba(255,212,71,0.55)" : "none", transition: "box-shadow 300ms" }}>
                <FlipCard code={outcome ? outcome.cards[i] : null} dealt={dealt(i)} flipped={flipped(i)} />
              </div>
            ))}
          </div>
        </FitWidth>
        {showHand && (
          <p className={`text-center text-base font-extrabold mt-3 ${isWin ? "fg-neon" : "text-white/70"}`} style={{ color: isWin ? "#ffd447" : undefined }} data-testid="nohold-hand">
            {outcome.hand}{outcome.multiplier > 0 ? ` — ${outcome.multiplier}×` : ""}
          </p>
        )}
        {!showHand && (
          <p className="text-[11px] text-white/60 text-center mt-3">One universal 5-card deal — no holds, straight to the showdown</p>
        )}
        <div className="flex justify-center mt-2 relative z-10">
          <LastResults items={lastResults} render={(r) => <ResultPill label={`${r.multiplier}×`} tone={r.multiplier >= 6 ? "gold" : r.multiplier > 0 ? "emerald" : "neutral"} />} />
        </div>
      </div>

      <ResultBanner result={result} />
    </GameStage>
  );
}
