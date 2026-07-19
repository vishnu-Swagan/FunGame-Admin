import { Timer } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { formatChips } from "@/components/common";

const PHASE_LABELS = { BETTING: "PLACE YOUR BETS", REVEAL: "NO MORE BETS", RESULT: "RESULT" };

/** Universal phase bar: identical countdown for every player worldwide. */
export const LiveBar = ({ state, countdown, labels = {} }) => {
  const phase = state?.phase;
  const betting = phase === "BETTING";
  const tone = betting ? "emerald" : phase === "REVEAL" ? "magenta" : "gold";
  const cls =
    tone === "emerald"
      ? { box: "border-[hsl(var(--emerald)/0.4)] bg-[hsl(var(--emerald)/0.08)]", text: "text-[hsl(var(--emerald))]" }
      : tone === "magenta"
      ? { box: "border-[hsl(var(--magenta)/0.4)] bg-[hsl(var(--magenta)/0.08)]", text: "text-[hsl(var(--magenta))]" }
      : { box: "border-primary/40 bg-primary/8", text: "text-primary" };
  return (
    <div className="space-y-1.5">
      <div data-testid="live-phase-bar" className={`rounded-2xl border p-3 flex items-center justify-between gap-3 ${cls.box}`}>
        <div className="flex items-center gap-2">
          <Timer className={`h-4 w-4 ${cls.text}`} />
          <span data-testid="live-phase" className={`text-xs font-extrabold tracking-wider ${cls.text}`}>
            {(labels[phase] ?? PHASE_LABELS[phase]) || "SYNCING…"}
          </span>
          <span className="inline-flex items-center gap-1 rounded-full bg-white/8 px-2 py-0.5 text-[9px] font-bold tracking-widest text-white/60">
            <span className="h-1.5 w-1.5 rounded-full bg-[hsl(var(--emerald))] animate-pulse" /> LIVE 24/7
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-white/45 tabular-nums">round #{state ? state.round_number % 100000 : "…"}</span>
          <span data-testid="live-timer" className={`tabular-nums font-display text-2xl ${cls.text}`}>
            {Math.ceil(countdown)}
          </span>
        </div>
      </div>
      {betting && (
        <div className="h-1.5 rounded-full bg-white/5 overflow-hidden">
          <div
            className="h-full bg-[hsl(var(--emerald))] rounded-full transition-[width] duration-200"
            style={{ width: `${Math.min(100, (countdown / (state?.timings?.bet || 13)) * 100)}%` }}
          />
        </div>
      )}
    </div>
  );
};

const QUICK = [10, 50, 100, 500, 1000];

/** Bet controls for live rounds - locked outside the betting window. */
export const LiveBetPanel = ({ amount, setAmount, onPlace, betting, placing, disabled = false, label = "Place bet", myTotal = 0, hint }) => (
  <div className="rounded-2xl bg-card/55 border border-white/10 p-4 space-y-3" data-testid="live-bet-panel">
    <div className="flex items-center justify-between">
      <p className="text-xs font-semibold text-white/60">Bet amount</p>
      <p className="text-xs text-white/60">
        This round: <span data-testid="live-my-total" className="tabular-nums font-bold text-primary">{formatChips(myTotal)}</span>
      </p>
    </div>
    <div className="flex gap-1.5 flex-wrap">
      {QUICK.map((q) => (
        <button
          key={q}
          type="button"
          data-testid={`live-bet-quick-${q}`}
          onClick={() => setAmount(q)}
          className={`rounded-lg border px-3 py-2 min-h-[38px] text-xs font-bold tabular-nums transition-[background-color,border-color] duration-150 ${
            amount === q ? "bg-primary/15 border-primary/50 text-primary" : "bg-white/5 border-white/10 text-white/70 hover:bg-white/10"
          }`}
        >
          {formatChips(q)}
        </button>
      ))}
      <Input
        data-testid="live-bet-custom-input"
        type="number"
        min="10"
        max="100000"
        value={amount}
        onChange={(e) => setAmount(parseInt(e.target.value, 10) || 0)}
        className="h-[38px] w-24 rounded-lg bg-white/5 border-white/12 tabular-nums text-xs"
        aria-label="Custom bet amount"
      />
    </div>
    {hint && <p className="text-[11px] text-white/40">{hint}</p>}
    <Button
      data-testid="live-place-bet-button"
      onClick={onPlace}
      disabled={!betting || placing || disabled || !amount || amount < 10}
      className="w-full h-12 rounded-xl text-base font-bold hover:brightness-110 active:scale-[0.98] transition-[filter,transform] duration-150"
    >
      {placing ? "Placing…" : betting ? label : "Bets locked — next round soon"}
    </Button>
  </div>
);

const TONES = {
  gold: "bg-primary/15 border-primary/40 text-primary",
  cyan: "bg-[hsl(var(--cyan)/0.15)] border-[hsl(var(--cyan)/0.4)] text-[hsl(var(--cyan))]",
  magenta: "bg-[hsl(var(--magenta)/0.15)] border-[hsl(var(--magenta)/0.4)] text-[hsl(var(--magenta))]",
  emerald: "bg-[hsl(var(--emerald)/0.15)] border-[hsl(var(--emerald)/0.4)] text-[hsl(var(--emerald))]",
  red: "bg-destructive/15 border-destructive/40 text-red-400",
  neutral: "bg-white/8 border-white/15 text-white/70",
};

export const ResultPill = ({ label, tone = "neutral" }) => (
  <span className={`inline-flex items-center justify-center min-w-7 h-7 px-1.5 rounded-full border text-[10px] font-extrabold tabular-nums ${TONES[tone] || TONES.neutral}`}>
    {label}
  </span>
);

/** Strip of universal past outcomes - identical for every player. */
export const LastResults = ({ items, render }) => {
  if (!items || items.length === 0) return null;
  return (
    <div className="flex items-center gap-1.5 flex-wrap" data-testid="live-last-results">
      <span className="text-[10px] text-white/40 mr-0.5">LAST</span>
      {items.map((r) => (
        <span key={r.round_number}>{render(r)}</span>
      ))}
    </div>
  );
};
