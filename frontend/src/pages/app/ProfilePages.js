import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { setHaptics, setMuted } from "@/lib/sound";
import { toast } from "sonner";
import {
  Shield, HeartPulse, Settings as SettingsIcon, Megaphone, Bell, Heart, Clock, LogOut, ChevronRight,
  LayoutDashboard, Volume2, Music, Vibrate, Accessibility, Contrast, KeyRound, MessagesSquare,
  Download, CheckCircle2, Landmark, HandCoins, Pencil, Save, X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { api, errMsg, APP_VERSION } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { PageTransition, AvatarBadge, UserStatusBadge, Disclaimer, formatChips, AVATARS } from "@/components/common";
import { APP_INSTALL_REQUEST_EVENT, isAppStandalone } from "@/components/IosInstallHint";

// ---------------- Profile ----------------
export function Profile() {
  const navigate = useNavigate();
  const { user, setUser, logout } = useAuth();
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(user?.display_name || "");
  const [draftAvatar, setDraftAvatar] = useState(user?.avatar || "star");
  const [saving, setSaving] = useState(false);

  const links = [
    { icon: HandCoins, label: "Request chips", to: "/chips/request", testId: "profile-link-request-chips" },
    { icon: MessagesSquare, label: "Support & messages", to: "/support", testId: "profile-link-support" },
    { icon: Shield, label: "Security", to: "/security", testId: "profile-link-security" },
    { icon: Landmark, label: "Bank details", to: "/profile/bank-details", testId: "profile-link-bank-details" },
    { icon: HeartPulse, label: "Responsible play", to: "/responsible-play", testId: "profile-link-responsible" },
    { icon: SettingsIcon, label: "Account settings", to: "/settings", testId: "profile-link-settings" },
    { icon: Megaphone, label: "Announcements", to: "/announcements", testId: "profile-link-announcements" },
    { icon: Bell, label: "Notifications", to: "/notifications", testId: "profile-link-notifications" },
    { icon: Heart, label: "Favorites", to: "/favorites", testId: "profile-link-favorites" },
    { icon: Clock, label: "Recently viewed", to: "/recent", testId: "profile-link-recent" },
  ];
  const primaryContact = (user?.primary_identity_channel === "PHONE" ? user?.phone : user?.email)
    || user?.phone || user?.email || user?.login_id || "Not provided";
  const verificationDeferred = user?.activation_mode === "SELF_SERVICE_NO_OTP"
    && user?.contact_verification_status === "DEFERRED";
  const contactVerified = user?.contact_verified === true;
  const verificationLabel = contactVerified ? "Verified" : verificationDeferred ? "OTP deferred" : "Not verified";

  const beginEdit = () => {
    setDraftName(user?.display_name || "");
    setDraftAvatar(user?.avatar || "star");
    setEditing(true);
  };

  const saveProfile = async (event) => {
    event.preventDefault();
    const displayName = draftName.trim();
    if (displayName.length < 2 || displayName.length > 32) {
      return toast.error("Display name must contain 2 to 32 characters");
    }
    setSaving(true);
    try {
      const { data } = await api.patch("/profile", { display_name: displayName, avatar: draftAvatar });
      const profile = data?.profile || {};
      setUser((current) => ({
        ...current,
        display_name: profile.display_name ?? displayName,
        avatar: profile.avatar ?? draftAvatar,
        ...(profile.profile_updated_at ? { profile_updated_at: profile.profile_updated_at } : {}),
      }));
      setEditing(false);
      toast.success(data?.message || "Game profile updated");
    } catch (error) {
      toast.error(errMsg(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <PageTransition className="space-y-5">
      <h1 className="text-2xl font-bold tracking-tight">Profile</h1>

      <div className="rounded-2xl bg-card/60 backdrop-blur-md border border-white/10 p-5 shadow-[0_10px_30px_rgba(0,0,0,0.35)]">
        <div className="flex items-center gap-4">
          <AvatarBadge avatarKey={user?.avatar} size={60} />
          <div className="min-w-0">
            <p data-testid="profile-display-name" className="font-bold text-lg truncate">{user?.display_name || "Player"}</p>
            <p className="text-xs text-white/55 truncate">
              {user?.username ? <span className="text-primary/85 font-semibold">@{user.username}</span> : null}
              {user?.username ? " · " : ""}
              {user?.email || user?.phone || user?.login_id}
            </p>
            <div className="mt-1.5 flex items-center gap-2">
              <UserStatusBadge status={user?.status} />
              {user?.role === "ADMIN" && <span className="text-[10px] font-bold text-primary tracking-wider">ADMIN</span>}
            </div>
          </div>
        </div>
        <div className="mt-4">
          <div className="rounded-xl bg-white/5 border border-white/10 px-4 py-3">
            <p className="text-xs text-white/55">Play chips</p>
            <p className="tabular-nums font-bold text-primary" data-testid="profile-chip-balance">{formatChips(user?.chip_balance)}</p>
          </div>
        </div>
        {user?.role === "PLAYER" && user?.status === "ACTIVE" && (
          <button type="button" data-testid="profile-edit-open" onClick={beginEdit} className="mt-3 inline-flex min-h-10 w-full items-center justify-center gap-2 rounded-xl border border-primary/30 bg-primary/10 text-sm font-semibold text-primary hover:bg-primary/15">
            <Pencil className="h-4 w-4" /> Edit game profile
          </button>
        )}
      </div>

      {editing && (
        <form data-testid="profile-edit-form" onSubmit={saveProfile} className="space-y-4 rounded-2xl border border-primary/25 bg-card/60 p-4">
          <div>
            <p className="text-sm font-semibold">Game profile</p>
            <p className="mt-0.5 text-[11px] text-white/45">Only your public display name and avatar can be changed here.</p>
          </div>
          <div className="space-y-2">
            <Label>Avatar</Label>
            <div className="grid grid-cols-6 gap-2" role="radiogroup" aria-label="Game profile avatar">
              {AVATARS.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  role="radio"
                  aria-checked={draftAvatar === item.key}
                  aria-label={`Choose ${item.key} avatar`}
                  data-testid={`profile-edit-avatar-${item.key}`}
                  onClick={() => setDraftAvatar(item.key)}
                  className={`rounded-full p-0.5 ${draftAvatar === item.key ? "ring-2 ring-primary" : "opacity-70 hover:opacity-100"}`}
                >
                  <AvatarBadge avatarKey={item.key} size={42} />
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="profile-edit-display-name">Display name</Label>
            <Input id="profile-edit-display-name" data-testid="profile-edit-display-name" required minLength={2} maxLength={32} value={draftName} onChange={(event) => setDraftName(event.target.value)} className="h-12 rounded-xl border-white/12 bg-white/5" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Button type="button" variant="outline" disabled={saving} onClick={() => setEditing(false)} className="h-11 rounded-xl border-white/15 bg-white/5"><X className="mr-1.5 h-4 w-4" />Cancel</Button>
            <Button data-testid="profile-edit-save" type="submit" disabled={saving} className="h-11 rounded-xl font-bold"><Save className="mr-1.5 h-4 w-4" />{saving ? "Saving…" : "Save"}</Button>
          </div>
          <p className="text-[11px] leading-relaxed text-white/40">Email, mobile number, country, verification status and chip balances are managed separately and remain read-only here.</p>
        </form>
      )}

      <section data-testid="profile-account-details" className="rounded-2xl border border-white/10 bg-card/55 p-4">
        <div className="flex items-center justify-between gap-3">
          <div><p className="text-sm font-semibold">Account details</p><p className="mt-0.5 text-[11px] text-white/45">This status is used for support and operator account review.</p></div>
          <UserStatusBadge status={user?.status} />
        </div>
        <dl className="mt-4 divide-y divide-white/5 text-sm">
          <div className="flex items-center justify-between gap-4 py-2.5"><dt className="text-white/50">Login ID</dt><dd className="truncate font-mono text-xs font-semibold">{user?.login_id || user?.username || "Assigned account"}</dd></div>
          <div className="flex items-center justify-between gap-4 py-2.5"><dt className="text-white/50">Contact</dt><dd className="truncate text-xs font-medium">{primaryContact}</dd></div>
          <div className="flex items-center justify-between gap-4 py-2.5"><dt className="text-white/50">Contact status</dt><dd data-testid="profile-contact-verification" className={`text-xs font-semibold ${contactVerified ? "text-emerald-300" : verificationDeferred ? "text-amber-300" : "text-red-300"}`}>{verificationLabel}</dd></div>
          <div className="flex items-center justify-between gap-4 py-2.5"><dt className="text-white/50">Country</dt><dd className="truncate text-xs font-medium">{user?.country || "Not provided"}</dd></div>
        </dl>
      </section>

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

      <p className="text-center text-[11px] text-white/35">Chakri.Casino v{APP_VERSION}</p>
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

function applyEngineSetting(key, value) {
  if (key === "haptics_enabled") setHaptics(value);
  if (key === "sound_enabled") setMuted(!value);
}

export function Settings() {
  const { user, setUser } = useAuth();
  const settings = user?.settings || {};
  const [appInstalled, setAppInstalled] = useState(isAppStandalone);

  // apply stored sound/haptics prefs to the engines on load
  useEffect(() => {
    if (settings.haptics_enabled === false) setHaptics(false);
    if (settings.sound_enabled === false) setMuted(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const updateInstallState = () => setAppInstalled(isAppStandalone());
    const standaloneQuery = window.matchMedia?.("(display-mode: standalone)");
    window.addEventListener("appinstalled", updateInstallState);
    standaloneQuery?.addEventListener?.("change", updateInstallState);
    return () => {
      window.removeEventListener("appinstalled", updateInstallState);
      standaloneQuery?.removeEventListener?.("change", updateInstallState);
    };
  }, []);

  const toggle = async (key, value) => {
    const prev = { ...settings };
    applyEngineSetting(key, value);
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
      <div className="rounded-2xl bg-card/55 border border-primary/20 p-4">
        <div className="flex items-center gap-3">
          <div className="h-11 w-11 shrink-0 rounded-xl bg-primary/12 border border-primary/25 flex items-center justify-center">
            {appInstalled ? (
              <CheckCircle2 className="h-5 w-5 text-primary" />
            ) : (
              <Download className="h-5 w-5 text-primary" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">{appInstalled ? "App installed" : "Install Chakri.Casino"}</p>
            <p className="text-[11px] text-white/50 mt-0.5 leading-relaxed">
              {appInstalled
                ? "You are using the standalone app experience."
                : "Add it to this device and launch without the browser address bar."}
            </p>
          </div>
          {!appInstalled && (
            <Button
              type="button"
              size="sm"
              data-testid="settings-install-app-button"
              onClick={() => window.dispatchEvent(new Event(APP_INSTALL_REQUEST_EVENT))}
              className="shrink-0 rounded-xl font-semibold"
            >
              Install
            </Button>
          )}
        </div>
      </div>
      <div className="rounded-2xl bg-card/55 border border-white/10 p-4">
        <p className="text-sm font-semibold">About</p>
        <p className="text-xs text-white/55 mt-1">Chakri.Casino v{APP_VERSION} — games, a secure chips wallet and account-level responsible-play controls.</p>
      </div>
      <Disclaimer />
    </PageTransition>
  );
}
