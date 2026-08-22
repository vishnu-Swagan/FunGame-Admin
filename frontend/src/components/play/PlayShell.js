import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, Coins, Volume2, VolumeX } from "lucide-react";
import { Disclaimer, formatChips, timeAgo } from "@/components/common";
import { isMuted, toggleMuted, onMuteChange } from "@/lib/sound";
import { LiveActivityBar } from "@/components/play/LiveActivityBar";
import { BrandWordmark } from "@/components/Brand";

/**
 * `compact` is for a table that already carries its own chrome. Roulette prints
 * the balance and a live ticker along its own money bar, so the full header
 * above it is a second copy of both — and on a phone that duplicate costs the
 * number board about seventy pixels it could be using to make every bet easier
 * to hit.
 */
export const PlayShell = ({ game, balance, compact = false, children }) => {
  const navigate = useNavigate();
  const [muted, setMutedState] = useState(isMuted());
  useEffect(() => {
    // Background casino music disabled by user request - only game SFX play.
    const off = onMuteChange((m) => setMutedState(m));
    return () => off();
  }, []);
  return (
    <div className={compact ? "space-y-1.5" : "space-y-4"} data-testid="game-play-page">
      <div className={`relative rounded-2xl fg-glass overflow-hidden ${compact ? "px-2 py-1.5" : "px-3 pt-3 pb-2.5"}`}>
      <div className="flex items-center justify-between gap-3">
        <button
          data-testid="play-back-button"
          onClick={() => navigate(`/games/${game.slug}`)}
          aria-label="Back to game details"
          className={`flex items-center justify-center rounded-full border border-white/10 bg-white/5 hover:bg-white/10 transition-[background-color] duration-150 ${
            compact ? "h-9 w-9" : "h-10 w-10 min-h-[44px] min-w-[44px]"
          }`}
        >
          <ArrowLeft className="h-4 w-4 text-white/85" />
        </button>
        <BrandWordmark logoClassName={`h-auto ${compact ? "w-24" : "w-[clamp(96px,26vw,128px)]"}`} />
        <h1 className={`font-display text-white flex-1 truncate ${compact ? "text-base" : "text-2xl"}`}>{game.name}</h1>
        <button
          data-testid="play-sound-toggle"
          onClick={toggleMuted}
          aria-label={muted ? "Unmute game sounds" : "Mute game sounds"}
          className={`flex items-center justify-center rounded-full border transition-[background-color,border-color] duration-150 ${
            compact ? "h-9 w-9" : "h-10 w-10 min-h-[44px] min-w-[44px]"
          } ${muted ? "border-white/10 bg-white/5 hover:bg-white/10" : "border-primary/35 bg-primary/10 hover:bg-primary/15"}`}
        >
          {muted ? <VolumeX className="h-4 w-4 text-white/60" /> : <Volume2 className="h-4 w-4 text-primary" />}
        </button>
        {/* a table that prints its own balance does not need this one as well */}
        {!compact && (
          <div data-testid="play-balance" className="flex items-center gap-1.5 rounded-full border border-primary/35 bg-primary/10 px-3 py-1.5">
            <Coins className="h-4 w-4 text-primary" />
            <span className="tabular-nums text-sm font-bold text-primary">{balance === null ? "…" : formatChips(balance)}</span>
          </div>
        )}
      </div>
        {!compact && (
          <>
            <div className="mt-2.5">
              <LiveActivityBar slug={game.slug} />
            </div>
            <div className="fg-accent-line mt-2.5" aria-hidden="true" />
          </>
        )}
      </div>
      {children}
      {!compact && <Disclaimer />}
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
