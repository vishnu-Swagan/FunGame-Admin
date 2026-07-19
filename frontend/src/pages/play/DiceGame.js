import { useState } from "react";
import { Dice1, Dice2, Dice3, Dice4, Dice5, Dice6 } from "lucide-react";
import { motion } from "framer-motion";
import { useGamePlay } from "@/lib/useGamePlay";
import { PlayShell, HistoryStrip } from "@/components/play/PlayShell";
import { BetPanel } from "@/components/play/BetPanel";
import { ResultBanner } from "@/components/play/ResultBanner";

const DICE = [null, Dice1, Dice2, Dice3, Dice4, Dice5, Dice6];
const SIDES = [
  { id: "down", label: "Down (2-6)", pays: "2.3x" },
  { id: "seven", label: "Lucky 7", pays: "5.8x" },
  { id: "up", label: "Up (8-12)", pays: "2.3x" },
];

export default function DiceGame({ game }) {
  const { balance, busy, play, history, loadHistory } = useGamePlay(game.slug);
  const [side, setSide] = useState(null);
  const [bet, setBet] = useState(50);
  const [dice, setDice] = useState([3, 4]);
  const [rolling, setRolling] = useState(false);
  const [result, setResult] = useState(null);

  const doPlay = async () => {
    if (!side) return;
    setResult(null);
    setRolling(true);
    const t = setInterval(() => setDice([Math.ceil(Math.random() * 6), Math.ceil(Math.random() * 6)]), 90);
    const data = await play(bet, { side });
    setTimeout(() => {
      clearInterval(t);
      setRolling(false);
      if (data) {
        const o = data.round.outcome;
        setDice(o.dice);
        setResult({
          key: data.round.id, win: o.won,
          title: o.won ? "You won!" : "Not this time",
          subtitle: `Rolled ${o.dice[0]} + ${o.dice[1]} = ${o.total}`,
          payout: data.round.payout,
        });
        loadHistory();
      }
    }, 900);
  };

  const [D1, D2] = [DICE[dice[0]], DICE[dice[1]]];

  return (
    <PlayShell game={game} balance={balance}>
      <div className="rounded-2xl bg-card/55 border border-white/10 p-6 flex items-center justify-center gap-5">
        <motion.div animate={rolling ? { rotate: [0, 15, -15, 0] } : {}} transition={{ repeat: rolling ? Infinity : 0, duration: 0.3 }}>
          <D1 className="h-20 w-20 text-primary" strokeWidth={1.4} />
        </motion.div>
        <motion.div animate={rolling ? { rotate: [0, -15, 15, 0] } : {}} transition={{ repeat: rolling ? Infinity : 0, duration: 0.3 }}>
          <D2 className="h-20 w-20 text-[hsl(var(--cyan))]" strokeWidth={1.4} />
        </motion.div>
      </div>

      <div className="grid grid-cols-3 gap-2">
        {SIDES.map((s) => (
          <button
            key={s.id}
            data-testid={`dice-side-${s.id}`}
            onClick={() => setSide(s.id)}
            className={`rounded-xl border p-3 min-h-[64px] text-center transition-[background-color,border-color] duration-150 ${
              side === s.id ? "bg-primary/15 border-primary/50" : "bg-white/5 border-white/10 hover:bg-white/10"
            }`}
          >
            <p className={`text-sm font-bold ${side === s.id ? "text-primary" : "text-white/85"}`}>{s.label}</p>
            <p className="text-[11px] text-white/50 mt-0.5">pays {s.pays}</p>
          </button>
        ))}
      </div>

      <ResultBanner result={result} />
      <BetPanel bet={bet} setBet={setBet} onPlay={doPlay} busy={busy || rolling} disabled={!side} playLabel={side ? "Roll the dice" : "Pick a side first"} />
      <HistoryStrip history={history} />
    </PlayShell>
  );
}
