import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, AlertTriangle, CheckCircle2, CreditCard, GitBranch, KeyRound, Plus, RefreshCw, Route, ShieldCheck, TestTube2, Webhook } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageTransition } from "@/components/common";
import { useAuth } from "@/context/AuthContext";
import { ADMIN_PERMISSIONS, hasPermission } from "@/lib/adminPermissions";
import { adminPayments } from "@/lib/paymentApi";
import { errMsg } from "@/lib/api";

const EMPTY_GATEWAY = { code: "", display_name: "", adapter_type: "MOCK_SANDBOX", environment: "SANDBOX", capabilities: ["PAYIN", "PAYMENT_STATUS_QUERY", "WEBHOOKS", "HOSTED_CHECKOUT"], non_secret_config: { scenario: "success", replay_window_seconds: 300 } };
const EMPTY_ROUTE = { name: "", direction: "PAYIN", payment_method: "HOSTED_CHECKOUT", currency: "INR", min_amount_minor: 100, max_amount_minor: 100000000, subject_type: "ALL", gateway_id: "", priority: 100, weight: 100 };

function when(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "—";
}

function Status({ children, tone = "neutral" }) {
  const tones = { healthy: "border-emerald-400/25 bg-emerald-400/10 text-emerald-200", warning: "border-amber-300/25 bg-amber-300/10 text-amber-100", danger: "border-red-400/25 bg-red-400/10 text-red-200", neutral: "border-white/10 bg-white/5 text-white/65" };
  return <span className={`inline-flex rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider ${tones[tone]}`}>{children}</span>;
}

function Panel({ title, subtitle, actions, children }) {
  return <section className="rounded-2xl border border-white/10 bg-card/55"><header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/8 px-4 py-3"><div><h2 className="font-bold">{title}</h2><p className="mt-0.5 text-xs text-white/45">{subtitle}</p></div>{actions}</header><div className="p-4">{children}</div></section>;
}

export default function AdminPaymentHub() {
  const { user } = useAuth();
  const [status, setStatus] = useState(null);
  const [gateways, setGateways] = useState([]);
  const [routes, setRoutes] = useState([]);
  const [events, setEvents] = useState([]);
  const [activity, setActivity] = useState([]);
  const [approvals, setApprovals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [gatewayForm, setGatewayForm] = useState(EMPTY_GATEWAY);
  const [routeForm, setRouteForm] = useState(EMPTY_ROUTE);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const hub = await adminPayments.hubStatus();
      setStatus(hub);
      if (hub?.admin) {
        const [gatewayRows, routeRows, eventRows, activityRows, approvalRows] = await Promise.all([
          adminPayments.gateways(), adminPayments.routes(), adminPayments.hubWebhookEvents(), adminPayments.hubActivity(), adminPayments.paymentApprovals(),
        ]);
        setGateways(gatewayRows); setRoutes(routeRows); setEvents(eventRows); setActivity(activityRows); setApprovals(approvalRows);
      }
    } catch (error) {
      toast.error(errMsg(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!routeForm.gateway_id && gateways[0]?.id) setRouteForm((current) => ({ ...current, gateway_id: gateways[0].id }));
  }, [gateways, routeForm.gateway_id]);

  const activeGateways = useMemo(() => gateways.filter((item) => item.is_enabled).length, [gateways]);
  const isSuperAdmin = String(user?.admin_role || "").toUpperCase() === "SUPER_ADMIN";
  const canCreateGateway = isSuperAdmin && hasPermission(user, ADMIN_PERMISSIONS.GATEWAY_CREATE);
  const canRotateCredentials = isSuperAdmin && hasPermission(user, ADMIN_PERMISSIONS.GATEWAY_ROTATE_CREDENTIALS);
  const canTestGateway = hasPermission(user, ADMIN_PERMISSIONS.GATEWAY_TEST);
  const canActivateGateway = isSuperAdmin && hasPermission(user, ADMIN_PERMISSIONS.GATEWAY_ACTIVATE);
  const canDisableGateway = isSuperAdmin && hasPermission(user, ADMIN_PERMISSIONS.GATEWAY_DISABLE);
  const canManageRoutes = isSuperAdmin && hasPermission(user, ADMIN_PERMISSIONS.GATEWAY_MANAGE_ROUTES);

  const createGateway = async (event) => {
    event.preventDefault(); setBusy("create-gateway");
    try {
      await adminPayments.createGateway(gatewayForm);
      toast.success("Sandbox gateway created in draft mode");
      setGatewayForm(EMPTY_GATEWAY); await load();
    } catch (error) { toast.error(errMsg(error)); } finally { setBusy(""); }
  };

  const act = async (gateway, action) => {
    setBusy(`${gateway.id}:${action}`);
    try {
      if (action === "credentials") {
        const value = window.prompt("Enter the sandbox webhook secret (write-only, at least 32 characters)");
        if (!value) return;
        await adminPayments.writeGatewayCredentials(gateway.id, { webhook_secret: value });
        toast.success("Credential encrypted and stored");
      } else if (action === "test") {
        await adminPayments.testGateway(gateway.id); toast.success("Gateway health test passed");
      } else if (action === "request") {
        const reason = window.prompt("Reason for activation request");
        if (!reason) return;
        const approval = await adminPayments.requestGatewayActivation(gateway.id, reason);
        toast.success(`Approval requested: ${approval.id}`);
      } else if (action === "disable") {
        const reason = window.prompt("Reason for disabling this gateway");
        if (!reason) return;
        await adminPayments.disableGateway(gateway.id, reason); toast.success("Gateway disabled");
      }
      await load();
    } catch (error) { toast.error(errMsg(error)); } finally { setBusy(""); }
  };

  const createRoute = async (event) => {
    event.preventDefault(); setBusy("create-route");
    try {
      await adminPayments.createRoute({ ...routeForm, min_amount_minor: Number(routeForm.min_amount_minor), max_amount_minor: Number(routeForm.max_amount_minor), priority: Number(routeForm.priority), weight: Number(routeForm.weight) });
      toast.success("Routing rule created disabled; approval is required before traffic");
      setRouteForm((current) => ({ ...EMPTY_ROUTE, gateway_id: current.gateway_id })); await load();
    } catch (error) { toast.error(errMsg(error)); } finally { setBusy(""); }
  };

  const requestRoute = async (route) => {
    const reason = window.prompt("Reason for route activation request");
    if (!reason) return;
    setBusy(`${route.id}:request`);
    try {
      await adminPayments.requestRouteActivation(route.id, reason);
      toast.success("Route activation sent for independent approval");
      await load();
    } catch (error) { toast.error(errMsg(error)); } finally { setBusy(""); }
  };

  const approve = async (approval) => {
    setBusy(`${approval.id}:approve`);
    try {
      if (approval.target_type === "PAYMENT_GATEWAY") await adminPayments.approveGatewayActivation(approval.target_id, approval.id);
      else if (approval.target_type === "PAYMENT_ROUTE") await adminPayments.approveRouteActivation(approval.target_id, approval.id);
      toast.success("Activation approved and audited");
      await load();
    } catch (error) { toast.error(errMsg(error)); } finally { setBusy(""); }
  };

  return <PageTransition className="space-y-4" data-testid="payment-hub">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-bold uppercase tracking-[.22em] text-primary">Payments · operations control plane</p><h1 className="mt-1 text-2xl font-black">Universal payment hub</h1><p className="mt-1 max-w-3xl text-sm text-white/50">Provider-neutral configuration, deterministic routing and sanitized operational evidence. Live mode remains locked until separately approved.</p></div><Button variant="outline" onClick={load} disabled={loading} className="rounded-xl border-white/15"><RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />Refresh</Button></div>

    {!status?.admin && !loading && <div className="flex gap-3 rounded-2xl border border-amber-300/25 bg-amber-300/8 p-4 text-sm text-amber-100"><AlertTriangle className="h-5 w-5 shrink-0" /><div><strong>Payment hub is safely disabled.</strong><p className="mt-1 text-xs opacity-80">Enable the staging admin flag only after the encryption key and sandbox domain allow-list are configured.</p></div></div>}

    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <div className="rounded-2xl border border-white/10 bg-card/55 p-4"><CreditCard className="h-5 w-5 text-primary" /><p className="mt-3 text-2xl font-black">{gateways.length}</p><p className="text-xs text-white/45">Configured gateways</p></div>
      <div className="rounded-2xl border border-white/10 bg-card/55 p-4"><CheckCircle2 className="h-5 w-5 text-emerald-300" /><p className="mt-3 text-2xl font-black">{activeGateways}</p><p className="text-xs text-white/45">Active gateways</p></div>
      <div className="rounded-2xl border border-white/10 bg-card/55 p-4"><GitBranch className="h-5 w-5 text-sky-300" /><p className="mt-3 text-2xl font-black">{routes.length}</p><p className="text-xs text-white/45">Auditable routes</p></div>
      <div className="rounded-2xl border border-white/10 bg-card/55 p-4"><ShieldCheck className="h-5 w-5 text-amber-200" /><p className="mt-3 text-lg font-black">{status?.live_allowed ? "Approved" : "Locked"}</p><p className="text-xs text-white/45">Live payment mode</p></div>
    </div>

    <Tabs defaultValue="gateways" className="space-y-4">
      <TabsList className="h-auto flex-wrap rounded-xl bg-white/5 p-1"><TabsTrigger value="gateways">Gateways</TabsTrigger><TabsTrigger value="routing">Routing rules</TabsTrigger><TabsTrigger value="webhooks">Webhook inspector</TabsTrigger><TabsTrigger value="activity">Activity</TabsTrigger></TabsList>
      <TabsContent value="gateways" className="space-y-4">
        <Panel title="Gateway registry" subtitle="Secrets are write-only; this table contains masked operational state only.">
          {gateways.length ? <div className="space-y-2">{gateways.map((gateway) => <article key={gateway.id} className="rounded-xl border border-white/8 bg-black/10 p-3"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="font-bold">{gateway.display_name}</p><p className="font-mono text-[10px] text-white/40">{gateway.code} · {gateway.adapter_type} · {gateway.environment}</p></div><div className="flex gap-2"><Status tone={gateway.health_status === "HEALTHY" ? "healthy" : gateway.health_status === "DOWN" ? "danger" : "neutral"}>{gateway.health_status}</Status><Status tone={gateway.is_enabled ? "healthy" : "warning"}>{gateway.status}</Status></div></div><div className="mt-3 flex flex-wrap gap-2">{canRotateCredentials && <Button size="sm" variant="outline" onClick={() => act(gateway, "credentials")} disabled={Boolean(busy)}><KeyRound className="mr-1.5 h-3.5 w-3.5" />Write credentials</Button>}{canTestGateway && <Button size="sm" variant="outline" onClick={() => act(gateway, "test")} disabled={Boolean(busy)}><TestTube2 className="mr-1.5 h-3.5 w-3.5" />Test</Button>}{!gateway.is_enabled && canActivateGateway ? <Button size="sm" onClick={() => act(gateway, "request")} disabled={Boolean(busy)}>Request activation</Button> : gateway.is_enabled && canDisableGateway ? <Button size="sm" variant="destructive" onClick={() => act(gateway, "disable")} disabled={Boolean(busy)}>Disable</Button> : null}</div></article>)}</div> : <p className="text-sm text-white/45">No gateways configured.</p>}
        </Panel>
        <Panel title="Add sandbox gateway" subtitle="Creates a disabled draft. A different authorised administrator must approve activation.">
          {canCreateGateway ? <form onSubmit={createGateway} className="grid gap-3 md:grid-cols-2"><Input required placeholder="Stable code, e.g. ACME_SANDBOX" value={gatewayForm.code} onChange={(event) => setGatewayForm({ ...gatewayForm, code: event.target.value.toUpperCase() })} /><Input required placeholder="Display name" value={gatewayForm.display_name} onChange={(event) => setGatewayForm({ ...gatewayForm, display_name: event.target.value })} /><Select value={gatewayForm.adapter_type} onValueChange={(value) => setGatewayForm({ ...gatewayForm, adapter_type: value })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="MOCK_SANDBOX">Mock sandbox</SelectItem><SelectItem value="GENERIC_REST">Generic REST</SelectItem></SelectContent></Select><div className="flex items-center rounded-md border border-white/10 bg-white/5 px-3 text-sm text-white/55">SANDBOX · live mode unavailable</div><Button className="md:col-span-2" disabled={Boolean(busy)}><Plus className="mr-2 h-4 w-4" />{busy === "create-gateway" ? "Creating…" : "Create draft gateway"}</Button></form> : <p className="text-sm text-white/45">Read-only access. A Super Admin with gateway-create permission must create drafts.</p>}
        </Panel>
      </TabsContent>
      <TabsContent value="routing" className="space-y-4"><Panel title="Deterministic routing" subtitle="Rules use legitimate operational criteria and remain disabled until approval.">{routes.length ? <div className="space-y-2">{routes.map((item) => <div key={item.id} className="grid items-center gap-2 rounded-xl border border-white/8 bg-black/10 p-3 text-sm sm:grid-cols-[1fr_.7fr_.7fr_auto_auto]"><strong>{item.name}</strong><span>{item.direction} · {item.payment_method}</span><span>{item.currency} · priority {item.priority}</span><Status tone={item.is_enabled ? "healthy" : "warning"}>{item.is_enabled ? "Enabled" : "Approval required"}</Status>{!item.is_enabled && canManageRoutes && <Button size="sm" variant="outline" onClick={() => requestRoute(item)} disabled={Boolean(busy)}>Request activation</Button>}</div>)}</div> : <p className="text-sm text-white/45">No routing rules configured.</p>}</Panel><Panel title="Pending maker-checker approvals" subtitle="The requesting administrator cannot approve their own change.">{approvals.length ? <div className="space-y-2">{approvals.map((item) => { const permitted = item.target_type === "PAYMENT_GATEWAY" ? canActivateGateway : canManageRoutes; return <div key={item.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/8 bg-black/10 p-3 text-sm"><div><strong>{item.action_type}</strong><p className="font-mono text-[10px] text-white/40">{item.target_type} · {item.target_id}</p></div>{permitted && <Button size="sm" onClick={() => approve(item)} disabled={Boolean(busy)}>Approve</Button>}</div>; })}</div> : <p className="text-sm text-white/45">No pending approvals.</p>}</Panel><Panel title="Create routing draft" subtitle="Amount values are integer minor units.">{canManageRoutes ? <form onSubmit={createRoute} className="grid gap-3 md:grid-cols-3"><Input required placeholder="Route name" value={routeForm.name} onChange={(event) => setRouteForm({ ...routeForm, name: event.target.value })} /><Select value={routeForm.gateway_id} onValueChange={(value) => setRouteForm({ ...routeForm, gateway_id: value })}><SelectTrigger><SelectValue placeholder="Gateway" /></SelectTrigger><SelectContent>{gateways.map((gateway) => <SelectItem key={gateway.id} value={gateway.id}>{gateway.display_name}</SelectItem>)}</SelectContent></Select><Select value={routeForm.direction} onValueChange={(value) => setRouteForm({ ...routeForm, direction: value })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="PAYIN">Pay-in</SelectItem><SelectItem value="PAYOUT">Payout</SelectItem></SelectContent></Select><Input type="number" min="1" value={routeForm.min_amount_minor} onChange={(event) => setRouteForm({ ...routeForm, min_amount_minor: event.target.value })} /><Input type="number" min="1" value={routeForm.max_amount_minor} onChange={(event) => setRouteForm({ ...routeForm, max_amount_minor: event.target.value })} /><Button disabled={Boolean(busy) || !routeForm.gateway_id}><Route className="mr-2 h-4 w-4" />Create disabled route</Button></form> : <p className="text-sm text-white/45">Read-only access. Route changes require a Super Admin with route-management permission.</p>}</Panel></TabsContent>
      <TabsContent value="webhooks"><Panel title="Webhook inspector" subtitle="Verified, deduplicated events with sanitized payloads.">{events.length ? <div className="space-y-2">{events.map((item) => <div key={item.id} className="grid gap-2 rounded-xl border border-white/8 bg-black/10 p-3 text-sm sm:grid-cols-[1fr_1fr_auto]"><div><strong>{item.provider_event_type}</strong><p className="font-mono text-[10px] text-white/40">{item.provider_event_id}</p></div><span>{when(item.received_at)}</span><Status tone={item.processing_status === "PROCESSED" ? "healthy" : item.processing_status === "DEAD_LETTER" ? "danger" : "warning"}>{item.processing_status}</Status></div>)}</div> : <div className="py-8 text-center text-sm text-white/45"><Webhook className="mx-auto mb-2 h-6 w-6" />No webhook events.</div>}</Panel></TabsContent>
      <TabsContent value="activity"><Panel title="Immutable activity timeline" subtitle="Sensitive before/after values are redacted server-side.">{activity.length ? <div className="space-y-2">{activity.map((item) => <div key={item.id} className="flex items-start justify-between gap-3 rounded-xl border border-white/8 bg-black/10 p-3"><div><p className="text-sm font-bold">{item.event_type}</p><p className="font-mono text-[10px] text-white/40">{item.target_type} · {item.target_id}</p></div><span className="text-xs text-white/45">{when(item.occurred_at)}</span></div>)}</div> : <div className="py-8 text-center text-sm text-white/45"><Activity className="mx-auto mb-2 h-6 w-6" />No payment activity.</div>}</Panel></TabsContent>
    </Tabs>
  </PageTransition>;
}
