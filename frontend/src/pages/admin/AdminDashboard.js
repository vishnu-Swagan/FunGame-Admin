import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Users, HandCoins, Gamepad2, Megaphone, Wrench, UserCheck, ChevronRight, Ban, ArrowDownToLine, ArrowUpFromLine, Webhook, LockKeyhole } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { api, financialApi } from "@/lib/api";
import { PageTransition, formatChips } from "@/components/common";
import { useAuth } from "@/context/AuthContext";
import { ADMIN_PERMISSIONS, hasPermission } from "@/components/RouteGuards";

export default function AdminDashboard() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [stats, setStats] = useState(null);
  const canViewPayments = hasPermission(user, ADMIN_PERMISSIONS.PAYMENTS_VIEW);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const base = await api.get("/admin/stats");
        let merged = base.data;
        if (canViewPayments) {
          try {
            const payment = await financialApi.get("/admin/payments/summary");
            merged = { ...merged, ...payment.data };
          } catch (_paymentError) {
            // Base dashboard remains useful when the financial module is unavailable.
          }
        }
        if (active) setStats(merged);
      } catch (_error) {
        if (active) setStats(null);
      }
    };
    load();
    return () => { active = false; };
  }, [canViewPayments]);

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
  if (canViewPayments) {
    if (stats.pending_deposits !== undefined) KPIS.push({ label: "Pending deposits", value: stats.pending_deposits, icon: ArrowDownToLine, to: "/admin/deposits?status=PENDING", accent: "text-sky-300", urgent: stats.pending_deposits > 0 });
    if (stats.pending_withdrawals !== undefined) KPIS.push({ label: "Pending withdrawals", value: stats.pending_withdrawals, icon: ArrowUpFromLine, to: "/admin/withdrawals?status=PENDING_ADMIN", accent: "text-primary", urgent: stats.pending_withdrawals > 0 });
    if (stats.failed_payment_events !== undefined) KPIS.push({ label: "Provider events needing review", value: stats.failed_payment_events, icon: Webhook, to: "/admin/payment-events?attention=1", accent: "text-red-300", urgent: stats.failed_payment_events > 0 });
  }
  if (hasPermission(user, ADMIN_PERMISSIONS.LEDGER_VIEW) && stats.held_chips !== undefined) {
    KPIS.push({ label: "Held chips", value: formatChips(stats.held_chips), icon: LockKeyhole, to: "/admin/wallet-ledger", accent: "text-fuchsia-300" });
  }

  return (
    <PageTransition className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Operator dashboard</h1>
        <p className="text-sm text-white/55 mt-1">{stats.total_users} registered players · {stats.enabled_games ?? 0} live games</p>
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
        <p className="text-sm font-semibold">Game availability</p>
        <p className="text-xs text-white/55 mt-1 leading-relaxed">
          Nine completed games can be live. The rest remain visible as Coming Soon, and the server rejects every locked-game play attempt.
        </p>
      </div>
    </PageTransition>
  );
}
