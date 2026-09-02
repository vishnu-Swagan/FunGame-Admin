import { ArrowRight, CirclePause, Gift, ShieldCheck } from "lucide-react";
import { normalizeMission } from "@/lib/promotionApi";
import { ClaimFinalityNotice, MissionDeadline, PromotionProgress, rewardLabel } from "./PromotionProgress";

export default function MissionCard({ mission: rawMission, onOpen, className = "" }) {
  const mission = normalizeMission(rawMission);
  if (!mission) return null;
  const paused = mission.status === "PAUSED_FOR_REVIEW";
  const done = mission.status === "CLAIMED";
  return (
    <section className={`relative overflow-hidden rounded-2xl border border-primary/25 bg-card/70 p-4 shadow-[0_16px_44px_rgba(0,0,0,.3)] ${className}`} data-testid="active-mission-card">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_85%_0%,rgba(255,201,64,.14),transparent_40%)]" />
      <div className="relative">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border ${mission.claimable ? "border-emerald-400/35 bg-emerald-400/10 text-emerald-300" : "border-primary/30 bg-primary/10 text-primary"}`}>
              {paused ? <CirclePause className="h-5 w-5" /> : done ? <ShieldCheck className="h-5 w-5" /> : <Gift className="h-5 w-5" />}
            </span>
            <div className="min-w-0">
              <p className="text-[10px] font-bold uppercase tracking-[.18em] text-primary">Bonus mission</p>
              <h2 className="mt-0.5 truncate text-base font-extrabold">Unlock {rewardLabel(mission.reward)}</h2>
              <p className="mt-1 text-xs text-white/50">Your deposited cash stays separate and withdrawable.</p>
            </div>
          </div>
          {paused && <span className="rounded-full border border-amber-300/30 bg-amber-300/10 px-2 py-1 text-[9px] font-bold uppercase tracking-wide text-amber-200">Review</span>}
        </div>
        <div className="mt-4"><PromotionProgress mission={mission} compact /></div>
        <ClaimFinalityNotice mission={mission} compact />
        <div className="mt-3 flex items-end justify-between gap-3">
          <MissionDeadline mission={mission} />
          <button type="button" onClick={onOpen} className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-xl border border-primary/30 bg-primary/10 px-3 text-xs font-bold text-primary hover:bg-primary/15">
            View details <ArrowRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </section>
  );
}
