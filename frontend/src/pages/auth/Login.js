import { useState, useEffect } from "react";
import { useNavigate, Link } from "react-router-dom";
import { toast } from "sonner";
import { Eye, EyeOff, MonitorSmartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, errMsg, routeForUser } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { AuthShell } from "@/pages/auth/AuthShell";

export default function Login() {
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

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      // `email` keeps older API deployments compatible during the rollout.
      const { data } = await api.post("/auth/login", { identifier, email: identifier, password });
      if (data.user.role === "ADMIN") {
        toast.info("Administrators sign in on the dedicated operator console.");
        window.location.assign("https://crm.chakri.casino/admin/login");
        return;
      }
      login(data.access_token, data.user);
      toast.success(`Welcome back${data.user.display_name ? ", " + data.user.display_name : ""}!`);
      navigate(routeForUser(data.user), { replace: true });
    } catch (err) {
      const detail = err?.response?.data?.detail;
      if (["EMAIL_NOT_VERIFIED", "CONTACT_NOT_VERIFIED"].includes(detail?.code)) {
        const channel = detail?.channel || (identifier.includes("@") ? "EMAIL" : "PHONE");
        toast.info(`Please verify your ${channel === "PHONE" ? "mobile number" : "email"} first`);
        try {
          const { data } = await api.post("/auth/resend-otp", {
            channel,
            identifier,
            email: identifier,
          });
          navigate("/verify", { state: { channel, identifier, resendAfter: data?.resend_after_seconds } });
        } catch (_e) {
          navigate("/verify", { state: { channel, identifier } });
        }
      } else {
        toast.error(errMsg(err));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Welcome back" subtitle="Log in to enter the Chakri.Casino lounge.">
      {sessionNotice && (
        <div data-testid="session-replaced-notice" className="mb-4 flex items-start gap-2.5 rounded-xl border border-primary/35 bg-primary/10 p-3 text-sm text-primary">
          <MonitorSmartphone className="h-4 w-4 mt-0.5 shrink-0" />
          <span>{sessionNotice}</span>
        </div>
      )}
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="identifier">Email, mobile number, or Login ID</Label>
          <Input
            id="identifier"
            data-testid="login-email-input"
            type="text"
            required
            autoComplete="username"
            placeholder="email, +91 mobile, or GK Login ID"
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
        <Link data-testid="login-forgot-link" to="/forgot-password" className="text-white/60 hover:text-white/85">
          Forgot password?
        </Link>
        <Link to="/register" className="text-white/60 hover:text-white/85">Create account</Link>
      </div>
    </AuthShell>
  );
}
