import { useState, useEffect, useRef } from "react";
import { motion } from "framer-motion";
import { Zap, Star } from "lucide-react";
import { useLiveRound } from "@/lib/useLiveRound";
import { sfx } from "@/lib/sound";
import { PlayShell, HistoryStrip } from "@/components/play/PlayShell";
import { LiveBar, LiveBetPanel, LastResults, ResultPill } from "@/components/play/LiveBar";
import { ResultBanner } from "@/components/play/ResultBanner";
import { SpinStrip, SettledCell, reelStopTimes, pickSeeded } from "./reelKit";
import { FitWidth } from "@/components/FitWidth";

/**
 * 777 TRIPLE FUN - classic Vegas cabinet: red + gold marquee with blinking
 * bulbs, chrome bezel, ivory mechanical reels, BAR symbols and a pull lever.
 * One universal spin per round on the shared server clock.
 */

const IDS = ["dot", "duo", "trio", "spark", "tri7", "trifun"];
const NICE = { DOT: "CHERRY DOT", DUO: "DOUBLE BAR", TRIO: "TRIPLE BAR", SPARK: "SPARK", TRI7: "SEVENS", TRIFUN: "WILD STAR" };
const nice = (label) => label.replace(/3x (\w+)/, (_, id) => `3\u00d7 ${NICE[id] || id}`);
const PAYS = [
  ["3\u00d7 Cherry Dot", "2x"], ["3\u00d7 Double Bar", "4x"], ["3\u00d7 Triple Bar", "6x"],
  ["3\u00d7 Spark", "12x"], ["3\u00d7 Sevens", "30x"], ["3\u00d7 Wild Star", "75x"],
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
      return (
        <span
          className="rounded-full"
          style={{ width: size * 0.52, height: size * 0.52, background: "radial-gradient(circle at 35% 30%, #ef4444, #991b1b)", boxShadow: "inset -2px -4px 6px rgba(0,0,0,0.35)" }}
        />
      );
    case "duo":
      return <Bars n={2} size={size} />;
    case "trio":
      return <Bars n={3} size={size} />;
    case "spark":
      return <Zap style={{ color: "#b45309", width: size * 0.6, height: size * 0.6 }} fill="#f59e0b" strokeWidth={1.5} />;
    case "tri7":
      return (
        <span className="font-display font-bold" style={{ color: "#dc2626", fontSize: size * 0.5, textShadow: "0 2px 0 rgba(127,29,29,0.55)", letterSpacing: -1 }}>
          777
        </span>
      );
    case "trifun":
      return <Star style={{ color: "#b45309", width: size * 0.62, height: size * 0.62 }} fill="#fbbf24" strokeWidth={1.4} />;
    default:
      return <span>?</span>;
  }
};

const Bulbs = ({ fast }) => (
  <div className="flex justify-between px-3" aria-hidden="true">
    {Array.from({ length: 14 }, (_, i) => (
      <span
        key={i}
        className={`fg-bulb ${fast ? "fg-bulb-fast" : ""} h-1.5 w-1.5 rounded-full`}
        style={{ background: "#ffd447", boxShadow: "0 0 6px rgba(255,212,71,0.9)", animationDelay: `${(i % 2) * 0.55}s` }}
      />
    ))}
  </div>
);

const CELL = 84;

export default function TripleFun777Game({ game }) {
  const { state, countdown, balance, betting, phase, outcome, result, history, placeBet, clearBets, myTotal, lastResults, placing, myBets, revealElapsed } =
    useLiveRound(game.slug, {
      revealSound: "lever777",
      formatResult: (s) => ({
        push: s.outcome.multiplier === 1,
        title:
          s.outcome.multiplier > 1
            ? `${nice(s.outcome.label)} \u2014 ${s.outcome.multiplier}x!`
            : s.outcome.multiplier === 1
            ? "Pair \u2014 stake back"
            : "No win this spin",
        subtitle: s.outcome.multiplier > 1 ? "Ding ding ding \u2014 the classic pays out!" : undefined,
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

  // mechanical clack per reel stop + payout bell once per winning round
  const prevStopRef = useRef(0);
  const winKeyRef = useRef(null);
  useEffect(() => {
    if (phase !== "REVEAL" && phase !== "RESULT") {
      prevStopRef.current = 0;
      return;
    }
    if (stoppedCount > prevStopRef.current && phase === "REVEAL") sfx.reelStop();
    prevStopRef.current = stoppedCount;
  }, [stoppedCount, phase]);
  useEffect(() => {
    if (!allStopped || winKeyRef.current === roundNo) return;
    winKeyRef.current = roundNo;
    if (outcome.multiplier > 1) sfx.slotBell();
  }, [allStopped, outcome, roundNo]);

  const reelCell = (i) => {
    if (!outcome || (!spinningPhase && phase !== "RESULT"))
      return (
        <div style={{ height: CELL }} className="flex items-center justify-center opacity-45">
          <Sym id={pickSeeded(IDS, roundNo * 7 + i)} size={52} />
        </div>
      );
    if (i < stoppedCount)
      return (
        <SettledCell cellH={CELL} k={`${roundNo}-${i}`}>
          <Sym id={outcome.reels[i]} size={52} />
        </SettledCell>
      );
    return <SpinStrip ids={IDS} render={(id) => <Sym id={id} size={52} />} cellH={CELL} />;
  };

  return (
    <PlayShell game={game} balance={balance}>
      <LiveBar state={state} countdown={countdown} labels={{ REVEAL: "REELS SPINNING\u2026" }} />

      {/* ---- classic Vegas cabinet ---- */}
      <div
        data-testid="slot777-cabinet"
        className="rounded-2xl overflow-hidden border-2"
        style={{ borderColor: "#b4530966", background: "linear-gradient(180deg, #450a0a 0%, #2b0707 55%, #1a0404 100%)" }}
      >
        {/* marquee */}
        <div className="pt-2.5 pb-2 space-y-1.5" style={{ background: "linear-gradient(180deg, #7f1d1d, #450a0a)", borderBottom: "1px solid #b4530955" }}>
          <Bulbs fast={isWin} />
          <div className="text-center leading-none">
            <p
              className="font-display text-4xl"
              style={{ color: "#ffd447", textShadow: "0 0 18px rgba(255,212,71,0.55), 0 2px 0 rgba(0,0,0,0.5)" }}
              data-testid="slot777-marquee"
            >
              777
            </p>
            <p className="text-[10px] font-extrabold tracking-[0.4em] mt-1" style={{ color: "#fca5a5" }}>
              TRIPLE FUN
            </p>
          </div>
          <Bulbs fast={isWin} />
        </div>

        {/* reels + lever */}
        <div className="p-4">
          <FitWidth>
            <div className="flex items-center gap-3">
          <div
            className={`rounded-xl p-1.5 mx-auto w-fit ${isWin ? "fg-win-glow" : ""}`}
            style={{ background: "linear-gradient(180deg, #cbd5e1, #64748b 45%, #94a3b8)" }}
          >
            <div className="rounded-lg py-2 px-5 flex gap-2 justify-center relative" style={{ background: "#160303" }} data-testid="slot777-reels">
              {/* payline arrows */}
              <span className="absolute left-0.5 top-1/2 -translate-y-1/2 text-[10px]" style={{ color: "#ffd447" }} aria-hidden="true">{"\u25b6"}</span>
              <span className="absolute right-0.5 top-1/2 -translate-y-1/2 text-[10px]" style={{ color: "#ffd447" }} aria-hidden="true">{"\u25c0"}</span>
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className="w-[76px] rounded-md overflow-hidden relative"
                  style={{ background: "linear-gradient(180deg, #d9cfb2, #f5efdc 30%, #f5efdc 70%, #d9cfb2)", boxShadow: "inset 0 6px 10px rgba(0,0,0,0.3), inset 0 -6px 10px rgba(0,0,0,0.3)" }}
                  data-testid={`slot777-reel-${i}`}
                >
                  {reelCell(i)}
                </div>
              ))}
            </div>
          </div>
          {/* pull lever */}
          <div className="flex flex-col items-center self-stretch justify-center w-8" aria-hidden="true">
            <div className="relative flex flex-col items-center" style={{ height: 96 }}>
              <div className="w-1.5 rounded-full flex-1" style={{ background: "linear-gradient(180deg, #e2e8f0, #64748b, #94a3b8)" }} />
              <motion.div
                animate={{ y: spinningPhase && stoppedCount === 0 ? 34 : 0 }}
                transition={{ type: "spring", stiffness: 300, damping: 18 }}
                className="absolute top-0 h-7 w-7 rounded-full"
                style={{ background: "radial-gradient(circle at 35% 30%, #f87171, #991b1b)", boxShadow: "0 2px 8px rgba(0,0,0,0.5), inset -2px -3px 5px rgba(0,0,0,0.4)" }}
              />
              <div className="h-3 w-6 rounded-sm mt-auto" style={{ background: "#475569" }} />
            </div>
          </div>
            </div>
          </FitWidth>
        </div>

        {/* result plate */}
        <div className="px-4 pb-3 -mt-1">
          <div
            className="rounded-lg border text-center py-1.5"
            style={{ borderColor: "#b4530944", background: "rgba(0,0,0,0.35)" }}
          >
            <p className="text-xs font-extrabold tracking-wider" style={{ color: isWin ? "#ffd447" : "#fca5a5aa" }} data-testid="slot777-label">
              {allStopped ? nice(outcome.label) + (outcome.multiplier > 1 ? ` \u2014 PAYS ${outcome.multiplier}x` : "") : spinningPhase ? "GOOD LUCK\u2026" : "INSERT CHIPS \u00b7 ONE UNIVERSAL SPIN PER ROUND"}
            </p>
          </div>
          <div className="flex justify-center mt-2">
            <LastResults items={lastResults} render={(r) => <ResultPill label={`${r.multiplier}x`} tone={r.multiplier > 1 ? "gold" : r.multiplier === 1 ? "cyan" : "neutral"} />} />
          </div>
        </div>
      </div>

      <ResultBanner result={result} />
      <LiveBetPanel
        amount={amount}
        setAmount={setAmount}
        onPlace={() => placeBet(null, amount)}
        betting={betting}
        placing={placing}
        label={"Pull the lever \u2014 join this spin"}
        myTotal={myTotal}
        hint={"Pairs return your stake \u00b7 Wild Star substitutes"}
      />
      {betting && myBets.length > 0 && (
        <button data-testid="live-clear-bets" onClick={clearBets} className="w-full text-[11px] font-bold text-red-400/85 hover:text-red-400">
          Clear my bets (refund)
        </button>
      )}

      {/* classic paytable */}
      <div className="rounded-2xl border p-3.5" style={{ borderColor: "#b4530933", background: "rgba(69,10,10,0.35)" }} data-testid="slot777-paytable">
        <p className="text-xs font-extrabold tracking-wider mb-2" style={{ color: "#ffd447" }}>{"PAYS \u2014 CENTER LINE"}</p>
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
    </PlayShell>
  );
}
