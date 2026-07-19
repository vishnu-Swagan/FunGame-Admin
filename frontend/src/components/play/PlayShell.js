import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, Coins, Volume2, VolumeX } from "lucide-react";
import { Disclaimer, formatChips, timeAgo } from "@/components/common";
import { isMuted, toggleMuted, onMuteChange } from "@/lib/sound";

export const PlayShell = ({ game, balance, children }) => {
  const navigate = useNavigate();
  const [muted, setMutedState] = useState(isMuted());
  useEffect(() => onMuteChange(setMutedState), []);
  return (
    <div className="space-y-4" data-testid="game-play-page">
      <div className="flex items-center justify-between gap-3">
        <button
          data-testid="play-back-button"
          onClick={() => navigate(`/games/${game.slug}`)}
          aria-label="Back to game details"
          className="h-10 w-10 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full border border-white/10 bg-white/5 hover:bg-white/10 transition-[background-color] duration-150"
        >
          <ArrowLeft className="h-4 w-4 text-white/85" />
        </button>
        <h1 className="font-display text-2xl text-white flex-1 truncate">{game.name}</h1>
        <button
          data-testid="play-sound-toggle"
          onClick={toggleMuted}
          aria-label={muted ? "Unmute game sounds" : "Mute game sounds"}
          className={`h-10 w-10 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full border transition-[background-color,border-color] duration-150 ${
            muted ? "border-white/10 bg-white/5 hover:bg-white/10" : "border-primary/35 bg-primary/10 hover:bg-primary/15"
          }`}
        >
          {muted ? <VolumeX className="h-4 w-4 text-white/60" /> : <Volume2 className="h-4 w-4 text-primary" />}
        </button>
        <div data-testid="play-balance" className="flex items-center gap-1.5 rounded-full border border-primary/35 bg-primary/10 px-3 py-1.5">
          <Coins className="h-4 w-4 text-primary" />
          <span className="tabular-nums text-sm font-bold text-primary">{balance === null ? "…" : formatChips(balance)}</span>
        </div>
      </div>
      {children}
      <Disclaimer />
    </div>
  );
};

export const HistoryStrip = ({ history }) => {
  if (!history || history.length === 0) return null;
  return (
    <div className="rounded-2xl bg-card/55 border border-white/10 p-3.5" data-testid="play-history">
      <p className="text-xs font-semibold text-white/60 mb-2">Recent rounds</p>
      <div className="space-y-1.5 max-h-[180px] overflow-y-auto">
        {history.map((r) => (
          <div key={r.id} className="flex items-center justify-between text-xs">
            <span className="text-white/45">{timeAgo(r.created_at)}</span>
            <span className="tabular-nums text-white/60">bet {formatChips(r.bet)}</span>
            <span className={`tabular-nums font-bold ${r.payout > 0 ? "text-[hsl(var(--emerald))]" : "text-red-400"}`}>
              {r.payout > 0 ? `+${formatChips(r.payout)}` : `-${formatChips(r.bet)}`}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};
