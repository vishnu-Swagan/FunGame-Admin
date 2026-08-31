import { useCallback, useEffect, useState } from "react";
import {
  Activity, AlertTriangle, Copy, CreditCard, GitBranch, KeyRound, Plus, Power, PowerOff, RefreshCw,
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

function publicBase(status) {
  return String(status?.webhook_base_url || "").replace(/\/$/, "");
}

export function webhookUrlFor(gateway, status) {
  if (gateway?.webhook_url) return gateway.webhook_url;
  const base = publicBase(status);
  const code = String(gateway?.code || "").trim().toUpperCase();
  return base && code ? `${base}/api/webhooks/payments/${encodeURIComponent(code)}` : "";
}

export function v1WebhookUrlFor(gateway, status) {
  const configuredProvider = String(status?.v1_provider_code || "").trim().toLowerCase();
  const gatewayCode = String(gateway?.code || "").trim().toLowerCase();
  return configuredProvider && gatewayCode === configuredProvider
    ? String(status?.v1_webhook_url || "")
    : "";
}

async function copyValue(value, label = "Webhook URL") {
  try {
    await navigator.clipboard.writeText(value);
    toast.success(`${label} copied`);
  } catch {
    toast.error("Copy failed");
  }
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

function CopyableUrl({ label, value, testId }) {
  if (!value) return null;
  return (
    <div className="rounded-lg border border-white/10 bg-black/20 p-3" data-testid={testId}>
      <p className="text-[10px] font-bold uppercase tracking-wider text-white/55">{label}</p>
      <div className="mt-1 flex items-start gap-2">
        <code className="min-w-0 flex-1 break-all font-mono text-xs text-emerald-100">{value}</code>
        <Button type="button" size="sm" variant="outline" onClick={() => copyValue(value, label)} aria-label={`Copy ${label}`}>
          <Copy className="mr-1.5 h-3.5 w-3.5" />Copy
        </Button>
      </div>
    </div>
  );
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
  const canActivateGateway = isSuperAdmin && hasPermission(user, ADMIN_PERMISSIONS.GATEWAY_ACTIVATE);
  const canDisableGateway = isSuperAdmin && hasPermission(user, ADMIN_PERMISSIONS.GATEWAY_DISABLE);
  const adminEnabled = Boolean(status?.admin);
  const paymentsV2 = Boolean(status?.payments_v2);
  const webhookBase = publicBase(status);

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
      toast.success("Provider saved. Copy its webhook URL for the provider dashboard; live wallet posting stays gated.");
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
      toast.success("Configuration validation passed; this does not credit player wallets");
      await load();
    }
    catch (error) { toast.error(errMsg(error)); }
    finally { setBusy(""); }
  };

  const requestEnable = async (gateway) => {
    if (!paymentsV2) {
      toast.error("Set PAYMENTS_V2_ENABLED=true in Render before enabling a gateway. Webhook URLs can still be copied.");
      return;
    }
    const reason = window.prompt("Reason for enabling this gateway", "Approved provider configuration");
    if (!reason) return;
    setBusy(`${gateway.id}:enable`);
    try {
      await adminPayments.requestGatewayActivation(gateway.id, reason);
      toast.success("Enable requested. A second Super Admin must approve it.");
      await load();
    } catch (error) { toast.error(errMsg(error)); }
    finally { setBusy(""); }
  };

  const approveEnable = async (gateway, approvalId) => {
    if (!paymentsV2) {
      toast.error("Set PAYMENTS_V2_ENABLED=true in Render before enabling a gateway.");
      return;
    }
    setBusy(`${gateway.id}:approve`);
    try {
      await adminPayments.approveGatewayActivation(gateway.id, approvalId);
      toast.success("Gateway enabled as stored configuration. Live wallet posting still follows real-money flags.");
      await load();
    } catch (error) { toast.error(errMsg(error)); }
    finally { setBusy(""); }
  };

  const disableGateway = async (gateway) => {
    const reason = window.prompt("Reason for disabling this gateway", "Operator requested disable");
    if (!reason) return;
    setBusy(`${gateway.id}:disable`);
    try {
      await adminPayments.disableGateway(gateway.id, reason);
      toast.success("Gateway disabled");
      await load();
    } catch (error) { toast.error(errMsg(error)); }
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
      toast.success("Routing record saved. Player traffic still follows certified real-money flags.");
      setRouteForm((current) => ({ ...EMPTY_ROUTE, gateway_id: current.gateway_id }));
      await load();
    } catch (error) { toast.error(errMsg(error)); }
    finally { setBusy(""); }
  };

  return <PageTransition className="space-y-4" data-testid="payment-hub">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <p className="text-xs font-bold uppercase tracking-[.22em] text-primary">Payments · gateway control plane</p>
        <h1 className="mt-1 text-2xl font-black">Payment gateways</h1>
        <p className="mt-1 max-w-3xl text-sm text-white/50">Add approved providers, store encrypted credentials, and copy each gateway webhook URL for the provider dashboard.</p>
      </div>
      <Button variant="outline" onClick={load} disabled={loading} className="rounded-xl border-white/15"><RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />Refresh</Button>
    </div>

    <div data-testid="payment-hub-boundary" className="flex gap-3 rounded-2xl border border-sky-300/25 bg-sky-300/8 p-4 text-sm text-sky-50">
      <ShieldCheck className="h-5 w-5 shrink-0" />
      <div><strong>Provider registration is available here.</strong><p className="mt-1 text-xs opacity-85">This release exposes configuration and callback URLs only. Player pay-ins, payouts, wallet credit/debit, and V2 activation remain disabled by source-controlled rollout flags.</p></div>
    </div>

    {!adminEnabled && !loading && <div data-testid="payment-admin-disabled" className="flex gap-3 rounded-2xl border border-amber-300/25 bg-amber-300/8 p-4 text-sm text-amber-100"><AlertTriangle className="h-5 w-5 shrink-0" /><div><strong>PAYMENT_GATEWAY_ADMIN_ENABLED must be on in Render.</strong><p className="mt-1 text-xs opacity-80">Turn that API flag on so Super Admins can add providers, save credentials, and load webhook URLs. This page still renders so operators can confirm the flag.</p></div></div>}

    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <div className="rounded-2xl border border-white/10 bg-card/55 p-4"><CreditCard className="h-5 w-5 text-primary" /><p className="mt-3 text-2xl font-black">{gateways.length}</p><p className="text-xs text-white/45">Stored providers</p></div>
      <div className="rounded-2xl border border-white/10 bg-card/55 p-4"><ShieldCheck className="h-5 w-5 text-amber-200" /><p className="mt-3 text-lg font-black">{adminEnabled ? "On" : "Off"}</p><p className="text-xs text-white/45">CRM gateway admin API</p></div>
      <div className="rounded-2xl border border-white/10 bg-card/55 p-4"><GitBranch className="h-5 w-5 text-sky-300" /><p className="mt-3 text-2xl font-black">{routes.length}</p><p className="text-xs text-white/45">Routing records</p></div>
      <div className="rounded-2xl border border-white/10 bg-card/55 p-4"><Webhook className="h-5 w-5 text-emerald-200" /><p className="mt-3 text-lg font-black">{webhookBase ? "Ready" : "Unset"}</p><p className="text-xs text-white/45">Webhook public base URL</p></div>
    </div>

    <Tabs defaultValue="gateways" className="space-y-4">
      <TabsList className="h-auto flex-wrap rounded-xl bg-white/5 p-1"><TabsTrigger value="gateways">Providers</TabsTrigger><TabsTrigger value="routing">Routing</TabsTrigger><TabsTrigger value="webhooks">Webhooks</TabsTrigger><TabsTrigger value="activity">Activity</TabsTrigger></TabsList>

      <TabsContent value="gateways" className="space-y-4">
        <Panel title="Provider registry" subtitle="Super Admins add providers, save credentials, and copy webhook URLs for registration.">
          {gateways.length ? <div className="space-y-3">{gateways.map((gateway) => {
            const v2Url = webhookUrlFor(gateway, status);
            const v1Url = v1WebhookUrlFor(gateway, status);
            const pending = approvals.find((item) => item.target_type === "PAYMENT_GATEWAY" && item.target_id === gateway.id);
            return <article key={gateway.id} className="rounded-xl border border-white/8 bg-black/10 p-4" data-testid={`payment-gateway-${gateway.code}`}>
              <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="font-bold">{gateway.display_name}</p><p className="font-mono text-[10px] text-white/40">{gateway.code} · {gateway.environment === "LIVE" ? "Production" : "Sandbox"} · {gateway.adapter_type}</p></div><div className="flex flex-wrap gap-2"><Status tone="neutral">Health: {gateway.health_status || "NOT_RUN"}</Status><Status tone={gateway.is_enabled ? "healthy" : "warning"}>{gateway.is_enabled ? "Enabled" : "Disabled"}</Status></div></div>
              <div className="mt-3 space-y-2">
                <CopyableUrl label="Provider webhook URL" value={v2Url} testId={`gateway-webhook-url-${gateway.code}`} />
                <CopyableUrl label="V1 callback (if this provider still uses it)" value={v1Url} testId={`gateway-v1-webhook-url-${gateway.code}`} />
                {!v2Url && <p className="text-xs text-amber-100">Set PAYMENT_WEBHOOK_PUBLIC_BASE_URL to a public https origin in Render to display the webhook URL.</p>}
                {!paymentsV2 && <p className="text-xs text-white/50">Enable/activation requires PAYMENTS_V2_ENABLED in Render. Webhook URLs can still be copied for provider registration.</p>}
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {canRotateCredentials && <Button size="sm" variant="outline" onClick={() => openCredentials(gateway)} disabled={Boolean(busy)}><KeyRound className="mr-1.5 h-3.5 w-3.5" />Credentials</Button>}
                {canTestGateway && <Button size="sm" variant="outline" onClick={() => validateGateway(gateway)} disabled={Boolean(busy)}><TestTube2 className="mr-1.5 h-3.5 w-3.5" />Validate configuration</Button>}
                {canActivateGateway && !gateway.is_enabled && paymentsV2 && !pending && <Button size="sm" variant="outline" onClick={() => requestEnable(gateway)} disabled={Boolean(busy)}><Power className="mr-1.5 h-3.5 w-3.5" />Enable</Button>}
                {canActivateGateway && !gateway.is_enabled && paymentsV2 && pending && <Button size="sm" variant="outline" onClick={() => approveEnable(gateway, pending.id)} disabled={Boolean(busy)}><Power className="mr-1.5 h-3.5 w-3.5" />Approve enable</Button>}
                {canActivateGateway && !gateway.is_enabled && !paymentsV2 && <Button size="sm" variant="outline" disabled data-testid={`gateway-enable-blocked-${gateway.code}`}><Power className="mr-1.5 h-3.5 w-3.5" />Enable requires PAYMENTS_V2_ENABLED</Button>}
                {canDisableGateway && gateway.is_enabled && <Button size="sm" variant="outline" onClick={() => disableGateway(gateway)} disabled={Boolean(busy)}><PowerOff className="mr-1.5 h-3.5 w-3.5" />Disable</Button>}
              </div>
            </article>;
          })}</div> : <p className="text-sm text-white/45">{adminEnabled ? "No payment providers have been added." : "Provider records load after PAYMENT_GATEWAY_ADMIN_ENABLED is on."}</p>}
        </Panel>

        <Panel title="Add provider configuration" subtitle="Stores an encrypted provider record and its callback URL. It cannot create player payments or post to wallets.">
          {canCreateGateway ? <form data-testid="provider-draft-form" onSubmit={createGateway} className="space-y-4">
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1.5"><Label htmlFor="gateway-code">Provider code</Label><Input id="gateway-code" required placeholder="APPROVED_GATEWAY" value={gatewayForm.code} onChange={(event) => setGatewayForm({ ...gatewayForm, code: event.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "") })} /></div>
              <div className="space-y-1.5"><Label htmlFor="gateway-name">Display name</Label><Input id="gateway-name" required placeholder="Provider display name" value={gatewayForm.display_name} onChange={(event) => setGatewayForm({ ...gatewayForm, display_name: event.target.value })} /></div>
              <div className="space-y-1.5"><Label htmlFor="gateway-url">Approved API base URL</Label><Input id="gateway-url" required type="url" placeholder="https://api.provider.example" value={gatewayForm.base_url} onChange={(event) => setGatewayForm({ ...gatewayForm, base_url: event.target.value })} /></div>
              <div className="space-y-1.5"><Label>Provider contract environment (metadata only)</Label><Select value={gatewayForm.environment} onValueChange={(value) => setGatewayForm({ ...gatewayForm, environment: value })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="SANDBOX">Sandbox contract</SelectItem><SelectItem value="LIVE">Production contract</SelectItem></SelectContent></Select></div>
              <div className="space-y-1.5 md:col-span-2"><Label htmlFor="gateway-merchant">Merchant reference (masked or non-secret)</Label><Input id="gateway-merchant" placeholder="Merchant account label" value={gatewayForm.merchant_reference_masked} onChange={(event) => setGatewayForm({ ...gatewayForm, merchant_reference_masked: event.target.value })} /></div>
            </div>
            <fieldset className="rounded-xl border border-white/10 p-3"><legend className="px-1 text-xs font-bold uppercase tracking-wider text-white/55">Claimed provider capabilities · configuration only</legend><div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{CAPABILITY_OPTIONS.map(([value, label]) => <label key={value} className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-white/8 px-3 text-sm"><Checkbox checked={gatewayForm.capabilities.includes(value)} onCheckedChange={(checked) => toggleCapability(value, Boolean(checked))} /><span>{label}</span></label>)}</div></fieldset>
            <div className="space-y-1.5"><Label htmlFor="gateway-config">Provider contract mapping (non-secret JSON)</Label><Textarea id="gateway-config" rows={7} spellCheck={false} className="font-mono text-xs" value={gatewayForm.config_json} onChange={(event) => setGatewayForm({ ...gatewayForm, config_json: event.target.value })} /><p className="text-xs text-white/40">Endpoint paths, request fields, response mappings, and webhook header mappings belong here. Keep API keys and webhook secrets in the encrypted Credentials dialog.</p></div>
            <p className="rounded-lg border border-amber-300/20 bg-amber-300/8 p-3 text-xs text-amber-100">Providers are stored disabled. The enable control remains blocked until PAYMENTS_V2_ENABLED is explicitly released, and no gateway configuration can credit or debit a player wallet.</p>
            <Button disabled={Boolean(busy)}><Plus className="mr-2 h-4 w-4" />{busy === "create-gateway" ? "Saving provider…" : "Save provider configuration"}</Button>
          </form> : <p className="text-sm text-white/45">Read-only access. A Super Admin with provider-create permission must add providers.</p>}
        </Panel>
      </TabsContent>

      <TabsContent value="routing" className="space-y-4">
        <Panel title="Routing configuration" subtitle="Priority and weights are stored configuration. The player wallet does not consult this V2 registry.">
          {routes.length ? <div className="space-y-2">{routes.map((item) => <div key={item.id} className="grid items-center gap-2 rounded-xl border border-white/8 bg-black/10 p-3 text-sm sm:grid-cols-[1fr_.7fr_.7fr_auto]"><strong>{item.name}</strong><span>{item.direction} · {item.payment_method}</span><span>{item.currency} · priority {item.priority}</span><Status tone="warning">{item.is_enabled ? "Stored enabled · not player-routed" : "Stored disabled"}</Status></div>)}</div> : <p className="text-sm text-white/45">No routing configuration records.</p>}
        </Panel>
        <Panel title="Stored approval evidence" subtitle="Activation requests need PAYMENTS_V2_ENABLED and a second Super Admin; they still do not authorize wallet posting.">
          {approvals.length ? <div className="space-y-2">{approvals.map((item) => <div key={item.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/8 bg-black/10 p-3 text-sm"><div><strong>{item.action_type}</strong><p className="font-mono text-[10px] text-white/40">{item.target_type} · {item.target_id}</p></div><Status tone="warning">Awaiting separate approval</Status></div>)}</div> : <p className="text-sm text-white/45">No stored approval requests.</p>}
        </Panel>
        <Panel title="Create routing configuration draft" subtitle="Amounts are in paise; ₹1,000 is entered as 100000. Saving does not affect player traffic.">
          {canManageRoutes ? <form onSubmit={createRoute} className="grid gap-3 md:grid-cols-3"><Input required placeholder="Route name" value={routeForm.name} onChange={(event) => setRouteForm({ ...routeForm, name: event.target.value })} /><Select value={routeForm.gateway_id} onValueChange={(value) => setRouteForm({ ...routeForm, gateway_id: value })}><SelectTrigger><SelectValue placeholder="Provider" /></SelectTrigger><SelectContent>{gateways.map((gateway) => <SelectItem key={gateway.id} value={gateway.id}>{gateway.display_name}</SelectItem>)}</SelectContent></Select><Select value={routeForm.direction} onValueChange={(value) => setRouteForm({ ...routeForm, direction: value })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="PAYIN">Pay-in</SelectItem><SelectItem value="PAYOUT">Payout</SelectItem></SelectContent></Select><Input aria-label="Minimum amount in paise" type="number" min="1" value={routeForm.min_amount_minor} onChange={(event) => setRouteForm({ ...routeForm, min_amount_minor: event.target.value })} /><Input aria-label="Maximum amount in paise" type="number" min="1" value={routeForm.max_amount_minor} onChange={(event) => setRouteForm({ ...routeForm, max_amount_minor: event.target.value })} /><Button disabled={Boolean(busy) || !routeForm.gateway_id}><Route className="mr-2 h-4 w-4" />Create route draft</Button></form> : <p className="text-sm text-white/45">Read-only access. Route changes require a Super Admin with route-management permission.</p>}
        </Panel>
      </TabsContent>

      <TabsContent value="webhooks"><Panel title="V2 webhook evidence" subtitle="Callback URLs can be registered while V2 processing remains disabled."><div className="mb-3 rounded-lg border border-amber-300/20 bg-amber-300/8 p-3 text-xs text-amber-100">Webhook URLs are provider-registration metadata only while PAYMENTS_V2_ENABLED is false. They cannot create a payment order or credit a player wallet.</div>{events.length ? <div className="space-y-2">{events.map((item) => <div key={item.id} className="grid gap-2 rounded-xl border border-white/8 bg-black/10 p-3 text-sm sm:grid-cols-[1fr_1fr_auto]"><div><strong>{item.provider_event_type}</strong><p className="font-mono text-[10px] text-white/40">{item.provider_event_id}</p></div><span>{when(item.received_at)}</span><Status tone={item.processing_status === "DEAD_LETTER" ? "danger" : "neutral"}>Evidence: {item.processing_status}</Status></div>)}</div> : <div className="py-8 text-center text-sm text-white/45"><Webhook className="mx-auto mb-2 h-6 w-6" />No V2 webhook events have been received.</div>}</Panel></TabsContent>
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
