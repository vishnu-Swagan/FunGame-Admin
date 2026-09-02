import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  CreditCard,
  Database,
  Gamepad2,
  LockKeyhole,
  Network,
  RefreshCw,
  ScrollText,
  ServerCog,
  ShieldCheck,
  Users,
} from "lucide-react";
import { PageTransition } from "@/components/common";
import { api } from "@/lib/api";
import { adminPayments } from "@/lib/paymentApi";

function when(value) {
  if (!value) return "Not recorded";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? String(value)
    : date.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}

function statusTone(status) {
  if (["READY", "ACTIVE", "HEALTHY", "CONFIGURED", "LIVE"].includes(status)) {
    return "border-emerald-400/30 bg-emerald-400/10 text-emerald-300";
  }
  if (["INACTIVE", "LOCKED", "LIMITED", "UNKNOWN"].includes(status)) {
    return "border-amber-300/30 bg-amber-300/10 text-amber-200";
  }
  return "border-white/15 bg-white/5 text-white/55";
}

function StatusPill({ children }) {
  const value = String(children || "UNKNOWN").toUpperCase();
  return <span className={`rounded-full border px-2.5 py-1 text-[10px] font-bold ${statusTone(value)}`}>{value}</span>;
}

function PageHeader({ context, title, description, loading, onRefresh }) {
  return (
    <div className="crm-page-header">
      <div className="crm-page-header-copy">
        <span className="crm-page-context">{context}</span>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      <div className="crm-page-actions">
        <button type="button" className="icon-button" aria-label={`Refresh ${title}`} onClick={onRefresh} disabled={loading}>
          <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
        </button>
      </div>
    </div>
  );
}

function SummaryCard({ icon: Icon, label, value, note, tone = "" }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-card/55 p-4">
      <div className="flex items-start justify-between gap-3">
        <span className="rounded-xl border border-white/10 bg-white/5 p-2"><Icon className="h-4 w-4 text-primary" /></span>
        <StatusPill>{tone || value}</StatusPill>
      </div>
      <p className="mt-4 text-xs font-semibold uppercase tracking-[0.12em] text-white/40">{label}</p>
      <p className="mt-1 text-lg font-extrabold">{value}</p>
      <p className="mt-1 text-xs leading-relaxed text-white/45">{note}</p>
    </div>
  );
}

function LoadingBlock() {
  return <div className="h-44 rounded-2xl border border-white/5 fg-shimmer" />;
}

export function AdminPaymentGateways() {
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      setSettings(await adminPayments.settings());
    } catch (_error) {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const financial = settings?.financial || {};
  const features = financial.features || {};
  const gatewayRequested = Boolean(features.real_money || features.deposits || features.withdrawals || features.automatic_withdrawals);
  const providerState = financial.ready && gatewayRequested ? "Ready" : "Inactive";

  return (
    <PageTransition className="crm-page-stack">
      <PageHeader
        context="Provider boundary"
        title="Payment gateways"
        description="Connection readiness and isolation controls for external payment providers and source-aware player balances."
        loading={loading}
        onRefresh={load}
      />

      {error && (
        <div className="flex items-start gap-2.5 rounded-2xl border border-amber-300/25 bg-amber-300/8 p-4 text-xs text-amber-100">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
          Provider readiness could not be loaded. No gateway action has been enabled.
        </div>
      )}

      {loading ? <LoadingBlock /> : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <SummaryCard icon={Gamepad2} label="Gameplay economy" value="Source-aware balances" note="The game ledger remains the source of truth for player balances." tone="Active" />
            <SummaryCard icon={CreditCard} label="Provider adapter" value={providerState} note="External provider actions stay isolated from gameplay." />
            <SummaryCard icon={LockKeyhole} label="Automatic actions" value={features.automatic_withdrawals ? "Configured" : "Locked"} note="No automatic provider action can run without server readiness." />
            <SummaryCard icon={ServerCog} label="Configuration schema" value={`v${financial.schema_version || settings?.mode_version || 1}`} note={`Last control update: ${when(settings?.updated_at)}`} tone="Configured" />
          </div>

          <section className="crm-panel">
            <header className="crm-panel-header">
              <div><h2>Provider connection boundary</h2><p>Non-secret status only; credentials remain on the deployment host.</p></div>
            </header>
            <div className="crm-panel-body compact-list">
              <div className="compact-row"><span className="transaction-glyph"><Network size={15} /></span><span className="compact-main"><strong>Provider connection</strong><small>Adapter and production readiness</small></span><StatusPill>{providerState}</StatusPill></div>
              <div className="compact-row"><span className="transaction-glyph"><ShieldCheck size={15} /></span><span className="compact-main"><strong>Secret handling</strong><small>Keys and callback verification never render in the browser</small></span><StatusPill>Configured</StatusPill></div>
              <div className="compact-row"><span className="transaction-glyph"><Database size={15} /></span><span className="compact-main"><strong>Gameplay ledger isolation</strong><small>A provider response alone cannot change a player balance</small></span><StatusPill>Active</StatusPill></div>
            </div>
          </section>
        </>
      )}
    </PageTransition>
  );
}

export function AdminMonitoring() {
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const [health, stats, system, telesign] = await Promise.allSettled([
      api.get("/health"),
      api.get("/admin/stats"),
      api.get("/admin/system"),
      api.get("/admin/telesign"),
    ]);
    setState({
      health: health.status === "fulfilled" ? health.value.data : null,
      stats: stats.status === "fulfilled" ? stats.value.data : null,
      system: system.status === "fulfilled" ? system.value.data?.config : null,
      telesign: telesign.status === "fulfilled" ? telesign.value.data : null,
      failures: [health, stats, system, telesign].filter((result) => result.status === "rejected").length,
      refreshedAt: new Date(),
    });
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const health = state?.health;
  const stats = state?.stats;
  const telesignProducts = Object.values(state?.telesign?.products || {});
  const telesignEnabled = telesignProducts.filter((product) => product.enabled).length;

  return (
    <PageTransition className="crm-page-stack">
      <PageHeader
        context="Live operations"
        title="System monitoring"
        description="API, database, gameplay, CRM, catalog, queue, and provider-readiness evidence from the live service."
        loading={loading}
        onRefresh={load}
      />

      {loading ? <LoadingBlock /> : (
        <>
          {state?.failures > 0 && (
            <div className="flex items-start gap-2.5 rounded-2xl border border-amber-300/25 bg-amber-300/8 p-4 text-xs text-amber-100">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
              {state.failures} monitoring source{state.failures === 1 ? " is" : "s are"} temporarily unavailable; available evidence is shown below.
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <SummaryCard icon={Activity} label="API process" value={health?.status === "ok" ? "Healthy" : "Unknown"} note={`Refreshed ${when(state?.refreshedAt)}`} />
            <SummaryCard icon={Database} label="Database and gameplay" value={health?.gameplay_ready ? "Ready" : "Unknown"} note="Health requires a live database transaction probe." />
            <SummaryCard icon={Network} label="CRM services" value={health?.crm_ready ? "Ready" : "Unknown"} note="Registration and distributor persistence readiness." />
            <SummaryCard icon={ServerCog} label="Maintenance" value={state?.system?.maintenance_mode ? "Active" : "Inactive"} note="Player access control from current system configuration." />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <section className="crm-panel">
              <header className="crm-panel-header"><div><h2>Platform capacity</h2><p>Current database-backed workload evidence.</p></div></header>
              <div className="crm-panel-body compact-list">
                <div className="compact-row"><span className="transaction-glyph"><Users size={15} /></span><span className="compact-main"><strong>Registered players</strong><small>{Number(stats?.active_users || 0)} active accounts</small></span><strong>{Number(stats?.total_users || 0)}</strong></div>
                <div className="compact-row"><span className="transaction-glyph"><Gamepad2 size={15} /></span><span className="compact-main"><strong>Game catalog</strong><small>Enabled titles available to approved players</small></span><strong>{Number(stats?.enabled_games || 0)}/{Number(stats?.total_games || 0)}</strong></div>
                <div className="compact-row"><span className="transaction-glyph"><ScrollText size={15} /></span><span className="compact-main"><strong>Operator queue</strong><small>Pending bonus-balance decisions</small></span><strong>{Number(stats?.pending_chip_requests || 0)}</strong></div>
              </div>
            </section>

            <section className="crm-panel">
              <header className="crm-panel-header"><div><h2>Trust provider status</h2><p>TeleSign configuration and usage evidence without secret values.</p></div></header>
              <div className="crm-panel-body compact-list">
                <div className="compact-row"><span className="transaction-glyph"><ShieldCheck size={15} /></span><span className="compact-main"><strong>Host credentials</strong><small>Managed outside the browser</small></span><StatusPill>{state?.telesign?.credentials_ready ? "Ready" : "Inactive"}</StatusPill></div>
                <div className="compact-row"><span className="transaction-glyph"><Network size={15} /></span><span className="compact-main"><strong>Enabled products</strong><small>{telesignProducts.length} products reported by the server</small></span><strong>{telesignEnabled}</strong></div>
                <div className="compact-row"><span className="transaction-glyph"><Users size={15} /></span><span className="compact-main"><strong>Screened players</strong><small>{Number(state?.telesign?.usage?.flagged_players || 0)} risk flags recorded</small></span><strong>{Number(state?.telesign?.usage?.screened_players || 0)}</strong></div>
              </div>
            </section>
          </div>
        </>
      )}
    </PageTransition>
  );
}

export function AdminSecurityAudit() {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      setEvents(await adminPayments.audit());
    } catch (_error) {
      setEvents([]);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const summary = useMemo(() => {
    const actors = new Set(events.map((event) => event.actor_email || event.actor_id || event.admin_id).filter(Boolean));
    const privileged = events.filter((event) => !/LOGIN|SESSION/i.test(String(event.action || event.event_type || ""))).length;
    const blocked = events.filter((event) => /FAIL|BLOCK|DENY|REJECT/i.test(String(event.action || event.event_type || ""))).length;
    return { actors: actors.size, privileged, blocked };
  }, [events]);

  return (
    <PageTransition className="crm-page-stack">
      <PageHeader
        context="Access control"
        title="Security and audit"
        description="Authentication, permissions, protected actions, and immutable administrative evidence."
        loading={loading}
        onRefresh={load}
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard icon={ScrollText} label="Loaded audit events" value={loading ? "…" : events.length} note="Most recent protected actions returned by the server." tone={error ? "Unknown" : "Live"} />
        <SummaryCard icon={Users} label="Distinct actors" value={loading ? "…" : summary.actors} note="Administrators represented in the loaded evidence." tone={error ? "Unknown" : "Configured"} />
        <SummaryCard icon={LockKeyhole} label="Privileged actions" value={loading ? "…" : summary.privileged} note="Control changes and reviewed operations." tone={error ? "Unknown" : "Configured"} />
        <SummaryCard icon={AlertTriangle} label="Failed or blocked" value={loading ? "…" : summary.blocked} note="Denied, rejected, blocked, or failed audit actions." tone={summary.blocked ? "Limited" : "Healthy"} />
      </div>

      {error && (
        <div className="flex items-start gap-2.5 rounded-2xl border border-amber-300/25 bg-amber-300/8 p-4 text-xs text-amber-100">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
          Audit evidence is temporarily unavailable. Access controls remain server-enforced.
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[1.35fr_.65fr]">
        <section className="crm-panel">
          <header className="crm-panel-header"><div><h2>Recent audit events</h2><p>Latest server-recorded administrative activity.</p></div></header>
          <div className="crm-panel-body">
            {loading ? <LoadingBlock /> : events.length ? (
              <div className="timeline-list">
                {events.slice(0, 30).map((event, index) => (
                  <div className="timeline-row" key={event.id || `${event.action}-${index}`}>
                    <span className="timeline-marker" />
                    <div>
                      <strong>{event.action || event.event_type || "Administrative action"}</strong>
                      <small>{event.actor_email || event.actor_id || event.admin_id || "System actor"} · {when(event.created_at)}</small>
                      {(event.target_type || event.target_id) && <small>{[event.target_type, event.target_id].filter(Boolean).join(" · ")}</small>}
                    </div>
                  </div>
                ))}
              </div>
            ) : <div className="empty-state-compact"><span><CheckCircle2 size={19} /></span><h3>No audit events returned</h3><p>New protected administrative actions will appear here.</p></div>}
          </div>
        </section>

        <section className="crm-panel">
          <header className="crm-panel-header"><div><h2>Control model</h2><p>Configuration summary, not a live health assertion.</p></div></header>
          <div className="crm-panel-body compact-list">
            <div className="compact-row"><span className="transaction-glyph"><ShieldCheck size={15} /></span><span className="compact-main"><strong>Role-based authorization</strong><small>Protected routes require explicit server permissions</small></span><StatusPill>Configured</StatusPill></div>
            <div className="compact-row"><span className="transaction-glyph"><LockKeyhole size={15} /></span><span className="compact-main"><strong>Session and CSRF protection</strong><small>Authenticated mutations require session validation</small></span><StatusPill>Configured</StatusPill></div>
            <div className="compact-row"><span className="transaction-glyph"><Activity size={15} /></span><span className="compact-main"><strong>Authentication rate limits</strong><small>Sign-in and registration routes are server limited</small></span><StatusPill>Configured</StatusPill></div>
          </div>
        </section>
      </div>
    </PageTransition>
  );
}
