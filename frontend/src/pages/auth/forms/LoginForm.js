import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Eye, EyeOff, MonitorSmartphone, UserCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, errMsg, routeForUser } from "@/lib/api";
import { LOGIN_SURFACES, loginRequestPayload } from "@/lib/loginSurface";
import { useAuth } from "@/context/AuthContext";
import { AUTH_PANELS, frontPathForAuthPanel } from "@/lib/frontDoor";
import { adminLoginPathForConsole } from "@/lib/adminConsole";

/**
 * Shared login form. When `onSwitchPanel` is provided (frontpage embed), panel
 * switches stay on `/` instead of navigating to legacy auth routes.
 */
export default function LoginForm({
  onSwitchPanel,
  registrationSubmitted = false,
  showTitle = false,
}) {
  const navigate = useNavigate();
  const { login } = useAuth();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sessionNotice, setSessionNotice] = useState("");

  useEffect(() => {
    const reason = localStorage.getItem("fg_logout_reason");
    if (reason) {
      setSessionNotice(reason);
      localStorage.removeItem("fg_logout_reason");
    }
  }, []);

  const goPanel = (panel) => {
    if (onSwitchPanel) onSwitchPanel(panel);
    else navigate(frontPathForAuthPanel(panel));
  };

  const finishLogin = (data) => {
      if (data.user.role === "ADMIN") {
        toast.info("Administrator accounts sign in through Chakri.Casino/Admin.");
        navigate(adminLoginPathForConsole(), { replace: true });
        return false;
      }
      if (data.user.role === "DISTRIBUTOR") {
        toast.info("Distributor accounts use the dedicated distributor portal.");
        navigate("/distributor/login", { replace: true });
        return false;
      }
      login(data.access_token, data.user);
      toast.success(`Welcome back${data.user.display_name ? ", " + data.user.display_name : ""}!`);
      navigate(routeForUser(data.user), { replace: true });
      return true;
  };

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const { data } = await api.post(
        "/auth/login",
        loginRequestPayload(identifier, password, LOGIN_SURFACES.PLAYER),
      );
      finishLogin(data);
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="frontpage-login-panel">
      {showTitle && (
        <div className="mb-5">
          <h2 className="text-2xl font-bold tracking-tight">Welcome back</h2>
          <p className="mt-1 text-sm text-white/65">Log in to enter the Chakri.Casino lounge.</p>
        </div>
      )}
      {registrationSubmitted && (
        <div data-testid="registration-submitted-notice" className="mb-4 flex items-start gap-2.5 rounded-xl border border-amber-300/30 bg-amber-300/10 p-3 text-sm text-amber-100">
          <UserCheck className="h-4 w-4 mt-0.5 shrink-0" />
          <span>Registration submitted. You can log in after an administrator approves your account.</span>
        </div>
      )}
      {sessionNotice && (
        <div data-testid="session-replaced-notice" className="mb-4 flex items-start gap-2.5 rounded-xl border border-primary/35 bg-primary/10 p-3 text-sm text-primary">
          <MonitorSmartphone className="h-4 w-4 mt-0.5 shrink-0" />
          <span>{sessionNotice}</span>
        </div>
      )}
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="identifier">Email, mobile with +country code, or Login ID</Label>
          <Input
            id="identifier"
            data-testid="login-email-input"
            type="text"
            required
            autoComplete="username"
            placeholder="Email, mobile with +country code, or your Login ID"
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            className="h-12 rounded-xl bg-white/5 border-white/12"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="password">Password</Label>
          <div className="relative">
            <Input
              id="password"
              data-testid="login-password-input"
              type={showPw ? "text" : "password"}
              required
              autoComplete="current-password"
              placeholder="Your password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="h-12 rounded-xl bg-white/5 border-white/12 pr-12"
            />
            <button type="button" aria-label={showPw ? "Hide password" : "Show password"} onClick={() => setShowPw(!showPw)} className="absolute right-3 top-1/2 -translate-y-1/2 text-white/50 hover:text-white/80">
              {showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </div>
        <Button data-testid="auth-primary-submit-button" type="submit" disabled={busy} className="w-full h-12 rounded-xl text-base font-bold hover:brightness-110 active:scale-[0.98] transition-[filter,transform] duration-150">
          {busy ? "Logging in…" : "Log in"}
        </Button>
      </form>
      <div className="mt-5 flex items-center justify-between text-sm">
          <button type="button" data-testid="login-forgot-link" onClick={() => goPanel(AUTH_PANELS.FORGOT)} className="text-white/60 hover:text-white/85">
            Forgot password?
          </button>

        <button type="button" onClick={() => goPanel(AUTH_PANELS.REGISTER)} className="text-white/60 hover:text-white/85">Create account</button>
      </div>
    </div>
  );
}
