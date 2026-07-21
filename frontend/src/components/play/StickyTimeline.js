import { Timer } from "lucide-react";

const PHASE = { BETTING: "PLACE BETS", REVEAL: "NO MORE BETS", RESULT: "RESULT" };

export const StickyTimeline = ({ phase, countdown, timings, labels = {} }) => {
  const betting = phase === "BETTING";
  const secs = Math.ceil(countdown || 0);
  const alarm = betting && secs <= 5 && secs >= 1;
  const total = timings?.bet || 13;
  const pct = betting ? Math.min(100, Math.max(0, (countdown / total) * 100)) : 100;
  const tone = alarm ? "#ef4444" : betting ? "hsl(var(--emerald))" : phase === "REVEAL" ? "hsl(var(--magenta))" : "hsl(var(--primary))";
  return (
    <div className={`flex items-center gap-2 ${alarm ? "fg-timeline-alarm" : ""}`} data-testid="sticky-timeline">
      <Timer className="h-3.5 w-3.5 shrink-0" style={{ color: tone }} />
      <span className="text-[10px] font-extrabold tracking-wider shrink-0" style={{ color: tone }}>
        {labels[phase] ?? PHASE[phase] ?? "SYNCING…"}
      </span>
      <div className="flex-1 h-1.5 rounded-full bg-white/8 overflow-hidden">
        <div className="h-full rounded-full transition-[width] duration-200" style={{ width: `${pct}%`, background: tone }} />
      </div>
      <span data-testid="sticky-timer" className="tabular-nums font-display text-lg leading-none shrink-0" style={{ color: tone }}>{secs}</span>
    </div>
  );
};
