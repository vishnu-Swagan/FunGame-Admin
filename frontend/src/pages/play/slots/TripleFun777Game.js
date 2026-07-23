import { useState, useEffect, useRef } from "react";
import { motion } from "framer-motion";
import { Zap, Star } from "lucide-react";
import { useLiveRound } from "@/lib/useLiveRound";
import { sfx } from "@/lib/sound";
import { HistoryStrip } from "@/components/play/PlayShell";
import { LiveBetPanel, LastResults, ResultPill } from "@/components/play/LiveBar";
import { ResultBanner } from "@/components/play/ResultBanner";
import { GameStage } from "@/components/play/GameStage";
import { SpinStrip, SettledCell, reelStopTimes, pickSeeded } from "./reelKit";
import { CoinShower, WinBurst } from "@/pages/play/slots/slotFx";

/**
 * 777 TRIPLE FUN — plays inside the real chrome cabinet art. The machine image
 * is the cabinet; live reels spin in its window and land on the one universal
 * server outcome for the round.
 */

const IDS = ["dot", "duo", "trio", "spark", "tri7", "trifun"];
const NICE = { DOT: "CHERRY DOT", DUO: "DOUBLE BAR", TRIO: "TRIPLE BAR", SPARK: "SPARK", TRI7: "SEVENS", TRIFUN: "WILD STAR" };
const nice = (label) => label.replace(/3x (\w+)/, (_, id) => `3× ${NICE[id] || id}`);
const PAYS = [
  ["3× Cherry Dot", "2x"], ["3× Double Bar", "4x"], ["3× Triple Bar", "6x"],
  ["3× Spark", "12x"], ["3× Sevens", "30x"], ["3× Wild Star", "75x"],
];

const Bars = ({ n, size }) => (
  <span className="flex flex-col items-center" style={{ gap: size * 0.07 }}>
    {Array.from({ length: n }, (_, i) => (
      <span
        key={i}
        className="flex items-center justify-center rounded-[3px] font-extrabold"
        style={{ width: size * 0.92, height: size * 0.26, background: "#1c1917", color: "#fbbf24", fontSize: size * 0.17, letterSpacing: 1.5 }}
      >
        BAR
      </span>
    ))}
  </span>
);

const Sym = ({ id, size = 44 }) => {
  switch (id) {
    case "dot":
      return <span className="rounded-full" style={{ width: size * 0.52, height: size * 0.52, background: "radial-gradient(circle at 35% 30%, #ef4444, #991b1b)", boxShadow: "inset -2px -4px 6px rgba(0,0,0,0.35)" }} />;
    case "duo":
      return <Bars n={2} size={size} />;
    case "trio":
      return <Bars n={3} size={size} />;
    case "spark":
      return <Zap style={{ color: "#b45309", width: size * 0.6, height: size * 0.6 }} fill="#f59e0b" strokeWidth={1.5} />;
    case "tri7":
      return <span className="font-display font-bold" style={{ color: "#dc2626", fontSize: size * 0.62, textShadow: "0 2px 0 rgba(127,29,29,0.55)", letterSpacing: -1 }}>7</span>;
    case "trifun":
      return <Star style={{ color: "#b45309", width: size * 0.62, height: size * 0.62 }} fill="#fbbf24" strokeWidth={1.4} />;
    default:
      return <span>?</span>;
  }
};

// live reel window placed over the cabinet art (fractions of the image box)
const WINDOW = { left: 23, top: 35, width: 60, height: 45 };
// lever ball position over the printed lever (fractions of the image box)
const LEVER = { left: 83.5, top: 19, size: 8.5 };

/** Pulsing screen-blend glows that light the printed marquee bulbs (arch + both
    rails). Staggered timing gives a running-lights chase; faster when live. */
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
            ? `${nice(s.outcome.label)} — ${s.outcome.multiplier}x!`
            : s.outcome.multiplier === 1
            ? "Pair — stake back"
            : "No win this spin",
        subtitle: s.outcome.multiplier > 1 ? "Ding ding ding — the classic pays out!" : undefined,
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

  // measure the reel window so symbols scale with the cabinet on any screen
  const reelsRef = useRef(null);
  const [cellH, setCellH] = useState(96);
  useEffect(() => {
    const el = reelsRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setCellH(Math.max(40, el.clientHeight)));
    ro.observe(el);
    setCellH(Math.max(40, el.clientHeight));
    return () => ro.disconnect();
  }, []);

  // mechanical clack per reel stop + payout bell once per winning round
  const prevStopRef = useRef(0);
  const winKeyRef = useRef(null);
  useEffect(() => {
    if (phase !== "REVEAL" && phase !== "RESULT") { prevStopRef.current = 0; return; }
    if (stoppedCount > prevStopRef.current && phase === "REVEAL") sfx.reelStop();
    prevStopRef.current = stoppedCount;
  }, [stoppedCount, phase]);
  useEffect(() => {
    if (!allStopped || winKeyRef.current === roundNo) return;
    winKeyRef.current = roundNo;
    if (outcome.multiplier >= 30) { sfx.gong(); sfx.coinShower(); sfx.slotBell(); }
    else if (outcome.multiplier > 1) { sfx.slotBell(); sfx.coinShower(); }
  }, [allStopped, outcome, roundNo]);

  const reelCell = (i) => {
    if (!outcome || (!spinningPhase && phase !== "RESULT"))
      return <div style={{ height: cellH }} className="flex items-center justify-center opacity-40"><Sym id={pickSeeded(IDS, roundNo * 7 + i)} size={cellH * 0.6} /></div>;
    if (i < stoppedCount)
      return <SettledCell cellH={cellH} k={`${roundNo}-${i}`}><Sym id={outcome.reels[i]} size={cellH * 0.62} /></SettledCell>;
    return <SpinStrip ids={IDS} render={(id) => <Sym id={id} size={cellH * 0.62} />} cellH={cellH} />;
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
            label={"Pull the lever — join this spin"}
            myTotal={myTotal}
            hint={"Pairs return your stake · Wild Star substitutes"}
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
          </div>
          <HistoryStrip history={history} />
        </div>
      }
    >
      {/* ---- real chrome cabinet art with a live reel window ---- */}
      <div className="relative mx-auto w-full" style={{ maxWidth: 460 }}>
        <div
          className={`relative w-full ${isWin && outcome.multiplier >= 30 ? "fg-jackpot-pulse" : ""}`}
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

          {/* pull lever — yanks down when the reels start rolling */}
          <motion.div
            aria-hidden="true"
            className="absolute z-30 rounded-full pointer-events-none"
            style={{
              left: `${LEVER.left}%`,
              top: `${LEVER.top}%`,
              width: `${LEVER.size}%`,
              aspectRatio: "1 / 1",
              background: "radial-gradient(circle at 34% 28%, #ff9a9a, #e11d1d 52%, #7f1010)",
              boxShadow: "0 3px 10px rgba(0,0,0,0.5), 0 0 16px rgba(255,70,70,0.55), inset -3px -4px 8px rgba(0,0,0,0.45), inset 2px 2px 5px rgba(255,255,255,0.55)",
            }}
            animate={{ y: spinningPhase && stoppedCount === 0 ? "120%" : "0%" }}
            transition={{ type: "spring", stiffness: 240, damping: 15 }}
          />

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
                  {reelCell(i)}
                </div>
              ))}
            </div>
            {/* center payline */}
            <div aria-hidden="true" className="absolute left-[-3%] right-[-3%] top-1/2 -translate-y-1/2 h-[2px] z-20" style={{ background: "rgba(220,38,38,0.75)", boxShadow: "0 0 6px rgba(220,38,38,0.6)" }} />
          </div>

          {/* win celebration layered over the machine */}
          {isWin && <WinBurst mult={outcome.multiplier} color="#ffd447" showAt={12} />}
          {isWin && <CoinShower />}
        </div>

        {/* result plate */}
        <div className="mt-2 rounded-lg border text-center py-1.5" style={{ borderColor: "#b4530944", background: "rgba(0,0,0,0.35)" }}>
          <p className="text-xs font-extrabold tracking-wider" style={{ color: isWin ? "#ffd447" : "#fca5a5aa" }} data-testid="slot777-label">
            {allStopped
              ? nice(outcome.label) + (outcome.multiplier > 1 ? ` — PAYS ${outcome.multiplier}x` : "")
              : spinningPhase
              ? "GOOD LUCK…"
              : "INSERT CHIPS · ONE UNIVERSAL SPIN PER ROUND"}
          </p>
        </div>
        <div className="flex justify-center mt-2">
          <LastResults items={lastResults} render={(r) => <ResultPill label={`${r.multiplier}x`} tone={r.multiplier > 1 ? "gold" : r.multiplier === 1 ? "cyan" : "neutral"} />} />
        </div>
      </div>

      <ResultBanner result={result} />
    </GameStage>
  );
}
