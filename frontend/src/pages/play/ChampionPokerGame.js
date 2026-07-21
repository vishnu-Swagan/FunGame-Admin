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

/**
 * Champion Poker with a REAL hold-and-draw flow on the universal clock:
 * 1) five cards are dealt and flipped one by one,
 * 2) the house marks its HOLDs,
 * 3) discarded cards flip face-down and are redrawn one at a time,
 * 4) the final hand is announced.
 */
export default function ChampionPokerGame({ game }) {
  const { state, countdown, balance, betting, phase, outcome, result, history, placeBet, clearBets, myTotal, lastResults, placing, myBets, revealElapsed } =
    useLiveRound(game.slug, {
      formatResult: (s) => ({
        title: s.outcome.hand === "NO WIN" ? "No win" : s.outcome.hand,
        subtitle: s.outcome.multiplier > 0 ? `Pays ${s.outcome.multiplier}x` : "The dealer drew a cold hand",
      }),
    });
  const [amount, setAmount] = useState(50);

  /* ---------- universal dealing timeline (monotonic server clock) ---------- */
  const elapsed = revealElapsed;
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

  const isWin = showHand && outcome.multiplier > 0;
  const roundNo = state?.round_number || 0;
  const winKeyRef = useRef(null);
  useEffect(() => {
    if (!isWin || winKeyRef.current === roundNo) return;
    winKeyRef.current = roundNo;
    if (outcome.multiplier >= 8) { sfx.gong(); sfx.coinShower(); }
    else sfx.slotBell();
  }, [isWin, outcome, roundNo]);

  return (
    <GameStage
      game={game}
      balance={balance}
      live={{ phase, countdown, timings: state?.timings, roundNumber: state?.round_number }}
      labels={{ REVEAL: "HOLD & DRAW…" }}
      betDock={
        <div className="space-y-2">
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
        </div>
      }
      extras={<HistoryStrip history={history} />}
    >
      {/* ---- cinematic casino felt table (3D tilt + gold rail) ---- */}
      <div style={{ perspective: "1200px" }}>
      <div
        className={`relative rounded-2xl border-2 p-4 overflow-hidden ${isWin && outcome.multiplier >= 8 ? "fg-jackpot-pulse" : ""}`}
        style={{
          borderColor: "#c9a22788",
          background: "radial-gradient(120% 95% at 50% 25%, #167d3e 0%, #0f5f2e 48%, #093c1e 100%)",
          transform: "rotateX(5deg)",
          transformStyle: "preserve-3d",
          boxShadow: "0 20px 44px rgba(0,0,0,0.5), inset 0 0 70px rgba(0,0,0,0.4)",
        }}
        data-testid="champion-table"
      >
        <div aria-hidden="true" className="fg-noise absolute inset-0 rounded-2xl pointer-events-none" style={{ opacity: 0.06 }} />
        <div aria-hidden="true" className="absolute inset-1.5 rounded-xl pointer-events-none" style={{ border: "1px solid rgba(201,162,39,0.35)" }} />
        {isWin && <WinBurst mult={outcome.multiplier} color="#ffd447" showAt={5} />}
        {isWin && outcome.multiplier >= 8 && <CoinShower />}
        <FitWidth>
          <div className="flex gap-1.5">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="flex flex-col items-center gap-1">
                <FlipCard code={cardCode(i)} dealt={dealt(i)} flipped={cardFlipped(i)} highlight={showHolds && !showHand && holds[i]} />
                <span className={`text-[9px] font-bold tracking-wider min-h-[12px] ${showHolds && !showHand ? (holds[i] ? "text-primary" : "text-white/35") : "text-transparent"}`}>
                  {showHolds && !showHand ? (holds[i] ? "HELD" : "DRAW") : "·"}
                </span>
              </div>
            ))}
          </div>
        </FitWidth>
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
      </div>

      <ResultBanner result={result} />
    </GameStage>
  );
}
