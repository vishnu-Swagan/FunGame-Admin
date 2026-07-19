import { useState, useEffect, useRef } from "react";
import { Flower2, Coins, Fish, Flame, Gem } from "lucide-react";
import { useLiveRound } from "@/lib/useLiveRound";
import { sfx } from "@/lib/sound";
import { PlayShell, HistoryStrip } from "@/components/play/PlayShell";
import { LiveBar, LiveBetPanel, LastResults, ResultPill } from "@/components/play/LiveBar";
import { ResultBanner } from "@/components/play/ResultBanner";
import { SpinStrip, SettledCell, reelStopTimes, pickSeeded } from "./reelKit";
import { FitWidth } from "@/components/FitWidth";

/**
 * LUCKY 8 LINE - Asian fortune cabinet: crimson + gold, swaying lanterns,
 * a full 3x3 symbol window with 8 numbered line lamps chasing around the
 * frame. Wins pay on the glowing CENTER line. Gong + coin shower on a win.
 */

const IDS = ["blossom", "ingot", "coin", "fish", "eight", "dragon"];
const NICE = { BLOSSOM: "BLOSSOM", INGOT: "GOLD INGOT", COIN: "FORTUNE COIN", FISH: "KOI FISH", EIGHT: "LUCKY 8", DRAGON: "DRAGON WILD" };
const nice = (label) => label.replace(/3x (\w+)/, (_, id) => `3\u00d7 ${NICE[id] || id}`);
const PAYS = [
  ["3\u00d7 Blossom", "2x"], ["3\u00d7 Gold Ingot", "4x"], ["3\u00d7 Fortune Coin", "6x"],
  ["3\u00d7 Koi Fish", "10x"], ["3\u00d7 Lucky 8", "25x"], ["3\u00d7 Dragon", "60x"],
];

const GOLD = "#ffd447";
const CRIMSON = "#7f1d1d";

const Sym = ({ id, size = 40 }) => {
  const st = (color) => ({ color, width: size * 0.62, height: size * 0.62, filter: `drop-shadow(0 0 5px ${color}66)` });
  switch (id) {
    case "blossom":
      return <Flower2 style={st("#ff8fab")} strokeWidth={1.7} />;
    case "ingot":
      return <Gem style={st("#e0aa5f")} strokeWidth={1.7} />;
    case "coin":
      return <Coins style={st(GOLD)} strokeWidth={1.7} />;
    case "fish":
      return <Fish style={st("#5ab9ea")} strokeWidth={1.7} />;
    case "eight":
      return (
        <span className="font-display font-bold" style={{ color: "#f87171", fontSize: size * 0.6, textShadow: `0 0 10px ${GOLD}66` }}>
          8
        </span>
      );
    case "dragon":
      return <Flame style={st("#fb923c")} strokeWidth={1.7} />;
    default:
      return <span>?</span>;
  }
};

const Lantern = ({ className = "", delay = "0s" }) => (
  <div className={`fg-lantern flex flex-col items-center ${className}`} style={{ animationDelay: delay }} aria-hidden="true">
    <div className="h-2 w-0.5" style={{ background: `${GOLD}88` }} />
    <div className="h-1 w-3 rounded-sm" style={{ background: GOLD }} />
    <div
      className="h-6 w-5 rounded-[50%]"
      style={{ background: "radial-gradient(circle at 40% 30%, #ef4444, #991b1b)", boxShadow: "0 0 12px rgba(239,68,68,0.55)", border: `1px solid ${GOLD}66` }}
    />
    <div className="h-1 w-3 rounded-sm" style={{ background: GOLD }} />
    <div className="h-2 w-0.5" style={{ background: "#ef444488" }} />
  </div>
);

const CELL = 52;

export default function Lucky8LineGame({ game }) {
  const { state, countdown, balance, betting, phase, outcome, result, history, placeBet, clearBets, myTotal, lastResults, placing, myBets, revealElapsed } =
    useLiveRound(game.slug, {
      revealSound: "luckySpin",
      formatResult: (s) => ({
        push: s.outcome.multiplier === 1,
        title:
          s.outcome.label === "WILD JACKPOT"
            ? `DRAGON JACKPOT \u2014 ${s.outcome.multiplier}x!!`
            : s.outcome.multiplier > 1
            ? `${nice(s.outcome.label)} \u2014 ${s.outcome.multiplier}x!`
            : s.outcome.multiplier === 1
            ? "Pair \u2014 stake back"
            : "No fortune this spin",
        subtitle: s.outcome.multiplier > 1 ? "The center line glows with fortune!" : undefined,
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

  // gong + coin shower once per winning round; reel stop clacks
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
    if (outcome.multiplier > 1) {
      sfx.gong();
      sfx.coinShower();
    }
  }, [allStopped, outcome, roundNo]);

  // decorative top/bottom rows - deterministic per round so every player sees the same grid
  const deco = (col, row) => pickSeeded(IDS, roundNo * 97 + col * 13 + row * 7);

  const columnCells = (col) => {
    if (!outcome || (!spinningPhase && phase !== "RESULT"))
      return [0, 1, 2].map((row) => (
        <div key={row} style={{ height: CELL }} className="flex items-center justify-center opacity-40">
          <Sym id={deco(col, row)} size={38} />
        </div>
      ));
    if (col < stoppedCount)
      return [0, 1, 2].map((row) => (
        <SettledCell key={row} cellH={CELL} k={`${roundNo}-${col}-${row}`}>
          <div
            className={`flex items-center justify-center rounded-md ${row === 1 && isWin ? "fg-line-flash" : ""}`}
            style={row === 1 ? { boxShadow: isWin ? `0 0 14px ${GOLD}66` : "none" } : { opacity: 0.45 }}
          >
            <Sym id={row === 1 ? outcome.reels[col] : deco(col, row)} size={38} />
          </div>
        </SettledCell>
      ));
    return [<SpinStrip key="strip" ids={IDS} render={(id) => <Sym id={id} size={38} />} cellH={CELL} rows={3} />];
  };

  // 8 line lamps: chase while spinning, lock gold on a win
  const chaseIdx = spinningPhase ? Math.floor(revealElapsed * 5) % 8 : -1;
  const Lamp = ({ n }) => {
    const active = spinningPhase ? chaseIdx === n - 1 : isWin;
    return (
      <span
        className={`flex items-center justify-center h-5 w-5 rounded-full border text-[9px] font-extrabold tabular-nums transition-[background-color,color,box-shadow] duration-150 ${isWin ? "fg-line-flash" : ""}`}
        style={{
          borderColor: active ? GOLD : "rgba(255,255,255,0.15)",
          background: active ? `${GOLD}22` : "rgba(0,0,0,0.3)",
          color: active ? GOLD : "rgba(255,255,255,0.35)",
          boxShadow: active ? `0 0 10px ${GOLD}55` : "none",
        }}
        data-testid={`lucky8-lamp-${n}`}
      >
        {n}
      </span>
    );
  };

  return (
    <PlayShell game={game} balance={balance}>
      <LiveBar state={state} countdown={countdown} labels={{ REVEAL: "FORTUNE SPINNING\u2026" }} />

      {/* ---- Asian fortune cabinet ---- */}
      <div
        data-testid="lucky8-cabinet"
        className="rounded-2xl overflow-hidden border-2 relative"
        style={{ borderColor: `${GOLD}55`, background: `linear-gradient(180deg, ${CRIMSON} 0%, #450a0a 40%, #2b0707 100%)` }}
      >
        {/* header with lanterns */}
        <div className="flex items-start justify-between px-4 pt-2 pb-1" style={{ borderBottom: `1px solid ${GOLD}33` }}>
          <Lantern />
          <div className="text-center pt-1">
            <p className="font-display text-2xl" style={{ color: GOLD, textShadow: `0 0 16px ${GOLD}66` }} data-testid="lucky8-marquee">
              LUCKY 8 LINE
            </p>
            <p className="text-[9px] font-extrabold tracking-[0.35em]" style={{ color: "#fca5a5" }}>
              {"\u798f"} FORTUNE REELS {"\u798f"}
            </p>
          </div>
          <Lantern delay="1.4s" />
        </div>

        {/* 3x3 grid + 8 line lamps */}
        <div className="p-3.5">
          <FitWidth>
            <div className="flex items-center gap-2">
          <div className="flex flex-col gap-1.5" aria-hidden="true">
            {[1, 2, 3, 4].map((n) => <Lamp key={n} n={n} />)}
          </div>
          <div
            className={`rounded-xl p-1.5 ${isWin ? "fg-win-glow" : ""}`}
            style={{ background: `linear-gradient(180deg, ${GOLD}, #b45309 55%, ${GOLD})` }}
          >
            <div className="rounded-lg p-1.5 flex gap-1.5" style={{ background: "#1a0404" }} data-testid="lucky8-grid">
              {[0, 1, 2].map((col) => (
                <div
                  key={col}
                  className="w-[72px] rounded-md overflow-hidden"
                  style={{ background: "linear-gradient(180deg, #2b0707, #160303 50%, #2b0707)", boxShadow: "inset 0 4px 8px rgba(0,0,0,0.5), inset 0 -4px 8px rgba(0,0,0,0.5)" }}
                  data-testid={`lucky8-col-${col}`}
                >
                  {columnCells(col)}
                </div>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-1.5" aria-hidden="true">
            {[5, 6, 7, 8].map((n) => <Lamp key={n} n={n} />)}
          </div>
            </div>
          </FitWidth>
        </div>

        {/* center line marker + status */}
        <div className="px-4 pb-3 text-center">
          <p className="text-[11px]" style={{ color: isWin ? GOLD : "rgba(255,255,255,0.45)" }} data-testid="lucky8-label">
            {allStopped
              ? outcome.multiplier > 1
                ? `CENTER LINE \u2014 ${nice(outcome.label)} pays ${outcome.multiplier}x`
                : `${nice(outcome.label)} on the center line`
              : spinningPhase
              ? "8 lamps of luck are chasing\u2026"
              : "Wins pay on the glowing CENTER line"}
          </p>
          <div className="flex justify-center mt-1.5">
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
        label="Spin for fortune"
        myTotal={myTotal}
        hint={"Pairs return your stake \u00b7 Dragon wild substitutes"}
      />
      {betting && myBets.length > 0 && (
        <button data-testid="live-clear-bets" onClick={clearBets} className="w-full text-[11px] font-bold text-red-400/85 hover:text-red-400">
          Clear my bets (refund)
        </button>
      )}

      <div className="rounded-2xl border p-3.5" style={{ borderColor: `${GOLD}33`, background: "rgba(69,10,10,0.35)" }} data-testid="lucky8-paytable">
        <p className="text-xs font-extrabold tracking-wider mb-2" style={{ color: GOLD }}>
          FORTUNE PAYTABLE
        </p>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1">
          {PAYS.map(([h, p]) => (
            <div key={h} className="flex items-center justify-between text-[11px]">
              <span className="text-white/60">{h}</span>
              <span className="tabular-nums font-bold" style={{ color: GOLD }}>{p}</span>
            </div>
          ))}
        </div>
      </div>
      <HistoryStrip history={history} />
    </PlayShell>
  );
}
