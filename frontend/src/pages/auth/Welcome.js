import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { ShieldCheck, Coins, Gamepad2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Disclaimer } from "@/components/common";
import SiteFooter from "@/components/SiteFooter";
import { BrandWordmark } from "@/components/Brand";
import { useAuthCapabilities } from "@/lib/authCapabilities";

const BASE_FEATURES = [
  { icon: Gamepad2, title: "Premium digital games", text: "Enter the live game lobby and explore the available tables and arcade titles." },
  { icon: Coins, title: "Virtual play chips", text: "Request play chips from an operator and follow the approval status from your profile." },
];

export default function Welcome() {
  const navigate = useNavigate();
  const { capabilities, loading: capabilitiesLoading } = useAuthCapabilities();
  const manualReview = capabilities.registration_mode === "ADMIN_REVIEW";
  const features = [...BASE_FEATURES, manualReview
    ? { icon: ShieldCheck, title: "Admin-reviewed access", text: "Submit both contact details securely. Play begins only after an administrator approves the account." }
    : { icon: ShieldCheck, title: "Verified accounts", text: "Sign up securely with mandatory mobile OTP verification." }];
  const channelSummary = manualReview
    ? "New accounts are reviewed by an administrator before login and play."
    : capabilities.phone_registration
      ? "Mobile OTP verification is available."
      : "Secure mobile OTP verification is required to activate a new account.";
  return (
    <div className="App fg-noise min-h-dvh bg-background relative overflow-hidden">
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
        </div>

        <div className="space-y-3 pt-8">
          <Button data-testid="welcome-register-button" onClick={() => navigate("/register")} className="w-full h-12 rounded-xl text-base font-bold hover:brightness-110 active:scale-[0.98] transition-[filter,transform] duration-150">
            Create account
          </Button>
          <Button data-testid="welcome-login-button" onClick={() => navigate("/login")} className="w-full h-12 rounded-xl text-base font-bold hover:brightness-110 active:scale-[0.98] transition-[filter,transform] duration-150">
            Log in instead
          </Button>
          <p className="text-center text-xs text-white/45">
            {capabilitiesLoading ? "Checking registration availability…" : channelSummary}
          </p>
          <SiteFooter />
        </div>
      </div>
    </div>
  );
}
