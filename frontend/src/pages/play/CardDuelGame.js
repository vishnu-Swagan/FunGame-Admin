import { useState, useEffect, useRef } from "react";
import { useLiveRound } from "@/lib/useLiveRound";
import { sfx } from "@/lib/sound";
import { HistoryStrip } from "@/components/play/PlayShell";
import { LiveBetPanel, LastResults, ResultPill } from "@/components/play/LiveBar";
import { FlipCard } from "@/components/play/FlipCard";
import { FitWidth } from "@/components/FitWidth";
import { ResultBanner } from "@/components/play/ResultBanner";
import { GameStage } from "@/components/play/GameStage";
import { formatChips } from "@/components/common";

/**
 * Teen Patti / Poker duel with a REAL dealing flow, driven entirely by the
 * universal server clock: cards are dealt face-down one at a time
 * (alternating player/dealer), then flipped one by one, then hands and the
 * winner are announced. Every player worldwide sees the same card at the
 * same moment.
 */

/* Module-level seat row: keeps a STABLE component identity so React never
   remounts the cards between countdown ticks (remounting caused the cards
   to constantly re-run their deal animation = flicker/ghosting bug). */
const SeatRow = ({ label, seat, cards, hand, nCards, outcome, showHands, winner, dealtFn, flipFn }) => {
  const isWinner = showHands && winner === seat;
  const isLoser = showHands && winner !== seat && winner !== "tie";
  return (
    <div className={`rounded-xl p-2 -m-2 transition-[background-color] duration-300 ${isWinner ? "bg-[hsl(var(--emerald)/0.07)]" : ""}`}>
      <div className="flex items-center gap-2 mb-1.5 min-h-[18px]">
        <p className="text-[11px] font-semibold text-white/50">{label}</p>
        {showHands && hand && <span className="text-[11px] font-bold text-primary">{hand}</span>}
        {isWinner && (
          <span className="text-[9px] font-extrabold tracking-wider text-[hsl(var(--emerald))] border border-[hsl(var(--emerald)/0.4)] bg-[hsl(var(--emerald)/0.12)] rounded-full px-1.5 py-0.5">
            WINNER
          </span>
        )}
      </div>
      <FitWidth>
        <div className="flex gap-1.5">
          {Array.from({ length: nCards }, (_, i) => (
            <FlipCard
              key={i}
              code={outcome ? cards[i] : null}
              size={nCards === 3 ? "lg" : "md"}
              dealt={dealtFn(i)}
              flipped={flipFn(i)}
              dim={isLoser}
            />
          ))}
        </div>
      </FitWidth>
    </div>
  );
};

export default function CardDuelGame({ game }) {
  const nCards = game.slug === "teen-patti" ? 3 : 5;
  const { state, countdown, balance, betting, phase, outcome, result, history, placeBet, clearBets, myBets, myTotal, lastResults, placing, revealElapsed } =
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
  const options = state?.options || { player: 1.9, dealer: 1.9, tie: game.slug === "teen-patti" ? 8 : 20 };

  /* ---------- universal dealing timeline (monotonic server clock) ---------- */
  const elapsed = revealElapsed;
  const DEAL = nCards === 3 ? 0.6 : 0.5; // seconds per card dealt
  const FLIP = nCards === 3 ? 0.65 : 0.5; // seconds per card flipped
  const START = 0.2;
  const dealDone = START + 2 * nCards * DEAL;
  const dealtP = (i) => !!outcome && elapsed >= START + 2 * i * DEAL + 0.01;
  const dealtD = (i) => !!outcome && elapsed >= START + (2 * i + 1) * DEAL;
  const flipP = (i) => !!outcome && elapsed >= dealDone + 0.5 + i * FLIP;
  const flipD = (i) => !!outcome && elapsed >= dealDone + 0.5 + nCards * FLIP + 0.4 + i * FLIP;
  const showHands = !!outcome && elapsed >= dealDone + 0.9 + 2 * nCards * FLIP;
  const winner = outcome?.winner;

  // one soft flick per dealt card
  const dealtTotal = !outcome
    ? 0
    : Array.from({ length: nCards }).reduce((acc, _, i) => acc + (dealtP(i) ? 1 : 0) + (dealtD(i) ? 1 : 0), 0);
  const prevDealtRef = useRef(0);
  useEffect(() => {
    if (phase !== "REVEAL") {
      prevDealtRef.current = 0;
      return;
    }
    if (dealtTotal > prevDealtRef.current) sfx.flick();
    prevDealtRef.current = dealtTotal;
  }, [dealtTotal, phase]);

  const sideTotals = {};
  myBets.forEach((b) => {
    sideTotals[b.selection] = (sideTotals[b.selection] || 0) + b.amount;
  });

  return (
    <GameStage
      game={game}
      balance={balance}
      live={{ phase, countdown, timings: state?.timings, roundNumber: state?.round_number }}
      labels={{ REVEAL: "DEALING…" }}
      betDock={
        <div className="space-y-2">
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
          <p className="text-[11px] text-white/45 text-center">Player/Dealer pay 1.90x (5% house commission). A tie is a house win — only the Tie bet wins on a tie.</p>
          <LiveBetPanel
            amount={amount}
            setAmount={setAmount}
            onPlace={() => side && placeBet(side, amount)}
            betting={betting}
            placing={placing}
            disabled={!side}
            label={side ? `Bet ${side.toUpperCase()}` : "Pick a side first"}
            myTotal={myTotal}
            hint="Player/Dealer pay 1.90x · a tie is a house win"
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
        className="relative rounded-2xl border-2 p-4 space-y-3 overflow-hidden"
        style={{
          borderColor: "#c9a22788",
          background: "radial-gradient(120% 95% at 50% 25%, #167d3e 0%, #0f5f2e 48%, #093c1e 100%)",
          transform: "rotateX(5deg)",
          transformStyle: "preserve-3d",
          boxShadow: "0 20px 44px rgba(0,0,0,0.5), inset 0 0 70px rgba(0,0,0,0.4)",
        }}
        data-testid="duel-table"
      >
        {/* felt texture + inner gold trim */}
        <div aria-hidden="true" className="fg-noise absolute inset-0 rounded-2xl pointer-events-none" style={{ opacity: 0.06 }} />
        <div aria-hidden="true" className="absolute inset-1.5 rounded-xl pointer-events-none" style={{ border: "1px solid rgba(201,162,39,0.35)" }} />
        <SeatRow
          label="Dealer"
          seat="dealer"
          cards={outcome?.dealer || []}
          hand={outcome?.dealer_hand}
          nCards={nCards}
          outcome={outcome}
          showHands={showHands}
          winner={winner}
          dealtFn={dealtD}
          flipFn={flipD}
        />
        <div className="relative border-t border-white/8">
          {showHands && winner === "tie" && (
            <span className="absolute left-1/2 -translate-x-1/2 -top-2.5 text-[9px] font-extrabold tracking-widest text-primary border border-primary/40 bg-black/60 rounded-full px-2 py-0.5">
              TIE
            </span>
          )}
        </div>
        <SeatRow
          label="Player"
          seat="player"
          cards={outcome?.player || []}
          hand={outcome?.player_hand}
          nCards={nCards}
          outcome={outcome}
          showHands={showHands}
          winner={winner}
          dealtFn={dealtP}
          flipFn={flipP}
        />
        <div className="flex items-center justify-between">
          <p className="text-[11px] text-white/45">One universal deal per round — dealt live, card by card</p>
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
      </div>

      <ResultBanner result={result} />
    </GameStage>
  );
}
