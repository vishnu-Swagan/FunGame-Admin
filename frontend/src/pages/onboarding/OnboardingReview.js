import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, errMsg } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { AvatarBadge, Disclaimer } from "@/components/common";
import { motion } from "framer-motion";

export default function OnboardingReview() {
  const navigate = useNavigate();
  const { user, setUser } = useAuth();
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      const { data } = await api.post("/onboarding/submit");
      setUser(data.user);
      toast.success("Submitted for approval!");
      navigate("/onboarding/pending", { replace: true });
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const rows = [
    { label: "Display name", value: user?.display_name },
    { label: "Email", value: user?.email },
    { label: "Country", value: user?.country },
    { label: "Date of birth", value: user?.date_of_birth || "Not provided" },
  ];

  return (
    <div className="App fg-noise min-h-dvh bg-background">
      <div className="fg-aurora absolute top-0 left-0 right-0 h-[160px] pointer-events-none" />
      <div className="relative z-[2] mx-auto max-w-[430px] px-5 py-10">
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}>
          <p className="font-display text-lg text-primary">FunGame</p>
          <div className="mt-4 flex items-center gap-2 text-xs text-white/50">
            <span className="h-6 w-6 rounded-full bg-[hsl(var(--emerald))] text-black font-bold flex items-center justify-center">✓</span> Profile
            <span className="w-6 h-px bg-white/20" />
            <span className="h-6 w-6 rounded-full bg-primary text-primary-foreground font-bold flex items-center justify-center">2</span> Review
            <span className="w-6 h-px bg-white/20" />
            <span className="h-6 w-6 rounded-full bg-white/10 flex items-center justify-center">3</span> Approval
          </div>
          <h1 className="mt-5 text-3xl font-bold tracking-tight">Review your details</h1>
          <p className="mt-2 text-sm text-white/65">An operator will review this before you enter the lounge.</p>

          <div className="mt-7 rounded-2xl bg-card/60 backdrop-blur-md border border-white/10 p-5 shadow-[0_10px_30px_rgba(0,0,0,0.35)]">
            <div className="flex items-center gap-4">
              <AvatarBadge avatarKey={user?.avatar} size={56} />
              <div>
                <p className="font-bold text-lg">{user?.display_name}</p>
                <p className="text-xs text-white/55">{user?.email}</p>
              </div>
            </div>
            <div className="mt-5 space-y-3">
              {rows.map((r) => (
                <div key={r.label} className="flex items-center justify-between text-sm border-b border-white/5 pb-2.5 last:border-0">
                  <span className="text-white/55">{r.label}</span>
                  <span className="font-medium">{r.value}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-6 space-y-3">
            <Button data-testid="onboarding-review-submit-button" onClick={submit} disabled={busy} className="w-full h-12 rounded-xl text-base font-bold hover:brightness-110 active:scale-[0.98] transition-[filter,transform] duration-150">
              {busy ? "Submitting…" : "Submit for approval"}
            </Button>
            <Button data-testid="onboarding-review-edit-button" variant="outline" onClick={() => navigate("/onboarding/profile")} className="w-full h-12 rounded-xl border-white/15 bg-white/5 hover:bg-white/10">
              <Pencil className="h-4 w-4 mr-2" /> Edit profile
            </Button>
          </div>
          <Disclaimer className="mt-6" />
        </motion.div>
      </div>
    </div>
  );
}
