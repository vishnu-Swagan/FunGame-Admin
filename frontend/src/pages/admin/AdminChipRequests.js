import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { Check, X, HandCoins } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { api, errMsg } from "@/lib/api";
import { PageTransition, EmptyState, formatChips, timeAgo } from "@/components/common";

const FILTERS = ["PENDING", "APPROVED", "DENIED", "ALL"];

const STATUS_CLS = {
  PENDING: "border-primary/35 bg-primary/10 text-primary",
  APPROVED: "border-[hsl(var(--emerald)/0.35)] bg-[hsl(var(--emerald)/0.1)] text-[hsl(var(--emerald))]",
  DENIED: "border-destructive/40 bg-destructive/10 text-red-400",
};

export default function AdminChipRequests() {
  const [filter, setFilter] = useState("PENDING");
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState(null); // {req, type}
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (f) => {
    setLoading(true);
    try {
      const qs = f && f !== "ALL" ? `?status=${f}` : "";
      const { data } = await api.get(`/admin/chip-requests${qs}`);
      // Points removed: only show BUY chip requests, hide legacy SELL→points requests.
      setRequests((data.requests || []).filter((r) => r.type !== "SELL"));
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(filter);
  }, [filter, load]);

  const resolve = async () => {
    if (!action) return;
    setBusy(true);
    try {
      await api.post(`/admin/chip-requests/${action.req.id}/${action.type}`, { note: note || null });
      const isReturn = action.req?.type === "RETURN";
      toast.success(action.type !== "approve" ? "Request denied" : isReturn ? "Chips returned to operator" : "Chips credited to player");
      setAction(null);
      setNote("");
      await load(filter);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <PageTransition className="space-y-4">
      <h1 className="text-2xl font-bold tracking-tight">Chip requests</h1>

      <div className="fg-rail flex gap-2 overflow-x-auto">
        {FILTERS.map((f) => (
          <button
            key={f}
            data-testid={`admin-chip-requests-filter-${f.toLowerCase()}`}
            onClick={() => setFilter(f)}
            className={`shrink-0 rounded-full px-3.5 py-1.5 min-h-[36px] text-xs font-bold border transition-[background-color] duration-150 ${
              filter === f ? "bg-primary text-primary-foreground border-primary" : "bg-white/5 text-white/65 border-white/10 hover:bg-white/10"
            }`}
          >
            {f}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="h-40 rounded-2xl fg-shimmer border border-white/5" />
      ) : requests.length === 0 ? (
        <EmptyState icon={HandCoins} title={`No ${filter.toLowerCase()} requests`} subtitle="Player chip requests appear here for review." />
      ) : (
        <div className="rounded-2xl border border-white/10 overflow-x-auto">
          <Table data-testid="admin-chip-requests-table">
            <TableHeader>
              <TableRow className="border-white/10 hover:bg-transparent">
                <TableHead className="text-white/50">Player</TableHead>
                <TableHead className="text-white/50">Type</TableHead>
                <TableHead className="text-white/50 text-right">Amount</TableHead>
                <TableHead className="text-white/50">Note</TableHead>
                <TableHead className="text-white/50">Status</TableHead>
                <TableHead className="text-white/50">When</TableHead>
                <TableHead className="text-white/50 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {requests.map((r) => (
                <TableRow key={r.id} data-testid="admin-chip-request-row" className="border-white/5 hover:bg-white/5">
                  <TableCell>
                    <p className="font-semibold text-sm">{r.user_display_name || "—"}</p>
                    <p className="text-[11px] text-white/45">{r.user_email}</p>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className={`rounded-full border text-[10px] font-bold px-2.5 py-1 ${r.type === "RETURN" ? "border-[hsl(var(--magenta)/0.4)] bg-[hsl(var(--magenta)/0.1)] text-[hsl(var(--magenta))]" : "border-[hsl(var(--emerald)/0.4)] bg-[hsl(var(--emerald)/0.1)] text-[hsl(var(--emerald))]"}`}>
                      {r.type === "RETURN" ? "RETURN" : "BUY"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums font-bold text-primary">{formatChips(r.amount)}</TableCell>
                  <TableCell className="text-xs text-white/60 max-w-[180px] truncate">{r.note || "—"}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className={`rounded-full border text-[10px] font-bold px-2.5 py-1 ${STATUS_CLS[r.status]}`}>{r.status}</Badge>
                  </TableCell>
                  <TableCell className="text-xs text-white/50">{timeAgo(r.created_at)}</TableCell>
                  <TableCell className="text-right">
                    {r.status === "PENDING" ? (
                      <div className="flex items-center justify-end gap-1.5">
                        <Button
                          data-testid="admin-approve-chip-request-button"
                          size="sm"
                          onClick={() => setAction({ req: r, type: "approve" })}
                          className="h-8 rounded-lg text-xs font-bold bg-[hsl(var(--emerald))] text-black hover:brightness-110"
                        >
                          <Check className="h-3.5 w-3.5 mr-1" /> Approve
                        </Button>
                        <Button
                          data-testid="admin-deny-chip-request-button"
                          size="sm"
                          variant="outline"
                          onClick={() => setAction({ req: r, type: "deny" })}
                          className="h-8 rounded-lg text-xs font-bold border-destructive/40 bg-destructive/10 text-red-400 hover:bg-destructive/20"
                        >
                          <X className="h-3.5 w-3.5 mr-1" /> Deny
                        </Button>
                      </div>
                    ) : (
                      <span className="text-[11px] text-white/40">{r.admin_note || "—"}</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={!!action} onOpenChange={(o) => !o && setAction(null)}>
        <DialogContent className="rounded-2xl border-white/10 bg-card">
          <DialogHeader>
            <DialogTitle>
              {action?.type === "approve"
                ? action?.req?.type === "RETURN" ? "Approve chip return" : "Approve chip request"
                : action?.req?.type === "RETURN" ? "Deny chip return" : "Deny chip request"}
            </DialogTitle>
            <DialogDescription>
              {action?.type === "approve"
                ? action?.req?.type === "RETURN"
                  ? `Deduct ${formatChips(action?.req?.amount)} chips from ${action?.req?.user_email} — returned to the operator. This settles the request permanently.`
                  : `Credit ${formatChips(action?.req?.amount)} play chips to ${action?.req?.user_email}. This settles the request permanently.`
                : `Deny the ${formatChips(action?.req?.amount)} ${action?.req?.type === "RETURN" ? "return" : "chip"} request from ${action?.req?.user_email}.`}
            </DialogDescription>
          </DialogHeader>
          <Textarea
            data-testid="admin-chip-request-note-input"
            placeholder="Note to the player (optional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="rounded-xl bg-white/5 border-white/12"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setAction(null)} className="rounded-xl border-white/15">Cancel</Button>
            <Button
              data-testid="admin-chip-request-confirm-button"
              onClick={resolve}
              disabled={busy}
              className={`rounded-xl font-bold ${action?.type === "approve" ? "bg-[hsl(var(--emerald))] text-black hover:brightness-110" : "bg-destructive text-white hover:brightness-110"}`}
            >
              {busy ? "Working…" : action?.type === "approve" ? (action?.req?.type === "RETURN" ? "Approve & deduct" : "Approve & credit") : "Deny request"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageTransition>
  );
}
