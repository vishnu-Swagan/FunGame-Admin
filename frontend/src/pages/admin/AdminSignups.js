import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { UserPlus, RefreshCw, Copy, Check, X, Dices } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { api, errMsg } from "@/lib/api";

const TABS = ["PENDING", "APPROVED", "REJECTED", "ALL"];

const STATUS_TONE = {
  PENDING: "border-primary/40 bg-primary/10 text-primary",
  APPROVED: "border-[hsl(var(--emerald)/0.4)] bg-[hsl(var(--emerald)/0.1)] text-[hsl(var(--emerald))]",
  REJECTED: "border-destructive/40 bg-destructive/10 text-red-400",
};

const genPassword = () => {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  let pw = "";
  const arr = new Uint32Array(10);
  crypto.getRandomValues(arr);
  for (let i = 0; i < 10; i++) pw += chars[arr[i] % chars.length];
  return pw + "@" + Math.floor(Math.random() * 90 + 10);
};

const suggestUsername = (fullName) =>
  (fullName || "player")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .join("_")
    .slice(0, 18) + "_" + Math.floor(Math.random() * 900 + 100);

export default function AdminSignups() {
  const [tab, setTab] = useState("PENDING");
  const [requests, setRequests] = useState(null);
  const [target, setTarget] = useState(null); // request being approved
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [startingChips, setStartingChips] = useState(1000);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState(null); // {username, password} after approval
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const qs = tab === "ALL" ? "" : `?status=${tab}`;
      const { data } = await api.get(`/admin/signup-requests${qs}`);
      setRequests(data.requests);
    } catch (err) {
      toast.error(errMsg(err));
    }
  }, [tab]);

  useEffect(() => {
    setRequests(null);
    load();
  }, [load]);

  const openApprove = (req) => {
    setTarget(req);
    setUsername(suggestUsername(req.full_name));
    setPassword(genPassword());
    setStartingChips(1000);
    setCreated(null);
    setCopied(false);
  };

  const approve = async () => {
    setBusy(true);
    try {
      const { data } = await api.post(`/admin/signup-requests/${target.id}/approve`, {
        username: username.trim().toLowerCase(),
        password,
        starting_chips: Number(startingChips) || 0,
      });
      setCreated({ username: data.username, password });
      toast.success(data.message);
      load();
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const reject = async (req) => {
    try {
      await api.post(`/admin/signup-requests/${req.id}/reject`, { note: "Details could not be verified" });
      toast.success("Request rejected");
      load();
    } catch (err) {
      toast.error(errMsg(err));
    }
  };

  const copyCreds = async () => {
    try {
      await navigator.clipboard.writeText(`FunGame login\nLogin ID: ${created.username}\nPassword: ${created.password}`);
      setCopied(true);
      toast.success("Credentials copied");
    } catch (_e) {
      toast.error("Copy failed — note them down manually");
    }
  };

  return (
    <div className="space-y-4" data-testid="admin-signups-page">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="font-display text-2xl text-white flex items-center gap-2">
            <UserPlus className="h-5 w-5 text-primary" /> Signup requests
          </h1>
          <p className="text-sm text-white/55 mt-0.5">Verify new players and assign their unique Login ID and password.</p>
        </div>
        <Button data-testid="signups-refresh-button" variant="outline" size="sm" onClick={load} className="border-white/15 bg-white/5">
          <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Refresh
        </Button>
      </div>

      <div className="flex gap-1.5 flex-wrap">
        {TABS.map((t) => (
          <button
            key={t}
            data-testid={`signups-tab-${t.toLowerCase()}`}
            onClick={() => setTab(t)}
            className={`rounded-full px-3.5 py-1.5 text-xs font-bold border transition-[background-color,color] duration-150 ${
              tab === t ? "bg-primary/15 text-primary border-primary/35" : "text-white/55 border-white/10 hover:bg-white/5"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {requests === null ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-20 w-full rounded-2xl bg-white/5" />
          ))}
        </div>
      ) : requests.length === 0 ? (
        <div data-testid="signups-empty-state" className="rounded-2xl border border-white/10 bg-card/55 p-10 text-center text-white/50 text-sm">
          No {tab === "ALL" ? "" : tab.toLowerCase() + " "}signup requests right now.
        </div>
      ) : (
        <div className="space-y-2">
          {requests.map((r) => (
            <div key={r.id} data-testid={`signup-request-${r.id}`} className="rounded-2xl border border-white/10 bg-card/55 p-4 flex flex-wrap items-center gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="font-semibold text-white truncate">{r.full_name}</p>
                  <Badge variant="outline" className={`text-[10px] ${STATUS_TONE[r.status] || "border-white/15 text-white/60"}`}>
                    {r.status}
                  </Badge>
                  {r.assigned_username && (
                    <span className="text-[11px] text-primary font-semibold">Login ID: {r.assigned_username}</span>
                  )}
                </div>
                <p className="text-xs text-white/55 mt-1 truncate">
                  {r.email} · DOB {r.date_of_birth} · {r.phone}
                </p>
                <p className="text-[11px] text-white/35 mt-0.5">Requested {new Date(r.created_at).toLocaleString()}</p>
              </div>
              {r.status === "PENDING" && (
                <div className="flex gap-2">
                  <Button data-testid={`signup-approve-${r.id}`} size="sm" onClick={() => openApprove(r)} className="font-bold">
                    <Check className="h-3.5 w-3.5 mr-1" /> Verify & assign
                  </Button>
                  <Button data-testid={`signup-reject-${r.id}`} size="sm" variant="outline" onClick={() => reject(r)} className="border-destructive/40 text-red-400 hover:bg-destructive/10">
                    <X className="h-3.5 w-3.5 mr-1" /> Reject
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Approve dialog */}
      <Dialog open={!!target} onOpenChange={(o) => !o && setTarget(null)}>
        <DialogContent className="max-w-md" data-testid="signup-approve-dialog">
          <DialogHeader>
            <DialogTitle>{created ? "Account created" : `Assign credentials — ${target?.full_name}`}</DialogTitle>
            <DialogDescription>
              {created
                ? "Share these credentials with the player offline. They will not be shown again."
                : "Set the unique Login ID and password for this player."}
            </DialogDescription>
          </DialogHeader>
          {created ? (
            <div className="space-y-3">
              <div className="rounded-xl border border-primary/35 bg-primary/10 p-4 space-y-1.5" data-testid="signup-created-credentials">
                <p className="text-sm">
                  <span className="text-white/55">Login ID:</span> <span className="font-bold text-primary">{created.username}</span>
                </p>
                <p className="text-sm">
                  <span className="text-white/55">Password:</span> <span className="font-mono font-bold text-white">{created.password}</span>
                </p>
              </div>
              <div className="flex gap-2">
                <Button data-testid="signup-copy-credentials" onClick={copyCreds} className="flex-1 font-bold">
                  {copied ? <Check className="h-4 w-4 mr-1.5" /> : <Copy className="h-4 w-4 mr-1.5" />} {copied ? "Copied" : "Copy credentials"}
                </Button>
                <Button variant="outline" className="border-white/15" onClick={() => setTarget(null)} data-testid="signup-close-dialog">
                  Done
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-3.5">
              <div className="space-y-1.5">
                <Label htmlFor="assign-username">Login ID (username)</Label>
                <Input
                  id="assign-username"
                  data-testid="assign-username-input"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="e.g. ravi_kumar_101"
                  className="bg-white/5 border-white/12"
                />
                <p className="text-[11px] text-white/40">3-24 chars: letters, numbers, dot or underscore. Must be unique.</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="assign-password">Password</Label>
                <div className="flex gap-2">
                  <Input
                    id="assign-password"
                    data-testid="assign-password-input"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="bg-white/5 border-white/12 font-mono"
                  />
                  <Button type="button" variant="outline" data-testid="assign-generate-password" onClick={() => setPassword(genPassword())} className="border-white/15 shrink-0" aria-label="Generate password">
                    <Dices className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="assign-chips">Starting play chips</Label>
                <Input
                  id="assign-chips"
                  data-testid="assign-chips-input"
                  type="number"
                  min={0}
                  max={1000000}
                  value={startingChips}
                  onChange={(e) => setStartingChips(e.target.value)}
                  className="bg-white/5 border-white/12"
                />
              </div>
              <Button data-testid="assign-confirm-button" onClick={approve} disabled={busy || username.trim().length < 3 || password.length < 8} className="w-full font-bold">
                {busy ? "Creating…" : "Create account & assign"}
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
