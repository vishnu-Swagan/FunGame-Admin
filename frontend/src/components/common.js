import { motion } from "framer-motion";
import { Badge } from "@/components/ui/badge";
import {
  Star, Crown, Gem, Zap, Rocket, Sun, Moon, Heart, Spade, Club, Diamond, Dices, Coins,
} from "lucide-react";

export const Disclaimer = ({ className = "" }) => (
  <p data-testid="play-chips-disclaimer" className={`text-[11px] tracking-[0.18em] uppercase text-white/70 ${className}`}>
    PLAY CHIPS — NO CASH VALUE
  </p>
);

export const LoadingScreen = () => (
  <div className="min-h-dvh flex flex-col items-center justify-center bg-background gap-4" data-testid="loading-screen">
    <div className="h-12 w-12 rounded-full border-2 border-primary/30 border-t-primary animate-spin" />
    <span className="font-display text-xl text-primary">FunGame</span>
  </div>
);

export const PageTransition = ({ children, className = "" }) => (
  <motion.div
    initial={{ opacity: 0, y: 8 }}
    animate={{ opacity: 1, y: 0 }}
    transition={{ duration: 0.25, ease: "easeOut" }}
    className={className}
  >
    {children}
  </motion.div>
);

const GAME_STATUS_STYLES = {
  COMING_SOON: "bg-[hsl(var(--cyan)/0.14)] border-[hsl(var(--cyan)/0.35)] text-[hsl(var(--cyan))]",
  ENABLED: "bg-[hsl(var(--emerald)/0.14)] border-[hsl(var(--emerald)/0.35)] text-[hsl(var(--emerald))]",
  DISABLED: "bg-white/8 border-white/20 text-white/60",
  MAINTENANCE: "bg-[hsl(var(--magenta)/0.12)] border-[hsl(var(--magenta)/0.32)] text-[hsl(var(--magenta))]",
  UPDATE_REQUIRED: "bg-primary/12 border-primary/35 text-primary",
  RETIRED: "bg-white/6 border-white/15 text-white/50",
};

export const GameStatusBadge = ({ status, pulse = false, className = "" }) => (
  <Badge
    variant="outline"
    data-testid="game-card-status-badge"
    className={`rounded-full px-2.5 py-1 text-[10px] font-semibold tracking-wide border ${GAME_STATUS_STYLES[status] || GAME_STATUS_STYLES.DISABLED} ${pulse ? "fg-badge-pulse" : ""} ${className}`}
  >
    {String(status || "").replaceAll("_", " ")}
  </Badge>
);

const USER_STATUS_STYLES = {
  ACTIVE: "bg-[hsl(var(--emerald)/0.14)] border-[hsl(var(--emerald)/0.35)] text-[hsl(var(--emerald))]",
  PENDING: "bg-primary/12 border-primary/35 text-primary",
  PROFILE_SUBMITTED: "bg-[hsl(var(--cyan)/0.14)] border-[hsl(var(--cyan)/0.35)] text-[hsl(var(--cyan))]",
  VERIFIED: "bg-[hsl(var(--cyan)/0.14)] border-[hsl(var(--cyan)/0.35)] text-[hsl(var(--cyan))]",
  PENDING_VERIFICATION: "bg-white/8 border-white/20 text-white/60",
  REJECTED: "bg-destructive/15 border-destructive/40 text-red-400",
  SUSPENDED: "bg-[hsl(var(--magenta)/0.12)] border-[hsl(var(--magenta)/0.32)] text-[hsl(var(--magenta))]",
};

export const UserStatusBadge = ({ status, className = "" }) => (
  <Badge
    variant="outline"
    data-testid="user-status-badge"
    className={`rounded-full px-2.5 py-1 text-[10px] font-semibold tracking-wide border ${USER_STATUS_STYLES[status] || USER_STATUS_STYLES.PENDING_VERIFICATION} ${className}`}
  >
    {String(status || "").replaceAll("_", " ")}
  </Badge>
);

export const SectionTitle = ({ children, action, className = "" }) => (
  <div className={`flex items-center justify-between ${className}`}>
    <h2 className="text-lg font-semibold tracking-tight">{children}</h2>
    {action}
  </div>
);

export const EmptyState = ({ icon: Icon = Coins, title, subtitle, action }) => (
  <div className="flex flex-col items-center justify-center text-center py-14 px-6 gap-3" data-testid="empty-state">
    <div className="h-14 w-14 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center">
      <Icon className="h-6 w-6 text-white/50" />
    </div>
    <p className="font-semibold">{title}</p>
    {subtitle && <p className="text-sm text-white/60 max-w-[280px]">{subtitle}</p>}
    {action}
  </div>
);

// ---------- Preset avatars (original CSS/SVG-based, no external images) ----------
export const AVATARS = [
  { key: "star", icon: Star, from: "#8a5a2b", to: "#e0aa5f" },
  { key: "crown", icon: Crown, from: "#a97d0b", to: "#ffd447" },
  { key: "gem", icon: Gem, from: "#186a8c", to: "#3ec6e8" },
  { key: "zap", icon: Zap, from: "#1f7a33", to: "#4ade80" },
  { key: "rocket", icon: Rocket, from: "#a11d4b", to: "#ff6b9d" },
  { key: "sun", icon: Sun, from: "#c9a227", to: "#ffe08a" },
  { key: "moon", icon: Moon, from: "#4646c8", to: "#8f8fff" },
  { key: "heart", icon: Heart, from: "#c2185b", to: "#ff4f9a" },
  { key: "spade", icon: Spade, from: "#37475a", to: "#8fa9c4" },
  { key: "club", icon: Club, from: "#2e8b57", to: "#66d9a3" },
  { key: "diamond", icon: Diamond, from: "#7b2fbe", to: "#c084fc" },
  { key: "dice", icon: Dices, from: "#0b8457", to: "#28e0a5" },
];

export const AvatarBadge = ({ avatarKey = "star", size = 40, className = "" }) => {
  const preset = AVATARS.find((a) => a.key === avatarKey) || AVATARS[0];
  const Icon = preset.icon;
  return (
    <div
      data-testid="avatar-badge"
      className={`rounded-full flex items-center justify-center border border-white/20 shadow-[inset_0_1px_0_rgba(255,255,255,0.25)] ${className}`}
      style={{ width: size, height: size, background: `linear-gradient(140deg, ${preset.from}, ${preset.to})` }}
    >
      <Icon className="text-white drop-shadow" style={{ width: size * 0.5, height: size * 0.5 }} />
    </div>
  );
};

export const formatChips = (n) => new Intl.NumberFormat("en-US").format(n ?? 0);

export const timeAgo = (iso) => {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
};
