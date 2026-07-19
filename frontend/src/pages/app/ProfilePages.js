import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import {
  Shield, Settings as SettingsIcon, Megaphone, Bell, Heart, Clock, LogOut, ChevronRight,
  LayoutDashboard, Volume2, Music, Vibrate, Accessibility, Contrast, KeyRound,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { api, errMsg, APP_VERSION } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { PageTransition, AvatarBadge, UserStatusBadge, Disclaimer, formatChips } from "@/components/common";

// ---------------- Profile ----------------
export function Profile() {
  const navigate = useNavigate();
  const { user, logout } = useAuth();

  const links = [
    { icon: Shield, label: "Security", to: "/security", testId: "profile-link-security" },
    { icon: SettingsIcon, label: "Settings", to: "/settings", testId: "profile-link-settings" },
    { icon: Megaphone, label: "Announcements", to: "/announcements", testId: "profile-link-announcements" },
    { icon: Bell, label: "Notifications", to: "/notifications", testId: "profile-link-notifications" },
    { icon: Heart, label: "Favorites", to: "/favorites", testId: "profile-link-favorites" },
    { icon: Clock, label: "Recently viewed", to: "/recent", testId: "profile-link-recent" },
  ];

  return (
    <PageTransition className="space-y-5">
      <h1 className="text-2xl font-bold tracking-tight">Profile</h1>

      <div className="rounded-2xl bg-card/60 backdrop-blur-md border border-white/10 p-5 shadow-[0_10px_30px_rgba(0,0,0,0.35)]">
        <div className="flex items-center gap-4">
          <AvatarBadge avatarKey={user?.avatar} size={60} />
          <div className="min-w-0">
            <p data-testid="profile-display-name" className="font-bold text-lg truncate">{user?.display_name || "Player"}</p>
            <p className="text-xs text-white/55 truncate">{user?.email}</p>
            <div className="mt-1.5 flex items-center gap-2">
              <UserStatusBadge status={user?.status} />
              {user?.role === "ADMIN" && <span className="text-[10px] font-bold text-primary tracking-wider">ADMIN</span>}
            </div>
          </div>
        </div>
        <div className="mt-4 rounded-xl bg-white/5 border border-white/10 px-4 py-3 flex items-center justify-between">
          <span className="text-xs text-white/55">Play-chip balance</span>
          <span className="tabular-nums font-bold text-primary">{formatChips(user?.chip_balance)}</span>
        </div>
      </div>

      {user?.role === "ADMIN" && (
        <button
          data-testid="profile-admin-panel-link"
          onClick={() => navigate("/admin")}
          className="w-full flex items-center justify-between rounded-2xl border border-primary/35 bg-primary/10 p-4 hover:bg-primary/15 transition-[background-color] duration-150"
        >
          <span className="flex items-center gap-3 font-semibold text-primary">
            <LayoutDashboard className="h-5 w-5" /> Open admin panel
          </span>
          <ChevronRight className="h-4 w-4 text-primary" />
        </button>
      )}

      <div className="rounded-2xl bg-card/55 border border-white/10 divide-y divide-white/5 overflow-hidden">
        {links.map(({ icon: Icon, label, to, testId }) => (
          <button key={to} data-testid={testId} onClick={() => navigate(to)} className="w-full flex items-center justify-between p-4 min-h-[52px] hover:bg-white/5 transition-[background-color] duration-150">
            <span className="flex items-center gap-3 text-sm font-medium">
              <Icon className="h-4.5 w-4.5 text-white/60" style={{ width: 18, height: 18 }} /> {label}
            </span>
            <ChevronRight className="h-4 w-4 text-white/35" />
          </button>
        ))}
      </div>

      <Button
        data-testid="profile-logout-button"
        variant="outline"
        onClick={() => {
          logout();
          navigate("/welcome");
          toast.success("Logged out");
        }}
        className="w-full h-12 rounded-xl border-destructive/40 bg-destructive/10 text-red-400 hover:bg-destructive/20 hover:text-red-300"
      >
        <LogOut className="h-4 w-4 mr-2" /> Log out
      </Button>

      <p className="text-center text-[11px] text-white/35">FunGame v{APP_VERSION}</p>
    </PageTransition>
  );
}

// ---------------- Security ----------------
export function Security() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (next.length < 8) {
      toast.error("New password must be at least 8 characters");
      return;
    }
    setBusy(true);
    try {
      await api.post("/auth/change-password", { current_password: current, new_password: next });
      toast.success("Password changed");
      setCurrent("");
      setNext("");
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <PageTransition className="space-y-5">
      <h1 className="text-2xl font-bold tracking-tight">Security</h1>
      <form onSubmit={submit} className="rounded-2xl bg-card/55 border border-white/10 p-4 space-y-4">
        <p className="text-sm font-semibold flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-primary" /> Change password
        </p>
        <div className="space-y-1.5">
          <Label htmlFor="cur">Current password</Label>
          <Input id="cur" data-testid="security-current-password-input" type="password" required value={current} onChange={(e) => setCurrent(e.target.value)} className="h-12 rounded-xl bg-white/5 border-white/12" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="new">New password</Label>
          <Input id="new" data-testid="security-new-password-input" type="password" required minLength={8} value={next} onChange={(e) => setNext(e.target.value)} className="h-12 rounded-xl bg-white/5 border-white/12" />
        </div>
        <Button data-testid="security-change-password-button" type="submit" disabled={busy} className="w-full h-12 rounded-xl font-bold">
          {busy ? "Saving…" : "Update password"}
        </Button>
      </form>
      <div className="rounded-2xl bg-card/55 border border-white/10 p-4">
        <p className="text-sm font-semibold">Session</p>
        <p className="text-xs text-white/55 mt-1">Your session token is stored on this device only and expires automatically after 7 days.</p>
      </div>
      <Disclaimer />
    </PageTransition>
  );
}

// ---------------- Settings ----------------
const TOGGLES = [
  { key: "sound_enabled", label: "Sound effects", icon: Volume2, hint: "UI and game sound cues" },
  { key: "music_enabled", label: "Music", icon: Music, hint: "Lobby and game music" },
  { key: "haptics_enabled", label: "Haptics", icon: Vibrate, hint: "Vibration feedback on supported devices" },
  { key: "reduced_motion", label: "Reduced motion", icon: Accessibility, hint: "Disable glints and animations" },
  { key: "high_contrast", label: "High contrast", icon: Contrast, hint: "Boost text and border visibility" },
];

export function Settings() {
  const { user, setUser } = useAuth();
  const settings = user?.settings || {};

  const toggle = async (key, value) => {
    const prev = { ...settings };
    setUser({ ...user, settings: { ...settings, [key]: value } });
    try {
      const { data } = await api.patch("/settings", { [key]: value });
      setUser((u) => ({ ...u, settings: data.settings }));
    } catch (err) {
      setUser({ ...user, settings: prev });
      toast.error(errMsg(err));
    }
  };

  return (
    <PageTransition className="space-y-5">
      <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
      <div className="rounded-2xl bg-card/55 border border-white/10 divide-y divide-white/5">
        {TOGGLES.map(({ key, label, icon: Icon, hint }) => (
          <div key={key} className="flex items-center justify-between p-4 min-h-[60px]">
            <div className="flex items-center gap-3">
              <Icon className="text-white/60" style={{ width: 18, height: 18 }} />
              <div>
                <p className="text-sm font-medium">{label}</p>
                <p className="text-[11px] text-white/45">{hint}</p>
              </div>
            </div>
            <Switch data-testid={`settings-toggle-${key}`} checked={!!settings[key]} onCheckedChange={(v) => toggle(key, v)} aria-label={label} />
          </div>
        ))}
      </div>
      <div className="rounded-2xl bg-card/55 border border-white/10 p-4">
        <p className="text-sm font-semibold">About</p>
        <p className="text-xs text-white/55 mt-1">FunGame v{APP_VERSION} — a play-chip-only amusement platform. No payments, prizes or cash-outs exist anywhere in the product.</p>
      </div>
      <Disclaimer />
    </PageTransition>
  );
}
