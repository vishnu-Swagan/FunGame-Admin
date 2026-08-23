import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { FileText, Download, Printer } from "lucide-react";
import { api, errMsg, downloadCsv } from "@/lib/api";
import { formatChips } from "@/components/common";
import { Card, Money, Pill, Table, pct, shortDate } from "./partnerBits";

/**
 * Settled commission and its processing history.
 *
 * Two things here exist because of how commission actually behaves rather than
 * because they look good on a statement:
 *
 * The rate is printed on every row. It is the rate that period was SETTLED at,
 * which is not necessarily today's — that is the whole reason rates are stored
 * as history — and a statement that omitted it could not be checked.
 *
 * Carried in and carried out are printed too. A losing period produces negative
 * commission that is carried against the next one instead of being invoiced
 * back, so a partner reading "£0 earned" needs to see the figure that will be
 * netted off next month, or the following statement looks like a mistake.
 */
export default function PartnerStatements() {
  const [entries, setEntries] = useState([]);
  const [payouts, setPayouts] = useState([]);
  const [accrued, setAccrued] = useState(0);
  const [paidTotal, setPaidTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [s, p] = await Promise.all([
        api.get("/distributor/statements"),
        api.get("/distributor/payouts"),
      ]);
      setEntries(s.data.entries || []);
      setAccrued(s.data.accrued || 0);
      setPayouts(p.data.payouts || []);
      setPaidTotal(p.data.paid_total || 0);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const exportCsv = async () => {
    try {
      await downloadCsv("/distributor/exports/statements.csv", "statements.csv");
      toast.success("Export downloaded");
    } catch (e) {
      toast.error(errMsg(e));
    }
  };

  return (
    <div className="space-y-5" data-testid="partner-statements">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl text-white flex items-center gap-2">
            <FileText className="h-5 w-5 text-primary" /> My commission
          </h1>
          <p className="text-xs text-white/55 mt-1">
            Each settled period, the recorded rate, and its processing status.
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={exportCsv} data-testid="partner-export-statements"
            className="h-10 rounded-xl border border-white/12 bg-white/5 px-3 text-sm font-semibold flex items-center gap-1.5">
            <Download className="h-3.5 w-3.5" /> CSV
          </button>
          {/* The browser's own print dialogue saves a PDF on every platform the
              app runs on, which is a file a partner can forward to an
              accountant. Generating one server-side would add a rendering
              dependency to produce the same document. */}
          <button onClick={() => window.print()} data-testid="partner-print"
            className="h-10 rounded-xl border border-white/12 bg-white/5 px-3 text-sm font-semibold flex items-center gap-1.5">
            <Printer className="h-3.5 w-3.5" /> PDF
          </button>
        </div>
      </div>

      {loading ? <p className="text-sm text-white/50">Loading…</p> : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-2xl border border-amber-400/25 bg-amber-400/8 p-4">
              <p className="text-xs text-amber-200/80">Accrued commission units</p>
              <p className="text-2xl font-bold text-amber-200 tabular-nums">{formatChips(accrued)}</p>
            </div>
            <div className="rounded-2xl border border-emerald-400/25 bg-emerald-400/8 p-4">
              <p className="text-xs text-emerald-200/80">Processed to date</p>
              <p className="text-2xl font-bold text-emerald-200 tabular-nums">{formatChips(paidTotal)}</p>
            </div>
          </div>

          <Card title="Commission periods" testId="partner-ledger">
            <Table
              head={["Period", "Net result", "Carried in", "Basis", "Rate", "Commission", "Carried out", ""]}
              right={[1, 2, 3, 4, 5, 6]}
              rows={entries.map((e) => [
                e.period_start === e.period_end ? e.period_start : `${e.period_start} → ${e.period_end}`,
                <Money value={e.ngr} />,
                <Money value={e.carry_in} />,
                <Money value={e.basis} />,
                e.is_clawback ? "—" : `${pct(e.rate_bps)}%`,
                <Money value={e.commission} />,
                <Money value={e.carry_out} />,
                <Pill>{e.status}</Pill>,
              ])}
              empty="No periods settled yet. Commission appears the morning after your players first play."
            />
            <p className="text-[10px] text-white/35 mt-2">
              Commission uses the recorded net-result basis after anything carried
              forward. Negative periods reduce the next positive basis; they are not
              charged to a player. Virtual player chips have no cash value.
            </p>
          </Card>

          <Card title="Processing history" testId="partner-payments">
            <Table
              head={["Raised", "Covering", "Units", "Status", "Processed", "Reference"]}
              right={[2]}
              rows={payouts.map((p) => [
                shortDate(p.created_at),
                `${p.period_from} → ${p.period_to}`,
                <Money value={p.amount} />,
                <Pill>{p.status}</Pill>,
                shortDate(p.paid_at),
                p.payment_ref || (p.status === "REJECTED" ? "Returned to accrued" : "—"),
              ])}
              empty="No processing records yet."
            />
            <p className="text-[10px] text-white/35 mt-2">
              A rejected record returns its commission units to the accrued balance
              for a later processing run.
            </p>
          </Card>
        </>
      )}
    </div>
  );
}
