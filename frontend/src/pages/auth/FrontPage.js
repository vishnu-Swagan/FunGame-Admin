import { useEffect, useMemo } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { motion } from "framer-motion";
import { ShieldCheck, Coins, Gamepad2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Disclaimer, LoadingScreen } from "@/components/common";
import SiteFooter from "@/components/SiteFooter";
import { BrandWordmark } from "@/components/Brand";
import { useAuth } from "@/context/AuthContext";
import { routeForUser } from "@/lib/api";
import { useAuthCapabilities } from "@/lib/authCapabilities";
import { AUTH_PANELS, authPanelFromQuery, authSearchForPanel } from "@/lib/frontDoor";
import AppShell from "@/components/AppShell";
import PlayerLobby from "@/pages/app/PlayerLobby";
import LoginForm from "@/pages/auth/forms/LoginForm";
import RegisterForm from "@/pages/auth/forms/RegisterForm";
import ForgotPasswordForm from "@/pages/auth/forms/ForgotPasswordForm";

const BASE_FEATURES = [
  { icon: Gamepad2, title: "Premium digital games", text: "Enter the live game lobby and explore the available tables and arcade titles." },
  { icon: Coins, title: "Virtual play chips", text: "Request play chips from an operator and follow the approval status from your profile." },
];

/**
 * Single front door for chakri.casino:
 * - logged out → welcome branding + inline login/register/forgot panels
 * - ACTIVE player → AppShell + lobby (game cards launch straight into play)
 */
export default function FrontPage() {
  const { user, loading } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  useEffect(() => {
    if (searchParams.get("verify") === "skip" || searchParams.get("email_verify") === "skip") {
      toast.info("Email verification is not required. Sign in with your mobile number or Login ID.");
      const next = new URLSearchParams(searchParams);
      next.delete("verify");
      next.delete("email_verify");
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  if (loading) return <LoadingScreen />;

  if (user) {
    if (user.role === "PLAYER" && user.status === "ACTIVE") {
      return (
        <AppShell>
          <PlayerLobby />
        </AppShell>
      );
    }
    const dest = routeForUser(user);
    // Unknown/legacy statuses map to `/` — park them on pending rather than looping.
    if (!dest || dest === "/" || dest.startsWith("/?")) {
      return <Navigate to="/onboarding/pending" replace />;
    }
    return <Navigate to={dest} replace />;
  }

  const panel = authPanelFromQuery(searchParams.get("auth"));
  const registrationSubmitted = searchParams.get("registered") === "1"
    || searchParams.get("registrationSubmitted") === "1";

  const setPanel = (nextPanel, opts = {}) => {
    const search = authSearchForPanel(nextPanel, Boolean(opts.registrationSubmitted));
    navigate({ pathname: "/", search }, { replace: true });
  };

  return (
    <LoggedOutFront
      panel={panel}
      registrationSubmitted={registrationSubmitted}
      onSwitchPanel={setPanel}
    />
  );
}

function LoggedOutFront({ panel, registrationSubmitted, onSwitchPanel }) {
  const { capabilities, loading: capabilitiesLoading } = useAuthCapabilities();
  const manualReview = capabilities.registration_mode === "ADMIN_REVIEW";
  const features = useMemo(() => [...BASE_FEATURES, manualReview
    ? { icon: ShieldCheck, title: "Admin-reviewed access", text: "Submit both contact details securely. Play begins only after an administrator approves the account." }
    : { icon: ShieldCheck, title: "Verified accounts", text: "Sign up securely with mandatory mobile OTP verification." }], [manualReview]);
  const channelSummary = manualReview
    ? "New accounts are reviewed by an administrator before login and play."
    : capabilities.phone_registration
      ? "Mobile OTP verification is available."
      : "Secure mobile OTP verification is required to activate a new account.";

  const showHero = panel === AUTH_PANELS.HERO;

  return (
    <div className="App fg-noise min-h-dvh bg-background relative overflow-hidden" data-testid="frontpage">
      <div className="fg-aurora absolute top-0 left-0 right-0 h-[220px] pointer-events-none" />
      <div className="relative z-[2] mx-auto max-w-[430px] px-6 min-h-dvh flex flex-col justify-between py-10">
        <div className="pt-10">
          <motion.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
            <BrandWordmark logoClassName="h-auto w-[min(88vw,380px)]" className="mb-5" />
            <h1 className="sr-only">CHAKRI.CASINO</h1>
            <p className="mt-3 text-base text-white/75 leading-relaxed">
              Premium virtual-chip digital entertainment in one glowing midnight lobby.
            </p>
            <Disclaimer className="mt-3" />
            <p className="mt-3 text-[11px] leading-relaxed text-white/45">
              Chakri.Casino is a virtual-chip digital entertainment service launched by Liberty Markets Ltd, a UK software development, sales and production company.
            </p>
          </motion.div>

          {showHero && (
            <div className="mt-8 space-y-3">
              {features.map(({ icon: Icon, title, text }, i) => (
                <motion.div
                  key={title}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.35, delay: 0.12 + i * 0.08 }}
                  className="flex items-start gap-3 rounded-2xl bg-card/55 backdrop-blur-md border border-white/10 p-4"
                >
                  <div className="h-9 w-9 shrink-0 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center">
                    <Icon className="h-4 w-4 text-primary" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold">{title}</p>
                    <p className="text-xs text-white/60 mt-0.5">{text}</p>
                  </div>
                </motion.div>
              ))}
            </div>
          )}

          {!showHero && (
            <div className="mt-8 rounded-2xl border border-white/10 bg-card/55 backdrop-blur-md p-4">
              <div className="mb-4 flex gap-2" role="tablist" aria-label="Account">
                {[
                  { id: AUTH_PANELS.LOGIN, label: "Log in", testId: "frontpage-tab-login" },
                  { id: AUTH_PANELS.REGISTER, label: "Create account", testId: "frontpage-tab-register" },
                  { id: AUTH_PANELS.FORGOT, label: "Forgot", testId: "frontpage-tab-forgot" },
                ].map(({ id, label, testId }) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={panel === id}
                    data-testid={testId}
                    onClick={() => onSwitchPanel(id)}
                    className={`flex-1 rounded-xl px-2 py-2 text-xs font-semibold border transition-[background-color,color] ${
                      panel === id
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-white/5 text-white/70 border-white/10 hover:bg-white/10"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {panel === AUTH_PANELS.LOGIN && (
                <LoginForm
                  onSwitchPanel={onSwitchPanel}
                  registrationSubmitted={registrationSubmitted}
                  showTitle
                />
              )}
              {panel === AUTH_PANELS.REGISTER && (
                <RegisterForm onSwitchPanel={onSwitchPanel} showTitle />
              )}
              {panel === AUTH_PANELS.FORGOT && (
                <ForgotPasswordForm onSwitchPanel={onSwitchPanel} showTitle />
              )}
            </div>
          )}
        </div>

        <div className="space-y-3 pt-8">
          {showHero && (
            <>
              <Button
                data-testid="welcome-register-button"
                onClick={() => onSwitchPanel(AUTH_PANELS.REGISTER)}
                className="w-full h-12 rounded-xl text-base font-bold hover:brightness-110 active:scale-[0.98] transition-[filter,transform] duration-150"
              >
                Create account
              </Button>
              <Button
                data-testid="welcome-login-button"
                onClick={() => onSwitchPanel(AUTH_PANELS.LOGIN)}
                className="w-full h-12 rounded-xl text-base font-bold hover:brightness-110 active:scale-[0.98] transition-[filter,transform] duration-150"
              >
                Log in instead
              </Button>
            </>
          )}
          {!showHero && (
            <button
              type="button"
              data-testid="frontpage-back-to-welcome"
              onClick={() => onSwitchPanel(AUTH_PANELS.HERO)}
              className="w-full text-center text-sm text-white/60 hover:text-white/85"
            >
              Back to welcome
            </button>
          )}
          <p className="text-center text-xs text-white/45">
            {capabilitiesLoading ? "Checking registration availability…" : channelSummary}
          </p>
          <SiteFooter />
        </div>
      </div>
    </div>
  );
}
