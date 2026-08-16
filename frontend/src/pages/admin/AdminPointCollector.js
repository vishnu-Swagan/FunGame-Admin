import { useState, useEffect, useCallback, useMemo } from "react";
import { toast } from "sonner";
import { ArrowDownToLine, Check, X, Search, RefreshCw } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, errMsg } from "@/lib/api";
import { PageTransition } from "@/components/common";

const STATUS_TABS = ["PENDING", "RECEIVED", "REJECTED", "CANCELLED"];

const STATUS_STYLE = {
  PENDING: "text-amber-300 border-amber-400/40 bg-amber-400/10",
  RECEIVED: "text-emerald-300 border-emerald-400/40 bg-emerald-400/10",
  REJECTED: "text-rose-300 border-rose-400/40 bg-rose-400/10",
  CANCELLED: "text-white/50 border-white/15 bg-white/5",
};

function points(value) {
  return Number(value ?? 0).toLocaleString();
}

function when(value) {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

function Stat({ label, value, hint, accent }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
      <p className="text-[11px] uppercase tracking-wider text-white/45">{label}</p>
      <p className={`mt-1 font-display text-2xl ${accent || "text-white"}`}>{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-white/40">{hint}</p>}
    </div>
  );
}

export default function AdminPointCollector() {
  const [collector, setCollector] = useState(null);
  const [configured, setConfigured] = useState(true);
  const [transfers, setTransfers] = useState([]);
  const [status, setStatus] = useState("PENDING");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  // Tracked per row so one settlement in flight cannot double-submit, and so a
  // slow request never disables the whole table.
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    try {
      const [overview, list] = await Promise.all([
        api.get("/admin/point-collector"),
        api.get("/admin/point-collector/transfers", { params: { status } }),
      ]);
      setConfigured(overview.data.configured !== false);
      setCollector(overview.data.collector || null);
      setTransfers(list.data.transfers || []);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    load();
  }, [load]);

  const settle = async (row, accept) => {
    setBusyId(row.id);
    try {
      const action = accept ? "receive" : "reject";
      await api.post(`/admin/point-collector/transfers/${row.id}/${action}`, {});
      toast.success(
        accept
          ? `Received ${points(row.amount)} points from ${row.sender_login_id}`
          : `Rejected ${row.reference_code} and refunded the sender`,
      );
      await load();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusyId(null);
    }
  };

  const visible = useMemo(() => {
    const term = search.trim().toUpperCase();
    if (!term) return transfers;
    return transfers.filter((row) =>
      String(row.sender_login_id || "").toUpperCase().includes(term) ||
      String(row.reference_code || "").toUpperCase().includes(term)
    );
  }, [transfers, search]);

  if (!loading && !configured) {
    return (
      <PageTransition className="space-y-4">
        <h1 className="text-2xl font-bold tracking-tight">Point Collector</h1>
        <div
          data-testid="collector-not-configured"
          className="rounded-2xl border border-amber-400/30 bg-amber-400/[0.06] p-5"
        >
          <p className="font-display text-lg text-amber-200">No collector account yet</p>
          <p className="mt-1 max-w-xl text-sm text-white/60">
            A collector is the single account that receives play points from
            players. It uses a <span className="font-mono">GK</span> ID followed by
            eight digits, it can never send points, and it cannot be signed into
            from the game client. A primary administrator creates it once.
          </p>
        </div>
      </PageTransition>
    );
  }

  return (
    <PageTransition className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <ArrowDownToLine className="h-5 w-5 text-sky-400" />
            Point Collector
          </h1>
          <p className="mt-1 text-sm text-white/55">
            {collector
              ? <>Receiving into <span className="font-mono text-white/80">{collector.login_id}</span>. Players cannot send to any other account.</>
              : "Loading collector…"}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={load}
          data-testid="collector-refresh"
          className="shrink-0 gap-1.5"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Refresh
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="collector-stats">
        <Stat
          label="Available balance"
          value={points(collector?.available_balance)}
          hint="Points held by this account"
          accent="text-emerald-300"
        />
        <Stat
          label="Total received"
          value={points(collector?.received_total)}
          hint={`${points(collector?.received_count)} accepted transfers`}
        />
        <Stat
          label="Awaiting approval"
          value={points(collector?.pending_total)}
          hint={`${points(collector?.pending_count)} pending`}
          accent="text-amber-300"
        />
        <Stat
          label="Senders"
          value={points(collector?.distinct_senders)}
          hint={`${points(collector?.rejected_count)} rejected`}
        />
      </div>

      {/* Pending points are debited from the sender but not yet credited here,
          so neither balance shows them. Say so, rather than let the numbers
          look like they fail to add up. */}
      {Number(collector?.pending_total) > 0 && (
        <p className="text-xs text-amber-300/80" data-testid="collector-escrow-note">
          {points(collector.pending_total)} points are in escrow: already debited
          from senders, not yet added to the balance above. Accept or reject them
          to settle.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1 rounded-full border border-white/10 bg-white/[0.03] p-1">
          {STATUS_TABS.map((tab) => (
            <button
              key={tab}
              data-testid={`collector-tab-${tab.toLowerCase()}`}
              onClick={() => setStatus(tab)}
              className={`rounded-full px-3 py-1.5 text-xs font-semibold transition ${
                status === tab ? "bg-white/10 text-white" : "text-white/50 hover:text-white/80"
              }`}
            >
              {tab.charAt(0) + tab.slice(1).toLowerCase()}
            </button>
          ))}
        </div>
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-white/35" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search player ID or reference"
            data-testid="collector-search"
            className="pl-9"
          />
        </div>
      </div>

      {loading ? (
        <div className="h-64 rounded-2xl fg-shimmer border border-white/5" />
      ) : (
        <div className="rounded-2xl border border-white/10 overflow-x-auto">
          <Table data-testid="collector-transfers-table">
            <TableHeader>
              <TableRow className="border-white/10 hover:bg-transparent">
                <TableHead className="text-white/50">From player</TableHead>
                <TableHead className="text-white/50">Reference</TableHead>
                <TableHead className="text-white/50 text-right">Amount</TableHead>
                <TableHead className="text-white/50">Status</TableHead>
                <TableHead className="text-white/50">Sent</TableHead>
                <TableHead className="text-white/50">Settled</TableHead>
                {status === "PENDING" && <TableHead className="text-white/50 text-right">Action</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.length === 0 && (
                <TableRow className="border-white/5 hover:bg-transparent">
                  <TableCell colSpan={status === "PENDING" ? 7 : 6} className="py-10 text-center text-sm text-white/40">
                    No {status.toLowerCase()} transfers.
                  </TableCell>
                </TableRow>
              )}
              {visible.map((row) => (
                <TableRow key={row.id} data-testid="collector-transfer-row" className="border-white/5 hover:bg-white/5">
                  <TableCell>
                    <p className="font-mono text-sm">{row.sender_login_id || "—"}</p>
                    {row.sender_name && <p className="text-[11px] text-white/45">{row.sender_name}</p>}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-white/60">{row.reference_code}</TableCell>
                  <TableCell className="text-right font-display text-sm">{points(row.amount)}</TableCell>
                  <TableCell>
                    <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold ${STATUS_STYLE[row.status] || STATUS_STYLE.CANCELLED}`}>
                      {row.status}
                    </span>
                  </TableCell>
                  <TableCell className="text-xs text-white/55">{when(row.created_at)}</TableCell>
                  <TableCell className="text-xs text-white/55">{when(row.settled_at)}</TableCell>
                  {status === "PENDING" && (
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1.5">
                        <Button
                          size="sm"
                          disabled={busyId === row.id}
                          onClick={() => settle(row, true)}
                          data-testid="collector-receive"
                          className="h-8 gap-1 bg-emerald-500/90 hover:bg-emerald-500 text-black"
                        >
                          <Check className="h-3.5 w-3.5" />
                          Receive
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busyId === row.id}
                          onClick={() => settle(row, false)}
                          data-testid="collector-reject"
                          className="h-8 gap-1 border-rose-400/40 text-rose-300 hover:bg-rose-500/10"
                        >
                          <X className="h-3.5 w-3.5" />
                          Reject
                        </Button>
                      </div>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </PageTransition>
  );
}
