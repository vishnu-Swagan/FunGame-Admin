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
  const [email, setEmail] = useState("");
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
      const { data } = await api.post("/auth/login", { email, password });
      login(data.access_token, data.user);
      toast.success(`Welcome back${data.user.display_name ? ", " + data.user.display_name : ""}!`);
      navigate(routeForUser(data.user), { replace: true });
    } catch (err) {
      const detail = err?.response?.data?.detail;
      if (detail?.code === "EMAIL_NOT_VERIFIED") {
        toast.info("Please verify your email first");
        try {
          const { data: rs } = await api.post("/auth/resend-verification", { email });
          navigate("/verify-email", { state: { email, devCode: rs.dev_code } });
        } catch (_e) {
          navigate("/verify-email", { state: { email } });
        }
      } else {
        toast.error(errMsg(err));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Welcome back" subtitle="Log in to enter the FunGame lounge.">
      {sessionNotice && (
        <div data-testid="session-replaced-notice" className="mb-4 flex items-start gap-2.5 rounded-xl border border-primary/35 bg-primary/10 p-3 text-sm text-primary">
          <MonitorSmartphone className="h-4 w-4 mt-0.5 shrink-0" />
          <span>{sessionNotice}</span>
        </div>
      )}
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="email">Login ID or Email</Label>
          <Input
            id="email"
            data-testid="login-email-input"
            type="text"
            required
            autoComplete="username"
            placeholder="your Login ID or email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
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
        <span className="text-white/40">Accounts are issued by the operator</span>
      </div>
    </AuthShell>
  );
}
