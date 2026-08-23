import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { KeyRound, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BrandWordmark } from "@/components/Brand";
import { Disclaimer } from "@/components/common";
import { useAuth } from "@/context/AuthContext";
import { api, errMsg } from "@/lib/api";

export default function PartnerPasswordChange() {
  const navigate = useNavigate();
  const { setUser } = useAuth();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    if (next.length < 12) return toast.error("The new password must contain at least 12 characters");
    if (next !== confirm) return toast.error("The new passwords do not match");
    if (next === current) return toast.error("Choose a password different from the temporary password");
    setBusy(true);
    try {
      await api.post("/auth/change-password", { current_password: current, new_password: next });
      localStorage.removeItem("fg_token");
      setUser(null);
      toast.success("Password changed. Sign in again with your new password.");
      navigate("/distributor/login", { replace: true });
    } catch (error) {
      toast.error(errMsg(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="App fg-noise min-h-dvh bg-background px-5 py-10" data-testid="distributor-password-change">
      <section className="mx-auto max-w-md rounded-3xl border border-white/10 bg-card/70 p-5 shadow-2xl sm:p-7">
        <BrandWordmark logoClassName="h-auto w-full max-w-[320px]" />
        <div className="mt-7 flex items-start gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-primary/30 bg-primary/10"><KeyRound className="h-5 w-5 text-primary" /></span>
          <div>
            <h1 className="text-2xl font-bold">Replace temporary password</h1>
            <p className="mt-1 text-sm leading-relaxed text-white/55">Create a private password before opening the distributor portal.</p>
          </div>
        </div>

        <form className="mt-6 space-y-4" onSubmit={submit}>
          <PasswordField id="current-password" label="Temporary password" value={current} onChange={setCurrent} autoComplete="current-password" />
          <PasswordField id="new-password" label="New password" value={next} onChange={setNext} autoComplete="new-password" />
          <PasswordField id="confirm-password" label="Confirm new password" value={confirm} onChange={setConfirm} autoComplete="new-password" />
          <p className="flex items-start gap-2 text-[11px] leading-relaxed text-white/45"><ShieldCheck className="mt-px h-3.5 w-3.5 shrink-0 text-emerald-300" />Use at least 12 characters. You will sign in again after the change so the temporary session cannot remain active.</p>
          <Button type="submit" disabled={busy || !current || !next || !confirm} className="h-12 w-full rounded-xl font-bold">
            {busy ? "Changing password…" : "Change password and continue"}
          </Button>
        </form>
        <Disclaimer className="mt-7" />
      </section>
    </main>
  );
}

function PasswordField({ id, label, value, onChange, autoComplete }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} type="password" required minLength={12} maxLength={128} autoComplete={autoComplete}
        value={value} onChange={(event) => onChange(event.target.value)}
        className="h-12 rounded-xl border-white/12 bg-white/5" />
    </div>
  );
}
