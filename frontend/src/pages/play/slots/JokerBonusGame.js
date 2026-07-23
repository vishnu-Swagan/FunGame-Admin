import { useState, useEffect, useRef } from "react";
import { useLiveRound } from "@/lib/useLiveRound";
import { sfx } from "@/lib/sound";
import { HistoryStrip } from "@/components/play/PlayShell";
import { LiveBetPanel, LastResults, ResultPill } from "@/components/play/LiveBar";
import { ResultBanner } from "@/components/play/ResultBanner";
import { GameStage } from "@/components/play/GameStage";
import { SpinStrip, SettledCell, reelStopTimes, pickSeeded } from "./reelKit";
import { SlotSymbol } from "@/pages/play/slots/SlotSymbols";
import { FitWidth } from "@/components/FitWidth";

/**
 * JOKER BONUS - dark jester cabinet: violet neon, harlequin diamond backdrop,
 * neon fruit reels and a 3-segment JOKER METER that lights up as wild jesters
 * land. One universal spin per round on the shared server clock.
 */

const IDS = ["--", "plum", "grape", "melon", "bell", "seven", "joker"];
const PAYS = [
  ["1 Plum", "1x"], ["2 Plums", "2x"], ["3\u00d7 Plum", "7x"], ["3\u00d7 Grape", "9x"],
  ["3\u00d7 Melon", "15x"], ["3\u00d7 Bell", "24x"], ["3\u00d7 Neon 7", "54x"], ["3\u00d7 JOKER", "140x"],
];

const NEON = "#c084fc";
const MAGENTA = "#e879f9";

const Sym = ({ id, size = 44 }) => <SlotSymbol id={id} size={size * 0.92} />;

/* Laughing Joker mascot (matches the game logo). Shakes + the mouth pulses when
   `laughing` is true (on a result). */
const JokerFace = ({ laughing, size = 54 }) => (
  <svg viewBox="0 0 100 100" width={size} height={size} className={laughing ? "fg-joker-laugh" : ""} aria-hidden="true" style={{ filter: "drop-shadow(0 3px 6px rgba(0,0,0,0.5))" }}>
    <defs>
      <radialGradient id="jkFace" cx="42%" cy="36%" r="66%">
        <stop offset="0%" stopColor="#fff8ee" /><stop offset="70%" stopColor="#ffe6c8" /><stop offset="100%" stopColor="#dcb283" />
      </radialGradient>
    </defs>
    <path d="M20 46 C4 34 8 12 26 12 L36 44 Z" fill="#7b2fbe" stroke="#4a1873" strokeWidth="1.2" />
    <path d="M80 46 C96 34 92 12 74 12 L64 44 Z" fill="#facc15" stroke="#9a6c05" strokeWidth="1.2" />
    <circle cx="8" cy="30" r="5" fill="#facc15" stroke="#9a6c05" strokeWidth="1" />
    <circle cx="92" cy="30" r="5" fill="#7b2fbe" stroke="#4a1873" strokeWidth="1" />
    <path d="M42 18 C42 4 58 4 58 18 L60 42 L40 42 Z" fill="#e879f9" stroke="#a21caf" strokeWidth="1" />
    <circle cx="50" cy="10" r="4.5" fill="#facc15" stroke="#9a6c05" strokeWidth="1" />
    <path d="M22 44 Q50 34 78 44 L78 52 Q50 43 22 52 Z" fill="#facc15" stroke="#9a6c05" strokeWidth="1" />
    <circle cx="50" cy="62" r="29" fill="url(#jkFace)" stroke="#c9a06a" strokeWidth="1" />
    <path d="M35 58 Q41 52 47 58" fill="none" stroke="#2a1c10" strokeWidth="2.6" strokeLinecap="round" />
    <path d="M53 58 Q59 52 65 58" fill="none" stroke="#2a1c10" strokeWidth="2.6" strokeLinecap="round" />
    <circle cx="32" cy="68" r="5.5" fill="#ff8a8a" opacity="0.6" />
    <circle cx="68" cy="68" r="5.5" fill="#ff8a8a" opacity="0.6" />
    <g className={laughing ? "fg-joker-mouth" : ""} style={{ transformOrigin: "50px 74px" }}>
      <path d="M34 70 Q50 92 66 70 Q50 78 34 70 Z" fill="#7a1020" />
      <path d="M39 71 Q50 75 61 71 L60 73 Q50 77 40 73 Z" fill="#fff" />
      <ellipse cx="50" cy="82" rx="7" ry="4.5" fill="#ff5964" />
    </g>
  </svg>
);

const CELL = 88;

export default function JokerBonusGame({ game }) {
  const { state, countdown, balance, betting, phase, outcome, result, history, placeBet, clearBets, myTotal, lastResults, placing, myBets, revealElapsed } =
    useLiveRound(game.slug, {
      revealSound: "jokerSpin",
      formatResult: (s) => ({
        push: s.outcome.multiplier === 1,
        title:
          s.outcome.multiplier > 1
            ? `${s.outcome.label} \u2014 ${s.outcome.multiplier}\u00d7!`
            : s.outcome.multiplier === 1
            ? "1 Plum \u2014 stake back"
            : "The Joker laughs\u2026 no win",
        subtitle: s.outcome.multiplier >= 54 ? "The jester roars \u2014 huge hit!" : s.outcome.multiplier > 1 ? "The jester grins in your favor!" : undefined,
        big: s.outcome.multiplier >= 24,
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
    if (outcome.multiplier >= 140) { sfx.jokerLaugh(); sfx.gong && sfx.gong(); sfx.coinShower && sfx.coinShower(); }
    else if (outcome.multiplier > 1) { sfx.slotBell && sfx.slotBell(); sfx.coinShower && sfx.coinShower(); }
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
            hint={"Joker wild substitutes \u00b7 plum pays left-aligned"}
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
            <div className="flex justify-center mb-1">
              <JokerFace laughing={allStopped} size={56} />
            </div>
            <p
              className="fg-neon font-display text-2xl"
              style={{ color: MAGENTA, textShadow: `0 0 14px ${MAGENTA}aa, 0 0 30px ${NEON}66` }}
              data-testid="joker-marquee"
            >
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
                {jokersLanded === 3 ? "JACKPOT 140x!" : "3 = 140x"}
              </span>
            </div>
            <p className="text-center text-[11px] mt-2" style={{ color: "rgba(255,255,255,0.45)" }} data-testid="joker-label">
              {allStopped
                ? outcome.label + (outcome.multiplier > 1 ? ` \u2014 pays ${outcome.multiplier}x` : "")
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
