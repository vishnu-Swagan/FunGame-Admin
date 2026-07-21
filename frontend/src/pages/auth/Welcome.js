import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { Sparkles, ShieldCheck, Coins, Gamepad2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Disclaimer } from "@/components/common";

const FEATURES = [
  { icon: Gamepad2, title: "18 original games", text: "Aviator, Teen Patti, Fun Roulette and more — all in production." },
  { icon: Coins, title: "Play chips only", text: "No payments or withdrawals. Pure amusement." },
  { icon: ShieldCheck, title: "Members only", text: "Accounts are issued by the operator — log in with the Login ID and password you were given." },
];

export default function Welcome() {
  const navigate = useNavigate();
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
              Fun<span className="text-primary">Game</span>
            </h1>
            <p className="mt-3 text-base text-white/75 leading-relaxed">
              A premium play-chip amusement lounge. 18 original games, one glowing midnight lobby.
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
          <Button data-testid="welcome-login-button" onClick={() => navigate("/login")} className="w-full h-12 rounded-xl text-base font-bold hover:brightness-110 active:scale-[0.98] transition-[filter,transform] duration-150">
            Log in
          </Button>
          <p className="text-center text-xs text-white/45">
            No account? Ask the operator to create one for you.
          </p>
        </div>
      </div>
    </div>
  );
}
