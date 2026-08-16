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
import { IS_ADMIN_CONSOLE } from "@/lib/adminConsole";
import { PageTransition, EmptyState, formatChips, timeAgo } from "@/components/common";

const FILTERS = ["PENDING", "APPROVED", "DENIED", "ALL"];

const STATUS_CLS = {
  PENDING: "border-primary/35 bg-primary/10 text-primary",
  APPROVED: "border-[hsl(var(--emerald)/0.35)] bg-[hsl(var(--emerald)/0.1)] text-[hsl(var(--emerald))]",
  DENIED: "border-destructive/40 bg-destructive/10 text-red-400",
};

const REQUESTS_PATH = IS_ADMIN_CONSOLE ? "/admin/point-requests" : "/admin/chip-requests";
const requestPlayerId = (request) =>
  request.user_login_id || request.player_login_id || request.login_id || request.user_email || "—";
const requestPlayerName = (request) =>
  request.user_display_name || request.player_display_name || request.display_name || "—";

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
      const { data } = await api.get(`${REQUESTS_PATH}${qs}`);
      const listed = data.point_requests || data.requests || [];
      // The legacy player host can still render its historic purchase records;
      // the Supabase console only handles virtual play-point grants.
      setRequests(IS_ADMIN_CONSOLE ? listed : listed.filter((r) => r.type !== "SELL"));
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
      await api.post(`${REQUESTS_PATH}/${action.req.id}/${action.type}`, { note: note || null });
      const isLegacyReturn = !IS_ADMIN_CONSOLE && action.req?.type === "RETURN";
      toast.success(
        action.type !== "approve"
          ? "Request denied"
          : IS_ADMIN_CONSOLE
            ? "Play points credited to player"
            : isLegacyReturn ? "Chips returned to operator" : "Chips credited to player"
      );
      setAction(null);
      setNote("");
      await load(filter);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const isLegacyReturn = !IS_ADMIN_CONSOLE && action?.req?.type === "RETURN";
  const actionPlayer = action ? requestPlayerId(action.req) : "the player";

  return (
    <PageTransition className="space-y-4">
      <h1 className="text-2xl font-bold tracking-tight">{IS_ADMIN_CONSOLE ? "Play point requests" : "Chip requests"}</h1>

      <div className="fg-rail flex gap-2 overflow-x-auto">
        {FILTERS.map((f) => (
          <button
            key={f}
            data-testid={`admin-${IS_ADMIN_CONSOLE ? "point" : "chip"}-requests-filter-${f.toLowerCase()}`}
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
        <EmptyState
          icon={HandCoins}
          title={`No ${filter.toLowerCase()} requests`}
          subtitle={`Player ${IS_ADMIN_CONSOLE ? "play-point" : "chip"} requests appear here for review.`}
        />
      ) : (
        <div className="rounded-2xl border border-white/10 overflow-x-auto">
          <Table data-testid={`admin-${IS_ADMIN_CONSOLE ? "point" : "chip"}-requests-table`}>
            <TableHeader>
              <TableRow className="border-white/10 hover:bg-transparent">
                <TableHead className="text-white/50">Player</TableHead>
                <TableHead className="text-white/50">{IS_ADMIN_CONSOLE ? "Request" : "Type"}</TableHead>
                <TableHead className="text-white/50 text-right">{IS_ADMIN_CONSOLE ? "Play points" : "Amount"}</TableHead>
                <TableHead className="text-white/50">Note</TableHead>
                <TableHead className="text-white/50">Status</TableHead>
                <TableHead className="text-white/50">When</TableHead>
                <TableHead className="text-white/50 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {requests.map((r) => (
                <TableRow key={r.id} data-testid={`admin-${IS_ADMIN_CONSOLE ? "point" : "chip"}-request-row`} className="border-white/5 hover:bg-white/5">
                  <TableCell>
                    <p className="font-semibold text-sm">{requestPlayerName(r)}</p>
                    <p className="text-[11px] text-white/45">{requestPlayerId(r)}</p>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className={`rounded-full border text-[10px] font-bold px-2.5 py-1 ${!IS_ADMIN_CONSOLE && r.type === "RETURN" ? "border-[hsl(var(--magenta)/0.4)] bg-[hsl(var(--magenta)/0.1)] text-[hsl(var(--magenta))]" : "border-[hsl(var(--emerald)/0.4)] bg-[hsl(var(--emerald)/0.1)] text-[hsl(var(--emerald))]"}`}>
                      {IS_ADMIN_CONSOLE ? "PLAY POINTS" : r.type === "RETURN" ? "RETURN" : "BUY"}
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
                          data-testid={`admin-approve-${IS_ADMIN_CONSOLE ? "point" : "chip"}-request-button`}
                          size="sm"
                          onClick={() => setAction({ req: r, type: "approve" })}
                          className="h-8 rounded-lg text-xs font-bold bg-[hsl(var(--emerald))] text-black hover:brightness-110"
                        >
                          <Check className="h-3.5 w-3.5 mr-1" /> Approve
                        </Button>
                        <Button
                          data-testid={`admin-deny-${IS_ADMIN_CONSOLE ? "point" : "chip"}-request-button`}
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
                ? IS_ADMIN_CONSOLE ? "Approve play-point request" : isLegacyReturn ? "Approve chip return" : "Approve chip request"
                : IS_ADMIN_CONSOLE ? "Deny play-point request" : isLegacyReturn ? "Deny chip return" : "Deny chip request"}
            </DialogTitle>
            <DialogDescription>
              {action?.type === "approve"
                ? IS_ADMIN_CONSOLE
                  ? `Credit ${formatChips(action?.req?.amount)} virtual play points to ${actionPlayer}. This settles the request permanently.`
                  : isLegacyReturn
                    ? `Deduct ${formatChips(action?.req?.amount)} chips from ${actionPlayer} — returned to the operator. This settles the request permanently.`
                    : `Credit ${formatChips(action?.req?.amount)} play chips to ${actionPlayer}. This settles the request permanently.`
                : `Deny the ${formatChips(action?.req?.amount)} ${IS_ADMIN_CONSOLE ? "play-point" : isLegacyReturn ? "return" : "chip"} request from ${actionPlayer}.`}
            </DialogDescription>
          </DialogHeader>
          <Textarea
            data-testid={`admin-${IS_ADMIN_CONSOLE ? "point" : "chip"}-request-note-input`}
            placeholder="Note to the player (optional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="rounded-xl bg-white/5 border-white/12"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setAction(null)} className="rounded-xl border-white/15">Cancel</Button>
            <Button
              data-testid={`admin-${IS_ADMIN_CONSOLE ? "point" : "chip"}-request-confirm-button`}
              onClick={resolve}
              disabled={busy}
              className={`rounded-xl font-bold ${action?.type === "approve" ? "bg-[hsl(var(--emerald))] text-black hover:brightness-110" : "bg-destructive text-white hover:brightness-110"}`}
            >
              {busy ? "Working…" : action?.type === "approve" ? (isLegacyReturn ? "Approve & deduct" : "Approve & credit") : "Deny request"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageTransition>
  );
}
