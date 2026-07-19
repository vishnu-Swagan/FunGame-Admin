import { useState, useEffect, useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { UserCheck, UserX, Ban, RotateCcw, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { api, errMsg } from "@/lib/api";
import { PageTransition, UserStatusBadge, EmptyState, formatChips, timeAgo, AvatarBadge } from "@/components/common";

const FILTERS = ["PENDING", "ACTIVE", "SUSPENDED", "REJECTED", "ALL"];

export default function AdminUsers() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initial = searchParams.get("status") || "PENDING";
  const [filter, setFilter] = useState(FILTERS.includes(initial) ? initial : "PENDING");
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [rejectTarget, setRejectTarget] = useState(null);
  const [rejectNote, setRejectNote] = useState("");
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async (f) => {
    setLoading(true);
    try {
      const qs = f && f !== "ALL" ? `?status=${f}` : "";
      const { data } = await api.get(`/admin/users${qs}`);
      setUsers(data.users || []);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(filter);
  }, [filter, load]);

  const act = async (userId, action, body = {}) => {
    setBusyId(userId);
    try {
      await api.post(`/admin/users/${userId}/${action}`, body);
      toast.success(`User ${action}d`);
      await load(filter);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusyId(null);
    }
  };

  const confirmReject = async () => {
    if (!rejectTarget) return;
    await act(rejectTarget.id, "reject", { note: rejectNote || null });
    setRejectTarget(null);
    setRejectNote("");
  };

  return (
    <PageTransition className="space-y-4">
      <h1 className="text-2xl font-bold tracking-tight">Users</h1>

      <div className="fg-rail flex gap-2 overflow-x-auto">
        {FILTERS.map((f) => (
          <button
            key={f}
            data-testid={`admin-users-filter-${f.toLowerCase()}`}
            onClick={() => {
              setFilter(f);
              setSearchParams(f === "ALL" ? {} : { status: f });
            }}
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
      ) : users.length === 0 ? (
        <EmptyState icon={Users} title={`No ${filter.toLowerCase()} users`} subtitle="They will appear here as players register and submit onboarding." />
      ) : (
        <div className="rounded-2xl border border-white/10 overflow-x-auto">
          <Table data-testid="admin-users-table">
            <TableHeader>
              <TableRow className="border-white/10 hover:bg-transparent">
                <TableHead className="text-white/50">Player</TableHead>
                <TableHead className="text-white/50">Country</TableHead>
                <TableHead className="text-white/50">Status</TableHead>
                <TableHead className="text-white/50 text-right">Chips</TableHead>
                <TableHead className="text-white/50">Joined</TableHead>
                <TableHead className="text-white/50 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map((u) => (
                <TableRow key={u.id} data-testid="admin-user-row" className="border-white/5 hover:bg-white/5">
                  <TableCell>
                    <div className="flex items-center gap-2.5">
                      <AvatarBadge avatarKey={u.avatar} size={30} />
                      <div className="min-w-0">
                        <p className="font-semibold text-sm truncate">{u.display_name || "—"}</p>
                        <p className="text-[11px] text-white/45 truncate">{u.email}</p>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="text-sm text-white/70">{u.country || "—"}</TableCell>
                  <TableCell><UserStatusBadge status={u.status} /></TableCell>
                  <TableCell className="text-right tabular-nums text-sm font-semibold">{formatChips(u.chip_balance)}</TableCell>
                  <TableCell className="text-xs text-white/50">{timeAgo(u.created_at)}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1.5">
                      {(u.status === "PENDING" || u.status === "REJECTED" || u.status === "SUSPENDED") && (
                        <Button
                          data-testid="admin-approve-user-button"
                          size="sm"
                          disabled={busyId === u.id}
                          onClick={() => act(u.id, "approve")}
                          className="h-8 rounded-lg text-xs font-bold bg-[hsl(var(--emerald))] text-black hover:brightness-110"
                        >
                          <UserCheck className="h-3.5 w-3.5 mr-1" /> {u.status === "PENDING" ? "Approve" : "Reactivate"}
                        </Button>
                      )}
                      {u.status === "PENDING" && (
                        <Button
                          data-testid="admin-reject-user-button"
                          size="sm"
                          variant="outline"
                          disabled={busyId === u.id}
                          onClick={() => setRejectTarget(u)}
                          className="h-8 rounded-lg text-xs font-bold border-destructive/40 bg-destructive/10 text-red-400 hover:bg-destructive/20"
                        >
                          <UserX className="h-3.5 w-3.5 mr-1" /> Reject
                        </Button>
                      )}
                      {u.status === "ACTIVE" && (
                        <Button
                          data-testid="admin-suspend-user-button"
                          size="sm"
                          variant="outline"
                          disabled={busyId === u.id}
                          onClick={() => act(u.id, "suspend")}
                          className="h-8 rounded-lg text-xs font-bold border-[hsl(var(--magenta)/0.4)] bg-[hsl(var(--magenta)/0.1)] text-[hsl(var(--magenta))] hover:bg-[hsl(var(--magenta)/0.2)]"
                        >
                          <Ban className="h-3.5 w-3.5 mr-1" /> Suspend
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Reject dialog */}
      <Dialog open={!!rejectTarget} onOpenChange={(o) => !o && setRejectTarget(null)}>
        <DialogContent className="rounded-2xl border-white/10 bg-card">
          <DialogHeader>
            <DialogTitle>Reject onboarding</DialogTitle>
            <DialogDescription>
              {rejectTarget?.display_name || rejectTarget?.email} will be notified with your reason and can resubmit.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            data-testid="admin-reject-note-input"
            placeholder="Reason (optional)"
            value={rejectNote}
            onChange={(e) => setRejectNote(e.target.value)}
            className="rounded-xl bg-white/5 border-white/12"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectTarget(null)} className="rounded-xl border-white/15">Cancel</Button>
            <Button data-testid="admin-reject-confirm-button" onClick={confirmReject} className="rounded-xl bg-destructive text-white hover:brightness-110">
              <RotateCcw className="h-4 w-4 mr-1.5" /> Reject user
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageTransition>
  );
}
