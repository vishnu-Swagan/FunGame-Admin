import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { Plus, Pencil, Trash2, Pin, Megaphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { api, errMsg } from "@/lib/api";
import { PageTransition, EmptyState, timeAgo } from "@/components/common";

const EMPTY = { title: "", body: "", pinned: false, active: true };

export default function AdminAnnouncements() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editor, setEditor] = useState(null); // {mode:'create'|'edit', data}
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get("/admin/announcements");
      setItems(data.announcements || []);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    if (!editor) return;
    const { mode, data } = editor;
    if (!data.title.trim() || !data.body.trim()) {
      toast.error("Title and body are required");
      return;
    }
    setBusy(true);
    try {
      if (mode === "create") {
        await api.post("/admin/announcements", data);
        toast.success("Announcement published");
      } else {
        await api.patch(`/admin/announcements/${data.id}`, { title: data.title, body: data.body, pinned: data.pinned, active: data.active });
        toast.success("Announcement updated");
      }
      setEditor(null);
      await load();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const toggleActive = async (a, v) => {
    setItems((prev) => prev.map((x) => (x.id === a.id ? { ...x, active: v } : x)));
    try {
      await api.patch(`/admin/announcements/${a.id}`, { active: v });
    } catch (e) {
      toast.error(errMsg(e));
      load();
    }
  };

  const remove = async () => {
    if (!deleteTarget) return;
    try {
      await api.delete(`/admin/announcements/${deleteTarget.id}`);
      toast.success("Announcement deleted");
      setDeleteTarget(null);
      await load();
    } catch (e) {
      toast.error(errMsg(e));
    }
  };

  return (
    <PageTransition className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">Announcements</h1>
        <Button data-testid="admin-create-announcement-button" size="sm" onClick={() => setEditor({ mode: "create", data: { ...EMPTY } })} className="rounded-xl font-bold">
          <Plus className="h-4 w-4 mr-1" /> New
        </Button>
      </div>

      {loading ? (
        <div className="h-40 rounded-2xl fg-shimmer border border-white/5" />
      ) : items.length === 0 ? (
        <EmptyState icon={Megaphone} title="No announcements" subtitle="Publish updates for all players." />
      ) : (
        <div data-testid="admin-announcements-table" className="space-y-2.5">
          {items.map((a) => (
            <div key={a.id} data-testid="admin-announcement-row" className="rounded-2xl bg-card/55 border border-white/10 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="font-semibold">{a.title}</p>
                    {a.pinned && (
                      <Badge variant="outline" className="rounded-full border-primary/35 bg-primary/10 text-primary text-[10px] font-bold px-2 py-0.5">
                        <Pin className="h-3 w-3 mr-0.5" /> PINNED
                      </Badge>
                    )}
                    {!a.active && <Badge variant="outline" className="rounded-full border-white/20 bg-white/5 text-white/50 text-[10px] font-bold px-2 py-0.5">HIDDEN</Badge>}
                  </div>
                  <p className="text-sm text-white/60 mt-1 line-clamp-2">{a.body}</p>
                  <p className="text-[11px] text-white/35 mt-1.5">{timeAgo(a.created_at)}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Switch data-testid="admin-announcement-active-switch" checked={!!a.active} onCheckedChange={(v) => toggleActive(a, v)} aria-label="Visible to players" />
                  <button data-testid="admin-edit-announcement-button" aria-label="Edit" onClick={() => setEditor({ mode: "edit", data: { ...a } })} className="h-9 w-9 flex items-center justify-center rounded-lg border border-white/10 bg-white/5 hover:bg-white/10">
                    <Pencil className="h-3.5 w-3.5 text-white/70" />
                  </button>
                  <button data-testid="admin-delete-announcement-button" aria-label="Delete" onClick={() => setDeleteTarget(a)} className="h-9 w-9 flex items-center justify-center rounded-lg border border-destructive/30 bg-destructive/10 hover:bg-destructive/20">
                    <Trash2 className="h-3.5 w-3.5 text-red-400" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Editor dialog */}
      <Dialog open={!!editor} onOpenChange={(o) => !o && setEditor(null)}>
        <DialogContent className="rounded-2xl border-white/10 bg-card">
          <DialogHeader>
            <DialogTitle>{editor?.mode === "create" ? "New announcement" : "Edit announcement"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <Input
              data-testid="admin-announcement-title-input"
              placeholder="Title"
              value={editor?.data.title || ""}
              onChange={(e) => setEditor((p) => ({ ...p, data: { ...p.data, title: e.target.value } }))}
              className="h-11 rounded-xl bg-white/5 border-white/12"
            />
            <Textarea
              data-testid="admin-announcement-body-input"
              placeholder="Message to all players"
              value={editor?.data.body || ""}
              onChange={(e) => setEditor((p) => ({ ...p, data: { ...p.data, body: e.target.value } }))}
              className="rounded-xl bg-white/5 border-white/12 min-h-[110px]"
            />
            <div className="flex items-center justify-between">
              <Label className="text-sm">Pin to top</Label>
              <Switch data-testid="admin-announcement-pinned-switch" checked={!!editor?.data.pinned} onCheckedChange={(v) => setEditor((p) => ({ ...p, data: { ...p.data, pinned: v } }))} />
            </div>
            <div className="flex items-center justify-between">
              <Label className="text-sm">Visible to players</Label>
              <Switch checked={!!editor?.data.active} onCheckedChange={(v) => setEditor((p) => ({ ...p, data: { ...p.data, active: v } }))} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditor(null)} className="rounded-xl border-white/15">Cancel</Button>
            <Button data-testid="admin-announcement-save-button" onClick={save} disabled={busy} className="rounded-xl font-bold">
              {busy ? "Saving…" : editor?.mode === "create" ? "Publish" : "Save changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent className="rounded-2xl border-white/10 bg-card">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete announcement?</AlertDialogTitle>
            <AlertDialogDescription>“{deleteTarget?.title}” will be permanently removed.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="rounded-xl border-white/15">Cancel</AlertDialogCancel>
            <AlertDialogAction data-testid="admin-delete-announcement-confirm" onClick={remove} className="rounded-xl bg-destructive text-white hover:brightness-110">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageTransition>
  );
}
