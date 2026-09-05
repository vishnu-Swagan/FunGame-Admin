import { useRef } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { ArrowRight, CheckCircle2, FileText, HelpCircle, ShieldCheck, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { formatChips } from "@/components/common";
import { formatInrPaise } from "@/lib/walletUtils";
import { normalizeMission } from "@/lib/promotionApi";
import { MissionDeadline, PromotionProgress, rewardLabel } from "./PromotionProgress";

export default function MissionReceipt({ mission: rawMission, deposit, onClose, onStart, onHelp }) {
  const reducedMotion = useReducedMotion();
  const returnFocusRef = useRef(typeof document !== "undefined" ? document.activeElement : null);
  const mission = normalizeMission(rawMission);
  if (!mission) return null;
  const rules = mission.contribution_rules;
  const requestClose = () => {
    const returnTarget = returnFocusRef.current;
    onClose?.();
    Promise.resolve().then(() => {
      if (returnTarget?.isConnected && typeof returnTarget.focus === "function") returnTarget.focus({ preventScroll: true });
    });
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) requestClose(); }}>
      <DialogContent className="!inset-0 !left-0 !top-0 z-[70] !block !min-h-[100dvh] !w-full !max-w-none !translate-x-0 !translate-y-0 !gap-0 !overflow-hidden !border-0 !bg-background !p-0 !shadow-[0_0_0_100vmax_hsl(var(--background))] !duration-0 data-[state=closed]:!animate-none data-[state=open]:!animate-none sm:!rounded-none [&>button:last-child]:hidden" data-testid="mission-receipt">
      <motion.div
        className="fg-visual-viewport overflow-y-auto overscroll-contain bg-background"
        initial={reducedMotion ? false : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={reducedMotion ? { duration: 0 } : { opacity: { duration: 0.18 }, y: { duration: 0.26 } }}
      >
        <div className="mx-auto flex min-h-full min-w-0 w-full max-w-xl flex-col px-4 pb-[max(20px,var(--fg-safe-bottom))] pt-4">
          <header className="flex items-center justify-between gap-3">
            <DialogClose aria-label="Close mission receipt" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-white/12 bg-white/5 text-white/75"><X className="h-5 w-5" /></DialogClose>
            <div className="flex items-center gap-2">
              <button type="button" onClick={onHelp} className="inline-flex min-h-11 items-center gap-2 rounded-xl px-3 text-xs font-bold text-white/65"><HelpCircle className="h-4 w-4" />Help</button>
              <a href="#mission-terms" className="inline-flex min-h-11 items-center gap-2 rounded-xl px-3 text-xs font-bold text-white/65"><FileText className="h-4 w-4" />Terms</a>
            </div>
          </header>

          <main className="flex min-w-0 flex-1 flex-col">
            <div className="mt-5 text-center">
              <img src="/promo/reward-vault.webp" alt="Gold reward vault with an emerald center" className="mx-auto mb-4 h-32 w-24 rounded-2xl object-cover object-center shadow-[0_18px_48px_rgba(255,199,64,.16)]" />
              <motion.span
                aria-hidden="true"
                className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl border border-emerald-400/35 bg-emerald-400/10 text-emerald-300 shadow-[0_16px_44px_rgba(16,185,129,.14)]"
                initial={reducedMotion ? false : { scale: 0.94, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={reducedMotion ? { duration: 0 } : { duration: 0.5 }}
              ><CheckCircle2 className="h-8 w-8" /></motion.span>
              <p className="mt-4 text-[10px] font-bold uppercase tracking-[.22em] text-emerald-300">Payment verified by server</p>
              <DialogTitle asChild><h1 className="mt-2 text-3xl font-extrabold tracking-tight">Deposit received</h1></DialogTitle>
              <DialogDescription asChild><p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-white/55">Your cash is in your wallet. Your optional mission is now active for a separate {rewardLabel(mission.reward)} reward.</p></DialogDescription>
            </div>

            <section className="mt-5 overflow-hidden rounded-2xl border border-primary/30 bg-card/70 p-5 shadow-[0_22px_60px_rgba(0,0,0,.35)]">
              <div aria-hidden="true" className="pointer-events-none absolute" />
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-xl border border-white/10 bg-black/15 p-3"><p className="text-[10px] uppercase tracking-wider text-white/40">Deposit</p><p className="mt-1 tabular-nums text-xl font-extrabold text-white">{mission.deposit.amount_paise ? formatInrPaise(mission.deposit.amount_paise) : formatChips(mission.deposit.chips || deposit?.amount_chips || 0)}</p><p className="mt-1 text-[10px] text-emerald-200/70">{mission.deposit.amount_paise ? "Cash wallet" : "Player balance"}</p></div>
                <div className="rounded-xl border border-primary/20 bg-primary/[.06] p-3"><p className="text-[10px] uppercase tracking-wider text-white/40">Pending reward</p><p className="mt-1 tabular-nums text-xl font-extrabold text-primary">{rewardLabel(mission.reward)}</p><p className="mt-1 text-[10px] text-white/40">Separate until earned</p></div>
              </div>
              <div className="mt-5"><PromotionProgress mission={mission} /></div>
              <MissionDeadline mission={mission} className="mt-4 rounded-xl border border-white/8 bg-black/10 p-3" />
            </section>

            <section id="mission-terms" className="mt-4 scroll-mt-4 rounded-2xl border border-white/10 bg-card/45 p-4 text-sm">
              <div className="flex items-center gap-2"><ShieldCheck className="h-5 w-5 text-primary" /><h2 className="font-bold">Mission details</h2></div>
              <dl className="mt-3 grid gap-3 text-xs leading-relaxed">
                <div><dt className="font-bold text-white/75">Qualifying games</dt><dd className="mt-0.5 text-white/50">{rules.allowed_games.length ? rules.allowed_games.join(", ") : "See the accepted campaign game list."}</dd></div>
                {rules.excluded_games.length > 0 && <div><dt className="font-bold text-white/75">Excluded games</dt><dd className="mt-0.5 text-white/50">{rules.excluded_games.join(", ")}</dd></div>}
                <div><dt className="font-bold text-white/75">Qualifying wallet sources</dt><dd className="mt-0.5 text-white/50">{rules.eligible_source_buckets?.length ? rules.eligible_source_buckets.join(", ") : "Set by the accepted campaign rules."}</dd></div>
                <div><dt className="font-bold text-white/75">Contribution</dt><dd className="mt-0.5 text-white/50">Default {rules.default_bps / 100}% of eligible settled stake. Voids, cancellations and refunds contribute zero.</dd></div>
                {Object.keys(rules.game_bps || {}).length > 0 && <div><dt className="font-bold text-white/75">Game contribution rates</dt><dd className="mt-0.5 text-white/50">{Object.entries(rules.game_bps).map(([game, bps]) => `${game}: ${Number(bps) / 100}%`).join(" · ")}</dd></div>}
                <div><dt className="font-bold text-white/75">Maximum qualifying stake</dt><dd className="mt-0.5 text-white/50">{rules.max_qualifying_stake_chips ? `${formatChips(rules.max_qualifying_stake_chips)} per wager` : "Set by the accepted campaign rules."}</dd></div>
                <div><dt className="font-bold text-white/75">Settlement-finality review</dt><dd className="mt-0.5 text-white/50">After the target reaches 100%, the server verifies settled wagers for {mission.claim_finality.window_hours || "the disclosed"} hours under policy {mission.claim_finality.policy_version || mission.settlement_finality_policy_version || "not supplied"} before it can mark the reward claimable.</dd></div>
                <div><dt className="font-bold text-white/75">Accepted terms</dt><dd className="mt-0.5 text-white/50">Version {mission.terms_version || "not supplied"} · campaign {mission.campaign_version} · {mission.jurisdiction || "jurisdiction not supplied"}</dd></div>
              </dl>
              <p className="mt-4 rounded-xl border border-emerald-400/20 bg-emerald-400/[.07] p-3 text-xs leading-relaxed text-emerald-100/80">Your deposited cash is not locked by this mission. Only the separate unearned reward is subject to the accepted campaign conditions.</p>
            </section>
          </main>

          <footer className="sticky bottom-0 -mx-4 mt-5 border-t border-white/8 bg-background/95 px-4 pb-[max(12px,var(--fg-safe-bottom))] pt-3 backdrop-blur-xl">
            <Button type="button" onClick={onStart} className="h-12 w-full rounded-xl text-base font-extrabold">Start qualifying games <ArrowRight className="ml-2 h-4 w-4" /></Button>
            <button type="button" onClick={() => document.getElementById("mission-terms")?.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth" })} className="mt-2 min-h-11 w-full rounded-xl text-xs font-bold text-white/55">View full rules</button>
          </footer>
        </div>
      </motion.div>
      </DialogContent>
    </Dialog>
  );
}
