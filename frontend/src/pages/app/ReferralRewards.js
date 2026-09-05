import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { motion, useReducedMotion } from "framer-motion";
import { ArrowLeft, Check, Clock3, Copy, Gift, Headphones, RefreshCw, Share2, ShieldAlert, UserCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageTransition, formatChips } from "@/components/common";
import { useAuth } from "@/context/AuthContext";
import { errMsg } from "@/lib/api";
import { clearFinancialIntent, financialIntentKey } from "@/lib/financialIntent";
import { promotions } from "@/lib/promotionApi";
import { formatPromotionDate } from "@/components/promotions";
import { formatInrPaise } from "@/lib/walletUtils";

const TASK_TONE = {
  VERIFIED: "border-emerald-400/25 bg-emerald-400/10 text-emerald-200",
  CLAIMED: "border-emerald-400/25 bg-emerald-400/10 text-emerald-200",
  PENDING: "border-sky-400/25 bg-sky-400/10 text-sky-200",
  REJECTED: "border-red-400/25 bg-red-400/10 text-red-200",
};

function taskReward(task) {
  if (String(task.reward_type || "").toUpperCase() === "CASH_CREDIT" && Number(task.reward_paise) > 0) {
    return formatInrPaise(task.reward_paise);
  }
  if (Number(task.reward_chips) > 0) return `${formatChips(task.reward_chips)} restricted bonus`;
  return "Reward shown after verification";
}

function safeSupportPath(value) {
  return ["/support", "/responsible-play"].includes(value) ? value : "/support";
}

function referralClaimDisabledCopy(value) {
  const code = String(value || "");
  const known = {
    REFERRAL_FRAUD_REVIEW_REQUIRED: "Relationship verification must be cleared before claiming.",
    REFERRAL_TASKS_PENDING: "Complete and verify the required tasks before claiming.",
    CLAIM_THRESHOLD_NOT_MET: "Reach the verified claim threshold before claiming.",
  };
  return known[code] || (code && !/^[A-Z0-9_]+$/.test(code) ? code : "Server verification is required before claiming.");
}

function serverAllowsAppeal(task) {
  const review = task?.fraud_review;
  return Boolean(
    task?.referral_id
      && review?.status === "REJECTED"
      && review?.appeal_available === true,
  );
}

function ReferralTask({ task, appealEligible = false, appealReason = "", appealError = "", appealBusy = false, onAppealReason, onAppeal }) {
  const status = String(task.status || "PENDING").toUpperCase();
  const review = task?.fraud_review || null;
  const appealId = `referral-appeal-${String(task.referral_id || task.id || "task").replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  return (
    <article className="rounded-xl border border-white/10 bg-black/10 p-3.5" data-testid="referral-task">
      <div className="flex items-start justify-between gap-3"><div className="flex min-w-0 items-start gap-3"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-primary/25 bg-primary/10"><UserCheck className="h-5 w-5 text-primary" /></span><div><h3 className="text-sm font-bold">{task.title || task.task_key?.replaceAll("_", " ") || task.task_type?.replaceAll("_", " ") || "Verified referral task"}</h3><p className="mt-1 text-xs leading-relaxed text-white/50">{task.description || "This task is verified by the server before its fixed reward becomes claimable."}</p></div></div><span className={`shrink-0 rounded-full border px-2 py-1 text-[9px] font-bold uppercase ${TASK_TONE[status] || "border-white/15 bg-white/5 text-white/55"}`}>{status}</span></div>
      <div className="mt-3 flex items-center justify-between border-t border-white/8 pt-3 text-xs"><span className="text-white/45">Fixed reward</span><strong className="tabular-nums text-primary">{taskReward(task)}</strong></div>
      {task.verification_period_hours != null && <p className="mt-2 flex items-center gap-1.5 text-[10px] text-white/40"><Clock3 className="h-3.5 w-3.5" />Verification may take up to {task.verification_period_hours} hours.</p>}
      {task.verify_after && <p className="mt-2 flex items-center gap-1.5 text-[10px] text-white/40"><Clock3 className="h-3.5 w-3.5" />Verification review after {formatPromotionDate(task.verify_after, "UTC")}</p>}
      {(task.rejection_reason || task.review_reason) && <p className="mt-2 rounded-lg border border-red-400/20 bg-red-400/[.07] p-2 text-[11px] leading-relaxed text-red-100">{task.rejection_reason || task.review_reason}</p>}
      {review?.status === "REJECTED" && <div className="mt-3 rounded-xl border border-red-400/20 bg-red-400/[.06] p-3 text-[11px] leading-relaxed text-red-50/80" data-testid="referral-fraud-review"><p className="font-bold text-red-100">Referral relationship rejected</p>{review.reason_code && <p className="mt-1">Reason code: <strong className="font-mono">{review.reason_code}</strong></p>}<p className="mt-1">Appeal status: <strong>{String(review.appeal_status || "NOT_SUBMITTED").replaceAll("_", " ")}</strong></p><Link to={safeSupportPath(review.support_path)} className="mt-2 inline-flex min-h-11 items-center font-bold text-primary underline">Get support</Link></div>}
      {appealEligible && <form className="mt-3 rounded-xl border border-primary/20 bg-primary/[.06] p-3" onSubmit={(event) => { event.preventDefault(); onAppeal(task); }} data-testid="referral-appeal-form"><label htmlFor={appealId} className="text-xs font-bold text-white/80">Why should this referral decision be reviewed?</label><p id={`${appealId}-help`} className="mt-1 text-[11px] leading-relaxed text-white/45">Provide at least 10 characters. Do not include passwords, payment credentials or identity document numbers.</p><textarea id={appealId} value={appealReason} onChange={(event) => onAppealReason(task.referral_id, event.target.value)} minLength={10} maxLength={1000} required aria-describedby={`${appealId}-help${appealError ? ` ${appealId}-error` : ""}`} className="mt-2 min-h-24 w-full resize-y rounded-xl border border-white/12 bg-black/20 p-3 text-sm text-white outline-none focus:border-primary" />{appealError && <p id={`${appealId}-error`} role="alert" className="mt-2 text-[11px] text-red-100">{appealError}</p>}<Button type="submit" disabled={appealBusy || appealReason.trim().length < 10} className="mt-3 min-h-11 w-full rounded-xl">{appealBusy ? "Submitting appeal…" : appealError ? "Retry appeal" : "Submit appeal"}</Button></form>}
    </article>
  );
}

export default function ReferralRewards() {
  const navigate = useNavigate();
  const reducedMotion = useReducedMotion();
  const { user, refreshUser } = useAuth();
  const [referral, setReferral] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [copied, setCopied] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [claimReceipt, setClaimReceipt] = useState(null);
  const [appealReasons, setAppealReasons] = useState({});
  const [appealErrors, setAppealErrors] = useState({});

  const load = useCallback(async () => {
    setLoading(true);
    const [summaryResult, tasksResult] = await Promise.allSettled([promotions.referral(), promotions.referralTasks()]);
    if (summaryResult.status === "fulfilled") {
      setReferral(summaryResult.value);
      if (summaryResult.value?.tasks?.length) setTasks(summaryResult.value.tasks);
      setError("");
    }
    else setError(errMsg(summaryResult.reason, "Referral rewards are unavailable right now."));
    if (tasksResult.status === "fulfilled") setTasks(tasksResult.value);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const shareText = referral?.invite_url ? `Join me on Chakri.Casino: ${referral.invite_url}` : "";
  const share = async () => {
    if (!shareText || busy) return;
    setBusy("share");
    try {
      if (navigator.share) await navigator.share({ title: "Chakri.Casino referral", text: "Join through my referral link", url: referral.invite_url });
      else { await navigator.clipboard.writeText(referral.invite_url); setCopied(true); setAnnouncement("Referral link copied."); }
    } catch (shareError) {
      if (shareError?.name !== "AbortError") setError("The share sheet could not be opened. Copy the referral link instead.");
    } finally { setBusy(""); }
  };
  const copy = async () => {
    if (!referral?.invite_url) return;
    try { await navigator.clipboard.writeText(referral.invite_url); setCopied(true); setAnnouncement("Referral link copied."); }
    catch (_error) { setError("Clipboard access was blocked. Select and copy the referral link manually."); }
  };
  const whatsapp = () => {
    if (!shareText) return;
    window.open(`https://wa.me/?text=${encodeURIComponent(shareText)}`, "_blank", "noopener,noreferrer");
  };
  const claim = async () => {
    if (!referral?.claimable || busy) return;
    const key = financialIntentKey("referral-claim", user?.id, `threshold=${referral.claim_threshold_chips}`);
    setBusy("claim");
    try {
      const result = await promotions.claimReferral(key);
      clearFinancialIntent("referral-claim", user?.id, key);
      if (result.referral) setReferral(result.referral);
      setClaimReceipt(result.claim || null);
      setAnnouncement("Referral reward claim confirmed by the server.");
      await refreshUser?.();
      await load();
    } catch (requestError) { setError(errMsg(requestError, "The server did not confirm this claim. Retry safely with the same request.")); }
    finally { setBusy(""); }
  };

  const appeal = async (task) => {
    if (!serverAllowsAppeal(task)) return;
    const referralId = String(task.referral_id);
    const reason = String(appealReasons[referralId] || "").trim();
    if (reason.length < 10 || busy) return;
    setBusy(`appeal:${referralId}`);
    setAppealErrors((current) => ({ ...current, [referralId]: "" }));
    try {
      await promotions.appealReferral(referralId, reason);
      setAnnouncement("Referral appeal submitted for server review.");
      setAppealReasons((current) => ({ ...current, [referralId]: "" }));
      await load();
    } catch (requestError) {
      setAppealErrors((current) => ({ ...current, [referralId]: errMsg(requestError, "The appeal was not submitted. Review your reason and retry.") }));
    } finally {
      setBusy("");
    }
  };

  if (loading) return <PageTransition className="min-h-[100dvh] space-y-4"><div className="h-12 rounded-xl fg-shimmer" /><div className="h-72 rounded-3xl fg-shimmer" /><div className="h-52 rounded-2xl fg-shimmer" /></PageTransition>;
  if (!referral) return <PageTransition className="min-h-[100dvh] py-10 text-center" data-testid="referral-empty"><Gift className="mx-auto h-10 w-10 text-primary" /><h1 className="mt-4 text-xl font-bold">Referral rewards unavailable</h1><p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-white/55">{error || "No active referral campaign is available for your account."}</p><Button type="button" onClick={load} className="mt-5 h-11 rounded-xl"><RefreshCw className="mr-2 h-4 w-4" />Try again</Button></PageTransition>;

  const percent = Math.min(100, Math.max(0, Number(referral.progress_percent) || 0));
  const renderedAppealRelationships = new Set();
  return (
    <PageTransition className="-mx-4 -my-4 min-h-[100dvh] overflow-x-clip bg-background px-4 pb-8 pt-4" data-testid="referral-rewards-page">
      <div className="mx-auto max-w-xl">
        <header className="flex items-center justify-between"><button type="button" onClick={() => navigate(-1)} aria-label="Go back" className="flex h-11 w-11 items-center justify-center rounded-xl border border-white/12 bg-white/5"><ArrowLeft className="h-5 w-5" /></button><p className="text-xs font-bold uppercase tracking-[.18em] text-white/55">Referral rewards</p><Link to="/support" className="flex h-11 w-11 items-center justify-center rounded-xl border border-white/12 bg-white/5" aria-label="Get help"><Headphones className="h-5 w-5" /></Link></header>

        <motion.section initial={reducedMotion ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={reducedMotion ? { duration: 0 } : { duration: 0.26 }} className="mt-5 overflow-hidden rounded-3xl border border-primary/30 bg-card/70 p-5 shadow-[0_24px_64px_rgba(0,0,0,.4)]">
          <div className="flex items-center justify-between"><div><p className="text-[10px] font-bold uppercase tracking-[.2em] text-primary">Verified reward balance</p><h1 className="mt-2 text-3xl font-extrabold tabular-nums">{formatChips(referral.verified_reward_chips)}</h1></div><span className="flex h-14 w-14 items-center justify-center rounded-2xl border border-primary/30 bg-primary/10"><Gift className="h-7 w-7 text-primary" /></span></div>
          <div className="mt-5 flex items-end justify-between gap-3"><p className="text-sm text-white/55">Claim threshold <strong className="tabular-nums text-white">{formatChips(referral.claim_threshold_chips)}</strong></p><strong className="tabular-nums text-3xl text-primary">{percent}%</strong></div>
          <div role="progressbar" aria-label="Verified referral reward progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={`${percent} percent verified`} className="mt-3 h-3 overflow-hidden rounded-full border border-white/10 bg-black/35"><motion.div className="h-full w-full origin-left rounded-full bg-primary" initial={false} animate={{ scaleX: percent / 100 }} transition={reducedMotion ? { duration: 0 } : { duration: 0.4 }} /></div>
          <div className="mt-3 flex justify-between text-xs text-white/45"><span className="tabular-nums">{formatChips(referral.remaining_chips)} remaining</span><span className="tabular-nums">{formatChips(referral.pending_reward_chips)} pending verification</span></div>
          <Button type="button" onClick={claim} disabled={!referral.claimable || busy === "claim"} className={`mt-5 h-12 w-full rounded-xl text-base font-extrabold ${referral.claimable ? "bg-[hsl(var(--emerald))] text-slate-950 hover:bg-[hsl(var(--emerald))]/90" : ""}`} data-testid="claim-referral-button">{busy === "claim" ? "Confirming claim…" : referral.claimable ? "Claim verified reward" : referralClaimDisabledCopy(referral.claim_disabled_reason)}</Button>
        </motion.section>

        {error && <div role="alert" className="mt-4 rounded-xl border border-red-400/25 bg-red-400/10 p-3 text-sm text-red-100">{error}</div>}
        <p aria-live="polite" className="sr-only">{announcement}</p>

        {claimReceipt && <motion.section initial={reducedMotion ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={reducedMotion ? { duration: 0 } : { duration: 0.6 }} className="mt-4 rounded-2xl border border-emerald-400/30 bg-emerald-400/[.08] p-4" data-testid="referral-claim-receipt"><div className="flex items-start gap-3"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-400/15 text-emerald-300"><Check className="h-5 w-5" /></span><div><h2 className="font-bold text-emerald-100">Referral reward confirmed</h2><p className="mt-1 text-xs text-emerald-50/65">Receipt {claimReceipt.id || "not supplied"} · {formatPromotionDate(claimReceipt.claimed_at, "UTC")}</p></div></div><button type="button" onClick={() => navigate("/wallet/activity")} className="mt-3 min-h-11 w-full rounded-xl border border-emerald-400/25 bg-emerald-400/10 text-xs font-bold text-emerald-100">View transaction</button></motion.section>}

        <section className="mt-4 rounded-2xl border border-white/10 bg-card/50 p-4">
          <h2 className="font-bold">Your private referral link</h2><p className="mt-1 text-xs leading-relaxed text-white/45">Share only when you choose. Chakri.Casino does not request your contacts.</p>
          <div className="mt-3 flex min-h-12 items-center gap-2 rounded-xl border border-white/10 bg-black/15 px-3"><code className="min-w-0 flex-1 truncate text-xs text-white/65">{referral.invite_url || "No link supplied"}</code><button type="button" onClick={copy} disabled={!referral.invite_url} aria-label="Copy referral link" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-primary">{copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}</button></div>
          {!referral.invite_url && <p role="status" className="mt-2 text-[11px] leading-relaxed text-amber-100/75">Sharing is disabled until the operator publishes an approved secure app address. This browser will not invent a referral URL.</p>}
          <div className="mt-3 grid grid-cols-2 gap-3"><Button type="button" variant="outline" onClick={share} disabled={!referral.invite_url || busy === "share"} className="h-11 rounded-xl border-white/15"><Share2 className="mr-2 h-4 w-4" />Share</Button><Button type="button" variant="outline" onClick={whatsapp} disabled={!referral.invite_url} className="h-11 rounded-xl border-white/15">WhatsApp</Button></div>
        </section>

        <section className="mt-4 rounded-2xl border border-white/10 bg-card/50 p-4"><div className="flex items-center justify-between"><div><h2 className="font-bold">Reward tasks</h2><p className="mt-1 text-xs text-white/45">Server-verified fixed rewards</p></div><span className="rounded-full border border-white/12 bg-white/5 px-2 py-1 text-[10px] text-white/50">{tasks.length} tasks</span></div><div className="mt-4 space-y-3">{tasks.length ? tasks.map((task, index) => { const eligible = serverAllowsAppeal(task) && !renderedAppealRelationships.has(task.referral_id); if (eligible) renderedAppealRelationships.add(task.referral_id); return <ReferralTask key={task.id || `${task.task_type}:${index}`} task={task} appealEligible={eligible} appealReason={appealReasons[task.referral_id] || ""} appealError={appealErrors[task.referral_id] || ""} appealBusy={busy === `appeal:${task.referral_id}`} onAppealReason={(referralId, value) => setAppealReasons((current) => ({ ...current, [referralId]: value }))} onAppeal={appeal} />; }) : <p className="rounded-xl border border-white/8 bg-black/10 p-4 text-center text-sm text-white/45">No referral tasks have been published.</p>}</div></section>

        <section className="mt-4 rounded-2xl border border-amber-300/20 bg-amber-300/[.06] p-4 text-xs leading-relaxed text-amber-50/75"><p className="flex items-center gap-2 font-bold text-amber-100"><ShieldAlert className="h-4 w-4" />Fair-use and privacy notice</p><p className="mt-2">One inviter is allowed per eligible new player. Registration and deposit tasks pass identity, payment and anti-fraud verification before rewards become claimable. Device data is only one review signal and is not the sole decision.</p><p className="mt-2"><Link to="/support" className="font-bold underline">Ask for support or appeal a rejected task</Link> · <Link to="/responsible-play" className="font-bold underline">Responsible play</Link></p></section>
      </div>
    </PageTransition>
  );
}
