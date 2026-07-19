import { useState, useRef, useEffect } from "react";
import { Crown } from "lucide-react";
import { motion } from "framer-motion";
import { useGamePlay } from "@/lib/useGamePlay";
import { PlayShell, HistoryStrip } from "@/components/play/PlayShell";
import { BetPanel } from "@/components/play/BetPanel";
import { ResultBanner } from "@/components/play/ResultBanner";

export default function CheckerGame({ game }) {
  const { balance, busy, play, history, loadHistory } = useGamePlay(game.slug);
  const [side, setSide] = useState(null);
  const [bet, setBet] = useState(50);
  const [shown, setShown] = useState([]);
  const [playing, setPlaying] = useState(false);
  const [result, setResult] = useState(null);
  const timer = useRef(null);

  useEffect(() => () => clearInterval(timer.current), []);

  const doPlay = async () => {
    if (!side) return;
    setResult(null);
    setShown([]);
    const data = await play(bet, { side });
    if (!data) return;
    const o = data.round.outcome;
    setPlaying(true);
    let i = 0;
    timer.current = setInterval(() => {
      i += 1;
      setShown(o.rounds.slice(0, i));
      if (i >= o.rounds.length) {
        clearInterval(timer.current);
        setPlaying(false);
        setResult({
          key: data.round.id, win: o.won,
          title: o.won ? `${o.winner.toUpperCase()} takes the board!` : `${o.winner.toUpperCase()} wins the duel`,
          subtitle: `Captures — Gold ${o.gold} : Steel ${o.steel}`,
          payout: data.round.payout,
        });
        loadHistory();
      }
    }, 320);
  };

  return (
    <PlayShell game={game} balance={balance}>
      <div className="rounded-2xl bg-card/55 border border-white/10 p-5">
        <div
          className="mx-auto h-28 w-28 rounded-xl border border-white/15 mb-4"
          style={{ background: "conic-gradient(rgba(224,170,95,0.35) 90deg, rgba(255,255,255,0.06) 90deg 180deg, rgba(224,170,95,0.35) 180deg 270deg, rgba(255,255,255,0.06) 270deg)", backgroundSize: "28px 28px" }}
        />
        <div className="flex justify-center gap-1.5 min-h-[36px] flex-wrap" data-testid="checker-captures">
          {shown.map((w, i) => (
            <motion.div
              key={i}
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              className={`h-8 w-8 rounded-full border-2 flex items-center justify-center ${w === "gold" ? "bg-primary/25 border-primary" : "bg-white/10 border-white/40"}`}
            >
              <Crown className={`h-3.5 w-3.5 ${w === "gold" ? "text-primary" : "text-white/70"}`} />
            </motion.div>
          ))}
        </div>
        <p className="text-[11px] text-white/45 text-center mt-2">Best of 7 captures — winning side pays 1.9x</p>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {[
          { id: "gold", label: "Gold", cls: "text-primary" },
          { id: "steel", label: "Steel", cls: "text-white/85" },
        ].map((s) => (
          <button
            key={s.id}
            data-testid={`checker-side-${s.id}`}
            onClick={() => setSide(s.id)}
            className={`rounded-xl border p-3.5 min-h-[56px] transition-[background-color,border-color] duration-150 ${side === s.id ? "bg-primary/12 border-primary/50" : "bg-white/5 border-white/10 hover:bg-white/10"}`}
          >
            <p className={`font-display text-lg ${s.cls}`}>{s.label}</p>
            <p className="text-[10px] text-white/45">pays 1.9x</p>
          </button>
        ))}
      </div>

      <ResultBanner result={result} />
      <BetPanel bet={bet} setBet={setBet} onPlay={doPlay} busy={busy || playing} disabled={!side} playLabel={side ? `Start duel — ${side.toUpperCase()}` : "Pick a side first"} />
      <HistoryStrip history={history} />
    </PlayShell>
  );
}
