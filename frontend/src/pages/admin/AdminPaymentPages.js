import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowDownToLine, ArrowUpFromLine, BookOpenCheck, CheckCircle2, RefreshCw, ScrollText, Settings2, ShieldCheck, Webhook } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PageTransition, EmptyState, formatChips } from "@/components/common";
import { adminPayments } from "@/lib/paymentApi";
import { errMsg } from "@/lib/api";
import { formatInrPaise, formatPaymentTime, paymentDisplayAt } from "@/lib/walletUtils";
import { PaymentStatus } from "@/pages/app/wallet/WalletBits";
import { useAuth } from "@/context/AuthContext";
import { ADMIN_PERMISSIONS, hasPermission } from "@/components/RouteGuards";
import { auditState, formatAuditValue, reconciliationSummary } from "@/lib/adminPaymentUtils";
import { useSearchParams } from "react-router-dom";
import AdminStepUpDialog, { requiresAdminStepUp } from "@/components/AdminStepUpDialog";

const ALL = "ALL";

function valueOf(item, ...keys) {
  for (const key of keys) if (item?.[key] !== undefined && item?.[key] !== null) return item[key];
  return "—";
}

function when(value) {
  return formatPaymentTime(value);
}

function useAdminRows(loader) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    try { setRows(await loader()); } catch (error) { toast.error(errMsg(error)); } finally { setLoading(false); }
  }, [loader]);
  useEffect(() => { load(); }, [load]);
  return { rows, loading, load, setRows };
}

function PageHead({ icon: Icon, title, subtitle, onRefresh, loading }) {
  return <div className="flex items-start justify-between gap-3"><div><h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight"><Icon className="h-5 w-5 text-primary" />{title}</h1><p className="mt-1 text-sm text-white/50">{subtitle}</p></div>{onRefresh && <Button type="button" variant="outline" size="sm" onClick={onRefresh} disabled={loading} className="rounded-xl border-white/15"><RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />Refresh</Button>}</div>;
}

function FilterBar({ query, setQuery, status, setStatus, statuses = [] }) {
  return <div className="grid gap-2 rounded-2xl border border-white/10 bg-card/45 p-3 sm:grid-cols-[1fr_180px]">
    <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search user, ID or reference" className="h-10 rounded-xl border-white/10 bg-white/5" />
    <Select value={status} onValueChange={setStatus}><SelectTrigger className="h-10 rounded-xl border-white/10 bg-white/5"><SelectValue /></SelectTrigger><SelectContent><SelectItem value={ALL}>All statuses</SelectItem>{statuses.map((item) => <SelectItem key={item} value={item}>{item.replaceAll("_", " ")}</SelectItem>)}</SelectContent></Select>
  </div>;
}

function filteredRows(rows, query, status, statusKey = "status") {
  const needle = query.trim().toLowerCase();
  return rows.filter((row) => (status === ALL || String(row[statusKey]).toUpperCase() === status) && (!needle || [row.id, row.user_id, row.user_email, row.provider_reference, row.provider_order_id, row.reference].some((value) => String(value || "").toLowerCase().includes(needle))));
}

function DataCard({ children }) { return <div className="overflow-hidden rounded-2xl border border-white/10 bg-card/55 divide-y divide-white/5">{children}</div>; }
function Empty({ icon, loading, noun }) { return loading ? <div className="h-40 rounded-2xl fg-shimmer border border-white/5" /> : <EmptyState icon={icon} title={`No ${noun}`} subtitle={`Matching ${noun} will appear here.`} />; }

export function AdminDeposits() {
  const { user } = useAuth();
  const [searchParams] = useSearchParams();
  const loader = useCallback(() => adminPayments.deposits(), []);
  const { rows, loading, load } = useAdminRows(loader);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState(searchParams.get("status")?.toUpperCase() || ALL);
  const [drafts, setDrafts] = useState({});
  const [acting, setActing] = useState("");
  const shown = useMemo(() => filteredRows(rows, query, status), [rows, query, status]);
  const canReview = hasPermission(user, ADMIN_PERMISSIONS.PAYMENTS_VIEW);
  const act = async (item, action) => {
    const note = (drafts[item.id] || "").trim();
    if (action === "reject" && !note) return toast.error("Enter a rejection reason first");
    const key = `${item.id}:${action}`;
    setActing(key);
    try {
      await adminPayments.resolveOperatorRequest(item.id, action, action === "reject" ? { reason: note } : { note: note || null });
      toast.success(`Buy request ${action === "approve" ? "approved" : "rejected"}`);
      setDrafts((current) => ({ ...current, [item.id]: "" }));
      await load();
    } catch (error) {
      toast.error(errMsg(error));
    } finally {
      setActing("");
    }
  };
  return <PageTransition className="space-y-4">
    <PageHead icon={ArrowDownToLine} title="Deposits" subtitle="Admin-reviewed funding requests and provider-created deposits. Operator requests credit the player balance only after approval." onRefresh={load} loading={loading} />
    <FilterBar query={query} setQuery={setQuery} status={status} setStatus={setStatus} statuses={["PENDING", "APPROVED", "REJECTED", "CREATED", "CREDITED", "FAILED", "EXPIRED", "REFUNDED"]} />
    {shown.length ? <div className="space-y-3">{shown.map((item) => {
      const operator = String(item.source || "").toUpperCase() === "ADMIN_REVIEW";
      const pending = operator && String(item.status || "").toUpperCase() === "PENDING";
      return <article key={item.id} className="rounded-2xl border border-white/10 bg-card/55 p-4" data-testid={operator ? `operator-deposit-${item.id}` : `deposit-${item.id}`}>
        <div className="grid gap-3 sm:grid-cols-[1.3fr_.8fr_.8fr_auto] sm:items-center">
          <div className="min-w-0"><p className="truncate text-sm font-semibold">{valueOf(item, "user_email", "user_phone", "user_id")}</p><p className="truncate font-mono text-[10px] text-white/35">{item.id}</p></div>
          <div><p className="tabular-nums font-bold text-primary">{formatInrPaise(item.amount_paise)}</p><p className="text-[10px] text-white/35">Balance credit {formatChips(item.chips)}</p></div>
          <div><p className="truncate font-mono text-[10px] text-white/55">{operator ? "Admin review" : valueOf(item, "provider_order_id", "provider_reference")}</p><p className="text-[10px] text-white/35">{when(item.created_at)}</p></div>
          <PaymentStatus status={item.status} />
        </div>
        {pending && canReview && <div className="mt-4 flex flex-col gap-2 border-t border-white/5 pt-3 sm:flex-row"><Input value={drafts[item.id] || ""} onChange={(event) => setDrafts((current) => ({ ...current, [item.id]: event.target.value }))} placeholder="Note or rejection reason" className="h-10 flex-1 rounded-xl border-white/10 bg-white/5" /><Button type="button" size="sm" data-testid={`approve-deposit-${item.id}`} onClick={() => act(item, "approve")} disabled={Boolean(acting)} className="h-10 rounded-xl">{acting === `${item.id}:approve` ? "Working…" : "Approve"}</Button><Button type="button" size="sm" variant="destructive" data-testid={`reject-deposit-${item.id}`} onClick={() => act(item, "reject")} disabled={Boolean(acting)} className="h-10 rounded-xl">{acting === `${item.id}:reject` ? "Working…" : "Reject"}</Button></div>}
      </article>;
    })}</div> : <Empty icon={ArrowDownToLine} loading={loading} noun="deposits" />}
  </PageTransition>;
}

const WITHDRAWAL_ACTIONS = {
  REQUESTED: [["approve", "Approve"], ["reject", "Reject"]],
  PENDING_ADMIN: [["approve", "Approve"], ["reject", "Reject"]],
  PENDING: [["approve", "Approve"], ["reject", "Reject"]],
  APPROVED: [["mark-submitted", "Mark submitted"]],
  SUBMITTED_TO_PROVIDER: [["mark-paid", "Mark paid"]],
  PROCESSING: [["mark-paid", "Mark paid"]],
};

export function AdminWithdrawals() {
  const { user } = useAuth();
  const [searchParams] = useSearchParams();
  const loader = useCallback(() => adminPayments.withdrawals(), []);
  const { rows, loading, load } = useAdminRows(loader);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState(searchParams.get("status")?.toUpperCase() || ALL);
  const [drafts, setDrafts] = useState({});
  const [acting, setActing] = useState("");
  const shown = useMemo(() => filteredRows(rows, query, status, "internal_status"), [rows, query, status]);
  const canApprove = hasPermission(user, ADMIN_PERMISSIONS.WITHDRAWALS_APPROVE);
  const canReviewOperator = hasPermission(user, ADMIN_PERMISSIONS.PAYMENTS_VIEW);
  const canMarkPaid = hasPermission(user, ADMIN_PERMISSIONS.WITHDRAWALS_MARK_PAID);
  const act = async (item, action) => {
    const key = `${item.id}:${action}`;
    const note = (drafts[item.id] || "").trim();
    if (action === "reject" && !note) return toast.error("Enter a rejection reason first");
    if (["mark-submitted", "mark-paid"].includes(action) && !note) return toast.error("Enter the provider or payment reference first");
    setActing(key);
    try {
      const operator = String(item.source || "").toUpperCase() === "ADMIN_REVIEW";
      if (operator && action === "retry-payout") {
        await adminPayments.retryOperatorPayout(item.id);
      } else if (operator) {
        await adminPayments.resolveOperatorRequest(item.id, action, action === "reject" ? { reason: note } : { note: note || null });
      } else {
        const body = action === "reject" ? { reason: note } : action === "approve" ? { note: note || null } : ["mark-submitted", "mark-paid"].includes(action) ? { provider_reference: note } : {};
        await adminPayments.withdrawalAction(item.id, action, body);
      }
      toast.success(`Withdrawal ${action.replaceAll("-", " ")}`);
      setDrafts((current) => ({ ...current, [item.id]: "" }));
      await load();
    } catch (error) {
      toast.error(errMsg(error));
    } finally {
      setActing("");
    }
  };
  return <PageTransition className="space-y-4">
    <PageHead icon={ArrowUpFromLine} title="Withdrawal queue" subtitle="Approve, reject and record provider settlement without exposing full bank data." onRefresh={load} loading={loading} />
    <FilterBar query={query} setQuery={setQuery} status={status} setStatus={setStatus} statuses={["PENDING", "REQUESTED", "PENDING_ADMIN", "APPROVED", "SUBMITTED_TO_PROVIDER", "PROCESSING", "PAID", "REJECTED", "FAILED", "CANCELLED"]} />
    {shown.length ? <div className="space-y-3">{shown.map((item) => {
      const internalStatus = String(item.internal_status || item.status).toUpperCase();
      const automatic = String(item.withdrawal_mode || "").toUpperCase() === "AUTOMATIC";
      const operator = String(item.source || "").toUpperCase() === "ADMIN_REVIEW";
      const permittedActions = (WITHDRAWAL_ACTIONS[internalStatus] || []).filter(([action]) => {
        if (operator) return ["approve", "reject"].includes(action) && canReviewOperator;
        if (automatic && ["mark-submitted", "mark-paid"].includes(action)) return false;
        return ["approve", "reject"].includes(action) ? canApprove : canMarkPaid;
      });
      return <article key={item.id} className="rounded-2xl border border-white/10 bg-card/55 p-4" data-testid={operator ? `operator-withdrawal-${item.id}` : `withdrawal-${item.id}`}>
        <div className="grid gap-3 sm:grid-cols-[1.2fr_.75fr_.8fr_auto] sm:items-center">
          <div className="min-w-0"><p className="truncate text-sm font-semibold">{valueOf(item, "user_email", "user_phone", "user_id")}</p><p className="truncate font-mono text-[10px] text-white/35">{item.id}</p></div>
          <div><p className="tabular-nums font-bold text-primary">{formatChips(item.amount_chips)} balance units</p><p className="text-[10px] text-white/35">{formatInrPaise(item.amount_paise ?? item.locked_amount_paise)}</p></div>
          <div><p className="text-xs text-white/60">{valueOf(item.bank_detail, "bank_name")}</p><p className="font-mono text-[10px] text-white/40">{valueOf(item.bank_detail, "account_number_masked", "masked_account_number")}</p>{item.bank_detail?.payout_identifier_masked && <p className="font-mono text-[10px] text-white/35">{item.bank_detail.payout_identifier_masked}</p>}</div>
          <PaymentStatus status={internalStatus} />
        </div>
        {item.provider_reference && <div className="mt-3 rounded-lg border border-white/10 bg-black/10 px-3 py-2"><p className="text-[10px] font-semibold uppercase tracking-wider text-white/35">Provider reference</p><p className="mt-0.5 break-all font-mono text-xs text-white/70">{item.provider_reference}</p></div>}
        {operator && item.payout_status && <p className="mt-3 rounded-lg border border-emerald-400/20 bg-emerald-400/8 px-3 py-2 text-[11px] text-emerald-100">SgPay payout: {item.payout_status}{item.payout_error ? ` · ${item.payout_error}` : ""}</p>}
        {operator && String(item.internal_status || "").toUpperCase() === "APPROVED" && String(item.payout_status || "").toUpperCase() !== "PAID" && canReviewOperator && (
          <Button type="button" size="sm" className="mt-3 h-10 rounded-xl" onClick={() => act(item, "retry-payout")} disabled={Boolean(acting)}>Retry SgPay payout</Button>
        )}
        {automatic && <p className="mt-3 rounded-lg border border-sky-400/20 bg-sky-400/8 px-3 py-2 text-[11px] text-sky-200">Automatic route · provider/outbox events control submission and settlement.</p>}
        {permittedActions.length > 0 && <div className="mt-4 flex flex-col gap-2 border-t border-white/5 pt-3 sm:flex-row"><Input value={drafts[item.id] || ""} onChange={(event) => setDrafts((current) => ({ ...current, [item.id]: event.target.value }))} placeholder={permittedActions.some(([action]) => action === "reject") ? "Reason (required to reject)" : "Provider/payment reference"} className="h-10 flex-1 rounded-xl border-white/10 bg-white/5" />{permittedActions.map(([action, label]) => <Button key={action} type="button" size="sm" variant={action === "reject" ? "destructive" : "default"} onClick={() => act(item, action)} disabled={Boolean(acting)} className="h-10 rounded-xl">{acting === `${item.id}:${action}` ? "Working…" : label}</Button>)}</div>}
      </article>;
    })}</div> : <Empty icon={ArrowUpFromLine} loading={loading} noun="withdrawals" />}
  </PageTransition>;
}

export function AdminPaymentEvents() {
  const { user } = useAuth();
  const [searchParams] = useSearchParams();
  const initialStatus = searchParams.get("attention") === "1" ? "ATTENTION" : searchParams.get("status")?.toUpperCase() || ALL;
  const [status, setStatus] = useState(initialStatus);
  const [query, setQuery] = useState("");
  const [acting, setActing] = useState("");
  const [bulkActing, setBulkActing] = useState(false);
  const loader = useCallback(() => adminPayments.events(), []);
  const { rows, loading, load } = useAdminRows(loader);
  const canReconcile = hasPermission(user, ADMIN_PERMISSIONS.PAYMENTS_RECONCILE);
  const needle = query.trim().toLowerCase();
  const shown = rows.filter((item) => {
    const itemStatus = String(item.status || "").toUpperCase();
    const statusMatch = status === ALL || (status === "ATTENTION" ? ["RETRY", "REVIEW_REQUIRED"].includes(itemStatus) : itemStatus === status);
    const queryMatch = !needle || [item.id, item.event_id, item.event_type, item.object_id, item.error_code].some((value) => String(value || "").toLowerCase().includes(needle));
    return statusMatch && queryMatch;
  });
  const reconcile = async (item) => {
    setActing(item.id);
    try {
      await adminPayments.reconcileEvent(item.id);
      toast.success("Payment event reconciled");
      await load();
    } catch (error) {
      toast.error(errMsg(error));
    } finally {
      setActing("");
    }
  };
  const reconcileAll = async () => {
    if (!window.confirm("Reconcile up to 50 pending financial records with the provider now?")) return;
    setBulkActing(true);
    try {
      const response = await adminPayments.reconcileAll(50);
      toast.success(`Reconciliation complete: ${reconciliationSummary(response)}`);
      await load();
    } catch (error) {
      toast.error(errMsg(error));
    } finally {
      setBulkActing(false);
    }
  };
  return <PageTransition className="space-y-4">
    <PageHead icon={Webhook} title="Provider events" subtitle="Webhook delivery, verification and reconciliation status. Payload secrets are never displayed." onRefresh={load} loading={loading || bulkActing} />
    {canReconcile && <div className="flex justify-end"><Button type="button" variant="outline" onClick={reconcileAll} disabled={loading || bulkActing || Boolean(acting)} className="rounded-xl border-primary/30 text-primary"><RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${bulkActing ? "animate-spin" : ""}`} />{bulkActing ? "Reconciling records…" : "Reconcile pending records"}</Button></div>}
    <FilterBar query={query} setQuery={setQuery} status={status} setStatus={setStatus} statuses={["ATTENTION", "RECEIVED", "RETRY", "REVIEW_REQUIRED", "PROCESSED"]} />
    {shown.length ? <DataCard>{shown.map((item) => {
      const itemStatus = String(item.status || "").toUpperCase();
      const actionable = canReconcile && ["RETRY", "REVIEW_REQUIRED"].includes(itemStatus);
      return <div key={item.id} className="grid gap-2 p-4 sm:grid-cols-[1.1fr_1fr_.9fr_auto] sm:items-center"><div><p className="text-sm font-semibold">{valueOf(item, "event_type", "type")}</p><p className="font-mono text-[10px] text-white/35">{item.id}</p></div><div><p className="truncate font-mono text-[11px] text-white/55">{valueOf(item, "event_id", "provider_reference")}</p><p className="truncate font-mono text-[10px] text-white/35">object {valueOf(item, "object_id")}</p></div><div><p className="text-[11px] text-white/45">{when(valueOf(item, "received_at", "created_at"))}</p>{item.error_code && <p className="mt-0.5 font-mono text-[10px] text-red-300">{item.error_code}</p>}</div><div className="flex flex-col items-end gap-2"><PaymentStatus status={itemStatus} />{actionable && <Button type="button" size="sm" variant="outline" onClick={() => reconcile(item)} disabled={Boolean(acting) || bulkActing} className="h-8 rounded-lg border-primary/30 text-xs text-primary">{acting === item.id ? "Reconciling…" : "Reconcile"}</Button>}</div></div>;
    })}</DataCard> : <Empty icon={Webhook} loading={loading} noun="provider events" />}
  </PageTransition>;
}

export function AdminWalletLedger() {
  const loader = useCallback(() => adminPayments.ledger(), []); const { rows, loading, load } = useAdminRows(loader);
  return <PageTransition className="space-y-4"><PageHead icon={BookOpenCheck} title="Wallet ledger" subtitle="Immutable balance movements and their business references." onRefresh={load} loading={loading} />{rows.length ? <DataCard>{rows.map((item) => <div key={item.id} className="grid gap-2 p-4 sm:grid-cols-[1.1fr_.75fr_.75fr_1fr] sm:items-center"><div><p className="truncate text-sm font-semibold">{valueOf(item, "user_email", "user_phone", "user_id")}</p><p className="font-mono text-[10px] text-white/35">{item.id}</p></div><div><p className={`tabular-nums font-bold ${Number(item.delta_chips ?? item.amount_chips) >= 0 ? "text-emerald-300" : "text-red-300"}`}>{Number(item.delta_chips ?? item.amount_chips) > 0 ? "+" : ""}{formatChips(item.delta_chips ?? item.amount_chips)}</p><p className="text-[10px] text-white/35">balance {formatChips(item.balance_after)}</p></div><p className="text-xs text-white/60">{valueOf(item, "bucket", "entry_type", "type")}</p><div><p className="truncate font-mono text-[10px] text-white/50">{valueOf(item, "operation_id", "reference", "reference_id")}</p><p className="text-[10px] text-white/35">{when(item.created_at)}</p></div></div>)}</DataCard> : <Empty icon={BookOpenCheck} loading={loading} noun="ledger entries" />}</PageTransition>;
}

export function AdminPaymentAudit() {
  const loader = useCallback(() => adminPayments.audit(), []);
  const { rows, loading, load } = useAdminRows(loader);
  return <PageTransition className="space-y-4">
    <PageHead icon={ScrollText} title="Administrative audit" subtitle="Administrative approvals, rejections, wallet actions, and control changes." onRefresh={load} loading={loading} />
    {rows.length ? <div className="space-y-3">{rows.map((item) => {
      const state = auditState(item);
      const target = [item.target_type, item.target_id].filter(Boolean).join(" · ") || "—";
      return <article key={item.id} className="rounded-2xl border border-white/10 bg-card/55 p-4">
        <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-start">
          <div><p className="text-sm font-semibold">{valueOf(item, "action", "event_type")}</p><p className="mt-0.5 font-mono text-[10px] text-white/35">{item.id}</p></div>
          <div><p className="text-[10px] font-semibold uppercase tracking-wider text-white/35">Target</p><p className="mt-0.5 break-all font-mono text-xs text-white/65">{target}</p></div>
          <div className="sm:text-right"><p className="truncate text-xs text-white/60">{valueOf(item, "actor_email", "actor_id", "admin_id")}</p><p className="mt-0.5 text-[10px] text-white/35">{when(item.created_at)}</p></div>
        </div>
        <div className="mt-3 grid gap-2 border-t border-white/5 pt-3 sm:grid-cols-2">
          <AuditValue label="Before" value={state.before} />
          <AuditValue label="After" value={state.after} />
        </div>
        {(item.reason || item.description) && <p className="mt-3 text-xs leading-relaxed text-white/55"><span className="font-semibold text-white/70">Reason:</span> {valueOf(item, "reason", "description")}</p>}
      </article>;
    })}</div> : <Empty icon={ScrollText} loading={loading} noun="audit events" />}
  </PageTransition>;
}

function AuditValue({ label, value }) {
  return <div className="min-w-0 rounded-xl border border-white/8 bg-black/10 p-3"><p className="text-[10px] font-semibold uppercase tracking-wider text-white/35">{label}</p><p className="mt-1 break-words font-mono text-[11px] leading-relaxed text-white/60">{formatAuditValue(value)}</p></div>;
}

export function AdminKyc() {
  const { user } = useAuth();
  const [searchParams] = useSearchParams();
  const [status, setStatus] = useState(searchParams.get("status")?.toUpperCase() || ALL);
  const [query, setQuery] = useState("");
  const [drafts, setDrafts] = useState({});
  const [acting, setActing] = useState("");
  const [pendingSensitiveAction, setPendingSensitiveAction] = useState(null);
  const loader = useCallback(() => adminPayments.kyc(status === ALL ? undefined : status), [status]);
  const { rows, loading, load } = useAdminRows(loader);
  const canReview = hasPermission(user, ADMIN_PERMISSIONS.KYC_REVIEW);
  const needle = query.trim().toLowerCase();
  const shown = rows.filter((item) => !needle || [item.id, item.email_masked, item.phone_masked, item.country].some((value) => String(value || "").toLowerCase().includes(needle)));

  const performSensitiveAction = async (action) => {
    if (action.kind === "KYC") {
      await adminPayments.reviewKyc(action.playerId, action.decision, action.reason);
      toast.success(`KYC marked ${action.decision.toLowerCase()}`);
    } else if (action.kind === "VERIFY_MOBILE") {
      await adminPayments.reviewPlayerMobile(action.playerId, true, action.reason);
      toast.success("Mobile verification recorded and player notified");
    }
    setDrafts((current) => ({ ...current, [action.playerId]: "" }));
    await load();
  };

  const runSensitiveAction = async (action, offerStepUp = true) => {
    setActing(action.key);
    try {
      await performSensitiveAction(action);
    } catch (error) {
      if (offerStepUp && requiresAdminStepUp(error)) {
        // The rejected request made no mutation. Preserve its exact player,
        // decision and audit reason while the admin completes password + OTP,
        // then retry it once.
        setPendingSensitiveAction(action);
      } else {
        toast.error(errMsg(error));
      }
    } finally {
      setActing("");
    }
  };

  const retryPendingSensitiveAction = async () => {
    const action = pendingSensitiveAction;
    if (!action) return;
    await runSensitiveAction(action, false);
  };

  const review = async (player, decision) => {
    const reason = String(drafts[player.id] || "").trim();
    if (reason.length < 5) return toast.error("Enter a clear review reason");
    await runSensitiveAction({
      kind: "KYC", playerId: player.id, decision, reason,
      key: `${player.id}:${decision}`,
    });
  };

  const verificationAction = async (player, action) => {
    const reason = String(drafts[player.id] || "").trim();
    if (reason.length < 5) return toast.error("Enter a clear verification reason");
    if (action === "VERIFY_MOBILE") {
      await runSensitiveAction({
        kind: action, playerId: player.id, reason,
        key: `${player.id}:${action}`,
      });
      return;
    }
    const key = `${player.id}:${action}`;
    setActing(key);
    try {
      if (action === "REQUEST_MOBILE") await adminPayments.requestPlayerVerification(player.id, "MOBILE", reason);
      toast.success("Verification action recorded and player notified");
      setDrafts((current) => ({ ...current, [player.id]: "" }));
      await load();
    } catch (error) { toast.error(errMsg(error)); } finally { setActing(""); }
  };

  return <PageTransition className="space-y-4">
    <PageHead icon={ShieldCheck} title="Player verification" subtitle="Review contact verification and KYC status." onRefresh={load} loading={loading} />
    <FilterBar query={query} setQuery={setQuery} status={status} setStatus={setStatus} statuses={["UNVERIFIED", "PENDING", "VERIFIED", "REJECTED"]} />
    {shown.length ? <div className="space-y-3">{shown.map((player) => <article key={player.id} className="rounded-2xl border border-white/10 bg-card/55 p-4">
      <div className="grid gap-3 sm:grid-cols-[1.2fr_.8fr_auto] sm:items-center">
        <div className="min-w-0"><p className="truncate text-sm font-semibold">{player.email_masked || player.phone_masked || "Masked player"}</p><p className="truncate font-mono text-[10px] text-white/35">{player.id}</p></div>
        <div><p className="text-xs text-white/60">{player.phone_masked || "No mobile"}</p><p className={`text-[10px] ${player.contact_verified ? "text-emerald-300" : "text-amber-300"}`}>{player.mobile_manually_verified ? "Mobile admin reviewed" : player.contact_verified ? "Contact verified" : player.mobile_verification_status === "REQUESTED" ? "Mobile requested" : "Mobile not verified"}</p></div>
        <PaymentStatus status={player.kyc_status} />
      </div>
      {canReview && <div className="mt-4 space-y-2 border-t border-white/5 pt-3">
        <Input value={drafts[player.id] || ""} onChange={(event) => setDrafts((current) => ({ ...current, [player.id]: event.target.value }))} placeholder="Verification reason / instructions (required)" minLength={5} maxLength={500} className="h-10 rounded-xl border-white/10 bg-white/5" />
        <div className="flex flex-wrap gap-2">
          {!player.contact_verified && player.phone_available && <Button type="button" size="sm" variant="outline" onClick={() => verificationAction(player, "REQUEST_MOBILE")} disabled={Boolean(acting)}>Request mobile OTP</Button>}
          {!player.contact_verified && player.phone_available && <Button type="button" size="sm" onClick={() => verificationAction(player, "VERIFY_MOBILE")} disabled={Boolean(acting)}>Approve mobile manually</Button>}
          <Button type="button" size="sm" onClick={() => review(player, "VERIFIED")} disabled={Boolean(acting)}>Verify KYC</Button>
          <Button type="button" size="sm" variant="destructive" onClick={() => review(player, "REJECTED")} disabled={Boolean(acting)}>Reject KYC</Button>
        </div>
      </div>}
    </article>)}</div> : <Empty icon={ShieldCheck} loading={loading} noun="verification records" />}
    <AdminStepUpDialog
      open={Boolean(pendingSensitiveAction)}
      actionLabel={pendingSensitiveAction?.kind === "KYC" ? "completing this KYC decision" : "recording this manual verification"}
      onCancel={() => setPendingSensitiveAction(null)}
      onVerified={retryPendingSensitiveAction}
    />
  </PageTransition>;
}

export function AdminPaymentSettings() {
  const [settings, setSettings] = useState(null); const [nextMode, setNextMode] = useState("MANUAL"); const [reason, setReason] = useState(""); const [busy, setBusy] = useState(false);
  const load = useCallback(async () => { try { const result = await adminPayments.settings(); setSettings(result); setNextMode(result.withdrawal_mode || "MANUAL"); } catch (error) { toast.error(errMsg(error)); } }, []);
  useEffect(() => { load(); }, [load]);
  const automaticAvailable = Boolean(settings?.financial?.ready && settings?.financial?.features?.real_money && settings?.financial?.features?.withdrawals && settings?.financial?.features?.automatic_withdrawals);
  const save = async (event) => { event.preventDefault(); if (nextMode === "AUTOMATIC" && !automaticAvailable) return toast.error("Automatic withdrawals are not production-ready"); if (reason.trim().length < 5) return toast.error("Enter a clear reason for this control change"); setBusy(true); try { await adminPayments.setWithdrawalMode(nextMode, reason.trim()); toast.success("Withdrawal mode updated and audited"); setReason(""); await load(); } catch (error) { toast.error(errMsg(error)); } finally { setBusy(false); } };
  return <PageTransition className="space-y-4"><PageHead icon={Settings2} title="Payment controls" subtitle="Global withdrawal routing. Only authorised Super Admins may change this control." /><div className="rounded-2xl border border-primary/25 bg-primary/5 p-4"><p className="text-xs text-white/45">Current withdrawal mode</p><p className="mt-1 text-2xl font-extrabold text-primary">{settings?.withdrawal_mode || "Loading…"}</p><p className="mt-2 text-xs leading-relaxed text-white/55">MANUAL keeps new requests in the admin queue. AUTOMATIC submits eligible new requests through the configured provider adapter. Changing to MANUAL does not cancel payouts already submitted.</p></div>{settings && !automaticAvailable && <div className="flex items-start gap-2.5 rounded-2xl border border-amber-300/25 bg-amber-300/8 p-4 text-xs leading-relaxed text-amber-100"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" /><span><strong>Automatic withdrawals are locked.</strong> Provider approval, production credentials, feature flags and financial readiness checks must pass before this mode can be selected.</span></div>}<form onSubmit={save} className="space-y-4 rounded-2xl border border-white/10 bg-card/55 p-4"><div><p className="font-semibold">Change withdrawal mode</p><p className="mt-1 flex items-center gap-1.5 text-[11px] text-amber-300"><AlertTriangle className="h-3.5 w-3.5" />The server enforces recent re-authentication/2FA and records an immutable audit event.</p></div><Select value={nextMode} onValueChange={setNextMode}><SelectTrigger className="h-12 rounded-xl border-white/12 bg-white/5"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="MANUAL">MANUAL — admin approval queue</SelectItem><SelectItem value="AUTOMATIC" disabled={!automaticAvailable}>AUTOMATIC — provider submission</SelectItem></SelectContent></Select><Input value={reason} onChange={(event) => setReason(event.target.value)} required minLength={5} maxLength={240} placeholder="Reason for the change (required)" className="h-12 rounded-xl border-white/12 bg-white/5" /><Button type="submit" disabled={busy || !settings || nextMode === settings.withdrawal_mode || (nextMode === "AUTOMATIC" && !automaticAvailable)} className="h-12 w-full rounded-xl font-bold"><CheckCircle2 className="mr-2 h-4 w-4" />{busy ? "Applying…" : "Apply audited change"}</Button></form></PageTransition>;
}
