import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Mail, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, errMsg } from "@/lib/api";
import { isValidE164Phone, normalizeContactIdentifier, registrationChannelAvailable, useAuthCapabilities } from "@/lib/authCapabilities";
import { AuthShell } from "@/pages/auth/AuthShell";

const CHANNELS = [
  { key: "EMAIL", label: "Email", icon: Mail },
  { key: "PHONE", label: "Mobile", icon: Smartphone },
];

export default function Register() {
  const navigate = useNavigate();
  const { capabilities, loading: capabilitiesLoading } = useAuthCapabilities();
  const [channel, setChannel] = useState("EMAIL");
  const [identifier, setIdentifier] = useState("");
  const [fullName, setFullName] = useState("");
  const [dob, setDob] = useState("");
  const [country, setCountry] = useState("India");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (capabilitiesLoading || registrationChannelAvailable(capabilities, channel)) return;
    if (registrationChannelAvailable(capabilities, "EMAIL")) setChannel("EMAIL");
    else if (registrationChannelAvailable(capabilities, "PHONE")) setChannel("PHONE");
  }, [capabilities, capabilitiesLoading, channel]);

  const selectedChannelAvailable = registrationChannelAvailable(capabilities, channel);
  const registrationAvailable = CHANNELS.some(({ key }) => registrationChannelAvailable(capabilities, key));

  const submit = async (event) => {
    event.preventDefault();
    if (capabilitiesLoading || !registrationAvailable || !selectedChannelAvailable) {
      return toast.info("Registration is temporarily unavailable for this contact method.");
    }
    if (password.length < 8) return toast.error("Password must be at least 8 characters");
    if (password !== confirm) return toast.error("Passwords do not match");
    if (channel === "PHONE" && !isValidE164Phone(identifier)) {
      return toast.error("Enter your mobile number with country code, for example +919876543210");
    }
    setBusy(true);
    try {
      const normalized = normalizeContactIdentifier(channel, identifier);
      const { data } = await api.post("/auth/register", {
        channel,
        identifier: normalized,
        email: channel === "EMAIL" ? normalized : undefined,
        phone: channel === "PHONE" ? normalized : undefined,
        password,
        full_name: fullName.trim(),
        date_of_birth: dob,
        country,
      });
      toast.success(data?.message || "Verification code sent");
      navigate("/verify", {
        state: {
          channel,
          identifier: normalized,
          destinationMasked: data?.destination_masked,
          resendAfter: data?.resend_after_seconds,
        },
      });
    } catch (error) {
      toast.error(errMsg(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Create your account" subtitle="Choose one secure contact method. We will send a one-time verification code.">
      <div className="grid grid-cols-2 gap-2 mb-5" role="tablist" aria-label="Sign-up method">
        {CHANNELS.map(({ key, label, icon: Icon }) => {
          const available = registrationChannelAvailable(capabilities, key);
          return <button
              key={key}
              type="button"
              role="tab"
              aria-selected={channel === key}
              aria-disabled={capabilitiesLoading || !available}
              disabled={capabilitiesLoading || !available}
              data-testid={`register-channel-${key.toLowerCase()}`}
              onClick={() => { setChannel(key); setIdentifier(""); }}
              className={`h-11 rounded-xl border flex items-center justify-center gap-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40 ${channel === key && available ? "border-primary/55 bg-primary/12 text-primary" : "border-white/10 bg-white/5 text-white/65"}`}
            >
              <Icon className="h-4 w-4" /> {label}
            </button>;
        })}
      </div>

      <form onSubmit={submit} className="space-y-4">
        <Field label="Full name" htmlFor="reg-name">
          <Input id="reg-name" required minLength={2} maxLength={64} autoComplete="name" value={fullName} onChange={(e) => setFullName(e.target.value)} className="h-12 rounded-xl bg-white/5 border-white/12" />
        </Field>
        <Field label={channel === "EMAIL" ? "Email address" : "Mobile number with country code"} htmlFor="reg-contact">
          <Input
            id="reg-contact"
            data-testid="register-identifier-input"
            type={channel === "EMAIL" ? "email" : "tel"}
            inputMode={channel === "EMAIL" ? "email" : "tel"}
            autoComplete={channel === "EMAIL" ? "email" : "tel"}
            required
            placeholder={channel === "EMAIL" ? "you@example.com" : "+91 98765 43210"}
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            className="h-12 rounded-xl bg-white/5 border-white/12"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Date of birth" htmlFor="reg-dob">
            <Input id="reg-dob" type="date" required max={new Date().toISOString().slice(0, 10)} value={dob} onChange={(e) => setDob(e.target.value)} className="h-12 rounded-xl bg-white/5 border-white/12" />
          </Field>
          <Field label="Country" htmlFor="reg-country">
            <Input id="reg-country" required value={country} onChange={(e) => setCountry(e.target.value)} className="h-12 rounded-xl bg-white/5 border-white/12" />
          </Field>
        </div>
        <Field label="Password" htmlFor="reg-password">
          <Input id="reg-password" type="password" autoComplete="new-password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} className="h-12 rounded-xl bg-white/5 border-white/12" />
        </Field>
        <Field label="Confirm password" htmlFor="reg-confirm">
          <Input id="reg-confirm" type="password" autoComplete="new-password" required minLength={8} value={confirm} onChange={(e) => setConfirm(e.target.value)} className="h-12 rounded-xl bg-white/5 border-white/12" />
        </Field>
        <p className="text-[11px] text-white/45 leading-relaxed">You will re-enter this password with the OTP. It is not saved until your contact ownership is verified.</p>
        <p className="text-[11px] text-white/45 leading-relaxed">Deposits, gameplay and withdrawals remain unavailable until required identity, age and jurisdiction checks are complete.</p>
        <Button data-testid="auth-primary-submit-button" type="submit" disabled={busy || capabilitiesLoading || !selectedChannelAvailable} className="w-full h-12 rounded-xl text-base font-bold">
          {capabilitiesLoading ? "Checking availability…" : busy ? "Creating account…" : registrationAvailable ? "Create account & verify" : "Registration temporarily unavailable"}
        </Button>
      </form>
      <p className="mt-5 text-center text-sm text-white/60">Already registered? <Link to="/login" className="text-primary font-semibold hover:underline">Log in</Link></p>
    </AuthShell>
  );
}

function Field({ label, htmlFor, children }) {
  return <div className="space-y-1.5"><Label htmlFor={htmlFor}>{label}</Label>{children}</div>;
}
