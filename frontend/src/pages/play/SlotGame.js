import { useState, useEffect, useRef } from "react";
import {
  Cherry, Citrus, Bell, Star, Sparkles, Coins, Gem, Crown, Diamond, Grape, Apple, Flower2, Fish, Flame, Zap, Circle,
} from "lucide-react";
import { useLiveRound } from "@/lib/useLiveRound";
import { sfx } from "@/lib/sound";
import { PlayShell, HistoryStrip } from "@/components/play/PlayShell";
import { LiveBar, LiveBetPanel, LastResults, ResultPill } from "@/components/play/LiveBar";
import { ResultBanner } from "@/components/play/ResultBanner";
import { CoinShower, WinBurst } from "@/pages/play/slots/slotFx";
import { FitWidth } from "@/components/FitWidth";

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
      revealSound: "reel",
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
  const isWin = showFinal && outcome.multiplier > 1;

  // reel-stop clacks + payout celebration sound, once per winning round
  const winKeyRef = useRef(null);
  const roundNo = state?.round_number || 0;
  useEffect(() => {
    if (!showFinal || winKeyRef.current === roundNo) return;
    winKeyRef.current = roundNo;
    if (outcome.multiplier >= 20) { sfx.gong(); sfx.coinShower(); sfx.slotBell(); }
    else if (outcome.multiplier > 1) { sfx.slotBell(); sfx.coinShower(); }
  }, [showFinal, outcome, roundNo]);

  return (
    <PlayShell game={game} balance={balance}>
      <LiveBar state={state} countdown={countdown} labels={{ REVEAL: "SPINNING…" }} />

      {/* ---- cinematic jackpot cabinet (3D tilt + chrome frame) ---- */}
      <div style={{ perspective: "1100px" }}>
        <div
          data-testid="slot-cabinet"
          className={`relative rounded-2xl overflow-hidden border-2 ${isWin && outcome.multiplier >= 20 ? "fg-jackpot-pulse" : ""}`}
          style={{
            borderColor: "#c9a227aa",
            background: "linear-gradient(180deg, #2a1856 0%, #1a1035 45%, #120a24 100%)",
            transform: "rotateX(6deg)",
            transformStyle: "preserve-3d",
            boxShadow: "0 18px 40px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.08)",
          }}
        >
          {isWin && <WinBurst mult={outcome.multiplier} color="#ffd447" showAt={10} />}
          {isWin && <CoinShower />}
          <span aria-hidden="true" className="absolute left-0 top-0 bottom-0 w-1.5" style={{ background: "linear-gradient(90deg, #ffe08a, #b8860b)" }} />
          <span aria-hidden="true" className="absolute right-0 top-0 bottom-0 w-1.5" style={{ background: "linear-gradient(270deg, #ffe08a, #b8860b)" }} />

          {/* marquee */}
          <div className="text-center pt-2.5 pb-2" style={{ borderBottom: "1px solid #c9a22733" }}>
            <p className="font-display text-2xl fg-neon" style={{ color: "#ffd447" }} data-testid="slot-marquee">{game.name}</p>
            <p className="text-[9px] font-extrabold tracking-[0.35em]" style={{ color: "#c4b5fd" }}>★ JACKPOT REELS ★</p>
          </div>

          {/* reels in a chrome bezel — FitWidth keeps the fixed-width reels on any phone */}
          <div className="p-4">
            <FitWidth>
            <div className="rounded-xl p-1.5 mx-auto w-fit" style={{ background: "linear-gradient(180deg, #e2e8f0, #64748b 45%, #94a3b8)" }}>
              <div className="rounded-lg p-2 flex justify-center gap-2" style={{ background: "#0d0820" }} data-testid="slot-reels">
                {reels.map((r, i) => (
                  <div
                    key={i}
                    className={`h-24 w-20 rounded-lg flex items-center justify-center relative overflow-hidden ${spinning ? "fg-reel-spinning" : ""}`}
                    style={{ background: "linear-gradient(180deg, #1e1440, #140d2c 50%, #1e1440)", boxShadow: isWin ? "0 0 16px rgba(255,212,71,0.4), inset 0 0 0 1px rgba(255,212,71,0.5)" : "inset 0 4px 8px rgba(0,0,0,0.5)" }}
                  >
                    <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-1/3 z-10" style={{ background: "linear-gradient(180deg, rgba(255,255,255,0.22), transparent)" }} />
                    <Symbol id={r} map={map} size={56} />
                  </div>
                ))}
              </div>
            </div>
            </FitWidth>
          </div>

          {/* result plate */}
          <div className="px-4 pb-3">
            <div className="rounded-lg border text-center py-1.5" style={{ borderColor: "#c9a22733", background: "rgba(0,0,0,0.3)" }}>
              <p className="text-xs font-extrabold tracking-wider" style={{ color: isWin ? "#ffd447" : "rgba(196,181,253,0.7)" }} data-testid="slot-label">
                {showFinal
                  ? outcome.label + (outcome.multiplier > 1 ? ` — PAYS ${outcome.multiplier}x` : "")
                  : spinning ? "GOOD LUCK…" : "ONE UNIVERSAL SPIN PER ROUND · 3 OF A KIND PAYS"}
              </p>
            </div>
            <div className="mt-2 flex flex-wrap justify-center gap-x-3 gap-y-1">
              {ids.map((id) => (
                <span key={id} className="flex items-center gap-1 text-[10px] text-white/50">
                  <Symbol id={id} map={map} size={18} /> {map[id].wild ? "WILD" : id.toUpperCase()}
                </span>
              ))}
            </div>
            <div className="flex justify-center mt-2">
              <LastResults items={lastResults} render={(r) => <ResultPill label={`${r.multiplier}x`} tone={r.multiplier > 1 ? "gold" : r.multiplier === 1 ? "cyan" : "neutral"} />} />
            </div>
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
