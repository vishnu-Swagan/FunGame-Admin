import { useState } from "react";
import { motion } from "framer-motion";
import { useGamePlay } from "@/lib/useGamePlay";
import { PlayShell, HistoryStrip } from "@/components/play/PlayShell";
import { BetPanel } from "@/components/play/BetPanel";
import { ResultBanner } from "@/components/play/ResultBanner";

const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);

const OUTSIDE = [
  { type: "color", value: "red", label: "Red", pays: "2x", cls: "bg-red-600/25 border-red-500/50 text-red-300" },
  { type: "color", value: "black", label: "Black", pays: "2x", cls: "bg-white/8 border-white/25 text-white/85" },
  { type: "parity", value: "odd", label: "Odd", pays: "2x" },
  { type: "parity", value: "even", label: "Even", pays: "2x" },
  { type: "range", value: "low", label: "1-18", pays: "2x" },
  { type: "range", value: "high", label: "19-36", pays: "2x" },
  { type: "dozen", value: 1, label: "1st 12", pays: "3x" },
  { type: "dozen", value: 2, label: "2nd 12", pays: "3x" },
  { type: "dozen", value: 3, label: "3rd 12", pays: "3x" },
];

export default function RouletteGame({ game }) {
  const { balance, busy, play, history, loadHistory } = useGamePlay(game.slug);
  const [sel, setSel] = useState(null); // {type, value, label}
  const [bet, setBet] = useState(50);
  const [spinning, setSpinning] = useState(false);
  const [landed, setLanded] = useState(null); // {number, color}
  const [result, setResult] = useState(null);

  const doPlay = async () => {
    if (!sel) return;
    setResult(null);
    setSpinning(true);
    setLanded(null);
    const data = await play(bet, { bet_type: sel.type, value: sel.value });
    setTimeout(() => {
      setSpinning(false);
      if (data) {
        const o = data.round.outcome;
        setLanded({ number: o.number, color: o.color });
        setResult({
          key: data.round.id, win: o.won,
          title: o.won ? "Winner!" : "House takes it",
          subtitle: `Ball landed on ${o.number} (${o.color})`,
          payout: data.round.payout,
        });
        loadHistory();
      }
    }, 1200);
  };

  const numColor = (n) => (n === 0 ? "bg-[hsl(var(--emerald)/0.3)] border-[hsl(var(--emerald)/0.5)]" : RED.has(n) ? "bg-red-600/25 border-red-500/40" : "bg-white/8 border-white/20");

  return (
    <PlayShell game={game} balance={balance}>
      {/* Wheel result */}
      <div className="rounded-2xl bg-card/55 border border-white/10 p-5 flex items-center justify-center">
        <motion.div
          animate={spinning ? { rotate: 360 } : { rotate: 0 }}
          transition={spinning ? { repeat: Infinity, duration: 0.6, ease: "linear" } : { duration: 0.4 }}
          className="h-24 w-24 rounded-full border-4 border-primary/40 flex items-center justify-center"
          style={{ background: "repeating-conic-gradient(rgba(220,38,38,0.35) 0 10deg, rgba(255,255,255,0.08) 10deg 20deg)" }}
        >
          <div className={`h-14 w-14 rounded-full border flex items-center justify-center ${landed ? numColor(landed.number) : "bg-black/50 border-white/15"}`}>
            <span className="font-display text-2xl text-white" data-testid="roulette-result">{spinning ? "…" : landed ? landed.number : "?"}</span>
          </div>
        </motion.div>
      </div>

      {/* Outside bets */}
      <div className="grid grid-cols-3 gap-1.5">
        {OUTSIDE.map((o) => (
          <button
            key={`${o.type}-${o.value}`}
            data-testid={`roulette-bet-${o.type}-${o.value}`}
            onClick={() => setSel(o)}
            className={`rounded-lg border px-2 py-2.5 min-h-[44px] text-xs font-bold transition-[background-color,border-color] duration-150 ${
              sel && sel.type === o.type && sel.value === o.value ? "ring-2 ring-primary border-primary/60 bg-primary/15 text-primary" : o.cls || "bg-white/5 border-white/10 text-white/75 hover:bg-white/10"
            }`}
          >
            {o.label} <span className="opacity-60">({o.pays})</span>
          </button>
        ))}
      </div>

      {/* Straight numbers */}
      <div className="rounded-2xl bg-card/55 border border-white/10 p-3">
        <p className="text-[11px] font-semibold text-white/50 mb-2">Straight number — pays 36x</p>
        <div className="grid grid-cols-9 gap-1">
          {Array.from({ length: 37 }, (_, n) => (
            <button
              key={n}
              data-testid={`roulette-number-${n}`}
              onClick={() => setSel({ type: "straight", value: n, label: `#${n}` })}
              className={`rounded-md border text-[11px] font-bold py-1.5 min-h-[30px] tabular-nums transition-[box-shadow] duration-100 ${numColor(n)} ${
                sel && sel.type === "straight" && sel.value === n ? "ring-2 ring-primary" : ""
              }`}
            >
              {n}
            </button>
          ))}
        </div>
      </div>

      <ResultBanner result={result} />
      <BetPanel bet={bet} setBet={setBet} onPlay={doPlay} busy={busy || spinning} disabled={!sel} playLabel={sel ? `Spin on ${sel.label}` : "Place a bet first"} />
      <HistoryStrip history={history} />
    </PlayShell>
  );
}
