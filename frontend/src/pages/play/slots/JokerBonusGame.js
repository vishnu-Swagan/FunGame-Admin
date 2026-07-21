import { useState, useEffect, useRef } from "react";
import { VenetianMask, Bell, Grape, Citrus, Apple } from "lucide-react";
import { useLiveRound } from "@/lib/useLiveRound";
import { sfx } from "@/lib/sound";
import { HistoryStrip } from "@/components/play/PlayShell";
import { LiveBetPanel, LastResults, ResultPill } from "@/components/play/LiveBar";
import { ResultBanner } from "@/components/play/ResultBanner";
import { GameStage } from "@/components/play/GameStage";
import { SpinStrip, SettledCell, reelStopTimes, pickSeeded } from "./reelKit";
import { FitWidth } from "@/components/FitWidth";

/**
 * JOKER BONUS - dark jester cabinet: violet neon, harlequin diamond backdrop,
 * neon fruit reels and a 3-segment JOKER METER that lights up as wild jesters
 * land. One universal spin per round on the shared server clock.
 */

const IDS = ["plum", "grape", "melon", "bell", "seven", "joker"];
const NICE = { PLUM: "NEON PLUM", GRAPE: "GRAPES", MELON: "MELON", BELL: "BELL", SEVEN: "NEON 7", JOKER: "JOKER WILD" };
const nice = (label) => label.replace(/3x (\w+)/, (_, id) => `3\u00d7 ${NICE[id] || id}`);
const PAYS = [
  ["3\u00d7 Neon Plum", "2x"], ["3\u00d7 Grapes", "3x"], ["3\u00d7 Melon", "5x"],
  ["3\u00d7 Bell", "10x"], ["3\u00d7 Neon 7", "18x"], ["3\u00d7 JOKER", "40x"],
];

const NEON = "#c084fc";
const MAGENTA = "#e879f9";

const Sym = ({ id, size = 44 }) => {
  const st = (color) => ({ color, width: size * 0.6, height: size * 0.6, filter: `drop-shadow(0 0 6px ${color}88)` });
  switch (id) {
    case "plum":
      return <Apple style={st("#a78bfa")} strokeWidth={1.7} />;
    case "grape":
      return <Grape style={st("#8b5cf6")} strokeWidth={1.7} />;
    case "melon":
      return <Citrus style={st("#4ade80")} strokeWidth={1.7} />;
    case "bell":
      return <Bell style={st("#fbbf24")} strokeWidth={1.7} />;
    case "seven":
      return (
        <span className="font-display font-bold" style={{ color: "#fb7185", fontSize: size * 0.58, textShadow: "0 0 10px rgba(251,113,133,0.7)" }}>
          7
        </span>
      );
    case "joker":
      return <VenetianMask style={st("#facc15")} strokeWidth={1.6} />;
    default:
      return <span>?</span>;
  }
};

const CELL = 88;

export default function JokerBonusGame({ game }) {
  const { state, countdown, balance, betting, phase, outcome, result, history, placeBet, clearBets, myTotal, lastResults, placing, myBets, revealElapsed } =
    useLiveRound(game.slug, {
      revealSound: "jokerSpin",
      formatResult: (s) => ({
        push: s.outcome.multiplier === 1,
        title:
          s.outcome.label === "WILD JACKPOT"
            ? `JESTER JACKPOT \u2014 ${s.outcome.multiplier}x!!`
            : s.outcome.multiplier > 1
            ? `${nice(s.outcome.label)} \u2014 ${s.outcome.multiplier}x!`
            : s.outcome.multiplier === 1
            ? "Pair \u2014 stake back"
            : "The Joker laughs\u2026 no win",
        subtitle: s.outcome.multiplier > 1 ? "The jester grins in your favor!" : undefined,
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
  const jokersLanded = outcome ? outcome.reels.filter((r, i) => i < stoppedCount && r === "joker").length : 0;

  // reel stop clack + jester laugh when a wild lands + jackpot stinger
  const prevRef = useRef({ stops: 0, jokers: 0 });
  const winKeyRef = useRef(null);
  useEffect(() => {
    if (phase !== "REVEAL" && phase !== "RESULT") {
      prevRef.current = { stops: 0, jokers: 0 };
      return;
    }
    if (phase === "REVEAL") {
      if (stoppedCount > prevRef.current.stops) sfx.reelStop();
      if (jokersLanded > prevRef.current.jokers) sfx.jokerLaugh();
    }
    prevRef.current = { stops: stoppedCount, jokers: jokersLanded };
  }, [stoppedCount, jokersLanded, phase]);
  useEffect(() => {
    if (!allStopped || winKeyRef.current === roundNo) return;
    winKeyRef.current = roundNo;
    if (outcome.label === "WILD JACKPOT") sfx.jokerLaugh();
  }, [allStopped, outcome, roundNo]);

  const reelCell = (i) => {
    if (!outcome || (!spinningPhase && phase !== "RESULT"))
      return (
        <div style={{ height: CELL }} className="flex items-center justify-center opacity-40">
          <Sym id={pickSeeded(IDS, roundNo * 11 + i)} size={54} />
        </div>
      );
    if (i < stoppedCount)
      return (
        <SettledCell cellH={CELL} k={`${roundNo}-${i}`}>
          <Sym id={outcome.reels[i]} size={54} />
        </SettledCell>
      );
    return <SpinStrip ids={IDS} render={(id) => <Sym id={id} size={54} />} cellH={CELL} />;
  };

  return (
    <GameStage
      game={game}
      balance={balance}
      live={{ phase, countdown, timings: state?.timings, roundNumber: state?.round_number }}
      labels={{ REVEAL: "THE JESTER SPINS\u2026" }}
      betDock={
        <div className="space-y-2">
          <LiveBetPanel
            amount={amount}
            setAmount={setAmount}
            onPlace={() => placeBet(null, amount)}
            betting={betting}
            placing={placing}
            label="Tempt the Joker"
            myTotal={myTotal}
            hint={"Pairs return your stake \u00b7 Joker wild substitutes"}
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
          <div className="rounded-2xl border p-3.5" style={{ borderColor: `${NEON}33`, background: "rgba(26,11,46,0.45)" }} data-testid="joker-paytable">
            <p className="text-xs font-extrabold tracking-wider mb-2" style={{ color: MAGENTA }}>
              JESTER PAYTABLE
            </p>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1">
              {PAYS.map(([h, p]) => (
                <div key={h} className="flex items-center justify-between text-[11px]">
                  <span className="text-white/60">{h}</span>
                  <span className="tabular-nums font-bold" style={{ color: "#facc15" }}>{p}</span>
                </div>
              ))}
            </div>
          </div>
          <HistoryStrip history={history} />
        </div>
      }
    >
      {/* ---- dark jester cabinet ---- */}
      <div
        data-testid="joker-cabinet"
        className="rounded-2xl overflow-hidden border relative"
        style={{ borderColor: `${NEON}55`, background: "#12081f", boxShadow: `0 0 28px ${NEON}22` }}
      >
        {/* harlequin diamond backdrop */}
        <div
          className="absolute inset-0 pointer-events-none"
          aria-hidden="true"
          style={{
            background:
              "repeating-linear-gradient(45deg, rgba(147,51,234,0.09) 0 16px, transparent 16px 32px), repeating-linear-gradient(-45deg, rgba(88,28,135,0.12) 0 16px, transparent 16px 32px)",
          }}
        />
        <div className="relative">
          {/* neon header */}
          <div className="pt-3 pb-2 text-center" style={{ borderBottom: `1px solid ${NEON}33` }}>
            <p
              className="fg-neon font-display text-2xl inline-flex items-center gap-2"
              style={{ color: MAGENTA, textShadow: `0 0 14px ${MAGENTA}aa, 0 0 30px ${NEON}66` }}
              data-testid="joker-marquee"
            >
              <VenetianMask className="h-6 w-6" style={{ color: "#facc15", filter: "drop-shadow(0 0 8px rgba(250,204,21,0.7))" }} />
              JOKER BONUS
            </p>
            <p className="text-[9px] font-extrabold tracking-[0.35em] mt-0.5" style={{ color: `${NEON}99` }}>
              WILD JESTER SLOTS
            </p>
          </div>

          {/* neon reels */}
          <div className="p-4">
            <FitWidth>
              <div className="flex gap-2.5" data-testid="joker-reels">
                {[0, 1, 2].map((i) => (
                  <div
                    key={i}
                    className={`w-[86px] rounded-xl overflow-hidden border ${isWin ? "fg-win-glow" : ""}`}
                    style={{
                      borderColor: i < stoppedCount && outcome?.reels[i] === "joker" ? "#facc15aa" : `${NEON}44`,
                      background: "linear-gradient(180deg, #1a0b2e, #0d0518 50%, #1a0b2e)",
                      boxShadow: `inset 0 8px 12px rgba(0,0,0,0.6), inset 0 -8px 12px rgba(0,0,0,0.6), 0 0 12px ${NEON}22`,
                    }}
                    data-testid={`joker-reel-${i}`}
                  >
                    {reelCell(i)}
                  </div>
                ))}
              </div>
            </FitWidth>
          </div>

          {/* joker meter */}
          <div className="px-4 pb-3">
            <div className="flex items-center gap-2" data-testid="joker-meter">
              <span className="text-[9px] font-extrabold tracking-widest" style={{ color: `${NEON}bb` }}>
                JOKER METER
              </span>
              <div className="flex-1 flex gap-1.5">
                {[0, 1, 2].map((i) => (
                  <div
                    key={i}
                    className={`h-2.5 flex-1 rounded-full transition-[background-color,box-shadow] duration-300 ${jokersLanded > i ? "fg-line-flash" : ""}`}
                    style={{
                      background: jokersLanded > i ? "#facc15" : "rgba(255,255,255,0.07)",
                      boxShadow: jokersLanded > i ? "0 0 10px rgba(250,204,21,0.7)" : "none",
                    }}
                  />
                ))}
              </div>
              <span className="text-[9px] font-bold" style={{ color: jokersLanded === 3 ? "#facc15" : "rgba(255,255,255,0.4)" }}>
                {jokersLanded === 3 ? "JACKPOT 40x!" : "3 = 40x"}
              </span>
            </div>
            <p className="text-center text-[11px] mt-2" style={{ color: "rgba(255,255,255,0.45)" }} data-testid="joker-label">
              {allStopped
                ? nice(outcome.label) + (outcome.multiplier > 1 ? ` \u2014 pays ${outcome.multiplier}x` : "")
                : spinningPhase
                ? "The jester shuffles the reels\u2026"
                : "Joker is WILD \u2014 substitutes any fruit"}
            </p>
            <div className="flex justify-center mt-1.5">
              <LastResults items={lastResults} render={(r) => <ResultPill label={`${r.multiplier}x`} tone={r.multiplier > 1 ? "magenta" : r.multiplier === 1 ? "cyan" : "neutral"} />} />
            </div>
          </div>
        </div>
      </div>

      <ResultBanner result={result} />
    </GameStage>
  );
}
