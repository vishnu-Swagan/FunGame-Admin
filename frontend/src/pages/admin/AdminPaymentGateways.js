import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle, Banknote, Bitcoin, Building2, CheckCircle2, Copy, CreditCard,
  Plus, RefreshCw, ShieldCheck, TestTube2, Trash2, Wallet,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { PageTransition } from "@/components/common";
import { useAuth } from "@/context/AuthContext";
import { ADMIN_PERMISSIONS, hasPermission } from "@/lib/adminPermissions";
import { adminPayments } from "@/lib/paymentApi";
import { errMsg } from "@/lib/api";

const CATEGORIES = [
  { key: "CARD", label: "Card Payments", icon: CreditCard },
  { key: "CRYPTO", label: "Crypto Payments", icon: Bitcoin },
  { key: "EWALLET", label: "E-Wallets", icon: Wallet },
  { key: "BANK", label: "Bank Transfer", icon: Building2 },
];

const MANUAL_FIELDS = [
  ["walletAddress", "Wallet address", "text"],
  ["qrImageUrl", "QR image URL", "text"],
  ["instructions", "Instructions", "textarea"],
  ["bankName", "Bank name", "text"],
  ["accountHolderName", "Account holder name", "text"],
  ["accountNumber", "Account number", "text"],
  ["swiftIban", "SWIFT / IBAN", "text"],
  ["accountIdentifier", "Account identifier", "text"],
];

const AUTOMATED_FIELDS = [
  ["apiBaseUrl", "API base URL", "https://api.provider.com"],
  ["gatewayServer", "Gateway server", ""],
  ["merchantId", "Merchant ID", ""],
  ["projectId", "Project ID", ""],
  ["orderCurrency", "Order currency", ""],
  ["allowedPayTokens", "Allowed pay tokens", "USDT-TRC20, USDT-BEP20"],
  ["orderValidMinutes", "Order valid (minutes)", ""],
];

const SECRET_FIELDS = [
  ["api_secret", "API Secret"],
  ["webhook_secret", "Webhook Secret"],
  ["auth_key", "Auth Key"],
  ["encryption_key", "Encryption key"],
];

const EMPTY_AGENT = {
  agent_type: "BANK", agent_name: "", country_code: "IN",
  deposit_enabled: false, withdrawal_enabled: false, show_details: false, details: "",
};

async function copyValue(value, label) {
  try {
    await navigator.clipboard.writeText(value);
    toast.success(`${label} copied`);
  } catch {
    toast.error("Copy failed");
  }
}

function Badge({ children, tone = "neutral" }) {
  const tones = {
    ok: "border-emerald-400/25 bg-emerald-400/10 text-emerald-200",
    warn: "border-amber-300/25 bg-amber-300/10 text-amber-100",
    info: "border-sky-300/25 bg-sky-300/10 text-sky-100",
    neutral: "border-white/10 bg-white/5 text-white/65",
  };
  return <span className={`inline-flex rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider ${tones[tone]}`}>{children}</span>;
}

function Panel({ title, subtitle, actions, children, testId }) {
  return <section className="rounded-2xl border border-white/10 bg-card/55" data-testid={testId}>
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/8 px-4 py-3">
      <div><h2 className="font-bold">{title}</h2>{subtitle && <p className="mt-0.5 text-xs text-white/45">{subtitle}</p>}</div>{actions}
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

function ToggleRow({ id, label, description, checked, disabled, onChange }) {
  return (
    <label htmlFor={id} className="flex items-start justify-between gap-3 rounded-lg border border-white/8 bg-black/10 p-3">
      <span className="min-w-0">
        <span className="block text-sm font-semibold">{label}</span>
        {description && <span className="mt-0.5 block text-[11px] text-white/45">{description}</span>}
      </span>
      <Switch id={id} checked={Boolean(checked)} disabled={disabled} onCheckedChange={onChange} data-testid={id} />
    </label>
  );
}

export default function AdminPaymentGateways() {
  const { user } = useAuth();
  const [status, setStatus] = useState(null);
  const [gateways, setGateways] = useState([]);
  const [settings, setSettings] = useState(null);
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [category, setCategory] = useState("CARD");
  const [busy, setBusy] = useState("");
  const [editing, setEditing] = useState(null);
  const [creating, setCreating] = useState(false);
  const [agentForm, setAgentForm] = useState({ ...EMPTY_AGENT });

  const isSuperAdmin = String(user?.admin_role || "").toUpperCase() === "SUPER_ADMIN";
  const canManage = isSuperAdmin && hasPermission(user, ADMIN_PERMISSIONS.GATEWAY_UPDATE_NON_SECRET_CONFIG);
  const canCreate = isSuperAdmin && hasPermission(user, ADMIN_PERMISSIONS.GATEWAY_CREATE);
  const canTest = hasPermission(user, ADMIN_PERMISSIONS.GATEWAY_TEST);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const hub = await adminPayments.hubStatus();
      setStatus(hub);
      if (hub?.admin) {
        const [gatewayRows, settingsRow, agentRows] = await Promise.all([
          adminPayments.gateways(),
          adminPayments.paymentGatewaySettings(),
          adminPayments.localAgents(),
        ]);
        setGateways(gatewayRows);
        setSettings(settingsRow);
        setAgents(agentRows);
      }
    } catch (error) {
      toast.error(errMsg(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const adminEnabled = Boolean(status?.admin);
  const paymentsV2 = Boolean(status?.payments_v2);

  const counts = useMemo(() => {
    const map = { CARD: 0, CRYPTO: 0, EWALLET: 0, BANK: 0 };
    gateways.forEach((gateway) => {
      if (map[gateway.category] !== undefined) map[gateway.category] += 1;
    });
    return map;
  }, [gateways]);

  const shown = useMemo(
    () => gateways.filter((gateway) => gateway.category === category),
    [gateways, category],
  );

  const patchGateway = async (gateway, body, label) => {
    setBusy(`${gateway.id}:toggle`);
    try {
      await adminPayments.updateGateway(gateway.id, body);
      toast.success(label);
      await load();
    } catch (error) {
      toast.error(errMsg(error));
    } finally {
      setBusy("");
    }
  };

  const testConnection = async (gateway) => {
    setBusy(`${gateway.id}:test`);
    try {
      await adminPayments.testGateway(gateway.id);
      toast.success("Connection test passed. This does not credit player wallets.");
      await load();
    } catch (error) {
      toast.error(errMsg(error));
    } finally {
      setBusy("");
    }
  };

  const removeAgent = async (agent) => {
    if (!window.confirm(`Remove local method “${agent.agent_name}”?`)) return;
    setBusy(`agent:${agent.id}`);
    try {
      await adminPayments.deleteLocalAgent(agent.id);
      toast.success("Local method removed");
      await load();
    } catch (error) {
      toast.error(errMsg(error));
    } finally {
      setBusy("");
    }
  };

  const createAgent = async (event) => {
    event.preventDefault();
    setBusy("agent:create");
    try {
      await adminPayments.createLocalAgent(agentForm);
      toast.success("Local deposit method published");
      setAgentForm({ ...EMPTY_AGENT });
      await load();
    } catch (error) {
      toast.error(errMsg(error));
    } finally {
      setBusy("");
    }
  };

  return <PageTransition className="space-y-4" data-testid="payment-gateways">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <p className="text-xs font-bold uppercase tracking-[.22em] text-primary">Payments · operator controls</p>
        <h1 className="mt-1 text-2xl font-black">Payment gateways</h1>
        <p className="mt-1 max-w-3xl text-sm text-white/50">Choose which payment methods clients can use to deposit and withdraw — automated providers or manual instructions. Enabling a method stores operator intent; live wallet credit/debit stays gated by the platform's financial readiness flags.</p>
      </div>
      <Button variant="outline" onClick={load} disabled={loading} className="rounded-xl border-white/15"><RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />Refresh</Button>
    </div>

    <div data-testid="payment-gateways-boundary" className="flex gap-3 rounded-2xl border border-sky-300/25 bg-sky-300/8 p-4 text-sm text-sky-50">
      <ShieldCheck className="h-5 w-5 shrink-0" />
      <div><strong>Configuration surface only.</strong><p className="mt-1 text-xs opacity-85">Saving providers, toggling methods, and copying webhook URLs work while payments remain disabled. No control here credits or debits a player wallet — that stays behind the source-controlled financial readiness flags.</p></div>
    </div>

    {!adminEnabled && !loading && <div data-testid="payment-admin-disabled" className="flex gap-3 rounded-2xl border border-amber-300/25 bg-amber-300/8 p-4 text-sm text-amber-100"><AlertTriangle className="h-5 w-5 shrink-0" /><div><strong>PAYMENT_GATEWAY_ADMIN_ENABLED must be on in Render.</strong><p className="mt-1 text-xs opacity-80">Turn that API flag on so operators can configure methods, save credentials, and load webhook URLs. This page still renders so the flag state is visible.</p></div></div>}

    <div className="flex flex-wrap gap-2" role="tablist" aria-label="Payment categories">
      {CATEGORIES.map(({ key, label, icon: Icon }) => (
        <button
          key={key}
          type="button"
          role="tab"
          aria-selected={category === key}
          data-testid={`category-tab-${key}`}
          onClick={() => setCategory(key)}
          className={`inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm font-semibold transition ${category === key ? "border-primary/40 bg-primary/15 text-white" : "border-white/10 bg-white/5 text-white/60"}`}
        >
          <Icon className="h-4 w-4" />
          {label}
          <span className="ml-1 rounded-full bg-black/30 px-2 py-0.5 text-[10px] tabular-nums">{counts[key]}</span>
        </button>
      ))}
    </div>

    <Panel
      title={CATEGORIES.find((item) => item.key === category)?.label || "Providers"}
      subtitle="Automated providers settle through an integration; manual methods publish instructions clients follow."
      testId="gateways-panel"
      actions={canCreate && adminEnabled ? <Button size="sm" onClick={() => setCreating(true)}><Plus className="mr-1.5 h-3.5 w-3.5" />Add provider</Button> : null}
    >
      {shown.length ? <div className="space-y-3">{shown.map((gateway) => {
        const automated = gateway.provider_type === "AUTOMATED";
        const canAutoDeposits = automated && gateway.connection_tested && gateway.deposits_enabled;
        const canAutoWithdrawals = automated && gateway.connection_tested && gateway.withdrawals_enabled;
        return <article key={gateway.id} data-testid={`gateway-card-${gateway.code}`} className="rounded-xl border border-white/8 bg-black/10 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="font-bold">{gateway.display_name}</p>
              <p className="font-mono text-[10px] text-white/40">{gateway.code}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge tone="info">{automated ? "Automated" : "Manual / Instructions"}</Badge>
              <Badge tone={gateway.configured ? "ok" : "warn"}>{gateway.configured ? "Configured" : "Needs setup"}</Badge>
              <Badge tone="neutral">{gateway.mode === "LIVE" ? "Live mode" : "Sandbox mode"}</Badge>
              {automated && <Badge tone={gateway.connection_tested ? "ok" : "neutral"}>{gateway.connection_tested ? "Connection tested" : "Not tested"}</Badge>}
            </div>
          </div>

          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <ToggleRow id={`deposits-${gateway.code}`} label="Enable deposits" description="Clients may select this method to deposit." checked={gateway.deposits_enabled} disabled={!canManage || Boolean(busy)} onChange={(checked) => patchGateway(gateway, { deposits_enabled: checked }, checked ? "Deposits enabled" : "Deposits disabled")} />
            <ToggleRow id={`withdrawals-${gateway.code}`} label="Enable withdrawals" description="Clients may select this method to withdraw." checked={gateway.withdrawals_enabled} disabled={!canManage || Boolean(busy)} onChange={(checked) => patchGateway(gateway, { withdrawals_enabled: checked }, checked ? "Withdrawals enabled" : "Withdrawals disabled")} />
            <ToggleRow id={`auto-deposits-${gateway.code}`} label="Auto-approve deposits" description={automated ? "Requires a passing connection test and deposits enabled." : "Automated providers only."} checked={gateway.auto_approve_deposits} disabled={!canManage || Boolean(busy) || !canAutoDeposits} onChange={(checked) => patchGateway(gateway, { auto_approve_deposits: checked }, checked ? "Auto-approve deposits on" : "Auto-approve deposits off")} />
            <ToggleRow id={`auto-withdrawals-${gateway.code}`} label="Auto-approve withdrawals" description={automated ? "Requires a passing connection test and withdrawals enabled." : "Automated providers only."} checked={gateway.auto_approve_withdrawals} disabled={!canManage || Boolean(busy) || !canAutoWithdrawals} onChange={(checked) => patchGateway(gateway, { auto_approve_withdrawals: checked }, checked ? "Auto-approve withdrawals on" : "Auto-approve withdrawals off")} />
          </div>

          <div className="mt-3 space-y-2">
            <CopyableUrl label="Webhook URL" value={gateway.webhook_url} testId={`gateway-webhook-url-${gateway.code}`} />
            <CopyableUrl label="Origin verification URL" value={gateway.origin_verification_url} testId={`gateway-origin-url-${gateway.code}`} />
            {!gateway.webhook_url && <p className="text-xs text-amber-100">Set PAYMENT_WEBHOOK_PUBLIC_BASE_URL to a public https origin in Render to display the webhook URL.</p>}
            {!paymentsV2 && <p className="text-xs text-white/50">Live payment processing requires PAYMENTS_V2_ENABLED. Configuration and webhook URLs remain available now.</p>}
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            {canManage && <Button size="sm" variant="outline" onClick={() => setEditing(gateway)} disabled={Boolean(busy)}>Configure</Button>}
            {automated && canTest && <Button size="sm" variant="outline" onClick={() => testConnection(gateway)} disabled={Boolean(busy)}><TestTube2 className="mr-1.5 h-3.5 w-3.5" />{busy === `${gateway.id}:test` ? "Testing…" : "Test connection"}</Button>}
          </div>
        </article>;
      })}</div> : <p data-testid="gateways-empty" className="text-sm text-white/45">{adminEnabled ? `No ${CATEGORIES.find((item) => item.key === category)?.label.toLowerCase()} providers yet.` : "Providers load after PAYMENT_GATEWAY_ADMIN_ENABLED is on."}</p>}
    </Panel>

    <PlatformSettingsPanel settings={settings} canManage={canManage} adminEnabled={adminEnabled} onSaved={load} />

    <Panel title="Local deposits" subtitle="Publish country-specific bank, UPI, card, or physical collection methods. Receiving details remain hidden unless explicitly shown." testId="local-agents-panel">
      {agents.length ? <div className="space-y-2">{agents.map((agent) => (
        <div key={agent.id} data-testid={`local-agent-${agent.id}`} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/8 bg-black/10 p-3 text-sm">
          <div className="min-w-0">
            <p className="font-semibold">{agent.agent_name} <span className="ml-1 text-[10px] font-mono text-white/40">{agent.country_code} · {agent.agent_type}</span></p>
            <p className="mt-0.5 text-[11px] text-white/45">
              {agent.deposit_enabled ? "Deposits on" : "Deposits off"} · {agent.withdrawal_enabled ? "Withdrawals on" : "Withdrawals off"}
              {" · "}
              {agent.show_details ? <span className="text-emerald-200">Details shown{agent.details ? `: ${agent.details}` : ""}</span> : <span className="text-white/40">Receiving details hidden</span>}
            </p>
          </div>
          {canManage && <Button size="sm" variant="outline" onClick={() => removeAgent(agent)} disabled={Boolean(busy)} aria-label={`Remove ${agent.agent_name}`}><Trash2 className="h-3.5 w-3.5" /></Button>}
        </div>
      ))}</div> : <p data-testid="local-agents-empty" className="text-sm text-white/45">No local deposit methods have been published.</p>}

      {canManage && adminEnabled && <form onSubmit={createAgent} className="mt-4 grid gap-3 border-t border-white/8 pt-4 md:grid-cols-2">
        <div className="space-y-1.5"><Label htmlFor="agent-name">Method name</Label><Input id="agent-name" required value={agentForm.agent_name} onChange={(event) => setAgentForm({ ...agentForm, agent_name: event.target.value })} placeholder="e.g. Mumbai UPI desk" /></div>
        <div className="space-y-1.5"><Label>Type</Label><Select value={agentForm.agent_type} onValueChange={(value) => setAgentForm({ ...agentForm, agent_type: value })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="BANK">Bank</SelectItem><SelectItem value="UPI">UPI</SelectItem><SelectItem value="CARD">Card</SelectItem><SelectItem value="OTHER">Other</SelectItem></SelectContent></Select></div>
        <div className="space-y-1.5"><Label htmlFor="agent-country">Country code</Label><Input id="agent-country" required maxLength={2} value={agentForm.country_code} onChange={(event) => setAgentForm({ ...agentForm, country_code: event.target.value.toUpperCase().replace(/[^A-Z]/g, "") })} placeholder="IN" /></div>
        <div className="space-y-1.5"><Label htmlFor="agent-details">Receiving details</Label><Input id="agent-details" value={agentForm.details} onChange={(event) => setAgentForm({ ...agentForm, details: event.target.value })} placeholder="Account / UPI ID (hidden unless shown)" /></div>
        <div className="flex flex-wrap gap-4 md:col-span-2">
          <label className="flex items-center gap-2 text-sm"><Switch checked={agentForm.deposit_enabled} onCheckedChange={(checked) => setAgentForm({ ...agentForm, deposit_enabled: checked })} />Deposits</label>
          <label className="flex items-center gap-2 text-sm"><Switch checked={agentForm.withdrawal_enabled} onCheckedChange={(checked) => setAgentForm({ ...agentForm, withdrawal_enabled: checked })} />Withdrawals</label>
          <label className="flex items-center gap-2 text-sm"><Switch checked={agentForm.show_details} onCheckedChange={(checked) => setAgentForm({ ...agentForm, show_details: checked })} />Show receiving details</label>
        </div>
        <div className="md:col-span-2"><Button type="submit" disabled={Boolean(busy)}><Banknote className="mr-2 h-4 w-4" />{busy === "agent:create" ? "Publishing…" : "Publish local method"}</Button></div>
      </form>}
    </Panel>

    {editing && <ConfigureDialog gateway={editing} onClose={() => setEditing(null)} onSaved={load} />}
    {creating && <CreateDialog category={category} onClose={() => setCreating(false)} onSaved={load} />}
  </PageTransition>;
}

function PlatformSettingsPanel({ settings, canManage, adminEnabled, onSaved }) {
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (settings) setForm(settings); }, [settings]);
  if (!settings || !form) return null;

  const save = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      await adminPayments.savePaymentGatewaySettings({
        return_pages: {
          success_path: form.return_pages.success_path,
          failure_path: form.return_pages.failure_path,
        },
        deposits_enabled: form.deposits_enabled,
        withdrawals_enabled: form.withdrawals_enabled,
        deposit_auto_approve: form.deposit_auto_approve,
        withdrawal_auto_approve: form.withdrawal_auto_approve,
        wallet_to_wallet_enabled: form.wallet_to_wallet_enabled,
      });
      toast.success("Payment platform settings saved");
      onSaved();
    } catch (error) {
      toast.error(errMsg(error));
    } finally {
      setBusy(false);
    }
  };

  return <Panel title="Payment platform settings" subtitle="Global deposit/withdrawal defaults and return pages. Stored configuration only." testId="platform-settings-panel">
    <form onSubmit={save} data-testid="platform-settings-form" className="space-y-4">
      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-1.5"><Label htmlFor="success-path">Return success path</Label><Input id="success-path" value={form.return_pages.success_path} onChange={(event) => setForm({ ...form, return_pages: { ...form.return_pages, success_path: event.target.value } })} disabled={!canManage} /></div>
        <div className="space-y-1.5"><Label htmlFor="failure-path">Return failure path</Label><Input id="failure-path" value={form.return_pages.failure_path} onChange={(event) => setForm({ ...form, return_pages: { ...form.return_pages, failure_path: event.target.value } })} disabled={!canManage} /></div>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <ToggleRow id="settings-deposits" label="Deposits enabled" checked={form.deposits_enabled} disabled={!canManage} onChange={(checked) => setForm({ ...form, deposits_enabled: checked })} />
        <ToggleRow id="settings-withdrawals" label="Withdrawals enabled" checked={form.withdrawals_enabled} disabled={!canManage} onChange={(checked) => setForm({ ...form, withdrawals_enabled: checked })} />
        <ToggleRow id="settings-deposit-auto" label="Deposit auto-approve" checked={form.deposit_auto_approve} disabled={!canManage} onChange={(checked) => setForm({ ...form, deposit_auto_approve: checked })} />
        <ToggleRow id="settings-withdrawal-auto" label="Withdrawal auto-approve" checked={form.withdrawal_auto_approve} disabled={!canManage} onChange={(checked) => setForm({ ...form, withdrawal_auto_approve: checked })} />
        <ToggleRow id="settings-w2w" label="Wallet-to-wallet enabled" checked={form.wallet_to_wallet_enabled} disabled={!canManage} onChange={(checked) => setForm({ ...form, wallet_to_wallet_enabled: checked })} />
      </div>
      {canManage && adminEnabled && <Button type="submit" disabled={busy}><CheckCircle2 className="mr-2 h-4 w-4" />{busy ? "Saving…" : "Save platform settings"}</Button>}
    </form>
  </Panel>;
}

function fieldsToConfig(gateway) {
  const config = { ...(gateway.non_secret_config || {}) };
  return config;
}

function ConfigureDialog({ gateway, onClose, onSaved }) {
  const automated = gateway.provider_type === "AUTOMATED";
  const [displayName, setDisplayName] = useState(gateway.display_name || "");
  const [baseUrl, setBaseUrl] = useState(gateway.base_url || "");
  const [config, setConfig] = useState(() => fieldsToConfig(gateway));
  const [secrets, setSecrets] = useState({});
  const [busy, setBusy] = useState(false);

  const fields = automated ? AUTOMATED_FIELDS : MANUAL_FIELDS;

  const save = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      const nonSecret = {};
      fields.forEach(([key]) => {
        const value = config[key];
        if (value !== undefined && value !== "") nonSecret[key] = value;
      });
      await adminPayments.updateGateway(gateway.id, {
        display_name: displayName,
        base_url: baseUrl,
        non_secret_config: nonSecret,
      });
      const secretEntries = Object.fromEntries(
        Object.entries(secrets).map(([key, value]) => [key, String(value).trim()]).filter(([, value]) => value),
      );
      if (Object.keys(secretEntries).length) {
        await adminPayments.writeGatewayCredentials(gateway.id, secretEntries);
      }
      toast.success("Provider saved. Credentials are encrypted at rest and never returned.");
      onSaved();
      onClose();
    } catch (error) {
      toast.error(errMsg(error));
    } finally {
      setBusy(false);
    }
  };

  return <Dialog open onOpenChange={(open) => !open && onClose()}>
    <DialogContent className="max-h-[85dvh] overflow-y-auto rounded-2xl border-white/10 bg-card sm:max-w-xl">
      <DialogHeader>
        <DialogTitle>Configure {gateway.display_name}</DialogTitle>
        <DialogDescription>Saving requires a privileged Super Admin session. Credentials are encrypted at rest and are never returned to the CRM.</DialogDescription>
      </DialogHeader>
      <form onSubmit={save} data-testid="configure-form" className="space-y-4">
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-1.5"><Label htmlFor="cfg-name">Display name</Label><Input id="cfg-name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></div>
          {automated && <div className="space-y-1.5"><Label htmlFor="cfg-base">Base URL</Label><Input id="cfg-base" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.provider.com" /></div>}
        </div>
        <fieldset className="space-y-3 rounded-xl border border-white/10 p-3">
          <legend className="px-1 text-xs font-bold uppercase tracking-wider text-white/55">{automated ? "Automated fields" : "Manual fields"}</legend>
          {fields.map(([key, label, hint]) => hint === "textarea"
            ? <div key={key} className="space-y-1.5"><Label htmlFor={`cfg-${key}`}>{label}</Label><Textarea id={`cfg-${key}`} rows={3} value={config[key] || ""} onChange={(event) => setConfig({ ...config, [key]: event.target.value })} /></div>
            : <div key={key} className="space-y-1.5"><Label htmlFor={`cfg-${key}`}>{label}</Label><Input id={`cfg-${key}`} value={config[key] || ""} placeholder={typeof hint === "string" ? hint : ""} onChange={(event) => setConfig({ ...config, [key]: event.target.value })} /></div>)}
        </fieldset>
        {automated && <fieldset className="space-y-3 rounded-xl border border-white/10 p-3">
          <legend className="px-1 text-xs font-bold uppercase tracking-wider text-white/55">Encrypted credentials (write-only)</legend>
          {SECRET_FIELDS.map(([key, label]) => (
            <div key={key} className="space-y-1.5"><Label htmlFor={`sec-${key}`}>{label}</Label><Input id={`sec-${key}`} type="password" autoComplete="new-password" placeholder={gateway.credential_hints?.[key] || "New value"} value={secrets[key] || ""} onChange={(event) => setSecrets({ ...secrets, [key]: event.target.value })} /></div>
          ))}
        </fieldset>}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy}>{busy ? "Saving…" : "Save configuration"}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}

function CreateDialog({ category, onClose, onSaved }) {
  const [form, setForm] = useState({
    code: "", display_name: "", category, provider_type: "AUTOMATED",
    base_url: "", environment: "SANDBOX",
  });
  const [busy, setBusy] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      await adminPayments.createGateway({
        code: form.code,
        display_name: form.display_name,
        adapter_type: "GENERIC_REST",
        environment: form.environment,
        category: form.category,
        provider_type: form.provider_type,
        base_url: form.base_url,
        non_secret_config: {},
      });
      toast.success("Provider added as a disabled draft. Enabling methods stays fail-closed behind financial flags.");
      onSaved();
      onClose();
    } catch (error) {
      toast.error(errMsg(error));
    } finally {
      setBusy(false);
    }
  };

  return <Dialog open onOpenChange={(open) => !open && onClose()}>
    <DialogContent className="max-h-[85dvh] overflow-y-auto rounded-2xl border-white/10 bg-card sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>Add provider</DialogTitle>
        <DialogDescription>Stores a disabled provider record. It cannot create player payments or post to wallets.</DialogDescription>
      </DialogHeader>
      <form onSubmit={submit} data-testid="create-form" className="space-y-4">
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-1.5"><Label htmlFor="new-code">Provider code</Label><Input id="new-code" required value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "") })} placeholder="APPROVED_PROVIDER" /></div>
          <div className="space-y-1.5"><Label htmlFor="new-name">Display name</Label><Input id="new-name" required value={form.display_name} onChange={(event) => setForm({ ...form, display_name: event.target.value })} /></div>
          <div className="space-y-1.5"><Label>Category</Label><Select value={form.category} onValueChange={(value) => setForm({ ...form, category: value })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{CATEGORIES.map((item) => <SelectItem key={item.key} value={item.key}>{item.label}</SelectItem>)}</SelectContent></Select></div>
          <div className="space-y-1.5"><Label>Provider type</Label><Select value={form.provider_type} onValueChange={(value) => setForm({ ...form, provider_type: value })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="AUTOMATED">Automated</SelectItem><SelectItem value="MANUAL">Manual / Instructions</SelectItem></SelectContent></Select></div>
          {form.provider_type === "AUTOMATED" && <div className="space-y-1.5 md:col-span-2"><Label htmlFor="new-base">API base URL</Label><Input id="new-base" value={form.base_url} onChange={(event) => setForm({ ...form, base_url: event.target.value })} placeholder="https://api.provider.com" /></div>}
          <div className="space-y-1.5"><Label>Mode</Label><Select value={form.environment} onValueChange={(value) => setForm({ ...form, environment: value })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="SANDBOX">Sandbox</SelectItem><SelectItem value="LIVE">Live</SelectItem></SelectContent></Select></div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy}>{busy ? "Adding…" : "Add provider"}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
