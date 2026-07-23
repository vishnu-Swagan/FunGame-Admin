import { useState, useEffect, useRef } from "react";
import { Shuffle, Eraser } from "lucide-react";
import { useLiveRound } from "@/lib/useLiveRound";
import { sfx } from "@/lib/sound";
import { HistoryStrip } from "@/components/play/PlayShell";
import { LiveBetPanel } from "@/components/play/LiveBar";
import { ResultBanner } from "@/components/play/ResultBanner";
import { GameStage } from "@/components/play/GameStage";

/* Spribe-style Keno paytable — mirrors backend KENO_PAYTABLE (36 balls, 10 drawn).
   Keyed by number of picks -> { hits: multiplier }. ~88% RTP each. */
const KENO_PAYS = {
  1: { 1: 3.17 },
  2: { 1: 1.35, 2: 4.51 },
  3: { 2: 1.27, 3: 40 },
  4: { 2: 1.28, 3: 2.55, 4: 120 },
  5: { 2: 0.64, 3: 3.18, 4: 8.27, 5: 350 },
  6: { 3: 2.94, 4: 7.65, 5: 19.5, 6: 700 },
  7: { 3: 1.44, 4: 5.78, 5: 15, 6: 34.5, 7: 1500 },
  8: { 4: 5.07, 5: 12.5, 6: 30.5, 7: 67.5, 8: 3000 },
  9: { 4: 2.34, 5: 9.38, 6: 23.5, 7: 54.5, 8: 125, 9: 6000 },
  10: { 4: 1.95, 5: 4.87, 6: 12, 7: 29, 8: 68, 9: 800, 10: 10000 },
};
const fmtMult = (v) => (v >= 100 ? Math.round(v).toLocaleString() : v.toFixed(2));

/* one Spribe ball on the 6x6 board */
function Ball({ n, picked, drawn, hit, dim, onClick, disabled, flash }) {
  let bg, border, color, glow;
  if (hit) {
    bg = "radial-gradient(circle at 35% 26%, #fff6cf, #ffd447 58%, #b8860b)";
    border = "1.5px solid #fff2b0"; color = "#3a2a00";
    glow = "0 3px 10px rgba(0,0,0,0.45), 0 0 16px rgba(255,212,71,0.85)";
  } else if (drawn && !picked) {
    // drawn but you didn't pick it — hollow gold ring
    bg = "radial-gradient(circle at 35% 26%, #57132a, #2c0a17 72%, #1a0710)";
    border = "2px solid #ffd447"; color = "#ffe9a8";
    glow = "0 3px 8px rgba(0,0,0,0.5), 0 0 9px rgba(255,212,71,0.5)";
  } else if (picked) {
    bg = "radial-gradient(circle at 35% 26%, #ffe6f0, #f7b3cf 62%, #d585a6)";
    border = "1.5px solid #ffd7e6"; color = "#5a1030";
    glow = "0 3px 9px rgba(0,0,0,0.4), 0 0 10px rgba(247,179,207,0.5)";
  } else {
    bg = "radial-gradient(circle at 35% 26%, #5c1430, #2c0a17 72%, #180610)";
    border = "1px solid #7a1e3d"; color = "rgba(255,235,242,0.82)";
    glow = "0 3px 7px rgba(0,0,0,0.5), inset 0 1px 2px rgba(255,255,255,0.14)";
  }
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      data-testid={`keno-number-${n}`}
      className={`aspect-square rounded-full grid place-items-center font-bold tabular-nums select-none transition-[transform,box-shadow] duration-150 ${flash ? "scale-110" : ""} ${disabled ? "" : "active:scale-95"}`}
      style={{ background: bg, border, color, boxShadow: glow, fontSize: "clamp(11px,3.4vw,15px)", opacity: dim ? 0.5 : 1 }}
    >
      {n}
    </button>
  );
}

export default function KenoGame({ game }) {
  const { state, countdown, balance, betting, phase, outcome, result, history, placeBet, clearBets, myBets, myTotal, placing, revealProgress } =
    useLiveRound(game.slug, {
      revealSound: "draw",
      formatResult: (s) => {
        const b = s.bets[0] || {};
        const m = (b.matches || []).length;
        return {
          title: s.payout > 0 ? `${m} hit${m === 1 ? "" : "s"} — ${b.multiplier}x!` : `${m} hit${m === 1 ? "" : "s"}`,
          subtitle: s.payout > 0 ? "Nice picking!" : "Not enough hits this draw",
        };
      },
    });
  const [picks, setPicks] = useState([]);
  const [amount, setAmount] = useState(50);

  const drawnAll = outcome?.drawn || [];
  const shownCount = phase === "RESULT" ? drawnAll.length : Math.floor(revealProgress * drawnAll.length);
  const drawn = drawnAll.slice(0, shownCount);
  const drawnSet = new Set(drawn);

  const locked = myBets.length > 0;
  const myPicks = locked ? myBets[0].selection || [] : picks;
  const K = myPicks.length;
  const table = KENO_PAYS[K] || {};
  const matchCount = drawn.filter((n) => myPicks.includes(n)).length;
  const isDrawing = phase !== "BETTING";

  // ball pop as each ball drops; a bright ding when one of your picks hits
  const prevShownRef = useRef(0);
  const prevMatchRef = useRef(0);
  useEffect(() => {
    if (phase !== "REVEAL") { prevShownRef.current = 0; prevMatchRef.current = 0; return; }
    if (shownCount > prevShownRef.current) { matchCount > prevMatchRef.current ? sfx.slotBell() : sfx.chip(); }
    prevShownRef.current = shownCount; prevMatchRef.current = matchCount;
  }, [shownCount, matchCount, phase]);

  const toggle = (n) => {
    if (!betting || locked) return;
    setPicks((p) => (p.includes(n) ? p.filter((x) => x !== n) : p.length < 10 ? [...p, n] : p));
  };
  const random = () => {
    if (!betting || locked) return;
    const count = picks.length > 0 ? picks.length : 10;
    const pool = Array.from({ length: 36 }, (_, i) => i + 1);
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    setPicks(pool.slice(0, count).sort((a, b) => a - b));
    sfx.chip && sfx.chip();
  };
  const latest = drawn.length ? drawn[drawn.length - 1] : null;
  const canPlace = picks.length > 0 && !locked;

  return (
    <GameStage
      game={game}
      balance={balance}
      live={{ phase, countdown, timings: state?.timings, roundNumber: state?.round_number }}
      labels={{ REVEAL: "DRAWING 10 BALLS…" }}
      betDock={
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <button data-testid="keno-random" onClick={random} disabled={!betting || locked}
              className="rounded-xl border py-2.5 min-h-[44px] font-extrabold text-sm tracking-wide flex items-center justify-center gap-1.5 transition-colors disabled:opacity-40"
              style={{ borderColor: "#c9527a66", background: "rgba(201,82,122,0.12)", color: "#ffc0d6" }}>
              <Shuffle className="h-4 w-4" /> RANDOM
            </button>
            <button data-testid="keno-clear-button" onClick={() => setPicks([])} disabled={!betting || locked || picks.length === 0}
              className="rounded-xl border py-2.5 min-h-[44px] font-extrabold text-sm tracking-wide flex items-center justify-center gap-1.5 transition-colors disabled:opacity-40"
              style={{ borderColor: "#c9527a66", background: "rgba(201,82,122,0.08)", color: "#ffb0cc" }}>
              <Eraser className="h-4 w-4" /> CLEAR
            </button>
          </div>
          <LiveBetPanel
            amount={amount}
            setAmount={setAmount}
            onPlace={() => canPlace && placeBet(picks, amount)}
            betting={betting}
            placing={placing}
            disabled={!canPlace}
            label={locked ? `${K} pick${K > 1 ? "s" : ""} in play` : picks.length === 0 ? "Pick numbers first" : `Bet ${picks.length} pick${picks.length > 1 ? "s" : ""}`}
            myTotal={myTotal}
          />
          {betting && locked && (
            <button data-testid="live-clear-bets" onClick={clearBets} className="w-full text-[11px] font-bold text-red-400/85 hover:text-red-400">
              Clear my bets (refund)
            </button>
          )}
        </div>
      }
      extras={<HistoryStrip history={history} />}
    >
      <div
        className="relative rounded-2xl border-2 p-3 overflow-hidden"
        style={{
          borderColor: "#e0a5bd44",
          background: "radial-gradient(125% 100% at 50% 0%, #8a1c40 0%, #6d1633 50%, #4a0f24 100%)",
          boxShadow: "0 16px 38px rgba(0,0,0,0.5), inset 0 0 60px rgba(0,0,0,0.35)",
        }}
        data-testid="keno-board"
      >
        {/* faint chevron watermark like Spribe */}
        <div aria-hidden className="absolute inset-0 pointer-events-none" style={{ background: "repeating-linear-gradient(135deg, rgba(255,255,255,0.02) 0 2px, transparent 2px 26px)" }} />

        <div className="flex items-center justify-between mb-2 relative">
          <span className="text-[11px] font-bold tracking-wide text-white/70">
            {isDrawing ? `DRAWING · ${shownCount}/10` : `Pick up to 10 · ${picks.length}/10`}
          </span>
          {K > 0 && (
            <span className="text-[10px] font-extrabold tabular-nums px-2 py-0.5 rounded-full" style={{ color: "#ffe9a8", background: "rgba(255,212,71,0.14)", border: "1px solid rgba(255,212,71,0.4)" }} data-testid="keno-match-count">
              {isDrawing ? `${matchCount} HIT${matchCount === 1 ? "" : "S"}` : `WIN UP TO ${fmtMult(table[K] || 0)}x`}
            </span>
          )}
        </div>

        {/* board + paytable */}
        <div className="flex gap-2 relative">
          <div className="grid grid-cols-6 gap-1.5 flex-1">
            {Array.from({ length: 36 }, (_, i) => i + 1).map((n) => {
              const picked = myPicks.includes(n);
              const isDrawn = drawnSet.has(n);
              return (
                <Ball
                  key={n}
                  n={n}
                  picked={picked}
                  drawn={isDrawn}
                  hit={picked && isDrawn}
                  dim={isDrawing && picked && !isDrawn && shownCount >= 10}
                  flash={n === latest && shownCount < 10}
                  disabled={!betting || locked}
                  onClick={() => toggle(n)}
                />
              );
            })}
          </div>

          {/* paytable panel */}
          <div className="w-[74px] shrink-0 rounded-lg border p-1.5 flex flex-col gap-0.5" style={{ borderColor: "#ffffff22", background: "rgba(0,0,0,0.22)" }}>
            <div className="flex items-center justify-between px-1 pb-0.5 mb-0.5 border-b" style={{ borderColor: "#ffffff1a" }}>
              <span className="text-[8px] font-bold text-white/45">HITS</span>
              <span className="text-[8px] font-bold text-white/45">PAYS</span>
            </div>
            {K === 0 ? (
              <p className="text-[9px] text-white/40 text-center py-4 leading-tight">Pick numbers to see payouts</p>
            ) : (
              Array.from({ length: K }, (_, i) => K - i).map((h) => {
                const mult = table[h] || 0;
                const active = isDrawing && matchCount === h;
                const pays = mult > 0;
                return (
                  <div key={h} className="flex items-center justify-between rounded px-1 py-0.5 transition-colors"
                    style={{ background: active ? "rgba(255,212,71,0.22)" : "transparent" }}>
                    <span className="grid place-items-center rounded-full font-extrabold tabular-nums"
                      style={{ width: 15, height: 15, fontSize: 8, color: pays ? "#3a2a00" : "#ffffff88",
                        background: pays ? "radial-gradient(circle at 35% 30%, #ffe08a, #f5b312)" : "rgba(255,255,255,0.08)" }}>{h}</span>
                    <span className="text-[9px] font-bold tabular-nums" style={{ color: active ? "#ffe9a8" : pays ? "#fff" : "#ffffff55" }}>{fmtMult(mult)}x</span>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>

      <ResultBanner result={result} />
    </GameStage>
  );
}
