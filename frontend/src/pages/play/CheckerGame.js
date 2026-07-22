import { useState, useEffect, useRef } from "react";
import { Crown, X } from "lucide-react";
import { useLiveRound } from "@/lib/useLiveRound";
import { HistoryStrip } from "@/components/play/PlayShell";
import { LiveBetPanel, LastResults, ResultPill } from "@/components/play/LiveBar";
import { ResultBanner } from "@/components/play/ResultBanner";
import { GameStage } from "@/components/play/GameStage";

const DISC = {
  gold: { face: "radial-gradient(circle at 35% 28%, #ffe9ad, #ffca3a 55%, #a9781a)", ring: "rgba(122,82,0,0.55)", border: "#b8860b", crown: "#7a5200", label: "#ffd447" },
  steel: { face: "radial-gradient(circle at 35% 28%, #eef2f7, #9aa7b8 55%, #566173)", ring: "rgba(43,50,64,0.6)", border: "#47505f", crown: "#2b3240", label: "#cbd5e1" },
};

/** A single king checker piece; when captured it dims, shrinks and shows an X. */
const Disc = ({ side, captured, flash }) => {
  const c = DISC[side];
  return (
    <div className={`relative h-8 w-8 rounded-full transition-all duration-300 ${captured ? "opacity-30 scale-[0.72] grayscale" : flash ? "fg-checker-jump" : ""}`}
      style={{ background: c.face, border: `2px solid ${c.border}`, boxShadow: captured ? "none" : "0 4px 10px rgba(0,0,0,0.5), inset 0 -2px 5px rgba(0,0,0,0.35), inset 0 2px 4px rgba(255,255,255,0.5)" }}
    >
      <span className="absolute inset-[3px] rounded-full pointer-events-none" style={{ border: `2px solid ${c.ring}` }} />
      <span className="absolute inset-0 flex items-center justify-center">
        <Crown className="h-3.5 w-3.5" style={{ color: c.crown }} />
      </span>
      {captured && (
        <span className="absolute inset-0 flex items-center justify-center">
          <X className="h-4 w-4 text-red-500" strokeWidth={3} />
        </span>
      )}
      {flash && <span aria-hidden className="fg-checker-burst absolute -inset-1.5 rounded-full" style={{ background: "radial-gradient(circle, rgba(255,90,90,0.8), transparent 70%)" }} />}
    </div>
  );
};

/** One side's army row — pieces get captured left-to-right as the duel plays. */
const Army = ({ side, removed, pieces, isWinner, flashLatest }) => {
  const c = DISC[side];
  return (
    <div className={`rounded-xl px-3 py-2 transition-[background-color,box-shadow] duration-300 ${isWinner ? (side === "gold" ? "bg-primary/10 shadow-[0_0_26px_rgba(255,199,64,0.4)]" : "bg-white/10 shadow-[0_0_26px_rgba(255,255,255,0.22)]") : ""}`} data-testid={`checker-${side}`}>
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[11px] font-extrabold tracking-widest" style={{ color: c.label }}>{side.toUpperCase()}{isWinner ? " ♚" : ""}</span>
        <span className="text-[10px] text-white/45 tabular-nums">{pieces - removed} left</span>
      </div>
      <div className="flex gap-1.5 justify-center">
        {Array.from({ length: pieces }, (_, i) => (
          <Disc key={i} side={side} captured={i < removed} flash={flashLatest && i === removed - 1} />
        ))}
      </div>
    </div>
  );
};

export default function CheckerGame({ game }) {
  const { state, countdown, balance, betting, phase, outcome, result, history, placeBet, clearBets, myBets, myTotal, lastResults, placing, revealProgress } =
    useLiveRound(game.slug, {
      revealSound: "draw",
      formatResult: (s) => ({
        title: `${s.outcome.winner.toUpperCase()} clears the board!`,
        subtitle: `Captures — Gold ${s.outcome.gold} : Steel ${s.outcome.steel}`,
        big: s.payout > 0,
      }),
    });
  const [side, setSide] = useState(null);
  const [amount, setAmount] = useState(50);

  const rounds = outcome?.rounds || [];
  const shownCount = phase === "RESULT" ? rounds.length : Math.floor(revealProgress * rounds.length);
  const shown = rounds.slice(0, shownCount);

  // capture haptic as each new jump lands during the reveal
  const prevShown = useRef(0);
  useEffect(() => {
    if (phase === "BETTING") { prevShown.current = 0; return; }
    if (shownCount > prevShown.current && navigator.vibrate) navigator.vibrate(14);
    prevShown.current = shownCount;
  }, [shownCount, phase]);

  const sideTotals = {};
  myBets.forEach((b) => {
    sideTotals[b.selection] = (sideTotals[b.selection] || 0) + b.amount;
  });

  return (
    <GameStage
      game={game}
      balance={balance}
      live={{ phase, countdown, timings: state?.timings, roundNumber: state?.round_number }}
      labels={{ REVEAL: "CAPTURING…" }}
      betDock={
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            {[
              { id: "gold", label: "Gold", cls: "text-primary" },
              { id: "steel", label: "Steel", cls: "text-white/85" },
            ].map((s) => (
              <button
                key={s.id}
                data-testid={`checker-side-${s.id}`}
                onClick={() => setSide(s.id)}
                disabled={!betting}
                className={`relative rounded-xl border p-3.5 min-h-[56px] transition-[background-color,border-color] duration-150 ${side === s.id ? "bg-primary/12 border-primary/50" : "bg-white/5 border-white/10 hover:bg-white/10"} ${!betting ? "opacity-70" : ""}`}
              >
                <p className={`font-display text-lg ${s.cls}`}>{s.label}</p>
                <p className="text-[10px] text-white/45">pays 1.4x</p>
                {sideTotals[s.id] > 0 && (
                  <span className="absolute -top-1.5 -right-1.5 h-5 min-w-5 px-1 rounded-full bg-primary text-primary-foreground text-[9px] font-extrabold flex items-center justify-center border border-yellow-200 shadow tabular-nums">
                    {sideTotals[s.id]}
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
      {/* ---- Checkers capture duel: real board + two armies cleared piece-by-piece ---- */}
      <div style={{ perspective: "1200px" }}>
      <div
        className="relative mx-auto rounded-2xl border-2 p-4 overflow-hidden"
        style={{
          borderColor: "#c9a22788",
          background: "#0c3a1e",
          transform: "rotateX(6deg)",
          transformStyle: "preserve-3d",
          boxShadow: "0 20px 44px rgba(0,0,0,0.5), inset 0 0 70px rgba(0,0,0,0.45)",
        }}
        data-testid="checker-table"
      >
        {/* checkerboard surface */}
        <div aria-hidden="true" className="absolute inset-0 rounded-2xl pointer-events-none" style={{
          opacity: 0.55,
          backgroundImage: "linear-gradient(45deg, #0a2c17 25%, transparent 25%, transparent 75%, #0a2c17 75%), linear-gradient(45deg, #0a2c17 25%, transparent 25%, transparent 75%, #0a2c17 75%)",
          backgroundSize: "46px 46px",
          backgroundPosition: "0 0, 23px 23px",
        }} />
        <div aria-hidden="true" className="absolute inset-1.5 rounded-xl pointer-events-none" style={{ border: "1px solid rgba(201,162,39,0.35)" }} />
        {(() => {
          // gold's captures remove STEEL pieces (and vice-versa)
          const goldCaps = shown.filter((w) => w === "gold").length;
          const steelCaps = shown.filter((w) => w === "steel").length;
          const pieces = outcome?.pieces || 6;
          const showWinner = phase === "RESULT" && !!outcome;
          const winner = outcome?.winner;
          const latest = phase === "REVEAL" && shownCount > 0 ? shown[shownCount - 1] : null;
          return (
            <div className="relative space-y-2.5">
              {/* STEEL army (pieces removed = gold's captures) */}
              <Army side="steel" pieces={pieces} removed={goldCaps} isWinner={showWinner && winner === "steel"} flashLatest={latest === "gold"} />

              {/* capture scoreboard */}
              <div className="flex flex-col items-center gap-1 py-0.5">
                <div className="flex items-center gap-3">
                  <span className="font-display text-2xl tabular-nums leading-none" style={{ color: "#ffd447" }}>{goldCaps}</span>
                  <span className="text-[9px] font-bold tracking-[0.3em] text-white/40">CAPTURES</span>
                  <span className="font-display text-2xl tabular-nums leading-none" style={{ color: "#e2e8f0" }}>{steelCaps}</span>
                </div>
                <p className="text-[10px] text-white/55 min-h-[14px]">
                  {showWinner ? `${winner.toUpperCase()} clears the board!` : latest ? `${latest.toUpperCase()} captures!` : "Duel begins…"}
                </p>
              </div>

              {/* GOLD army (pieces removed = steel's captures) */}
              <Army side="gold" pieces={pieces} removed={steelCaps} isWinner={showWinner && winner === "gold"} flashLatest={latest === "steel"} />
            </div>
          );
        })()}
        <p className="text-[11px] text-white/45 text-center mt-3 relative">Winning side pays 1.4x · first to clear the board wins</p>
        <div className="flex justify-center mt-2 relative">
          <LastResults items={lastResults} render={(r) => <ResultPill label={r.winner === "gold" ? "G" : "S"} tone={r.winner === "gold" ? "gold" : "neutral"} />} />
        </div>
      </div>
      </div>

      <ResultBanner result={result} />
    </GameStage>
  );
}
