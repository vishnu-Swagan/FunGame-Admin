import { useState, useEffect, useCallback } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { UserCheck, UserX, Ban, RotateCcw, Search, Trash2, Users, History } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { api, errMsg } from "@/lib/api";
import { registrationReview } from "@/lib/adminRegistrationReview";
import { PageTransition, UserStatusBadge, EmptyState, formatChips, timeAgo, AvatarBadge } from "@/components/common";

const FILTERS = ["PENDING", "ACTIVE", "SUSPENDED", "REJECTED", "ALL"];

export default function AdminUsers() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const initial = searchParams.get("status") || "PENDING";
  const [filter, setFilter] = useState(FILTERS.includes(initial) ? initial : "PENDING");
  const [users, setUsers] = useState([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [rejectTarget, setRejectTarget] = useState(null);
  const [rejectNote, setRejectNote] = useState("");
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
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

  useEffect(() => {
    const requested = searchParams.get("status") || "PENDING";
    const nextFilter = FILTERS.includes(requested) ? requested : "PENDING";
    setFilter((current) => current === nextFilter ? current : nextFilter);
  }, [searchParams]);

  const act = async (userId, action, body = {}) => {
    setBusyId(userId);
    try {
      const { data } = await api.post(`/admin/users/${userId}/${action}`, body);
      toast.success(data?.message || (action === "approve" ? "User approved" : action === "reject" ? "User rejected" : "User updated"));
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

  const openDeleteDialog = (user) => {
    setDeleteConfirmation("");
    setDeleteTarget(user);
  };

  const closeDeleteDialog = () => {
    if (busyId === deleteTarget?.id) return;
    setDeleteTarget(null);
    setDeleteConfirmation("");
  };

  const confirmDelete = async () => {
    if (!deleteTarget || deleteConfirmation.trim().toUpperCase() !== "DELETE") return;
    setBusyId(deleteTarget.id);
    try {
      const { data } = await api.delete(`/admin/users/${deleteTarget.id}`);
      toast.success(data?.message || "Player account deleted permanently");
      setDeleteTarget(null);
      setDeleteConfirmation("");
      await load(filter);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusyId(null);
    }
  };

  const approve = async (user) => {
    const review = registrationReview(user);
    if (review.manualReview) {
      const confirmed = window.confirm(
        `Confirm you manually verified ${review.contact} before activating gameplay?`,
      );
      if (!confirmed) return;
    }
    await act(user.id, "approve");
  };

  const shownUsers = users.filter((user) => {
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    return [user.id, user.display_name, user.username, user.email, user.phone, user.country]
      .some((value) => String(value || "").toLowerCase().includes(needle));
  });

  return (
    <PageTransition className="space-y-4">
      <div className="crm-page-header">
        <div className="crm-page-header-copy">
          <span className="crm-page-context">People</span>
          <h1>Players</h1>
          <p>Internal player management, wallet visibility, gaming activity, security, and audit history.</p>
        </div>
        <div className="crm-page-actions"><span className="source-badge"><span className="source-indicator" />Live service</span></div>
      </div>

      <div className="crm-filter-bar">
        <label className="crm-search-control">
          <Search size={15} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search ID, name, mobile, or email" aria-label="Search players" />
        </label>
        <div className="crm-filter-tabs" aria-label="Player status">
          {FILTERS.map((f) => (
            <button
              key={f}
              data-testid={`admin-users-filter-${f.toLowerCase()}`}
              onClick={() => {
                setFilter(f);
                setSearchParams(f === "ALL" ? {} : { status: f });
              }}
              className={filter === f ? "active" : ""}
            >
              {f === "ALL" ? "All players" : f.toLowerCase().replace(/^./, (letter) => letter.toUpperCase())}
            </button>
          ))}
        </div>
        <span className="crm-filter-count">{shownUsers.length} loaded</span>
      </div>

      {loading ? (
        <div className="h-40 rounded-2xl fg-shimmer border border-white/5" />
      ) : shownUsers.length === 0 ? (
        <EmptyState icon={Users} title={`No ${filter.toLowerCase()} users`} subtitle="They will appear here as players register and submit onboarding." />
      ) : (
        <div className="rounded-2xl border border-white/10 overflow-x-auto">
          <Table data-testid="admin-users-table">
            <TableHeader>
              <TableRow className="border-white/10 hover:bg-transparent">
                <TableHead className="text-white/50">Player</TableHead>
                <TableHead className="text-white/50">Registration</TableHead>
                <TableHead className="text-white/50">Review readiness</TableHead>
                <TableHead className="text-white/50">Country</TableHead>
                <TableHead className="text-white/50">Status</TableHead>
                <TableHead className="text-white/50 text-right">Chips</TableHead>
                <TableHead className="text-white/50 text-right">Won</TableHead>
                <TableHead className="text-white/50 text-right">Lost</TableHead>
                <TableHead className="text-white/50">Joined</TableHead>
                <TableHead className="text-white/50 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shownUsers.map((u) => {
                const review = registrationReview(u);
                return (
                <TableRow key={u.id} data-testid="admin-user-row" className="border-white/5 hover:bg-white/5">
                  <TableCell>
                    <div className="flex items-center gap-2.5">
                      <AvatarBadge avatarKey={u.avatar} size={30} />
                      <div className="min-w-0">
                        <p className="font-semibold text-sm truncate">{u.display_name || "—"}</p>
                        <p className="text-[11px] text-white/45 truncate">
                          {u.username ? <span className="text-primary/85 font-semibold">@{u.username}</span> : null}
                          {u.username ? " · " : ""}
                          {review.contact}
                        </p>
                        {review.manualReview && (
                          <p className="text-[10px] text-amber-300 truncate">Manual check · DOB {u.date_of_birth || "missing"}</p>
                        )}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell data-testid="admin-user-registration-source">
                    <span className={`inline-flex rounded-full border px-2 py-1 text-[10px] font-bold ${review.selfService ? "border-sky-400/30 bg-sky-400/10 text-sky-300" : "border-white/10 bg-white/5 text-white/55"}`}>
                      {review.sourceLabel}
                    </span>
                  </TableCell>
                  <TableCell data-testid="admin-user-review-readiness">
                    <div className="space-y-1 text-[11px] leading-tight">
                      <p
                        data-testid="admin-user-contact-verification"
                        className={review.contactVerified || review.manualReviewApproved ? "text-emerald-300" : review.verificationDeferred || review.manualReview ? "text-amber-300" : "text-red-300"}
                      >
                        {review.contactLabel}: {review.contactStatusLabel}
                      </p>
                      <p className={review.submitted || review.directlyActivated ? "text-white/65" : "text-amber-300"}>
                        {review.submitted ? `Submitted ${timeAgo(u.submitted_at)}` : review.submissionLabel}
                      </p>
                      {review.selfService && <p className={review.termsAccepted ? "text-white/50" : "text-amber-300"}>Terms: {review.termsAccepted ? "accepted" : "missing"}</p>}
                    </div>
                  </TableCell>
                  <TableCell className="text-sm text-white/70">{u.country || "—"}</TableCell>
                  <TableCell><UserStatusBadge status={u.status} /></TableCell>
                  <TableCell className="text-right tabular-nums text-sm font-semibold">{formatChips(u.chip_balance)}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm font-semibold text-[hsl(var(--emerald))]" data-testid="admin-user-won">
                    {formatChips(u.stats?.winning_chips || 0)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-sm font-semibold text-red-400" data-testid="admin-user-lost">
                    {formatChips(u.stats?.loss_chips || 0)}
                  </TableCell>
                  <TableCell className="text-xs text-white/50">{timeAgo(u.created_at)}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1.5">
                      <Button
                        size="sm"
                        variant="outline"
                        data-testid="admin-user-history-button"
                        className="h-8 rounded-lg text-xs font-bold"
                        onClick={() => navigate(`/Admin/play-history?user=${encodeURIComponent(u.id)}`)}
                      >
                        <History className="h-3.5 w-3.5 mr-1" /> History
                      </Button>
                      {(u.status === "PENDING" || u.status === "REJECTED" || u.status === "SUSPENDED") && (
                        <Button
                          data-testid="admin-approve-user-button"
                          size="sm"
                          disabled={busyId === u.id || !review.approvalReady}
                          title={!review.approvalReady ? "Accepted terms and a submitted eligible profile are required; non-manual accounts also require contact verification" : undefined}
                          onClick={() => approve(u)}
                          className="h-8 rounded-lg text-xs font-bold bg-[hsl(var(--emerald))] text-black hover:brightness-110"
                        >
                          <UserCheck className="h-3.5 w-3.5 mr-1" /> {u.status === "PENDING" ? (review.manualReview ? "Verify & approve" : "Approve") : "Reactivate"}
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
                      <Button
                        data-testid="admin-delete-user-button"
                        size="sm"
                        variant="outline"
                        disabled={busyId === u.id}
                        onClick={() => openDeleteDialog(u)}
                        className="h-8 rounded-lg text-xs font-bold border-destructive/45 bg-destructive/10 text-red-300 hover:bg-destructive/20 hover:text-red-200"
                      >
                        <Trash2 className="h-3.5 w-3.5 mr-1" /> Delete
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
                );
              })}
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

      {/* Permanent account deletion dialog */}
      <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && closeDeleteDialog()}>
        <DialogContent className="rounded-2xl border-destructive/30 bg-card">
          <DialogHeader>
            <DialogTitle>Delete player account permanently?</DialogTitle>
            <DialogDescription>
              <span className="font-semibold text-white">
                {deleteTarget?.display_name || deleteTarget?.username || deleteTarget?.email}
              </span>{" "}
              will immediately lose login access. This cannot be undone. Historical game and audit records remain for reporting. Accounts with payment history or unfinished activity cannot be deleted.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label htmlFor="delete-player-confirmation" className="text-xs font-semibold text-white/70">
              Type DELETE to confirm
            </label>
            <Input
              id="delete-player-confirmation"
              data-testid="admin-delete-user-confirmation-input"
              value={deleteConfirmation}
              onChange={(event) => setDeleteConfirmation(event.target.value)}
              autoComplete="off"
              placeholder="DELETE"
              className="rounded-xl border-destructive/30 bg-white/5"
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busyId === deleteTarget?.id}
              onClick={closeDeleteDialog}
              className="rounded-xl border-white/15"
            >
              Cancel
            </Button>
            <Button
              data-testid="admin-delete-user-confirm-button"
              disabled={busyId === deleteTarget?.id || deleteConfirmation.trim().toUpperCase() !== "DELETE"}
              onClick={confirmDelete}
              className="rounded-xl bg-destructive text-white hover:brightness-110"
            >
              <Trash2 className="h-4 w-4 mr-1.5" />
              {busyId === deleteTarget?.id ? "Deleting…" : "Delete permanently"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageTransition>
  );
}
