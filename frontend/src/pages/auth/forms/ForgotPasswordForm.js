import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, errMsg } from "@/lib/api";
import { isValidE164Phone, normalizeContactIdentifier } from "@/lib/authCapabilities";
import { AUTH_PANELS, frontPathForAuthPanel } from "@/lib/frontDoor";
import { useNavigate } from "react-router-dom";

function resetIdentityPayload(identifier) {
  const raw = String(identifier || "").trim();
  if (isValidE164Phone(raw)) {
    const e164 = normalizeContactIdentifier("PHONE", raw);
    return { identifier: e164, phone: e164 };
  }
  const email = normalizeContactIdentifier("EMAIL", raw);
  return { identifier: email, email };
}

export default function ForgotPasswordForm({ onSwitchPanel, showTitle = false }) {
  const navigate = useNavigate();
  const [step, setStep] = useState(1);
  const [identifier, setIdentifier] = useState("");
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const goLogin = () => {
    if (onSwitchPanel) onSwitchPanel(AUTH_PANELS.LOGIN);
    else navigate(frontPathForAuthPanel(AUTH_PANELS.LOGIN));
  };

  const requestCode = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      const { data } = await api.post("/auth/forgot-password", resetIdentityPayload(identifier));
      toast.success(data.message || "If that account exists, a reset code has been sent.");
      if (data?.delivery_available === false) {
        return;
      }
      setStep(2);
    } catch (error) {
      toast.error(errMsg(error));
    } finally {
      setBusy(false);
    }
  };

  const reset = async (event) => {
    event.preventDefault();
    if (code.length !== 6) return toast.error("Enter the 6-digit code");
    if (newPassword.length < 8) return toast.error("Password must be at least 8 characters");
    setBusy(true);
    try {
      const { data } = await api.post("/auth/reset-password", {
        ...resetIdentityPayload(identifier),
        code,
        new_password: newPassword,
      });
      toast.success(data.message || "Password reset. You can now log in.");
      goLogin();
    } catch (error) {
      toast.error(errMsg(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="frontpage-forgot-panel">
      {showTitle && (
        <div className="mb-5">
          <h2 className="text-2xl font-bold tracking-tight">Reset password</h2>
          <p className="mt-1 text-sm text-white/65">
            {step === 1 ? "Reset with the verified mobile number (SMS OTP) or email." : "Enter the code and choose a new password."}
          </p>
        </div>
      )}
      {step === 1 ? (
        <form onSubmit={requestCode} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="fp-identifier">Email or mobile number</Label>
            <Input id="fp-identifier" data-testid="forgot-email-input" required autoComplete="username" placeholder="you@example.com or +country code mobile" value={identifier} onChange={(event) => setIdentifier(event.target.value)} className="h-12 rounded-xl bg-white/5 border-white/12" />
          </div>
          <Button data-testid="auth-primary-submit-button" type="submit" disabled={busy} className="w-full h-12 rounded-xl text-base font-bold">{busy ? "Sending…" : "Send reset code"}</Button>
          <p className="text-[11px] text-white/45 leading-relaxed">For privacy, the response is the same whether or not an account matches.</p>
        </form>
      ) : (
        <form onSubmit={reset} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="fp-code">Reset code</Label>
            <Input id="fp-code" data-testid="forgot-code-input" required inputMode="numeric" maxLength={6} pattern="[0-9]{6}" placeholder="6-digit code" value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))} className="h-12 rounded-xl bg-white/5 border-white/12" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="fp-new">New password</Label>
            <Input id="fp-new" data-testid="forgot-new-password-input" type="password" autoComplete="new-password" required minLength={8} placeholder="At least 8 characters" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} className="h-12 rounded-xl bg-white/5 border-white/12" />
          </div>
          <Button data-testid="forgot-reset-submit-button" type="submit" disabled={busy} className="w-full h-12 rounded-xl text-base font-bold">{busy ? "Resetting…" : "Reset password"}</Button>
        </form>
      )}
      <p className="mt-5 text-center text-sm text-white/60">
        <button type="button" onClick={goLogin} className="text-primary font-semibold hover:underline">Back to log in</button>
      </p>
    </div>
  );
}
