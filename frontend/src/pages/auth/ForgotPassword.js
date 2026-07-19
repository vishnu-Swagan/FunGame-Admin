import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, errMsg } from "@/lib/api";
import { AuthShell } from "@/pages/auth/AuthShell";

export default function ForgotPassword() {
  const navigate = useNavigate();
  const [step, setStep] = useState(1);
  const [email, setEmail] = useState("");
  const [devCode, setDevCode] = useState(null);
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const requestCode = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const { data } = await api.post("/auth/forgot-password", { email });
      setDevCode(data.dev_code || null);
      toast.success(data.message);
      setStep(2);
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const reset = async (e) => {
    e.preventDefault();
    if (newPassword.length < 8) {
      toast.error("Password must be at least 8 characters");
      return;
    }
    setBusy(true);
    try {
      const { data } = await api.post("/auth/reset-password", { email, code, new_password: newPassword });
      toast.success(data.message);
      navigate("/login");
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Reset password" subtitle={step === 1 ? "We will send a reset code to your email." : "Enter the code and choose a new password."} backTo="/login">
      {step === 1 ? (
        <form onSubmit={requestCode} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="fp-email">Email</Label>
            <Input id="fp-email" data-testid="forgot-email-input" type="email" required placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} className="h-12 rounded-xl bg-white/5 border-white/12" />
          </div>
          <Button data-testid="auth-primary-submit-button" type="submit" disabled={busy} className="w-full h-12 rounded-xl text-base font-bold">
            {busy ? "Sending…" : "Send reset code"}
          </Button>
        </form>
      ) : (
        <form onSubmit={reset} className="space-y-4">
          {devCode && (
            <div data-testid="dev-code-banner" className="rounded-xl border border-[hsl(var(--cyan)/0.35)] bg-[hsl(var(--cyan)/0.1)] p-3.5">
              <p className="text-xs font-semibold text-[hsl(var(--cyan))] flex items-center gap-1.5">
                <KeyRound className="h-3.5 w-3.5" /> DEMO MODE — your reset code
              </p>
              <p data-testid="dev-code-value" className="mt-1 font-mono text-2xl font-bold tracking-[0.3em] text-white">{devCode}</p>
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="fp-code">Reset code</Label>
            <Input id="fp-code" data-testid="forgot-code-input" required placeholder="6-digit code" value={code} onChange={(e) => setCode(e.target.value)} className="h-12 rounded-xl bg-white/5 border-white/12" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="fp-new">New password</Label>
            <Input id="fp-new" data-testid="forgot-new-password-input" type="password" required minLength={8} placeholder="At least 8 characters" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} className="h-12 rounded-xl bg-white/5 border-white/12" />
          </div>
          <Button data-testid="forgot-reset-submit-button" type="submit" disabled={busy} className="w-full h-12 rounded-xl text-base font-bold">
            {busy ? "Resetting…" : "Reset password"}
          </Button>
        </form>
      )}
    </AuthShell>
  );
}
