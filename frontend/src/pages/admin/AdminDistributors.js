import { useState, useEffect, useCallback, useMemo } from "react";
import { toast } from "sonner";
import { Network, Plus, Percent, Users, Ban, CheckCircle2, KeyRound, X, Download, Search, ChevronDown } from "lucide-react";
import { api, downloadCsv, errCode, errMsg } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { ADMIN_PERMISSIONS, hasPermission } from "@/lib/adminPermissions";
import { DISTRIBUTOR_VERSION_CONFLICT, withExpectedDistributorVersion } from "@/lib/distributorConcurrency";
import AdminStepUpDialog, { requiresAdminStepUp } from "@/components/AdminStepUpDialog";

/**
 * Distributors — the deck's section 1, and the front of the commission engine.
 *
 * Two things on this screen are deliberately awkward, because the underlying
 * rules are: a rate change says out loud that it does not touch settled
 * periods, and a code cannot be edited once players have arrived through it.
 * Both are one-way doors and the screen should read like one.
 */

/** Basis points are what the API speaks; percent is what people speak. */
const pct = (bps) => (bps / 100).toFixed(bps % 100 === 0 ? 0 : 2);

export default function AdminDistributors() {
  const { user } = useAuth();
  const canManage = hasPermission(user, ADMIN_PERMISSIONS.DISTRIBUTORS_MANAGE);
  const canIssueCredentials = hasPermission(user, ADMIN_PERMISSIONS.DISTRIBUTORS_CREDENTIALS);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: "", code: "", username: "", pct: "25", email: "", phone: "", note: "" });
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState(null);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(null);
  const [loginTarget, setLoginTarget] = useState(null);
  const [loginForm, setLoginForm] = useState({ email: "", username: "", password: "" });
  const [editTarget, setEditTarget] = useState(null);
  const [editForm, setEditForm] = useState({ name: "", email: "", phone: "", note: "", username: "" });
  const [detailData, setDetailData] = useState({});
  const [pendingSensitiveAction, setPendingSensitiveAction] = useState(null);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get("/admin/distributors");
      setRows(data.distributors || []);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const reloadAfterVersionConflict = useCallback(async (error) => {
    if (errCode(error) !== DISTRIBUTOR_VERSION_CONFLICT) return false;
    toast.error("This distributor changed in another administrator session. The latest record is loaded; review it and retry.");
    setEditTarget(null);
    setExpanded(null);
    setDetailData({});
    await load();
    return true;
  }, [load]);

  const performSensitiveAction = useCallback(async (action) => {
    if (action.kind === "LOGIN") {
      const { data } = await api.post(
        `/admin/distributors/${action.target.id}/login`,
        action.payload,
      );
      setIssued({ ...data, name: action.target.name });
      setLoginTarget(null);
      await load();
      return;
    }

    const { data } = await api.patch(
      `/admin/distributors/${action.target.id}`,
      action.payload,
    );
    toast.success(data.message);
    setEditTarget(null);
    setDetailData((current) => {
      const next = { ...current };
      delete next[action.target.id];
      return next;
    });
    await load();
  }, [load]);

  const runSensitiveAction = useCallback(async (action) => {
    setBusy(true);
    try {
      await performSensitiveAction(action);
    } catch (error) {
      if (requiresAdminStepUp(error)) {
        // The backend rejects before mutation. Keep an immutable snapshot of the
        // exact intended request, complete step-up, then retry it once.
        setPendingSensitiveAction(action);
      } else if (!(await reloadAfterVersionConflict(error))) {
        toast.error(errMsg(error));
      }
    } finally {
      setBusy(false);
    }
  }, [performSensitiveAction, reloadAfterVersionConflict]);

  const retryPendingSensitiveAction = useCallback(async () => {
    const action = pendingSensitiveAction;
    if (!action) return;
    setBusy(true);
    try {
      await performSensitiveAction(action);
    } catch (error) {
      if (!(await reloadAfterVersionConflict(error))) toast.error(errMsg(error));
    } finally {
      setBusy(false);
    }
  }, [pendingSensitiveAction, performSensitiveAction, reloadAfterVersionConflict]);

  const create = async () => {
    const rate_bps = Math.round(parseFloat(form.pct || "0") * 100);
    if (!form.name.trim() || !form.code.trim()) return toast.error("Name and code are required");
    if (!(rate_bps >= 0 && rate_bps <= 10000)) return toast.error("Commission must be 0–100%");
    setBusy(true);
    try {
      const { data } = await api.post("/admin/distributors", {
        name: form.name.trim(), code: form.code.trim(), rate_bps,
        email: form.email.trim() || null, phone: form.phone.trim() || null,
        note: form.note.trim() || null,
        username: form.username.trim() || null,
      });
      toast.success(data.message);
      setForm({ name: "", code: "", username: "", pct: "25", email: "", phone: "", note: "" });
      setCreating(false);
      load();
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };

  const changeRate = async (d) => {
    const current = pct(d.rate_bps);
    const next = window.prompt(
      `New commission for ${d.code} (percent).\n\n` +
      `This applies from now on. Periods already settled keep the rate they were ` +
      `settled at — statements you have already sent will not change.`, current);
    if (next === null) return;
    const rate_bps = Math.round(parseFloat(next) * 100);
    if (!(rate_bps >= 0 && rate_bps <= 10000)) return toast.error("Commission must be 0–100%");
    try {
      const { data } = await api.patch(`/admin/distributors/${d.id}/rate`, { rate_bps });
      toast.success(data.message);
      load();
    } catch (e) { toast.error(errMsg(e)); }
  };

  /* Credentials are shown once, in a panel rather than a toast, because the
     operator has to copy them somewhere before they close it — a toast that
     dismisses itself would lose a password that cannot be read back. */
  const openLogin = (d) => {
    setLoginTarget(d);
    setLoginForm({
      email: d.email || "",
      username: d.login_username || d.login?.username || d.code,
      password: "",
    });
  };

  const issueLogin = async () => {
    const email = loginForm.email.trim();
    const password = loginForm.password;
    if (!email) return toast.error("A portal email is required");
    if (password && password.length < 12) return toast.error("A temporary password must be at least 12 characters");
    await runSensitiveAction({
      kind: "LOGIN",
      target: { id: loginTarget.id, name: loginTarget.name },
      payload: {
        email,
        username: loginForm.username.trim() || null,
        password: password || null,
        must_change_password: true,
      },
    });
  };

  const setStatus = async (d, status) => {
    try {
      const { data } = await api.patch(
        `/admin/distributors/${d.id}/status`,
        withExpectedDistributorVersion(d, { status }),
      );
      toast.success(data.message);
      load();
    } catch (e) {
      if (!(await reloadAfterVersionConflict(e))) toast.error(errMsg(e));
    }
  };

  const toggleDetail = async (d) => {
    if (expanded === d.id) {
      setExpanded(null);
      return;
    }
    setExpanded(d.id);
    if (detailData[d.id]) return;
    setDetailData((current) => ({ ...current, [d.id]: { loading: true, rates: [], events: [] } }));
    const [detail, rates, audit] = await Promise.allSettled([
      api.get(`/admin/distributors/${d.id}`),
      api.get(`/admin/distributors/${d.id}/rates`),
      api.get(`/admin/distributors/${d.id}/audit`),
    ]);
    setDetailData((current) => ({
      ...current,
      [d.id]: {
        loading: false,
        distributor: detail.status === "fulfilled" ? detail.value.data.distributor : d,
        rates: rates.status === "fulfilled" ? rates.value.data.rates || [] : [],
        events: audit.status === "fulfilled" ? audit.value.data.events || [] : [],
      },
    }));
  };

  const openEdit = (d) => {
    const detail = detailData[d.id]?.distributor || d;
    setEditTarget(detail);
    setEditForm({
      name: detail.name || "",
      email: detail.email || "",
      phone: detail.phone || "",
      note: detail.note || "",
      username: detail.login_username || detail.login?.username || detail.code || "",
    });
  };

  const saveEdit = async () => {
    if (!editForm.name.trim()) return toast.error("Distributor name is required");
    if (!editForm.username.trim()) return toast.error("Portal username is required");
    const changes = {};
    const currentUsername = editTarget.login_username || editTarget.login?.username || editTarget.code || "";
    const name = editForm.name.trim();
    const email = editForm.email.trim().toLowerCase() || null;
    const phone = editForm.phone.trim() || null;
    const note = editForm.note.trim() || null;
    const username = editForm.username.trim();
    if (name !== String(editTarget.name || "").trim()) changes.name = name;
    if (email !== (String(editTarget.email || "").trim().toLowerCase() || null)) changes.email = email;
    if (phone !== (String(editTarget.phone || "").trim() || null)) changes.phone = phone;
    if (note !== (String(editTarget.note || "").trim() || null)) changes.note = note;
    if (username !== currentUsername && canIssueCredentials) changes.username = username;
    if (!Object.keys(changes).length) return toast.info("No distributor changes to save");
    await runSensitiveAction({
      kind: "EDIT",
      target: { id: editTarget.id, name: editTarget.name },
      payload: withExpectedDistributorVersion(editTarget, changes),
    });
  };

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((d) => [d.name, d.code, d.login_username, d.login?.username, d.email, d.phone, d.note, d.status]
      .some((value) => String(value || "").toLowerCase().includes(needle)));
  }, [query, rows]);

  const exportCsv = async () => {
    try {
      await downloadCsv("/admin/distributors/export.csv", "chakri-distributors.csv");
      toast.success("Distributor export downloaded");
    } catch (error) {
      toast.error(errMsg(error));
    }
  };

  return (
    <div className="space-y-5" data-testid="admin-distributors">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl text-white flex items-center gap-2">
            <Network className="h-5 w-5 text-primary" /> Distributors
          </h1>
          <p className="text-xs text-white/55 mt-1">
            Players are attributed by referral code at registration. Anyone arriving
            without a code belongs to the house account.
          </p>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={exportCsv}
            className="flex items-center gap-1.5 rounded-xl border border-white/12 bg-white/5 px-3 py-2 text-sm font-semibold min-h-[40px]">
            <Download className="h-4 w-4" /> Export
          </button>
          {canManage && <button
            data-testid="distributor-new"
            onClick={() => setCreating((v) => !v)}
            className="flex items-center gap-1.5 rounded-xl bg-primary text-primary-foreground font-bold px-3 py-2 text-sm min-h-[40px]"
          >
            <Plus className="h-4 w-4" /> New
          </button>}
        </div>
      </div>

      {creating && (
        <div className="rounded-2xl border border-white/10 bg-card/55 p-4 space-y-3" data-testid="distributor-form">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} placeholder="Northern Agents" />
            <Field label="Referral code" value={form.code} onChange={(v) => setForm({ ...form, code: v.toUpperCase() })}
                   placeholder="NRTH1" hint="4–12 letters or digits. O reads as 0, I and L as 1." />
            <Field label="Commission %" value={form.pct} onChange={(v) => setForm({ ...form, pct: v })} placeholder="25" />
            <Field label="Email (optional)" value={form.email} onChange={(v) => setForm({ ...form, email: v })} />
            <Field label="Phone (optional)" value={form.phone} onChange={(v) => setForm({ ...form, phone: v })} />
            <Field label="Portal username (optional)" value={form.username}
                   onChange={(v) => setForm({ ...form, username: v })}
                   placeholder={form.code || "Independent Login ID"}
                   hint="4–32 letters, numbers, dot, underscore, or hyphen. If blank, the referral code is used." />
            <Field label="Internal note (optional)" value={form.note} onChange={(v) => setForm({ ...form, note: v })}
                   placeholder="Private operator context" />
          </div>
          <div className="flex gap-2">
            <button data-testid="distributor-create" onClick={create} disabled={busy}
              className="rounded-xl bg-primary text-primary-foreground font-bold px-4 py-2 text-sm min-h-[40px] disabled:opacity-50">
              {busy ? "Creating…" : "Create distributor"}
            </button>
            <button onClick={() => setCreating(false)}
              className="rounded-xl border border-white/12 bg-white/5 px-4 py-2 text-sm min-h-[40px]">Cancel</button>
          </div>
        </div>
      )}

      {loginTarget && (
        <div className="rounded-2xl border border-primary/30 bg-primary/8 p-4 space-y-3" data-testid="distributor-login-form">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-bold">Portal credentials for {loginTarget.name}</p>
              <p className="text-[11px] text-white/50">Login ID: <span className="font-mono text-primary">{loginTarget.login_username || loginTarget.login?.username || loginTarget.code}</span> · Sign-in: /distributor/login</p>
            </div>
            <button type="button" aria-label="Close credential form" onClick={() => setLoginTarget(null)}
              className="h-8 w-8 rounded-lg bg-white/5 flex items-center justify-center"><X className="h-4 w-4" /></button>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Portal email" type="email" autoComplete="email" value={loginForm.email} onChange={(v) => setLoginForm({ ...loginForm, email: v })} />
            <Field label="Portal username" value={loginForm.username}
                   onChange={(v) => setLoginForm({ ...loginForm, username: v })}
                   hint="This Login ID is independent from the referral code." />
            <Field label="Temporary password (optional)" value={loginForm.password}
                   onChange={(v) => setLoginForm({ ...loginForm, password: v })}
                   type="password" autoComplete="new-password"
                   placeholder="Leave blank to generate securely"
                   hint="Custom temporary passwords must contain at least 12 characters." />
          </div>
          <button type="button" onClick={issueLogin} disabled={busy}
            className="rounded-xl bg-primary px-4 py-2 text-sm font-bold text-primary-foreground min-h-[40px] disabled:opacity-45">
            {busy ? "Working…" : loginTarget.login_configured || loginTarget.user_id ? "Reset portal login" : "Issue portal login"}
          </button>
          <p className="text-[10px] text-white/45">The distributor must replace the temporary password at first sign-in.</p>
        </div>
      )}

      {editTarget && (
        <div className="rounded-2xl border border-white/12 bg-card/70 p-4 space-y-3" data-testid="distributor-edit-form">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-bold">Edit {editTarget.name}</p>
              <p className="text-[11px] text-white/45">Referral code {editTarget.code} and historical attribution remain unchanged.</p>
            </div>
            <button type="button" aria-label="Close edit form" onClick={() => setEditTarget(null)}
              className="h-8 w-8 rounded-lg bg-white/5 flex items-center justify-center"><X className="h-4 w-4" /></button>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" value={editForm.name} onChange={(v) => setEditForm({ ...editForm, name: v })} />
            <Field label="Portal username" value={editForm.username} onChange={(v) => setEditForm({ ...editForm, username: v })}
                   readOnly={!canIssueCredentials}
                   hint={!canIssueCredentials ? "Credential-management permission is required to change a Login ID." : undefined} />
            <Field label="Email" value={editForm.email} onChange={(v) => setEditForm({ ...editForm, email: v })}
                   readOnly={Boolean(editTarget.user_id) && !canIssueCredentials}
                   hint={editTarget.user_id && !canIssueCredentials ? "Credential-management permission is required to change a linked login email." : undefined} />
            <Field label="Phone" value={editForm.phone} onChange={(v) => setEditForm({ ...editForm, phone: v })} />
            <Field label="Internal note" value={editForm.note} onChange={(v) => setEditForm({ ...editForm, note: v })} />
          </div>
          <button type="button" onClick={saveEdit} disabled={busy}
            className="rounded-xl bg-primary px-4 py-2 text-sm font-bold text-primary-foreground min-h-[40px] disabled:opacity-50">
            {busy ? "Saving…" : "Save distributor"}
          </button>
        </div>
      )}

      {issued && (
        <div className="rounded-2xl border border-emerald-400/30 bg-emerald-400/8 p-4 space-y-2" data-testid="distributor-credentials">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-bold text-emerald-200">Portal login for {issued.name}</p>
              <p className="text-[11px] text-emerald-200/70">{issued.note}</p>
            </div>
            <button onClick={() => setIssued(null)} aria-label="Dismiss"
              className="h-8 w-8 rounded-lg bg-white/5 flex items-center justify-center"><X className="h-4 w-4 text-white/60" /></button>
          </div>
          <div className="grid gap-2 sm:grid-cols-3">
            <Cred label="Login ID" value={issued.login_id} />
            <Cred label="Password" value={issued.password} />
            <Cred label="Portal" value={window.location.origin + "/distributor/login"} />
          </div>
          {issued.must_change_password && <p className="text-[10px] text-emerald-200/70">Password change is required at first sign-in.</p>}
        </div>
      )}

      <label className="relative block">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/35" />
        <input value={query} onChange={(event) => setQuery(event.target.value)}
          aria-label="Search distributors" placeholder="Search name, code, email, phone, note, or status"
          className="h-11 w-full rounded-xl border border-white/12 bg-white/5 pl-10 pr-3 text-sm" />
      </label>

      {loading ? (
        <p className="text-sm text-white/50">Loading…</p>
      ) : (
        <div className="space-y-2">
          {filtered.map((d) => (
            <div key={d.id} data-testid={`distributor-${d.code}`}
                 className="rounded-2xl border border-white/10 bg-card/55 p-4">
              <div className="flex flex-wrap items-center gap-3">
              <button type="button" onClick={() => toggleDetail(d)}
                className="min-w-[160px] flex-1 text-left" aria-expanded={expanded === d.id}>
                <div className="flex items-center gap-2">
                  <span className="font-bold text-white">{d.name}</span>
                  {d.is_house && (
                    <span className="rounded-full border border-white/15 bg-white/5 px-2 py-0.5 text-[9px] tracking-wider text-white/55">HOUSE</span>
                  )}
                  <span className={`rounded-full px-2 py-0.5 text-[9px] tracking-wider ${
                    d.status === "ACTIVE" ? "bg-emerald-500/15 text-emerald-300" : "bg-white/8 text-white/50"}`}>
                    {d.status}
                  </span>
                </div>
                <p className="font-mono text-xs text-primary mt-0.5">
                  {d.code}
                  {!d.is_house && !(d.login_configured || d.user_id) && (
                    <span className="ml-2 font-sans text-[10px] text-white/35">no portal login yet</span>
                  )}
                  <ChevronDown className={`ml-2 inline h-3 w-3 transition-transform ${expanded === d.id ? "rotate-180" : ""}`} />
                </p>
              </button>
              <Stat icon={Users} label="Players" value={d.players} />
              <Stat icon={Percent} label="Commission" value={`${pct(d.rate_bps)}%`} />
              <div className="flex gap-2">
                {!d.is_house && (
                  <>
                    {canManage && <button onClick={() => changeRate(d)} data-testid={`distributor-rate-${d.code}`}
                      className="rounded-lg border border-white/12 bg-white/5 px-3 py-1.5 text-xs font-semibold min-h-[36px]">
                      Change rate
                    </button>}
                    {canIssueCredentials && <button onClick={() => openLogin(d)} data-testid={`distributor-login-${d.code}`}
                      className="rounded-lg border border-white/12 bg-white/5 px-3 py-1.5 text-xs font-semibold min-h-[36px] flex items-center gap-1">
                      <KeyRound className="h-3 w-3" /> {d.login_configured || d.user_id ? "Reset login" : "Portal login"}
                    </button>}
                    {canManage && <button onClick={() => setStatus(d, d.status === "ACTIVE" ? "DISABLED" : "ACTIVE")}
                      className="rounded-lg border border-white/12 bg-white/5 px-3 py-1.5 text-xs font-semibold min-h-[36px] flex items-center gap-1">
                      {d.status === "ACTIVE" ? <><Ban className="h-3 w-3" /> Disable</> : <><CheckCircle2 className="h-3 w-3" /> Activate</>}
                    </button>}
                  </>
                )}
              </div>
              </div>
              {expanded === d.id && (
                <div className="mt-4 border-t border-white/8 pt-4" data-testid={`distributor-detail-${d.code}`}>
                <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <Detail label="Portal username" value={d.login_username || d.login?.username || d.code} />
                  <Detail label="Email" value={d.email || "Not recorded"} />
                  <Detail label="Phone" value={d.phone || "Not recorded"} />
                  <Detail label="Status" value={d.status} />
                  <Detail label="Internal note" value={d.note || "No internal note"} />
                  <Detail label="Created" value={d.created_at ? String(d.created_at).slice(0, 10) : "Unknown"} />
                  <Detail label="Portal access" value={d.login_configured || d.user_id ? "Configured" : "Not configured"} />
                  <Detail label="Distributor ID" value={d.id} mono />
                </dl>
                <div className="mt-4 flex flex-wrap gap-2">
                  {!d.is_house && canManage && <button type="button" onClick={() => openEdit(d)}
                    className="rounded-lg border border-white/12 bg-white/5 px-3 py-2 text-xs font-semibold">Edit profile</button>}
                  <span className="rounded-lg border border-white/8 bg-white/[0.03] px-3 py-2 text-[10px] text-white/45">
                    {detailData[d.id]?.loading
                      ? "Loading rate and audit history…"
                      : `${detailData[d.id]?.rates?.length || 0} rate record(s) · ${detailData[d.id]?.events?.length || 0} audit event(s)`}
                  </span>
                </div>
                {!detailData[d.id]?.loading && (detailData[d.id]?.rates?.length > 0 || detailData[d.id]?.events?.length > 0) && (
                  <div className="mt-4 grid gap-4 lg:grid-cols-2">
                    <HistoryList title="Rate history" rows={(detailData[d.id]?.rates || []).slice(0, 5).map((rate) => ({
                      title: `${pct(rate.rate_bps)}%`,
                      meta: `${String(rate.effective_from || "").slice(0, 10)}${rate.effective_to ? ` → ${String(rate.effective_to).slice(0, 10)}` : " → current"}`,
                    }))} />
                    <HistoryList title="Audit history" rows={(detailData[d.id]?.events || []).slice(0, 5).map((event) => ({
                      title: String(event.action || "Update").replaceAll("_", " "),
                      meta: String(event.created_at || "").slice(0, 16).replace("T", " "),
                    }))} />
                  </div>
                )}
                </div>
              )}
            </div>
          ))}
          {!filtered.length && <p className="text-sm text-white/50">No distributors match this search.</p>}
        </div>
      )}
      <AdminStepUpDialog
        open={Boolean(pendingSensitiveAction)}
        actionLabel={pendingSensitiveAction?.kind === "LOGIN" ? "issuing distributor credentials" : "changing a linked distributor login"}
        onCancel={() => setPendingSensitiveAction(null)}
        onVerified={retryPendingSensitiveAction}
      />
    </div>
  );
}

const Field = ({ label, value, onChange, placeholder, hint, readOnly = false, type = "text", autoComplete }) => (
  <label className="block space-y-1">
    <span className="text-xs text-white/60">{label}</span>
    <input
      value={value}
      type={type}
      autoComplete={autoComplete}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      readOnly={readOnly}
      className="w-full h-10 rounded-xl bg-white/5 border border-white/12 px-3 text-sm text-white read-only:text-white/45 read-only:cursor-not-allowed"
    />
    {hint && <span className="block text-[10px] text-white/40">{hint}</span>}
  </label>
);

const Detail = ({ label, value, mono = false }) => (
  <div className="min-w-0">
    <dt className="text-[10px] uppercase tracking-wider text-white/40">{label}</dt>
    <dd className={`mt-1 break-words text-xs text-white/80 ${mono ? "font-mono" : ""}`}>{value}</dd>
  </div>
);

const HistoryList = ({ title, rows }) => (
  <section className="rounded-xl border border-white/8 bg-black/10 p-3">
    <h3 className="text-[10px] font-bold uppercase tracking-wider text-white/45">{title}</h3>
    <div className="mt-2 space-y-2">
      {rows.map((row, index) => (
        <div key={`${row.title}-${row.meta}-${index}`} className="flex items-center justify-between gap-3 text-xs">
          <span className="text-white/75">{row.title}</span>
          <span className="font-mono text-[10px] text-white/35">{row.meta}</span>
        </div>
      ))}
    </div>
  </section>
);

const Cred = ({ label, value }) => (
  <div className="rounded-xl border border-white/10 bg-black/25 p-2.5">
    <p className="text-[10px] tracking-wider text-white/45">{label}</p>
    <p className="font-mono text-sm text-white break-all select-all">{value}</p>
  </div>
);

const Stat = ({ icon: Icon, label, value }) => (
  <div className="min-w-[92px]">
    <p className="text-[10px] tracking-wider text-white/45 flex items-center gap-1"><Icon className="h-3 w-3" /> {label}</p>
    <p className="text-sm font-bold text-white tabular-nums">{value}</p>
  </div>
);
