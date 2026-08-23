import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { TrendingUp, Download } from "lucide-react";
import { api, errMsg, downloadCsv } from "@/lib/api";
import { formatChips } from "@/components/common";
import { Card, Metric, Money, Table } from "./partnerBits";

/**
 * Day-by-day attributed virtual-chip activity for a chosen range.
 *
 * The deductions between GGR and NGR are shown as their own columns rather than
 * summarised into one "adjustments" figure. NGR is what commission is paid on,
 * so a partner is entitled to see what came off it — and a partner who can
 * reconcile the drop themselves does not open a ticket about it.
 */
const today = () => new Date().toISOString().slice(0, 10);
const monthStart = () => today().slice(0, 8) + "01";

export default function PartnerRevenue() {
  const [frm, setFrm] = useState(monthStart());
  const [to, setTo] = useState(today());
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (from, until) => {
    setBusy(true);
    try {
      const { data } = await api.get("/distributor/daily", { params: { frm: from, to: until } });
      setData(data);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { load(monthStart(), today()); }, [load]);

  const exportCsv = async () => {
    try {
      await downloadCsv(`/distributor/exports/daily.csv?frm=${frm}&to=${to}`, `revenue-${frm}-to-${to}.csv`);
      toast.success("Export downloaded");
    } catch (e) {
      toast.error(errMsg(e));
    }
  };

  const t = data?.totals;

  return (
    <div className="space-y-5" data-testid="partner-revenue">
      <div>
        <h1 className="font-display text-2xl text-white flex items-center gap-2">
          <TrendingUp className="h-5 w-5 text-primary" /> Reports
        </h1>
        <p className="text-xs text-white/55 mt-1">
          Daily virtual-chip activity attributed to your distributor code and the
          recorded basis used for commission reporting.
        </p>
      </div>

      <Card testId="partner-revenue-range">
        <div className="flex flex-wrap items-end gap-3">
          <label className="space-y-1">
            <span className="block text-xs text-white/60">From</span>
            <input type="date" value={frm} onChange={(e) => setFrm(e.target.value)} data-testid="partner-range-from"
              className="h-10 rounded-xl bg-white/5 border border-white/12 px-3 text-sm text-white" />
          </label>
          <label className="space-y-1">
            <span className="block text-xs text-white/60">To</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} data-testid="partner-range-to"
              className="h-10 rounded-xl bg-white/5 border border-white/12 px-3 text-sm text-white" />
          </label>
          <button onClick={() => load(frm, to)} disabled={busy} data-testid="partner-range-apply"
            className="h-10 rounded-xl bg-primary text-primary-foreground px-4 text-sm font-bold disabled:opacity-50">
            {busy ? "Loading…" : "Show"}
          </button>
          <button onClick={exportCsv} data-testid="partner-export-daily"
            className="h-10 rounded-xl border border-white/12 bg-white/5 px-3 text-sm font-semibold flex items-center gap-1.5">
            <Download className="h-3.5 w-3.5" /> CSV
          </button>
        </div>
      </Card>

      {t && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Metric label="CHIPS PLAYED" value={formatChips(t.turnover)} hint={`${data.players} player${data.players === 1 ? "" : "s"}`} />
          <Metric label="CHIPS RETURNED" value={formatChips(t.payout)} hint={`${t.bets} rounds`} />
          <Metric label="GROSS RESULT" value={<Money value={t.ggr} />} />
          <Metric label="NET RESULT" value={<Money value={t.ngr} />} tone={t.ngr < 0 ? "loss" : "win"} hint="Commission basis" />
        </div>
      )}

      <Card title={data ? `${data.from} → ${data.to}` : "Days"} testId="partner-revenue-table">
        <Table
          head={["Day", "Players", "Rounds", "Chips played", "Chips returned", "Gross", "Adjustments", "Net"]}
          right={[1, 2, 3, 4, 5, 6, 7]}
          rows={(data?.days || []).map((r) => {
            const deductions = (r.bonus_cost || 0) + (r.duty || 0) + (r.gateway_fee || 0) + (r.platform_fee || 0);
            return [
              r.day, r.players, r.bets,
              formatChips(r.turnover), formatChips(r.payout),
              <Money value={r.ggr} />,
              deductions ? formatChips(deductions) : "—",
              <Money value={r.ngr} />,
            ];
          })}
          empty="No play in this range."
        />
        <p className="text-[10px] text-white/35 mt-2">
          Voided rounds are excluded. Adjustments are the recorded bonus-chip and
          platform entries frozen when the day was calculated. Player chips have no cash value.
        </p>
      </Card>
    </div>
  );
}
