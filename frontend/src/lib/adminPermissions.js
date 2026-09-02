export const ADMIN_PERMISSIONS = Object.freeze({
  PAYMENTS_VIEW: "PAYMENTS_VIEW",
  PAYMENTS_RECONCILE: "PAYMENTS_RECONCILE",
  WITHDRAWALS_APPROVE: "WITHDRAWALS_APPROVE",
  WITHDRAWALS_MARK_PAID: "WITHDRAWALS_MARK_PAID",
  PAYMENT_SETTINGS_WRITE: "PAYMENT_SETTINGS_WRITE",
  LEDGER_VIEW: "LEDGER_VIEW",
  AUDIT_VIEW: "AUDIT_VIEW",
  KYC_VIEW: "KYC_VIEW",
  KYC_REVIEW: "KYC_REVIEW",
  COMPLIANCE_ADMIN: "COMPLIANCE_ADMIN",
  GATEWAY_VIEW: "GATEWAY_VIEW",
  GATEWAY_CREATE: "GATEWAY_CREATE",
  GATEWAY_UPDATE_NON_SECRET_CONFIG: "GATEWAY_UPDATE_NON_SECRET_CONFIG",
  GATEWAY_ROTATE_CREDENTIALS: "GATEWAY_ROTATE_CREDENTIALS",
  GATEWAY_TEST: "GATEWAY_TEST",
  GATEWAY_ACTIVATE: "GATEWAY_ACTIVATE",
  GATEWAY_DISABLE: "GATEWAY_DISABLE",
  GATEWAY_MANAGE_ROUTES: "GATEWAY_MANAGE_ROUTES",
  PAYMENT_VIEW: "PAYMENT_VIEW",
  PAYOUT_VIEW: "PAYOUT_VIEW",
  WEBHOOK_VIEW: "WEBHOOK_VIEW",
  WEBHOOK_REPLAY: "WEBHOOK_REPLAY",
  SETTLEMENT_VIEW: "SETTLEMENT_VIEW",
  SETTLEMENT_IMPORT: "SETTLEMENT_IMPORT",
  RECONCILIATION_RESOLVE: "RECONCILIATION_RESOLVE",
  ACTIVITY_VIEW: "ACTIVITY_VIEW",
  PROMOTIONS_VIEW: "PROMOTIONS_VIEW",
  PROMOTIONS_MANAGE: "PROMOTIONS_MANAGE",
  PROMOTIONS_ACTIVATE: "PROMOTIONS_ACTIVATE",
  PROMOTION_AUDIT_VIEW: "PROMOTION_AUDIT_VIEW",
  DISTRIBUTORS_VIEW: "DISTRIBUTORS_VIEW",
  DISTRIBUTORS_MANAGE: "DISTRIBUTORS_MANAGE",
  DISTRIBUTORS_CREDENTIALS: "DISTRIBUTORS_CREDENTIALS",
});

// The first production administrator records predate granular RBAC claims.
// Keep only the read-oriented CRM surfaces (plus the distributor grants that
// the server already treats as legacy-compatible) available while those rows
// are migrated. An explicitly present empty canonical list still means revoked.
const LEGACY_ADMIN_COMPATIBILITY = new Set([
  ADMIN_PERMISSIONS.PAYMENTS_VIEW,
  ADMIN_PERMISSIONS.AUDIT_VIEW,
  ADMIN_PERMISSIONS.DISTRIBUTORS_VIEW,
  ADMIN_PERMISSIONS.DISTRIBUTORS_MANAGE,
  ADMIN_PERMISSIONS.DISTRIBUTORS_CREDENTIALS,
]);

export function isActiveAdmin(user) {
  return Boolean(user && user.role === "ADMIN" && user.status === "ACTIVE");
}

export function hasPermission(user, permission) {
  if (!isActiveAdmin(user)) return false;
  const superAdmin = String(user.admin_role || "").toUpperCase() === "SUPER_ADMIN";
  if (permission === ADMIN_PERMISSIONS.PAYMENT_SETTINGS_WRITE) return superAdmin;
  if (superAdmin) return true;
  const hasCanonical = Object.prototype.hasOwnProperty.call(user, "admin_permissions");
  const hasLegacy = Object.prototype.hasOwnProperty.call(user, "permissions");
  if (!hasCanonical && !hasLegacy) return LEGACY_ADMIN_COMPATIBILITY.has(permission);
  const permissions = Object.prototype.hasOwnProperty.call(user, "admin_permissions")
    ? user.admin_permissions
    : user.permissions;
  if (!Array.isArray(permissions)) return false;
  const normalized = permissions.map((value) => String(value).toUpperCase());
  return normalized.includes(permission);
}
