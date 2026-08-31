import { useCallback, useEffect, useState } from "react";
import {
  Activity, AlertTriangle, CreditCard, GitBranch, KeyRound, Plus, RefreshCw,
  Route, ShieldCheck, TestTube2, Webhook,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { PageTransition } from "@/components/common";
import { useAuth } from "@/context/AuthContext";
import { ADMIN_PERMISSIONS, hasPermission } from "@/lib/adminPermissions";
import { adminPayments } from "@/lib/paymentApi";
import { errMsg } from "@/lib/api";

const CAPABILITY_OPTIONS = [
  ["PAYIN", "Pay-ins"], ["PAYOUT", "Payouts"],
  ["HOSTED_CHECKOUT", "Hosted checkout"], ["PAYMENT_STATUS_QUERY", "Pay-in status"],
  ["PAYOUT_STATUS_QUERY", "Payout status"], ["WEBHOOKS", "Signed webhooks"],
  ["REFUND", "Refunds"], ["BANK_TRANSFER", "Bank transfer"],
  ["UPI", "UPI"], ["CARD", "Cards"],
];
const DEFAULT_CAPABILITIES = [
  "PAYIN", "PAYOUT", "HOSTED_CHECKOUT", "PAYMENT_STATUS_QUERY",
  "PAYOUT_STATUS_QUERY", "WEBHOOKS",
];
const EMPTY_GATEWAY = {
  code: "", display_name: "", adapter_type: "GENERIC_REST", environment: "SANDBOX",
  merchant_reference_masked: "", base_url: "", capabilities: DEFAULT_CAPABILITIES,
  config_json: "{}",
};
const EMPTY_ROUTE = {
  name: "", direction: "PAYIN", payment_method: "ALL", currency: "INR",
  min_amount_minor: 100, max_amount_minor: 100000000, subject_type: "ALL",
  gateway_id: "", priority: 100, weight: 100,
};
const DEFAULT_CREDENTIAL_ROWS = [
  { name: "api_key", value: "" },
  { name: "api_secret", value: "" },
  { name: "webhook_secret", value: "" },
];

function when(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime())
    ? date.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })
    : "—";
}

function Status({ children, tone = "neutral" }) {
  const tones = {
    healthy: "border-emerald-400/25 bg-emerald-400/10 text-emerald-200",
    warning: "border-amber-300/25 bg-amber-300/10 text-amber-100",
    danger: "border-red-400/25 bg-red-400/10 text-red-200",
    neutral: "border-white/10 bg-white/5 text-white/65",
  };
  return <span className={`inline-flex rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider ${tones[tone]}`}>{children}</span>;
}

function Panel({ title, subtitle, actions, children }) {
  return <section className="rounded-2xl border border-white/10 bg-card/55">
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/8 px-4 py-3">
      <div><h2 className="font-bold">{title}</h2><p className="mt-0.5 text-xs text-white/45">{subtitle}</p></div>{actions}
    </header>
    <div className="p-4">{children}</div>
  </section>;
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
  const [gatewayForm, setGatewayForm] = useState({ ...EMPTY_GATEWAY });
  const [routeForm, setRouteForm] = useState({ ...EMPTY_ROUTE });
  const [credentialTarget, setCredentialTarget] = useState(null);
  const [credentialRows, setCredentialRows] = useState(DEFAULT_CREDENTIAL_ROWS);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const hub = await adminPayments.hubStatus();
      setStatus(hub);
      if (hub?.admin) {
        const [gatewayRows, routeRows, eventRows, activityRows, approvalRows] = await Promise.all([
          adminPayments.gateways(), adminPayments.routes(), adminPayments.hubWebhookEvents(),
          adminPayments.hubActivity(), adminPayments.paymentApprovals(),
        ]);
        setGateways(gatewayRows); setRoutes(routeRows); setEvents(eventRows);
        setActivity(activityRows); setApprovals(approvalRows);
      }
    } catch (error) {
      toast.error(errMsg(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!routeForm.gateway_id && gateways[0]?.id) {
      setRouteForm((current) => ({ ...current, gateway_id: gateways[0].id }));
    }
  }, [gateways, routeForm.gateway_id]);

  const isSuperAdmin = String(user?.admin_role || "").toUpperCase() === "SUPER_ADMIN";
  const canCreateGateway = isSuperAdmin && hasPermission(user, ADMIN_PERMISSIONS.GATEWAY_CREATE);
  const canRotateCredentials = isSuperAdmin && hasPermission(user, ADMIN_PERMISSIONS.GATEWAY_ROTATE_CREDENTIALS);
  const canTestGateway = hasPermission(user, ADMIN_PERMISSIONS.GATEWAY_TEST);
  const canManageRoutes = isSuperAdmin && hasPermission(user, ADMIN_PERMISSIONS.GATEWAY_MANAGE_ROUTES);

  const toggleCapability = (capability, checked) => {
    setGatewayForm((current) => ({
      ...current,
      capabilities: checked
        ? [...new Set([...current.capabilities, capability])]
        : current.capabilities.filter((item) => item !== capability),
    }));
  };

  const createGateway = async (event) => {
    event.preventDefault(); setBusy("create-gateway");
    try {
      let nonSecretConfig;
      try { nonSecretConfig = JSON.parse(gatewayForm.config_json || "{}"); }
      catch { toast.error("Provider contract mapping must be valid JSON."); return; }
      if (!nonSecretConfig || Array.isArray(nonSecretConfig) || typeof nonSecretConfig !== "object") {
        toast.error("Provider contract mapping must be a JSON object."); return;
      }
      const { config_json: _ignored, ...body } = gatewayForm;
      await adminPayments.createGateway({ ...body, non_secret_config: nonSecretConfig });
      toast.success("Provider configuration saved as a disabled draft; player traffic is unchanged");
      setGatewayForm({ ...EMPTY_GATEWAY });
      await load();
    } catch (error) { toast.error(errMsg(error)); }
    finally { setBusy(""); }
  };

  const openCredentials = (gateway) => {
    setCredentialTarget(gateway);
    const names = Object.keys(gateway.credential_hints || {});
    setCredentialRows(names.length
      ? names.map((name) => ({ name, value: "" }))
      : DEFAULT_CREDENTIAL_ROWS.map((item) => ({ ...item })));
  };

  const saveCredentials = async (event) => {
    event.preventDefault();
    if (!credentialTarget) return;
    const credentials = Object.fromEntries(
      credentialRows.map(({ name, value }) => [name.trim().toLowerCase(), value]).filter(([name, value]) => name && value),
    );
    if (!Object.keys(credentials).length) { toast.error("Enter at least one credential value."); return; }
    setBusy(`${credentialTarget.id}:credentials`);
    try {
      await adminPayments.writeGatewayCredentials(credentialTarget.id, credentials);
      toast.success("Credentials encrypted and stored");
      setCredentialTarget(null); setCredentialRows(DEFAULT_CREDENTIAL_ROWS);
      await load();
    } catch (error) { toast.error(errMsg(error)); }
    finally { setBusy(""); }
  };

  const validateGateway = async (gateway) => {
    setBusy(`${gateway.id}:test`);
    try {
      await adminPayments.testGateway(gateway.id);
      toast.success("Configuration validation passed; this does not enable player traffic");
      await load();
    }
    catch (error) { toast.error(errMsg(error)); }
    finally { setBusy(""); }
  };

  const createRoute = async (event) => {
    event.preventDefault(); setBusy("create-route");
    try {
      await adminPayments.createRoute({
        ...routeForm,
        min_amount_minor: Number(routeForm.min_amount_minor), max_amount_minor: Number(routeForm.max_amount_minor),
        priority: Number(routeForm.priority), weight: Number(routeForm.weight),
      });
      toast.success("Routing configuration saved as a disabled draft; player traffic is unchanged");
      setRouteForm((current) => ({ ...EMPTY_ROUTE, gateway_id: current.gateway_id }));
      await load();
    } catch (error) { toast.error(errMsg(error)); }
    finally { setBusy(""); }
  };

  return <PageTransition className="space-y-4" data-testid="payment-hub">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <p className="text-xs font-bold uppercase tracking-[.22em] text-primary">Payments · configuration control plane</p>
        <h1 className="mt-1 text-2xl font-black">Payment gateway configuration preview</h1>
        <p className="mt-1 max-w-3xl text-sm text-white/50">Record provider contracts, protect credentials, and prepare routing drafts without connecting them to player deposits, withdrawals, or wallet posting.</p>
      </div>
      <Button variant="outline" onClick={load} disabled={loading} className="rounded-xl border-white/15"><RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />Refresh</Button>
    </div>

    <div data-testid="payment-preview-boundary" className="flex gap-3 rounded-2xl border border-amber-300/30 bg-amber-300/10 p-4 text-sm text-amber-50">
      <AlertTriangle className="h-5 w-5 shrink-0" />
      <div><strong>Configuration preview · no player traffic.</strong><p className="mt-1 text-xs opacity-85">The CRM V2 registry is not certified to the player wallet. Saving providers, credentials, capability claims, or routes here cannot create a player payment, credit chips, submit a withdrawal, or activate a provider callback. The current single-provider V1 callback is a separate integration.</p></div>
    </div>

    {!status?.admin && !loading && <div className="flex gap-3 rounded-2xl border border-amber-300/25 bg-amber-300/8 p-4 text-sm text-amber-100"><ShieldCheck className="h-5 w-5 shrink-0" /><div><strong>Gateway configuration API is disabled.</strong><p className="mt-1 text-xs opacity-80">Keep it disabled for Phase 0. A future staging-only configuration review does not authorize player traffic or callback registration.</p></div></div>}

    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <div className="rounded-2xl border border-white/10 bg-card/55 p-4"><CreditCard className="h-5 w-5 text-primary" /><p className="mt-3 text-2xl font-black">{gateways.length}</p><p className="text-xs text-white/45">Provider configuration records</p></div>
      <div className="rounded-2xl border border-white/10 bg-card/55 p-4"><ShieldCheck className="h-5 w-5 text-amber-200" /><p className="mt-3 text-lg font-black">Blocked</p><p className="text-xs text-white/45">Player wallet ↔ V2 bridge uncertified</p></div>
      <div className="rounded-2xl border border-white/10 bg-card/55 p-4"><GitBranch className="h-5 w-5 text-sky-300" /><p className="mt-3 text-2xl font-black">{routes.length}</p><p className="text-xs text-white/45">Routing configuration records</p></div>
      <div className="rounded-2xl border border-white/10 bg-card/55 p-4"><Webhook className="h-5 w-5 text-amber-200" /><p className="mt-3 text-lg font-black">Blocked</p><p className="text-xs text-white/45">V2 callback registration</p></div>
    </div>

    <Tabs defaultValue="gateways" className="space-y-4">
      <TabsList className="h-auto flex-wrap rounded-xl bg-white/5 p-1"><TabsTrigger value="gateways">Provider drafts</TabsTrigger><TabsTrigger value="routing">Routing preview</TabsTrigger><TabsTrigger value="webhooks">V2 webhook evidence</TabsTrigger><TabsTrigger value="activity">Activity</TabsTrigger></TabsList>

      <TabsContent value="gateways" className="space-y-4">
        <Panel title="Provider configuration registry" subtitle="Configuration and credentials only. Records shown here do not carry player traffic.">
          {gateways.length ? <div className="space-y-3">{gateways.map((gateway) => {
            return <article key={gateway.id} className="rounded-xl border border-white/8 bg-black/10 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="font-bold">{gateway.display_name}</p><p className="font-mono text-[10px] text-white/40">{gateway.code} · {gateway.environment === "LIVE" ? "Production" : "Sandbox"} contract metadata · draft only · {gateway.adapter_type}</p></div><div className="flex flex-wrap gap-2"><Status tone="neutral">Config check: {gateway.health_status || "NOT_RUN"} · not traffic readiness</Status><Status tone="warning">{gateway.is_enabled ? "Stored enabled · not player-routed" : "Disabled draft"}</Status></div></div>
              <div className="mt-3 rounded-lg border border-amber-300/20 bg-amber-300/8 p-3"><p className="text-[10px] font-bold uppercase tracking-wider text-amber-100/80">V2 callback registration blocked</p><p className="mt-1 text-xs text-amber-50/80">No provider webhook URL is exposed from this preview. Do not register the V2 callback until the player-wallet bridge, ledger posting, reconciliation, and rollback gates are certified.</p></div>
              <div className="mt-3 flex flex-wrap gap-2">
                {canRotateCredentials && <Button size="sm" variant="outline" onClick={() => openCredentials(gateway)} disabled={Boolean(busy)}><KeyRound className="mr-1.5 h-3.5 w-3.5" />Credentials</Button>}
                {canTestGateway && <Button size="sm" variant="outline" onClick={() => validateGateway(gateway)} disabled={Boolean(busy)}><TestTube2 className="mr-1.5 h-3.5 w-3.5" />Validate configuration</Button>}
              </div>
            </article>;
          })}</div> : <p className="text-sm text-white/45">No payment providers have been added.</p>}
        </Panel>

        <Panel title="Add provider configuration draft" subtitle="Stores a disabled draft only; it cannot enable a gateway, register a callback, or carry player traffic.">
          {canCreateGateway ? <form data-testid="provider-draft-form" onSubmit={createGateway} className="space-y-4">
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1.5"><Label htmlFor="gateway-code">Provider code</Label><Input id="gateway-code" required placeholder="APPROVED_GATEWAY" value={gatewayForm.code} onChange={(event) => setGatewayForm({ ...gatewayForm, code: event.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "") })} /></div>
              <div className="space-y-1.5"><Label htmlFor="gateway-name">Display name</Label><Input id="gateway-name" required placeholder="Provider display name" value={gatewayForm.display_name} onChange={(event) => setGatewayForm({ ...gatewayForm, display_name: event.target.value })} /></div>
              <div className="space-y-1.5"><Label htmlFor="gateway-url">Approved API base URL</Label><Input id="gateway-url" required type="url" placeholder="https://api.provider.example" value={gatewayForm.base_url} onChange={(event) => setGatewayForm({ ...gatewayForm, base_url: event.target.value })} /></div>
              <div className="space-y-1.5"><Label>Provider contract environment (metadata only)</Label><Select value={gatewayForm.environment} onValueChange={(value) => setGatewayForm({ ...gatewayForm, environment: value })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="SANDBOX">Sandbox contract · draft only</SelectItem><SelectItem value="LIVE">Production contract · draft only</SelectItem></SelectContent></Select></div>
              <div className="space-y-1.5 md:col-span-2"><Label htmlFor="gateway-merchant">Merchant reference (masked or non-secret)</Label><Input id="gateway-merchant" placeholder="Merchant account label" value={gatewayForm.merchant_reference_masked} onChange={(event) => setGatewayForm({ ...gatewayForm, merchant_reference_masked: event.target.value })} /></div>
            </div>
            <fieldset className="rounded-xl border border-white/10 p-3"><legend className="px-1 text-xs font-bold uppercase tracking-wider text-white/55">Claimed provider capabilities · configuration only</legend><div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{CAPABILITY_OPTIONS.map(([value, label]) => <label key={value} className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-white/8 px-3 text-sm"><Checkbox checked={gatewayForm.capabilities.includes(value)} onCheckedChange={(checked) => toggleCapability(value, Boolean(checked))} /><span>{label}</span></label>)}</div></fieldset>
            <div className="space-y-1.5"><Label htmlFor="gateway-config">Provider contract mapping (non-secret JSON)</Label><Textarea id="gateway-config" rows={7} spellCheck={false} className="font-mono text-xs" value={gatewayForm.config_json} onChange={(event) => setGatewayForm({ ...gatewayForm, config_json: event.target.value })} /><p className="text-xs text-white/40">Endpoint paths, request fields, response mappings, and webhook header mappings belong here. Keep API keys and webhook secrets in the encrypted Credentials dialog.</p></div>
            <p className="rounded-lg border border-amber-300/20 bg-amber-300/8 p-3 text-xs text-amber-100">Every provider saved here remains a disabled configuration draft. Activation and approval controls are intentionally unavailable until the V1↔V2 player-wallet bridge is separately certified and released.</p>
            <Button disabled={Boolean(busy)}><Plus className="mr-2 h-4 w-4" />{busy === "create-gateway" ? "Saving draft…" : "Save disabled provider draft"}</Button>
          </form> : <p className="text-sm text-white/45">Read-only access. A Super Admin with provider-create permission must add providers.</p>}
        </Panel>
      </TabsContent>

      <TabsContent value="routing" className="space-y-4">
        <Panel title="Routing configuration preview" subtitle="Priority and weights are draft metadata. The player wallet does not consult this V2 registry.">
          {routes.length ? <div className="space-y-2">{routes.map((item) => <div key={item.id} className="grid items-center gap-2 rounded-xl border border-white/8 bg-black/10 p-3 text-sm sm:grid-cols-[1fr_.7fr_.7fr_auto]"><strong>{item.name}</strong><span>{item.direction} · {item.payment_method}</span><span>{item.currency} · priority {item.priority}</span><Status tone="warning">{item.is_enabled ? "Stored enabled · not player-routed" : "Disabled draft"}</Status></div>)}</div> : <p className="text-sm text-white/45">No routing configuration records.</p>}
        </Panel>
        <Panel title="Stored approval evidence" subtitle="Read-only during Phase 0. The CRM cannot approve or enable a provider or route while the bridge gate is blocked.">
          {approvals.length ? <div className="space-y-2">{approvals.map((item) => <div key={item.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/8 bg-black/10 p-3 text-sm"><div><strong>{item.action_type}</strong><p className="font-mono text-[10px] text-white/40">{item.target_type} · {item.target_id}</p></div><Status tone="warning">Blocked by bridge gate</Status></div>)}</div> : <p className="text-sm text-white/45">No stored approval requests.</p>}
        </Panel>
        <Panel title="Create routing configuration draft" subtitle="Amounts are in paise; ₹1,000 is entered as 100000. Saving does not affect player traffic.">
          {canManageRoutes ? <form onSubmit={createRoute} className="grid gap-3 md:grid-cols-3"><Input required placeholder="Route name" value={routeForm.name} onChange={(event) => setRouteForm({ ...routeForm, name: event.target.value })} /><Select value={routeForm.gateway_id} onValueChange={(value) => setRouteForm({ ...routeForm, gateway_id: value })}><SelectTrigger><SelectValue placeholder="Provider" /></SelectTrigger><SelectContent>{gateways.map((gateway) => <SelectItem key={gateway.id} value={gateway.id}>{gateway.display_name}</SelectItem>)}</SelectContent></Select><Select value={routeForm.direction} onValueChange={(value) => setRouteForm({ ...routeForm, direction: value })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="PAYIN">Pay-in</SelectItem><SelectItem value="PAYOUT">Payout</SelectItem></SelectContent></Select><Input aria-label="Minimum amount in paise" type="number" min="1" value={routeForm.min_amount_minor} onChange={(event) => setRouteForm({ ...routeForm, min_amount_minor: event.target.value })} /><Input aria-label="Maximum amount in paise" type="number" min="1" value={routeForm.max_amount_minor} onChange={(event) => setRouteForm({ ...routeForm, max_amount_minor: event.target.value })} /><Button disabled={Boolean(busy) || !routeForm.gateway_id}><Route className="mr-2 h-4 w-4" />Create route draft</Button></form> : <p className="text-sm text-white/45">Read-only access. Route changes require a Super Admin with route-management permission.</p>}
        </Panel>
      </TabsContent>

      <TabsContent value="webhooks"><Panel title="V2 webhook evidence preview" subtitle="No V2 callback is registration-ready or connected to player wallet posting."><div className="mb-3 rounded-lg border border-amber-300/20 bg-amber-300/8 p-3 text-xs text-amber-100">Any rows shown here are configuration or staging evidence only. They do not prove player payment traffic and cannot credit a player wallet through the uncertified V2 bridge.</div>{events.length ? <div className="space-y-2">{events.map((item) => <div key={item.id} className="grid gap-2 rounded-xl border border-white/8 bg-black/10 p-3 text-sm sm:grid-cols-[1fr_1fr_auto]"><div><strong>{item.provider_event_type}</strong><p className="font-mono text-[10px] text-white/40">{item.provider_event_id}</p></div><span>{when(item.received_at)}</span><Status tone={item.processing_status === "DEAD_LETTER" ? "danger" : "neutral"}>Evidence: {item.processing_status}</Status></div>)}</div> : <div className="py-8 text-center text-sm text-white/45"><Webhook className="mx-auto mb-2 h-6 w-6" />No V2 preview events. No callback is ready to register.</div>}</Panel></TabsContent>
      <TabsContent value="activity"><Panel title="Immutable activity timeline" subtitle="Sensitive before/after values are redacted server-side.">{activity.length ? <div className="space-y-2">{activity.map((item) => <div key={item.id} className="flex items-start justify-between gap-3 rounded-xl border border-white/8 bg-black/10 p-3"><div><p className="text-sm font-bold">{item.event_type}</p><p className="font-mono text-[10px] text-white/40">{item.target_type} · {item.target_id}</p></div><span className="text-xs text-white/45">{when(item.occurred_at)}</span></div>)}</div> : <div className="py-8 text-center text-sm text-white/45"><Activity className="mx-auto mb-2 h-6 w-6" />No payment activity.</div>}</Panel></TabsContent>
    </Tabs>

    <Dialog open={Boolean(credentialTarget)} onOpenChange={(open) => !open && setCredentialTarget(null)}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto rounded-2xl border-white/10 bg-card sm:max-w-xl">
        <DialogHeader><DialogTitle>Write provider credentials</DialogTitle><DialogDescription>Values are encrypted before storage and cannot be read back in the CRM. Leave an existing credential blank to keep its current value.</DialogDescription></DialogHeader>
        <form onSubmit={saveCredentials} className="space-y-4">
          <div className="space-y-3">{credentialRows.map((row, index) => <div key={`${index}-${row.name}`} className="grid gap-2 sm:grid-cols-[.8fr_1.2fr_auto]"><Input aria-label={`Credential name ${index + 1}`} placeholder="credential_name" value={row.name} onChange={(event) => setCredentialRows((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, name: event.target.value.replace(/[^a-zA-Z0-9_]/g, "").toLowerCase() } : item))} /><Input aria-label={`Credential value ${index + 1}`} type="password" autoComplete="new-password" placeholder={credentialTarget?.credential_hints?.[row.name] || "New value"} value={row.value} onChange={(event) => setCredentialRows((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, value: event.target.value } : item))} /><Button type="button" variant="ghost" onClick={() => setCredentialRows((current) => current.filter((_, itemIndex) => itemIndex !== index))}>Remove</Button></div>)}</div>
          <Button type="button" variant="outline" onClick={() => setCredentialRows((current) => [...current, { name: "", value: "" }])}>Add credential field</Button>
          <DialogFooter><Button type="button" variant="outline" onClick={() => setCredentialTarget(null)}>Cancel</Button><Button disabled={Boolean(busy)}>Encrypt and save</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>

  </PageTransition>;
}
