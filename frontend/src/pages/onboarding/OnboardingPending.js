import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Hourglass, ShieldX, Ban, RefreshCw, LogOut, Pencil, MessagesSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { Disclaimer, UserStatusBadge, AvatarBadge } from "@/components/common";
import { motion } from "framer-motion";

export default function OnboardingPending() {
  const navigate = useNavigate();
  const { user, setUser, logout } = useAuth();
  const [checking, setChecking] = useState(false);

  const checkStatus = async (manual = false) => {
    if (manual) setChecking(true);
    try {
      const { data } = await api.get("/onboarding/status");
      setUser(data.user);
      if (data.status === "ACTIVE") {
        toast.success("You are approved! Welcome to FunGame.");
        navigate("/home", { replace: true });
      } else if (manual) {
        toast.info("Still under review — check back soon.");
      }
    } catch (e) {
      // silent
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    const t = setInterval(() => checkStatus(false), 10000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const status = user?.status;
  const isRejected = status === "REJECTED";
  const isSuspended = status === "SUSPENDED";

  return (
    <div className="App fg-noise min-h-dvh bg-background">
      <div className="fg-aurora absolute top-0 left-0 right-0 h-[160px] pointer-events-none" />
      <div className="relative z-[2] mx-auto max-w-[430px] px-5 py-10 min-h-dvh flex flex-col">
        <p className="font-display text-lg text-primary">FunGame</p>
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }} className="flex-1 flex flex-col items-center justify-center text-center">
          <div data-testid="pending-approval-status" className="w-full rounded-2xl bg-card/60 backdrop-blur-md border border-white/10 p-8 shadow-[0_10px_30px_rgba(0,0,0,0.35)]">
            <div className="flex justify-center">
              <div className={`h-16 w-16 rounded-2xl flex items-center justify-center border ${isRejected ? "bg-destructive/10 border-destructive/30" : isSuspended ? "bg-[hsl(var(--magenta)/0.1)] border-[hsl(var(--magenta)/0.3)]" : "bg-primary/10 border-primary/30"}`}>
                {isRejected ? <ShieldX className="h-7 w-7 text-red-400" /> : isSuspended ? <Ban className="h-7 w-7 text-[hsl(var(--magenta))]" /> : <Hourglass className="h-7 w-7 text-primary" />}
              </div>
            </div>
            <div className="mt-4 flex justify-center">
              <UserStatusBadge status={status} />
            </div>
            <h1 className="mt-4 text-2xl font-bold tracking-tight">
              {isRejected ? "Onboarding not approved" : isSuspended ? "Account suspended" : "Under review"}
            </h1>
            <p className="mt-2 text-sm text-white/65 leading-relaxed">
              {isRejected
                ? user?.rejection_reason
                  ? `Reason: ${user.rejection_reason}. You can update your profile and resubmit.`
                  : "You can update your profile and resubmit for approval."
                : isSuspended
                ? "Your account has been suspended by an operator. Contact support for details."
                : "An operator is reviewing your profile. You will be notified as soon as your account is approved — this page checks automatically."}
            </p>
            {user && (
              <div className="mt-5 flex items-center justify-center gap-3">
                <AvatarBadge avatarKey={user.avatar} size={36} />
                <span className="text-sm font-semibold">{user.display_name}</span>
              </div>
            )}
            {!isSuspended && !isRejected && <div className="mt-6 h-1.5 rounded-full overflow-hidden bg-white/5"><div className="h-full w-full fg-shimmer rounded-full" /></div>}
          </div>

          <div className="mt-6 w-full space-y-3">
            {isRejected && (
              <Button data-testid="pending-edit-profile-button" onClick={() => navigate("/onboarding/profile")} className="w-full h-12 rounded-xl font-bold">
                <Pencil className="h-4 w-4 mr-2" /> Update profile & resubmit
              </Button>
            )}
            {!isSuspended && (
              <Button data-testid="pending-check-status-button" variant="outline" onClick={() => checkStatus(true)} disabled={checking} className="w-full h-12 rounded-xl border-white/15 bg-white/5 hover:bg-white/10">
                <RefreshCw className={`h-4 w-4 mr-2 ${checking ? "animate-spin" : ""}`} /> Check status now
              </Button>
            )}
            <Button data-testid="pending-support-button" variant="outline" onClick={() => navigate("/support")} className="w-full h-12 rounded-xl border-white/15 bg-white/5 hover:bg-white/10">
              <MessagesSquare className="h-4 w-4 mr-2" /> Message support
            </Button>
            <Button
              data-testid="pending-logout-button"
              variant="ghost"
              onClick={() => {
                logout();
                navigate("/welcome");
              }}
              className="w-full h-11 rounded-xl text-white/60 hover:text-white"
            >
              <LogOut className="h-4 w-4 mr-2" /> Log out
            </Button>
          </div>
        </motion.div>
        <Disclaimer className="mt-6 text-center" />
      </div>
    </div>
  );
}
