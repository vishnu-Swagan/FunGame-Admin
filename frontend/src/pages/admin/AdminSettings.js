import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { Wrench, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { api, errMsg, APP_VERSION } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { PageTransition, Disclaimer } from "@/components/common";

export default function AdminSettings() {
  const { refreshConfig } = useAuth();
  const [config, setConfig] = useState(null);
  const [message, setMessage] = useState("");
  const [minVersion, setMinVersion] = useState("");
  const [confirmMaint, setConfirmMaint] = useState(null); // true/false pending value
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get("/admin/system");
      setConfig(data.config);
      setMessage(data.config?.maintenance_message || "");
      setMinVersion(data.config?.min_client_version || "1.0.0");
    } catch (e) {
      toast.error(errMsg(e));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const applyMaintenance = async (value) => {
    setBusy(true);
    try {
      const { data } = await api.patch("/admin/system", { maintenance_mode: value });
      setConfig(data.config);
      await refreshConfig();
      toast.success(value ? "Maintenance mode enabled — players are now blocked" : "Maintenance mode disabled");
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
      setConfirmMaint(null);
    }
  };

  const saveConfig = async () => {
    setBusy(true);
    try {
      const { data } = await api.patch("/admin/system", { maintenance_message: message, min_client_version: minVersion });
      setConfig(data.config);
      await refreshConfig();
      toast.success("System config saved");
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <PageTransition className="space-y-4">
      <h1 className="text-2xl font-bold tracking-tight">System</h1>

      {/* Maintenance */}
      <div className="rounded-2xl bg-card/55 border border-white/10 p-5 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold flex items-center gap-2">
              <Wrench className="h-4 w-4 text-[hsl(var(--magenta))]" /> Maintenance mode
            </p>
            <p className="text-xs text-white/55 mt-1">Blocks all player navigation. Operators keep full access.</p>
          </div>
          <Switch
            data-testid="admin-maintenance-switch"
            checked={!!config?.maintenance_mode}
            disabled={busy || !config}
            onCheckedChange={(v) => setConfirmMaint(v)}
            aria-label="Maintenance mode"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs text-white/60">Maintenance message shown to players</Label>
          <Textarea
            data-testid="admin-maintenance-message-input"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            className="rounded-xl bg-white/5 border-white/12 min-h-[70px]"
          />
        </div>
      </div>

      {/* Client version */}
      <div className="rounded-2xl bg-card/55 border border-white/10 p-5 space-y-3">
        <p className="text-sm font-semibold">Minimum client version</p>
        <p className="text-xs text-white/55">Clients below this version see the update-required screen. Current shipped client: v{APP_VERSION}.</p>
        <Input
          data-testid="admin-min-version-input"
          value={minVersion}
          onChange={(e) => setMinVersion(e.target.value)}
          placeholder="1.0.0"
          className="h-11 rounded-xl bg-white/5 border-white/12 max-w-[200px] tabular-nums"
        />
      </div>

      <Button data-testid="admin-system-save-button" onClick={saveConfig} disabled={busy || !config} className="rounded-xl font-bold h-11">
        <Save className="h-4 w-4 mr-1.5" /> {busy ? "Saving…" : "Save configuration"}
      </Button>

      <div className="pt-2">
        <Disclaimer />
      </div>

      {/* Maintenance confirm */}
      <AlertDialog open={confirmMaint !== null} onOpenChange={(o) => !o && setConfirmMaint(null)}>
        <AlertDialogContent className="rounded-2xl border-white/10 bg-card">
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmMaint ? "Enable maintenance mode?" : "Disable maintenance mode?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmMaint
                ? "All players will be blocked and redirected to the maintenance screen immediately."
                : "Players will regain access to the app immediately."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="rounded-xl border-white/15">Cancel</AlertDialogCancel>
            <AlertDialogAction data-testid="admin-maintenance-confirm-button" onClick={() => applyMaintenance(confirmMaint)} className="rounded-xl font-bold">
              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageTransition>
  );
}
