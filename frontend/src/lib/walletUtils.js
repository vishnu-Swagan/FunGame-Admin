export const TERMINAL_DEPOSIT_STATUSES = new Set(["CREDITED", "FAILED", "EXPIRED", "REFUNDED", "RECONCILIATION_REQUIRED"]);

export function formatInrPaise(paise) {
  const value = Number.isFinite(Number(paise)) ? Number(paise) : 0;
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: value % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(value / 100);
}

/** Parse a rupee input without binary floating-point money arithmetic. */
export function rupeesToPaise(raw) {
  const value = String(raw ?? "").trim().replaceAll(",", "");
  if (!/^\d+(?:\.\d{0,2})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  const paise = Number(whole) * 100 + Number((fraction + "00").slice(0, 2));
  return Number.isSafeInteger(paise) && paise > 0 ? paise : null;
}

export function normalizeWallet(payload, fallbackAvailable = 0) {
  const source = payload?.wallet || payload || {};
  const available = source.available_chips ?? source.available ?? source.chip_balance ?? source.balance ?? fallbackAvailable;
  const explicitCash = source.cash_chips ?? source.cash;
  const explicitBonus = source.bonus_chips ?? source.promotional_chips ?? source.bonus;
  const nonCashBalance = explicitCash == null
    ? (Number(available) || Number(explicitBonus) || 0)
    : (Number(explicitBonus) || 0);
  return {
    available_chips: Number(available) || 0,
    // Unknown legacy chips are playable but never presented as cleared cash.
    // Withdrawal eligibility must always arrive as an explicit server field.
    cash_chips: Number(explicitCash ?? 0) || 0,
    bonus_chips: nonCashBalance,
    restricted_bonus_chips: Number(source.restricted_bonus_chips ?? source.restricted_bonus ?? nonCashBalance) || 0,
    held_chips: Number(source.held_chips ?? source.held ?? 0) || 0,
    held_withdrawal_chips: Number(source.held_withdrawal_chips ?? source.withdrawal_hold_chips ?? 0) || 0,
    withdrawable_chips: Number(source.withdrawable_chips ?? source.withdrawable ?? 0) || 0,
    pending_reward_chips: Number(source.pending_reward_chips ?? source.pending_reward ?? 0) || 0,
    active_mission: source.active_mission || payload?.active_mission || null,
    withdrawal_eligibility: source.withdrawal_eligibility || payload?.withdrawal_eligibility || null,
  };
}

export function isFinancialFeatureAvailable(financial, feature) {
  return Boolean(financial?.ready && financial?.features?.real_money && financial?.features?.[feature]);
}

export function statusTone(status) {
  const value = String(status || "PENDING").toUpperCase();
  if (["PAID", "CREDITED", "APPROVED", "VERIFIED"].includes(value)) return "success";
  if (["FAILED", "REJECTED", "RECONCILIATION_REQUIRED"].includes(value)) return "danger";
  if (["REFUNDED", "CANCELLED", "EXPIRED"].includes(value)) return "neutral";
  if (["PROCESSING", "SUBMITTED_TO_PROVIDER", "SUBMITTED"].includes(value)) return "info";
  return "pending";
}

export function userWithdrawalStatus(status) {
  const value = String(status || "REQUESTED").toUpperCase();
  if (["PENDING", "REQUESTED", "PENDING_ADMIN"].includes(value)) return "Pending";
  if (["APPROVED", "SUBMITTED_TO_PROVIDER", "SUBMITTED", "PROCESSING"].includes(value)) return "Processing";
  if (value === "PAID") return "Paid";
  if (value === "REJECTED") return "Rejected";
  if (value === "FAILED") return "Failed";
  if (value === "CANCELLED") return "Cancelled";
  return value.replaceAll("_", " ");
}
