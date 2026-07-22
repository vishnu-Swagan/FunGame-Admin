import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { motion } from "framer-motion";
import { Eye, EyeOff, Lock, ShieldCheck, Terminal, ChevronRight } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, errMsg } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { BrandWordmark } from "@/components/Brand";

/** Private operator sign-in — deliberately distinct from the player login
    (secure "control console" look, no casino branding). Admin-only. */
export default function AdminLogin() {
  const navigate = useNavigate();
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const { data } = await api.post("/auth/login", { email, password });
      if (data.user.role !== "ADMIN") {
        toast.error("Access denied — administrators only.");
        navigate("/login", { replace: true });
        return;
      }
      login(data.access_token, data.user);
      toast.success("Operator authenticated.");
      navigate("/admin", { replace: true });
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="min-h-dvh w-full flex items-center justify-center px-5 py-10 relative overflow-hidden"
      data-testid="admin-login"
      style={{
        background:
          "radial-gradient(1100px 500px at 50% -10%, #0e2233 0%, #0a1420 45%, #05080e 100%)",
      }}
    >
      {/* technical grid backdrop */}
      <div
        aria-hidden="true"
        className="absolute inset-0 pointer-events-none opacity-[0.35]"
        style={{
          backgroundImage:
            "linear-gradient(rgba(56,189,248,0.08) 1px, transparent 1px), linear-gradient(90deg, rgba(56,189,248,0.08) 1px, transparent 1px)",
          backgroundSize: "38px 38px",
          maskImage: "radial-gradient(circle at 50% 30%, black, transparent 78%)",
          WebkitMaskImage: "radial-gradient(circle at 50% 30%, black, transparent 78%)",
        }}
      />
      {/* scan sweep */}
      <div aria-hidden="true" className="absolute top-0 left-0 right-0 h-px" style={{ background: "linear-gradient(90deg, transparent, #38bdf8, transparent)", opacity: 0.5 }} />

      <motion.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35 }}
        className="relative z-[2] w-full max-w-[400px]"
      >
        {/* brand wordmark + ops tag */}
        <div className="flex items-center justify-center gap-2.5 mb-6">
          <BrandWordmark logoClassName="h-7 w-7" textClassName="text-base" />
          <span className="inline-flex items-center gap-1 rounded-full border border-sky-400/40 bg-sky-400/10 px-2 py-0.5">
            <Terminal className="h-3 w-3 text-sky-400" />
            <span className="font-mono text-[9px] tracking-[0.25em] text-sky-300 uppercase">Ops</span>
          </span>
        </div>

        {/* console card */}
        <div
          className="rounded-2xl border p-6 sm:p-7"
          style={{
            borderColor: "rgba(56,189,248,0.25)",
            background: "linear-gradient(180deg, rgba(15,28,44,0.9), rgba(8,15,26,0.92))",
            boxShadow: "0 24px 60px rgba(0,0,0,0.55), inset 0 1px 0 rgba(56,189,248,0.12)",
            backdropFilter: "blur(6px)",
          }}
        >
          {/* shield badge */}
          <div className="flex flex-col items-center text-center mb-6">
            <div
              className="h-16 w-16 rounded-2xl flex items-center justify-center mb-4 relative"
              style={{
                background: "radial-gradient(circle at 40% 30%, #14324a, #0b1a29)",
                border: "1px solid rgba(56,189,248,0.4)",
                boxShadow: "0 0 26px rgba(56,189,248,0.28)",
              }}
            >
              <ShieldCheck className="h-8 w-8 text-sky-400" />
            </div>
            <h1 className="text-2xl font-bold tracking-tight text-white">Operator Console</h1>
            <div className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 py-1">
              <Lock className="h-3 w-3 text-amber-400" />
              <span className="font-mono text-[10px] tracking-[0.2em] text-amber-300 uppercase">Restricted access</span>
            </div>
          </div>

          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="admin-email" className="font-mono text-[11px] tracking-wider text-sky-200/70 uppercase">Operator ID</Label>
              <Input
                id="admin-email"
                data-testid="admin-login-email-input"
                type="text"
                required
                autoComplete="username"
                placeholder="admin login or email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="h-12 rounded-lg bg-sky-950/40 border-sky-400/20 font-mono text-sky-50 placeholder:text-sky-200/30 focus-visible:ring-sky-400/40"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="admin-password" className="font-mono text-[11px] tracking-wider text-sky-200/70 uppercase">Passcode</Label>
              <div className="relative">
                <Input
                  id="admin-password"
                  data-testid="admin-login-password-input"
                  type={showPw ? "text" : "password"}
                  required
                  autoComplete="current-password"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="h-12 rounded-lg bg-sky-950/40 border-sky-400/20 font-mono text-sky-50 placeholder:text-sky-200/30 pr-12 focus-visible:ring-sky-400/40"
                />
                <button type="button" aria-label={showPw ? "Hide passcode" : "Show passcode"} onClick={() => setShowPw(!showPw)} className="absolute right-3 top-1/2 -translate-y-1/2 text-sky-300/50 hover:text-sky-200">
                  {showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
            <button
              data-testid="admin-login-submit"
              type="submit"
              disabled={busy}
              className="w-full h-12 rounded-lg text-base font-bold text-[#05121f] flex items-center justify-center gap-2 disabled:opacity-60 active:scale-[0.98] transition-transform duration-150"
              style={{ background: "linear-gradient(180deg, #7dd3fc, #38bdf8 60%, #0ea5e9)", boxShadow: "0 8px 24px rgba(56,189,248,0.35)" }}
            >
              {busy ? "Authenticating…" : <>Authenticate <ChevronRight className="h-5 w-5" /></>}
            </button>
          </form>
        </div>

        {/* secure footer */}
        <div className="flex items-center justify-center gap-1.5 mt-5">
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-70 animate-ping" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
          </span>
          <span className="font-mono text-[10px] tracking-[0.2em] text-white/35 uppercase">Encrypted session · authorized personnel only</span>
        </div>
      </motion.div>
    </div>
  );
}
