import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowUpRight,
  ChevronRight,
  CircleAlert,
  Clock3,
  Database,
  FileCheck2,
  RefreshCw,
  ShieldCheck,
  UserRoundCheck,
  Users,
  WalletCards,
  Wrench,
} from "lucide-react";
import { api } from "@/lib/api";
import { formatChips } from "@/components/common";

const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;

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

export default function AdminDashboard() {
  const navigate = useNavigate();
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  const load = async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const base = await api.get("/admin/stats");
      setStats(base.data);
    } catch (_error) {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let active = true;
    const run = async () => {
      try {
        const base = await api.get("/admin/stats");
        if (active) setStats(base.data);
      } catch (_error) {
        if (active) setLoadError(true);
      } finally {
        if (active) setLoading(false);
      }
    };
    run();
    return () => { active = false; };
  }, []);

  const metrics = useMemo(() => {
    const data = stats || {};
    return [
      { label: "Registered players", value: number(data.total_users), note: "Platform database", to: "/Admin/users" },
      { label: "Active players", value: number(data.active_users), note: "Approved accounts", to: "/Admin/users?status=ACTIVE" },
      { label: "Pending review", value: number(data.pending_users), note: "Manual approval queue", to: "/Admin/users?status=PENDING", trend: true },
      { label: "Chip requests", value: number(data.pending_chip_requests), note: "Awaiting operator action", to: "/Admin/chip-requests", trend: true },
      { label: "Live games", value: `${number(data.enabled_games)}/${number(data.total_games)}`, note: "Catalog availability", to: "/Admin/games" },
      { label: "Virtual chips", value: formatChips(number(data.held_chips)), note: "No cash value", to: "/Admin/chip-requests" },
    ];
  }, [stats]);

  const queues = useMemo(() => {
    const data = stats || {};
    const items = [
      { label: "Player approvals", count: number(data.pending_users), oldest: "Manual review required", to: "/Admin/users?status=PENDING", severity: "critical" },
      { label: "Chip requests", count: number(data.pending_chip_requests), oldest: "Operator decision required", to: "/Admin/chip-requests", severity: "warning" },
    ];
    return items.filter((item) => item.count > 0);
  }, [stats]);

  const chartValues = useMemo(() => {
    const data = stats || {};
    const raw = [
      number(data.pending_chip_requests),
      number(data.active_users),
      number(data.pending_users),
      number(data.enabled_games),
      number(data.total_users),
    ];
    const max = Math.max(...raw, 1);
    return raw.map((value) => Math.max(8, Math.round((value / max) * 88)));
  }, [stats]);

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
    <div className="crm-page-stack">
      <div className="crm-page-header">
        <div className="crm-page-header-copy">
          <span className="crm-page-context">Platform operations</span>
          <h1>Operations overview</h1>
          <p>Player activity, virtual-chip controls, distributor attribution, and queues requiring attention.</p>
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

      {stats?.maintenance_mode && (
        <button data-testid="admin-maintenance-banner" onClick={() => navigate("/Admin/settings")} className="w-full flex items-center justify-between rounded-2xl border border-[hsl(var(--magenta)/0.4)] bg-[hsl(var(--magenta)/0.12)] p-4 text-left">
          <span className="flex items-center gap-2.5 text-sm font-semibold text-[hsl(var(--magenta))]">
            <Wrench className="h-4 w-4" /> Maintenance mode is on — players are blocked from the app
          </span>
          <ChevronRight className="h-4 w-4" />
        </button>
      )}

      <div className="metric-strip">
        {metrics.map((metric) => (
          <button key={metric.label} type="button" className="metric-cell" data-testid="admin-kpi-card" onClick={() => navigate(metric.to)}>
            <span className="metric-label">{metric.label}</span>
            <strong className="metric-value">{metric.value}</strong>
            <span className={`metric-delta ${metric.trend && number(metric.value) > 0 ? "metric-down" : ""}`}>
              {metric.trend && number(metric.value) > 0 ? <CircleAlert size={11} /> : <Database size={11} />}
              {metric.note}
            </span>
          </button>
        ))}
      </div>

      <div className="dashboard-primary-grid">
        <Panel
          title="Platform activity"
          description="Current operational volume from the live service."
          action={<TextLink onClick={() => navigate("/Admin/reports")}>Open report</TextLink>}
        >
          <div className="chart-stage" aria-label="Platform activity chart">
            <div className="chart-grid" />
            <div className="chart-bars">
              {chartValues.map((height, index) => (
                <div className="chart-bar-group" key={index}>
                  <span className="chart-bar" style={{ height: `${height}%` }} />
                  <span className="chart-bar alt" style={{ height: `${Math.max(7, height * .65)}%` }} />
                </div>
              ))}
            </div>
            <div className="chart-labels"><span>Requests</span><span>Active</span><span>Pending</span><span>Games</span><span>Players</span></div>
          </div>
        </Panel>

        <Panel
          title="Action queue"
          description="Sorted by operational risk"
          action={queues.length ? <span className="crm-panel-meta">{queues.reduce((total, item) => total + item.count, 0)} open</span> : null}
        >
          {queues.length ? (
            <div className="queue-list">
              {queues.map((item) => (
                <button type="button" className="queue-row" onClick={() => navigate(item.to)} key={item.label}>
                  <span className={`queue-severity severity-${item.severity}`}><CircleAlert size={15} /></span>
                  <span className="queue-copy"><strong>{item.label}</strong><small>{item.oldest}</small></span>
                  <span className="queue-count">{item.count}</span>
                  <ChevronRight size={15} />
                </button>
              ))}
            </div>
          ) : (
            <div className="empty-state-compact"><span><FileCheck2 size={19} /></span><h3>No queue items</h3><p>Operational queue items will appear here when the live service returns them.</p></div>
          )}
        </Panel>
      </div>

      <div className="dashboard-secondary-grid">
        <Panel title="Active players" description="Live account state" action={<TextLink onClick={() => navigate("/Admin/users?status=ACTIVE")}>View players</TextLink>}>
          <div className="compact-list">
            <div className="compact-row"><span className="transaction-glyph"><Users size={15} /></span><span className="compact-main"><strong>Approved accounts</strong><small>Eligible to sign in and play</small></span><strong>{number(stats?.active_users)}</strong></div>
            <div className="compact-row"><span className="transaction-glyph"><UserRoundCheck size={15} /></span><span className="compact-main"><strong>Awaiting verification</strong><small>Admin review required</small></span><strong>{number(stats?.pending_users)}</strong></div>
            <div className="compact-row"><span className="transaction-glyph"><ShieldCheck size={15} /></span><span className="compact-main"><strong>Restricted accounts</strong><small>Suspended by platform controls</small></span><strong>{number(stats?.suspended_users)}</strong></div>
          </div>
        </Panel>

        <Panel title="Distributor performance" description="Attributed platform activity" action={<TextLink onClick={() => navigate("/Admin/distributors")}>Compare</TextLink>}>
          <div className="compact-list">
            <div className="compact-row"><span className="transaction-glyph"><Database size={15} /></span><span className="compact-main"><strong>Attribution source</strong><small>Created with each player registration</small></span><strong>Live</strong></div>
            <div className="compact-row"><span className="transaction-glyph"><WalletCards size={15} /></span><span className="compact-main"><strong>Commission ledger</strong><small>Fixed-rate distributor evidence</small></span><strong>Synced</strong></div>
            <div className="compact-row"><span className="transaction-glyph"><FileCheck2 size={15} /></span><span className="compact-main"><strong>Role isolation</strong><small>Distributor access stays outside player games</small></span><strong>Guarded</strong></div>
          </div>
        </Panel>
      </div>

      <div className="dashboard-bottom-grid">
        <Panel title="Virtual-chip controls" action={<TextLink onClick={() => navigate("/Admin/chip-requests")}>View requests</TextLink>}>
          <div className="compact-list">
            <div className="compact-row"><span className="transaction-glyph">R</span><span className="compact-main"><strong>Pending chip requests</strong><small>Manual operator review</small></span><strong>{number(stats?.pending_chip_requests)}</strong></div>
            <div className="compact-row"><span className="transaction-glyph">C</span><span className="compact-main"><strong>Virtual chips</strong><small>No purchase, cash-out, transfer, or redemption</small></span><strong>{formatChips(number(stats?.held_chips))}</strong></div>
            <div className="compact-row"><span className="transaction-glyph">18</span><span className="compact-main"><strong>Age gate</strong><small>Adults only · play responsibly</small></span><strong>On</strong></div>
          </div>
        </Panel>

        <Panel title="Audit activity" action={<TextLink onClick={() => navigate("/Admin/security")}>Open audit log</TextLink>}>
          <div className="timeline-list">
            <div className="timeline-row"><span className="timeline-marker" /><div><strong>Registration review is active</strong><small>Manual approval governs player access</small></div></div>
            <div className="timeline-row"><span className="timeline-marker" /><div><strong>Wallet ledger is protected</strong><small>Mutations require authorized server actions</small></div></div>
            <div className="timeline-row"><span className="timeline-marker" /><div><strong>Platform source is live</strong><small>Operational summary loaded from the API</small></div></div>
            <div className="timeline-row"><span className="timeline-marker" /><div><strong>Last refreshed</strong><small><Clock3 size={10} style={{ display: "inline", marginRight: 4 }} />{new Date().toLocaleString()}</small></div></div>
          </div>
        </Panel>
      </div>
    </div>
  );
}
