import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { Calculator, PlayCircle, RefreshCw, AlertTriangle } from "lucide-react";
import { api, errMsg } from "@/lib/api";
import { formatChips } from "@/components/common";

/**
 * The night run, and the ledger it writes — the deck's section 4.
 *
 * Nothing here recalculates anything. A settled period is a fact; this screen
 * reads it. Re-settling is possible but is refused rather than silently
 * repeated, so the button says what it will do and the error says why it did
 * not.
 */

const pct = (bps) => (bps / 100).toFixed(bps % 100 === 0 ? 0 : 2);
const yesterday = () => {
  const d = new Date(); d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
};

export default function AdminCommission() {
  const [day, setDay] = useState(yesterday());
  const [runs, setRuns] = useState([]);
  const [entries, setEntries] = useState([]);
  const [revenue, setRevenue] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [r, l] = await Promise.all([
        api.get("/admin/commission/runs"),
        api.get("/admin/commission/ledger"),
      ]);
      setRuns(r.data.runs || []);
      setEntries(l.data.entries || []);
    } catch (e) { toast.error(errMsg(e)); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const loadRevenue = async () => {
    try {
      const { data } = await api.get(`/admin/revenue/${day}`);
      setRevenue(data);
    } catch (e) { toast.error(errMsg(e)); }
  };

  const rebuild = async () => {
    setBusy(true);
    try {
      const { data } = await api.post(`/admin/revenue/${day}/rebuild`);
      toast.success(`${data.message} — ${data.players} player days, ${data.distributors} distributors`);
      loadRevenue();
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };

  const settle = async () => {
    setBusy(true);
    try {
      const { data } = await api.post("/admin/commission/settle", { period_start: day, period_end: day });
      toast.success(`${data.message} — ${formatChips(data.commission)} commission across ${data.distributors}`);
      load();
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-5" data-testid="admin-commission">
      <div>
        <h1 className="font-display text-2xl text-white flex items-center gap-2">
          <Calculator className="h-5 w-5 text-primary" /> Commission
        </h1>
        <p className="text-xs text-white/55 mt-1">
          The night job settles the previous virtual-chip activity day at 02:00. These controls do the
          same thing by hand — safely, because a settled period is refused rather than repeated.
        </p>
      </div>

      <div className="rounded-2xl border border-white/10 bg-card/55 p-4 space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="space-y-1">
            <span className="block text-xs text-white/60">Activity day</span>
            <input type="date" value={day} onChange={(e) => setDay(e.target.value)} data-testid="commission-day"
              className="h-10 rounded-xl bg-white/5 border border-white/12 px-3 text-sm text-white" />
          </label>
          <button onClick={loadRevenue} className="h-10 rounded-xl border border-white/12 bg-white/5 px-3 text-sm font-semibold">
            View revenue
          </button>
          <button onClick={rebuild} disabled={busy} data-testid="commission-rebuild"
            className="h-10 rounded-xl border border-white/12 bg-white/5 px-3 text-sm font-semibold flex items-center gap-1.5 disabled:opacity-50">
            <RefreshCw className="h-3.5 w-3.5" /> Rebuild from ledger
          </button>
          <button onClick={settle} disabled={busy} data-testid="commission-settle"
            className="h-10 rounded-xl bg-primary text-primary-foreground px-4 text-sm font-bold flex items-center gap-1.5 disabled:opacity-50">
            <PlayCircle className="h-4 w-4" /> Settle this day
          </button>
        </div>
        <p className="text-[11px] text-white/40 flex items-start gap-1.5">
          <AlertTriangle className="h-3.5 w-3.5 mt-px shrink-0" />
          Rebuilding recomputes the day's figures from the chip ledger. It is safe to run
          repeatedly — the figures are derived, never accumulated.
        </p>
      </div>

      {revenue && (
        <Panel title={`Revenue · ${revenue.day}`}>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
            <Metric label="Chips played" value={formatChips(revenue.totals.turnover)} />
            <Metric label="Chips returned" value={formatChips(revenue.totals.payout)} />
            <Metric label="Gross result" value={formatChips(revenue.totals.ggr)} />
            <Metric label="Net result" value={formatChips(revenue.totals.ngr)} tone={revenue.totals.ngr < 0 ? "loss" : "win"} />
          </div>
          <Table head={["Distributor", "Players", "Chips played", "Gross result", "Net result"]}
                 rows={revenue.distributors.map((d) => [
                   d.distributor_code || d.distributor_id.slice(0, 8),
                   d.players, formatChips(d.turnover), formatChips(d.ggr), formatChips(d.ngr),
                 ])} />
        </Panel>
      )}

      <Panel title="Settled periods">
        <Table head={["Period", "Distributors", "Net result", "Commission", "Carried", "Status"]}
               rows={runs.map((r) => [
                 r.period_start === r.period_end ? r.period_start : `${r.period_start} → ${r.period_end}`,
                 r.distributors ?? "—",
                 formatChips(r.total_ngr ?? 0),
                 formatChips(r.total_commission ?? 0),
                 formatChips(r.total_carried ?? 0),
                 r.status,
               ])} empty="No periods settled yet." />
      </Panel>

      <Panel title="Commission ledger">
        <Table head={["Period", "Distributor", "Net result", "Carry in", "Rate", "Commission", "Carry out", "Status"]}
               rows={entries.map((e) => [
                 e.period_end,
                 e.distributor_code || e.distributor_id.slice(0, 8),
                 formatChips(e.ngr),
                 formatChips(e.carry_in),
                 `${pct(e.rate_bps)}%${e.rate_source === "EARLIEST_FALLBACK" ? " ⚠" : ""}`,
                 formatChips(e.commission),
                 formatChips(e.carry_out),
                 e.status,
               ])} empty="Nothing accrued yet." />
        <p className="text-[10px] text-white/35 mt-2">
          ⚠ marks a period settled with a fallback rate — no rate was in force for that
          date, so the distributor's earliest rate was used. Worth checking.
        </p>
      </Panel>
    </div>
  );
}

const Panel = ({ title, children }) => (
  <div className="rounded-2xl border border-white/10 bg-card/55 p-4">
    <h2 className="text-sm font-bold text-white/85 mb-3">{title}</h2>
    {children}
  </div>
);

const Metric = ({ label, value, tone }) => (
  <div className="rounded-xl border border-white/10 bg-white/5 p-3">
    <p className="text-[10px] tracking-wider text-white/45">{label}</p>
    <p className={`text-lg font-bold tabular-nums ${
      tone === "loss" ? "text-rose-300" : tone === "win" ? "text-emerald-300" : "text-white"}`}>{value}</p>
  </div>
);

const Table = ({ head, rows, empty }) => (
  <div className="overflow-x-auto">
    {rows.length ? (
      <table className="w-full text-xs">
        <thead>
          <tr className="text-white/45">
            {head.map((h) => <th key={h} className="text-left font-medium py-1.5 pr-4 whitespace-nowrap">{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-white/8">
              {r.map((c, j) => (
                <td key={j} className={`py-1.5 pr-4 whitespace-nowrap ${j === 0 ? "text-white/85 font-medium" : "text-white/70 tabular-nums"}`}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    ) : <p className="text-sm text-white/45">{empty}</p>}
  </div>
);
