import { useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { toast } from "sonner";
import { MailCheck, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { api, errMsg } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { AuthShell } from "@/pages/auth/AuthShell";

export default function VerifyEmail() {
  const navigate = useNavigate();
  const location = useLocation();
  const { login } = useAuth();
  const [email, setEmail] = useState(location.state?.email || "");
  const [devCode, setDevCode] = useState(location.state?.devCode || null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e?.preventDefault();
    if (!email) {
      toast.error("Enter your email");
      return;
    }
    if (code.length !== 6) {
      toast.error("Enter the 6-digit code");
      return;
    }
    setBusy(true);
    try {
      const { data } = await api.post("/auth/verify-email", { email, code });
      if (data.access_token) {
        login(data.access_token, data.user);
        toast.success("Email verified!");
        navigate("/onboarding/profile", { replace: true });
      } else {
        toast.info(data.message);
        navigate("/login");
      }
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    if (!email) {
      toast.error("Enter your email first");
      return;
    }
    try {
      const { data } = await api.post("/auth/resend-verification", { email });
      setDevCode(data.dev_code || null);
      if (data.email_delivery === "failed") {
        toast.warning(data.message);
      } else {
        toast.success("Code re-sent");
      }
    } catch (err) {
      toast.error(errMsg(err));
    }
  };

  return (
    <AuthShell title="Verify your email" subtitle={`Enter the 6-digit code sent to ${email || "your email"}.`} backTo="/register">
      {devCode && (
        <div data-testid="dev-code-banner" className="mb-5 rounded-xl border border-[hsl(var(--cyan)/0.35)] bg-[hsl(var(--cyan)/0.1)] p-3.5">
          <p className="text-xs font-semibold text-[hsl(var(--cyan))] flex items-center gap-1.5">
            <MailCheck className="h-3.5 w-3.5" /> DEMO MODE — your verification code
          </p>
          <div className="mt-1.5 flex items-center gap-2">
            <span data-testid="dev-code-value" className="font-mono text-2xl font-bold tracking-[0.3em] text-white">{devCode}</span>
            <button
              aria-label="Copy code"
              onClick={() => {
                navigator.clipboard?.writeText(devCode);
                toast.success("Copied");
              }}
              className="h-8 w-8 flex items-center justify-center rounded-lg bg-white/5 border border-white/10 hover:bg-white/10"
            >
              <Copy className="h-3.5 w-3.5 text-white/70" />
            </button>
          </div>
          <p className="mt-1 text-[11px] text-white/50">Real emails activate once the operator connects SendGrid/SMTP.</p>
        </div>
      )}

      <form onSubmit={submit} className="space-y-5">
        {!location.state?.email && (
          <Input
            data-testid="verify-email-email-input"
            type="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="h-12 rounded-xl bg-white/5 border-white/12"
          />
        )}
        <div data-testid="verify-email-otp" className="flex justify-center">
          <InputOTP maxLength={6} value={code} onChange={setCode}>
            <InputOTPGroup className="gap-2">
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <InputOTPSlot key={i} index={i} className="h-12 w-11 rounded-xl border-white/15 bg-white/5 text-lg" />
              ))}
            </InputOTPGroup>
          </InputOTP>
        </div>
        <Button data-testid="verify-email-submit-button" type="submit" disabled={busy || code.length !== 6} className="w-full h-12 rounded-xl text-base font-bold hover:brightness-110 active:scale-[0.98] transition-[filter,transform] duration-150">
          {busy ? "Verifying…" : "Verify email"}
        </Button>
      </form>
      <button data-testid="verify-email-resend-button" onClick={resend} className="mt-5 text-sm text-primary font-semibold hover:underline">
        Resend code
      </button>
    </AuthShell>
  );
}
