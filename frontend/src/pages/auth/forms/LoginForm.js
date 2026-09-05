import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Eye, EyeOff, MonitorSmartphone, ShieldCheck, UserCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, errMsg, routeForUser } from "@/lib/api";
import { LOGIN_SURFACES, loginRequestPayload } from "@/lib/loginSurface";
import { loginVerificationRecovery, normalizeAuthCapabilities, normalizeContactChannel, useAuthCapabilities } from "@/lib/authCapabilities";
import { useAuth } from "@/context/AuthContext";
import { AUTH_PANELS, frontPathForAuthPanel } from "@/lib/frontDoor";
import { adminLoginPathForConsole } from "@/lib/adminConsole";

/**
 * Shared login form. When `onSwitchPanel` is provided (frontpage embed), panel
 * switches stay on `/` instead of navigating to legacy auth routes.
 */
export default function LoginForm({
  onSwitchPanel,
  registrationSubmitted = false,
  showTitle = false,
}) {
  const navigate = useNavigate();
  const { login } = useAuth();
  const { capabilities } = useAuthCapabilities();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sessionNotice, setSessionNotice] = useState("");
  const [otpChallengeId, setOtpChallengeId] = useState("");
  const [otpDestination, setOtpDestination] = useState("");
  const [otpCode, setOtpCode] = useState("");
  const [resendIn, setResendIn] = useState(0);
  const passwordResetAvailable = capabilities.email_password_reset
    || capabilities.phone_password_reset;

  useEffect(() => {
    const reason = localStorage.getItem("fg_logout_reason");
    if (reason) {
      setSessionNotice(reason);
      localStorage.removeItem("fg_logout_reason");
    }
  }, []);

  useEffect(() => {
    if (resendIn <= 0) return undefined;
    const timer = window.setInterval(() => setResendIn((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [resendIn]);

  const goPanel = (panel) => {
    if (onSwitchPanel) onSwitchPanel(panel);
    else navigate(frontPathForAuthPanel(panel));
  };

  const finishLogin = (data) => {
      if (data.user.role === "ADMIN") {
        toast.info("Administrator accounts sign in through Chakri.Casino/Admin.");
        navigate(adminLoginPathForConsole(), { replace: true });
        return false;
      }
      if (data.user.role === "DISTRIBUTOR") {
        toast.info("Distributor accounts use the dedicated distributor portal.");
        navigate("/distributor/login", { replace: true });
        return false;
      }
      login(data.access_token, data.user);
      toast.success(`Welcome back${data.user.display_name ? ", " + data.user.display_name : ""}!`);
      navigate(routeForUser(data.user), { replace: true });
      return true;
  };

  const rememberOtpChallenge = (data) => {
    setOtpChallengeId(data?.challenge_id || data?.verification_id || "");
    setOtpDestination(data?.destination_masked || "your account contact");
    setOtpCode("");
    setResendIn(Number(data?.resend_after_seconds || 60));
    toast.success(data?.message || "Verification code sent");
  };

  const requestLogin = async () => {
    const { data } = await api.post(
      "/auth/login",
      loginRequestPayload(identifier, password, LOGIN_SURFACES.PLAYER),
    );
    if (data?.requires_otp) {
      rememberOtpChallenge(data);
      return;
    }
    finishLogin(data);
  };

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await requestLogin();
    } catch (err) {
      const detail = err?.response?.data?.detail;
      if (["EMAIL_NOT_VERIFIED", "CONTACT_NOT_VERIFIED"].includes(detail?.code)) {
        try {
          const { data: capabilityData } = await api.get("/auth/capabilities");
          const latestCapabilities = normalizeAuthCapabilities(capabilityData);
          const recovery = loginVerificationRecovery(
            latestCapabilities,
            detail?.channel,
            detail?.identifier || identifier,
          );
          const requestedChannel = recovery?.channel
            || normalizeContactChannel(detail?.channel, detail?.identifier || identifier);
          if (!recovery) {
            if (requestedChannel === "EMAIL" && latestCapabilities.email_verification_required !== true) {
              toast.info("Email verification is not required. Sign in with your mobile number or Login ID.");
              return;
            }
            toast.info(`Verification by ${requestedChannel === "PHONE" ? "mobile" : "email"} is temporarily unavailable. Contact an administrator.`);
            return;
          }
          toast.info(`Please verify your ${requestedChannel === "PHONE" ? "mobile number" : "email"} first`);
          const { data } = await api.post("/auth/resend-otp", recovery.body);
          navigate("/verify", { state: {
            channel: recovery.channel,
            identifier: recovery.contact,
            challengeId: data?.challenge_id || data?.verification_id || "",
            destinationMasked: data?.destination_masked,
            resendAfter: data?.resend_after_seconds,
            loginId: detail?.login_id || "",
          } });
        } catch (verificationError) {
          toast.error(errMsg(verificationError));
        }
      } else {
        toast.error(errMsg(err));
      }
    } finally {
      setBusy(false);
    }
  };

  const verifyLoginOtp = async (event) => {
    event.preventDefault();
    if (!/^\d{6}$/.test(otpCode)) return toast.error("Enter the 6-digit verification code.");
    setBusy(true);
    try {
      const { data } = await api.post("/auth/login/verify-otp", {
        challenge_id: otpChallengeId,
        code: otpCode,
      });
      finishLogin(data);
    } catch (error) {
      toast.error(errMsg(error));
    } finally {
      setBusy(false);
    }
  };

  const resendLoginOtp = async () => {
    setBusy(true);
    try {
      await requestLogin();
    } catch (error) {
      toast.error(errMsg(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="frontpage-login-panel">
      {showTitle && (
        <div className="mb-5">
          <h2 className="text-2xl font-bold tracking-tight">Welcome back</h2>
          <p className="mt-1 text-sm text-white/65">Log in to enter the Chakri.Casino lounge.</p>
        </div>
      )}
      {registrationSubmitted && (
        <div data-testid="registration-submitted-notice" className="mb-4 flex items-start gap-2.5 rounded-xl border border-amber-300/30 bg-amber-300/10 p-3 text-sm text-amber-100">
          <UserCheck className="h-4 w-4 mt-0.5 shrink-0" />
          <span>Registration submitted. You can log in after an administrator approves your account.</span>
        </div>
      )}
      {sessionNotice && (
        <div data-testid="session-replaced-notice" className="mb-4 flex items-start gap-2.5 rounded-xl border border-primary/35 bg-primary/10 p-3 text-sm text-primary">
          <MonitorSmartphone className="h-4 w-4 mt-0.5 shrink-0" />
          <span>{sessionNotice}</span>
        </div>
      )}
      {otpChallengeId ? (
        <form onSubmit={verifyLoginOtp} className="space-y-4" data-testid="login-otp-form">
          <div className="flex items-start gap-2.5 rounded-xl border border-primary/30 bg-primary/10 p-3 text-sm text-white/75">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <span>Enter the one-time code sent to <strong className="text-white">{otpDestination}</strong>.</span>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="login-otp">Login verification code</Label>
            <Input
              id="login-otp"
              data-testid="login-otp-input"
              required
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              placeholder="6-digit code"
              value={otpCode}
              onChange={(event) => setOtpCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
              className="h-12 rounded-xl bg-white/5 border-white/12"
            />
          </div>
          <Button data-testid="login-otp-submit-button" type="submit" disabled={busy || otpCode.length !== 6} className="w-full h-12 rounded-xl text-base font-bold">
            {busy ? "Verifying…" : "Verify and log in"}
          </Button>
          <div className="flex items-center justify-between text-xs text-white/55">
            <button type="button" disabled={busy || resendIn > 0} onClick={resendLoginOtp} className="hover:text-primary disabled:cursor-wait disabled:opacity-50">
              {resendIn > 0 ? `New code in ${resendIn}s` : "Send a new code"}
            </button>
            <button type="button" onClick={() => { setOtpChallengeId(""); setOtpCode(""); }} className="hover:text-primary">Use different details</button>
          </div>
        </form>
      ) : (
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="identifier">Email, mobile with +country code, or Login ID</Label>
          <Input
            id="identifier"
            data-testid="login-email-input"
            type="text"
            required
            autoComplete="username"
            placeholder="Email, mobile with +country code, or your Login ID"
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            className="h-12 rounded-xl bg-white/5 border-white/12"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="password">Password</Label>
          <div className="relative">
            <Input
              id="password"
              data-testid="login-password-input"
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
        <Button data-testid="auth-primary-submit-button" type="submit" disabled={busy} className="w-full h-12 rounded-xl text-base font-bold hover:brightness-110 active:scale-[0.98] transition-[filter,transform] duration-150">
          {busy ? "Logging in…" : "Log in"}
        </Button>
      </form>
      )}
      <div className="mt-5 flex items-center justify-between text-sm">
        {passwordResetAvailable ? (
          <button type="button" data-testid="login-forgot-link" onClick={() => goPanel(AUTH_PANELS.FORGOT)} className="text-white/60 hover:text-white/85">
            Forgot password?
          </button>
        ) : capabilities.manual_admin_review ? (
          <span data-testid="login-manual-recovery-note" className="text-xs text-white/50">
            Contact an administrator for password reset.
          </span>
        ) : <span />}
        <button type="button" onClick={() => goPanel(AUTH_PANELS.REGISTER)} className="text-white/60 hover:text-white/85">Create account</button>
      </div>
    </div>
  );
}
