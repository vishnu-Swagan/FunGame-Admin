import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { motion, useReducedMotion } from "framer-motion";
import { AlertTriangle, ArrowLeft, Ban, CheckCircle2, CirclePause, FileSearch, Gamepad2, Gift, Headphones, RefreshCw, RotateCcw, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { PageTransition, formatChips } from "@/components/common";
import { useAuth } from "@/context/AuthContext";
import { errMsg } from "@/lib/api";
import { clearFinancialIntent, financialIntentKey } from "@/lib/financialIntent";
import { normalizeMission, promotions } from "@/lib/promotionApi";
import { formatInrPaise } from "@/lib/walletUtils";
import { ClaimFinalityNotice, MissionDeadline, PromotionProgress, formatPromotionDate, isClaimFinalityPending, rewardLabel } from "@/components/promotions";

const EVENT_STATUS = {
  PENDING: "border-sky-300/25 bg-sky-300/10 text-sky-200",
  SETTLED: "border-emerald-300/25 bg-emerald-300/10 text-emerald-200",
  VOID: "border-white/15 bg-white/5 text-white/55",
  REVERSED: "border-amber-300/25 bg-amber-300/10 text-amber-200",
};

export function MissionStateNotice({ mission }) {
  const config = {
    CLAIMABLE: [CheckCircle2, "Requirement complete", "Your server-confirmed reward is ready to claim.", "border-emerald-400/25 bg-emerald-400/10 text-emerald-100"],
    CLAIMED: [ShieldCheck, "Reward claimed", "This mission is complete. Your claim receipt remains in wallet activity.", "border-emerald-400/25 bg-emerald-400/10 text-emerald-100"],
    EXPIRED: [AlertTriangle, "Mission expired", "The deadline has passed. Your deposited cash remains separate and is not locked by this mission.", "border-amber-300/25 bg-amber-300/10 text-amber-100"],
    FORFEITED: [Ban, "Mission ended", "The unearned reward was forfeited. Deposited cash was not forfeited.", "border-white/15 bg-white/5 text-white/65"],
    PAUSED_FOR_REVIEW: [CirclePause, "Progress paused for review", "No reward decision is being made in the browser. Contact support for the review status and appeal route.", "border-amber-300/25 bg-amber-300/10 text-amber-100"],
  }[mission.status];
  if (!config) return null;
  const [Icon, title, description, tone] = config;
  return <div className={`mt-3 flex items-start gap-3 rounded-xl border p-3 text-sm ${tone}`}><Icon className="mt-0.5 h-5 w-5 shrink-0" /><div><strong>{title}</strong><p className="mt-1 text-xs leading-relaxed opacity-75">{description}</p></div></div>;
}

function EventRow({ event }) {
  const rawStatus = String(event.status || event.event_type || "PENDING").toUpperCase();
  const status = rawStatus === "STAKE" ? "PENDING" : ["VOID", "REFUND"].includes(rawStatus) ? "REVERSED" : rawStatus;
  const occurred = event.settled_at || event.occurred_at || event.created_at;
  const bps = Number(event.contribution_bps || event.contribution_rate_bps || 0);
  return (
    <article className="grid grid-cols-[1fr_auto] gap-3 p-3.5" data-testid="wager-event-row">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2"><p className="truncate text-sm font-bold">{event.game_name || event.game || event.game_id || "Qualifying game"}</p><span className={`rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase ${EVENT_STATUS[status] || EVENT_STATUS.PENDING}`}>{status.replaceAll("_", " ")}</span></div>
        <p className="mt-1 truncate font-mono text-[10px] text-white/35">Bet {event.bet_reference || event.source_id || event.id || "—"}</p>
        <p className="mt-1 text-[10px] text-white/40">{occurred ? formatPromotionDate(occurred, event.timezone || "UTC") : "Server time unavailable"}</p>
      </div>
      <div className="text-right text-xs">
        <p className="tabular-nums font-bold text-white">{formatChips(event.stake_chips || 0)} stake</p>
        <p className="mt-1 tabular-nums text-primary">+{formatChips(event.contribution_chips || 0)}</p>
        <p className="mt-1 text-[10px] text-white/40">{bps ? `${bps / 100}%` : "Server rule"}</p>
      </div>
    </article>
  );
}

export default function BonusMission() {
  const { missionId } = useParams();
  const navigate = useNavigate();
  const reducedMotion = useReducedMotion();
  const { user, refreshUser } = useAuth();
  const [mission, setMission] = useState(null);
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [confirmForfeit, setConfirmForfeit] = useState(false);
  const [claimReceipt, setClaimReceipt] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      if (missionId) {
        const result = await promotions.mission(missionId);
        setMission(result.mission);
        setEvents(result.events);
      } else {
        const active = await promotions.activeMission();
        if (active?.id) {
          const result = await promotions.mission(active.id);
          setMission(result.mission);
          setEvents(result.events);
        } else {
          setMission(null);
          setEvents([]);
        }
      }
      setError("");
    } catch (requestError) {
      setError(errMsg(requestError, "We could not load this mission. Your wallet and eligibility remain server-controlled."));
    } finally {
      setLoading(false);
    }
  }, [missionId]);

  useEffect(() => { load(); }, [load]);

  const normalized = useMemo(() => normalizeMission(mission), [mission]);
  const claim = async () => {
    if (!normalized?.claimable || busy) return;
    const key = financialIntentKey("bonus-claim", user?.id, `mission=${normalized.id}`);
    setBusy("claim");
    try {
      const result = await promotions.claimMission(normalized.id, key);
      const confirmedMission = normalizeMission(result.mission);
      const confirmedClaim = result.claim;
      if (confirmedMission?.status !== "CLAIMED" || confirmedClaim?.status !== "CLAIMED") {
        throw new Error("The server has not finalized this reward claim yet.");
      }
      clearFinancialIntent("bonus-claim", user?.id, key);
      setMission(confirmedMission);
      setClaimReceipt(confirmedClaim);
      setAnnouncement(`Reward claimed. ${rewardLabel(normalized.reward)} was confirmed by the server.`);
      await refreshUser?.();
    } catch (requestError) {
      setError(errMsg(requestError, "The claim was not confirmed. Retry safely with the same claim request."));
    } finally {
      setBusy("");
    }
  };

  const forfeit = async () => {
    if (!normalized?.forfeit_allowed || busy) return;
    const key = financialIntentKey("bonus-forfeit", user?.id, `mission=${normalized.id}`);
    setBusy("forfeit");
    try {
      const result = await promotions.forfeitMission(normalized.id, "PLAYER_REQUESTED_WITHDRAWAL_OPTION", key);
      clearFinancialIntent("bonus-forfeit", user?.id, key);
      setMission(result.mission || { ...normalized, status: "FORFEITED", claimable: false });
      setAnnouncement("The server confirmed that the unearned bonus mission ended. Your deposited cash was not forfeited.");
      setConfirmForfeit(false);
      await refreshUser?.();
    } catch (requestError) {
      setError(errMsg(requestError, "The mission was not changed. Get help before retrying."));
    } finally {
      setBusy("");
    }
  };

  if (loading) return <PageTransition className="min-h-[100dvh] space-y-4" data-testid="bonus-mission-loading"><div className="h-12 rounded-xl fg-shimmer" /><div className="h-64 rounded-2xl fg-shimmer" /><div className="h-48 rounded-2xl fg-shimmer" /></PageTransition>;

  if (error && !normalized) return <PageTransition className="min-h-[100dvh] py-10 text-center" data-testid="bonus-mission-error"><FileSearch className="mx-auto h-10 w-10 text-primary" /><h1 className="mt-4 text-xl font-bold">Mission unavailable</h1><p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-white/55">{error}</p><Button type="button" onClick={load} className="mt-5 h-11 rounded-xl"><RefreshCw className="mr-2 h-4 w-4" />Try again</Button></PageTransition>;

  if (!normalized) return <PageTransition className="min-h-[100dvh] py-10 text-center" data-testid="bonus-mission-empty"><Gift className="mx-auto h-10 w-10 text-primary" /><h1 className="mt-4 text-xl font-bold">No active bonus mission</h1><p className="mx-auto mt-2 max-w-sm text-sm text-white/55">Available offers are shown before payment so you can choose them deliberately.</p><Button type="button" onClick={() => navigate("/wallet")} className="mt-5 h-11 rounded-xl">View deposit options</Button></PageTransition>;

  const rules = normalized.contribution_rules;
  return (
    <PageTransition className="-mx-4 -my-4 min-h-[100dvh] overflow-x-clip bg-background px-4 pb-8 pt-4" data-testid="bonus-mission-page">
      <div className="mx-auto max-w-xl">
        <header className="flex items-center justify-between">
          <button type="button" onClick={() => navigate(-1)} aria-label="Go back" className="flex h-11 w-11 items-center justify-center rounded-xl border border-white/12 bg-white/5"><ArrowLeft className="h-5 w-5" /></button>
          <span className="rounded-full border border-primary/25 bg-primary/10 px-3 py-1.5 text-[10px] font-bold uppercase tracking-[.16em] text-primary">{normalized.status.replaceAll("_", " ")}</span>
          <Link to="/support" className="flex h-11 w-11 items-center justify-center rounded-xl border border-white/12 bg-white/5" aria-label="Get help"><Headphones className="h-5 w-5" /></Link>
        </header>

        <motion.section initial={reducedMotion ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={reducedMotion ? { duration: 0 } : { duration: 0.26 }} className="mt-5 overflow-hidden rounded-3xl border border-primary/30 bg-card/70 p-5 shadow-[0_24px_64px_rgba(0,0,0,.38)]">
          <img src="/promo/reward-vault.webp" alt="Gold reward vault with an emerald center" className="float-right ml-4 h-28 w-20 rounded-2xl object-cover object-center shadow-[0_16px_36px_rgba(255,199,64,.14)]" />
          <p className="text-[10px] font-bold uppercase tracking-[.2em] text-primary">Bonus mission</p>
          <h1 className="mt-2 text-3xl font-extrabold tracking-tight">Unlock {rewardLabel(normalized.reward)}</h1>
          <p className="mt-2 text-sm leading-relaxed text-white/55">Only eligible settled wagers count. Progress and claim eligibility come from the server.</p>
          <div className="mt-5"><PromotionProgress mission={normalized} /></div>
          <ClaimFinalityNotice mission={normalized} />
          <MissionDeadline mission={normalized} className="mt-4 rounded-xl border border-white/8 bg-black/10 p-3" />
          <div className="clear-both" />
          <MissionStateNotice mission={normalized} />
          {normalized.status === "ACTIVE" && <p className="mt-3 flex items-start gap-2 rounded-xl border border-emerald-400/20 bg-emerald-400/[.06] p-3 text-xs leading-relaxed text-emerald-100/80"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />Deposited cash remains separate. This progress controls only the pending promotional reward.</p>}
        </motion.section>

        {error && <div role="alert" className="mt-4 rounded-xl border border-red-400/25 bg-red-400/10 p-3 text-sm text-red-100">{error}</div>}
        <p aria-live="polite" className="sr-only">{announcement}</p>

        {claimReceipt && normalized.status === "CLAIMED" && <motion.section initial={reducedMotion ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={reducedMotion ? { duration: 0 } : { duration: 0.6 }} className="mt-4 rounded-2xl border border-emerald-400/30 bg-emerald-400/[.08] p-4" data-testid="bonus-claim-receipt"><div className="flex items-start gap-3"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-400/15 text-emerald-300"><CheckCircle2 className="h-5 w-5" /></span><div><h2 className="font-bold text-emerald-100">Reward claim confirmed</h2><p className="mt-1 text-xs leading-relaxed text-emerald-50/65">{rewardLabel(normalized.reward)} was confirmed by the server.</p></div></div><dl className="mt-3 grid grid-cols-2 gap-2 text-xs"><div className="rounded-xl border border-white/8 bg-black/10 p-3"><dt className="text-white/40">Receipt ID</dt><dd className="mt-1 truncate font-mono text-[11px] text-white/75">{claimReceipt.id || "Not supplied"}</dd></div><div className="rounded-xl border border-white/8 bg-black/10 p-3"><dt className="text-white/40">Confirmed at</dt><dd className="mt-1 text-white/75">{formatPromotionDate(claimReceipt.claimed_at, normalized.timezone)}</dd></div></dl><button type="button" onClick={() => navigate("/wallet/activity")} className="mt-3 min-h-11 w-full rounded-xl border border-emerald-400/25 bg-emerald-400/10 text-xs font-bold text-emerald-100">View transaction</button></motion.section>}

        <section className="mt-4 rounded-2xl border border-white/10 bg-card/50 p-4">
          <div className="flex items-center gap-2"><Gamepad2 className="h-5 w-5 text-primary" /><h2 className="font-bold">Qualifying rules</h2></div>
          <dl className="mt-4 grid grid-cols-2 gap-2 text-xs">
            <div className="rounded-xl border border-white/8 bg-black/10 p-3"><dt className="text-white/40">Default contribution</dt><dd className="mt-1 tabular-nums font-bold">{rules.default_bps / 100}% of settled stake</dd></div>
            <div className="rounded-xl border border-white/8 bg-black/10 p-3"><dt className="text-white/40">Maximum counted stake</dt><dd className="mt-1 tabular-nums font-bold">{rules.max_qualifying_stake_chips ? formatChips(rules.max_qualifying_stake_chips) : "Campaign rule"}</dd></div>
          </dl>
          <div className="mt-3 space-y-3 text-xs leading-relaxed"><div><p className="font-bold text-white/75">Included games</p><p className="mt-0.5 text-white/50">{rules.allowed_games.length ? rules.allowed_games.join(", ") : "The campaign's eligible-game list applies."}</p></div>{Object.keys(rules.game_bps || {}).length > 0 && <div><p className="font-bold text-white/75">Game contribution rates</p><p className="mt-0.5 text-white/50">{Object.entries(rules.game_bps).map(([game, bps]) => `${game}: ${Number(bps) / 100}%`).join(" · ")}</p></div>}{rules.excluded_games.length > 0 && <div><p className="font-bold text-white/75">Excluded games</p><p className="mt-0.5 text-white/50">{rules.excluded_games.join(", ")}</p></div>}<div><p className="font-bold text-white/75">Qualifying wallet sources</p><p className="mt-0.5 text-white/50">{rules.eligible_source_buckets?.length ? rules.eligible_source_buckets.join(", ") : "The accepted campaign source rules apply."}</p></div><p className="text-white/50">Cancelled, void and refunded wagers contribute zero. Winnings and losses do not change turnover; only qualifying stake does.</p></div>
        </section>

        <section className="mt-4 overflow-hidden rounded-2xl border border-white/10 bg-card/50">
          <div className="flex items-center justify-between border-b border-white/8 p-4"><div><h2 className="font-bold">Recent wager activity</h2><p className="mt-1 text-xs text-white/45">Authoritative contribution events</p></div><button type="button" onClick={load} className="flex h-11 w-11 items-center justify-center rounded-xl text-white/55" aria-label="Refresh mission"><RotateCcw className="h-4 w-4" /></button></div>
          {events.length ? <div className="divide-y divide-white/8">{events.map((event, index) => <EventRow key={event.id || `${event.source_id}:${index}`} event={event} />)}</div> : <p className="p-5 text-center text-sm text-white/45">No qualifying wager activity yet.</p>}
        </section>

        <section className="mt-4 rounded-2xl border border-white/10 bg-card/50 p-4 text-xs leading-relaxed text-white/50"><h2 className="font-bold text-white/75">Accepted campaign</h2><p className="mt-2">Terms {normalized.terms_version || "not supplied"} · campaign version {normalized.campaign_version} · jurisdiction {normalized.jurisdiction || "not supplied"}</p><p className="mt-1">Settlement-finality policy {normalized.claim_finality.policy_version || normalized.settlement_finality_policy_version || "not supplied"}</p><p className="mt-1">Deadline {formatPromotionDate(normalized.deadline_at, normalized.timezone)}</p><div className="mt-3 flex gap-3"><Link to="/support" className="font-bold text-primary">Get support</Link><Link to="/responsible-play" className="font-bold text-primary">Responsible play</Link></div></section>

        <div className="sticky bottom-0 -mx-4 mt-4 border-t border-white/8 bg-background/95 px-4 pb-[max(12px,var(--fg-safe-bottom))] pt-3 backdrop-blur-xl">
          <Button type="button" onClick={claim} disabled={!normalized.claimable || busy === "claim"} className={`h-12 w-full rounded-xl text-base font-extrabold ${normalized.claimable ? "bg-[hsl(var(--emerald))] text-slate-950 hover:bg-[hsl(var(--emerald))]/90" : ""}`} data-testid="claim-bonus-button">{busy === "claim" ? "Confirming claim…" : normalized.status === "CLAIMED" ? "Reward claimed" : normalized.claimable ? `Claim ${rewardLabel(normalized.reward)} reward` : isClaimFinalityPending(normalized) ? "Verifying settled wagers" : normalized.status === "PAUSED_FOR_REVIEW" ? "Claim paused for review" : "Complete the requirement to claim"}</Button>
          {normalized.forfeit_allowed && !["CLAIMED", "FORFEITED", "EXPIRED"].includes(normalized.status) && <button type="button" onClick={() => setConfirmForfeit(true)} className="mt-2 min-h-11 w-full rounded-xl text-xs font-bold text-white/50">Review option to end unearned bonus</button>}
        </div>
      </div>

      <AlertDialog open={confirmForfeit} onOpenChange={setConfirmForfeit}>
        <AlertDialogContent className="w-[calc(100%_-_2rem)] max-w-md rounded-2xl border-white/12 bg-card pb-[max(20px,var(--fg-safe-bottom))]">
          <AlertDialogHeader><AlertDialogTitle>End this bonus mission?</AlertDialogTitle><AlertDialogDescription className="leading-relaxed text-white/55">Only the unearned promotional reward will be forfeited if the server confirms this option. Deposited cash is not forfeited.</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter className="grid grid-cols-2 gap-3 sm:grid-cols-2 sm:space-x-0"><AlertDialogCancel disabled={busy === "forfeit"} className="mt-0 h-11 rounded-xl border-white/15">Keep mission</AlertDialogCancel><AlertDialogAction onClick={(event) => { event.preventDefault(); forfeit(); }} disabled={busy === "forfeit"} className="h-11 rounded-xl bg-white/10 text-white hover:bg-white/15">{busy === "forfeit" ? "Confirming…" : "End bonus"}</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageTransition>
  );
}
