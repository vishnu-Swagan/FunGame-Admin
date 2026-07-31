import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { Network, Plus, Percent, Users, Ban, CheckCircle2, KeyRound, X } from "lucide-react";
import { api, errMsg } from "@/lib/api";

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
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: "", code: "", pct: "25", email: "", phone: "" });
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState(null);

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

  const create = async () => {
    const rate_bps = Math.round(parseFloat(form.pct || "0") * 100);
    if (!form.name.trim() || !form.code.trim()) return toast.error("Name and code are required");
    if (!(rate_bps >= 0 && rate_bps <= 10000)) return toast.error("Commission must be 0–100%");
    setBusy(true);
    try {
      const { data } = await api.post("/admin/distributors", {
        name: form.name.trim(), code: form.code.trim(), rate_bps,
        email: form.email.trim() || null, phone: form.phone.trim() || null,
      });
      toast.success(data.message);
      setForm({ name: "", code: "", pct: "25", email: "", phone: "" });
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
  const issueLogin = async (d) => {
    const email = window.prompt(
      `Email for ${d.code}'s partner portal login.\n\n` +
      `They sign in at /partner with their code as the Login ID. A password is ` +
      `generated and shown once — it cannot be read back afterwards.`,
      d.email || "");
    if (!email) return;
    try {
      const { data } = await api.post(`/admin/distributors/${d.id}/login`, { email });
      setIssued({ ...data, name: d.name });
      load();
    } catch (e) { toast.error(errMsg(e)); }
  };

  const setStatus = async (d, status) => {
    try {
      const { data } = await api.patch(`/admin/distributors/${d.id}/status`, { status });
      toast.success(data.message);
      load();
    } catch (e) { toast.error(errMsg(e)); }
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
        <button
          data-testid="distributor-new"
          onClick={() => setCreating((v) => !v)}
          className="flex items-center gap-1.5 rounded-xl bg-primary text-primary-foreground font-bold px-3 py-2 text-sm min-h-[40px]"
        >
          <Plus className="h-4 w-4" /> New
        </button>
      </div>

      {creating && (
        <div className="rounded-2xl border border-white/10 bg-card/55 p-4 space-y-3" data-testid="distributor-form">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} placeholder="Northern Agents" />
            <Field label="Referral code" value={form.code} onChange={(v) => setForm({ ...form, code: v.toUpperCase() })}
                   placeholder="NRTH1" hint="4–12 letters or digits. O reads as 0, I and L as 1." />
            <Field label="Commission %" value={form.pct} onChange={(v) => setForm({ ...form, pct: v })} placeholder="25" />
            <Field label="Email (optional)" value={form.email} onChange={(v) => setForm({ ...form, email: v })} />
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
            <Cred label="Portal" value={window.location.origin + issued.portal_url} />
          </div>
        </div>
      )}

      {loading ? (
        <p className="text-sm text-white/50">Loading…</p>
      ) : (
        <div className="space-y-2">
          {rows.map((d) => (
            <div key={d.id} data-testid={`distributor-${d.code}`}
                 className="rounded-2xl border border-white/10 bg-card/55 p-4 flex flex-wrap items-center gap-3">
              <div className="min-w-[160px] flex-1">
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
                  {!d.is_house && !d.user_id && (
                    <span className="ml-2 font-sans text-[10px] text-white/35">no portal login yet</span>
                  )}
                </p>
              </div>
              <Stat icon={Users} label="Players" value={d.players} />
              <Stat icon={Percent} label="Commission" value={`${pct(d.rate_bps)}%`} />
              <div className="flex gap-2">
                {!d.is_house && (
                  <>
                    <button onClick={() => changeRate(d)} data-testid={`distributor-rate-${d.code}`}
                      className="rounded-lg border border-white/12 bg-white/5 px-3 py-1.5 text-xs font-semibold min-h-[36px]">
                      Change rate
                    </button>
                    <button onClick={() => issueLogin(d)} data-testid={`distributor-login-${d.code}`}
                      className="rounded-lg border border-white/12 bg-white/5 px-3 py-1.5 text-xs font-semibold min-h-[36px] flex items-center gap-1">
                      <KeyRound className="h-3 w-3" /> {d.user_id ? "Reset login" : "Portal login"}
                    </button>
                    <button onClick={() => setStatus(d, d.status === "ACTIVE" ? "SUSPENDED" : "ACTIVE")}
                      className="rounded-lg border border-white/12 bg-white/5 px-3 py-1.5 text-xs font-semibold min-h-[36px] flex items-center gap-1">
                      {d.status === "ACTIVE" ? <><Ban className="h-3 w-3" /> Suspend</> : <><CheckCircle2 className="h-3 w-3" /> Activate</>}
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
          {!rows.length && <p className="text-sm text-white/50">No distributors yet.</p>}
        </div>
      )}
    </div>
  );
}

const Field = ({ label, value, onChange, placeholder, hint }) => (
  <label className="block space-y-1">
    <span className="text-xs text-white/60">{label}</span>
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full h-10 rounded-xl bg-white/5 border border-white/12 px-3 text-sm text-white"
    />
    {hint && <span className="block text-[10px] text-white/40">{hint}</span>}
  </label>
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
