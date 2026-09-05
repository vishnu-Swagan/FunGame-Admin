export { formatPaymentTime, paymentDisplayAt } from "./walletUtils";

export function auditState(item) {
  const metadata = item?.metadata && typeof item.metadata === "object" ? item.metadata : {};
  return {
    before: item?.before ?? metadata.before ?? null,
    after: item?.after ?? metadata.after ?? null,
  };
}

export function formatAuditValue(value) {
  if (value === undefined || value === null || value === "") return "—";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch (_error) {
    return String(value);
  }
}

export function reconciliationSummary(response) {
  const result = response?.result || response || {};
  const checked = Number(result.checked || 0);
  const repaired = Number(result.repaired || 0);
  const review = Number(result.review_required || 0);
  return `${checked} checked · ${repaired} repaired · ${review} need review`;
}
