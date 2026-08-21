import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { LockKeyhole, Smartphone, UserCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, errMsg } from "@/lib/api";
import { isValidE164Phone, normalizeContactIdentifier, registrationChannelAvailable, useAuthCapabilities } from "@/lib/authCapabilities";
import { AuthShell } from "@/pages/auth/AuthShell";

export default function Register() {
  const navigate = useNavigate();
  const { capabilities, loading: capabilitiesLoading } = useAuthCapabilities();
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [dob, setDob] = useState("");
  const [country, setCountry] = useState("India");
  const [password, setPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [busy, setBusy] = useState(false);

  const selectedChannelAvailable = registrationChannelAvailable(capabilities, "PHONE");
  const registrationAvailable = selectedChannelAvailable;
  const manualReview = capabilities?.registration_mode === "ADMIN_REVIEW";

  const submit = async (event) => {
    event.preventDefault();
    if (capabilitiesLoading || !registrationAvailable || !selectedChannelAvailable) {
      return toast.info("Registration is temporarily unavailable for this contact method.");
    }
    if (!termsAccepted) return toast.error("Please accept the account and play terms");
    if (!isValidE164Phone(phone)) {
      return toast.error("Enter your mobile number with country code, for example +919876543210");
    }
    if (manualReview && !email.trim()) return toast.error("Enter your email address");
    if (manualReview && password.length < 8) return toast.error("Password must contain at least 8 characters");
    if (manualReview && password !== passwordConfirmation) return toast.error("Password confirmation does not match");
    setBusy(true);
    try {
      const normalized = normalizeContactIdentifier("PHONE", phone);
      const { data } = await api.post("/auth/register", {
        channel: "PHONE",
        identifier: normalized,
        phone: normalized,
        email: email.trim().toLowerCase() || undefined,
        full_name: fullName.trim(),
        date_of_birth: dob,
        country,
        accepted_terms: true,
        ...(manualReview ? { password, password_confirmation: passwordConfirmation } : {}),
      });
      toast.success(data?.message || (manualReview ? "Registration submitted for review" : "Verification code sent"));
      if (manualReview) {
        navigate("/login", { state: { registrationSubmitted: true } });
        return;
      }
      navigate("/verify", {
        state: {
          channel: "PHONE",
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
    <AuthShell
      title="Create your account"
      subtitle={manualReview
        ? "Enter your details and create a password. An administrator will review your account before you can play."
        : "Register with your mobile number. We will send a one-time SMS code before you create your password."}
    >
      <div className="mb-5 flex h-11 items-center justify-center gap-2 rounded-xl border border-primary/55 bg-primary/12 text-sm font-semibold text-primary">
        {manualReview ? <UserCheck className="h-4 w-4" /> : <Smartphone className="h-4 w-4" />}
        {manualReview ? "Administrator account review" : "Mobile OTP verification"}
      </div>

      <form onSubmit={submit} className="space-y-4">
        <Field label="Full name" htmlFor="reg-name">
          <Input id="reg-name" required minLength={2} maxLength={64} autoComplete="name" value={fullName} onChange={(e) => setFullName(e.target.value)} className="h-12 rounded-xl bg-white/5 border-white/12" />
        </Field>
        <Field label="Mobile number with country code" htmlFor="reg-contact">
          <Input
            id="reg-contact"
            data-testid="register-identifier-input"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            required
            placeholder="+91 98765 43210"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className="h-12 rounded-xl bg-white/5 border-white/12"
          />
        </Field>
        <Field label={manualReview ? "Email address" : "Email address (optional, no verification)"} htmlFor="reg-email">
          <Input id="reg-email" data-testid="register-email-input" required={manualReview} type="email" inputMode="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" className="h-12 rounded-xl bg-white/5 border-white/12" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Date of birth" htmlFor="reg-dob">
            <Input id="reg-dob" type="date" required max={new Date().toISOString().slice(0, 10)} value={dob} onChange={(e) => setDob(e.target.value)} className="h-12 rounded-xl bg-white/5 border-white/12" />
          </Field>
          <Field label="Country" htmlFor="reg-country">
            <Input id="reg-country" required value={country} onChange={(e) => setCountry(e.target.value)} className="h-12 rounded-xl bg-white/5 border-white/12" />
          </Field>
        </div>
        {manualReview && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Create password" htmlFor="reg-password">
              <Input id="reg-password" data-testid="register-password-input" type="password" required minLength={8} maxLength={128} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} className="h-12 rounded-xl bg-white/5 border-white/12" />
            </Field>
            <Field label="Confirm password" htmlFor="reg-password-confirmation">
              <Input id="reg-password-confirmation" data-testid="register-password-confirmation-input" type="password" required minLength={8} maxLength={128} autoComplete="new-password" value={passwordConfirmation} onChange={(e) => setPasswordConfirmation(e.target.value)} className="h-12 rounded-xl bg-white/5 border-white/12" />
            </Field>
          </div>
        )}
        <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-white/10 bg-white/5 p-3.5">
          <Checkbox
            data-testid="register-terms-checkbox"
            checked={termsAccepted}
            onCheckedChange={(value) => setTermsAccepted(!!value)}
            className="mt-0.5"
          />
          <span className="text-xs leading-relaxed text-white/70">
            I confirm that my details are accurate, I am eligible to use the service, and I accept the account and play terms.
          </span>
        </label>
        <p data-testid="register-verification-copy" className="text-[11px] text-white/45 leading-relaxed">
          {manualReview
            ? "No verification code is sent. Your email and mobile remain unverified until OTP verification is restored; an administrator must approve this account before login and play."
            : "Your email is optional and remains unverified. You create your password only after the SMS code proves you own the mobile number."}
        </p>
        <p className="text-[11px] text-white/45 leading-relaxed">Real-money deposits and withdrawals remain unavailable until required identity, age and jurisdiction checks are complete.</p>
        <Button data-testid="auth-primary-submit-button" type="submit" disabled={busy || capabilitiesLoading || !selectedChannelAvailable || !termsAccepted} className="w-full h-12 rounded-xl text-base font-bold">
          {manualReview && <LockKeyhole className="mr-2 h-4 w-4" />}
          {capabilitiesLoading
            ? "Checking availability…"
            : busy
              ? (manualReview ? "Submitting…" : "Sending code…")
              : registrationAvailable
                ? (manualReview ? "Create account for review" : "Send mobile verification code")
                : "Registration temporarily unavailable"}
        </Button>
      </form>
      <p className="mt-5 text-center text-sm text-white/60">Already registered? <Link to="/login" className="text-primary font-semibold hover:underline">Log in</Link></p>
    </AuthShell>
  );
}

function Field({ label, htmlFor, children }) {
  return <div className="space-y-1.5"><Label htmlFor={htmlFor}>{label}</Label>{children}</div>;
}
