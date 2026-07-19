import { useState, useRef, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { Plane } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, errMsg } from "@/lib/api";
import { useGamePlay } from "@/lib/useGamePlay";
import { PlayShell, HistoryStrip } from "@/components/play/PlayShell";
import { BetPanel } from "@/components/play/BetPanel";
import { ResultBanner } from "@/components/play/ResultBanner";
import { formatChips } from "@/components/common";

const GROWTH = 0.12; // must match backend

export default function AviatorGame({ game }) {
  const { balance, setBalance, busy, history, loadHistory, play } = useGamePlay(game.slug);
  const [bet, setBet] = useState(50);
  const [phase, setPhase] = useState("bet"); // bet | flying | done
  const [mult, setMult] = useState(1.0);
  const [result, setResult] = useState(null);
  const roundRef = useRef(null);
  const startRef = useRef(0);
  const animRef = useRef(null);
  const pollRef = useRef(null);
  const cashingRef = useRef(false);

  const stopLoops = useCallback(() => {
    clearInterval(animRef.current);
    clearInterval(pollRef.current);
  }, []);

  useEffect(() => () => stopLoops(), [stopLoops]);

  const crash = useCallback((crashPoint, newBalance) => {
    stopLoops();
    setPhase("done");
    setMult(crashPoint);
    if (typeof newBalance === "number") setBalance(newBalance);
    setResult({ key: `${roundRef.current}-crash`, win: false, title: `Flew away at ${crashPoint}x`, subtitle: "You didn't cash out in time", payout: 0 });
    loadHistory();
  }, [stopLoops, setBalance, loadHistory]);

  const start = async () => {
    setResult(null);
    const data = await play(bet, {});
    if (!data) return;
    roundRef.current = data.round_id;
    startRef.current = Date.now();
    cashingRef.current = false;
    setMult(1.0);
    setPhase("flying");
    animRef.current = setInterval(() => {
      const elapsed = (Date.now() - startRef.current) / 1000;
      setMult(Math.round(Math.exp(GROWTH * elapsed) * 100) / 100);
    }, 80);
    pollRef.current = setInterval(async () => {
      try {
        const { data: st } = await api.get(`/games/aviator/round/${roundRef.current}`);
        if (st.status === "CRASHED") crash(st.crash_point, st.balance);
      } catch (e) {
        // network hiccup - keep flying, next poll will retry
      }
    }, 700);
  };

  const cashout = async () => {
    if (cashingRef.current) return;
    cashingRef.current = true;
    try {
      const { data } = await api.post("/games/aviator/cashout", { round_id: roundRef.current });
      stopLoops();
      setPhase("done");
      setBalance(data.balance);
      if (data.result === "cashed_out") {
        setMult(data.multiplier);
        setResult({ key: `${roundRef.current}-win`, win: true, title: `Cashed out at ${data.multiplier}x!`, subtitle: `The plane flew until ${data.crash_point}x`, payout: data.payout });
      } else {
        setMult(data.crash_point);
        setResult({ key: `${roundRef.current}-late`, win: false, title: `Too late — crashed at ${data.crash_point}x`, payout: 0 });
      }
      loadHistory();
    } catch (e) {
      toast.error(errMsg(e));
      cashingRef.current = false;
    }
  };

  const flying = phase === "flying";

  return (
    <PlayShell game={game} balance={balance}>
      <div className={`relative overflow-hidden rounded-2xl border p-6 min-h-[190px] flex flex-col items-center justify-center ${flying ? "border-[hsl(var(--emerald)/0.4)] bg-[hsl(var(--emerald)/0.05)]" : result && !result.win ? "border-destructive/40 bg-destructive/5" : "border-white/10 bg-card/55"}`}>
        <Plane
          className={`h-9 w-9 mb-1 transition-transform duration-300 ${flying ? "text-[hsl(var(--emerald))] -rotate-12 -translate-y-2" : result && !result.win ? "text-red-400 rotate-45 translate-y-2" : "text-white/40"}`}
        />
        <p data-testid="aviator-multiplier" className={`font-display text-6xl tabular-nums ${flying ? "text-[hsl(var(--emerald))]" : result && !result.win ? "text-red-400" : "text-white/85"}`}>
          {mult.toFixed(2)}x
        </p>
        {flying && <p className="text-xs text-white/55 mt-1 tabular-nums">potential win: {formatChips(Math.floor(bet * mult))}</p>}
        {!flying && phase === "bet" && <p className="text-xs text-white/45 mt-1">Cash out before the plane flies away</p>}
      </div>

      <ResultBanner result={result} />

      {flying ? (
        <Button
          data-testid="aviator-cashout-button"
          onClick={cashout}
          className="w-full h-14 rounded-xl text-lg font-extrabold bg-[hsl(var(--emerald))] text-black hover:brightness-110 active:scale-[0.98] transition-[filter,transform] duration-150"
        >
          CASH OUT — {formatChips(Math.floor(bet * mult))}
        </Button>
      ) : (
        <BetPanel bet={bet} setBet={setBet} onPlay={start} busy={busy} playLabel="Take off" />
      )}
      <HistoryStrip history={history} />
    </PlayShell>
  );
}
