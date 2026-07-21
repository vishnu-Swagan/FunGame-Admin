import { useState, useEffect, useRef } from "react";
import { useLiveRound } from "@/lib/useLiveRound";
import { sfx } from "@/lib/sound";
import { HistoryStrip } from "@/components/play/PlayShell";
import { LiveBetPanel, LastResults, ResultPill } from "@/components/play/LiveBar";
import { FlipCard } from "@/components/play/FlipCard";
import { PlayingCard } from "@/components/play/PlayingCard";
import { ResultBanner } from "@/components/play/ResultBanner";
import { GameStage } from "@/components/play/GameStage";
import { formatChips } from "@/components/common";

/**
 * Andar Bahar with a REAL table flow on the universal clock:
 * the joker is flipped first, then cards are dealt one at a time
 * alternating Andar/Bahar at a natural pace until the joker's rank
 * appears. The matching card is highlighted and the winner announced.
 */
export default function AndarBaharGame({ game }) {
  const { state, countdown, balance, betting, phase, outcome, result, history, placeBet, clearBets, myBets, myTotal, lastResults, placing, revealElapsed } =
    useLiveRound(game.slug, {
      formatResult: (s) => ({
        title: s.payout > 0 ? `${s.outcome.winner.toUpperCase()} wins — you called it!` : `${s.outcome.winner.toUpperCase()} wins`,
        subtitle: `Match found after ${s.outcome.sequence.length} card${s.outcome.sequence.length > 1 ? "s" : ""}`,
      }),
    });
  const [side, setSide] = useState(null);
  const [amount, setAmount] = useState(50);

  /* ---------- universal dealing timeline (monotonic server clock) ---------- */
  const seq = outcome?.sequence || [];
  const revealSecs = state?.timings?.reveal || 16;
  const elapsed = revealElapsed;
  // natural pace, compressed only when the sequence is very long
  const pace = Math.min(0.55, Math.max(0.18, (revealSecs - 3.4) / Math.max(1, seq.length)));
  const jokerFlipped = !!outcome && elapsed >= 0.9;
  const FIRST = 1.7;
  const shownCount = !outcome || elapsed < FIRST ? 0 : Math.min(seq.length, Math.floor((elapsed - FIRST) / pace) + 1);
  const allDealt = !!outcome && shownCount >= seq.length;
  const showWinner = !!outcome && (phase === "RESULT" || elapsed >= FIRST + seq.length * pace + 0.4);
  const shown = seq.slice(0, shownCount);

  // one soft flick per dealt card
  const prevShownRef = useRef(0);
  useEffect(() => {
    if (phase !== "REVEAL") {
      prevShownRef.current = 0;
      return;
    }
    if (shownCount > prevShownRef.current) sfx.flick();
    prevShownRef.current = shownCount;
  }, [shownCount, phase]);
  useEffect(() => {
    if (phase === "REVEAL" && jokerFlipped && prevShownRef.current === 0 && shownCount === 0) sfx.flip();
  }, [jokerFlipped, phase, shownCount]);

  const sideCards = (s) => shown.map((c, i) => ({ ...c, idx: i })).filter((c) => c.side === s);
  const abPays = state?.options || { andar: 1.85, bahar: 1.9 };
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
                <p className="text-[10px] text-white/45">pays {abPays[s.id]}x</p>
                {sideTotals[s.id] > 0 && (
                  <span className="absolute -top-1.5 -right-1.5 h-5 min-w-5 px-1 rounded-full bg-primary text-primary-foreground text-[9px] font-extrabold flex items-center justify-center border border-yellow-200 shadow tabular-nums">
                    {formatChips(sideTotals[s.id])}
                  </span>
                )}
              </button>
            ))}
          </div>
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
        data-testid="andar-bahar-table"
      >
        <div aria-hidden="true" className="fg-noise absolute inset-0 rounded-2xl pointer-events-none" style={{ opacity: 0.06 }} />
        <div aria-hidden="true" className="absolute inset-1.5 rounded-xl pointer-events-none" style={{ border: "1px solid rgba(201,162,39,0.35)" }} />
        <div className="flex items-center justify-center gap-3 relative">
          <p className="text-[11px] font-semibold text-white/70">JOKER CARD</p>
          <FlipCard code={outcome?.joker || null} size="sm" dealt={!!outcome && phase !== "BETTING"} flipped={jokerFlipped} />
          {phase === "REVEAL" && !allDealt && jokerFlipped && (
            <span className="text-[10px] font-bold text-white/45 tabular-nums" data-testid="andar-bahar-dealt-count">
              card {Math.max(0, shownCount)}…
            </span>
          )}
        </div>
        <div className="grid grid-cols-2 gap-3">
          {["andar", "bahar"].map((s) => {
            const cards = sideCards(s);
            const wonHere = showWinner && outcome?.winner === s;
            return (
              <div
                key={s}
                className={`rounded-xl border p-2.5 min-h-[120px] transition-[border-color,background-color] duration-300 ${
                  wonHere ? "border-primary/60 bg-primary/8" : "border-white/10 bg-white/4"
                }`}
              >
                <div className="flex items-center justify-between mb-1.5">
                  <p className={`text-xs font-bold ${s === "andar" ? "text-[hsl(var(--cyan))]" : "text-[hsl(var(--magenta))]"}`}>{s.toUpperCase()}</p>
                  <span className="text-[10px] text-white/40 tabular-nums">{cards.length} card{cards.length === 1 ? "" : "s"}</span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {cards.slice(-9).map((c) => (
                    <FlipCard
                      key={c.idx}
                      code={c.card}
                      size="sm"
                      dealt
                      flipped
                      highlight={c.idx === seq.length - 1 && shownCount >= seq.length}
                    />
                  ))}
                  {cards.length === 0 && phase !== "BETTING" && <PlayingCard faceDown size="sm" />}
                </div>
                {wonHere && (
                  <p className="text-[10px] font-extrabold tracking-wider text-primary mt-1.5">MATCH — {s.toUpperCase()} WINS</p>
                )}
              </div>
            );
          })}
        </div>
        <div className="flex justify-center">
          <LastResults items={lastResults} render={(r) => <ResultPill label={r.winner === "andar" ? "A" : "B"} tone={r.winner === "andar" ? "cyan" : "magenta"} />} />
        </div>
      </div>
      </div>

      <ResultBanner result={result} />
    </GameStage>
  );
}
