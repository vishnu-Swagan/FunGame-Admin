import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle, BadgeCheck, BookOpenCheck, CheckCircle2, ChevronRight,
  ClipboardCheck, FileSearch, History, RefreshCw, Search, ShieldCheck, Users,
} from "lucide-react";
import { toast } from "sonner";

import AdminStepUpDialog, { requiresAdminStepUp } from "@/components/AdminStepUpDialog";
import { PageTransition, formatChips } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useAuth } from "@/context/AuthContext";
import { financialApi, errMsg } from "@/lib/api";
import { ADMIN_PERMISSIONS, hasPermission } from "@/lib/adminPermissions";

const ROOT = "/admin/promotions";

export const promotionAdminApi = {
  async readiness() {
    const { data } = await financialApi.get(`${ROOT}/readiness`);
    return data;
  },
  async campaigns() {
    const { data } = await financialApi.get(`${ROOT}/campaigns`);
    return Array.isArray(data?.campaigns) ? data.campaigns : [];
  },
  async campaign(id) {
    const { data } = await financialApi.get(`${ROOT}/campaigns/${encodeURIComponent(id)}`);
    return data;
  },
  async approveCampaign(id, version, reason) {
    const { data } = await financialApi.post(
      `${ROOT}/campaigns/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}/approve`,
      { reason }, { __noFailover: true },
    );
    return data;
  },
  async activateCampaign(id, version, reason) {
    const { data } = await financialApi.post(
      `${ROOT}/campaigns/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}/activate`,
      { reason }, { __noFailover: true },
    );
    return data;
  },
  async mission(id) {
    const { data } = await financialApi.get(`${ROOT}/missions/${encodeURIComponent(id)}`);
    return data;
  },
  async reconcileMission(id, reason) {
    const { data } = await financialApi.post(
      `${ROOT}/missions/${encodeURIComponent(id)}/reconcile`,
      { repair: false, reason }, { __noFailover: true },
    );
    return data;
  },
  async referralTasks() {
    const { data } = await financialApi.get(`${ROOT}/referral-tasks`, { params: { limit: 100 } });
    return Array.isArray(data?.tasks) ? data.tasks : [];
  },
  async referral(id) {
    const { data } = await financialApi.get(`${ROOT}/referrals/${encodeURIComponent(id)}`);
    return data;
  },
  async reviewReferralTask(id, approve, reason) {
    const { data } = await financialApi.post(
      `${ROOT}/referral-tasks/${encodeURIComponent(id)}/review`,
      { approve, reason }, { __noFailover: true },
    );
    return data;
  },
  async reviewReferralFraud(id, decision, reasonCode, reason) {
    const { data } = await financialApi.post(
      `${ROOT}/referrals/${encodeURIComponent(id)}/fraud-review`,
      { decision, reason_code: reasonCode, reason }, { __noFailover: true },
    );
    return data;
  },
  async audit(params = {}) {
    const { data } = await financialApi.get(`${ROOT}/audit`, { params: { page: 1, limit: 100, ...params } });
    return data;
  },
};

const REQUIREMENT_LABELS = {
  regulatory_approved: "REGULATORY_APPROVED",
  real_money_enabled: "REAL_MONEY_ENABLED",
  feature_enabled: "Feature deployment gate",
  promotion_core_ready: "Promotion indexes and transactions",
  financial_core_ready: "Financial core readiness",
  game_wallet_code_certified: "GAME_WALLET_INTEGRATION_READY",
  financial_game_wallet_integration_attested: "FINANCIAL_GAME_WALLET_INTEGRATED",
  promotion_wallet_integration_attested: "PROMOTIONS_GAME_WALLET_INTEGRATED",
};

const SAFE_AUDIT_METADATA = new Set([
  "campaign_id", "campaign_version", "deposit_id", "target_chips", "bet_id",
  "source_event_id", "task_id", "claim_id", "status", "expected_pending",
  "expected_settled", "stored_pending", "stored_settled", "repair",
  "jurisdiction", "terms_version",
]);

function when(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleString("en-IN", {
      day: "2-digit", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit", timeZoneName: "short",
    });
}

function human(value) {
  return String(value || "Unknown").replaceAll("_", " ").toLowerCase().replace(/(^|\s)\S/g, (letter) => letter.toUpperCase());
}

function statusTone(status) {
  const value = String(status || "").toUpperCase();
  if (["ACTIVE", "VERIFIED", "CLAIMED", "READY", "MATCH"].includes(value)) return "positive";
  if (["DRAFT", "PENDING", "REVIEWING", "APPROVED", "DORMANT"].includes(value)) return "warning";
  if (["REJECTED", "FAILED", "MISMATCH", "PAUSED_FOR_REVIEW"].includes(value)) return "danger";
  return "neutral";
}

function StatusPill({ children, tone }) {
  const styles = {
    positive: "border-[#b7ddd0] bg-[#e3f3ed] text-[#19745a]",
    warning: "border-[#e9d49d] bg-[#f8efd9] text-[#8a5909]",
    danger: "border-[#e6bbc0] bg-[#f8e7e9] text-[#a12f3c]",
    neutral: "border-[#dcdfe4] bg-[#f0f1f3] text-[#5e636c]",
  };
  return <span className={`inline-flex rounded-full border px-2 py-1 text-[9px] font-bold uppercase tracking-[.08em] ${styles[tone || statusTone(children)]}`}>{children}</span>;
}

function EmptyPanel({ icon: Icon = FileSearch, title, text }) {
  return <div className="empty-state-compact"><span><Icon size={19} /></span><h3>{title}</h3><p>{text}</p></div>;
}

function Panel({ title, subtitle, meta, children, testId }) {
  return (
    <section className="crm-panel" data-testid={testId}>
      <header className="crm-panel-header"><div><h2>{title}</h2><p>{subtitle}</p></div>{meta && <span className="crm-panel-meta">{meta}</span>}</header>
      <div className="crm-panel-body">{children}</div>
    </section>
  );
}

function ReadinessMetric({ label, ready, note }) {
  return <div className="metric-cell"><span className="metric-label">{label}</span><strong className="metric-value">{ready ? "Ready" : "Dormant"}</strong><span className={`metric-delta ${ready ? "metric-up" : "metric-down"}`}>{note}</span></div>;
}

function RequirementList({ title, feature }) {
  const rows = Object.entries(feature?.requirements || {});
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
      <div className="flex items-center justify-between gap-3"><strong className="text-xs">{title}</strong><StatusPill tone={feature?.enabled ? "positive" : "warning"}>{feature?.enabled ? "Enabled" : "Fail closed"}</StatusPill></div>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {rows.map(([key, value]) => <div key={key} className="flex min-w-0 items-center gap-2 text-[10px]"><span className={`h-2 w-2 shrink-0 rounded-full ${value ? "bg-[#19745a]" : "bg-[#b13a46]"}`} /><span className="min-w-0 flex-1 truncate text-white/55">{REQUIREMENT_LABELS[key] || human(key)}</span><strong className={value ? "text-emerald-700" : "text-red-700"}>{value ? "Yes" : "No"}</strong></div>)}
      </div>
    </div>
  );
}

function versionPreviewRows(version) {
  if (!version) return [];
  const base = [
    ["Terms version", version.terms_version || "Not supplied"],
    ["Jurisdictions", (version.jurisdictions || []).join(", ") || "None"],
    ["Window", `${when(version.starts_at)} — ${when(version.ends_at)}`],
    ["Reward", `${formatChips(version.reward_chips || 0)} balance value · ${version.reward_type || "Not supplied"}`],
    ["Products", (version.incentive_products || []).join(", ") || "Not supplied"],
  ];
  Object.entries(version.responsible_gambling_rules || {})
    .sort(([left], [right]) => left.localeCompare(right))
    .forEach(([key, value]) => base.push([`Responsible play · ${human(key)}`, String(value)]));
  if (version.campaign_type === "WAGER") {
    base.push(
      ["Wager multiplier", `${Number(version.wager_multiplier_bps || 0) / 10000}×`],
      ["Duration", `${Number(version.duration_hours || 0)} hours`],
      ["Claim finality", `${Number(version.claim_finality_hours || 0)} hours`],
      ["Finality policy", version.settlement_finality_policy_version || "Not supplied"],
      ["Default contribution", `${Number(version.default_contribution_bps || 0) / 100}%`],
      ["Maximum qualifying stake", formatChips(version.max_qualifying_stake_chips || 0)],
      ["Per-player reward cap", formatChips(version.per_user_cap_chips || 0)],
      ["Daily liability cap", `${formatChips(version.daily_cap_chips || 0)} · UTC day`],
      ["Campaign liability cap", formatChips(version.campaign_cap_chips || 0)],
      ["Eligible sources", (version.eligible_source_buckets || []).join(", ") || "None"],
      ["Allowed games", (version.allowed_games || []).join(", ") || "Campaign list not supplied"],
      ["Excluded games", (version.excluded_games || []).join(", ") || "None"],
      ["Forfeit option", version.forfeit_allowed ? "Disclosed option enabled" : "Not allowed"],
    );
  } else {
    base.push(
      ["Claim threshold", formatChips(version.claim_threshold_chips || 0)],
      ["Cooling period", `${Number(version.cooling_period_hours || 0)} hours`],
      ["Per-user cap", formatChips(version.per_user_cap_chips || 0)],
      ["Daily cap", formatChips(version.daily_cap_chips || 0)],
      ["Campaign cap", formatChips(version.campaign_cap_chips || 0)],
      ["Fixed tasks", Object.entries(version.referral_tasks || {}).map(([key, reward]) => `${human(key)}: ${formatChips(reward.reward_chips || 0)}`).join(" · ") || "None"],
    );
  }
  return base;
}

function CampaignWorkspace({ campaigns, detail, selectedCampaignId, selectedVersion, onCampaign, onVersion, reason, onReason, canManage, canActivate, busy, onApprove, onActivate }) {
  const versions = detail?.versions || [];
  const version = versions.find((row) => Number(row.version) === Number(selectedVersion)) || versions[0] || null;
  const immutable = version && version.status !== "DRAFT";
  return (
    <div className="grid min-h-[430px] lg:grid-cols-[230px_minmax(0,1fr)]">
      <div className="border-b border-white/10 p-3 lg:border-b-0 lg:border-r">
        <p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-white/45">Campaigns</p>
        <div className="grid max-h-[390px] gap-1 overflow-y-auto">
          {campaigns.map((campaign) => <button key={campaign.id} type="button" onClick={() => onCampaign(campaign.id)} className={`grid min-h-12 grid-cols-[1fr_auto] items-center gap-2 rounded-lg px-3 text-left ${selectedCampaignId === campaign.id ? "bg-primary/10 text-primary" : "hover:bg-white/5"}`}><span className="min-w-0"><strong className="block truncate text-xs">{campaign.id}</strong><small className="text-[9px] text-white/45">{campaign.campaign_type} · v{campaign.latest_version}</small></span><ChevronRight size={14} /></button>)}
          {!campaigns.length && <p className="py-8 text-center text-xs text-white/45">No campaigns stored.</p>}
        </div>
      </div>
      {!version ? <EmptyPanel title="Select a campaign" text="Immutable campaign versions and significant terms appear here." /> : (
        <div className="min-w-0 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div><p className="text-[10px] font-bold uppercase tracking-wider text-primary">{version.campaign_type} campaign</p><h3 className="mt-1 text-lg font-bold">{version.title || version.campaign_id}</h3><p className="mt-1 font-mono text-[10px] text-white/40">{version.campaign_id}</p></div>
            <div className="flex flex-wrap items-center gap-2"><StatusPill>{version.status}</StatusPill><span className="source-badge"><BookOpenCheck size={12} />{immutable ? "Immutable snapshot" : "Draft snapshot"}</span></div>
          </div>
          <div className="mt-4 flex gap-2 overflow-x-auto pb-1" aria-label="Campaign versions">{versions.map((item) => <button key={item.version} type="button" onClick={() => onVersion(item.version)} className={`min-h-9 shrink-0 rounded-lg border px-3 text-[10px] font-bold ${Number(item.version) === Number(version.version) ? "border-primary/35 bg-primary/10 text-primary" : "border-white/10 bg-white/5 text-white/55"}`}>v{item.version} · {item.status}</button>)}</div>
          <div className="mt-4 grid gap-x-5 gap-y-3 sm:grid-cols-2">{versionPreviewRows(version).map(([label, value]) => <div key={label} className="min-w-0 border-b border-white/8 pb-2"><p className="text-[9px] font-bold uppercase tracking-wider text-white/40">{label}</p><p className="mt-1 break-words text-xs text-white/70">{value}</p></div>)}</div>
          <details className="mt-4 rounded-xl border border-white/10 bg-white/[0.03] p-3"><summary className="cursor-pointer text-xs font-bold">Significant terms · hash {String(version.terms_hash || "not supplied").slice(0, 12)}</summary><p className="mt-3 whitespace-pre-wrap text-[11px] leading-relaxed text-white/55">{version.terms_text || "No terms text supplied."}</p>{version.forfeit_disclosure && <p className="mt-3 border-t border-white/8 pt-3 text-[11px] leading-relaxed text-white/55"><strong>Withdrawal consequence:</strong> {version.forfeit_disclosure}</p>}</details>
          <div className="mt-4 rounded-xl border border-[#c9d8ef] bg-[#e8effb] p-3 text-[11px] leading-relaxed text-[#234c89]"><strong>{immutable ? "This version cannot be edited in place." : "Approval locks this version."}</strong> Changes require a cloned version. Maker-checker approval and recent administrator verification are enforced by the server.</div>
          {(canManage || canActivate) && <div className="mt-4 grid gap-3 border-t border-white/10 pt-4 sm:grid-cols-[1fr_auto]"><Textarea aria-label="Campaign approval or activation reason" value={reason} onChange={(event) => onReason(event.target.value)} minLength={5} maxLength={500} placeholder="Audit reason (minimum 5 characters)" className="min-h-20 resize-none" /><div className="flex flex-col gap-2">{canManage && version.status === "DRAFT" && <Button type="button" onClick={() => onApprove(version)} disabled={busy || reason.trim().length < 5} data-testid="approve-campaign-version"><ClipboardCheck className="mr-2 h-4 w-4" />Approve version</Button>}{canActivate && version.status === "APPROVED" && <Button type="button" onClick={() => onActivate(version)} disabled={busy || reason.trim().length < 5} data-testid="activate-campaign-version"><BadgeCheck className="mr-2 h-4 w-4" />Review activation</Button>}<p className="max-w-52 text-[9px] leading-relaxed text-white/40">Activation is Super Admin only. Deployment and legal flags are not changed by this screen.</p></div></div>}
          {!canManage && <p className="mt-4 text-[10px] text-white/45">Read-only campaign access. Approval requires PROMOTIONS_MANAGE.</p>}
        </div>
      )}
    </div>
  );
}

function MissionWorkspace({ canAudit, canManage, busy, detail, result, missionId, setMissionId, reason, setReason, onLookup, onReconcile }) {
  if (!canAudit) return <EmptyPanel icon={ShieldCheck} title="Audit permission required" text="Mission contribution records require PROMOTION_AUDIT_VIEW." />;
  const mission = detail?.mission;
  const events = detail?.events || [];
  const percent = Number(mission?.progress?.percent || 0);
  const issues = result?.issues || {};
  return (
    <div className="p-4">
      <form onSubmit={onLookup} className="flex flex-col gap-2 sm:flex-row"><Input aria-label="Mission ID" value={missionId} onChange={(event) => setMissionId(event.target.value)} placeholder="Exact mission ID" required className="h-10 flex-1" /><Button type="submit" variant="outline" className="h-10" disabled={busy === "mission-load"}><Search className="mr-2 h-4 w-4" />Look up</Button></form>
      {!mission && <div className="mt-4"><EmptyPanel title="No mission selected" text="Look up an exact mission ID to inspect its server-owned progress and contribution events." /></div>}
      {mission && <>
        <div className="mt-4 flex flex-wrap items-start justify-between gap-3"><div><strong className="text-sm">{mission.campaign_id} · v{mission.campaign_version}</strong><p className="mt-1 font-mono text-[10px] text-white/40">{mission.id}</p></div><StatusPill>{mission.status}</StatusPill></div>
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4"><div className="rounded-xl border border-white/10 p-3"><p className="text-[9px] text-white/40">Settled stake</p><strong className="tabular-nums">{formatChips(mission.progress?.settled_chips)}</strong></div><div className="rounded-xl border border-white/10 p-3"><p className="text-[9px] text-white/40">Pending stake</p><strong className="tabular-nums">{formatChips(mission.progress?.pending_chips)}</strong></div><div className="rounded-xl border border-white/10 p-3"><p className="text-[9px] text-white/40">Target</p><strong className="tabular-nums">{formatChips(mission.progress?.target_chips)}</strong></div><div className="rounded-xl border border-white/10 p-3"><p className="text-[9px] text-white/40">Progress</p><strong className="tabular-nums">{percent}%</strong></div></div>
        <div role="progressbar" aria-label="Mission progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="mt-3 h-2 overflow-hidden rounded-full bg-[#e5e7eb]"><div className="h-full origin-left bg-[#a82f42]" style={{ transform: `scaleX(${Math.min(100, Math.max(0, percent)) / 100})` }} /></div>
        <div className="mt-4 overflow-x-auto rounded-xl border border-white/10"><table><thead><tr><th>Event</th><th>Game</th><th>Stake</th><th>Contribution</th><th>Status</th></tr></thead><tbody>{events.slice(0, 25).map((event) => <tr key={event.id || event.source_key}><td className="max-w-48 truncate font-mono text-[10px]">{event.bet_id || event.source_event_id || event.id}</td><td>{event.game_id || event.game || "—"}</td><td className="tabular-nums">{formatChips(event.stake_chips)}</td><td className="tabular-nums">{formatChips(event.contribution_chips)}</td><td><StatusPill>{event.status || event.event_type}</StatusPill></td></tr>)}</tbody></table>{!events.length && <p className="p-4 text-center text-xs text-white/45">No derived contribution events.</p>}</div>
        {canManage && <form onSubmit={onReconcile} className="mt-4 grid gap-2 sm:grid-cols-[1fr_auto]"><Input aria-label="Mission reconciliation reason" value={reason} onChange={(event) => setReason(event.target.value)} minLength={5} maxLength={500} placeholder="Dry-run reconciliation reason" /><Button type="submit" disabled={busy || reason.trim().length < 5} data-testid="reconcile-mission"><RefreshCw className="mr-2 h-4 w-4" />Run dry reconciliation</Button><p className="text-[9px] text-white/40 sm:col-span-2">This control compares authoritative bets and wallet allocations. It sends repair=false and cannot alter mission progress.</p></form>}
        {result && <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.03] p-3" data-testid="reconciliation-result"><div className="flex items-center justify-between"><strong className="text-xs">Reconciliation result</strong><StatusPill tone={result.matches ? "positive" : "danger"}>{result.matches ? "Match" : "Mismatch"}</StatusPill></div><div className="mt-3 grid grid-cols-2 gap-2 text-[10px]"><p>Stored: <strong>{formatChips(result.stored?.settled_chips)} settled / {formatChips(result.stored?.pending_chips)} pending</strong></p><p>Expected: <strong>{formatChips(result.expected?.settled_chips)} settled / {formatChips(result.expected?.pending_chips)} pending</strong></p></div><p className="mt-2 text-[10px] text-white/45">{Number(result.authoritative_event_count || 0)} authoritative events · repair performed: {result.repaired ? "yes" : "no"}</p>{Object.entries(issues).some(([, values]) => values?.length) && <div className="mt-2 flex flex-wrap gap-1">{Object.entries(issues).filter(([, values]) => values?.length).map(([name, values]) => <StatusPill key={name} tone="danger">{human(name)} {values.length}</StatusPill>)}</div>}</div>}
      </>}
    </div>
  );
}

function ReferralWorkspace({ tasks, canAudit, canManage, busy, reasons, onReason, onInspect, detail, onReview, fraudDecision, fraudReasonCode, fraudReason, onFraudDecision, onFraudReasonCode, onFraudReason, onFraudReview }) {
  return (
    <div className="p-4">
      {!tasks.length && <EmptyPanel icon={Users} title="No referral tasks" text="Pending and reviewed fixed-reward tasks appear here." />}
      <div className="grid gap-3">{tasks.map((task) => {
        const status = String(task.status || "PENDING").toUpperCase();
        const fraudCleared = task.fraud_review?.status === "CLEARED";
        return <article key={task.id} className="rounded-xl border border-white/10 p-3" data-testid="admin-referral-task"><div className="flex flex-wrap items-start justify-between gap-3"><div><strong className="text-xs">{human(task.task_key)}</strong><p className="mt-1 font-mono text-[9px] text-white/40">Task {task.id}</p><p className="mt-1 text-[10px] text-white/45">Fixed bonus reward {formatChips(task.reward_chips || 0)} · verify after {when(task.verify_after)}</p></div><StatusPill>{status}</StatusPill></div>{task.review_reason && <p className="mt-2 rounded-lg bg-[#f0f1f3] p-2 text-[10px] text-[#5e636c]">Review reason: {task.review_reason}</p>}<div className="mt-3 flex flex-wrap gap-2">{canAudit && task.referral_id && <Button type="button" size="sm" variant="outline" onClick={() => onInspect(task.referral_id)} disabled={busy} className="h-8" data-testid="inspect-referral-review"><ShieldCheck className="mr-1.5 h-3.5 w-3.5" />Fraud review evidence</Button>}</div>{canManage && status === "PENDING" && !fraudCleared && <p role="status" className="mt-3 rounded-lg border border-[#e9d49d] bg-[#f8efd9] p-2 text-[10px] text-[#8a5909]">Task approval is unavailable until the server reports this referral relationship as CLEARED.</p>}{canManage && status === "PENDING" && fraudCleared && <div className="mt-3 grid gap-2 border-t border-white/10 pt-3 sm:grid-cols-[1fr_auto_auto]"><Input aria-label={`Review reason for ${task.id}`} value={reasons[task.id] || ""} onChange={(event) => onReason(task.id, event.target.value)} placeholder="Review reason (minimum 5 characters)" /><Button type="button" size="sm" onClick={() => onReview(task, true)} disabled={busy || (reasons[task.id] || "").trim().length < 5} data-testid="approve-referral-task"><CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />Verify</Button><Button type="button" size="sm" variant="destructive" onClick={() => onReview(task, false)} disabled={busy || (reasons[task.id] || "").trim().length < 5} data-testid="reject-referral-task">Reject</Button></div>}</article>;
      })}</div>
      {detail && <div className="mt-4 rounded-xl border border-[#c9d8ef] bg-[#e8effb] p-3 text-[#234c89]" data-testid="referral-fraud-review"><div className="flex items-center justify-between gap-3"><strong className="text-xs">Fraud and appeal review</strong><StatusPill tone={statusTone(detail.fraud_review?.status)}>{detail.fraud_review?.status || "Unknown"}</StatusPill></div><dl className="mt-3 grid gap-2 text-[10px] sm:grid-cols-2"><div><dt className="font-bold">Signal categories</dt><dd>{(detail.fraud_review?.signal_names || []).join(", ") || "No signal categories recorded"}</dd></div><div><dt className="font-bold">Appeal</dt><dd>{detail.fraud_review?.appeal_status || "No appeal status"}</dd></div><div><dt className="font-bold">Decision reason code</dt><dd>{detail.fraud_review?.reason_code || "No decision recorded"}</dd></div><div><dt className="font-bold">Reviewed at</dt><dd>{when(detail.fraud_review?.reviewed_at)}</dd></div></dl><p className="mt-2 text-[9px]">Only signal names are displayed. Device, identity and payment secret values remain hidden.</p>{canManage && detail.referral?.id && <div className="mt-3 grid gap-2 border-t border-[#c9d8ef] pt-3"><div className="grid gap-2 sm:grid-cols-2"><label className="text-[10px] font-bold">Decision<select aria-label="Referral fraud review decision" value={fraudDecision} onChange={(event) => onFraudDecision(event.target.value)} className="mt-1 h-10 w-full rounded-lg border border-[#a8bad5] bg-white px-3 text-xs text-[#234c89]"><option value="CLEAR">Clear relationship</option><option value="REJECT">Reject relationship</option></select></label><label className="text-[10px] font-bold">Reason code<Input aria-label="Referral fraud review reason code" value={fraudReasonCode} onChange={(event) => onFraudReasonCode(event.target.value.toUpperCase())} placeholder="MANUAL_REVIEW_COMPLETE" className="mt-1 h-10 bg-white" /></label></div><label className="text-[10px] font-bold">Audit reason<Textarea aria-label="Referral fraud review reason" value={fraudReason} onChange={(event) => onFraudReason(event.target.value)} minLength={5} maxLength={500} placeholder="Explain the evidence reviewed and decision" className="mt-1 min-h-20 resize-none bg-white" /></label><Button type="button" onClick={() => onFraudReview(detail.referral.id)} disabled={busy || !/^[A-Z][A-Z0-9_]{2,63}$/.test(fraudReasonCode) || fraudReason.trim().length < 5} data-testid="submit-referral-fraud-review">Submit relationship decision</Button><p className="text-[9px]">Recent step-up authentication is enforced by the server. Raw signal values are never sent from this form.</p></div>}</div>}
    </div>
  );
}

function AuditWorkspace({ audits, canAudit }) {
  if (!canAudit) return <EmptyPanel icon={ShieldCheck} title="Audit permission required" text="Promotion history requires PROMOTION_AUDIT_VIEW." />;
  if (!audits.length) return <EmptyPanel icon={History} title="No audit entries" text="Campaign, mission and referral decisions will appear here." />;
  return <div className="timeline-list">{audits.map((entry) => {
    const metadata = Object.entries(entry.metadata || {}).filter(([key]) => SAFE_AUDIT_METADATA.has(key));
    return <article key={entry.id} className="timeline-row"><span className="timeline-marker" /><div className="min-w-0"><div className="flex flex-wrap items-center justify-between gap-2"><strong>{human(entry.action)}</strong><small>{when(entry.created_at)}</small></div><small className="block">{entry.entity_type} · {entry.entity_id} · actor {entry.actor || "not supplied"}</small>{entry.reason && <p className="mt-1 text-[10px] text-white/55">Reason: {entry.reason}</p>}{metadata.length > 0 && <p className="mt-1 text-[9px] text-white/40">{metadata.map(([key, value]) => `${human(key)}: ${String(value)}`).join(" · ")}</p>}</div></article>;
  })}</div>;
}

export default function AdminPromotions() {
  const { user } = useAuth();
  const canManage = hasPermission(user, ADMIN_PERMISSIONS.PROMOTIONS_MANAGE);
  const canAudit = hasPermission(user, ADMIN_PERMISSIONS.PROMOTION_AUDIT_VIEW);
  const superAdmin = String(user?.admin_role || "").toUpperCase() === "SUPER_ADMIN";
  const canActivate = superAdmin && hasPermission(user, ADMIN_PERMISSIONS.PROMOTIONS_ACTIVATE);
  const [readiness, setReadiness] = useState(null);
  const [campaigns, setCampaigns] = useState([]);
  const [campaignDetail, setCampaignDetail] = useState(null);
  const [selectedCampaignId, setSelectedCampaignId] = useState("");
  const [selectedVersion, setSelectedVersion] = useState(null);
  const [campaignReason, setCampaignReason] = useState("");
  const [tasks, setTasks] = useState([]);
  const [audits, setAudits] = useState([]);
  const [auditTotal, setAuditTotal] = useState(0);
  const [missionId, setMissionId] = useState("");
  const [missionDetail, setMissionDetail] = useState(null);
  const [missionReason, setMissionReason] = useState("");
  const [reconciliation, setReconciliation] = useState(null);
  const [reviewReasons, setReviewReasons] = useState({});
  const [referralDetail, setReferralDetail] = useState(null);
  const [fraudDecision, setFraudDecision] = useState("CLEAR");
  const [fraudReasonCode, setFraudReasonCode] = useState("");
  const [fraudReason, setFraudReason] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [loadErrors, setLoadErrors] = useState([]);
  const [stepUpAction, setStepUpAction] = useState(null);
  const [activationCandidate, setActivationCandidate] = useState(null);

  const loadCampaign = useCallback(async (id) => {
    if (!id) { setCampaignDetail(null); return; }
    setBusy("campaign-load");
    try {
      const detail = await promotionAdminApi.campaign(id);
      setCampaignDetail(detail);
      setSelectedCampaignId(id);
      const versions = detail?.versions || [];
      const preferred = versions.find((row) => Number(row.version) === Number(detail?.campaign?.active_version)) || versions[0];
      setSelectedVersion(preferred?.version ?? null);
      setCampaignReason("");
    } catch (error) { toast.error(errMsg(error, "Campaign details could not be loaded.")); }
    finally { setBusy(""); }
  }, []);

  const loadAudit = useCallback(async () => {
    if (!canAudit) return;
    const result = await promotionAdminApi.audit();
    setAudits(Array.isArray(result?.audits) ? result.audits : []);
    setAuditTotal(Number(result?.total || 0));
  }, [canAudit]);

  const load = useCallback(async () => {
    setLoading(true);
    const requests = [promotionAdminApi.readiness(), promotionAdminApi.campaigns(), promotionAdminApi.referralTasks()];
    if (canAudit) requests.push(promotionAdminApi.audit());
    const results = await Promise.allSettled(requests);
    const errors = [];
    if (results[0].status === "fulfilled") setReadiness(results[0].value); else errors.push("Promotion readiness unavailable");
    let rows = [];
    if (results[1].status === "fulfilled") { rows = results[1].value; setCampaigns(rows); } else errors.push("Campaign list unavailable");
    if (results[2].status === "fulfilled") setTasks(results[2].value); else errors.push("Referral tasks unavailable");
    if (canAudit) {
      if (results[3].status === "fulfilled") { setAudits(results[3].value?.audits || []); setAuditTotal(Number(results[3].value?.total || 0)); }
      else errors.push("Promotion audit unavailable");
    }
    setLoadErrors(errors);
    setLoading(false);
    const desired = rows[0]?.id;
    if (desired) await loadCampaign(desired); else { setCampaignDetail(null); setSelectedCampaignId(""); }
  }, [canAudit, loadCampaign]);

  useEffect(() => { load(); }, [load]);

  const performSensitive = async (action) => {
    if (action.kind === "APPROVE_CAMPAIGN") {
      await promotionAdminApi.approveCampaign(action.campaignId, action.version, action.reason);
      toast.success("Campaign version approved as an immutable snapshot.");
      await Promise.all([loadCampaign(action.campaignId), loadAudit().catch(() => {})]);
    } else if (action.kind === "ACTIVATE_CAMPAIGN") {
      await promotionAdminApi.activateCampaign(action.campaignId, action.version, action.reason);
      toast.success("Campaign version status updated. Deployment flags were not changed.");
      await Promise.all([loadCampaign(action.campaignId), loadAudit().catch(() => {})]);
    } else if (action.kind === "RECONCILE_MISSION") {
      const result = await promotionAdminApi.reconcileMission(action.missionId, action.reason);
      setReconciliation(result);
      toast.success("Dry reconciliation completed without repair.");
      await loadAudit().catch(() => {});
    } else if (action.kind === "REVIEW_REFERRAL") {
      await promotionAdminApi.reviewReferralTask(action.taskId, action.approve, action.reason);
      toast.success(action.approve ? "Referral task verified by the server." : "Referral task rejected with an audit reason.");
      setTasks(await promotionAdminApi.referralTasks());
      await loadAudit().catch(() => {});
    } else if (action.kind === "REVIEW_REFERRAL_FRAUD") {
      await promotionAdminApi.reviewReferralFraud(action.referralId, action.decision, action.reasonCode, action.reason);
      toast.success(action.decision === "CLEAR" ? "Referral relationship cleared by the server." : "Referral relationship rejected with an audit reason.");
      const [detail, refreshedTasks] = await Promise.all([
        promotionAdminApi.referral(action.referralId),
        promotionAdminApi.referralTasks(),
      ]);
      setReferralDetail(detail);
      setTasks(refreshedTasks);
      setFraudReason("");
      setFraudReasonCode("");
      await loadAudit().catch(() => {});
    }
  };

  const runSensitive = async (action) => {
    setBusy(action.kind);
    try { await performSensitive(action); }
    catch (error) {
      if (requiresAdminStepUp(error)) setStepUpAction({ ...action });
      else toast.error(errMsg(error));
    } finally { setBusy(""); }
  };

  const retryStepUp = async () => {
    if (!stepUpAction) return;
    setBusy(stepUpAction.kind);
    try { await performSensitive(stepUpAction); setStepUpAction(null); }
    catch (error) { toast.error(errMsg(error)); }
    finally { setBusy(""); }
  };

  const lookupMission = async (event) => {
    event.preventDefault();
    if (!canAudit || !missionId.trim()) return;
    setBusy("mission-load"); setReconciliation(null);
    try { setMissionDetail(await promotionAdminApi.mission(missionId.trim())); }
    catch (error) { setMissionDetail(null); toast.error(errMsg(error, "Mission was not found.")); }
    finally { setBusy(""); }
  };

  const inspectReferral = async (id) => {
    setBusy("referral-load");
    try { setReferralDetail(await promotionAdminApi.referral(id)); setFraudDecision("CLEAR"); setFraudReasonCode(""); setFraudReason(""); }
    catch (error) { toast.error(errMsg(error, "Referral review evidence could not be loaded.")); }
    finally { setBusy(""); }
  };

  const currentFeatureReady = useMemo(() => Boolean(readiness?.wager?.enabled || readiness?.referral?.enabled), [readiness]);
  const actionLabel = {
    APPROVE_CAMPAIGN: "approving an immutable campaign version",
    ACTIVATE_CAMPAIGN: "activating an approved campaign version",
    RECONCILE_MISSION: "running mission reconciliation",
    REVIEW_REFERRAL: "reviewing a referral reward task",
    REVIEW_REFERRAL_FRAUD: "recording a referral relationship fraud decision",
  }[stepUpAction?.kind];

  return (
    <PageTransition className="crm-page-stack" data-testid="admin-promotions-page">
      <div className="crm-page-header"><div className="crm-page-header-copy"><span className="crm-page-context">Promotion control plane</span><h1>Bonus missions and referrals</h1><p>Preview immutable campaign terms, inspect contribution evidence, and review fixed referral rewards. This console never changes deployment or legal flags.</p></div><div className="crm-page-actions"><span className="source-badge"><span className="source-indicator" />Server-authoritative</span><button type="button" className="icon-button" onClick={load} disabled={loading} aria-label="Refresh promotion controls"><RefreshCw size={15} className={loading ? "animate-spin" : ""} /></button></div></div>

      <div className="crm-inline-notice" data-testid="promotion-dormant-notice"><AlertTriangle size={16} /><div><strong>{currentFeatureReady ? "Readiness evidence reports an enabled feature" : "Production promotion features remain dormant"}</strong><p>Campaign records do not unlock player rewards by themselves. Regulatory approval, financial readiness, game-wallet certification, and explicit deployment gates must all pass independently.</p></div></div>
      {loadErrors.length > 0 && <div role="alert" className="rounded-xl border border-[#e9d49d] bg-[#f8efd9] p-3 text-xs text-[#8a5909]">{loadErrors.join(" · ")}. No control was enabled.</div>}

      {loading && !readiness ? <div className="h-28 rounded-xl fg-shimmer" /> : <>
        <div className="metric-strip" data-testid="promotion-readiness"><ReadinessMetric label="Promotion core" ready={Boolean(readiness?.core?.ready)} note={`Schema v${readiness?.core?.schema_version || "—"}`} /><ReadinessMetric label="Wager missions" ready={Boolean(readiness?.wager?.enabled)} note={readiness?.wager?.enabled ? "All gates passed" : "Fail-closed gates remain"} /><ReadinessMetric label="Referral rewards" ready={Boolean(readiness?.referral?.enabled)} note={readiness?.referral?.enabled ? "All gates passed" : "Fail-closed gates remain"} /><ReadinessMetric label="Randomized rewards" ready={Boolean(readiness?.randomized_rewards_approved)} note={readiness?.randomized_rewards_approved ? "Legal approval recorded" : "Legal approval disabled"} /></div>
        <Panel title="Launch readiness evidence" subtitle="Non-secret boolean gates reported by the server; this page cannot toggle them." meta={readiness?.core?.ready ? "Core ready" : "Core dormant"}><div className="grid gap-3 p-4 lg:grid-cols-2"><RequirementList title="Wager mission gates" feature={readiness?.wager} /><RequirementList title="Referral reward gates" feature={readiness?.referral} />{readiness?.core?.errors?.length > 0 && <div className="rounded-xl border border-[#e6bbc0] bg-[#f8e7e9] p-3 text-xs text-[#a12f3c] lg:col-span-2"><strong>Core blockers</strong><ul className="mt-2 list-disc space-y-1 pl-4">{readiness.core.errors.map((error) => <li key={error}>{error}</li>)}</ul></div>}</div></Panel>
      </>}

      <Panel title="Campaign and version preview" subtitle="Activated versions are immutable; changes require a cloned version." meta={`${campaigns.length} campaigns`} testId="campaign-workspace"><CampaignWorkspace campaigns={campaigns} detail={campaignDetail} selectedCampaignId={selectedCampaignId} selectedVersion={selectedVersion} onCampaign={loadCampaign} onVersion={setSelectedVersion} reason={campaignReason} onReason={setCampaignReason} canManage={canManage} canActivate={canActivate} busy={Boolean(busy)} onApprove={(version) => runSensitive({ kind: "APPROVE_CAMPAIGN", campaignId: version.campaign_id, version: version.version, reason: campaignReason.trim() })} onActivate={(version) => setActivationCandidate({ kind: "ACTIVATE_CAMPAIGN", campaignId: version.campaign_id, version: version.version, reason: campaignReason.trim() })} /></Panel>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Mission contribution ledger" subtitle="Exact mission lookup, derived wager events, and non-repairing reconciliation." meta={missionDetail?.mission?.status || "Lookup"} testId="mission-workspace"><MissionWorkspace canAudit={canAudit} canManage={canManage} busy={busy} detail={missionDetail} result={reconciliation} missionId={missionId} setMissionId={setMissionId} reason={missionReason} setReason={setMissionReason} onLookup={lookupMission} onReconcile={(event) => { event.preventDefault(); runSensitive({ kind: "RECONCILE_MISSION", missionId: missionDetail?.mission?.id, reason: missionReason.trim() }); }} /></Panel>
        <Panel title="Referral reward review" subtitle="Fixed task status and privacy-safe fraud evidence; no raw device values." meta={`${tasks.length} tasks`} testId="referral-workspace"><ReferralWorkspace tasks={tasks} canAudit={canAudit} canManage={canManage} busy={Boolean(busy)} reasons={reviewReasons} onReason={(id, value) => setReviewReasons((current) => ({ ...current, [id]: value }))} onInspect={inspectReferral} detail={referralDetail} onReview={(task, approve) => runSensitive({ kind: "REVIEW_REFERRAL", taskId: task.id, approve, reason: (reviewReasons[task.id] || "").trim() })} fraudDecision={fraudDecision} fraudReasonCode={fraudReasonCode} fraudReason={fraudReason} onFraudDecision={setFraudDecision} onFraudReasonCode={setFraudReasonCode} onFraudReason={setFraudReason} onFraudReview={(referralId) => runSensitive({ kind: "REVIEW_REFERRAL_FRAUD", referralId, decision: fraudDecision, reasonCode: fraudReasonCode.trim(), reason: fraudReason.trim() })} /></Panel>
      </div>

      <Panel title="Promotion audit history" subtitle="Sanitized campaign, mission, claim and referral decision evidence." meta={canAudit ? `${auditTotal} entries` : "Restricted"} testId="promotion-audit"><AuditWorkspace audits={audits} canAudit={canAudit} /></Panel>

      <AlertDialog open={Boolean(activationCandidate)} onOpenChange={(open) => { if (!open) setActivationCandidate(null); }}>
        <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Activate immutable campaign version?</AlertDialogTitle><AlertDialogDescription>This records an active campaign version after server-enforced maker-checker and recent step-up checks. It does not change REGULATORY_APPROVED, WAGER_MISSIONS_ENABLED, REFERRAL_REWARDS_ENABLED, real-money, or game-wallet certification flags.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction onClick={(event) => { event.preventDefault(); const action = activationCandidate; setActivationCandidate(null); if (action) runSensitive(action); }} data-testid="confirm-campaign-activation">Confirm activation status</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
      </AlertDialog>

      <AdminStepUpDialog open={Boolean(stepUpAction)} actionLabel={actionLabel} onCancel={() => setStepUpAction(null)} onVerified={retryStepUp} />
    </PageTransition>
  );
}
