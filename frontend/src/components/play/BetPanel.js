import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { formatChips } from "@/components/common";

const QUICK = [10, 50, 100, 500, 1000];

export const BetPanel = ({ bet, setBet, onPlay, busy, playLabel = "Play", disabled = false, hint }) => (
  <div className="rounded-2xl bg-card/55 border border-white/10 p-4 space-y-3" data-testid="bet-panel">
    <div className="flex items-center justify-between">
      <p className="text-xs font-semibold text-white/60">Bet amount</p>
      {hint && <p className="text-[11px] text-white/40">{hint}</p>}
    </div>
    <div className="flex gap-1.5 flex-wrap">
      {QUICK.map((q) => (
        <button
          key={q}
          type="button"
          data-testid={`bet-quick-${q}`}
          onClick={() => setBet(q)}
          className={`rounded-lg border px-3 py-2 min-h-[38px] text-xs font-bold tabular-nums transition-[background-color,border-color] duration-150 ${
            bet === q ? "bg-primary/15 border-primary/50 text-primary" : "bg-white/5 border-white/10 text-white/70 hover:bg-white/10"
          }`}
        >
          {formatChips(q)}
        </button>
      ))}
      <Input
        data-testid="bet-custom-input"
        type="number"
        min="10"
        max="100000"
        value={bet}
        onChange={(e) => setBet(parseInt(e.target.value, 10) || 0)}
        className="h-[38px] w-24 rounded-lg bg-white/5 border-white/12 tabular-nums text-xs"
        aria-label="Custom bet amount"
      />
    </div>
    <Button
      data-testid="play-submit-button"
      onClick={onPlay}
      disabled={busy || disabled || !bet || bet < 10}
      className="w-full h-12 rounded-xl text-base font-bold hover:brightness-110 active:scale-[0.98] transition-[filter,transform] duration-150"
    >
      {busy ? "Playing…" : playLabel}
    </Button>
  </div>
);
