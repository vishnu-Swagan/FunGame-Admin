import { motion, useReducedMotion } from "framer-motion";
import { Clock3 } from "lucide-react";
import { formatChips } from "@/components/common";
import { formatInrPaise } from "@/lib/walletUtils";

export function formatPromotionDate(value, timezone = "UTC") {
  if (!value) return "Not supplied";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not supplied";
  try {
    return new Intl.DateTimeFormat("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: timezone || "UTC",
      timeZoneName: "short",
    }).format(date);
  } catch (_error) {
    return new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" }).format(date);
  }
}

export function timeRemaining(deadline, serverTime) {
  if (!deadline) return "No deadline supplied";
  if (!serverTime) return "Server time unavailable";
  const end = new Date(deadline).getTime();
  const now = new Date(serverTime).getTime();
  if (!Number.isFinite(end) || !Number.isFinite(now)) return "Deadline unavailable";
  const remaining = Math.max(0, end - now);
  if (remaining === 0) return "Deadline reached";
  const hours = Math.floor(remaining / 3_600_000);
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  const minutes = Math.max(1, Math.floor((remaining % 3_600_000) / 60_000));
  return days ? `${days}d ${restHours}h remaining` : hours ? `${hours}h ${minutes}m remaining` : `${minutes}m remaining`;
}

export function rewardLabel(reward = {}) {
  if (String(reward.type || "").toUpperCase() === "CASH_CREDIT" && Number(reward.paise) > 0) {
    return formatInrPaise(reward.paise);
  }
  return `${formatChips(reward.chips || 0)} restricted bonus`;
}

export function formatServerDuration(seconds) {
  const value = Math.max(0, Number.isSafeInteger(Number(seconds)) ? Number(seconds) : 0);
  if (value === 0) return "Finality review is due";
  const totalMinutes = Math.max(1, Math.ceil(value / 60));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days) return `${days}d ${hours}h remaining`;
  if (hours) return `${hours}h ${minutes}m remaining`;
  return `${minutes}m remaining`;
}

export function isClaimFinalityPending(mission) {
  return mission?.status === "PENDING_SETTLEMENT"
    && mission?.claim_finality?.status === "PENDING";
}

export function ClaimFinalityNotice({ mission, compact = false, className = "" }) {
  if (!isClaimFinalityPending(mission)) return null;
  const finality = mission.claim_finality;
  return (
    <div className={`${compact ? "mt-2 text-[11px]" : "mt-3 rounded-xl border border-sky-300/20 bg-sky-300/[.07] p-3 text-xs"} leading-relaxed text-sky-100/80 ${className}`} data-testid="claim-finality-notice">
      <strong className="block text-sky-100">Verifying settled wagers</strong>
      <span className="mt-0.5 block">The target is complete. Claiming stays unavailable until the server finishes its settlement-finality review.</span>
      {finality.finality_at && <span className="mt-1 block tabular-nums">Review window ends {formatPromotionDate(finality.finality_at, mission.timezone)}</span>}
      {finality.policy_version && <span className="mt-1 block">Settlement-finality policy {finality.policy_version}</span>}
      <span className="mt-1 block tabular-nums">{formatServerDuration(finality.remaining_seconds)} based on server time.</span>
    </div>
  );
}

export function PromotionProgress({ mission, compact = false, label = "Wager progress" }) {
  const reducedMotion = useReducedMotion();
  const progress = mission?.progress || {};
  const percent = Math.min(100, Math.max(0, Number(progress.percent) || 0));
  const complete = percent === 100 && mission?.claimable;
  const paused = mission?.status === "PAUSED_FOR_REVIEW";
  const barColor = paused ? "bg-amber-300" : "bg-primary";
  const liveCopy = mission?.status === "CLAIMED"
    ? "Reward claimed."
    : complete
      ? "Requirement complete. Reward ready to claim."
      : isClaimFinalityPending(mission)
        ? "Target achieved. Settled wagers are being verified."
        : "";

  return (
    <div className={compact ? "space-y-2" : "space-y-3"}>
      <div className="flex items-end justify-between gap-3">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-[.16em] text-white/45">{label}</p>
          {!compact && (
            <p className="mt-1 text-sm text-white/65">
              <strong className="tabular-nums text-white">{formatChips(progress.settled_chips || 0)}</strong>
              <span> of </span>
              <strong className="tabular-nums text-white">{formatChips(progress.target_chips || 0)}</strong>
              <span> qualifying stake settled</span>
            </p>
          )}
        </div>
        <strong className={`tabular-nums ${compact ? "text-xl" : "text-3xl"} ${complete ? "text-[hsl(var(--emerald))]" : "text-primary"}`}>{percent}%</strong>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={`${percent} percent complete`}
        className={`relative ${compact ? "h-2" : "h-3"} overflow-hidden rounded-full border border-white/10 bg-black/35`}
      >
        <motion.div
          className={`h-full w-full origin-left rounded-full ${barColor}`}
          initial={false}
          animate={{ scaleX: percent / 100 }}
          transition={reducedMotion ? { duration: 0 } : { duration: 0.38, ease: [0.2, 0.8, 0.2, 1] }}
        />
        {complete && <motion.div aria-hidden="true" className="absolute inset-0 h-full w-full origin-left rounded-full bg-[hsl(var(--emerald))]" initial={reducedMotion ? false : { scaleX: 0 }} animate={{ scaleX: 1 }} transition={reducedMotion ? { duration: 0 } : { duration: 1.1, ease: [0.2, 0.8, 0.2, 1] }} />}
      </div>
      {!compact && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-white/50">
          <span className="tabular-nums">{formatChips(progress.remaining_chips || 0)} remaining</span>
          <span className="tabular-nums">{formatChips(progress.pending_chips || 0)} pending settlement</span>
        </div>
      )}
      {liveCopy && <p aria-live="polite" className="sr-only">{liveCopy}</p>}
    </div>
  );
}

export function MissionDeadline({ mission, className = "" }) {
  return (
    <div className={`flex items-start gap-2 text-xs leading-relaxed text-white/55 ${className}`}>
      <Clock3 className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
      <span>
        <strong className="text-white/75">{timeRemaining(mission?.deadline_at, mission?.server_time)}</strong>
        <span className="block">Ends {formatPromotionDate(mission?.deadline_at, mission?.timezone)}</span>
      </span>
    </div>
  );
}
