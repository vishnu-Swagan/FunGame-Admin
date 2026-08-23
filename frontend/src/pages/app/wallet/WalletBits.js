import { Coins, Gift, Hourglass, WalletCards } from "lucide-react";
import { formatChips } from "@/components/common";
import { statusTone, userWithdrawalStatus } from "@/lib/walletUtils";

const TONE = {
  success: "border-emerald-400/35 bg-emerald-400/10 text-emerald-300",
  danger: "border-red-400/35 bg-red-400/10 text-red-300",
  info: "border-sky-400/35 bg-sky-400/10 text-sky-300",
  neutral: "border-white/15 bg-white/5 text-white/55",
  pending: "border-primary/35 bg-primary/10 text-primary",
};

export function PaymentStatus({ status, playerFriendly = false }) {
  const text = playerFriendly ? userWithdrawalStatus(status) : String(status || "PENDING").replaceAll("_", " ");
  return <span className={`inline-flex rounded-full border px-2 py-1 text-[10px] font-bold tracking-wide ${TONE[statusTone(status)]}`}>{text}</span>;
}

export function WalletBalanceCard({ wallet }) {
  const items = [
    { label: "Available", value: wallet.available_chips, icon: Coins, accent: "text-primary" },
    { label: "In play", value: wallet.held_chips, icon: Hourglass, accent: "text-sky-300" },
    { label: "Bonus", value: wallet.bonus_chips, icon: Gift, accent: "text-fuchsia-300" },
  ];
  return (
    <section className="relative overflow-hidden rounded-2xl border border-primary/30 bg-card/65 p-5 shadow-[0_20px_55px_rgba(0,0,0,.4)]">
      <div className="fg-aurora absolute inset-0 pointer-events-none" />
      <div className="relative">
        <p className="text-[11px] font-semibold tracking-[.18em] uppercase text-white/45">Virtual-chip balance</p>
        <div className="mt-2 flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-full border border-primary/45 bg-primary/15"><WalletCards className="h-5 w-5 text-primary" /></span>
          <div>
            <p className="text-xs text-white/50">Available play chips</p>
            <p data-testid="wallet-available-balance" className="tabular-nums text-4xl font-extrabold text-primary">{formatChips(wallet.available_chips)}</p>
          </div>
        </div>
        <div className="mt-5 grid grid-cols-2 gap-2">
          {items.slice(1).map(({ label, value, icon: Icon, accent }) => (
            <div key={label} className="rounded-xl border border-white/10 bg-black/15 p-3 min-w-0">
              <Icon className={`h-4 w-4 ${accent}`} />
              <p className="mt-2 text-[10px] text-white/45">{label}</p>
              <p className={`tabular-nums text-sm font-bold truncate ${accent}`}>{formatChips(value)}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export function PaymentRow({ item, kind }) {
  const isDeposit = kind === "deposit";
  const amount = isDeposit ? item.amount_paise : item.amount_chips;
  const amountText = isDeposit
    ? new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format((Number(amount) || 0) / 100)
    : `${formatChips(amount)} chips`;
  const when = item.created_at ? new Date(item.created_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "—";
  return (
    <article className="flex items-center justify-between gap-3 p-3.5" data-testid={`${kind}-activity-row`}>
      <div className="min-w-0">
        <p className="font-semibold tabular-nums">{amountText}</p>
        <p className="mt-0.5 truncate text-[11px] text-white/40">{when}{item.reference ? ` · ${item.reference}` : ""}</p>
      </div>
      <PaymentStatus status={item.status} playerFriendly={!isDeposit} />
    </article>
  );
}
