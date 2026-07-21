import { useState, useEffect, useRef } from "react";
import { useLiveRound } from "@/lib/useLiveRound";
import { sfx } from "@/lib/sound";
import { HistoryStrip } from "@/components/play/PlayShell";
import { LiveBetPanel } from "@/components/play/LiveBar";
import { ResultBanner } from "@/components/play/ResultBanner";
import { GameStage } from "@/components/play/GameStage";
import { CoinShower, WinBurst } from "@/pages/play/slots/slotFx";

export default function BingoGame({ game }) {
  const { state, countdown, balance, betting, phase, outcome, result, history, placeBet, clearBets, myBets, myTotal, placing, revealProgress } =
    useLiveRound(game.slug, {
      revealSound: "draw",
      formatResult: (s) => {
        const b = s.bets[0] || {};
        const lines = b.lines || 0;
        return {
          title: lines > 0 ? `${lines} line${lines > 1 ? "s" : ""} — ${b.multiplier}x!` : "No lines",
          subtitle: "30 universal balls drawn from 75",
        };
      },
    });
  const [amount, setAmount] = useState(50);

  const drawnAll = outcome?.drawn || [];
  const shownCount = phase === "RESULT" ? drawnAll.length : Math.floor(revealProgress * drawnAll.length);
  const drawn = new Set(drawnAll.slice(0, shownCount));

  // ball-call sound + haptic as each new ball is revealed
  const prevBalls = useRef(0);
  useEffect(() => {
    if (phase === "BETTING") { prevBalls.current = 0; return; }
    if (shownCount > prevBalls.current) {
      sfx.flick && sfx.flick();
      if (navigator.vibrate) navigator.vibrate(10);
    }
    prevBalls.current = shownCount;
  }, [shownCount, phase]);

  // win celebration once per round
  const isWin = result && result.win;
  const bigWin = result && result.big;
  const celebRef = useRef(null);
  useEffect(() => {
    if (!isWin || celebRef.current === state?.round_number) return;
    celebRef.current = state?.round_number;
    if (bigWin) { sfx.gong && sfx.gong(); sfx.coinShower && sfx.coinShower(); if (navigator.vibrate) navigator.vibrate([0, 90, 40, 140]); }
    else { sfx.slotBell && sfx.slotBell(); if (navigator.vibrate) navigator.vibrate(50); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isWin, bigWin, state?.round_number]);

  const card = myBets.length > 0 ? myBets[0].card : null;
  const grid = card || Array.from({ length: 5 }, (_, r) => Array.from({ length: 5 }, (_, c) => (r === 2 && c === 2 ? 0 : "?")));
  const BINGO_COLS = ["#ff5964", "#ffb347", "#4ade80", "#3ec6e8", "#c084fc"];
  const lastBall = shownCount > 0 ? drawnAll[shownCount - 1] : null;
  const ballLetter = (n) => "BINGO"[Math.min(4, Math.floor((n - 1) / 15))];

  return (
    <GameStage
      game={game}
      balance={balance}
      live={{ phase, countdown, timings: state?.timings, roundNumber: state?.round_number }}
      labels={{ REVEAL: "DRAWING 30 BALLS…" }}
      betDock={
        <div className="space-y-2">
          <LiveBetPanel
            amount={amount}
            setAmount={setAmount}
            onPlace={() => placeBet(null, amount)}
            betting={betting}
            placing={placing}
            disabled={myBets.length > 0}
            label={myBets.length > 0 ? "Card bought for this round" : "Buy a card"}
            myTotal={myTotal}
            hint="Everyone shares the same 30 balls — your card is yours alone"
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
      <div
        className="relative rounded-2xl border-2 p-4 overflow-hidden"
        style={{
          borderColor: "#c9a22766",
          background: "radial-gradient(130% 100% at 50% 0%, #10224a 0%, #0a1430 55%, #060b1c 100%)",
          boxShadow: "0 14px 34px rgba(0,0,0,0.45), inset 0 0 50px rgba(0,0,0,0.35)",
        }}
        data-testid="bingo-board"
      >
        <div aria-hidden="true" className="absolute inset-1.5 rounded-xl pointer-events-none" style={{ border: "1px solid rgba(201,162,39,0.3)" }} />
        {isWin && <WinBurst mult={result.payout} color="#ffd447" showAt={0} />}
        {bigWin && <CoinShower />}
        {/* live ball caller */}
        {phase !== "BETTING" && lastBall != null && (
          <div className="flex items-center justify-center gap-2 mb-3 relative">
            <span className="text-[10px] font-bold tracking-widest text-white/50">NOW CALLING</span>
            <span
              className="fg-line-flash flex items-center justify-center h-11 w-11 rounded-full font-display text-lg text-black tabular-nums"
              style={{ background: "radial-gradient(circle at 35% 30%, #fff6c8, #ffd447 60%, #b8860b)", boxShadow: "0 0 16px rgba(255,212,71,0.9)" }}
            >
              {ballLetter(lastBall)}{lastBall}
            </span>
          </div>
        )}
        <div className="grid grid-cols-5 gap-1 mb-2 relative">
          {["B", "I", "N", "G", "O"].map((l, i) => (
            <div key={l} className="text-center font-display text-xl fg-neon" style={{ color: BINGO_COLS[i] }}>{l}</div>
          ))}
        </div>
        <div className="grid grid-cols-5 gap-1 relative" data-testid="bingo-card">
          {grid.flat().map((v, i) => {
            const free = v === 0;
            const marked = free || (typeof v === "number" && drawn.has(v));
            const justCalled = typeof v === "number" && v === lastBall;
            return (
              <div
                key={i}
                className={`rounded-lg border py-3 min-h-[44px] flex items-center justify-center text-sm font-bold tabular-nums transition-[background-color,box-shadow,transform] duration-200 ${
                  justCalled
                    ? "bg-primary text-primary-foreground border-yellow-200 scale-110 shadow-[0_0_14px_rgba(255,199,64,0.95)]"
                    : marked
                    ? "bg-primary/25 border-primary/60 text-primary shadow-[0_0_8px_rgba(255,199,64,0.4)]"
                    : "bg-white/5 border-white/10 text-white/70"
                }`}
              >
                {free ? "✦" : v}
              </div>
            );
          })}
        </div>
        {!card && <p className="text-[11px] text-white/50 mt-2 text-center">Buy a card during betting to join this universal draw</p>}
        {phase !== "BETTING" && (
          <p className="text-[11px] text-white/50 mt-2 text-center tabular-nums" data-testid="bingo-drawn-count">
            Balls drawn: {shownCount}/30
          </p>
        )}
        <p className="text-[11px] text-white/45 mt-2 text-center">1 line 5× · 2 lines 16× · 3 lines 45× · 4 lines 150× · 5+ lines 400×</p>
      </div>

      <ResultBanner result={result} />
    </GameStage>
  );
}
