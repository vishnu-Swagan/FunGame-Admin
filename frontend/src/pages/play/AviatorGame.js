import { useState, useEffect, useRef, useCallback } from "react";
import { toast } from "sonner";
import { Users, X } from "lucide-react";
import { api, errMsg } from "@/lib/api";
import { sfx } from "@/lib/sound";
import { PlayShell, HistoryStrip } from "@/components/play/PlayShell";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { formatChips } from "@/components/common";

const PLANE_SRC = "/game-art/aviator-plane.png";

const QUICK = [50, 100, 500, 1000];

const crashTone = (c) =>
  c < 2
    ? "border-[hsl(var(--cyan)/0.35)] text-[hsl(var(--cyan))]"
    : c < 10
    ? "border-primary/40 text-primary"
    : "border-[hsl(var(--magenta)/0.4)] text-[hsl(var(--magenta))]";

/* ---------------- Spribe-style multiplier curve scene ---------------- */
const CurveScene = ({ phase, mult, growth, countdown, crashPoint }) => {
  const flying = phase === "FLYING";
  const crashed = phase === "CRASHED";
  const W = 100;
  const H = 56;
  const g = growth || 0.12;
  const elapsed = flying || crashed ? Math.log(Math.max(mult, 1.0001)) / g : 0;
  const T = Math.max(elapsed, 4);
  const M = Math.max(mult, 1.9);
  const pts = [];
  const steps = 36;
  for (let i = 0; i <= steps; i++) {
    const t = (elapsed * i) / steps;
    const x = 4 + (t / T) * (W - 16);
    const y = H - 6 - ((Math.exp(g * t) - 1) / (M - 1)) * (H - 21);
    pts.push([x, y]);
  }
  const tip = pts[pts.length - 1];
  const line = pts.map(([x, y], i) => `${i === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`).join(" ");
  const area = `${line} L ${tip[0].toFixed(2)} ${H - 6} L 4 ${H - 6} Z`;

  return (
    <div
      data-testid="aviator-stage"
      className={`relative overflow-hidden rounded-2xl border min-h-[240px] ${
        crashed ? "border-destructive/40" : flying ? "border-[hsl(var(--emerald)/0.35)]" : "border-white/10"
      }`}
      style={{ background: "radial-gradient(130% 120% at 20% 100%, #101c3a 0%, #0a1226 45%, #060b18 100%)" }}
    >
      {/* star field */}
      <div className="absolute inset-0 opacity-50" aria-hidden="true">
        {[...Array(18)].map((_, i) => (
          <span
            key={i}
            className="absolute h-[2px] w-[2px] rounded-full bg-white/60"
            style={{ left: `${(i * 53) % 100}%`, top: `${(i * 37) % 90}%`, opacity: 0.2 + ((i * 13) % 10) / 20 }}
          />
        ))}
      </div>

      {/* curve */}
      {(flying || crashed) && (
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="absolute inset-0 h-full w-full">
          <path d={area} fill={crashed ? "rgba(230,57,70,0.14)" : "rgba(255,79,154,0.16)"} />
          <path d={line} fill="none" stroke={crashed ? "#e63946" : "#ff4f9a"} strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      )}

      {/* the Aviator plane at the curve tip */}
      {(flying || crashed) && (
        <div
          className={`absolute transition-[transform,opacity] duration-300 ${crashed ? "opacity-0 translate-x-20 -translate-y-12" : ""}`}
          style={{ left: `${tip[0]}%`, top: `${(tip[1] / H) * 100}%`, transform: "translate(-42%, -78%)" }}
        >
          <img
            src={PLANE_SRC}
            alt=""
            draggable="false"
            className={`h-14 w-auto select-none drop-shadow-[0_6px_16px_rgba(255,79,154,0.45)] ${crashed ? "-rotate-[13deg]" : "fg-plane-bob"}`}
          />
        </div>
      )}

      {/* center readout */}
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        {phase === "BETTING" ? (
          <>
            <img src={PLANE_SRC} alt="" draggable="false" className="h-16 w-auto mb-1 fg-plane-idle select-none drop-shadow-[0_8px_16px_rgba(0,0,0,0.5)]" />
            <p className="text-[11px] font-bold tracking-[0.2em] text-white/55">TAKING OFF IN</p>
            <p data-testid="aviator-countdown" className="font-display text-5xl text-white/90 tabular-nums">
              {countdown.toFixed(1)}s
            </p>
            <div className="mt-2 h-1 w-40 rounded-full bg-white/10 overflow-hidden">
              <div className="h-full bg-[hsl(var(--emerald))] transition-[width] duration-150" style={{ width: `${Math.min(100, (countdown / 6) * 100)}%` }} />
            </div>
          </>
        ) : (
          <>
            {crashed && <p className="text-xs font-extrabold tracking-[0.25em] text-red-400 mb-1">FLEW AWAY!</p>}
            <p
              data-testid="aviator-multiplier"
              className={`font-display text-6xl tabular-nums ${crashed ? "text-red-400" : "text-white"}`}
            >
              {(crashed ? crashPoint : mult).toFixed(2)}x
            </p>
          </>
        )}
      </div>
    </div>
  );
};

/* ---------------- One of the two Spribe-style bet slots ---------------- */
function BetSlot({ panel, st, mult, busy, onBet, onCancel, onCashout }) {
  const [amount, setAmount] = useState(100);
  const [autoOn, setAutoOn] = useState(false);
  const [auto, setAuto] = useState("2.00");
  const phase = st?.phase;
  const bets = (st?.my_bets || []).filter((b) => b.panel === panel);
  const open = bets.find((b) => b.status === "OPEN");
  const done = bets.filter((b) => b.status === "CASHED" || b.status === "LOST").slice(-1)[0];

  const openIsLive = open && !open.queued && phase === "FLYING";
  const cancellable = open && (open.queued || phase === "BETTING");

  return (
    <div className="rounded-2xl bg-card/55 border border-white/10 p-3.5 space-y-2.5" data-testid={`aviator-panel-${panel}`}>
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-bold tracking-wider text-white/55">BET {panel}</p>
        {done && done.status === "CASHED" && (
          <span className="text-[10px] font-extrabold text-[hsl(var(--emerald))] tabular-nums">CASHED {done.multiplier}x +{formatChips(done.payout)}</span>
        )}
        {done && done.status === "LOST" && <span className="text-[10px] font-extrabold text-red-400">FLEW AWAY</span>}
      </div>

      {!open && (
        <>
          <div className="flex gap-1 flex-wrap">
            {QUICK.map((q) => (
              <button
                key={q}
                type="button"
                data-testid={`aviator-p${panel}-quick-${q}`}
                onClick={() => setAmount(q)}
                className={`rounded-lg border px-2 py-1.5 min-h-[32px] text-[11px] font-bold tabular-nums transition-[background-color,border-color] duration-150 ${
                  amount === q ? "bg-primary/15 border-primary/50 text-primary" : "bg-white/5 border-white/10 text-white/65 hover:bg-white/10"
                }`}
              >
                {formatChips(q)}
              </button>
            ))}
            <Input
              data-testid={`aviator-p${panel}-amount`}
              type="number"
              min="10"
              max="100000"
              value={amount}
              onChange={(e) => setAmount(parseInt(e.target.value, 10) || 0)}
              className="h-[32px] w-20 rounded-lg bg-white/5 border-white/12 tabular-nums text-[11px]"
              aria-label={`Bet ${panel} amount`}
            />
          </div>
          <div className="flex items-center gap-2">
            <Switch data-testid={`aviator-p${panel}-auto-toggle`} checked={autoOn} onCheckedChange={setAutoOn} aria-label="Auto cashout" />
            <span className="text-[11px] text-white/55">Auto cashout</span>
            {autoOn && (
              <Input
                data-testid={`aviator-p${panel}-auto-value`}
                type="number"
                step="0.1"
                min="1.01"
                max="200"
                value={auto}
                onChange={(e) => setAuto(e.target.value)}
                className="h-[30px] w-20 rounded-lg bg-white/5 border-white/12 tabular-nums text-[11px]"
                aria-label="Auto cashout multiplier"
              />
            )}
          </div>
        </>
      )}

      {open && !openIsLive && (
        <div className="rounded-xl border border-white/12 bg-white/5 px-3 py-2 flex items-center justify-between">
          <span className="text-[11px] text-white/60">
            {open.queued ? "Queued for next round" : "In this round"} · <span className="tabular-nums font-bold text-white/85">{formatChips(open.amount)}</span>
            {open.auto_cashout ? <span className="text-primary"> · auto {open.auto_cashout}x</span> : null}
          </span>
        </div>
      )}

      {openIsLive ? (
        <Button
          data-testid={`aviator-p${panel}-cashout`}
          onClick={() => onCashout(open.id)}
          disabled={busy}
          className="w-full h-14 rounded-xl text-base font-extrabold bg-[hsl(var(--emerald))] text-black hover:brightness-110 active:scale-[0.98] transition-[filter,transform] duration-150"
        >
          CASH OUT {formatChips(Math.floor(open.amount * mult))}
        </Button>
      ) : cancellable ? (
        <Button
          data-testid={`aviator-p${panel}-cancel`}
          onClick={() => onCancel(open.id)}
          disabled={busy}
          variant="outline"
          className="w-full h-12 rounded-xl text-sm font-bold border-destructive/40 bg-destructive/10 text-red-400 hover:bg-destructive/20"
        >
          <X className="h-4 w-4 mr-1" /> Cancel bet
        </Button>
      ) : open ? (
        <Button disabled className="w-full h-12 rounded-xl text-sm font-bold">
          Waiting for takeoff…
        </Button>
      ) : (
        <Button
          data-testid={`aviator-p${panel}-bet`}
          onClick={() => onBet(panel, amount, autoOn ? auto : null)}
          disabled={busy || !amount || amount < 10}
          className="w-full h-12 rounded-xl text-sm font-extrabold hover:brightness-110 active:scale-[0.98] transition-[filter,transform] duration-150"
        >
          {phase === "BETTING" ? `BET ${formatChips(amount || 0)}` : `BET NEXT ROUND ${formatChips(amount || 0)}`}
        </Button>
      )}
    </div>
  );
}

/* ---------------- Main page ---------------- */
export default function AviatorGame({ game }) {
  const [st, setSt] = useState(null);
  const [balance, setBalance] = useState(null);
  const [mult, setMult] = useState(1.0);
  const [countdown, setCountdown] = useState(0);
  const [history, setHistory] = useState([]);
  const [busy, setBusy] = useState(false);
  const stRef = useRef(null);
  const flyStartRef = useRef(null);
  const deadlineRef = useRef(0);
  const growthRef = useRef(0.12);

  const loadHistory = useCallback(async () => {
    try {
      const { data } = await api.get("/games/aviator/history");
      setHistory(data.rounds || []);
    } catch (e) {
      /* silent */
    }
  }, []);

  const poll = useCallback(async () => {
    try {
      const { data } = await api.get("/live/aviator/state");
      const prev = stRef.current;
      stRef.current = data;
      setSt(data);
      setBalance(data.balance);
      growthRef.current = data.growth || 0.12;
      if (data.phase === "FLYING") {
        flyStartRef.current = Date.now() - data.fly_elapsed * 1000;
      } else {
        deadlineRef.current = Date.now() + (data.phase_ends_in || 0) * 1000;
        if (data.phase === "CRASHED") setMult(data.crash_point);
        if (data.phase === "BETTING") setMult(1.0);
      }
      // phase-transition sounds (universal round, heard by everyone watching)
      if (prev && prev.phase !== data.phase) {
        if (data.phase === "FLYING") sfx.takeoff();
        if (data.phase === "CRASHED" && prev.phase === "FLYING") {
          sfx.crash();
          // crowd reacts to MY outcome
          const lostBet = (data.my_bets || []).some((b) => b.status === "LOST");
          const cashedBet = (data.my_bets || []).some((b) => b.status === "CASHED");
          if (lostBet) sfx.aww();
          else if (cashedBet) sfx.clap(false);
        }
      }
      // refresh my history when a round I was in finishes
      if (prev && prev.phase !== "CRASHED" && data.phase === "CRASHED" && (prev.my_bets || []).length > 0) {
        loadHistory();
      }
    } catch (e) {
      /* transient */
    }
  }, [loadHistory]);

  useEffect(() => {
    poll();
    loadHistory();
    const p = setInterval(poll, 800);
    const anim = setInterval(() => {
      const s = stRef.current;
      if (s?.phase === "FLYING" && flyStartRef.current) {
        const elapsed = (Date.now() - flyStartRef.current) / 1000;
        setMult(Math.max(1, Math.exp(growthRef.current * elapsed)));
      } else {
        setCountdown(Math.max(0, (deadlineRef.current - Date.now()) / 1000));
      }
    }, 60);
    return () => {
      clearInterval(p);
      clearInterval(anim);
    };
  }, [poll, loadHistory]);

  const placeBet = async (panel, amount, auto) => {
    setBusy(true);
    try {
      const body = { amount, panel };
      if (auto) body.auto_cashout = parseFloat(auto);
      const { data } = await api.post("/live/aviator/bets", body);
      setBalance(data.balance);
      sfx.chip();
      toast.success(data.queued ? "Bet queued for the next round" : "Bet placed — good luck!");
      await poll();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const cancelBet = async (betId) => {
    setBusy(true);
    try {
      const { data } = await api.post("/live/aviator/bets/cancel", { bet_id: betId });
      setBalance(data.balance);
      toast.success(`Bet cancelled — ${formatChips(data.refunded)} refunded`);
      await poll();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const cashout = async (betId) => {
    setBusy(true);
    try {
      const { data } = await api.post("/live/aviator/cashout", { bet_id: betId });
      setBalance(data.balance);
      if (data.result === "cashed_out") {
        sfx.cashout();
        (data.multiplier >= 5 ? sfx.bigWinCelebration : sfx.winCelebration)();
        toast.success(`Cashed out at ${data.multiplier}x — +${formatChips(data.payout)} chips`);
      } else {
        sfx.lose();
        sfx.aww();
        toast.error(`Too late — crashed at ${data.crash_point}x`);
      }
      await poll();
      loadHistory();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <PlayShell game={game} balance={balance}>
      {/* universal crash history */}
      <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5" data-testid="aviator-history-strip">
        <span className="inline-flex items-center gap-1 rounded-full bg-white/8 px-2 py-1 text-[9px] font-bold tracking-widest text-white/60 shrink-0">
          <span className="h-1.5 w-1.5 rounded-full bg-[hsl(var(--emerald))] animate-pulse" /> LIVE 24/7
        </span>
        {(st?.history || []).map((h) => (
          <span
            key={h.round_number}
            className={`shrink-0 rounded-full border bg-black/30 px-2 py-1 text-[10px] font-extrabold tabular-nums ${crashTone(h.crash_point)}`}
          >
            {h.crash_point.toFixed(2)}x
          </span>
        ))}
      </div>

      <CurveScene phase={st?.phase} mult={mult} growth={st?.growth} countdown={countdown} crashPoint={st?.crash_point ?? mult} />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
        <BetSlot panel={1} st={st} mult={mult} busy={busy} onBet={placeBet} onCancel={cancelBet} onCashout={cashout} />
        <BetSlot panel={2} st={st} mult={mult} busy={busy} onBet={placeBet} onCancel={cancelBet} onCashout={cashout} />
      </div>

      {/* all bets feed */}
      <div className="rounded-2xl bg-card/55 border border-white/10 p-3.5" data-testid="aviator-feed">
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs font-semibold text-white/60 flex items-center gap-1.5">
            <Users className="h-3.5 w-3.5 text-white/45" /> Bets this round
          </p>
          <p className="text-[11px] text-white/45 tabular-nums">
            {st?.players || 0} bets · {formatChips(st?.total_staked || 0)} staked
          </p>
        </div>
        {(st?.all_bets || []).length === 0 ? (
          <p className="text-[11px] text-white/35 text-center py-2">No bets yet — be the first aboard</p>
        ) : (
          <div className="space-y-1 max-h-[150px] overflow-y-auto">
            {(st?.all_bets || []).map((b, i) => (
              <div key={i} className="flex items-center justify-between text-[11px]">
                <span className="text-white/60">{b.name}</span>
                <span className="tabular-nums text-white/50">{formatChips(b.amount)}</span>
                <span
                  className={`tabular-nums font-bold ${
                    b.status === "CASHED" ? "text-[hsl(var(--emerald))]" : b.status === "LOST" ? "text-red-400" : "text-white/45"
                  }`}
                >
                  {b.status === "CASHED" ? `${b.multiplier}x +${formatChips(b.payout)}` : b.status === "LOST" ? "flew away" : "flying…"}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <p className="text-[11px] text-white/40">
        One universal plane for all players, 24/7. Bet before takeoff, cash out before it flies away. Auto cashout locks your multiplier automatically.
      </p>
      <HistoryStrip history={history} />
    </PlayShell>
  );
}
