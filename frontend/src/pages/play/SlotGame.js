import { useState, useEffect } from "react";
import {
  Cherry, Citrus, Bell, Star, Sparkles, Coins, Gem, Crown, Diamond, Grape, Apple, Flower2, Fish, Flame, Zap, Circle,
} from "lucide-react";
import { useLiveRound } from "@/lib/useLiveRound";
import { PlayShell, HistoryStrip } from "@/components/play/PlayShell";
import { LiveBar, LiveBetPanel, LastResults, ResultPill } from "@/components/play/LiveBar";
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
  const { state, countdown, balance, betting, phase, outcome, result, history, placeBet, clearBets, myTotal, lastResults, placing, myBets } =
    useLiveRound(game.slug, {
      formatResult: (s) => ({
        push: s.outcome.multiplier === 1,
        title: s.outcome.multiplier > 1 ? `${s.outcome.label} — ${s.outcome.multiplier}x!` : s.outcome.multiplier === 1 ? "Pair — stake back" : "No win",
        subtitle: s.outcome.multiplier > 1 ? "The reels align!" : undefined,
      }),
    });
  const map = SYMBOLS[game.slug] || SYMBOLS["fever-joker-bonus"];
  const ids = Object.keys(map);
  const [amount, setAmount] = useState(50);
  const [anim, setAnim] = useState([ids[0], ids[1], ids[2]]);

  useEffect(() => {
    if (phase !== "REVEAL") return;
    const t = setInterval(() => {
      setAnim([0, 1, 2].map(() => ids[Math.floor(Math.random() * ids.length)]));
    }, 90);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const showFinal = !!outcome && (phase === "RESULT" || (phase === "REVEAL" && countdown < 1.2));
  const spinning = phase === "REVEAL" && !showFinal;
  const reels = showFinal ? outcome.reels : spinning ? anim : [ids[0], ids[1], ids[2]];

  return (
    <PlayShell game={game} balance={balance}>
      <LiveBar state={state} countdown={countdown} labels={{ REVEAL: "SPINNING…" }} />

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
        {showFinal && phase === "RESULT" && (
          <p className="text-center text-sm font-bold text-white/85 mt-2" data-testid="slot-label">
            {outcome.label}{outcome.multiplier > 1 ? ` — ${outcome.multiplier}x` : ""}
          </p>
        )}
        <div className="mt-3 flex flex-wrap justify-center gap-x-3 gap-y-1">
          {ids.map((id) => (
            <span key={id} className="flex items-center gap-1 text-[10px] text-white/50">
              <Symbol id={id} map={map} size={20} /> {map[id].wild ? "WILD" : id.toUpperCase()}
            </span>
          ))}
        </div>
        <p className="text-[11px] text-white/45 text-center mt-2">One universal spin per round · 3 of a kind pays · pairs return your stake · wilds substitute</p>
        <div className="flex justify-center mt-2">
          <LastResults items={lastResults} render={(r) => <ResultPill label={`${r.multiplier}x`} tone={r.multiplier > 1 ? "gold" : r.multiplier === 1 ? "cyan" : "neutral"} />} />
        </div>
      </div>

      <ResultBanner result={result} />
      <LiveBetPanel
        amount={amount}
        setAmount={setAmount}
        onPlace={() => placeBet(null, amount)}
        betting={betting}
        placing={placing}
        label="Join this spin"
        myTotal={myTotal}
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
