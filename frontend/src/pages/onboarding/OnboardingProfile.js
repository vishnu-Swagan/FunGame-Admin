import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, errMsg } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { Disclaimer } from "@/components/common";
import { ProfileAvatar } from "@/components/ProfileAvatar";
import { CARTOON_AVATARS, cartoonAvatarForKey } from "@/lib/profileAvatars";
import { motion } from "framer-motion";
import { BrandWordmark } from "@/components/Brand";

const COUNTRIES = ["India", "United Arab Emirates", "Singapore", "United Kingdom", "Canada", "Australia", "Other"];

export default function OnboardingProfile() {
  const navigate = useNavigate();
  const { user, setUser } = useAuth();
  const [displayName, setDisplayName] = useState(user?.display_name || "");
  const [country, setCountry] = useState(user?.country || "");
  const [dob, setDob] = useState(user?.date_of_birth || "");
  const [avatar, setAvatar] = useState(
    cartoonAvatarForKey(user?.avatar)?.key || CARTOON_AVATARS[0].key,
  );
  const [terms, setTerms] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!terms) {
      toast.error("Please accept the account and play terms");
      return;
    }
    if (!country) {
      toast.error("Select your country");
      return;
    }
    setBusy(true);
    try {
      const { data } = await api.post("/onboarding/profile", {
        display_name: displayName,
        country,
        date_of_birth: dob || null,
        avatar,
        accepted_terms: true,
      });
      setUser(data.user);
      navigate("/onboarding/review");
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="App fg-noise min-h-dvh bg-background">
      <div className="fg-aurora absolute top-0 left-0 right-0 h-[160px] pointer-events-none" />
      <div className="relative z-[2] mx-auto max-w-[430px] px-5 py-10">
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}>
          <BrandWordmark logoClassName="h-auto w-56 max-w-full" />
          <div className="mt-4 flex items-center gap-2 text-xs text-white/50">
            <span className="h-6 w-6 rounded-full bg-primary text-primary-foreground font-bold flex items-center justify-center">1</span> Profile
            <span className="w-6 h-px bg-white/20" />
            <span className="h-6 w-6 rounded-full bg-white/10 flex items-center justify-center">2</span> Review
            <span className="w-6 h-px bg-white/20" />
            <span className="h-6 w-6 rounded-full bg-white/10 flex items-center justify-center">3</span> Approval
          </div>
          <h1 className="mt-5 text-3xl font-bold tracking-tight">Set up your player profile</h1>
          <p className="mt-2 text-sm text-white/65">This is how you will appear in the Chakri.Casino lounge.</p>

          <form onSubmit={submit} className="mt-7 space-y-5">
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <Label>Choose your 3D avatar</Label>
                <span className="text-[10px] font-semibold text-primary">60 royal characters</span>
              </div>
              <div data-testid="avatar-picker" className="grid max-h-64 grid-cols-6 gap-2 overflow-y-auto rounded-2xl border border-white/10 bg-black/20 p-2">
                {CARTOON_AVATARS.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    data-testid="avatar-picker-option"
                    aria-label={item.label}
                    aria-pressed={avatar === item.key}
                    onClick={() => setAvatar(item.key)}
                    className={`aspect-square rounded-2xl border p-1 transition-[transform,border-color,background-color,box-shadow] duration-150 ${avatar === item.key ? "border-primary bg-primary/15 ring-2 ring-primary" : "border-white/10 bg-white/[0.035] hover:-translate-y-0.5 hover:border-primary/35"}`}
                  >
                    <ProfileAvatar avatarKey={item.key} size={44} alt="" className="h-full w-full" />
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="dn">Display name</Label>
              <Input id="dn" data-testid="onboarding-display-name-input" required minLength={2} maxLength={32} placeholder="e.g. LuckyAce" value={displayName} onChange={(e) => setDisplayName(e.target.value)} className="h-12 rounded-xl bg-white/5 border-white/12" />
            </div>
            <div className="space-y-1.5">
              <Label>Country</Label>
              <Select value={country} onValueChange={setCountry}>
                <SelectTrigger data-testid="onboarding-country-select" className="h-12 rounded-xl bg-white/5 border-white/12">
                  <SelectValue placeholder="Select country" />
                </SelectTrigger>
                <SelectContent>
                  {COUNTRIES.map((c) => (
                    <SelectItem key={c} value={c}>{c}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="dob">Date of birth</Label>
              <Input id="dob" data-testid="onboarding-dob-input" type="date" required max={new Date().toISOString().slice(0, 10)} value={dob} onChange={(e) => setDob(e.target.value)} className="h-12 rounded-xl bg-white/5 border-white/12" />
            </div>
            <label className="flex items-start gap-3 rounded-xl border border-white/10 bg-white/5 p-3.5 cursor-pointer">
              <Checkbox data-testid="onboarding-terms-checkbox" checked={terms} onCheckedChange={(v) => setTerms(!!v)} className="mt-0.5" />
              <span className="text-xs text-white/70 leading-relaxed">
                I confirm that the details I provided are accurate, I am at least 18, and my access remains subject to identity, age, and jurisdiction checks.
              </span>
            </label>
            <Button data-testid="onboarding-profile-submit-button" type="submit" disabled={busy} className="w-full h-12 rounded-xl text-base font-bold hover:brightness-110 active:scale-[0.98] transition-[filter,transform] duration-150">
              {busy ? "Saving…" : "Continue to review"}
            </Button>
          </form>
          <Disclaimer className="mt-6" />
        </motion.div>
      </div>
    </div>
  );
}
