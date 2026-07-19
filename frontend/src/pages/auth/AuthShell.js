import { useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { motion } from "framer-motion";
import { Disclaimer } from "@/components/common";

export const AuthShell = ({ title, subtitle, children, backTo = "/welcome" }) => {
  const navigate = useNavigate();
  return (
    <div className="App fg-noise min-h-dvh bg-background relative overflow-hidden" data-testid="auth-shell">
      <div className="fg-aurora absolute top-0 left-0 right-0 h-[180px] pointer-events-none" />
      <div className="relative z-[2] mx-auto max-w-[430px] px-5 py-8 min-h-dvh flex flex-col">
        <button
          data-testid="auth-back-button"
          onClick={() => navigate(backTo)}
          aria-label="Go back"
          className="h-10 w-10 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full border border-white/10 bg-white/5 hover:bg-white/10 transition-[background-color] duration-150"
        >
          <ArrowLeft className="h-4 w-4 text-white/85" />
        </button>

        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }} className="flex-1 flex flex-col justify-center py-8">
          <p className="font-display text-lg text-primary mb-6">FunGame</p>
          <h1 className="text-3xl font-bold tracking-tight">{title}</h1>
          {subtitle && <p className="mt-2 text-sm text-white/65 leading-relaxed">{subtitle}</p>}
          <div className="mt-7">{children}</div>
          <Disclaimer className="mt-8" />
        </motion.div>
      </div>
    </div>
  );
};
