import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowUpRight,
  ChevronRight,
  CircleAlert,
  Clock3,
  Database,
  FileCheck2,
  Landmark,
  Receipt,
  RefreshCw,
  ShieldCheck,
  UserRoundCheck,
  Users,
  Wrench,
} from "lucide-react";
import { api } from "@/lib/api";
import { formatInrPaise } from "@/lib/walletUtils";

const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

function chips(value) {
  return new Intl.NumberFormat("en-IN").format(number(value));
}

function when(value) {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}

function Panel({ title, description, action, children, className = "" }) {
  return (
    <section className={`crm-panel ${className}`}>
      <header className="crm-panel-header">
        <div>
          <h2>{title}</h2>
          {description && <p>{description}</p>}
        </div>
        {action}
      </header>
      <div className="crm-panel-body">{children}</div>
    </section>
  );
}

function TextLink({ children, onClick }) {
  return (
    <button type="button" className="crm-text-link" onClick={onClick}>
      {children}<ArrowUpRight size={13} />
    </button>
  );
}

async function loadDashboard() {
  try {
    const { data } = await api.get("/admin/dashboard");
    return { data, source: "dashboard" };
  } catch (_error) {
    // Older API builds only expose /admin/stats. Compose the same shape so the
    // overview keeps working without inventing any numbers.
    const { data: stats } = await api.get("/admin/stats");
    return {
      source: "stats",
      data: {
        metrics: [
          { label: "Registered players", value: number(stats.total_users), note: "Platform database", to: "/Admin/users" },
          { label: "Active players", value: number(stats.active_users), note: "Approved accounts", to: "/Admin/users?status=ACTIVE" },
          { label: "Pending review", value: number(stats.pending_users), note: "Manual approval queue", to: "/Admin/users?status=PENDING" },
          { label: "Live games", value: number(stats.enabled_games), suffix: `/${number(stats.total_games)}`, note: "Catalog availability", to: "/Admin/games" },
        ],
        players: {
          total: number(stats.total_users), active: number(stats.active_users),
          pending: number(stats.pending_users), suspended: number(stats.suspended_users),
        },
        cash_movement: { deposits: { amount_paise: 0, count: 0 }, withdrawals: { amount_paise: 0, count: 0 }, net_paise: 0, recent: [] },
        action_queue: number(stats.pending_users) > 0
          ? [{ key: "player_approvals", label: "Player approvals", count: number(stats.pending_users), oldest: null, severity: "critical", to: "/Admin/users?status=PENDING" }]
          : [],
        distributors: { count: 0, top: [] },
        recent_transactions: [],
        audit_activity: [],
        maintenance_mode: Boolean(stats.maintenance_mode),
      },
    };
  }
}

export default function AdminDashboard() {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const result = await loadDashboard();
      setData(result.data);
    } catch (_error) {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const result = await loadDashboard();
        if (active) setData(result.data);
      } catch (_error) {
        if (active) setLoadError(true);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, []);

  const metrics = useMemo(() => data?.metrics || [], [data]);
  const queue = useMemo(() => data?.action_queue || [], [data]);
  const cash = data?.cash_movement || {};
  const cashTransactions = cash?.recent || [];
  const distributors = data?.distributors || { count: 0, top: [] };
  const transactions = data?.recent_transactions || [];
  const audit = data?.audit_activity || [];
  const hasCashMovement = number(cash?.deposits?.count) > 0 || number(cash?.withdrawals?.count) > 0;

  if (loading) {
    return (
      <div className="crm-page-stack" aria-label="Loading operations overview">
        <div className="crm-page-header">
          <div className="crm-page-header-copy">
            <span className="crm-page-context">Platform operations</span>
            <h1>Operations overview</h1>
          </div>
        </div>
        <div className="metric-strip">
          {[0, 1, 2, 3, 4, 5].map((key) => <div className="metric-cell" key={key}><span className="skeleton h-3 w-24" /><span className="skeleton h-7 w-16" /></div>)}
        </div>
      </div>
    );
  }

  return (
    <div className="crm-page-stack" data-testid="admin-dashboard">
      <div className="crm-page-header">
        <div className="crm-page-header-copy">
          <span className="crm-page-context">Platform operations</span>
          <h1>Operations overview</h1>
          <p>Financial movement, player activity, and queues requiring attention across the platform.</p>
        </div>
        <div className="crm-page-actions">
          <span className="source-badge">
            <span className="source-indicator" />
            {loadError ? "Last known state" : "Live service"}
          </span>
          <button type="button" className="icon-button" aria-label="Refresh dashboard" onClick={load}>
            <RefreshCw size={15} />
          </button>
        </div>
      </div>

      {loadError && (
        <div className="rounded-xl border border-amber-400/25 bg-amber-400/8 p-4">
          <p className="text-sm">The live dashboard summary is temporarily unavailable. Refresh to retry.</p>
        </div>
      )}

      {data?.maintenance_mode && (
        <button data-testid="admin-maintenance-banner" onClick={() => navigate("/Admin/settings")} className="w-full flex items-center justify-between rounded-2xl border border-[hsl(var(--magenta)/0.4)] bg-[hsl(var(--magenta)/0.12)] p-4 text-left">
          <span className="flex items-center gap-2.5 text-sm font-semibold text-[hsl(var(--magenta))]">
            <Wrench className="h-4 w-4" /> Maintenance mode is on — players are blocked from the app
          </span>
          <ChevronRight className="h-4 w-4" />
        </button>
      )}

      <div className="metric-strip">
        {metrics.map((metric) => (
          <button key={metric.label} type="button" className="metric-cell" data-testid="admin-kpi-card" onClick={() => metric.to && navigate(metric.to)}>
            <span className="metric-label">{metric.label}</span>
            <strong className="metric-value">{metric.value}{metric.suffix || ""}</strong>
            <span className="metric-delta">
              <Database size={11} />
              {metric.note}
            </span>
          </button>
        ))}
      </div>

      <div className="dashboard-primary-grid">
        <Panel
          title="Cash movement"
          description="Settled deposits and payouts across the platform."
          action={<TextLink onClick={() => navigate("/Admin/reports")}>Open report</TextLink>}
        >
          {hasCashMovement ? (
            <div className="compact-list" data-testid="cash-movement">
              <div className="compact-row"><span className="transaction-glyph"><Landmark size={15} /></span><span className="compact-main"><strong>Deposits credited</strong><small>{chips(cash.deposits.count)} settled</small></span><strong>{formatInrPaise(cash.deposits.amount_paise)}</strong></div>
              <div className="compact-row"><span className="transaction-glyph"><Receipt size={15} /></span><span className="compact-main"><strong>Withdrawals paid</strong><small>{chips(cash.withdrawals.count)} settled</small></span><strong>{formatInrPaise(cash.withdrawals.amount_paise)}</strong></div>
              <div className="compact-row"><span className="transaction-glyph"><Database size={15} /></span><span className="compact-main"><strong>Net movement</strong><small>Deposits minus payouts</small></span><strong>{formatInrPaise(cash.net_paise)}</strong></div>
              {cashTransactions.length > 0 && <div className="cash-movement-history" data-testid="cash-movement-transactions">
                <div className="cash-movement-history-label">Recent transactions</div>
                {cashTransactions.map((item) => {
                  const deposit = String(item.direction || "").toUpperCase() === "DEPOSIT";
                  const source = String(item.source || "Payment provider").replaceAll("_", " ");
                  const reference = item.reference ? ` · Ref ${item.reference}` : "";
                  return <div className="compact-row" key={`${item.direction}-${item.id}`}>
                    <span className="transaction-glyph">{deposit ? <Landmark size={15} /> : <Receipt size={15} />}</span>
                    <span className="compact-main"><strong>{deposit ? "Deposit credited" : "Withdrawal paid"}</strong><small>{when(item.occurred_at)} · {source}{reference}</small></span>
                    <strong className={`cash-movement-amount ${deposit ? "is-credit" : "is-debit"}`}>{deposit ? "+" : "−"}{formatInrPaise(item.amount_paise)}</strong>
                  </div>;
                })}
              </div>}
            </div>
          ) : (
            <div className="empty-state-compact" data-testid="cash-movement-empty"><span><Landmark size={19} /></span><h3>No cash movement</h3><p>Settled deposits and payouts will appear here when the platform records them.</p></div>
          )}
        </Panel>

        <Panel
          title="Action queue"
          description="Sorted by operational risk"
          action={queue.length ? <span className="crm-panel-meta">{queue.reduce((total, item) => total + number(item.count), 0)} open</span> : null}
        >
          {queue.length ? (
            <div className="queue-list" data-testid="action-queue">
              {queue.map((item) => (
                <button type="button" className="queue-row" onClick={() => item.to && navigate(item.to)} key={item.key || item.label}>
                  <span className={`queue-severity severity-${item.severity || "normal"}`}><CircleAlert size={15} /></span>
                  <span className="queue-copy"><strong>{item.label}</strong><small>{item.oldest ? `Oldest ${when(item.oldest)}` : "Awaiting operator action"}</small></span>
                  <span className="queue-count">{item.count}</span>
                  <ChevronRight size={15} />
                </button>
              ))}
            </div>
          ) : (
            <div className="empty-state-compact" data-testid="action-queue-empty"><span><FileCheck2 size={19} /></span><h3>No queue items</h3><p>Operational queue items will appear here when the dashboard service returns them.</p></div>
          )}
        </Panel>
      </div>

      <div className="dashboard-secondary-grid">
        <Panel title="Active players" description="Live account state" action={<TextLink onClick={() => navigate("/Admin/users?status=ACTIVE")}>View players</TextLink>}>
          <div className="compact-list">
            <div className="compact-row"><span className="transaction-glyph"><Users size={15} /></span><span className="compact-main"><strong>Approved accounts</strong><small>Eligible to sign in and play</small></span><strong>{chips(data?.players?.active)}</strong></div>
            <div className="compact-row"><span className="transaction-glyph"><UserRoundCheck size={15} /></span><span className="compact-main"><strong>Awaiting verification</strong><small>Admin review required</small></span><strong>{chips(data?.players?.pending)}</strong></div>
            <div className="compact-row"><span className="transaction-glyph"><ShieldCheck size={15} /></span><span className="compact-main"><strong>Restricted accounts</strong><small>Suspended by platform controls</small></span><strong>{chips(data?.players?.suspended)}</strong></div>
          </div>
        </Panel>

        <Panel title="Distributor performance" description="Attributed activity and commission" action={<TextLink onClick={() => navigate("/Admin/distributors")}>Compare</TextLink>}>
          {distributors.top && distributors.top.length ? (
            <div className="compact-list" data-testid="distributor-performance">
              {distributors.top.map((item) => (
                <div className="compact-row" key={item.distributor_id}>
                  <span className="transaction-glyph"><Database size={15} /></span>
                  <span className="compact-main"><strong>{item.name}</strong><small>Revenue {chips(item.ngr_chips)} · turnover {chips(item.turnover_chips)}</small></span>
                  <strong>{chips(item.commission_chips)}</strong>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-state-compact" data-testid="distributor-performance-empty"><span><Database size={19} /></span><h3>No distributor activity</h3><p>Distributor revenue and commission will appear here when the ledger records them.</p></div>
          )}
        </Panel>
      </div>

      <div className="dashboard-bottom-grid">
        <Panel title="Recent transactions" action={<TextLink onClick={() => navigate("/Admin/wallet-ledger")}>View all</TextLink>}>
          {transactions.length ? (
            <div className="compact-list" data-testid="recent-transactions">
              {transactions.map((item) => (
                <div className="compact-row" key={item.id}>
                  <span className="transaction-glyph">{String(item.type || "?").slice(0, 1)}</span>
                  <span className="compact-main"><strong>{item.note || item.kind || item.type}</strong><small>{when(item.created_at)}</small></span>
                  <strong>{item.type === "DEBIT" ? "-" : "+"}{chips(item.amount)}</strong>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-state-compact" data-testid="recent-transactions-empty"><span><Receipt size={19} /></span><h3>No recent transactions</h3><p>Wallet movements will appear here as players transact.</p></div>
          )}
        </Panel>

        <Panel title="Audit activity" action={<TextLink onClick={() => navigate("/Admin/security")}>Open audit log</TextLink>}>
          {audit.length ? (
            <div className="timeline-list" data-testid="audit-activity">
              {audit.map((item) => (
                <div className="timeline-row" key={item.id}>
                  <span className="timeline-marker" />
                  <div><strong>{item.event_type || "Activity"}</strong><small>{[item.target_type, item.actor].filter(Boolean).join(" · ") || "Recorded"}{item.created_at ? ` · ${when(item.created_at)}` : ""}</small></div>
                </div>
              ))}
            </div>
          ) : (
            <div className="timeline-list" data-testid="audit-activity-empty">
              <div className="timeline-row"><span className="timeline-marker" /><div><strong>Wallet ledger is protected</strong><small>Mutations require authorized server actions</small></div></div>
              <div className="timeline-row"><span className="timeline-marker" /><div><strong>Last refreshed</strong><small><Clock3 size={10} style={{ display: "inline", marginRight: 4 }} />{new Date().toLocaleString()}</small></div></div>
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
