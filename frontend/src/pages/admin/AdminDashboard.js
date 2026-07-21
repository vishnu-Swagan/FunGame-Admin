import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Users, HandCoins, Gamepad2, Megaphone, Wrench, UserCheck, ChevronRight, Ban } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { PageTransition } from "@/components/common";

export default function AdminDashboard() {
  const navigate = useNavigate();
  const [stats, setStats] = useState(null);

  useEffect(() => {
    api.get("/admin/stats").then(({ data }) => setStats(data)).catch(() => {});
  }, []);

  if (!stats) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[...Array(4)].map((_, i) => (
          <Skeleton key={i} className="h-28 rounded-2xl bg-white/5" />
        ))}
      </div>
    );
  }

  const KPIS = [
    { label: "Pending signups", value: stats.pending_signups ?? 0, icon: UserCheck, to: "/admin/signups", accent: "text-primary", urgent: (stats.pending_signups ?? 0) > 0 },
    { label: "Pending approvals", value: stats.pending_users, icon: UserCheck, to: "/admin/users?status=PENDING", accent: "text-primary", urgent: stats.pending_users > 0 },
    { label: "Pending chip requests", value: stats.pending_chip_requests, icon: HandCoins, to: "/admin/chip-requests", accent: "text-[hsl(var(--cyan))]", urgent: stats.pending_chip_requests > 0 },
    { label: "Active players", value: stats.active_users, icon: Users, to: "/admin/users?status=ACTIVE", accent: "text-[hsl(var(--emerald))]" },
    { label: "Suspended", value: stats.suspended_users, icon: Ban, to: "/admin/users?status=SUSPENDED", accent: "text-[hsl(var(--magenta))]" },
    { label: "Games enabled", value: `${stats.enabled_games}/${stats.total_games}`, icon: Gamepad2, to: "/admin/games", accent: "text-white" },
    { label: "Active announcements", value: stats.active_announcements, icon: Megaphone, to: "/admin/announcements", accent: "text-white" },
  ];

  return (
    <PageTransition className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Operator dashboard</h1>
        <p className="text-sm text-white/55 mt-1">{stats.total_users} registered players · foundation gate: 0 playable games</p>
      </div>

      {stats.maintenance_mode && (
        <button data-testid="admin-maintenance-banner" onClick={() => navigate("/admin/settings")} className="w-full flex items-center justify-between rounded-2xl border border-[hsl(var(--magenta)/0.4)] bg-[hsl(var(--magenta)/0.12)] p-4 text-left">
          <span className="flex items-center gap-2.5 text-sm font-semibold text-[hsl(var(--magenta))]">
            <Wrench className="h-4 w-4" /> Maintenance mode is ON — players are blocked from the app
          </span>
          <ChevronRight className="h-4 w-4 text-[hsl(var(--magenta))]" />
        </button>
      )}

      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        {KPIS.map(({ label, value, icon: Icon, to, accent, urgent }) => (
          <button
            key={label}
            data-testid="admin-kpi-card"
            onClick={() => navigate(to)}
            className={`text-left rounded-2xl border p-4 transition-[background-color,border-color] duration-150 hover:bg-white/5 ${
              urgent ? "border-primary/40 bg-primary/5" : "border-white/10 bg-card/55"
            }`}
          >
            <Icon className={`h-5 w-5 ${accent}`} />
            <p className={`mt-2.5 tabular-nums text-3xl font-extrabold ${accent}`}>{value}</p>
            <p className="text-xs text-white/55 mt-0.5">{label}</p>
          </button>
        ))}
      </div>

      <div className="rounded-2xl bg-card/55 border border-white/10 p-4">
        <p className="text-sm font-semibold">Foundation build gate</p>
        <p className="text-xs text-white/55 mt-1 leading-relaxed">
          All 18 games are registered and non-playable until each passes its game-specific build gate. Players can browse the lobby, favorite games and request play chips.
        </p>
      </div>
    </PageTransition>
  );
}
