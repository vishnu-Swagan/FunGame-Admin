import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Eye, EyeOff, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, errMsg } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { AuthShell } from "@/pages/auth/AuthShell";

/** Private operator sign-in — reachable only at its own URL, not linked anywhere. */
export default function AdminLogin() {
  const navigate = useNavigate();
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const { data } = await api.post("/auth/login", { email, password });
      if (data.user.role !== "ADMIN") {
        // Player credentials don't belong here — send them to the player login.
        toast.error("This portal is for administrators only.");
        navigate("/login", { replace: true });
        return;
      }
      login(data.access_token, data.user);
      toast.success("Welcome back, Operator.");
      navigate("/admin", { replace: true });
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Operator access" subtitle="Restricted — administrators only.">
      <div className="mb-4 flex items-center gap-2.5 rounded-xl border border-primary/35 bg-primary/10 p-3 text-sm text-primary">
        <ShieldCheck className="h-4 w-4 shrink-0" />
        <span>Secure admin console. Sign in with your operator credentials.</span>
      </div>
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="admin-email">Admin Login ID or Email</Label>
          <Input
            id="admin-email"
            data-testid="admin-login-email-input"
            type="text"
            required
            autoComplete="username"
            placeholder="operator login"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="h-12 rounded-xl bg-white/5 border-white/12"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="admin-password">Password</Label>
          <div className="relative">
            <Input
              id="admin-password"
              data-testid="admin-login-password-input"
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
        <Button data-testid="admin-login-submit" type="submit" disabled={busy} className="w-full h-12 rounded-xl text-base font-bold hover:brightness-110 active:scale-[0.98] transition-[filter,transform] duration-150">
          {busy ? "Signing in…" : "Enter admin console"}
        </Button>
      </form>
    </AuthShell>
  );
}
