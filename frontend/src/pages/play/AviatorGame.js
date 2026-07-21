import { useState, useEffect, useRef, useCallback } from "react";
import { toast } from "sonner";
import { Users, X } from "lucide-react";
import { api, errMsg } from "@/lib/api";
import { flight } from "@/lib/sound";
import { PlayShell, HistoryStrip } from "@/components/play/PlayShell";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { formatChips } from "@/components/common";
import { publishWins } from "@/lib/liveActivity";

const PLANE_SRC = "/game-art/aviator-plane.png";

const QUICK = [50, 100, 500, 1000];

const crashTone = (c) =>
  c < 2
    ? "border-[hsl(var(--cyan)/0.35)] text-[hsl(var(--cyan))]"
    : c < 10
    ? "border-primary/40 text-primary"
    : "border-[hsl(var(--magenta)/0.4)] text-[hsl(var(--magenta))]";

/* ---------------- Realistic multiplier flight scene ---------------- */
const heatColor = (m) => {
  if (m >= 10) return { c: "#ff5a5f", g: "rgba(230,57,70,0.65)", fill: "rgba(230,57,70,0.22)" };
  if (m >= 5) return { c: "#ff7ac0", g: "rgba(255,79,154,0.60)", fill: "rgba(255,79,154,0.18)" };
  if (m >= 2) return { c: "#ffc740", g: "rgba(255,199,64,0.55)", fill: "rgba(255,199,64,0.16)" };
  return { c: "#7cf6c9", g: "rgba(52,211,153,0.50)", fill: "rgba(52,211,153,0.14)" };
};

// two full-width drifting cloud bands (compositor-only translateX)
const CloudBand = ({ cls, top, opacity }) => (
  <div
    aria-hidden="true"
    className={`absolute ${cls}`}
    style={{
      top,
      left: 0,
      width: "200%",
      height: 70,
      opacity,
      background:
        "radial-gradient(60px 22px at 12% 50%, rgba(255,255,255,0.9), transparent 72%)," +
        "radial-gradient(90px 30px at 40% 60%, rgba(255,255,255,0.8), transparent 72%)," +
        "radial-gradient(54px 20px at 68% 42%, rgba(255,255,255,0.7), transparent 72%)," +
        "radial-gradient(76px 26px at 90% 58%, rgba(255,255,255,0.75), transparent 72%)",
      filter: "blur(2px)",
    }}
  />
);

const CurveScene = ({ phase, mult, growth, countdown, crashPoint }) => {
  const flying = phase === "FLYING";
  const crashed = phase === "CRASHED";
  const betting = phase === "BETTING";
  const W = 100;
  const H = 56;
  const g = growth || 0.12;
  const shown = crashed ? crashPoint : mult;
  const heat = heatColor(shown);
  const elapsed = flying || crashed ? Math.log(Math.max(mult, 1.0001)) / g : 0;
  const T = Math.max(elapsed, 4);
  const M = Math.max(mult, 1.9);
  const pts = [];
  const steps = 40;
  for (let i = 0; i <= steps; i++) {
    const t = (elapsed * i) / steps;
    const x = 4 + (t / T) * (W - 16);
    const y = H - 6 - ((Math.exp(g * t) - 1) / (M - 1)) * (H - 21);
    pts.push([x, y]);
  }
  const tip = pts[pts.length - 1];
  const line = pts.map(([x, y], i) => `${i === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`).join(" ");
  const area = `${line} L ${tip[0].toFixed(2)} ${H - 6} L 4 ${H - 6} Z`;
  // sky warms as the plane climbs (danger builds)
  const warm = Math.min(0.6, Math.max(0, (shown - 1.4) / 12));
  const ring = betting ? Math.min(1, countdown / 6) : 0;
  const R = 26, CIRC = 2 * Math.PI * R;

  return (
    <div
      data-testid="aviator-stage"
      className={`relative overflow-hidden rounded-2xl border min-h-[248px] ${crashed ? "fg-av-shake" : ""} ${
        crashed ? "border-destructive/45" : flying ? "border-[hsl(var(--emerald)/0.35)]" : "border-white/10"
      }`}
      style={{
        background:
          "radial-gradient(120% 90% at 50% 118%, rgba(255,150,60," + warm + ") 0%, transparent 55%)," +
          "radial-gradient(130% 130% at 22% 108%, #16244e 0%, #0d1834 42%, #060b1a 100%)",
      }}
    >
      {/* stars */}
      <div className="absolute inset-0" aria-hidden="true">
        {[...Array(22)].map((_, i) => (
          <span
            key={i}
            className="absolute rounded-full bg-white"
            style={{
              left: `${(i * 41) % 100}%`,
              top: `${(i * 29) % 70}%`,
              height: i % 5 === 0 ? 2.5 : 1.5,
              width: i % 5 === 0 ? 2.5 : 1.5,
              animation: `fg-av-twinkle ${2 + (i % 4)}s ease-in-out ${i * 0.13}s infinite`,
            }}
          />
        ))}
      </div>
      {/* drifting cloud parallax */}
      <CloudBand cls="fg-av-cloud2" top="18%" opacity={0.1} />
      <CloudBand cls="fg-av-cloud" top="52%" opacity={0.14} />
      {/* faint altitude grid */}
      <div
        className="absolute inset-0 opacity-[0.12]"
        aria-hidden="true"
        style={{
          backgroundImage: "linear-gradient(rgba(255,255,255,0.4) 1px, transparent 1px)",
          backgroundSize: "100% 28px",
          maskImage: "linear-gradient(to top, black, transparent 85%)",
          WebkitMaskImage: "linear-gradient(to top, black, transparent 85%)",
        }}
      />

      {/* the climbing curve with glowing gradient fill + hot leading edge */}
      {(flying || crashed) && (
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="absolute inset-0 h-full w-full">
          <defs>
            <linearGradient id="avFill" x1="0" y1="1" x2="0" y2="0">
              <stop offset="0%" stopColor={heat.fill} stopOpacity="0.05" />
              <stop offset="100%" stopColor={heat.fill} />
            </linearGradient>
          </defs>
          <path d={area} fill="url(#avFill)" />
          <path
            d={line}
            fill="none"
            stroke={crashed ? "#e63946" : heat.c}
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ filter: `drop-shadow(0 0 2px ${crashed ? "rgba(230,57,70,0.8)" : heat.g})` }}
          />
          {!crashed && <circle cx={tip[0]} cy={tip[1]} r="1.8" fill="#fff" style={{ filter: `drop-shadow(0 0 3px ${heat.g})` }} />}
        </svg>
      )}

      {/* plane at the curve tip — banks while flying, rockets off on crash */}
      {(flying || crashed) && (
        <div className="absolute" style={{ left: `${tip[0]}%`, top: `${(tip[1] / H) * 100}%` }}>
          <div className={crashed ? "fg-av-flyaway" : "fg-av-fly"}>
            {/* prop wash glow */}
            {flying && (
              <span
                className="absolute left-1/2 top-1/2 h-3 w-8 -translate-x-[130%] -translate-y-1/2 rounded-full fg-av-prop"
                style={{ background: `radial-gradient(closest-side, ${heat.g}, transparent)` }}
              />
            )}
            <img
              src={PLANE_SRC}
              alt=""
              draggable="false"
              className="h-14 w-auto select-none"
              style={{ filter: `drop-shadow(0 4px 12px ${heat.g})` }}
            />
          </div>
        </div>
      )}

      {/* crash red flash */}
      {crashed && <div className="absolute inset-0 bg-red-500/40 fg-av-flash pointer-events-none" aria-hidden="true" />}

      {/* center readout */}
      <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
        {betting ? (
          <>
            <img src={PLANE_SRC} alt="" draggable="false" className="h-16 w-auto mb-2 fg-av-idle select-none drop-shadow-[0_10px_18px_rgba(0,0,0,0.55)]" />
            {/* moving runway speed lines */}
            <div
              className="h-[3px] w-44 rounded-full fg-av-runway mb-3 opacity-70"
              style={{ background: "repeating-linear-gradient(90deg, rgba(255,199,64,0.9) 0 14px, transparent 14px 42px)" }}
            />
            <div className="relative h-16 w-16 grid place-items-center">
              <svg viewBox="0 0 64 64" className="absolute inset-0 h-full w-full -rotate-90">
                <circle cx="32" cy="32" r={R} fill="none" stroke="rgba(255,255,255,0.10)" strokeWidth="4" />
                <circle cx="32" cy="32" r={R} fill="none" stroke="hsl(var(--emerald))" strokeWidth="4" strokeLinecap="round" strokeDasharray={CIRC} strokeDashoffset={CIRC * (1 - ring)} style={{ transition: "stroke-dashoffset 0.15s linear" }} />
              </svg>
              <span data-testid="aviator-countdown" className="font-display text-2xl text-white/95 tabular-nums">{countdown.toFixed(1)}</span>
            </div>
            <p className="text-[10px] font-bold tracking-[0.25em] text-white/50 mt-2">TAKING OFF</p>
          </>
        ) : (
          <>
            {crashed && <p className="text-xs font-extrabold tracking-[0.28em] text-red-400 mb-1">FLEW AWAY!</p>}
            <p
              data-testid="aviator-multiplier"
              className={`font-display tabular-nums leading-none ${crashed ? "text-red-400" : "fg-av-pulse"}`}
              style={{ fontSize: `clamp(3rem, ${3 + Math.min(2.4, (shown - 1) * 0.3)}rem, 5.4rem)`, color: crashed ? undefined : heat.c, textShadow: `0 0 22px ${heat.g}` }}
            >
              {shown.toFixed(2)}x
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
      // flight engine: the ONLY sound in Aviator (user request) - real plane
      // engine while flying, doppler fly-away when it crashes
      if (prev && prev.phase !== data.phase) {
        if (data.phase === "FLYING") flight.start();
        if (data.phase === "CRASHED" && prev.phase === "FLYING") flight.flyAway();
      } else if (!prev && data.phase === "FLYING") {
        flight.start(); // joined mid-flight
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
        const m = Math.max(1, Math.exp(growthRef.current * elapsed));
        setMult(m);
        flight.set(m); // engine pitch climbs with the plane
      } else {
        setCountdown(Math.max(0, (deadlineRef.current - Date.now()) / 1000));
      }
    }, 60);
    return () => {
      clearInterval(p);
      clearInterval(anim);
      flight.stop(); // leaving the page cuts the engine
    };
  }, [poll, loadHistory]);

  const placeBet = async (panel, amount, auto) => {
    setBusy(true);
    try {
      const body = { amount, panel };
      if (auto) body.auto_cashout = parseFloat(auto);
      const { data } = await api.post("/live/aviator/bets", body);
      setBalance(data.balance);
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
        toast.success(`Cashed out at ${data.multiplier}x — +${formatChips(data.payout)} chips`);
        publishWins("aviator", [{ id: `me-av-${betId}`, mine: true, payout: data.payout, bet: 0 }]);
      } else {
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
