import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { LayoutDashboard, Users, UserPlus, HandCoins, Gamepad2, Megaphone, Settings, LogOut, Smartphone, MessagesSquare } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { Disclaimer } from "@/components/common";
import { toast } from "sonner";

const NAV = [
  { to: "/admin", label: "Dashboard", icon: LayoutDashboard, end: true, testId: "admin-nav-dashboard" },
  { to: "/admin/signups", label: "Signups", icon: UserPlus, testId: "admin-nav-signups" },
  { to: "/admin/users", label: "Users", icon: Users, testId: "admin-nav-users" },
  { to: "/admin/chip-requests", label: "Chip Requests", icon: HandCoins, testId: "admin-nav-chip-requests" },
  { to: "/admin/support", label: "Support", icon: MessagesSquare, testId: "admin-nav-support" },
  { to: "/admin/games", label: "Games", icon: Gamepad2, testId: "admin-nav-games" },
  { to: "/admin/announcements", label: "Announcements", icon: Megaphone, testId: "admin-nav-announcements" },
  { to: "/admin/settings", label: "System", icon: Settings, testId: "admin-nav-settings" },
];

export default function AdminLayout() {
  const navigate = useNavigate();
  const { user, logout } = useAuth();

  return (
    <div className="App fg-noise min-h-dvh bg-background">
      {/* Topbar */}
      <header data-testid="admin-topbar" className="sticky top-0 z-40 bg-[hsl(var(--background)/0.8)] backdrop-blur-xl border-b border-border/60">
        <div className="mx-auto max-w-7xl px-4 md:px-6 h-14 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="font-display text-lg text-primary">FunGame</span>
            <span className="text-[10px] font-bold tracking-[0.2em] text-white/45 border border-white/15 rounded-full px-2 py-0.5">OPERATOR</span>
          </div>
          <div className="flex items-center gap-3">
            <Disclaimer className="hidden md:block" />
            <button
              data-testid="admin-open-player-app"
              onClick={() => navigate("/home")}
              className="flex items-center gap-1.5 text-xs font-semibold text-white/65 hover:text-white border border-white/10 bg-white/5 rounded-full px-3 py-1.5 min-h-[36px]"
            >
              <Smartphone className="h-3.5 w-3.5" /> Player app
            </button>
            <button
              data-testid="admin-logout-button"
              onClick={() => {
                logout();
                navigate("/welcome");
                toast.success("Logged out");
              }}
              aria-label="Log out"
              className="h-9 w-9 flex items-center justify-center rounded-full border border-white/10 bg-white/5 hover:bg-white/10"
            >
              <LogOut className="h-4 w-4 text-white/70" />
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-7xl px-4 md:px-6 py-5 grid grid-cols-12 gap-4 md:gap-6 relative z-[2]">
        {/* Rail */}
        <aside className="col-span-12 lg:col-span-3">
          <nav className="fg-rail flex lg:flex-col gap-1.5 overflow-x-auto lg:overflow-visible -mx-4 px-4 lg:mx-0 lg:px-0" aria-label="Admin navigation">
            {NAV.map(({ to, label, icon: Icon, end, testId }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                data-testid={testId}
                className={({ isActive }) =>
                  `shrink-0 flex items-center gap-2.5 rounded-xl px-3.5 py-2.5 min-h-[44px] text-sm font-semibold transition-[background-color,color] duration-150 ${
                    isActive ? "bg-primary/12 text-primary border border-primary/30" : "text-white/60 hover:text-white hover:bg-white/5 border border-transparent"
                  }`
                }
              >
                <Icon className="h-4 w-4" /> {label}
              </NavLink>
            ))}
          </nav>
          <p className="hidden lg:block mt-6 text-[11px] text-white/35 px-2">Signed in as {user?.email}</p>
        </aside>

        {/* Main */}
        <main className="col-span-12 lg:col-span-9 min-w-0">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
