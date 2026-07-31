import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { Banknote, Check, X, Send, Undo2 } from "lucide-react";
import { api, errMsg } from "@/lib/api";
import { formatChips } from "@/components/common";

/**
 * The payout queue — where commission earned becomes money sent.
 *
 * Every action here is one the operator has to be able to defend later, so
 * each asks for what it needs rather than accepting a click: a rejection
 * without a reason and a payment without a reference are both refused by the
 * API, and the screen collects them rather than letting the call fail.
 */
export default function AdminPayouts() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get("/admin/payouts");
      setRows(data.payouts || []);
    } catch (e) { toast.error(errMsg(e)); } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const build = async () => {
    setBusy(true);
    try {
      const { data } = await api.post("/admin/payouts/build");
      toast.success(data.message, { description: data.note });
      load();
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };

  const act = async (p, kind) => {
    let body = {};
    if (kind === "reject") {
      const reason = window.prompt(
        `Why is this payout being rejected?\n\n` +
        `The commission returns to the pool and can be paid on a later run — this ` +
        `is not a write-off.`);
      if (!reason) return;
      body = { note: reason };
    }
    if (kind === "paid") {
      const ref = window.prompt(
        `Payment reference for ${formatChips(p.amount)} to ${p.distributor_code}.\n\n` +
        `A payment nobody can trace is a payment nobody can prove — this is what ` +
        `reconciles it against the bank statement.`);
      if (!ref) return;
      body = { payment_ref: ref };
    }
    try {
      const { data } = await api.post(`/admin/payouts/${p.id}/${kind}`, body);
      toast.success(data.message);
      load();
    } catch (e) { toast.error(errMsg(e)); }
  };

  const pending = rows.filter((r) => r.status === "PENDING");
  const pendingTotal = pending.reduce((t, r) => t + r.amount, 0);

  return (
    <div className="space-y-5" data-testid="admin-payouts">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="font-display text-2xl text-white flex items-center gap-2">
            <Banknote className="h-5 w-5 text-primary" /> Payouts
          </h1>
          <p className="text-xs text-white/55 mt-1">
            Commission inside the holdback period, or under the minimum, stays accrued
            and is picked up by a later run.
          </p>
        </div>
        <button onClick={build} disabled={busy} data-testid="payouts-build"
          className="rounded-xl bg-primary text-primary-foreground font-bold px-4 py-2 text-sm min-h-[40px] disabled:opacity-50">
          {busy ? "Building…" : "Raise payouts"}
        </button>
      </div>

      {pending.length > 0 && (
        <div className="rounded-2xl border border-amber-400/25 bg-amber-400/8 p-4">
          <p className="text-xs text-amber-200/80">Awaiting approval</p>
          <p className="text-2xl font-bold text-amber-200 tabular-nums">{formatChips(pendingTotal)}</p>
          <p className="text-[11px] text-amber-200/60 mt-0.5">{pending.length} payout{pending.length === 1 ? "" : "s"}</p>
        </div>
      )}

      {loading ? <p className="text-sm text-white/50">Loading…</p> : (
        <div className="space-y-2">
          {rows.map((p) => (
            <div key={p.id} data-testid={`payout-${p.id}`}
                 className="rounded-2xl border border-white/10 bg-card/55 p-4 flex flex-wrap items-center gap-3">
              <div className="min-w-[150px] flex-1">
                <p className="font-bold text-white">{p.distributor_name || p.distributor_code}</p>
                <p className="font-mono text-[11px] text-white/45">
                  {p.period_from} → {p.period_to} · {p.entry_count} period{p.entry_count === 1 ? "" : "s"}
                </p>
              </div>
              <p className="text-lg font-bold text-white tabular-nums min-w-[90px]">{formatChips(p.amount)}</p>
              <span className={`rounded-full px-2 py-0.5 text-[9px] tracking-wider ${{
                PENDING: "bg-amber-400/15 text-amber-300",
                APPROVED: "bg-sky-400/15 text-sky-300",
                PAID: "bg-emerald-500/15 text-emerald-300",
                REJECTED: "bg-white/8 text-white/45",
              }[p.status] || "bg-white/8 text-white/45"}`}>{p.status}</span>
              <div className="flex gap-2">
                {p.status === "PENDING" && (
                  <>
                    <Btn onClick={() => act(p, "approve")} icon={Check} label="Approve" testId={`payout-approve-${p.id}`} />
                    <Btn onClick={() => act(p, "reject")} icon={X} label="Reject" />
                  </>
                )}
                {p.status === "APPROVED" && (
                  <>
                    <Btn onClick={() => act(p, "paid")} icon={Send} label="Mark paid" testId={`payout-paid-${p.id}`} />
                    <Btn onClick={() => act(p, "reject")} icon={Undo2} label="Return to pool" />
                  </>
                )}
                {p.status === "PAID" && p.payment_ref && (
                  <span className="font-mono text-[11px] text-white/45">ref {p.payment_ref}</span>
                )}
                {p.status === "REJECTED" && p.rejected_reason && (
                  <span className="text-[11px] text-white/45 max-w-[220px] truncate">{p.rejected_reason}</span>
                )}
              </div>
            </div>
          ))}
          {!rows.length && (
            <p className="text-sm text-white/50">
              No payouts raised. Commission accrues as periods settle; use “Raise payouts”
              once there is something past the holdback.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

const Btn = ({ onClick, icon: Icon, label, testId }) => (
  <button onClick={onClick} data-testid={testId}
    className="rounded-lg border border-white/12 bg-white/5 px-3 py-1.5 text-xs font-semibold min-h-[36px] flex items-center gap-1">
    <Icon className="h-3 w-3" /> {label}
  </button>
);
