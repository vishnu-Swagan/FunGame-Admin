import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { toast } from "sonner";
import { CalendarDays, History, Minus, Plus, Trophy, UserRound, Users, X } from "lucide-react";
import { api, errMsg } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { flight } from "@/lib/sound";
import { GameStage } from "@/components/play/GameStage";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { formatChips } from "@/components/common";
import { publishWins } from "@/lib/liveActivity";

const PLANE_SRC = "/game-art/aviator-craft.svg";

const QUICK = [100, 200, 500, 1000];

const formatRoundDate = (value) => {
  if (!value) return "—";
  return new Date(value).toLocaleString(undefined, {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
};

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

const CurveScene = ({ phase, mult, growth, countdown, crashPoint, roundNumber }) => {
  const flying = phase === "FLYING";
  const crashed = phase === "CRASHED";
  const betting = phase === "BETTING" || !phase;
  const W = 100;
  const H = 56;
  const g = growth || 0.12;
  const shown = crashed ? crashPoint : mult;
  const heat = heatColor(shown);
  const elapsed = flying || crashed ? Math.log(Math.max(shown, 1.0001)) / g : 0;
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
  const ring = betting ? Math.min(1, countdown / 5) : 0;
  const R = 26, CIRC = 2 * Math.PI * R;

  return (
    <div
      data-testid="aviator-stage"
      className={`relative h-full min-h-[248px] overflow-hidden rounded-2xl border ${crashed ? "fg-av-shake" : ""} ${
        crashed ? "border-destructive/45" : flying ? "border-[hsl(var(--emerald)/0.35)]" : "border-white/10"
      }`}
      style={{
        /* Near-black, so the spokes and the lit core carry the panel. The navy
           sky washed them out — on a dark ground the rays read as light rather
           than as a texture laid over blue. */
        background:
          "radial-gradient(120% 90% at 50% 120%, rgba(255,150,60," + warm + ") 0%, transparent 48%)," +
          "radial-gradient(140% 120% at 8% 96%, #0a0a12 0%, #05050b 55%, #030307 100%)",
      }}
    >
      {/* the spokes, and the lit core they fan out of */}
      <div className="fg-av-core" aria-hidden="true" />
      <div className="fg-av-rays" aria-hidden="true" />
      <div className="fg-av-axis fg-av-axis-x" aria-hidden="true" />
      <div className="fg-av-axis fg-av-axis-y" aria-hidden="true" />
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
              {/* One red, not a hue that shifts with the multiplier. The
                  reference reads as a single instrument because the trace never
                  changes colour — only the number climbs. */}
              <stop offset="0%" stopColor="#c0121f" stopOpacity="0.10" />
              <stop offset="55%" stopColor="#d81b2a" stopOpacity="0.42" />
              <stop offset="100%" stopColor="#ef2337" stopOpacity="0.72" />
            </linearGradient>
          </defs>
          <path d={area} fill="url(#avFill)" />
          <path
            d={line}
            fill="none"
            stroke={crashed ? "#8d1420" : "#ff2740"}
            strokeWidth="2.1"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ filter: `drop-shadow(0 0 2px rgba(255,39,64,0.85))` }}
          />
          {!crashed && <circle cx={tip[0]} cy={tip[1]} r="1.8" fill="#fff" style={{ filter: `drop-shadow(0 0 3px ${heat.g})` }} />}
        </svg>
      )}

      {/* Exactly one aircraft node exists for the whole round. Updating this
          node's phase class prevents the live craft and the fly-away craft
          from overlapping during the FLYING -> CRASHED transition. */}
      <div
        data-testid="aviator-flight-craft"
        data-round={roundNumber || "syncing"}
        className="absolute z-20 pointer-events-none"
        style={{
          left: betting ? "50%" : `${tip[0]}%`,
          top: betting ? "31%" : `${(tip[1] / H) * 100}%`,
        }}
      >
        <div className={betting ? "fg-av-craft-idle" : crashed ? "fg-av-craft-away" : "fg-av-craft-live"}>
          {flying && (
            <span
              className="absolute left-0 top-1/2 h-4 w-14 -translate-x-[62%] -translate-y-1/2 rounded-full fg-av-prop"
              style={{ background: `radial-gradient(closest-side, ${heat.g}, transparent)` }}
            />
          )}
          <img
            src={PLANE_SRC}
            alt=""
            draggable="false"
            className="h-11 sm:h-14 lg:h-16 w-auto select-none"
            style={{ filter: `drop-shadow(0 5px 14px ${heat.g})` }}
          />
        </div>
      </div>

      {/* crash red flash */}
      {crashed && <div className="absolute inset-0 bg-red-500/40 fg-av-flash pointer-events-none" aria-hidden="true" />}

      <div className="absolute right-3 top-3 z-20 flex items-center gap-2 rounded-full border border-white/10 bg-black/45 px-2.5 py-1 text-[10px] font-bold text-white/60 backdrop-blur-sm">
        <span className="tabular-nums">ROUND #{roundNumber || "—"}</span>
        <span className="h-1 w-1 rounded-full bg-white/30" />
        <span data-testid="aviator-flight-time" className="tabular-nums text-white/85">
          {flying || crashed ? `${elapsed.toFixed(1)}s` : `${countdown.toFixed(1)}s`}
        </span>
      </div>

      {/* center readout */}
      <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
        {betting ? (
          <>
            <p className="mb-1 mt-16 text-xs font-black italic tracking-[0.24em] text-[#ed1742]">AVIATOR</p>
            <div className="relative h-16 w-16 grid place-items-center">
              <svg viewBox="0 0 64 64" className="absolute inset-0 h-full w-full -rotate-90">
                <circle cx="32" cy="32" r={R} fill="none" stroke="rgba(255,255,255,0.10)" strokeWidth="4" />
                <circle cx="32" cy="32" r={R} fill="none" stroke="hsl(var(--emerald))" strokeWidth="4" strokeLinecap="round" strokeDasharray={CIRC} strokeDashoffset={CIRC * (1 - ring)} style={{ transition: "stroke-dashoffset 0.15s linear" }} />
              </svg>
              <span data-testid="aviator-countdown" className="font-display text-2xl text-white/95 tabular-nums">{countdown.toFixed(1)}</span>
            </div>
            <p className="text-[10px] font-bold tracking-[0.25em] text-white/50 mt-2">WAITING FOR NEXT ROUND</p>
          </>
        ) : (
          <>
            {crashed && <p className="text-sm font-extrabold tracking-[0.28em] text-white mb-2">FLEW AWAY!</p>}
            <p
              data-testid="aviator-multiplier"
              className={`font-display tabular-nums leading-none ${crashed ? "text-red-400" : "fg-av-pulse"}`}
              style={{ fontSize: `clamp(3rem, ${3 + Math.min(2.4, (shown - 1) * 0.3)}rem, 5.4rem)`, color: crashed ? "#e2081c" : "#fff", textShadow: "0 2px 26px rgba(0,0,0,.7), 0 0 42px rgba(150,110,255,.35)" }}
            >
              {shown.toFixed(2)}x
            </p>
            <p className="mt-2 text-[11px] font-semibold tracking-[0.18em] text-white/45 tabular-nums">
              FLIGHT TIME {elapsed.toFixed(1)} SEC
            </p>
          </>
        )}
      </div>
    </div>
  );
};

/* ---------------- One of the two Spribe-style bet slots ---------------- */
function BetSlot({ panel, st, mult, busy, onBet, onCancel, onCashout }) {
  const [amount, setAmount] = useState("10");
  const [mode, setMode] = useState("auto");
  const [autoOn, setAutoOn] = useState(true);
  const [auto, setAuto] = useState("2.00");
  const [autoRounds, setAutoRounds] = useState(10);
  const [autoRemaining, setAutoRemaining] = useState(0);
  const [autoPlaying, setAutoPlaying] = useState(false);
  const autoRoundRef = useRef(null);
  const autoRemainingRef = useRef(0);
  const autoBusyRef = useRef(false);
  const phase = st?.phase;
  const bets = (st?.my_bets || []).filter((b) => b.panel === panel);
  const open = bets.find((b) => b.status === "OPEN");
  const done = bets.filter((b) => b.status === "CASHED" || b.status === "LOST").slice(-1)[0];
  const amountValue = Number(amount) || 0;
  const autoTarget = Math.min(200, Math.max(1.01, Number(auto) || 2));

  const openIsLive = open && !open.queued && phase === "FLYING";
  const cancellable = open && (open.queued || phase === "BETTING");

  useEffect(() => {
    if (!autoPlaying || phase !== "BETTING" || open || busy || autoBusyRef.current || !st?.round_number) return;
    if (autoRoundRef.current === st.round_number) return;
    autoRoundRef.current = st.round_number;
    autoBusyRef.current = true;

    Promise.resolve(onBet(panel, amountValue, autoOn ? autoTarget : null, { automatic: true }))
      .then((accepted) => {
        if (!accepted) {
          setAutoPlaying(false);
          return;
        }
        const left = Math.max(0, autoRemainingRef.current - 1);
        autoRemainingRef.current = left;
        setAutoRemaining(left);
        if (left === 0) setAutoPlaying(false);
      })
      .finally(() => {
        autoBusyRef.current = false;
      });
  }, [amountValue, autoOn, autoPlaying, autoTarget, busy, onBet, open, panel, phase, st?.round_number]);

  const startAuto = () => {
    autoRoundRef.current = null;
    autoRemainingRef.current = autoRounds;
    setAutoRemaining(autoRounds);
    setAutoPlaying(true);
    toast.success(`Auto Play started on Bet ${panel}`);
  };

  const stopAuto = () => {
    setAutoPlaying(false);
    toast.info(`Auto Play stopped on Bet ${panel}`);
  };

  const setSafeAmount = (next) => setAmount(String(Math.min(100000, Math.max(10, Number(next) || 10))));

  return (
    <div className="rounded-2xl border border-white/10 bg-[#1b1b1d] p-2.5 space-y-2" data-testid={`aviator-panel-${panel}`}>
      <div className="flex items-center gap-2">
        <div className="flex flex-1 rounded-full bg-black/35 p-0.5" role="tablist" aria-label={`Bet ${panel} mode`}>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "bet"}
            onClick={() => !autoPlaying && setMode("bet")}
            className={`flex-1 rounded-full px-3 py-1 text-[10px] font-bold transition-colors ${mode === "bet" ? "bg-white/14 text-white" : "text-white/45"}`}
          >
            Bet
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "auto"}
            data-testid={`aviator-p${panel}-auto-tab`}
            onClick={() => setMode("auto")}
            className={`flex-1 rounded-full px-3 py-1 text-[10px] font-bold transition-colors ${mode === "auto" ? "bg-white/14 text-white" : "text-white/45"}`}
          >
            Auto
          </button>
        </div>
        {done && done.status === "CASHED" && (
          <span className="shrink-0 text-[9px] font-extrabold text-[hsl(var(--emerald))] tabular-nums">{Number(done.multiplier).toFixed(2)}x +{formatChips(done.payout)}</span>
        )}
        {done && done.status === "LOST" && <span className="text-[10px] font-extrabold text-red-400">FLEW AWAY</span>}
      </div>

      {!open && (
        <>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setSafeAmount(amountValue - 10)}
              disabled={autoPlaying}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-black/35 text-white/55 disabled:opacity-40"
              aria-label={`Decrease Bet ${panel}`}
            >
              <Minus className="h-3.5 w-3.5" />
            </button>
            <Input
              data-testid={`aviator-p${panel}-amount`}
              type="number"
              min="10"
              max="100000"
              value={amount}
              disabled={autoPlaying}
              onChange={(e) => setAmount(e.target.value)}
              onBlur={(e) => setSafeAmount(e.target.value)}
              className="h-8 min-w-0 flex-1 rounded-lg border-white/10 bg-black/30 text-center text-sm font-extrabold tabular-nums"
              aria-label={`Bet ${panel} amount`}
            />
            <button
              type="button"
              onClick={() => setSafeAmount(amountValue + 10)}
              disabled={autoPlaying}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-black/35 text-white/55 disabled:opacity-40"
              aria-label={`Increase Bet ${panel}`}
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="grid grid-cols-4 gap-1">
            {QUICK.map((q) => (
              <button
                key={q}
                type="button"
                data-testid={`aviator-p${panel}-quick-${q}`}
                disabled={autoPlaying}
                onClick={() => setSafeAmount(q)}
                className={`rounded-lg border px-1 py-1 text-[10px] font-bold tabular-nums transition-[background-color,border-color] duration-150 disabled:opacity-40 ${
                  amountValue === q ? "bg-primary/15 border-primary/50 text-primary" : "bg-black/25 border-white/8 text-white/55 hover:bg-white/10"
                }`}
              >
                {formatChips(q)}
              </button>
            ))}
          </div>
          {mode === "auto" && (
            <div className="flex items-center gap-2 border-t border-white/8 pt-2">
              <Switch
                data-testid={`aviator-p${panel}-auto-toggle`}
                checked={autoOn}
                disabled={autoPlaying}
                onCheckedChange={setAutoOn}
                aria-label="Auto cashout"
              />
              <span className="text-[10px] text-white/55">Auto cash out</span>
              <Input
                data-testid={`aviator-p${panel}-auto-value`}
                type="number"
                step="0.1"
                min="1.01"
                max="200"
                value={auto}
                disabled={!autoOn || autoPlaying}
                onChange={(e) => setAuto(e.target.value)}
                onBlur={() => setAuto(autoTarget.toFixed(2))}
                className="ml-auto h-7 w-20 rounded-lg border-white/10 bg-black/30 text-center text-[11px] font-bold tabular-nums"
                aria-label="Auto cashout multiplier"
              />
              <span className="-ml-1 text-[10px] font-bold text-white/50">x</span>
            </div>
          )}
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
          className="w-full h-12 rounded-xl bg-[#20bd09] text-sm font-extrabold text-white hover:bg-[#25cf0c] active:scale-[0.98] transition-[background-color,transform] duration-150"
        >
          CASH OUT {formatChips(Math.round(open.amount * mult))}
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
          onClick={() => onBet(panel, amountValue, mode === "auto" && autoOn ? autoTarget : null)}
          disabled={busy || amountValue < 10}
          className="w-full h-12 rounded-xl bg-[#20bd09] text-sm font-extrabold text-white hover:bg-[#25cf0c] active:scale-[0.98] transition-[background-color,transform] duration-150"
        >
          {phase === "BETTING" ? `BET ${formatChips(amountValue)}` : `BET NEXT ROUND ${formatChips(amountValue)}`}
        </Button>
      )}

      {mode === "auto" && (
        <div className="flex items-center gap-1.5">
          <div className="grid flex-1 grid-cols-4 gap-1">
            {[10, 20, 50, 100].map((n) => (
              <button
                key={n}
                type="button"
                disabled={autoPlaying}
                onClick={() => setAutoRounds(n)}
                className={`rounded-md border py-1 text-[9px] font-bold tabular-nums disabled:opacity-50 ${autoRounds === n ? "border-primary/45 bg-primary/15 text-primary" : "border-white/8 bg-black/25 text-white/45"}`}
              >
                {n}
              </button>
            ))}
          </div>
          <button
            type="button"
            data-testid={`aviator-p${panel}-autoplay`}
            onClick={autoPlaying ? stopAuto : startAuto}
            disabled={busy || (!autoPlaying && amountValue < 10)}
            className={`h-7 min-w-[94px] rounded-lg px-2 text-[9px] font-black tracking-wide text-white transition-colors ${autoPlaying ? "bg-red-600 hover:bg-red-500" : "bg-[#1278d2] hover:bg-[#1688ec]"}`}
          >
            {autoPlaying ? `STOP · ${autoRemaining} LEFT` : "AUTO PLAY"}
          </button>
        </div>
      )}
    </div>
  );
}

function CrashHistoryStrip({ rounds = [] }) {
  return (
    <div className="flex min-h-8 items-center gap-1.5 overflow-x-auto rounded-xl border border-white/8 bg-[#151517] px-2 py-1.5" data-testid="aviator-history-strip">
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-white/8 px-2 py-1 text-[9px] font-bold tracking-widest text-white/60">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#20bd09]" /> LIVE
      </span>
      {rounds.map((round) => {
        const exact = Number(round.crash_point || 1);
        return (
          <span
            key={round.round_number}
            title={`Round #${round.round_number}`}
            className={`shrink-0 rounded-full border bg-black/35 px-2 py-1 text-[10px] font-extrabold tabular-nums ${crashTone(exact)}`}
          >
            {exact.toFixed(2)}x
          </span>
        );
      })}
    </div>
  );
}

function BetFeed({ st, history }) {
  const [tab, setTab] = useState("all");
  const allBets = useMemo(() => st?.all_bets || [], [st?.all_bets]);
  const myBets = st?.my_bets || [];
  const top = useMemo(
    () => [...allBets].sort((a, b) => (b.payout || 0) - (a.payout || 0) || b.amount - a.amount).slice(0, 20),
    [allBets]
  );
  const tabs = [
    { id: "all", label: "All Bets", icon: Users },
    { id: "mine", label: "My Bets", icon: UserRound },
    { id: "top", label: "Top", icon: Trophy },
    { id: "previous", label: "Previous", icon: History },
  ];

  const LiveRows = ({ rows }) =>
    rows.length ? (
      <div className="space-y-1 overflow-y-auto">
        {rows.map((bet, index) => (
          <div key={`${bet.name || "me"}-${index}`} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 rounded-lg px-2 py-1.5 text-[10px] even:bg-white/[0.035]">
            <span className="truncate text-white/60">{bet.name || `Bet ${bet.panel || ""}`}</span>
            <span className="tabular-nums text-white/55">{formatChips(bet.amount || 0)}</span>
            <span className={`min-w-[70px] text-right font-bold tabular-nums ${bet.status === "CASHED" ? "text-[#32df5a]" : bet.status === "LOST" ? "text-red-400" : "text-sky-400"}`}>
              {bet.status === "CASHED"
                ? `${Number(bet.multiplier).toFixed(2)}x · +${formatChips(bet.payout || 0)}`
                : bet.status === "LOST"
                ? "Flew away"
                : bet.queued
                ? "Next round"
                : st?.phase === "FLYING"
                ? "Flying…"
                : "Waiting"}
            </span>
          </div>
        ))}
      </div>
    ) : (
      <p className="py-6 text-center text-[10px] text-white/35">No bets to show yet</p>
    );

  return (
    <div className="flex h-full min-h-[220px] flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#151517]" data-testid="aviator-bet-feed">
      <div className="grid grid-cols-4 border-b border-white/8 p-1">
        {tabs.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`flex items-center justify-center gap-1 rounded-lg px-1 py-2 text-[9px] font-bold ${tab === id ? "bg-white/10 text-white" : "text-white/40 hover:text-white/65"}`}
          >
            <Icon className="h-3 w-3" /> <span className="truncate">{label}</span>
          </button>
        ))}
      </div>
      <div className="flex items-center justify-between border-b border-white/8 px-3 py-2 text-[9px] text-white/40">
        <span>{st?.players || 0} bets</span>
        <span className="tabular-nums">{formatChips(st?.total_staked || 0)} staked</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {tab === "all" && <LiveRows rows={allBets} />}
        {tab === "top" && <LiveRows rows={top} />}
        {tab === "mine" && (
          <>
            <LiveRows rows={myBets} />
            {history.length > 0 && (
              <div className="mt-2 border-t border-white/8 pt-2">
                <p className="mb-1 px-2 text-[9px] font-bold uppercase tracking-wider text-white/35">Settled history</p>
                {history.map((round) => (
                  <div key={round.id} className="grid grid-cols-[1fr_auto_auto] gap-2 rounded-lg px-2 py-1.5 text-[10px] even:bg-white/[0.035]">
                    <span className="flex items-center gap-1 truncate text-white/45"><CalendarDays className="h-3 w-3" /> {formatRoundDate(round.created_at)}</span>
                    <span className="tabular-nums text-white/55">{formatChips(round.bet)}</span>
                    <span className={`text-right font-bold tabular-nums ${round.payout > 0 ? "text-[#32df5a]" : "text-red-400"}`}>
                      {round.payout > 0 ? `+${formatChips(round.payout)}` : `-${formatChips(round.bet)}`}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
        {tab === "previous" && (
          <div className="space-y-1">
            {(st?.history || []).map((round) => {
              const exact = Number(round.crash_point || 1);
              return (
                <div key={round.round_number} className="flex items-center justify-between rounded-lg px-2 py-1.5 text-[10px] even:bg-white/[0.035]">
                  <span className="text-white/45">Round #{round.round_number}</span>
                  <span className={`font-extrabold tabular-nums ${crashTone(exact).split(" ").find((part) => part.startsWith("text-")) || "text-white"}`}>
                    {exact.toFixed(2)}x
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------- Main page ---------------- */
export default function AviatorGame({ game }) {
  const { setUser } = useAuth();
  const [st, setSt] = useState(null);
  const [balance, setBalance] = useState(null);
  const [mult, setMult] = useState(1.0);
  const [countdown, setCountdown] = useState(0);
  const [history, setHistory] = useState([]);
  const [busyCount, setBusyCount] = useState(0);
  const stRef = useRef(null);
  const flyStartRef = useRef(null);
  const deadlineRef = useRef(0);
  const growthRef = useRef(0.12);
  const pollBusyRef = useRef(false);
  const requestSequenceRef = useRef(0);
  const appliedSequenceRef = useRef(0);
  const busy = busyCount > 0;

  const applyBalance = useCallback((nextBalance) => {
    if (typeof nextBalance !== "number") return;
    setBalance(nextBalance);
    // The cabinet and the global header share the same authoritative value.
    // Preserve the rest of the authenticated user rather than forcing a second
    // profile request every time the live round poll observes a wallet change.
    setUser((current) =>
      current && current.chip_balance !== nextBalance
        ? { ...current, chip_balance: nextBalance }
        : current
    );
  }, [setUser]);

  const loadHistory = useCallback(async () => {
    try {
      const { data } = await api.get("/games/aviator/history");
      setHistory(data.rounds || []);
    } catch (e) {
      /* silent */
    }
  }, []);

  const poll = useCallback(async () => {
    if (pollBusyRef.current) return;
    pollBusyRef.current = true;
    const requestSequence = ++requestSequenceRef.current;
    try {
      const { data } = await api.get("/live/aviator/state");
      if (requestSequence < appliedSequenceRef.current) return;
      appliedSequenceRef.current = requestSequence;
      const prev = stRef.current;
      stRef.current = data;
      setSt(data);
      applyBalance(data.balance);
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
    } finally {
      pollBusyRef.current = false;
    }
  }, [applyBalance, loadHistory]);

  useEffect(() => {
    poll();
    loadHistory();
    const p = setInterval(poll, 500);
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

  const placeBet = async (panel, amount, auto, options = {}) => {
    setBusyCount((count) => count + 1);
    try {
      const body = { amount, panel };
      if (auto) body.auto_cashout = parseFloat(auto);
      const { data } = await api.post("/live/aviator/bets", body);
      appliedSequenceRef.current = ++requestSequenceRef.current;
      applyBalance(data.balance);
      if (!options.automatic) toast.success(data.queued ? "Bet queued for the next round" : "Bet placed — good luck!");
      await poll();
      return true;
    } catch (e) {
      toast.error(errMsg(e));
      return false;
    } finally {
      setBusyCount((count) => Math.max(0, count - 1));
    }
  };

  const cancelBet = async (betId) => {
    setBusyCount((count) => count + 1);
    try {
      const { data } = await api.post("/live/aviator/bets/cancel", { bet_id: betId });
      appliedSequenceRef.current = ++requestSequenceRef.current;
      applyBalance(data.balance);
      toast.success(`Bet cancelled — ${formatChips(data.refunded)} refunded`);
      await poll();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusyCount((count) => Math.max(0, count - 1));
    }
  };

  const cashout = async (betId) => {
    setBusyCount((count) => count + 1);
    try {
      const { data } = await api.post("/live/aviator/cashout", { bet_id: betId });
      appliedSequenceRef.current = ++requestSequenceRef.current;
      applyBalance(data.balance);
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
      setBusyCount((count) => Math.max(0, count - 1));
    }
  };

  return (
    <GameStage
      game={game}
      balance={balance}
      alarm={false}
      live={{
        phase: st?.phase,
        countdown,
        timings: { bet: st?.betting_seconds || 6 },
        roundNumber: st?.round_number,
      }}
      labels={{ FLYING: "IN FLIGHT", CRASHED: "CRASHED" }}
      betDock={
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          <BetSlot panel={1} st={st} mult={mult} busy={busy} onBet={placeBet} onCancel={cancelBet} onCashout={cashout} />
          <BetSlot panel={2} st={st} mult={mult} busy={busy} onBet={placeBet} onCancel={cancelBet} onCashout={cashout} />
        </div>
      }
      extras={<BetFeed st={st} history={history} />}
      /* The flight stage is a canvas, not a document: it should occupy the
         room it is given rather than stop at its minimum and leave the rest of
         the screen empty. Fitting scales content DOWN to fit and leaves it at
         its natural size when it is smaller, which for a 248px stage on a tall
         handset means two thirds of the panel is dead space. */
      fit={false}
    >
      <div className="flex h-full min-h-[280px] flex-col gap-2">
        <CrashHistoryStrip rounds={st?.history || []} />
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-2 lg:grid-cols-[minmax(250px,28%)_minmax(0,1fr)]">
          <div className="hidden min-h-0 lg:block">
            <BetFeed st={st} history={history} />
          </div>
          <CurveScene
            phase={st?.phase}
            mult={mult}
            growth={st?.growth}
            countdown={countdown}
            crashPoint={st?.crash_point ?? mult}
            roundNumber={st?.round_number}
          />
        </div>
      </div>
    </GameStage>
  );
}
