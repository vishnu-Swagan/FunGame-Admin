import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, Coins, Volume2, VolumeX } from "lucide-react";
import { isMuted, toggleMuted, onMuteChange } from "@/lib/sound";
import { formatChips } from "@/components/common";
import { StickyTimeline } from "@/components/play/StickyTimeline";
import { BetDock } from "@/components/play/BetDock";
import { ExtrasSheet } from "@/components/play/ExtrasSheet";
import { useBettingAlarm } from "@/lib/useBettingAlarm";

export const GameStage = ({ game, balance, live, betDock, extras, labels, children }) => {
  const navigate = useNavigate();
  const [muted, setMuted] = useState(isMuted());
  useEffect(() => onMuteChange(setMuted), []);
  useBettingAlarm({ phase: live?.phase, countdown: live?.countdown ?? 0, roundNumber: live?.roundNumber });

  return (
    <div
      className="flex flex-col"
      style={{ height: "calc(100dvh - var(--fg-header-h, 56px))" }}
      data-testid="game-stage"
    >
      {/* sticky game bar (below the FunGame logo) */}
      <div className="shrink-0 px-3 pt-2 pb-2 border-b border-white/10 bg-[hsl(var(--background)/0.9)] backdrop-blur-xl space-y-1.5">
        <div className="flex items-center gap-2">
          <button data-testid="play-back-button" onClick={() => navigate(`/games/${game.slug}`)} aria-label="Back"
            className="h-8 w-8 flex items-center justify-center rounded-full border border-white/10 bg-white/5 active:scale-95">
            <ArrowLeft className="h-4 w-4 text-white/85" />
          </button>
          <h1 className="flex-1 truncate font-display text-lg text-white">{game.name}</h1>
          <button data-testid="play-sound-toggle" onClick={toggleMuted} aria-label={muted ? "Unmute" : "Mute"}
            className={`h-8 w-8 flex items-center justify-center rounded-full border ${muted ? "border-white/10 bg-white/5" : "border-primary/35 bg-primary/10"}`}>
            {muted ? <VolumeX className="h-4 w-4 text-white/60" /> : <Volume2 className="h-4 w-4 text-primary" />}
          </button>
          <div data-testid="play-balance" className="flex items-center gap-1 rounded-full border border-primary/35 bg-primary/10 px-2 py-1">
            <Coins className="h-3.5 w-3.5 text-primary" />
            <span className="tabular-nums text-xs font-bold text-primary">{balance === null ? "…" : formatChips(balance)}</span>
          </div>
        </div>
        <StickyTimeline phase={live?.phase} countdown={live?.countdown} timings={live?.timings} labels={labels} />
      </div>

      {/* middle — scrolls only if the game overflows */}
      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3" data-testid="game-stage-middle">
        {children}
      </div>

      {/* extras sheet (pull-up) then the bet dock */}
      {extras ? <ExtrasSheet>{extras}</ExtrasSheet> : null}
      <BetDock>{betDock}</BetDock>
    </div>
  );
};
