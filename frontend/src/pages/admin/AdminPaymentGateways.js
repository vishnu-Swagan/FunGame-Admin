import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Banknote, Bitcoin, Building2, Copy, CreditCard, LayoutGrid,
  Plus, RefreshCw, ShieldCheck, TestTube2, Trash2, Wallet,
} from "lucide-react";
import { toast } from "sonner";
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
  { key: "OTHER", label: "Others", icon: LayoutGrid },
];

const MANUAL_FIELDS = [
  { key: "walletAddress", label: "Wallet Address", placeholder: "Wallet address" },
  { key: "qrImageUrl", label: "QR Image URL" },
  { key: "instructions", label: "Instructions / Note", placeholder: "Payment instructions" },
  { key: "bankName", label: "Bank Name", placeholder: "Bank name" },
  { key: "accountHolderName", label: "Account Holder Name", placeholder: "Account holder name" },
  { key: "accountNumber", label: "Account Number", placeholder: "Account number" },
  { key: "swiftIban", label: "SWIFT / IBAN" },
  { key: "accountIdentifier", label: "Account / Email / ID" },
];

const AUTOMATED_FIELDS = [
  { key: "apiBaseUrl", label: "API Base URL", placeholder: "https://api.provider.com", required: true },
  { key: "gatewayServer", label: "Gateway Server" },
  { key: "merchantId", label: "Merchant ID / Account ID", placeholder: "Merchant ID" },
  { key: "projectId", label: "Project ID (pid)", placeholder: "Project ID" },
  { key: "orderCurrency", label: "Order Currency" },
  { key: "allowedPayTokens", label: "Allowed Pay Tokens", placeholder: "USDT-TRC20, USDT-BEP20" },
  { key: "orderValidMinutes", label: "Order Valid Time (minutes)" },
];

const SECRET_FIELDS = [
  { key: "api_secret", crm: "apiSecret", label: "API Secret", required: true },
  { key: "webhook_secret", crm: "webhookSecret", label: "Webhook Secret" },
  { key: "auth_key", crm: "authKey", label: "Auth Key" },
  { key: "encryption_key", crm: "encryptionKey", label: "Encryption Key" },
];

function fieldsFor(gateway) {
  return gateway.provider_type === "MANUAL" ? MANUAL_FIELDS : AUTOMATED_FIELDS;
}

function secretsFor(gateway) {
  if (gateway.provider_type !== "AUTOMATED") return [];
  const extras = gateway.category === "CRYPTO"
    ? SECRET_FIELDS
    : SECRET_FIELDS.filter((item) => item.key !== "encryption_key" || gateway.category === "EWALLET");
  return extras;
}

function coerceGateway(row) {
  const config = row.configuration || row.non_secret_config || {};
  return {
    ...row,
    name: row.name || row.display_name,
    display_name: row.display_name || row.name,
    category: row.category || "OTHER",
    provider_type: row.provider_type || row.integrationMode || "AUTOMATED",
    deposits_enabled: row.deposits_enabled ?? row.depositEnabled ?? false,
    withdrawals_enabled: row.withdrawals_enabled ?? row.withdrawalEnabled ?? false,
    auto_approve_deposits: row.auto_approve_deposits ?? row.depositAutoApprove ?? false,
    auto_approve_withdrawals: row.auto_approve_withdrawals ?? row.withdrawalAutoApprove ?? false,
    sandboxMode: row.sandboxMode ?? row.mode !== "LIVE",
    configuration: config,
    countries: row.countries || [],
    description: row.description || "",
    webhook_url: row.webhook_url || row.webhookUrl || "",
    origin_verification_url: row.origin_verification_url || row.originVerificationUrl || "",
    connection_tested: row.connection_tested || row.lastTestStatus === "PASS",
    lastTestStatus: row.lastTestStatus || (row.connection_tested ? "PASS" : "NOT_TESTED"),
    lastTestedAt: row.lastTestedAt || row.last_health_check_at,
    configured: row.configured,
    credential_hints: row.credential_hints || {},
    secrets: row.secrets || {},
    secretDrafts: {},
  };
}

function coerceSettings(row) {
  const pages = row.returnPages || row.return_pages || {};
  const local = row.localSettings || {};
  return {
    returnPages: {
      successPath: pages.successPath || pages.success_path || "/play/wallet",
      failurePath: pages.failurePath || pages.failure_path || "/play/wallet",
    },
    localSettings: {
      depositsEnabled: local.depositsEnabled ?? row.deposits_enabled ?? false,
      withdrawalsEnabled: local.withdrawalsEnabled ?? row.withdrawals_enabled ?? false,
      depositAutoApprove: local.depositAutoApprove ?? row.deposit_auto_approve ?? false,
      withdrawalAutoApprove: local.withdrawalAutoApprove ?? row.withdrawal_auto_approve ?? false,
    },
    walletToWalletEnabled: row.walletToWalletEnabled ?? row.wallet_to_wallet_enabled ?? false,
  };
}

async function copyValue(value, label) {
  try {
    await navigator.clipboard.writeText(value);
    toast.success(`${label} copied`);
  } catch {
    toast.error("Copy failed");
  }
}

function Toggle({ id, label, checked, disabled, onChange, title, ariaLabel }) {
  return (
    <label className={`gateway-toggle ${disabled ? "is-disabled" : ""}`} title={title}>
      <input
        id={id}
        data-testid={id}
        type="checkbox"
        aria-label={ariaLabel || label}
        checked={Boolean(checked)}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="gateway-toggle-track" aria-hidden="true"><span /></span>
      {label ? <span>{label}</span> : null}
    </label>
  );
}

function Field({ label, required, value, onChange, placeholder, type = "text", readOnly, testId }) {
  return (
    <label className="gateway-field">
      <span>{label}{required ? <em> *</em> : null}</span>
      <input data-testid={testId} type={type} value={value ?? ""} placeholder={placeholder || ""} readOnly={readOnly} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function CopyField({ label, value, testId }) {
  return (
    <div className="gateway-copy-field" data-testid={testId}>
      <input readOnly value={value || ""} aria-label={label} />
      <button type="button" aria-label={`Copy ${label}`} onClick={() => value && copyValue(value, label)}><Copy size={14} /></button>
    </div>
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
  const [creating, setCreating] = useState(false);

  const isSuperAdmin = String(user?.admin_role || "").toUpperCase() === "SUPER_ADMIN";
  const canManage = isSuperAdmin && hasPermission(user, ADMIN_PERMISSIONS.GATEWAY_UPDATE_NON_SECRET_CONFIG);
  const canCreate = isSuperAdmin && hasPermission(user, ADMIN_PERMISSIONS.GATEWAY_CREATE);
  const canTest = hasPermission(user, ADMIN_PERMISSIONS.GATEWAY_TEST);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const hub = await adminPayments.hubStatus().catch(() => ({}));
      setStatus(hub || {});
      const [gatewayResult, settingsResult, agentResult] = await Promise.allSettled([
        adminPayments.gateways(),
        adminPayments.paymentGatewaySettings(),
        adminPayments.localAgents(),
      ]);
      if (gatewayResult.status === "fulfilled") {
        setGateways((gatewayResult.value || []).map(coerceGateway));
      } else {
        toast.error(errMsg(gatewayResult.reason, "Payment methods could not be loaded."));
      }
      setSettings(coerceSettings(settingsResult.status === "fulfilled" ? settingsResult.value || {} : {}));
      if (settingsResult.status === "rejected") {
        toast.error(errMsg(settingsResult.reason, "Payment settings could not be loaded."));
      }
      if (agentResult.status === "fulfilled") {
        setAgents(agentResult.value || []);
      } else {
        toast.error(errMsg(agentResult.reason, "Local deposit methods could not be loaded."));
      }
    } catch (error) {
      toast.error(errMsg(error));
      setSettings((current) => current || coerceSettings({}));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const adminEnabled = true;
  const liveCount = gateways.filter((item) => !item.sandboxMode).length;
  const shown = useMemo(() => gateways.filter((item) => item.category === category), [gateways, category]);

  return (
    <PageTransition className="payment-gateway-page" data-testid="payment-gateways">
      <div className="crm-page-header">
        <div className="crm-page-header-copy">
          <span className="crm-page-context">Payments</span>
          <h1>Payment gateways</h1>
          <p>Choose which payment methods clients can use to deposit and withdraw. Automated providers process callbacks; manual methods create reviewable instructions.</p>
        </div>
        <div className="gateway-header-actions">
          <span className="gateway-stat">{gateways.length} Methods</span>
          <span className="gateway-stat">{liveCount} Live</span>
          <button type="button" className="icon-button" aria-label="Refresh" onClick={load} disabled={loading}><RefreshCw size={15} /></button>
        </div>
      </div>

      <div data-testid="payment-gateways-boundary" className="crm-inline-notice">
        <ShieldCheck size={16} />
        <div>
          <strong>Provider connection boundary</strong>
          <p>Credentials are stored encrypted and callback URLs are ready to register. Connection tests verify the configured endpoint; hosted checkout, provider certification, and wallet credit/debit stay behind the financial readiness flags.</p>
        </div>
      </div>

      <nav className="gateway-tabs" aria-label="Payment method categories">
        {CATEGORIES.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            className={category === key ? "is-active" : ""}
            data-testid={`category-tab-${key}`}
            onClick={() => setCategory(key)}
          >
            <Icon size={18} />
            <span>{label}</span>
            <b>{gateways.filter((item) => item.category === key).length}</b>
          </button>
        ))}
      </nav>

      <div className="gateway-grid">
        {shown.map((gateway) => (
          <GatewayCard
            key={gateway.id}
            gateway={gateway}
            canManage={canManage}
            canTest={canTest}
            onRefresh={load}
          />
        ))}
        {!shown.length && !loading && (
          <div className="crm-panel" data-testid="gateways-empty">
            <div className="crm-panel-body empty-state-compact">
              <h3>No methods in this category</h3>
              <p>This admin database has no stored providers yet. CRM methods are not copied automatically — add the same provider here, then save credentials.</p>
              {canCreate && (
                <button type="button" className="crm-text-link" data-testid="add-provider-empty" onClick={() => setCreating(true)}><Plus size={14} /> Add a provider configuration</button>
              )}
            </div>
          </div>
        )}
      </div>

      {canCreate && shown.length > 0 && (
        <button type="button" className="gateway-link" onClick={() => setCreating(true)}><Plus size={14} /> Add a provider configuration</button>
      )}

      {settings && (
        <SettingsPanel
          settings={settings}
          canManage={canManage}
          adminEnabled={adminEnabled}
          onSaved={load}
        />
      )}

      <AgentsPanel agents={agents} canManage={canManage} adminEnabled={adminEnabled} onRefresh={load} />

      {creating && (
        <CreateCard
          category={category}
          onClose={() => setCreating(false)}
          onSaved={() => { setCreating(false); load(); }}
        />
      )}
    </PageTransition>
  );
}

function GatewayCard({ gateway, canManage, canTest, onRefresh }) {
  const [draft, setDraft] = useState(gateway);
  const [advanced, setAdvanced] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState("");

  useEffect(() => { setDraft(gateway); }, [gateway]);

  const automated = draft.provider_type === "AUTOMATED";
  const canAutoDeposits = automated && draft.connection_tested && draft.deposits_enabled;
  const canAutoWithdrawals = automated && draft.connection_tested && draft.withdrawals_enabled;
  const config = draft.configuration || {};

  const setToggle = (key, value) => {
    setDraft((current) => {
      const next = { ...current, [key]: value };
      if (key === "deposits_enabled" && !value) next.auto_approve_deposits = false;
      if (key === "withdrawals_enabled" && !value) next.auto_approve_withdrawals = false;
      return next;
    });
  };

  const save = async () => {
    setBusy("save");
    try {
      const secrets = Object.fromEntries(
        Object.entries(draft.secretDrafts || {}).filter(([, value]) => String(value || "").trim()),
      );
      await adminPayments.updateGateway(gateway.id, {
        display_name: draft.display_name,
        category: draft.category,
        provider_type: draft.provider_type,
        deposits_enabled: draft.deposits_enabled,
        withdrawals_enabled: draft.withdrawals_enabled,
        auto_approve_deposits: draft.auto_approve_deposits,
        auto_approve_withdrawals: draft.auto_approve_withdrawals,
        sandboxMode: draft.sandboxMode,
        countries: draft.countries,
        description: draft.description,
        non_secret_config: config,
        secrets,
        currentPassword: password,
      });
      toast.success("Gateway saved. Encrypted credentials and routing controls were saved and audit logged.");
      setPassword("");
      onRefresh();
    } catch (error) {
      toast.error(errMsg(error, "The gateway configuration was not saved."));
    } finally {
      setBusy("");
    }
  };

  const testConnection = async () => {
    setBusy("test");
    try {
      await adminPayments.testGateway(gateway.id);
      toast.success("Connection verified. This does not credit player wallets.");
      onRefresh();
    } catch (error) {
      toast.error(errMsg(error, "The provider could not be tested."));
    } finally {
      setBusy("");
    }
  };

  return (
    <article className="gateway-card" data-testid={`gateway-card-${gateway.code}`}>
      <header className="gateway-card-header">
        <div className="gateway-card-title">
          <span className="gateway-icon">{CATEGORIES.find((item) => item.key === draft.category)?.icon ? (() => {
            const Icon = CATEGORIES.find((item) => item.key === draft.category).icon;
            return <Icon size={18} />;
          })() : <CreditCard size={18} />}</span>
          <div>
            <h3>{draft.display_name}</h3>
            <span className="gateway-mode">{automated ? "Automated" : "Manual / Instructions"}</span>
            <span className={`status-tag ${draft.configured ? "is-ok" : "is-warn"}`}>{draft.configured ? "Configured" : "Needs setup"}</span>
          </div>
        </div>
        <div className="gateway-availability">
          Deposit
          <Toggle id={`deposits-${gateway.code}`} ariaLabel={`Enable deposits for ${draft.display_name}`} checked={draft.deposits_enabled} disabled={!canManage} onChange={(value) => setToggle("deposits_enabled", value)} />
          Withdrawal
          <Toggle id={`withdrawals-${gateway.code}`} ariaLabel={`Enable withdrawals for ${draft.display_name}`} checked={draft.withdrawals_enabled} disabled={!canManage} onChange={(value) => setToggle("withdrawals_enabled", value)} />
          <small>
            <Toggle id={`auto-deposits-${gateway.code}`} label="Auto-approve deposits" ariaLabel={`Auto-approve deposits for ${draft.display_name}`} checked={draft.auto_approve_deposits} disabled={!canManage || !canAutoDeposits} title={!automated ? "Auto-approval is available only for automated gateways." : !draft.deposits_enabled ? "Enable deposits before enabling deposit auto-approve." : !draft.connection_tested ? "A successful connection test is required before this setting can be saved." : ""} onChange={(value) => setToggle("auto_approve_deposits", value)} />
            <Toggle id={`auto-withdrawals-${gateway.code}`} label="Auto-approve withdrawals" ariaLabel={`Auto-approve withdrawals for ${draft.display_name}`} checked={draft.auto_approve_withdrawals} disabled={!canManage || !canAutoWithdrawals} title={!automated ? "Auto-approval is available only for automated gateways." : !draft.withdrawals_enabled ? "Enable withdrawals before enabling withdrawal auto-approve." : !draft.connection_tested ? "A successful connection test is required before this setting can be saved." : ""} onChange={(value) => setToggle("auto_approve_withdrawals", value)} />
          </small>
        </div>
      </header>

      <div className="gateway-card-body">
        {automated && !draft.connection_tested && (
          <div className="gateway-auto-note"><TestTube2 size={14} /> Test connection before saving auto-approve.</div>
        )}

        <div className="gateway-fields-grid">
          {secretsFor(draft).map((field) => (
            <Field
              key={field.key}
              label={field.label}
              required={field.required}
              type="password"
              placeholder={draft.credential_hints?.[field.key] || draft.secrets?.[field.crm]?.configured || draft.secrets?.[field.key]?.configured ? "Configured" : field.label}
              value={draft.secretDrafts?.[field.key] || ""}
              onChange={(value) => setDraft((current) => ({ ...current, secretDrafts: { ...current.secretDrafts, [field.key]: value } }))}
            />
          ))}
          {fieldsFor(draft).map((field) => (
            <Field
              key={field.key}
              label={field.label}
              required={field.required}
              placeholder={field.placeholder}
              value={config[field.key] || ""}
              onChange={(value) => setDraft((current) => ({ ...current, configuration: { ...current.configuration, [field.key]: value } }))}
            />
          ))}
          <Field
            label="Countries (ISO codes)"
            placeholder="IN, US"
            value={(draft.countries || []).join(", ")}
            onChange={(value) => setDraft((current) => ({ ...current, countries: value.split(",").map((item) => item.trim().toUpperCase()).filter(Boolean) }))}
          />
        </div>

        <div className="gateway-webhook">
          <strong><ShieldCheck size={15} /> Callback URLs</strong>
          <p>Copy webhook URL and origin verification URL for the provider dashboard. These work while live processing stays disabled.</p>
          <CopyField label="Webhook URL" value={draft.webhook_url} testId={`gateway-webhook-url-${gateway.code}`} />
          <CopyField label="Origin verification URL" value={draft.origin_verification_url} testId={`gateway-origin-url-${gateway.code}`} />
          <div className="gateway-security-row">
            <Toggle id={`sandbox-${gateway.code}`} label={draft.sandboxMode ? "Sandbox mode" : "Live mode"} checked={!draft.sandboxMode} disabled={!canManage} onChange={(live) => setDraft((current) => ({ ...current, sandboxMode: !live }))} />
            <span>Credentials are encrypted at rest and never returned to the browser.</span>
          </div>
        </div>

        {advanced && (
          <div className="gateway-advanced">
            <Field label="Description" value={draft.description} onChange={(value) => setDraft((current) => ({ ...current, description: value }))} />
            <Field label="Gateway slug" value={gateway.code} readOnly />
          </div>
        )}

        <div className="gateway-card-actions">
          <button type="button" className="gateway-link" onClick={() => setAdvanced((value) => !value)}>{advanced ? "Hide advanced" : "Advanced fields"}</button>
          <span className="gateway-test-status">{draft.lastTestedAt ? `${draft.lastTestStatus} · ${new Date(draft.lastTestedAt).toLocaleString()}` : "Not tested"}</span>
          {automated && canTest && (
            <button type="button" className="crm-text-link" onClick={testConnection} disabled={Boolean(busy)}><TestTube2 size={14} />{busy === "test" ? "Testing..." : "Test connection"}</button>
          )}
          {canManage && (
            <>
              <label className="gateway-password">
                <input data-testid={`save-password-${gateway.code}`} type="password" autoComplete="current-password" placeholder="Current Admin password" value={password} onChange={(event) => setPassword(event.target.value)} />
              </label>
              <button type="button" className="crm-text-link" data-testid={`save-gateway-${gateway.code}`} onClick={save} disabled={Boolean(busy) || !password}>{busy === "save" ? "Saving..." : "Save"}</button>
            </>
          )}
        </div>
      </div>
    </article>
  );
}

function SettingsPanel({ settings, canManage, adminEnabled, onSaved }) {
  const [form, setForm] = useState(settings);
  const [busy, setBusy] = useState(false);
  useEffect(() => setForm(settings), [settings]);

  const save = async () => {
    setBusy(true);
    try {
      await adminPayments.savePaymentGatewaySettings({
        returnPages: form.returnPages,
        localSettings: form.localSettings,
        walletToWalletEnabled: form.walletToWalletEnabled,
      });
      toast.success("Payment settings saved. Return pages, local rails, and wallet transfer policy were updated and audited.");
      onSaved();
    } catch (error) {
      toast.error(errMsg(error, "The settings were not saved."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="crm-panel" data-testid="platform-settings-panel">
      <header className="crm-panel-header">
        <div>
          <h2>Payment platform settings</h2>
          <p>Controls shared by hosted returns, local deposits, and wallet transfers.</p>
        </div>
      </header>
      <div className="crm-panel-body" style={{ padding: "16px 18px 18px" }}>
        <form data-testid="platform-settings-form" onSubmit={(event) => { event.preventDefault(); save(); }} className="space-y-3">
          <div className="gateway-settings-grid">
            <Field label="Success page" placeholder="/play/wallet or https://..." value={form.returnPages.successPath} onChange={(value) => setForm((current) => ({ ...current, returnPages: { ...current.returnPages, successPath: value } }))} />
            <Field label="Failure / cancel page" placeholder="/play/wallet or https://..." value={form.returnPages.failurePath} onChange={(value) => setForm((current) => ({ ...current, returnPages: { ...current.returnPages, failurePath: value } }))} />
          </div>
          <div className="gateway-settings-row">
            <strong>Local deposits</strong>
            <Toggle id="settings-deposits" label="Deposits" checked={form.localSettings.depositsEnabled} disabled={!canManage} onChange={(value) => setForm((current) => ({ ...current, localSettings: { ...current.localSettings, depositsEnabled: value } }))} />
            <Toggle id="settings-withdrawals" label="Withdrawals" checked={form.localSettings.withdrawalsEnabled} disabled={!canManage} onChange={(value) => setForm((current) => ({ ...current, localSettings: { ...current.localSettings, withdrawalsEnabled: value } }))} />
            <Toggle id="settings-deposit-auto" label="Auto-approve deposits" checked={form.localSettings.depositAutoApprove} disabled={!canManage} onChange={(value) => setForm((current) => ({ ...current, localSettings: { ...current.localSettings, depositAutoApprove: value } }))} />
            <Toggle id="settings-withdrawal-auto" label="Auto-approve withdrawals" checked={form.localSettings.withdrawalAutoApprove} disabled={!canManage} onChange={(value) => setForm((current) => ({ ...current, localSettings: { ...current.localSettings, withdrawalAutoApprove: value } }))} />
          </div>
          <div className="gateway-settings-row">
            <strong>Wallet to Wallet</strong>
            <Toggle id="settings-w2w" label="Allow player-to-player transfers" checked={form.walletToWalletEnabled} disabled={!canManage} onChange={(value) => setForm((current) => ({ ...current, walletToWalletEnabled: value }))} />
          </div>
          <div className="gateway-card-actions">
            <span className="gateway-muted"><ShieldCheck size={15} /> Changes are permission protected and audit logged.</span>
            {canManage && adminEnabled && <button type="submit" className="crm-text-link" disabled={busy}>{busy ? "Saving..." : "Save settings"}</button>}
          </div>
        </form>
      </div>
    </section>
  );
}

function AgentsPanel({ agents, canManage, adminEnabled, onRefresh }) {
  const [form, setForm] = useState({
    agentType: "CASH", agentName: "", countryCode: "IN",
    depositEnabled: true, withdrawalEnabled: true, showDetails: false, details: "",
  });
  const [busy, setBusy] = useState(false);

  const add = async () => {
    setBusy(true);
    try {
      await adminPayments.createLocalAgent(form);
      toast.success("Agent added. The local deposit method is ready for country-scoped use.");
      setForm({ agentType: "CASH", agentName: "", countryCode: "IN", depositEnabled: true, withdrawalEnabled: true, showDetails: false, details: "" });
      onRefresh();
    } catch (error) {
      toast.error(errMsg(error, "The local method was not added."));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (agent) => {
    try {
      await adminPayments.deleteLocalAgent(agent.id);
      onRefresh();
    } catch (error) {
      toast.error(errMsg(error, "The local method was not removed."));
    }
  };

  return (
    <section className="crm-panel" data-testid="local-agents-panel">
      <header className="crm-panel-header">
        <div>
          <h2>Local deposits</h2>
          <p>Publish country-specific bank, UPI, card, or physical collection methods. Receiving details remain hidden unless you explicitly show them.</p>
        </div>
      </header>
      <div className="crm-panel-body" style={{ padding: "8px 18px 18px" }}>
        {agents.length ? agents.map((agent) => (
          <div key={agent.id} className="local-agent-row" data-testid={`local-agent-${agent.id}`}>
            <div>
              <strong>{agent.agentName || agent.agent_name}</strong>
              <small>{agent.agentType || agent.agent_type} · {agent.countryCode || agent.country_code} · {(agent.detailsConfigured || agent.show_details) ? "Details shown" : "No receiving details"}</small>
            </div>
            <Toggle label="Deposit" checked={agent.depositEnabled ?? agent.deposit_enabled} disabled onChange={() => {}} />
            <Toggle label="Withdrawal" checked={agent.withdrawalEnabled ?? agent.withdrawal_enabled} disabled onChange={() => {}} />
            {canManage && <button type="button" className="gateway-danger-icon" aria-label={`Remove ${agent.agentName || agent.agent_name}`} onClick={() => remove(agent)}><Trash2 size={15} /></button>}
          </div>
        )) : <p data-testid="local-agents-empty" className="gateway-muted" style={{ padding: "16px 0" }}>No local deposit methods have been published.</p>}

        {canManage && adminEnabled && (
          <div className="local-agent-form">
            <select aria-label="Agent type" value={form.agentType} onChange={(event) => setForm({ ...form, agentType: event.target.value })}>
              <option value="CASH">Cash / Address</option>
              <option value="BANK">Bank</option>
              <option value="UPI">UPI</option>
              <option value="CARD">Card</option>
              <option value="OTHER">Other</option>
            </select>
            <input aria-label="Agent name" placeholder="e.g. Local Collection" value={form.agentName} onChange={(event) => setForm({ ...form, agentName: event.target.value })} />
            <input aria-label="Country code" placeholder="IN" maxLength={2} value={form.countryCode} onChange={(event) => setForm({ ...form, countryCode: event.target.value.toUpperCase().replace(/[^A-Z]/g, "") })} />
            <Toggle label="Deposits" checked={form.depositEnabled} onChange={(value) => setForm({ ...form, depositEnabled: value })} />
            <Toggle label="Withdrawals" checked={form.withdrawalEnabled} onChange={(value) => setForm({ ...form, withdrawalEnabled: value })} />
            <Toggle label="Show details" checked={form.showDetails} onChange={(value) => setForm({ ...form, showDetails: value })} />
            <button type="button" className="crm-text-link" onClick={add} disabled={busy || !form.agentName.trim()}>{busy ? "Adding..." : "Add agent"}</button>
            <input className="local-agent-details" aria-label="Receiving details" placeholder="Receiving details (hidden unless shown)" value={form.details} onChange={(event) => setForm({ ...form, details: event.target.value })} />
          </div>
        )}
      </div>
    </section>
  );
}

function CreateCard({ category, onClose, onSaved }) {
  const [form, setForm] = useState({
    code: "", display_name: "", category, provider_type: "AUTOMATED",
    environment: "SANDBOX",
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
        non_secret_config: {},
      });
      toast.success("Provider added as a disabled draft.");
      onSaved();
    } catch (error) {
      toast.error(errMsg(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="crm-panel">
      <header className="crm-panel-header"><div><h2>Add provider</h2><p>Stores a disabled provider record. It cannot create player payments or post to wallets.</p></div></header>
      <form data-testid="create-form" onSubmit={submit} className="crm-panel-body" style={{ display: "grid", gap: 12, padding: 18 }}>
        <div className="gateway-fields-grid">
          <Field label="Provider code" required value={form.code} onChange={(value) => setForm({ ...form, code: value.toUpperCase().replace(/[^A-Z0-9_]/g, "") })} placeholder="APPROVED_PROVIDER" />
          <Field label="Display name" required value={form.display_name} onChange={(value) => setForm({ ...form, display_name: value })} />
        </div>
        <div className="gateway-card-actions">
          <button type="button" className="gateway-link" onClick={onClose}>Cancel</button>
          <button type="submit" className="crm-text-link" disabled={busy}>{busy ? "Adding…" : "Add provider"}</button>
        </div>
      </form>
    </section>
  );
}
