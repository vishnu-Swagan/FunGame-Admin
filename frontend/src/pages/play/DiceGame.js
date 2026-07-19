import { useState, useEffect } from "react";
import { useLiveRound } from "@/lib/useLiveRound";
import { sfx } from "@/lib/sound";
import { PlayShell, HistoryStrip } from "@/components/play/PlayShell";
import { LiveBar, LiveBetPanel, LastResults, ResultPill } from "@/components/play/LiveBar";
import { ResultBanner } from "@/components/play/ResultBanner";
import { formatChips } from "@/components/common";

const SIDES = [
  { id: "down", label: "Down (2-6)", pays: "2.3x" },
  { id: "seven", label: "Lucky 7", pays: "5.8x" },
  { id: "up", label: "Up (8-12)", pays: "2.3x" },
];

/* pip layout per face value on a 3x3 grid */
const PIPS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };

/* cube rotation that brings each face value to the front */
const FACE_ROT = {
  1: "rotateX(0deg) rotateY(0deg)",
  2: "rotateX(-90deg) rotateY(0deg)",
  3: "rotateX(0deg) rotateY(-90deg)",
  4: "rotateX(0deg) rotateY(90deg)",
  5: "rotateX(90deg) rotateY(0deg)",
  6: "rotateX(0deg) rotateY(180deg)",
};

/* face placement on the cube: value -> transform */
const FACE_PLACE = {
  1: "translateZ(34px)",
  2: "rotateX(90deg) translateZ(34px)",
  3: "rotateY(90deg) translateZ(34px)",
  4: "rotateY(-90deg) translateZ(34px)",
  5: "rotateX(-90deg) translateZ(34px)",
  6: "rotateY(180deg) translateZ(34px)",
};

const DieFace = ({ value }) => (
  <div className="fg-die-face" style={{ transform: FACE_PLACE[value] }}>
    {Array.from({ length: 9 }, (_, i) => (
      <span key={i} className={PIPS[value].includes(i) ? `fg-pip ${value === 1 ? "fg-pip-red" : ""}` : ""} />
    ))}
  </div>
);

const Die = ({ value, rolling, duration = "0.72s" }) => (
  <div className="fg-die-scene">
    <div className={`fg-die ${rolling ? "rolling" : ""}`} style={rolling ? { animationDuration: duration } : { transform: FACE_ROT[value] }}>
      {[1, 2, 3, 4, 5, 6].map((v) => (
        <DieFace key={v} value={v} />
      ))}
    </div>
  </div>
);

export default function DiceGame({ game }) {
  const { state, countdown, balance, betting, phase, outcome, result, history, placeBet, clearBets, myBets, myTotal, lastResults, placing } =
    useLiveRound(game.slug, {
      formatResult: (s) => ({
        title: s.payout > 0 ? "You won!" : "Not this time",
        subtitle: `Rolled ${s.outcome.dice[0]} + ${s.outcome.dice[1]} = ${s.outcome.total} — ${s.outcome.winner.toUpperCase()}`,
      }),
    });
  const [side, setSide] = useState(null);
  const [amount, setAmount] = useState(50);

  const showFinal = !!outcome && (phase === "RESULT" || (phase === "REVEAL" && countdown < 1.2));
  const rolling = phase === "REVEAL" && !showFinal;
  const dice = showFinal ? outcome.dice : [3, 4];

  // dice rattle while tumbling, thud when they land
  useEffect(() => {
    if (!rolling) return;
    sfx.dice();
    const t = setInterval(sfx.dice, 1150);
    return () => clearInterval(t);
  }, [rolling]);
  useEffect(() => {
    if (showFinal && phase === "REVEAL") sfx.diceLand();
  }, [showFinal, phase]);

  const sideTotals = {};
  myBets.forEach((b) => {
    sideTotals[b.selection] = (sideTotals[b.selection] || 0) + b.amount;
  });

  return (
    <PlayShell game={game} balance={balance}>
      <LiveBar state={state} countdown={countdown} labels={{ REVEAL: "ROLLING…" }} />

      <div className="rounded-2xl bg-card/55 border border-white/10 p-6 flex flex-col items-center gap-4">
        <div className="flex items-center justify-center gap-8 py-2" data-testid="dice-stage">
          <Die value={dice[0]} rolling={rolling} duration="0.72s" />
          <Die value={dice[1]} rolling={rolling} duration="0.87s" />
        </div>
        {showFinal && (
          <p className="text-sm font-bold text-white/80 tabular-nums" data-testid="dice-total">
            {outcome.total} — {outcome.winner.toUpperCase()}
          </p>
        )}
        <LastResults
          items={lastResults}
          render={(r) => <ResultPill label={r.total} tone={r.winner === "seven" ? "gold" : r.winner === "up" ? "magenta" : "cyan"} />}
        />
      </div>

      <div className="grid grid-cols-3 gap-2">
        {SIDES.map((s) => (
          <button
            key={s.id}
            data-testid={`dice-side-${s.id}`}
            onClick={() => setSide(s.id)}
            disabled={!betting}
            className={`relative rounded-xl border p-3 min-h-[64px] text-center transition-[background-color,border-color] duration-150 ${
              side === s.id ? "bg-primary/15 border-primary/50" : "bg-white/5 border-white/10 hover:bg-white/10"
            } ${!betting ? "opacity-70" : ""}`}
          >
            <p className={`text-sm font-bold ${side === s.id ? "text-primary" : "text-white/85"}`}>{s.label}</p>
            <p className="text-[11px] text-white/50 mt-0.5">pays {s.pays}</p>
            {sideTotals[s.id] > 0 && (
              <span className="absolute -top-1.5 -right-1.5 h-6 min-w-6 px-1 rounded-full bg-primary text-primary-foreground text-[9px] font-extrabold flex items-center justify-center border-2 border-yellow-200 shadow-md tabular-nums">
                {formatChips(sideTotals[s.id])}
              </span>
            )}
          </button>
        ))}
      </div>

      <ResultBanner result={result} />
      <LiveBetPanel
        amount={amount}
        setAmount={setAmount}
        onPlace={() => side && placeBet(side, amount)}
        betting={betting}
        placing={placing}
        disabled={!side}
        label={side ? `Bet ${side.toUpperCase()}` : "Pick a side first"}
        myTotal={myTotal}
        hint="Universal dice — everyone sees the same roll"
      />
      {betting && myBets.length > 0 && (
        <button data-testid="live-clear-bets" onClick={clearBets} className="w-full text-[11px] font-bold text-red-400/85 hover:text-red-400">
          Clear my bets (refund)
        </button>
      )}
      <HistoryStrip history={history} />
    </PlayShell>
  );
}
