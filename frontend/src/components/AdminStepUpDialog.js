import { useEffect, useState } from "react";
import { KeyRound, LockKeyhole, ShieldCheck, X } from "lucide-react";
import { toast } from "sonner";

import { api, errCode, errMsg } from "@/lib/api";

const STEP_UP_REQUIRED_CODES = new Set([
  "ADMIN_MFA_REQUIRED",
  "ADMIN_STEP_UP_REQUIRED",
]);

export function requiresAdminStepUp(error) {
  return STEP_UP_REQUIRED_CODES.has(errCode(error));
}

/** Password + one-time-code ceremony for sensitive operator actions. The
 * intended mutation remains with the parent and is retried only after the
 * server confirms both factors. Passwords and codes never enter storage. */
export default function AdminStepUpDialog({ actionLabel, open, onCancel, onVerified }) {
  const [stage, setStage] = useState("PASSWORD");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [challenge, setChallenge] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setStage("PASSWORD");
    setPassword("");
    setCode("");
    setChallenge(null);
    setBusy(false);
  }, [open, actionLabel]);

  if (!open) return null;

  const close = () => {
    if (!busy) onCancel?.();
  };

  const start = async (event) => {
    event.preventDefault();
    if (!password) return toast.error("Enter your administrator password");
    setBusy(true);
    try {
      const { data } = await api.post("/admin/security/step-up/start", {
        current_password: password,
      });
      setPassword("");
      if (data?.verified || data?.password_only) {
        toast.success(data.message || "Administrator verification complete");
        try {
          await onVerified?.();
        } finally {
          setBusy(false);
          onCancel?.();
        }
        return;
      }
      setChallenge(data);
      setStage("CODE");
      toast.success(data.message || "Security code sent");
    } catch (error) {
      toast.error(errMsg(error));
    } finally {
      setBusy(false);
    }
  };

  const verify = async (event) => {
    event.preventDefault();
    if (code.length !== 6) return toast.error("Enter the 6-digit security code");
    setBusy(true);
    try {
      const { data } = await api.post("/admin/security/step-up/verify", {
        challenge_id: challenge.challenge_id,
        code,
      });
      toast.success(data.message || "Administrator verification complete");
    } catch (error) {
      toast.error(errMsg(error));
      setBusy(false);
      return;
    }

    // Verification consumes the code, so the exact pending action gets one
    // retry. Its own error handling lives in the parent and cannot accidentally
    // resubmit this already-consumed challenge.
    try {
      await onVerified?.();
    } finally {
      setBusy(false);
      onCancel?.();
    }
  };

  const destination = challenge?.destination_masked || challenge?.destination;

  return (
    <div className="fixed inset-0 z-[100] grid place-items-center bg-black/75 p-4 backdrop-blur-sm"
      role="presentation" data-testid="admin-step-up-dialog">
      <section role="dialog" aria-modal="true" aria-labelledby="admin-step-up-title"
        className="w-full max-w-md rounded-2xl border border-primary/30 bg-[#111827] p-5 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-primary/30 bg-primary/10 text-primary">
              <ShieldCheck className="h-5 w-5" />
            </span>
            <div>
              <h2 id="admin-step-up-title" className="font-display text-lg text-white">Confirm sensitive action</h2>
              <p className="mt-1 text-xs leading-relaxed text-white/55">
                Verify your administrator identity before {actionLabel || "continuing"}.
              </p>
            </div>
          </div>
          <button type="button" onClick={close} disabled={busy} aria-label="Cancel administrator verification"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-white/5 text-white/60 disabled:opacity-40">
            <X className="h-4 w-4" />
          </button>
        </div>

        {stage === "PASSWORD" ? (
          <form onSubmit={start} className="mt-5 space-y-4" data-testid="admin-step-up-password-form">
            <label className="block space-y-1.5" htmlFor="admin-step-up-password">
              <span className="text-xs text-white/65">Current administrator password</span>
              <span className="relative block">
                <LockKeyhole className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/35" />
                <input id="admin-step-up-password" type="password" required autoFocus
                  autoComplete="current-password" value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  className="h-11 w-full rounded-xl border border-white/12 bg-white/5 pl-10 pr-3 text-sm text-white" />
              </span>
            </label>
            <button type="submit" disabled={busy || !password}
              className="h-11 w-full rounded-xl bg-primary text-sm font-bold text-primary-foreground disabled:opacity-45">
              {busy ? "Checking…" : "Send security code"}
            </button>
          </form>
        ) : (
          <form onSubmit={verify} className="mt-5 space-y-4" data-testid="admin-step-up-code-form">
            <div className="rounded-xl border border-white/10 bg-white/[0.04] p-3 text-xs leading-relaxed text-white/60">
              <KeyRound className="mr-2 inline h-4 w-4 text-primary" />
              Enter the code sent to <strong className="text-white/85">{destination || "your verified contact"}</strong>.
            </div>
            <label className="block space-y-1.5" htmlFor="admin-step-up-code">
              <span className="text-xs text-white/65">6-digit security code</span>
              <input id="admin-step-up-code" type="text" required autoFocus inputMode="numeric"
                autoComplete="one-time-code" maxLength={6} pattern="[0-9]{6}" value={code}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
                className="h-12 w-full rounded-xl border border-white/12 bg-white/5 px-3 text-center font-mono text-xl tracking-[0.45em] text-white" />
            </label>
            <button type="submit" disabled={busy || code.length !== 6}
              className="h-11 w-full rounded-xl bg-primary text-sm font-bold text-primary-foreground disabled:opacity-45">
              {busy ? "Verifying…" : "Verify and continue"}
            </button>
          </form>
        )}
      </section>
    </div>
  );
}
