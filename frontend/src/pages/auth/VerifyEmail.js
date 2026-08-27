import { useEffect, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { toast } from "sonner";
import { AlertTriangle, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { api, errMsg, routeForUser } from "@/lib/api";
import { normalizeContactChannel, normalizeContactIdentifier, registrationChannelAvailable, useAuthCapabilities, verificationChannelState } from "@/lib/authCapabilities";
import { useAuth } from "@/context/AuthContext";
import { AuthShell } from "@/pages/auth/AuthShell";

const DEFAULT_RESEND_SECONDS = 30;

export default function VerifyEmail() {
  const navigate = useNavigate();
  const location = useLocation();
  const { login } = useAuth();
  const { capabilities, loading: capabilitiesLoading } = useAuthCapabilities();
  const initial = location.state || {};
  const issuedChallenge = Boolean(initial.identifier || initial.email);
  const [channel, setChannel] = useState(normalizeContactChannel(initial.channel || "PHONE", initial.identifier || initial.email));
  const [identifier, setIdentifier] = useState(initial.identifier || initial.email || "");
  const [secondaryIdentifier] = useState(initial.secondaryIdentifier || "");
  const [destinationMasked, setDestinationMasked] = useState(initial.destinationMasked || "");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [resending, setResending] = useState(false);
  const [resendIn, setResendIn] = useState(Number(initial.resendAfter || 0));

  useEffect(() => {
    if (resendIn <= 0) return undefined;
    const timer = window.setInterval(() => setResendIn((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [resendIn]);

  useEffect(() => {
    if (issuedChallenge || capabilitiesLoading || registrationChannelAvailable(capabilities, channel)) return;
    if (registrationChannelAvailable(capabilities, "PHONE")) setChannel("PHONE");
  }, [capabilities, capabilitiesLoading, channel, issuedChallenge]);

  const {
    deliveryAvailable: selectedChannelAvailable,
    verificationAvailable,
    anyChannelAvailable,
  } = verificationChannelState(capabilities, channel, issuedChallenge);
  // An OTP that has already been delivered remains verifiable if delivery is
  // later paused. Only direct-entry verification and resend require a live
  // delivery channel.

  const normalizedIdentifier = () => normalizeContactIdentifier(channel, identifier);

  const submit = async (event) => {
    event?.preventDefault();
    if (!verificationAvailable) return toast.info("Verification is temporarily unavailable for this contact method.");
    if (!identifier.trim()) return toast.error(`Enter your ${channel === "PHONE" ? "mobile number" : "email"}`);
    if (code.length !== 6) return toast.error("Enter the 6-digit code");
    if (password.length < 8) return toast.error("Password must be at least 8 characters");
    if (password !== confirmPassword) return toast.error("Passwords do not match");
    setBusy(true);
    try {
      const contact = normalizedIdentifier();
      const { data } = await api.post("/auth/verify-otp", {
        channel,
        identifier: contact,
        email: channel === "EMAIL" ? contact : undefined,
        phone: channel === "PHONE" ? contact : undefined,
        code,
        password,
      });
      if (data?.next_verification) {
        const next = data.next_verification;
        const nextChannel = normalizeContactChannel(next.channel || "EMAIL", secondaryIdentifier);
        const nextIdentifier = secondaryIdentifier || next.identifier || "";
        if (!nextIdentifier) {
          toast.info("Mobile verified. Sign in again to continue email verification.");
          navigate("/login", { replace: true });
          return;
        }
        setChannel(nextChannel);
        setIdentifier(nextIdentifier);
        setDestinationMasked(next.destination_masked || next.destination || "");
        setResendIn(Number(next.resend_after_seconds || next.resend_in || DEFAULT_RESEND_SECONDS));
        setCode("");
        toast.success(data.message || "Mobile verified. Check your email for the next code.");
        return;
      }
      if (data.access_token) {
        login(data.access_token, data.user);
        toast.success("Contact verified");
        navigate(routeForUser(data.user), { replace: true });
      } else {
        toast.success(data.message || "Contact verified. You can now log in.");
        navigate("/login", { replace: true });
      }
    } catch (error) {
      toast.error(errMsg(error));
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    if (capabilitiesLoading || !selectedChannelAvailable) return toast.info("Sending a new code is temporarily unavailable for this contact method.");
    if (!identifier.trim()) return toast.error("Enter your contact details first");
    setResending(true);
    try {
      const contact = normalizedIdentifier();
      const { data } = await api.post("/auth/resend-otp", {
        channel,
        identifier: contact,
        email: channel === "EMAIL" ? contact : undefined,
        phone: channel === "PHONE" ? contact : undefined,
      });
      setDestinationMasked(data.destination_masked || destinationMasked);
      setResendIn(Number(data.resend_after_seconds || DEFAULT_RESEND_SECONDS));
      setCode("");
      toast.success(data.message || "A new code was sent");
    } catch (error) {
      toast.error(errMsg(error));
    } finally {
      setResending(false);
    }
  };

  const destination = destinationMasked || identifier || (channel === "PHONE" ? "your mobile" : "your email");

  if (!capabilitiesLoading && capabilities.registration_mode === "ADMIN_REVIEW" && !issuedChallenge) {
    return (
      <AuthShell title="Administrator review" subtitle="Contact OTP is not part of the current registration flow." backTo="/register">
        <div className="rounded-xl border border-amber-300/25 bg-amber-300/8 p-4 text-sm leading-relaxed text-amber-100">
          Enter your email, mobile number and password on the registration page. An administrator must approve the account before you can log in and play.
        </div>
        <Button type="button" onClick={() => navigate("/register")} className="mt-5 h-12 w-full rounded-xl font-bold">
          Go to registration
        </Button>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Verify your account" subtitle={`Enter the 6-digit code sent to ${destination}.`} backTo="/register">
      {!issuedChallenge && !capabilitiesLoading && !anyChannelAvailable && (
        <div data-testid="verification-unavailable" className="mb-5 flex items-start gap-2.5 rounded-xl border border-amber-300/25 bg-amber-300/8 p-3 text-xs leading-relaxed text-amber-100">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
          <span><strong>Verification is temporarily unavailable.</strong> Mobile code delivery is not currently ready. Please try again later.</span>
        </div>
      )}
      {issuedChallenge && !capabilitiesLoading && !selectedChannelAvailable && (
        <div data-testid="verification-resend-unavailable" className="mb-5 flex items-start gap-2.5 rounded-xl border border-amber-300/25 bg-amber-300/8 p-3 text-xs leading-relaxed text-amber-100">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
          <span>Your delivered code can still be verified, but sending a new code is temporarily unavailable.</span>
        </div>
      )}
      {!initial.identifier && !initial.email && (
        <div className="space-y-3 mb-5">
          <div className="flex h-10 items-center justify-center gap-2 rounded-xl border border-primary/55 bg-primary/12 text-sm font-semibold text-primary">
            <Smartphone className="h-4 w-4" /> Mobile OTP verification
          </div>
          <Input data-testid="verify-identifier-input" disabled={capabilitiesLoading || !selectedChannelAvailable} type="tel" placeholder="+91 98765 43210" value={identifier} onChange={(event) => setIdentifier(event.target.value)} className="h-12 rounded-xl bg-white/5 border-white/12" />
        </div>
      )}
      <form onSubmit={submit} className="space-y-5">
        <div data-testid="verify-email-otp" className="flex justify-center">
          <InputOTP maxLength={6} value={code} onChange={setCode}>
            <InputOTPGroup className="gap-2">
              {[0, 1, 2, 3, 4, 5].map((index) => <InputOTPSlot key={index} index={index} className="h-12 w-11 rounded-xl border-white/15 bg-white/5 text-lg" />)}
            </InputOTPGroup>
          </InputOTP>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="verify-password" className="text-sm font-medium">Create your password</label>
          <Input id="verify-password" data-testid="verify-password-input" type="password" autoComplete="new-password" required minLength={8} placeholder="At least 8 characters" value={password} onChange={(event) => setPassword(event.target.value)} className="h-12 rounded-xl bg-white/5 border-white/12" />
          <p className="text-[11px] leading-relaxed text-white/45">For your security, the password is saved only after this code proves you own the contact method.</p>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="verify-password-confirm" className="text-sm font-medium">Confirm password</label>
          <Input id="verify-password-confirm" data-testid="verify-password-confirm-input" type="password" autoComplete="new-password" required minLength={8} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} className="h-12 rounded-xl bg-white/5 border-white/12" />
        </div>
        <Button data-testid="verify-email-submit-button" type="submit" disabled={busy || !verificationAvailable || code.length !== 6 || password.length < 8 || password !== confirmPassword} className="w-full h-12 rounded-xl text-base font-bold">
          {busy ? "Verifying…" : "Verify account"}
        </Button>
      </form>
      <button data-testid="verify-email-resend-button" type="button" onClick={resend} disabled={resending || resendIn > 0 || capabilitiesLoading || !selectedChannelAvailable} className="mt-5 text-sm text-primary font-semibold hover:underline disabled:text-white/35 disabled:no-underline">
        {resending ? "Sending…" : resendIn > 0 ? `Send a new code in ${resendIn}s` : "Send a new code"}
      </button>
    </AuthShell>
  );
}
