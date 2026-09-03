import { useCallback, useEffect, useState } from "react";
import { Gift, RefreshCw, Save } from "lucide-react";
import { toast } from "sonner";
import { api, errMsg } from "@/lib/api";
import { PageTransition } from "@/components/common";

const FIELDS = [
  ["free_cash_claim_inr", "Claim threshold", "The Free Cash balance needed before a player can claim."],
  ["free_cash_register_min", "Registration reward minimum", "Minimum virtual Free Cash for qualifying new-device registration."],
  ["free_cash_register_max", "Registration reward maximum", "Maximum virtual Free Cash for qualifying new-device registration."],
  ["free_cash_deposit_min", "Deposit reward minimum", "Minimum virtual Free Cash when a referred friend deposits."],
  ["free_cash_deposit_max", "Deposit reward maximum", "Maximum virtual Free Cash when a referred friend deposits."],
  ["bonus_amount_inr", "Deposit bonus amount", "Virtual-chip bonus amount for the existing deposit campaign."],
  ["bonus_wager_multiplier", "Bonus wager multiplier", "Required stake multiplier for the deposit bonus."],
  ["deposit_wager_multiplier", "Deposit wager multiplier", "Required stake multiplier for deposit-backed withdrawals to unlock."],
  ["bonus_duration_hours", "Bonus duration (hours)", "Active duration for an eligible deposit bonus (1–720 hours)."],
];

const DEFAULTS = { deposit_wager_multiplier: 1, bonus_amount_inr: 500, bonus_wager_multiplier: 30, bonus_duration_hours: 84, bonus_on: "first_deposit", free_cash_claim_inr: 200, free_cash_register_min: 0.01, free_cash_register_max: 20, free_cash_deposit_min: 0.01, free_cash_deposit_max: 20 };

export default function AdminFreeCash() {
  const [settings, setSettings] = useState(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try { const { data } = await api.get("/admin/promo/settings"); setSettings((current) => ({ ...current, ...data })); }
    catch (error) { toast.error(errMsg(error)); } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const update = (key, value) => setSettings((current) => ({ ...current, [key]: value }));
  const save = async (event) => {
    event.preventDefault(); setBusy(true);
    try {
      const payload = Object.fromEntries(Object.entries(settings).map(([key, value]) => [key, key === "bonus_on" ? value : Number(value)]));
      const { data } = await api.patch("/admin/promo/settings", payload);
      setSettings((current) => ({ ...current, ...data })); toast.success("Free Cash settings saved");
    } catch (error) { toast.error(errMsg(error)); } finally { setBusy(false); }
  };
  return (<PageTransition className="space-y-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h1 className="font-display text-2xl text-white flex items-center gap-2"><Gift className="h-5 w-5 text-primary" /> Free Cash &amp; promotions</h1>
      <p className="text-xs text-white/55 mt-1">Configure referral Free Cash and the existing deposit wager campaign. This product uses virtual chips only; these settings do not activate payments or cash movement.</p></div>
      <button type="button" onClick={load} disabled={loading || busy} className="h-10 rounded-xl border border-white/12 bg-white/5 px-3 text-sm font-semibold flex items-center gap-1.5 disabled:opacity-50"><RefreshCw className="h-3.5 w-3.5" /> Refresh</button>
    </div>
    {loading ? <div className="h-64 rounded-2xl fg-shimmer border border-white/5" /> : (<form onSubmit={save} className="rounded-2xl border border-white/10 bg-card/55 p-4 space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        {FIELDS.map(([key, label, help]) => (<label key={key} className="space-y-1.5"><span className="block text-sm font-semibold text-white/85">{label}</span><input type="number" min="0" step="any" value={settings[key]} onChange={(event) => update(key, event.target.value)} className="h-10 w-full rounded-xl bg-white/5 border border-white/12 px-3 text-sm text-white" data-testid={`free-cash-${key}`} /><span className="block text-[11px] text-white/40">{help}</span></label>))}
        <label className="space-y-1.5"><span className="block text-sm font-semibold text-white/85">Deposit bonus eligibility</span><select value={settings.bonus_on} onChange={(event) => update("bonus_on", event.target.value)} className="h-10 w-full rounded-xl bg-white/5 border border-white/12 px-3 text-sm text-white" data-testid="free-cash-bonus-on"><option value="first_deposit">First deposit only</option><option value="every_deposit">Every deposit</option><option value="off">Off</option></select><span className="block text-[11px] text-white/40">Controls the existing virtual-chip deposit campaign.</span></label>
      </div>
      <div className="flex justify-end border-t border-white/8 pt-4"><button type="submit" disabled={busy} data-testid="free-cash-save" className="h-10 rounded-xl bg-primary text-primary-foreground px-4 text-sm font-bold flex items-center gap-1.5 disabled:opacity-50"><Save className="h-4 w-4" /> {busy ? "Saving…" : "Save settings"}</button></div>
    </form>)}
  </PageTransition>);
}
