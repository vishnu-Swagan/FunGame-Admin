import { useState, useRef, useEffect } from "react";
import {
  Cherry, Citrus, Bell, Star, Sparkles, Coins, Gem, Crown, Diamond, Grape, Apple, Flower2, Fish, Flame, Zap, Circle,
} from "lucide-react";
import { useGamePlay } from "@/lib/useGamePlay";
import { PlayShell, HistoryStrip } from "@/components/play/PlayShell";
import { BetPanel } from "@/components/play/BetPanel";
import { ResultBanner } from "@/components/play/ResultBanner";

const SYMBOLS = {
  "fever-joker-bonus": {
    cherry: { icon: Cherry, color: "#ff5964" }, lemon: { icon: Citrus, color: "#ffd447" },
    bell: { icon: Bell, color: "#ffb347" }, star: { icon: Star, color: "#ffe08a" },
    seven: { text: "7", color: "#ff4f9a" }, joker: { icon: Sparkles, color: "#c084fc", wild: true },
  },
  "giant-jackpot": {
    coin: { icon: Coins, color: "#ffd447" }, bar: { text: "BAR", color: "#8fa9c4" },
    bell: { icon: Bell, color: "#ffb347" }, gem: { icon: Gem, color: "#3ec6e8" },
    crown: { icon: Crown, color: "#ffe08a" }, diamond: { icon: Diamond, color: "#9d7bff", wild: true },
  },
  "joker-bonus": {
    plum: { icon: Apple, color: "#c084fc" }, grape: { icon: Grape, color: "#7b2fbe" },
    melon: { icon: Citrus, color: "#4ade80" }, bell: { icon: Bell, color: "#ffb347" },
    seven: { text: "7", color: "#ff5964" }, joker: { icon: Sparkles, color: "#ffd447", wild: true },
  },
  "lucky-8-line": {
    blossom: { icon: Flower2, color: "#ff6b9d" }, ingot: { icon: Gem, color: "#e0aa5f" },
    coin: { icon: Coins, color: "#ffd447" }, fish: { icon: Fish, color: "#5ab9ea" },
    eight: { text: "8", color: "#ff5964" }, dragon: { icon: Flame, color: "#ffa04d", wild: true },
  },
  "triple-fun": {
    dot: { icon: Circle, color: "#8f8fff" }, duo: { text: "x2", color: "#5ab9ea" },
    trio: { text: "x3", color: "#4ade80" }, spark: { icon: Zap, color: "#ffd447" },
    tri7: { text: "777", color: "#ff4f9a" }, trifun: { icon: Sparkles, color: "#ffe08a", wild: true },
  },
};

const Symbol = ({ id, map, size = 44 }) => {
  const s = map[id];
  if (!s) return <span className="text-white/40">?</span>;
  if (s.text) return <span className="font-display font-bold" style={{ color: s.color, fontSize: size * 0.5 }}>{s.text}</span>;
  const Icon = s.icon;
  return <Icon style={{ color: s.color, width: size * 0.62, height: size * 0.62 }} strokeWidth={1.8} />;
};

export default function SlotGame({ game }) {
  const { balance, busy, play, history, loadHistory } = useGamePlay(game.slug);
  const map = SYMBOLS[game.slug] || SYMBOLS["fever-joker-bonus"];
  const ids = Object.keys(map);
  const [bet, setBet] = useState(50);
  const [reels, setReels] = useState([ids[0], ids[1], ids[2]]);
  const [spinning, setSpinning] = useState(false);
  const [result, setResult] = useState(null);
  const timer = useRef(null);

  useEffect(() => () => clearInterval(timer.current), []);

  const doPlay = async () => {
    setResult(null);
    setSpinning(true);
    timer.current = setInterval(() => {
      setReels([0, 1, 2].map(() => ids[Math.floor(Math.random() * ids.length)]));
    }, 90);
    const data = await play(bet, {});
    setTimeout(() => {
      clearInterval(timer.current);
      setSpinning(false);
      if (data) {
        const o = data.round.outcome;
        setReels(o.reels);
        setResult({
          key: data.round.id, win: data.round.payout > 0,
          push: o.multiplier === 1,
          title: o.multiplier > 1 ? `${o.label} — ${o.multiplier}x!` : o.multiplier === 1 ? "Pair — stake back" : "No win",
          subtitle: o.multiplier > 1 ? "The reels align!" : undefined,
          payout: o.multiplier > 1 ? data.round.payout : 0,
        });
        loadHistory();
      }
    }, 1000);
  };

  return (
    <PlayShell game={game} balance={balance}>
      <div className="rounded-2xl bg-card/55 border border-white/10 p-5">
        <div className="flex justify-center gap-2.5" data-testid="slot-reels">
          {reels.map((r, i) => (
            <div
              key={i}
              className={`h-24 w-20 rounded-xl border flex items-center justify-center bg-black/35 ${spinning ? "border-white/20" : "border-primary/35 shadow-[0_0_18px_rgba(255,199,64,0.12)]"}`}
            >
              <Symbol id={r} map={map} size={56} />
            </div>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap justify-center gap-x-3 gap-y-1">
          {ids.map((id) => (
            <span key={id} className="flex items-center gap-1 text-[10px] text-white/50">
              <Symbol id={id} map={map} size={20} /> {map[id].wild ? "WILD" : id.toUpperCase()}
            </span>
          ))}
        </div>
        <p className="text-[11px] text-white/45 text-center mt-2">3 of a kind pays the paytable · any pair returns your stake · wilds substitute</p>
      </div>

      <ResultBanner result={result} />
      <BetPanel bet={bet} setBet={setBet} onPlay={doPlay} busy={busy || spinning} playLabel="Spin" />
      <HistoryStrip history={history} />
    </PlayShell>
  );
}
