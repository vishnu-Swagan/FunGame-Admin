export const TERMINAL_DEPOSIT_STATUSES = new Set(["CREDITED", "FAILED", "EXPIRED", "REFUNDED", "RECONCILIATION_REQUIRED"]);

const TERMINAL_PAYMENT_STATUSES = new Set([
  "CREDITED", "PAID", "FAILED", "EXPIRED", "REFUNDED", "REJECTED",
  "CANCELLED", "APPROVED", "RECONCILIATION_REQUIRED",
]);

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
  return {
    available_chips: Number(available) || 0,
    cash_chips: Number(source.cash_chips ?? source.cash ?? available) || 0,
    bonus_chips: Number(source.bonus_chips ?? source.promotional_chips ?? source.bonus ?? 0) || 0,
    held_chips: Number(source.held_chips ?? source.held ?? 0) || 0,
    withdrawable_chips: Number(source.withdrawable_chips ?? source.withdrawable ?? source.cash_chips ?? available) || 0,
    wager_remaining_chips: Number(source.wager_remaining_chips ?? 0) || 0,
  };
}

export function isFinancialFeatureAvailable(financial, feature) {
  return Boolean(financial?.ready && financial?.features?.real_money && financial?.features?.[feature]);
}

export function isOperatorRailAvailable(financial, feature) {
  const operator = financial?.operator;
  if (!operator?.enabled) return false;
  if (feature === "deposits") return Boolean(operator.deposits_enabled);
  if (feature === "withdrawals") return Boolean(operator.withdrawals_enabled);
  return false;
}

export function isPlayerPaymentAvailable(financial, feature) {
  return isFinancialFeatureAvailable(financial, feature) || isOperatorRailAvailable(financial, feature);
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

/**
 * Timestamp shown for a payment row. Completed payments prefer the SgPay
 * capture clock (provider_occurred_at / paid_at / occurred_at), then
 * resolved_at. Pending rows keep checkout created_at.
 */
export function paymentDisplayAt(item) {
  if (!item || typeof item !== "object") return null;
  const status = String(item.status || item.internal_status || "").toUpperCase();
  const provider = item.provider_occurred_at || null;
  const resolved = item.resolved_at || item.credited_at || null;
  const displayed = item.paid_at || item.occurred_at || null;
  const created = item.created_at || null;
  if (TERMINAL_PAYMENT_STATUSES.has(status)) {
    return provider || resolved || displayed || created;
  }
  return created || provider || resolved || displayed;
}

/** Format a payment instant in Asia/Kolkata with an explicit IST label. */
export function formatPaymentTime(value) {
  if (value == null || value === "") return "—";
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  const formatted = parsed.toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    dateStyle: "medium",
    timeStyle: "short",
  });
  return /IST/i.test(formatted) ? formatted : `${formatted} IST`;
}
