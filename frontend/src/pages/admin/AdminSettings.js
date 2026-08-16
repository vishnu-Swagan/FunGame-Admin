import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { ShieldPlus, Wrench, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { api, errMsg, APP_VERSION, compareVersions } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { PageTransition, Disclaimer } from "@/components/common";
import { IS_ADMIN_CONSOLE } from "@/lib/adminConsole";

const operatorLoginId = (operator) => operator?.login_id || operator?.username || operator?.email || "operator";

export default function AdminSettings() {
  const { refreshConfig, user } = useAuth();
  const [config, setConfig] = useState(null);
  const [message, setMessage] = useState("");
  const [minVersion, setMinVersion] = useState("");
  const [confirmMaint, setConfirmMaint] = useState(null); // true/false pending value
  const [busy, setBusy] = useState(false);
  const [operatorId, setOperatorId] = useState("");
  const [operatorPassword, setOperatorPassword] = useState("");
  const [operatorPasswordConfirm, setOperatorPasswordConfirm] = useState("");
  const [operatorBusy, setOperatorBusy] = useState(false);
  const [confirmOperator, setConfirmOperator] = useState(false);
  const [operators, setOperators] = useState([]);
  const [revokeTarget, setRevokeTarget] = useState(null);
  const mayManageOperators = user?.role === "ADMIN" && (
    user?.admin_level === "PRIMARY" || user?.is_primary === true || !user?.operator_created_by
  );

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

  const loadOperators = useCallback(async () => {
    if (!mayManageOperators) {
      setOperators([]);
      return;
    }
    try {
      const { data } = await api.get("/admin/operators");
      setOperators(data.operators || []);
    } catch (e) {
      toast.error(errMsg(e));
    }
  }, [mayManageOperators]);

  useEffect(() => {
    load();
    loadOperators();
  }, [load, loadOperators]);

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

  const createOperator = async () => {
    if (operatorPassword !== operatorPasswordConfirm) {
      toast.error("The operator passwords do not match");
      return;
    }
    setOperatorBusy(true);
    try {
      const { data } = await api.post("/admin/operators", {
        [IS_ADMIN_CONSOLE ? "login_id" : "username"]: operatorId.trim(),
        password: operatorPassword,
      });
      toast.success(`Administrator ${operatorLoginId(data.operator)} created`);
      setOperatorId("");
      setOperatorPassword("");
      setOperatorPasswordConfirm("");
      setConfirmOperator(false);
      await loadOperators();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setOperatorBusy(false);
    }
  };

  const closeOperatorConfirmation = () => {
    if (operatorBusy) return;
    setConfirmOperator(false);
    // A cancelled confirmation should not leave a privileged temporary
    // credential resident in the page state.
    setOperatorPassword("");
    setOperatorPasswordConfirm("");
  };

  const revokeOperator = async () => {
    if (!revokeTarget) return;
    setOperatorBusy(true);
    try {
      await api.post(`/admin/operators/${revokeTarget.id}/revoke`);
      toast.success(`Administrator ${operatorLoginId(revokeTarget)} revoked`);
      setRevokeTarget(null);
      await loadOperators();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setOperatorBusy(false);
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
        {compareVersions(APP_VERSION, minVersion) < 0 && (
          <p data-testid="admin-min-version-warning" className="text-xs font-semibold text-amber-300">
            v{minVersion || "?"} is above the shipped client (v{APP_VERSION}). Saving this locks
            every player out on the update-required screen until a client that new is deployed.
          </p>
        )}
      </div>

      <Button data-testid="admin-system-save-button" onClick={saveConfig} disabled={busy || !config} className="rounded-xl font-bold h-11">
        <Save className="h-4 w-4 mr-1.5" /> {busy ? "Saving…" : "Save configuration"}
      </Button>

      {mayManageOperators && <div className="rounded-2xl bg-card/55 border border-white/10 p-5 space-y-4">
        <div>
          <p className="text-sm font-semibold flex items-center gap-2">
            <ShieldPlus className="h-4 w-4 text-sky-300" /> Create administrator
          </p>
          <p className="text-xs text-white/55 mt-1">
            Creates an active operator account only. It has no player wallet, play chips, or points balance.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="operator-id" className="text-xs text-white/60">Operator ID</Label>
            <Input
              id="operator-id"
              data-testid="admin-create-operator-id"
              value={operatorId}
              onChange={(e) => setOperatorId(e.target.value)}
              placeholder="e.g. Fun.mydgp"
              autoComplete="off"
              className="h-11 rounded-xl bg-white/5 border-white/12"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="operator-password" className="text-xs text-white/60">Temporary password</Label>
            <Input
              id="operator-password"
              data-testid="admin-create-operator-password"
              type="password"
              value={operatorPassword}
              onChange={(e) => setOperatorPassword(e.target.value)}
              placeholder="At least 8 characters"
              autoComplete="new-password"
              className="h-11 rounded-xl bg-white/5 border-white/12"
            />
          </div>
        </div>
        <div className="space-y-1.5 max-w-sm">
          <Label htmlFor="operator-password-confirm" className="text-xs text-white/60">Confirm temporary password</Label>
          <Input
            id="operator-password-confirm"
            data-testid="admin-create-operator-password-confirm"
            type="password"
            value={operatorPasswordConfirm}
            onChange={(e) => setOperatorPasswordConfirm(e.target.value)}
            placeholder="Repeat the password"
            autoComplete="new-password"
            className="h-11 rounded-xl bg-white/5 border-white/12"
          />
        </div>
        <Button
          data-testid="admin-create-operator-button"
          onClick={() => setConfirmOperator(true)}
          disabled={operatorBusy || operatorId.trim().length < 3 || operatorPassword.length < 8 || operatorPasswordConfirm.length < 8}
          className="rounded-xl font-bold h-11"
        >
          <ShieldPlus className="h-4 w-4 mr-1.5" /> {operatorBusy ? "Creating…" : "Create administrator"}
        </Button>

        {operators.length > 0 && (
          <div className="border-t border-white/10 pt-4 space-y-2">
            <p className="text-xs font-semibold text-white/65 uppercase tracking-wide">Delegated administrators</p>
            {operators.map((operator) => (
              <div key={operator.id} className="flex items-center justify-between gap-3 rounded-xl bg-white/[0.035] border border-white/8 px-3 py-2.5">
                <div className="min-w-0">
                  <p className="font-mono text-sm text-white/90 truncate">{operatorLoginId(operator)}</p>
                  <p className="text-[11px] text-white/45">{operator.status === "ACTIVE" ? "Active" : "Revoked"}</p>
                </div>
                {operator.status === "ACTIVE" && (
                  <Button
                    data-testid={`admin-revoke-operator-${operator.id}`}
                    variant="destructive"
                    size="sm"
                    onClick={() => setRevokeTarget(operator)}
                    disabled={operatorBusy}
                    className="rounded-lg shrink-0"
                  >
                    Revoke
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>}

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

      <AlertDialog open={confirmOperator} onOpenChange={(o) => !o && closeOperatorConfirmation()}>
        <AlertDialogContent className="rounded-2xl border-white/10 bg-card">
          <AlertDialogHeader>
            <AlertDialogTitle>Create administrator?</AlertDialogTitle>
            <AlertDialogDescription>
              <span className="font-mono text-white/80">{operatorId || "This operator"}</span> will receive full administrator access. The account has no player wallet, chips, or points.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={closeOperatorConfirmation} className="rounded-xl border-white/15">Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="admin-create-operator-confirm"
              onClick={createOperator}
              className="rounded-xl font-bold"
            >
              Create administrator
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!revokeTarget} onOpenChange={(o) => !o && !operatorBusy && setRevokeTarget(null)}>
        <AlertDialogContent className="rounded-2xl border-white/10 bg-card">
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke administrator access?</AlertDialogTitle>
            <AlertDialogDescription>
              <span className="font-mono text-white/80">{operatorLoginId(revokeTarget)}</span> will be signed out immediately and cannot use the operator console again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={operatorBusy} className="rounded-xl border-white/15">Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="admin-revoke-operator-confirm"
              onClick={revokeOperator}
              disabled={operatorBusy}
              className="rounded-xl bg-destructive text-white hover:brightness-110"
            >
              {operatorBusy ? "Revoking…" : "Revoke access"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageTransition>
  );
}
