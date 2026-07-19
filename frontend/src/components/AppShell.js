import { useState, useEffect, useCallback } from "react";
import { Outlet, NavLink, useNavigate, useLocation } from "react-router-dom";
import { Home, Gamepad2, Search, Coins, User, Bell, WifiOff, Wrench } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { api, APP_VERSION, compareVersions } from "@/lib/api";
import { Disclaimer, formatChips } from "@/components/common";

const NAV = [
  { to: "/home", label: "Home", icon: Home, testId: "bottom-nav-home" },
  { to: "/games", label: "Games", icon: Gamepad2, testId: "bottom-nav-games" },
  { to: "/search", label: "Search", icon: Search, testId: "bottom-nav-search" },
  { to: "/chips", label: "Chips", icon: Coins, testId: "bottom-nav-chips" },
  { to: "/profile", label: "Profile", icon: User, testId: "bottom-nav-profile" },
];

export default function AppShell() {
  const { user, refreshUser, config, refreshConfig } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [unread, setUnread] = useState(0);
  const [online, setOnline] = useState(navigator.onLine);

  const loadInbox = useCallback(async () => {
    try {
      const { data } = await api.get("/notifications");
      setUnread(data.unread_count || 0);
    } catch (e) {
      // silent
    }
  }, []);

  // Refresh balance + notifications on navigation, poll every 30s
  useEffect(() => {
    refreshUser();
    loadInbox();
  }, [location.pathname, refreshUser, loadInbox]);

  useEffect(() => {
    const t = setInterval(() => {
      loadInbox();
      refreshConfig();
    }, 30000);
    return () => clearInterval(t);
  }, [loadInbox, refreshConfig]);

  // Maintenance + version gates
  useEffect(() => {
    if (!config) return;
    if (config.maintenance_mode && user?.role !== "ADMIN") {
      navigate("/maintenance", { replace: true });
    } else if (compareVersions(APP_VERSION, config.min_client_version) < 0) {
      navigate("/update-required", { replace: true });
    }
  }, [config, user, navigate]);

  // Online/offline
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  return (
    <div className="App fg-noise relative min-h-dvh bg-background">
      <div className="mx-auto max-w-[430px] md:max-w-[560px] lg:max-w-[720px] px-4 md:px-6 pb-[calc(96px+env(safe-area-inset-bottom))] relative z-[2]">
        {/* Header */}
        <header className="sticky top-0 z-40 -mx-4 px-4 md:-mx-6 md:px-6 pt-3 pb-2 bg-[hsl(var(--background)/0.78)] backdrop-blur-xl border-b border-border/60 fg-aurora">
          <div className="flex items-center justify-between gap-3">
            <button data-testid="header-logo" onClick={() => navigate("/home")} className="font-display text-xl text-primary leading-none" aria-label="FunGame home">
              FunGame
            </button>
            <div className="flex items-center gap-2">
              <button
                data-testid="chip-balance-amount"
                onClick={() => navigate("/chips")}
                aria-label={`Chip balance ${formatChips(user?.chip_balance)}`}
                className="flex items-center gap-1.5 rounded-full border border-primary/35 bg-primary/10 pl-2.5 pr-3 py-1.5 min-h-[36px] hover:bg-primary/15 transition-[background-color] duration-150"
              >
                <Coins className="h-4 w-4 text-primary" />
                <span className="tabular-nums text-sm font-bold text-primary">{formatChips(user?.chip_balance)}</span>
              </button>
              <button
                data-testid="header-notifications-button"
                onClick={() => navigate("/notifications")}
                aria-label={`Notifications, ${unread} unread`}
                className="relative h-9 w-9 min-h-[36px] flex items-center justify-center rounded-full border border-white/10 bg-white/5 hover:bg-white/10 transition-[background-color] duration-150"
              >
                <Bell className="h-4 w-4 text-white/85" />
                {unread > 0 && (
                  <span data-testid="notification-unread-badge" className="absolute -top-0.5 -right-0.5 h-4 min-w-4 px-0.5 rounded-full bg-[hsl(var(--magenta))] text-[9px] font-bold text-white flex items-center justify-center">
                    {unread > 9 ? "9+" : unread}
                  </span>
                )}
              </button>
            </div>
          </div>
          <Disclaimer className="mt-1.5" />
        </header>

        {/* Offline banner */}
        {!online && (
          <div data-testid="offline-banner" className="mt-3 flex items-center gap-2 rounded-xl border border-[hsl(var(--magenta)/0.4)] bg-[hsl(var(--magenta)/0.12)] px-3 py-2.5 text-sm text-[hsl(var(--magenta))]">
            <WifiOff className="h-4 w-4" /> You are offline. Reconnecting…
          </div>
        )}

        {/* Admin viewing app during maintenance */}
        {config?.maintenance_mode && user?.role === "ADMIN" && (
          <div data-testid="maintenance-admin-banner" className="mt-3 flex items-center gap-2 rounded-xl border border-primary/40 bg-primary/10 px-3 py-2.5 text-sm text-primary">
            <Wrench className="h-4 w-4" /> Maintenance mode is ON — players are blocked.
          </div>
        )}

        <main className="pt-4">
          <Outlet />
        </main>
      </div>

      {/* Bottom navigation */}
      <nav data-testid="bottom-nav" aria-label="Main navigation" className="fixed bottom-0 left-0 right-0 z-50 border-t border-border/60 bg-[hsl(var(--background)/0.8)] backdrop-blur-xl">
        <div className="mx-auto max-w-[430px] md:max-w-[560px] lg:max-w-[720px] h-[72px] pb-[env(safe-area-inset-bottom)] grid grid-cols-5">
          {NAV.map(({ to, label, icon: Icon, testId }) => (
            <NavLink
              key={to}
              to={to}
              data-testid={testId}
              aria-label={label}
              className={({ isActive }) =>
                `flex flex-col items-center justify-center gap-1 min-h-[44px] min-w-[44px] transition-[color] duration-150 ${isActive ? "text-primary" : "text-white/55 hover:text-white/80"}`
              }
            >
              {({ isActive }) => (
                <>
                  <Icon className="h-5 w-5" strokeWidth={isActive ? 2.4 : 2} />
                  <span className={`text-[10px] tracking-wide ${isActive ? "font-bold" : "font-medium"}`}>{label}</span>
                </>
              )}
            </NavLink>
          ))}
        </div>
      </nav>
    </div>
  );
}
