import { useState } from "react";
import { toast } from "sonner";
import { UserPlus, Copy, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, errMsg } from "@/lib/api";
import { IS_ADMIN_CONSOLE } from "@/lib/adminConsole";
import {
  buildPlayerCreatePayload,
  normalizePlayerLoginId,
  validatePlayerProvisioning,
} from "@/lib/playerProvisioning";

export default function AdminSignups() {
  const [fullName, setFullName] = useState("");
  const [loginId, setLoginId] = useState("");
  const [temporaryPassword, setTemporaryPassword] = useState("");
  const [temporaryPasswordConfirmation, setTemporaryPasswordConfirmation] = useState("");
  const [startingChips, setStartingChips] = useState(IS_ADMIN_CONSOLE ? "" : 1000);
  // Issuing both credentials is the default: the operator types a name and the
  // server returns a GK + 8 digit ID and a password. Manual entry stays
  // available for the case where a specific ID has to be matched.
  const [autoIssue, setAutoIssue] = useState(true);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState(null); // {username, password}
  const [copied, setCopied] = useState(false);

  const manualEntry = IS_ADMIN_CONSOLE && !autoIssue;

  const create = async () => {
    if (manualEntry) {
      const validationError = validatePlayerProvisioning({
        loginId,
        fullName,
        password: temporaryPassword,
        passwordConfirmation: temporaryPasswordConfirmation,
        startingPoints: startingChips,
      });
      if (validationError) {
        toast.error(validationError);
        return;
      }
    } else if (IS_ADMIN_CONSOLE && fullName.trim().length < 1) {
      toast.error("Enter a display name");
      return;
    }

    setBusy(true);
    try {
      let payload;
      if (manualEntry) {
        payload = buildPlayerCreatePayload({
          loginId,
          fullName,
          password: temporaryPassword,
          startingPoints: startingChips,
        });
      } else if (IS_ADMIN_CONSOLE) {
        // Omitting login_id and password is what makes the server issue them.
        payload = {
          full_name: fullName.trim(),
          starting_points: Number(startingChips) || 0,
        };
      } else {
        payload = {
          full_name: fullName.trim(),
          starting_chips: Number(startingChips) || 0,
        };
      }
      const { data } = await api.post("/admin/users", payload);
      setCreated({
        username: IS_ADMIN_CONSOLE
          ? (data.login_id || normalizePlayerLoginId(loginId))
          : data.username,
        // When the operator supplied the password, keep their value and ignore
        // the server echo. When the server issued it, the echo is the only
        // copy that exists — it is never stored and never shown again.
        password: manualEntry
          ? temporaryPassword
          : (data.temporary_password || data.password),
      });
      setTemporaryPassword("");
      setTemporaryPasswordConfirmation("");
      setCopied(false);
      toast.success(data.message || (IS_ADMIN_CONSOLE ? "Player account created" : "Account created"));
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setFullName("");
    setLoginId("");
    setTemporaryPassword("");
    setTemporaryPasswordConfirmation("");
    setStartingChips(IS_ADMIN_CONSOLE ? "" : 1000);
    setCreated(null);
    setCopied(false);
  };

  const copyCreds = async () => {
    try {
      await navigator.clipboard.writeText(`${IS_ADMIN_CONSOLE ? "FunGame" : "Chakri.Casino"} login\nUsername: ${created.username}\nPassword: ${created.password}`);
      setCopied(true);
      toast.success("Credentials copied");
    } catch (_e) {
      toast.error("Copy failed — note them down manually");
    }
  };

  return (
    <div className="space-y-4 max-w-xl" data-testid="admin-create-user-page">
      <div>
        <h1 className="font-display text-2xl text-white flex items-center gap-2">
          <UserPlus className="h-5 w-5 text-primary" /> {IS_ADMIN_CONSOLE ? "Create player" : "Create user"}
        </h1>
        <p className="text-sm text-white/55 mt-0.5">
          {IS_ADMIN_CONSOLE ? (
            <>Enter a display name. The Player ID (<span className="font-mono text-white/70">GK</span> + 8 digits) and password are issued automatically. The password is shown only in the immediate confirmation and is never saved by this console.</>
          ) : (
            <>The Username (<span className="font-mono text-white/70">GK</span> + 7 digits) and Password (7 capital letters) are issued automatically. Hand them to the player — they log in with those.</>
          )}
        </p>
      </div>

      {created ? (
        <div className="rounded-2xl border border-white/10 bg-card/55 p-5 space-y-4" data-testid="created-user-card">
          <p className="text-sm text-white/70">{IS_ADMIN_CONSOLE ? "Active player account created. Record the credentials now — they disappear when you create another player or leave this page." : "Account created. Share these credentials with the player — the password won't be shown again."}</p>
          <div className="rounded-xl border border-primary/35 bg-primary/10 p-4 space-y-1.5" data-testid="created-credentials">
            <p className="text-sm"><span className="text-white/55">{IS_ADMIN_CONSOLE ? "Player ID" : "Username"}:</span> <span className="font-mono font-bold text-primary text-base tracking-wide">{created.username}</span></p>
            <p className="text-sm"><span className="text-white/55">Password:</span> <span className="font-mono font-bold text-white text-base tracking-widest">{created.password}</span></p>
          </div>
          <div className="flex gap-2">
            {!IS_ADMIN_CONSOLE && (
              <Button data-testid="copy-credentials" onClick={copyCreds} className="flex-1 font-bold">
                {copied ? <Check className="h-4 w-4 mr-1.5" /> : <Copy className="h-4 w-4 mr-1.5" />} {copied ? "Copied" : "Copy credentials"}
              </Button>
            )}
            <Button data-testid="create-another" variant="outline" className={`border-white/15 ${IS_ADMIN_CONSOLE ? "w-full" : ""}`} onClick={reset}>Create another</Button>
          </div>
        </div>
      ) : (
        <div className="rounded-2xl border border-white/10 bg-card/55 p-5 space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="cu-name">{IS_ADMIN_CONSOLE ? "Display name" : "Player name"}</Label>
            <Input id="cu-name" data-testid="create-name-input" value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="e.g. Ravi Kumar" maxLength={IS_ADMIN_CONSOLE ? 120 : undefined} autoComplete={IS_ADMIN_CONSOLE ? "name" : undefined} className="bg-white/5 border-white/12" />
          </div>
          {IS_ADMIN_CONSOLE && (
            <label
              className="flex items-start gap-2.5 rounded-xl border border-white/10 bg-white/[0.03] p-3 cursor-pointer"
              data-testid="create-auto-issue-toggle"
            >
              <input
                type="checkbox"
                checked={autoIssue}
                onChange={(e) => setAutoIssue(e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-primary"
              />
              <span className="text-sm">
                <span className="font-semibold text-white">Issue ID and password automatically</span>
                <span className="block text-[12px] text-white/50 mt-0.5">
                  Generates a <span className="font-mono">GK</span> + 8 digit Player ID and a password.
                  Uncheck only if this account must match a specific existing ID.
                </span>
              </span>
            </label>
          )}
          {manualEntry && <>
            <div className="space-y-1.5">
              <Label htmlFor="cu-login-id">Player Login ID</Label>
              <Input
                id="cu-login-id"
                data-testid="create-login-id-input"
                value={loginId}
                onChange={(e) => setLoginId(e.target.value.toUpperCase())}
                placeholder="GK00290877"
                maxLength={10}
                autoCapitalize="characters"
                autoComplete="off"
                spellCheck="false"
                className="bg-white/5 border-white/12 font-mono"
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="cu-password">Temporary password</Label>
                <Input
                  id="cu-password"
                  data-testid="create-password-input"
                  type="password"
                  value={temporaryPassword}
                  onChange={(e) => setTemporaryPassword(e.target.value)}
                  placeholder="At least 7 characters"
                  minLength={7}
                  maxLength={128}
                  autoComplete="new-password"
                  className="bg-white/5 border-white/12"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="cu-password-confirm">Confirm temporary password</Label>
                <Input
                  id="cu-password-confirm"
                  data-testid="create-password-confirm-input"
                  type="password"
                  value={temporaryPasswordConfirmation}
                  onChange={(e) => setTemporaryPasswordConfirmation(e.target.value)}
                  placeholder="Repeat the password"
                  minLength={7}
                  maxLength={128}
                  autoComplete="new-password"
                  className="bg-white/5 border-white/12"
                />
              </div>
            </div>
          </>}
          <div className="space-y-1.5">
            <Label htmlFor="cu-chips">{IS_ADMIN_CONSOLE ? "Initial virtual points (optional)" : "Starting play chips"}</Label>
            <Input id="cu-chips" data-testid="create-chips-input" type="number" min={0} max={1000000} step={1} value={startingChips} onChange={(e) => setStartingChips(e.target.value)} placeholder={IS_ADMIN_CONSOLE ? "0" : undefined} className="bg-white/5 border-white/12" />
          </div>
          <Button data-testid="create-user-button" onClick={create} disabled={busy || fullName.trim().length < 1} className="w-full font-bold">
            {busy ? "Creating…" : IS_ADMIN_CONSOLE ? "Create active player" : "Create account & issue login"}
          </Button>
        </div>
      )}
    </div>
  );
}
