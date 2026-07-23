import { useState, useEffect, useRef } from "react";
import { Cherry, Bell, Star } from "lucide-react";
import { useLiveRound } from "@/lib/useLiveRound";
import { sfx } from "@/lib/sound";
import { HistoryStrip } from "@/components/play/PlayShell";
import { LiveBetPanel, LastResults, ResultPill } from "@/components/play/LiveBar";
import { ResultBanner } from "@/components/play/ResultBanner";
import { GameStage } from "@/components/play/GameStage";
import { SpinStrip, SettledCell, reelStopTimes, pickSeeded } from "./reelKit";
import { CoinShower, WinBurst } from "@/pages/play/slots/slotFx";

/**
 * 777 TRIPLE FUN — a real classic 3-reel, single-payline slot played inside the
 * chrome cabinet art. Weighted reel strips: ~71% RTP, ~24% hit rate (you lose
 * 76% of spins), jackpot 1 in 14,400 — genuine online-slot volatility. Wild ★
 * substitutes; cherries pay left-aligned. One universal synced spin per round.
 */

const REEL_IDS = ["CH", "BL", "BR", "SV", "WD", "--", "CH", "BR", "BL"]; // decorative spin strip
const PAYS = [
  ["3× Wild ★", "175x"], ["3× Seven 7", "66x"], ["3× Bell", "22x"],
  ["3× Bar", "12x"], ["3× Cherry", "8x"], ["2× Cherry", "3x"], ["1× Cherry", "1x"],
];

const Sym = ({ id, size = 44, win = false }) => {
  const glow = win ? { filter: "drop-shadow(0 0 8px rgba(255,212,71,0.95))" } : undefined;
  switch (id) {
    case "CH":
      return <Cherry style={{ color: "#e0294a", width: size * 0.72, height: size * 0.72, ...glow }} strokeWidth={1.7} fill="#c81d3c" />;
    case "BL":
      return <Bell style={{ color: "#e8a20b", width: size * 0.68, height: size * 0.68, ...glow }} strokeWidth={1.5} fill="#ffd447" />;
    case "BR":
      return <span className="flex items-center justify-center rounded-[3px] font-extrabold" style={{ width: size * 0.94, height: size * 0.36, background: "#1c1917", color: "#fbbf24", fontSize: size * 0.23, letterSpacing: 1.5, ...glow }}>BAR</span>;
    case "SV":
      return <span className="font-display font-bold" style={{ color: "#dc2626", fontSize: size * 0.78, textShadow: "0 2px 0 rgba(127,29,29,0.55)", letterSpacing: -1, ...glow }}>7</span>;
    case "WD":
      return <Star style={{ color: "#b45309", width: size * 0.76, height: size * 0.76, ...glow }} fill="#fbbf24" strokeWidth={1.3} />;
    default:
      return null; // blank reel position
  }
};

// live reel window placed over the cabinet art (fractions of the image box)
const WINDOW = { left: 24, top: 35, width: 58.5, height: 46.5 };

/** Rolling win-amount count-up. */
function CountUp({ to }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    let raf;
    const t0 = performance.now();
    const dur = 900;
    const tick = (t) => {
      const p = Math.min(1, (t - t0) / dur);
      setN(Math.round(to * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [to]);
  return <>{n.toLocaleString()}</>;
}

/** Pulsing screen-blend glows that light the printed marquee bulbs. */
const MarqueeLights = ({ live }) => {
  const cls = live ? "fg-marquee-fast" : "fg-marquee";
  const layers = [
    { bg: "radial-gradient(58% 42% at 50% 15%, rgba(255,224,120,0.65), transparent 60%)", delay: "0s" },
    { bg: "radial-gradient(26% 52% at 19% 56%, rgba(255,220,110,0.6), transparent 62%)", delay: "0.25s" },
    { bg: "radial-gradient(26% 52% at 81% 56%, rgba(255,220,110,0.6), transparent 62%)", delay: "0.5s" },
  ];
  return (
    <>
      {layers.map((l, i) => (
        <div key={i} aria-hidden="true" className={`absolute inset-0 pointer-events-none ${cls}`} style={{ background: l.bg, mixBlendMode: "screen", animationDelay: l.delay }} />
      ))}
    </>
  );
};

export default function TripleFun777Game({ game }) {
  const { state, countdown, balance, betting, phase, outcome, result, history, placeBet, clearBets, myTotal, lastResults, placing, myBets, revealElapsed } =
    useLiveRound(game.slug, {
      revealSound: "lever777",
      formatResult: (s) => ({
        push: s.outcome.multiplier === 1,
        title:
          s.outcome.multiplier > 1
            ? `${s.outcome.label} — ${s.outcome.multiplier}×!`
            : s.outcome.multiplier === 1
            ? "1 Cherry — stake back"
            : "No win this spin",
        subtitle: s.outcome.multiplier >= 66 ? "MEGA HIT — the sevens align!" : s.outcome.multiplier > 1 ? "Winner — the line pays!" : undefined,
        big: s.outcome.multiplier >= 22,
      }),
    });
  const [amount, setAmount] = useState(50);

  const revealSecs = state?.timings?.reveal || 5;
  const stops = reelStopTimes(revealSecs);
  const roundNo = state?.round_number || 0;
  const spinningPhase = phase === "REVEAL" && !!outcome;
  const stoppedCount = phase === "RESULT" && outcome ? 3 : spinningPhase ? stops.filter((t) => revealElapsed >= t).length : 0;
  const allStopped = !!outcome && stoppedCount >= 3;
  const isWin = allStopped && outcome.multiplier > 1;
  const isJackpot = isWin && outcome.multiplier >= 66;

  // last-reel anticipation: reels 1 & 2 already show a big matching symbol
  const anticipation = spinningPhase && stoppedCount === 2 && !!outcome && (() => {
    const a = outcome.grid[1][0], b = outcome.grid[1][1];
    const highs = new Set(["SV", "WD"]);
    const match = a === b || a === "WD" || b === "WD";
    return match && (highs.has(a) || highs.has(b));
  })();

  // measure the reel window so symbols scale with the cabinet on any screen
  const reelsRef = useRef(null);
  const [cellH, setCellH] = useState(96);
  useEffect(() => {
    const el = reelsRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setCellH(Math.max(45, el.clientHeight)));
    ro.observe(el);
    setCellH(Math.max(45, el.clientHeight));
    return () => ro.disconnect();
  }, []);

  // mechanical clack per reel stop + anticipation tease + payout fanfare
  const prevStopRef = useRef(0);
  const antRef = useRef(false);
  const winKeyRef = useRef(null);
  useEffect(() => {
    if (phase !== "REVEAL" && phase !== "RESULT") { prevStopRef.current = 0; return; }
    if (stoppedCount > prevStopRef.current && phase === "REVEAL") sfx.reelStop();
    prevStopRef.current = stoppedCount;
  }, [stoppedCount, phase]);
  useEffect(() => {
    if (anticipation && !antRef.current) { antRef.current = true; sfx.slotBell && sfx.slotBell(); if (navigator.vibrate) navigator.vibrate(30); }
    if (!anticipation) antRef.current = false;
  }, [anticipation]);
  useEffect(() => {
    if (!allStopped || winKeyRef.current === roundNo) return;
    winKeyRef.current = roundNo;
    if (outcome.multiplier >= 66) { sfx.gong(); sfx.coinShower(); sfx.slotBell(); if (navigator.vibrate) navigator.vibrate([0, 90, 40, 160]); }
    else if (outcome.multiplier > 1) { sfx.slotBell(); sfx.coinShower(); if (navigator.vibrate) navigator.vibrate(60); }
  }, [allStopped, outcome, roundNo]);

  const reelCell = (c) => {
    const rowH = cellH / 3;
    const idle = !outcome || (!spinningPhase && phase !== "RESULT");
    if (idle)
      return (
        <div style={{ height: cellH }} className="flex flex-col">
          {[0, 1, 2].map((r) => (
            <div key={r} style={{ height: rowH }} className={`flex items-center justify-center ${r === 1 ? "opacity-75" : "opacity-30"}`}>
              <Sym id={pickSeeded(REEL_IDS, roundNo * 7 + c * 3 + r)} size={rowH * 0.92} />
            </div>
          ))}
        </div>
      );
    if (c < stoppedCount)
      return (
        <SettledCell cellH={cellH} k={`${roundNo}-${c}`}>
          <div className="flex flex-col" style={{ height: cellH }}>
            {[0, 1, 2].map((r) => (
              <div key={r} style={{ height: rowH }} className={`flex items-center justify-center ${r === 1 ? "" : "opacity-45"}`}>
                <Sym id={outcome.grid[r][c]} size={rowH * 0.92} win={isWin && r === 1} />
              </div>
            ))}
          </div>
        </SettledCell>
      );
    return <SpinStrip ids={REEL_IDS} render={(id) => <Sym id={id} size={rowH * 0.92} />} cellH={rowH} rows={3} />;
  };

  return (
    <GameStage
      game={game}
      balance={balance}
      live={{ phase, countdown, timings: state?.timings, roundNumber: state?.round_number }}
      labels={{ REVEAL: "REELS SPINNING…" }}
      betDock={
        <div className="space-y-2">
          <LiveBetPanel
            amount={amount}
            setAmount={setAmount}
            onPlace={() => placeBet(null, amount)}
            betting={betting}
            placing={placing}
            label={"Spin — join this round"}
            myTotal={myTotal}
            hint={"Center line pays · Wild ★ substitutes · cherries pay left"}
          />
          {betting && myBets.length > 0 && (
            <button data-testid="live-clear-bets" onClick={clearBets} className="w-full text-[11px] font-bold text-red-400/85 hover:text-red-400">
              Clear my bets (refund)
            </button>
          )}
        </div>
      }
      extras={
        <div className="space-y-3">
          <div className="rounded-2xl border p-3.5" style={{ borderColor: "#b4530933", background: "rgba(69,10,10,0.35)" }} data-testid="slot777-paytable">
            <p className="text-xs font-extrabold tracking-wider mb-2" style={{ color: "#ffd447" }}>{"PAYS — CENTER LINE"}</p>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1">
              {PAYS.map(([h, p]) => (
                <div key={h} className="flex items-center justify-between text-[11px]">
                  <span className="text-white/60">{h}</span>
                  <span className="tabular-nums font-bold" style={{ color: "#ffd447" }}>{p}</span>
                </div>
              ))}
            </div>
            <p className="text-[10px] text-white/40 mt-2">Real reel odds · jackpot 1 in 14,400 · you win about 1 spin in 4</p>
          </div>
          <HistoryStrip history={history} />
        </div>
      }
    >
      {/* ---- real chrome cabinet art with a live 3-row reel window ---- */}
      <div className="relative mx-auto w-full" style={{ maxWidth: 460 }}>
        <div
          className={`relative w-full ${isJackpot ? "fg-jackpot-pulse" : ""}`}
          style={{ aspectRatio: "1368 / 1072" }}
          data-testid="slot777-cabinet"
        >
          <img
            src="/game-art/triple-fun.png"
            alt="777 Triple Fun slot machine"
            draggable={false}
            className="absolute inset-0 h-full w-full object-contain select-none pointer-events-none"
          />
          {/* blend the art's light corners into the dark stage */}
          <div aria-hidden="true" className="absolute inset-0 pointer-events-none" style={{ background: "radial-gradient(74% 66% at 50% 50%, transparent 56%, rgba(6,10,20,0.92) 100%)" }} />

          {/* running marquee lights on the printed bulbs */}
          <MarqueeLights live={spinningPhase || isWin} />

          {/* live reel window (dark bezel fully covers the printed reels) */}
          <div
            className="absolute"
            style={{ left: `${WINDOW.left}%`, top: `${WINDOW.top}%`, width: `${WINDOW.width}%`, height: `${WINDOW.height}%` }}
            data-testid="slot777-reels"
          >
            <div className="absolute inset-0 rounded-[6px]" style={{ background: "#160303", boxShadow: "0 0 0 2px rgba(120,120,120,0.5), inset 0 2px 8px rgba(0,0,0,0.6)" }} />
            <div ref={reelsRef} className="absolute inset-[4%] flex gap-[3%]">
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className={`relative flex-1 overflow-hidden rounded-[4px] ${spinningPhase && i >= stoppedCount ? "fg-reel-spinning" : ""}`}
                  style={{ background: "linear-gradient(180deg, #e9e1c6, #faf4e2 32%, #faf4e2 68%, #e9e1c6)", boxShadow: "inset 0 8px 12px rgba(0,0,0,0.28), inset 0 -8px 12px rgba(0,0,0,0.28)" }}
                  data-testid={`slot777-reel-${i}`}
                >
                  <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-1/2 z-10" style={{ background: "linear-gradient(180deg, rgba(255,255,255,0.4), transparent)" }} />
                  {anticipation && i === 2 && (
                    <span aria-hidden="true" className="fg-marquee-fast absolute inset-0 z-20 rounded-[4px] pointer-events-none" style={{ boxShadow: "inset 0 0 0 2px rgba(255,212,71,0.95), 0 0 18px rgba(255,212,71,0.7)" }} />
                  )}
                  {reelCell(i)}
                </div>
              ))}
            </div>
            {/* center payline (flashes on a win) */}
            <div aria-hidden="true" className={`absolute left-[-3%] right-[-3%] top-1/2 -translate-y-1/2 h-[2px] z-20 ${isWin ? "fg-line-flash" : ""}`} style={{ background: "rgba(220,38,38,0.8)", boxShadow: "0 0 6px rgba(220,38,38,0.7)" }} />
          </div>

          {/* win celebration layered over the machine */}
          {isWin && <WinBurst mult={outcome.multiplier} color="#ffd447" showAt={22} />}
          {isWin && <CoinShower />}
        </div>

        {/* result plate */}
        <div className="mt-2 rounded-lg border text-center py-1.5" style={{ borderColor: "#b4530944", background: "rgba(0,0,0,0.35)" }}>
          <p className="text-xs font-extrabold tracking-wider" style={{ color: isWin ? "#ffd447" : "#fca5a5aa" }} data-testid="slot777-label">
            {allStopped
              ? result?.win && result?.payout > 0
                ? <>YOU WIN +<CountUp to={result.payout} /> · {outcome.multiplier}×</>
                : outcome.label + (outcome.multiplier > 1 ? ` · ${outcome.multiplier}×` : "")
              : spinningPhase
              ? anticipation ? "COME ON…!" : "GOOD LUCK…"
              : "INSERT CHIPS · ONE UNIVERSAL SPIN PER ROUND"}
          </p>
        </div>
        <div className="flex justify-center mt-2">
          <LastResults items={lastResults} render={(r) => <ResultPill label={`${r.multiplier}x`} tone={r.multiplier >= 22 ? "gold" : r.multiplier > 1 ? "emerald" : r.multiplier === 1 ? "cyan" : "neutral"} />} />
        </div>
      </div>

      <ResultBanner result={result} />
    </GameStage>
  );
}
