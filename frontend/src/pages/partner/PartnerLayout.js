import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { LayoutDashboard, BarChart3, Bell, FileText, Users, LifeBuoy, LogOut, Handshake, UserRound, ListChecks } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { Disclaimer } from "@/components/common";
import { BrandWordmark } from "@/components/Brand";
import { toast } from "sonner";

/**
 * The partner portal shell — the deck's section 5.
 *
 * Deliberately the same furniture as the admin panel rather than a second
 * design: an operator showing a distributor round the portal is showing them a
 * screen they already recognise, and one layout is one layout to keep working
 * on a phone.
 *
 * What is missing is the point. There is no wallet, no games link and no way
 * back into the player app, because a partner login cannot do any of those and
 * a control that 403s is worse than no control.
 */
const NAV = [
  { to: "/distributor/dashboard", label: "Dashboard", icon: LayoutDashboard, end: true, testId: "partner-nav-dashboard" },
  { to: "/distributor/my-commission", label: "My commission", icon: FileText, testId: "partner-nav-commission" },
  { to: "/distributor/my-players", label: "My players", icon: Users, testId: "partner-nav-players" },
  { to: "/distributor/transactions", label: "Transactions", icon: ListChecks, testId: "partner-nav-transactions" },
  { to: "/distributor/reports", label: "Reports", icon: BarChart3, testId: "partner-nav-reports" },
  { to: "/distributor/notifications", label: "Notifications", icon: Bell, testId: "partner-nav-notifications" },
  { to: "/distributor/support", label: "Support", icon: LifeBuoy, testId: "partner-nav-support" },
  { to: "/distributor/profile", label: "Profile", icon: UserRound, testId: "partner-nav-profile" },
];

export default function PartnerLayout() {
  const navigate = useNavigate();
  const { user, logout } = useAuth();

  return (
    <div className="App fg-noise min-h-dvh bg-background">
      <header data-testid="partner-topbar" className="sticky top-0 z-40 bg-[hsl(var(--background)/0.8)] backdrop-blur-xl border-b border-border/60">
        <div className="mx-auto max-w-7xl px-4 md:px-6 h-14 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5" data-testid="partner-logo">
            <BrandWordmark logoClassName="h-auto w-[clamp(118px,28vw,170px)]" />
            <span className="inline-flex items-center gap-1 rounded-full border border-emerald-400/40 bg-emerald-400/10 px-2 py-0.5">
              <Handshake className="h-3 w-3 text-emerald-400" />
              <span className="font-mono text-[9px] tracking-[0.2em] text-emerald-300 uppercase">Partner</span>
            </span>
          </div>
          <div className="flex items-center gap-3">
            <Disclaimer className="hidden md:block" />
            <button
              data-testid="partner-logout-button"
              onClick={() => {
                logout();
                navigate("/distributor/login");
                toast.success("Signed out");
              }}
              aria-label="Sign out"
              className="h-9 w-9 flex items-center justify-center rounded-full border border-white/10 bg-white/5 hover:bg-white/10"
            >
              <LogOut className="h-4 w-4 text-white/70" />
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-7xl px-4 md:px-6 py-5 grid grid-cols-12 gap-4 md:gap-6 relative z-[2]">
        <aside className="col-span-12 lg:col-span-3">
          <nav className="fg-rail flex lg:flex-col gap-1.5 overflow-x-auto lg:overflow-visible -mx-4 px-4 lg:mx-0 lg:px-0" aria-label="Partner navigation">
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
          <p className="hidden lg:block mt-6 text-[11px] text-white/35 px-2">Signed in as {user?.display_name || user?.email}</p>
        </aside>

        <main className="col-span-12 lg:col-span-9 min-w-0">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
