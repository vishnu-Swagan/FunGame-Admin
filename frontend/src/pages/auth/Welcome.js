import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { AlertTriangle, Sparkles, ShieldCheck, Coins, Gamepad2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Disclaimer } from "@/components/common";
import { useAuthCapabilities } from "@/lib/authCapabilities";

const FEATURES = [
  { icon: Gamepad2, title: "Live casino games", text: "Play the live tables now and preview the premium games coming next." },
  { icon: Coins, title: "One chips wallet", text: "Add chips in INR and follow every deposit or withdrawal from your dashboard." },
  { icon: ShieldCheck, title: "Verified accounts", text: "Sign up securely with your email address or mobile number." },
];

export default function Welcome() {
  const navigate = useNavigate();
  const { capabilities, loading: capabilitiesLoading } = useAuthCapabilities();
  const registrationAvailable = capabilities.registration_enabled;
  const channelSummary = capabilities.email_registration && capabilities.phone_registration
    ? "Email and mobile verification are available."
    : capabilities.email_registration
      ? "Email verification is available."
      : capabilities.phone_registration
        ? "Mobile verification is available."
        : "Registration verification is temporarily unavailable.";
  return (
    <div className="App fg-noise min-h-dvh bg-background relative overflow-hidden">
      <div className="fg-aurora absolute top-0 left-0 right-0 h-[220px] pointer-events-none" />
      <div className="relative z-[2] mx-auto max-w-[430px] px-6 min-h-dvh flex flex-col justify-between py-10">
        <div className="pt-10">
          <motion.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
            <div className="flex items-center gap-2 mb-5">
              <div className="h-10 w-10 rounded-xl bg-primary/15 border border-primary/35 flex items-center justify-center">
                <Sparkles className="h-5 w-5 text-primary" />
              </div>
            </div>
            <h1 className="font-display text-5xl leading-[1.05] text-white">
              Chakri<span className="text-primary">.Casino</span>
            </h1>
            <p className="mt-3 text-base text-white/75 leading-relaxed">
              Premium chip-based casino games in one glowing midnight lobby.
            </p>
            <Disclaimer className="mt-3" />
          </motion.div>

          <div className="mt-8 space-y-3">
            {FEATURES.map(({ icon: Icon, title, text }, i) => (
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
        </div>

        <div className="space-y-3 pt-8">
          {!capabilitiesLoading && !registrationAvailable && <div data-testid="welcome-registration-unavailable" className="flex items-start gap-2.5 rounded-xl border border-amber-300/25 bg-amber-300/8 p-3 text-xs leading-relaxed text-amber-100"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" /><span><strong>Registration is temporarily unavailable.</strong> Existing users can still log in.</span></div>}
          <Button data-testid="welcome-register-button" disabled={capabilitiesLoading || !registrationAvailable} onClick={() => navigate("/register")} className="w-full h-12 rounded-xl text-base font-bold hover:brightness-110 active:scale-[0.98] transition-[filter,transform] duration-150">
            {capabilitiesLoading ? "Checking registration…" : registrationAvailable ? "Create account" : "Registration temporarily unavailable"}
          </Button>
          <Button data-testid="welcome-login-button" onClick={() => navigate("/login")} className="w-full h-12 rounded-xl text-base font-bold hover:brightness-110 active:scale-[0.98] transition-[filter,transform] duration-150">
            Log in instead
          </Button>
          <p className="text-center text-xs text-white/45">
            {capabilitiesLoading ? "Checking verification availability…" : channelSummary}
          </p>
        </div>
      </div>
    </div>
  );
}
