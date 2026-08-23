import { useCallback, useEffect, useMemo, useState } from "react";
import { ListChecks } from "lucide-react";
import { toast } from "sonner";
import { api, errMsg } from "@/lib/api";
import { Card, Money, Pill, Table, shortDate } from "./partnerBits";

export default function PartnerTransactions() {
  const [entries, setEntries] = useState([]);
  const [processing, setProcessing] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [ledger, records] = await Promise.all([
        api.get("/distributor/statements"),
        api.get("/distributor/payouts"),
      ]);
      setEntries(ledger.data.entries || []);
      setProcessing(records.data.payouts || []);
    } catch (error) {
      toast.error(errMsg(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const rows = useMemo(() => [
    ...entries.map((entry) => ({
      id: `ledger-${entry.id || entry.period_end}`,
      at: entry.settled_at || entry.created_at || entry.period_end,
      kind: "Commission settled",
      period: entry.period_start === entry.period_end ? entry.period_start : `${entry.period_start} → ${entry.period_end}`,
      units: entry.commission,
      status: entry.status,
    })),
    ...processing.map((record) => ({
      id: `processing-${record.id}`,
      at: record.paid_at || record.approved_at || record.created_at,
      kind: "Commission processing",
      period: `${record.period_from} → ${record.period_to}`,
      units: record.amount,
      status: record.status,
    })),
  ].sort((a, b) => String(b.at || "").localeCompare(String(a.at || ""))), [entries, processing]);

  return (
    <div className="space-y-5" data-testid="partner-transactions">
      <div>
        <h1 className="font-display text-2xl text-white flex items-center gap-2">
          <ListChecks className="h-5 w-5 text-primary" /> Transactions
        </h1>
        <p className="mt-1 text-xs text-white/55">Read-only commission ledger and processing events for your distributor account.</p>
      </div>

      {loading ? <p className="text-sm text-white/50">Loading…</p> : (
        <Card testId="partner-transactions-table">
          <Table
            head={["Date", "Record", "Period", "Commission units", "Status"]}
            right={[3]}
            rows={rows.map((row) => [
              shortDate(row.at),
              row.kind,
              row.period,
              <Money value={row.units} />,
              <Pill>{row.status}</Pill>,
            ])}
            empty="No commission activity has been recorded yet."
          />
        </Card>
      )}

      <p className="text-[11px] leading-relaxed text-white/40">
        This portal does not provide a player wallet or game access. Virtual player chips have no cash value and cannot be purchased, withdrawn, transferred, exchanged, or redeemed.
      </p>
    </div>
  );
}
