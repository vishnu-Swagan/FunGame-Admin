import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { ShieldCheck, Globe, AlertTriangle, Ban, BadgeCheck, Eye } from "lucide-react";
import { api, errMsg } from "@/lib/api";
import { formatChips } from "@/components/common";

/**
 * The operator's side of the four controls.
 *
 * The screen is built around one hazard: switching a market on is the only
 * action in the whole admin panel that can lock existing players away from a
 * balance they already hold. So the order is deliberate — you preview who it
 * would hit, you see the count, and only then is there a switch to enforce it.
 * Saving the market list on its own changes nothing for existing accounts; that
 * separation is real in the API and is stated here rather than assumed.
 */
const REASONS = {
  MARKET: "Country not in your market list",
  COUNTRY_UNKNOWN: "Country could not be read",
  UNDERAGE: "Below the minimum age",
  NO_DOB: "No usable date of birth",
};

export default function AdminCompliance() {
  const [cfg, setCfg] = useState(null);
  const [review, setReview] = useState(null);
  const [preview, setPreview] = useState(null);
  const [exclusions, setExclusions] = useState([]);
  const [markets, setMarkets] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [c, r, e] = await Promise.all([
        api.get("/admin/compliance/config"),
        api.get("/admin/compliance/review"),
        api.get("/admin/compliance/exclusions"),
      ]);
      setCfg(c.data.config);
      setMarkets((c.data.config.markets || []).join(", "));
      setReview(r.data);
      setExclusions(e.data.exclusions || []);
    } catch (err) { toast.error(errMsg(err)); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const patch = async (body, message) => {
    setBusy(true);
    try {
      const { data } = await api.patch("/admin/compliance/config", body);
      setCfg(data.config);
      toast.success(message || data.message);
      setPreview(null);
      load();
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };

  const runPreview = async () => {
    try {
      const { data } = await api.get("/admin/compliance/preview", {
        params: { market_mode: cfg.market_mode, markets, min_age: cfg.min_age },
      });
      setPreview(data);
      toast.info(`${data.flagged.length} of ${data.checked} players would be affected`);
    } catch (e) { toast.error(errMsg(e)); }
  };

  const lift = async (row) => {
    const reason = window.prompt(
      `Lift the exclusion on ${row.login_id}?\n\n` +
      `This overrides the player's own decision, so the reason is recorded ` +
      `against your account.`);
    if (!reason) return;
    try {
      const { data } = await api.post(`/admin/compliance/players/${row.user_id}/exclusion/lift`, { reason });
      toast.success(data.message);
      load();
    } catch (e) { toast.error(errMsg(e)); }
  };

  const verifyAge = async (userId) => {
    try {
      const { data } = await api.post(`/admin/compliance/players/${userId}/age-verify`, { verified: true });
      toast.success(`${data.message} (age ${data.age})`);
      load();
    } catch (e) { toast.error(errMsg(e)); }
  };

  if (!cfg) return <p className="text-sm text-white/50">Loading…</p>;

  const shown = preview || review;

  return (
    <div className="space-y-5" data-testid="admin-compliance">
      <div>
        <h1 className="font-display text-2xl text-white flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-primary" /> Compliance
        </h1>
        <p className="text-xs text-white/55 mt-1">
          Markets, age, self-exclusion and player limits.
        </p>
      </div>

      {/* --- markets ---------------------------------------------------- */}
      <section className="rounded-2xl border border-white/10 bg-card/55 p-4 space-y-3" data-testid="compliance-markets">
        <h2 className="text-sm font-bold text-white/85 flex items-center gap-2">
          <Globe className="h-4 w-4 text-white/45" /> Markets
        </h2>
        <div className="flex flex-wrap gap-2">
          {["OFF", "ALLOW", "BLOCK"].map((mode) => (
            <button key={mode} onClick={() => setCfg({ ...cfg, market_mode: mode })}
              data-testid={`compliance-mode-${mode}`}
              className={`rounded-xl px-3 py-2 text-xs font-bold min-h-[40px] border ${
                cfg.market_mode === mode
                  ? "bg-primary/15 border-primary/40 text-primary"
                  : "bg-white/5 border-white/12 text-white/60"}`}>
              {mode}
            </button>
          ))}
        </div>
        <p className="text-[11px] text-white/45">
          {cfg.market_mode === "OFF" && "No geographic restriction. Anyone may register and play."}
          {cfg.market_mode === "ALLOW" && "Only the countries listed below may register. A country that cannot be read counts as unlisted."}
          {cfg.market_mode === "BLOCK" && "Everyone may register except the countries listed below."}
        </p>
        <label className="block space-y-1">
          <span className="text-xs text-white/60">Countries (two-letter codes, comma separated)</span>
          <input value={markets} onChange={(e) => setMarkets(e.target.value)} placeholder="GB, IE, IN"
            data-testid="compliance-markets-input"
            className="w-full h-10 rounded-xl bg-white/5 border border-white/12 px-3 text-sm text-white font-mono" />
        </label>
        <div className="flex flex-wrap gap-2">
          <button onClick={runPreview} data-testid="compliance-preview"
            className="rounded-xl border border-white/12 bg-white/5 px-3 py-2 text-sm font-semibold min-h-[40px] flex items-center gap-1.5">
            <Eye className="h-3.5 w-3.5" /> Preview effect
          </button>
          <button onClick={() => patch({
              market_mode: cfg.market_mode,
              markets: markets.split(",").map((s) => s.trim()).filter(Boolean),
            }, "Markets saved. Existing accounts are unchanged until you enforce below.")}
            disabled={busy} data-testid="compliance-save-markets"
            className="rounded-xl bg-primary text-primary-foreground font-bold px-4 py-2 text-sm min-h-[40px] disabled:opacity-50">
            Save markets
          </button>
        </div>
      </section>

      {/* --- who it would hit -------------------------------------------- */}
      <section className="rounded-2xl border border-white/10 bg-card/55 p-4" data-testid="compliance-review">
        <div className="flex items-start justify-between gap-3 mb-2">
          <div>
            <h2 className="text-sm font-bold text-white/85">
              {preview ? "Preview — unsaved settings" : "Under current settings"}
            </h2>
            <p className="text-[11px] text-white/45">
              {shown.flagged.length} of {shown.checked} players flagged
            </p>
          </div>
          {preview && (
            <button onClick={() => setPreview(null)} className="text-[11px] text-white/50">Show saved</button>
          )}
        </div>

        {shown.flagged.length ? (
          <div className="space-y-1.5 max-h-[320px] overflow-y-auto">
            {shown.flagged.map((f) => (
              <div key={f.user_id} className="rounded-xl border border-white/10 bg-white/[0.03] p-2.5 flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs text-white/85 flex-1 min-w-[110px]">{f.login_id}</span>
                <span className="text-[11px] text-white/45">{f.country || "—"} · {f.country_code}</span>
                <span className="text-[11px] text-white/45">{f.age == null ? "age ?" : `${f.age}y`}</span>
                <span className="text-[11px] text-white/45 tabular-nums">{formatChips(f.chip_balance)} chips</span>
                <span className="flex gap-1">
                  {f.reasons.map((r) => (
                    <span key={r} title={REASONS[r] || r}
                      className="rounded-full bg-amber-400/15 text-amber-300 px-2 py-0.5 text-[9px] tracking-wider">{r}</span>
                  ))}
                </span>
                {f.reasons.includes("UNDERAGE") ? null : (
                  <button onClick={() => verifyAge(f.user_id)}
                    className="rounded-lg border border-white/12 bg-white/5 px-2 py-1 text-[11px] font-semibold flex items-center gap-1">
                    <BadgeCheck className="h-3 w-3" /> Verify age
                  </button>
                )}
              </div>
            ))}
          </div>
        ) : <p className="text-sm text-white/45">No players are affected by these settings.</p>}

        <p className="text-[11px] text-white/40 mt-3 flex items-start gap-1.5">
          <AlertTriangle className="h-3.5 w-3.5 mt-px shrink-0" />
          Flagging changes nothing on its own. Existing accounts keep playing until
          you switch enforcement on below — which is the point, because a market
          change would otherwise lock established players away from their balance.
        </p>
      </section>

      {/* --- enforcement ------------------------------------------------- */}
      <section className="rounded-2xl border border-white/10 bg-card/55 p-4 space-y-3" data-testid="compliance-enforcement">
        <h2 className="text-sm font-bold text-white/85">Enforcement</h2>
        <Toggle
          label="Apply the market rules to existing accounts"
          hint={`${review?.flagged.filter((f) => f.reasons.includes("MARKET") || f.reasons.includes("COUNTRY_UNKNOWN")).length || 0} players would be signed out of play`}
          on={cfg.enforce_market_on_login}
          onChange={(v) => patch({ enforce_market_on_login: v })}
          testId="compliance-enforce-market"
        />
        <Toggle
          label="Require age verification before playing"
          hint="New and existing players are held until an operator confirms their age"
          on={cfg.require_age_verification}
          onChange={(v) => patch({ require_age_verification: v })}
          testId="compliance-require-age"
        />
        <div className="grid gap-3 sm:grid-cols-2 pt-1">
          <Num label="Minimum age" value={cfg.min_age}
               onSave={(v) => patch({ min_age: v })} testId="compliance-min-age" />
          <Num label="Reactivation wait (h)" value={cfg.reactivation_cooling_hours}
               onSave={(v) => patch({ reactivation_cooling_hours: v })} testId="compliance-cooling" />
        </div>
        <p className="text-[11px] text-white/40">
          This console has no cash, deposit, payout, or purchase controls. The
          minimum age is enforced at registration; raising it above 18 applies to
          existing accounts only once the market rules are enforced.
        </p>
      </section>

      {/* --- exclusions --------------------------------------------------- */}
      <section className="rounded-2xl border border-white/10 bg-card/55 p-4" data-testid="compliance-exclusions">
        <h2 className="text-sm font-bold text-white/85 flex items-center gap-2 mb-3">
          <Ban className="h-4 w-4 text-white/45" /> Self-exclusions
        </h2>
        {exclusions.length ? (
          <div className="space-y-1.5">
            {exclusions.map((x) => (
              <div key={x.id} className="rounded-xl border border-white/10 bg-white/[0.03] p-2.5 flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs text-white/85 flex-1 min-w-[110px]">{x.login_id || x.user_id.slice(0, 8)}</span>
                <span className="rounded-full bg-white/8 text-white/60 px-2 py-0.5 text-[9px] tracking-wider">{x.kind}</span>
                <span className="text-[11px] text-white/45">
                  {x.ends_at ? `until ${String(x.ends_at).slice(0, 10)}` : "permanent"}
                </span>
                <span className="text-[11px] text-white/40">by {x.source}</span>
                <span className={`rounded-full px-2 py-0.5 text-[9px] tracking-wider ${
                  x.in_force ? "bg-amber-400/15 text-amber-300" : "bg-white/8 text-white/45"}`}>
                  {x.in_force ? "IN FORCE" : x.status}
                </span>
                {x.in_force && (
                  <button onClick={() => lift(x)} data-testid={`compliance-lift-${x.user_id}`}
                    className="rounded-lg border border-white/12 bg-white/5 px-2 py-1 text-[11px] font-semibold">
                    Lift
                  </button>
                )}
              </div>
            ))}
          </div>
        ) : <p className="text-sm text-white/45">Nobody has excluded themselves.</p>}
        <p className="text-[11px] text-white/40 mt-3">
          Lifting overrides a player's own decision and records your reason against
          it. A break that has run its course does not need lifting — the player
          asks to return and waits out the cooling period.
        </p>
      </section>
    </div>
  );
}

const Toggle = ({ label, hint, on, onChange, testId }) => (
  <button onClick={() => onChange(!on)} data-testid={testId}
    className="w-full flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-3 text-left">
    <span>
      <span className="block text-sm font-semibold text-white">{label}</span>
      <span className="block text-[11px] text-white/45">{hint}</span>
    </span>
    <span className={`h-6 w-11 rounded-full shrink-0 relative transition-colors ${on ? "bg-emerald-500" : "bg-white/15"}`}>
      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-[left] ${on ? "left-[22px]" : "left-0.5"}`} />
    </span>
  </button>
);

const Num = ({ label, value, onSave, testId }) => {
  const [v, setV] = useState(value);
  useEffect(() => { setV(value); }, [value]);
  return (
    <label className="block space-y-1">
      <span className="text-xs text-white/60">{label}</span>
      <div className="flex gap-1.5">
        <input type="number" value={v} onChange={(e) => setV(e.target.value)} data-testid={testId}
          className="w-full h-10 rounded-xl bg-white/5 border border-white/12 px-3 text-sm text-white" />
        <button onClick={() => onSave(parseInt(v, 10))}
          className="rounded-xl border border-white/12 bg-white/5 px-3 text-xs font-semibold min-h-[40px]">Set</button>
      </div>
    </label>
  );
};
