import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { LockKeyhole, Smartphone, UserCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, errMsg } from "@/lib/api";
import { isValidE164Phone, normalizeContactIdentifier, registrationChannelAvailable, useAuthCapabilities } from "@/lib/authCapabilities";
import { COUNTRY_OPTIONS } from "@/lib/countryOptions";
import { AuthShell } from "@/pages/auth/AuthShell";

export default function Register() {
  const navigate = useNavigate();
  const formRef = useRef(null);
  const { capabilities, loading: capabilitiesLoading } = useAuthCapabilities();
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [dob, setDob] = useState("");
  const [country, setCountry] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [validationErrors, setValidationErrors] = useState({});

  const selectedChannelAvailable = registrationChannelAvailable(capabilities, "PHONE");
  const registrationAvailable = selectedChannelAvailable;
  const manualReview = capabilities?.registration_mode === "ADMIN_REVIEW";
  const emailVerificationRequired = !manualReview && capabilities?.email_verification_required === true;

  const clearValidationError = (field) => {
    setValidationErrors((current) => {
      if (!current[field]) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
  };

  const focusValidationField = (field) => {
    formRef.current?.querySelector(`[data-validation-field="${field}"]`)?.focus();
  };

  const validate = () => {
    const errors = {};
    const normalizedEmail = email.trim().toLowerCase();
    const emailInput = formRef.current?.querySelector("#reg-email");
    const today = new Date().toISOString().slice(0, 10);

    if (fullName.trim().length < 2) errors.fullName = "Enter your full name using at least 2 characters";
    else if (fullName.trim().length > 64) errors.fullName = "Full name must not exceed 64 characters";
    if (!isValidE164Phone(phone)) errors.phone = "Enter your mobile number in international format, starting with + and your country code";
    if ((manualReview || emailVerificationRequired) && !normalizedEmail) errors.email = "Enter your email address";
    else if (normalizedEmail && (normalizedEmail.length > 254 || emailInput?.validity?.typeMismatch)) errors.email = "Enter a valid email address";
    if (!dob) errors.dob = "Enter your date of birth";
    else if (dob > today) errors.dob = "Date of birth cannot be in the future";
    if (!country.trim()) errors.country = "Enter your country";
    else if (country.trim().length > 64) errors.country = "Country must not exceed 64 characters";
    if (manualReview && password.length < 8) errors.password = "Password must contain at least 8 characters";
    else if (manualReview && password.length > 128) errors.password = "Password must not exceed 128 characters";
    if (manualReview && password !== passwordConfirmation) errors.passwordConfirmation = "Password confirmation does not match";
    if (!termsAccepted) errors.terms = "Please accept the account and play terms";

    setValidationErrors(errors);
    const firstInvalidField = Object.keys(errors)[0];
    if (firstInvalidField) {
      focusValidationField(firstInvalidField);
      toast.error(errors[firstInvalidField]);
      return false;
    }
    return true;
  };

  const submit = async (event) => {
    event.preventDefault();
    if (capabilitiesLoading || !registrationAvailable || !selectedChannelAvailable) {
      return toast.info("Registration is temporarily unavailable for this contact method.");
    }
    if (!validate()) return;
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
          secondaryIdentifier: email.trim().toLowerCase(),
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
        : emailVerificationRequired
          ? "Verify your mobile number and email address with secure one-time codes before entering the lounge."
          : "Register with your mobile number. We will send a one-time SMS code before you create your password."}
    >
      {!emailVerificationRequired && (
        <div className="mb-5 flex h-11 items-center justify-center gap-2 rounded-xl border border-primary/55 bg-primary/12 text-sm font-semibold text-primary">
          {manualReview ? <UserCheck className="h-4 w-4" /> : <Smartphone className="h-4 w-4" />}
          {manualReview ? "Administrator account review" : "Mobile OTP verification"}
        </div>
      )}

      <form ref={formRef} onSubmit={submit} noValidate className="space-y-4">
        <p className="sr-only" role="alert" aria-live="assertive" data-testid="register-validation-summary">
          {validationErrors[Object.keys(validationErrors)[0]] || ""}
        </p>
        <Field label="Full name" htmlFor="reg-name" error={validationErrors.fullName}>
          <Input id="reg-name" data-validation-field="fullName" required minLength={2} maxLength={64} autoComplete="name" value={fullName} onChange={(e) => { setFullName(e.target.value); clearValidationError("fullName"); }} aria-invalid={Boolean(validationErrors.fullName)} aria-describedby={validationErrors.fullName ? "reg-name-error" : undefined} className="h-12 rounded-xl bg-white/5 border-white/12" />
        </Field>
        <Field label="Mobile number (enter with +country code)" htmlFor="reg-contact" error={validationErrors.phone}>
          <Input
            id="reg-contact"
            data-testid="register-identifier-input"
            data-validation-field="phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            required
            placeholder="Enter with +country code"
            value={phone}
            onChange={(e) => { setPhone(e.target.value); clearValidationError("phone"); }}
            aria-invalid={Boolean(validationErrors.phone)}
            aria-describedby={validationErrors.phone ? "reg-contact-error" : undefined}
            className="h-12 rounded-xl bg-white/5 border-white/12"
          />
        </Field>
        <Field label={manualReview || emailVerificationRequired ? "Email address" : "Email address (optional, no verification)"} htmlFor="reg-email" error={validationErrors.email}>
          <Input id="reg-email" data-testid="register-email-input" data-validation-field="email" required={manualReview || emailVerificationRequired} type="email" inputMode="email" autoComplete="email" value={email} onChange={(e) => { setEmail(e.target.value); clearValidationError("email"); }} aria-invalid={Boolean(validationErrors.email)} aria-describedby={validationErrors.email ? "reg-email-error" : undefined} placeholder="you@example.com" className="h-12 rounded-xl bg-white/5 border-white/12" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Date of birth" htmlFor="reg-dob" error={validationErrors.dob}>
            <Input id="reg-dob" data-validation-field="dob" type="date" required max={new Date().toISOString().slice(0, 10)} value={dob} onChange={(e) => { setDob(e.target.value); clearValidationError("dob"); }} aria-invalid={Boolean(validationErrors.dob)} aria-describedby={validationErrors.dob ? "reg-dob-error" : undefined} className="h-12 rounded-xl bg-white/5 border-white/12" />
          </Field>
          <Field label="Country" htmlFor="reg-country" error={validationErrors.country}>
            <select
              id="reg-country"
              data-validation-field="country"
              required
              autoComplete="country"
              value={country}
              onChange={(event) => { setCountry(event.target.value); clearValidationError("country"); }}
              aria-invalid={Boolean(validationErrors.country)}
              aria-describedby={validationErrors.country ? "reg-country-error" : undefined}
              className="h-12 w-full rounded-xl border border-white/12 bg-background px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="">Select your country</option>
              {COUNTRY_OPTIONS.map(({ code, name }) => (
                <option key={code} value={code}>{name}</option>
              ))}
            </select>
          </Field>
        </div>
        {manualReview && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Create password" htmlFor="reg-password" error={validationErrors.password}>
              <Input id="reg-password" data-testid="register-password-input" data-validation-field="password" type="password" required minLength={8} maxLength={128} autoComplete="new-password" value={password} onChange={(e) => { setPassword(e.target.value); clearValidationError("password"); }} aria-invalid={Boolean(validationErrors.password)} aria-describedby={validationErrors.password ? "reg-password-error" : undefined} className="h-12 rounded-xl bg-white/5 border-white/12" />
            </Field>
            <Field label="Confirm password" htmlFor="reg-password-confirmation" error={validationErrors.passwordConfirmation}>
              <Input id="reg-password-confirmation" data-testid="register-password-confirmation-input" data-validation-field="passwordConfirmation" type="password" required minLength={8} maxLength={128} autoComplete="new-password" value={passwordConfirmation} onChange={(e) => { setPasswordConfirmation(e.target.value); clearValidationError("passwordConfirmation"); }} aria-invalid={Boolean(validationErrors.passwordConfirmation)} aria-describedby={validationErrors.passwordConfirmation ? "reg-password-confirmation-error" : undefined} className="h-12 rounded-xl bg-white/5 border-white/12" />
            </Field>
          </div>
        )}
        <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-white/10 bg-white/5 p-3.5">
          <Checkbox
            data-testid="register-terms-checkbox"
            data-validation-field="terms"
            checked={termsAccepted}
            onCheckedChange={(value) => { setTermsAccepted(!!value); clearValidationError("terms"); }}
            aria-invalid={Boolean(validationErrors.terms)}
            aria-describedby={validationErrors.terms ? "reg-terms-error" : undefined}
            className="mt-0.5"
          />
          <span className="text-xs leading-relaxed text-white/70">
            I confirm that my details are accurate, I am eligible to use the service, and I accept the account and play terms.
          </span>
        </label>
        {validationErrors.terms && <p id="reg-terms-error" className="text-xs text-red-300">{validationErrors.terms}</p>}
        <p data-testid="register-verification-copy" className="text-[11px] text-white/45 leading-relaxed">
          {manualReview
            ? "No verification code is sent. Your email and mobile remain unverified until OTP verification is restored; an administrator must approve this account before login and play."
            : emailVerificationRequired
              ? "First verify the SMS code, then verify the code sent to your email. Your account activates only after both steps succeed."
              : "Your email is optional and remains unverified. You create your password only after the SMS code proves you own the mobile number."}
        </p>
        <p className="text-[11px] text-white/45 leading-relaxed">Virtual chips have no cash value and cannot be purchased, withdrawn, transferred, exchanged, or redeemed.</p>
        <Button data-testid="auth-primary-submit-button" type="submit" disabled={busy || capabilitiesLoading || !selectedChannelAvailable} className="w-full h-12 rounded-xl text-base font-bold">
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

function Field({ label, htmlFor, error, children }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {error && <p id={`${htmlFor}-error`} className="text-xs text-red-300">{error}</p>}
    </div>
  );
}
