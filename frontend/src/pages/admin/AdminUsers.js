import { useState, useEffect, useCallback, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { UserCheck, UserX, Ban, RotateCcw, Users, Coins } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { api, errMsg } from "@/lib/api";
import { IS_ADMIN_CONSOLE } from "@/lib/adminConsole";
import {
  newPointAdjustmentKey,
  pointAdjustmentHeaders,
  validatePointAdjustment,
} from "@/lib/pointAdjustment";
import { PageTransition, UserStatusBadge, EmptyState, formatChips, timeAgo, AvatarBadge } from "@/components/common";

const FILTERS = ["PENDING", "ACTIVE", "SUSPENDED", "REJECTED", "ALL"];
const playerLoginId = (user) => user.login_id || user.username || "";
const playerContact = (user) => user.email || user.auth_email || user.login_id || user.username || "—";
const playPointBalance = (user) => user.point_balance ?? user.points_balance ?? user.chip_balance ?? 0;
const playPointsWon = (user) => user.stats?.points_won ?? user.stats?.winning_points ?? user.stats?.winning_chips ?? 0;
const playPointsUsed = (user) => user.stats?.points_used ?? user.stats?.loss_points ?? user.stats?.loss_chips ?? 0;

export default function AdminUsers() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initial = searchParams.get("status") || "PENDING";
  const [filter, setFilter] = useState(FILTERS.includes(initial) ? initial : "PENDING");
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [rejectTarget, setRejectTarget] = useState(null);
  const [rejectNote, setRejectNote] = useState("");
  const [pointTarget, setPointTarget] = useState(null);
  const [pointAmount, setPointAmount] = useState("");
  const [pointNote, setPointNote] = useState("");
  const [pointAttempted, setPointAttempted] = useState(false);
  const [busyId, setBusyId] = useState(null);
  // This stays stable if the operator retries after a lost response, so the
  // immutable server ledger can return the original receipt rather than apply
  // a second transfer.
  const pointAdjustmentKey = useRef("");

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
      toast.success(`${IS_ADMIN_CONSOLE ? "Player" : "User"} ${action}d`);
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

  const openPointAdjustment = (player) => {
    try {
      pointAdjustmentKey.current = newPointAdjustmentKey();
    } catch (e) {
      // A privileged ledger operation must not fall back to a weak retry key.
      // Give the operator an actionable error instead of opening a form that
      // cannot be submitted safely.
      toast.error(errMsg(e, "Secure browser randomness is required to adjust points."));
      return;
    }
    setPointTarget(player);
    setPointAmount("");
    setPointNote("");
    setPointAttempted(false);
  };

  const closePointAdjustment = () => {
    if (busyId === pointTarget?.id) return;
    pointAdjustmentKey.current = "";
    setPointTarget(null);
    setPointAmount("");
    setPointNote("");
    setPointAttempted(false);
  };

  const submitPointAdjustment = async () => {
    if (!pointTarget) return;
    const validated = validatePointAdjustment({ amount: pointAmount, note: pointNote });
    if (validated.error) {
      toast.error(validated.error);
      return;
    }
    if (!pointAdjustmentKey.current) {
      toast.error("The stable retry key is missing. Close and reopen this correction.");
      return;
    }
    let headers;
    try {
      headers = pointAdjustmentHeaders(pointAdjustmentKey.current);
    } catch (e) {
      toast.error(errMsg(e, "The stable retry key is invalid. Close and reopen this correction."));
      return;
    }
    setPointAttempted(true);
    setBusyId(pointTarget.id);
    try {
      const { data } = await api.post(
        `/admin/users/${pointTarget.id}/points`,
        { delta: validated.delta, note: validated.note },
        { headers },
      );
      toast.success(data.message || "Virtual play points updated");
      pointAdjustmentKey.current = "";
      setPointTarget(null);
      setPointAmount("");
      setPointNote("");
      setPointAttempted(false);
      await load(filter);
    } catch (e) {
      // Keep the same key and values in memory so a deliberate retry is safe.
      toast.error(errMsg(e));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <PageTransition className="space-y-4">
      <h1 className="text-2xl font-bold tracking-tight">{IS_ADMIN_CONSOLE ? "Players" : "Users"}</h1>

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
        <EmptyState icon={Users} title={`No ${filter.toLowerCase()} ${IS_ADMIN_CONSOLE ? "players" : "users"}`} subtitle="They will appear here as players register and submit onboarding." />
      ) : (
        <div className="rounded-2xl border border-white/10 overflow-x-auto">
          <Table data-testid="admin-users-table">
            <TableHeader>
              <TableRow className="border-white/10 hover:bg-transparent">
                <TableHead className="text-white/50">Player</TableHead>
                <TableHead className="text-white/50">Country</TableHead>
                <TableHead className="text-white/50">Status</TableHead>
                <TableHead className="text-white/50 text-right">{IS_ADMIN_CONSOLE ? "Play points" : "Chips"}</TableHead>
                {!IS_ADMIN_CONSOLE && <TableHead className="text-white/50 text-right">Deposits</TableHead>}
                <TableHead className="text-white/50 text-right">{IS_ADMIN_CONSOLE ? "Points won" : "Won"}</TableHead>
                <TableHead className="text-white/50 text-right">{IS_ADMIN_CONSOLE ? "Points used" : "Lost"}</TableHead>
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
                        <p className="text-[11px] text-white/45 truncate">
                          {playerLoginId(u) ? <span className="text-primary/85 font-semibold">@{playerLoginId(u)}</span> : null}
                          {playerLoginId(u) ? " · " : ""}
                          {playerContact(u)}
                        </p>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="text-sm text-white/70">{u.country || "—"}</TableCell>
                  <TableCell><UserStatusBadge status={u.status} /></TableCell>
                  <TableCell className="text-right tabular-nums text-sm font-semibold">{formatChips(IS_ADMIN_CONSOLE ? playPointBalance(u) : u.chip_balance)}</TableCell>
                  {!IS_ADMIN_CONSOLE && (
                    <TableCell className="text-right tabular-nums text-sm text-white/70" data-testid="admin-user-deposits">
                      {formatChips(u.stats?.total_deposits || 0)}
                    </TableCell>
                  )}
                  <TableCell className="text-right tabular-nums text-sm font-semibold text-[hsl(var(--emerald))]" data-testid="admin-user-won">
                    {formatChips(IS_ADMIN_CONSOLE ? playPointsWon(u) : u.stats?.winning_chips || 0)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-sm font-semibold text-red-400" data-testid="admin-user-lost">
                    {formatChips(IS_ADMIN_CONSOLE ? playPointsUsed(u) : u.stats?.loss_chips || 0)}
                  </TableCell>
                  <TableCell className="text-xs text-white/50">{timeAgo(u.created_at)}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1.5">
                      {IS_ADMIN_CONSOLE && (
                        <Button
                          data-testid="admin-adjust-points-button"
                          size="sm"
                          variant="outline"
                          disabled={busyId === u.id}
                          onClick={() => openPointAdjustment(u)}
                          className="h-8 rounded-lg text-xs font-bold border-primary/35 bg-primary/10 text-primary hover:bg-primary/20"
                        >
                          <Coins className="h-3.5 w-3.5 mr-1" /> Points
                        </Button>
                      )}
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
              {rejectTarget?.display_name || playerContact(rejectTarget || {})} will be notified with your reason and can resubmit.
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

      {/* Virtual-point corrections are server-ledger actions, not client-side
          balance edits. A note and one stable idempotency key are required so
          an operator can safely retry a lost request without duplicating it. */}
      <Dialog open={!!pointTarget} onOpenChange={(o) => !o && closePointAdjustment()}>
        <DialogContent className="rounded-2xl border-white/10 bg-card" data-testid="admin-adjust-points-dialog">
          <DialogHeader>
            <DialogTitle>Adjust virtual play points</DialogTitle>
            <DialogDescription>
              {pointTarget ? (
                <>Apply a signed correction to <span className="font-mono text-white/80">{playerLoginId(pointTarget)}</span>. Current balance: <span className="font-semibold text-primary">{formatChips(playPointBalance(pointTarget))}</span>.</>
              ) : ""}
              {" "}This creates an immutable ledger receipt; it does not use cash or payments.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <label htmlFor="admin-point-amount" className="text-xs text-white/60">Points to add or remove</label>
              <Input
                id="admin-point-amount"
                data-testid="admin-point-adjustment-amount"
                value={pointAmount}
                onChange={(e) => setPointAmount(e.target.value)}
                disabled={pointAttempted}
                placeholder="e.g. 250 or -250"
                inputMode="text"
                pattern="-?[0-9]*"
                autoComplete="off"
                className="h-11 rounded-xl bg-white/5 border-white/12 font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="admin-point-note" className="text-xs text-white/60">Ledger note</label>
              <Textarea
                id="admin-point-note"
                data-testid="admin-point-adjustment-note"
                value={pointNote}
                onChange={(e) => setPointNote(e.target.value)}
                disabled={pointAttempted}
                placeholder="Reason for this virtual-point correction"
                maxLength={500}
                className="rounded-xl bg-white/5 border-white/12"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closePointAdjustment} disabled={busyId === pointTarget?.id} className="rounded-xl border-white/15">Cancel</Button>
            <Button
              data-testid="admin-point-adjustment-confirm"
              onClick={submitPointAdjustment}
              disabled={busyId === pointTarget?.id}
              className="rounded-xl font-bold"
            >
              <Coins className="h-4 w-4 mr-1.5" /> {busyId === pointTarget?.id ? "Saving…" : pointAttempted ? "Retry correction" : "Record correction"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageTransition>
  );
}
