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
});

export function isActiveAdmin(user) {
  return Boolean(user && user.role === "ADMIN" && user.status === "ACTIVE");
}

export function hasPermission(user, permission) {
  if (!isActiveAdmin(user)) return false;
  const superAdmin = String(user.admin_role || "").toUpperCase() === "SUPER_ADMIN";
  if (permission === ADMIN_PERMISSIONS.PAYMENT_SETTINGS_WRITE) return superAdmin;
  if (superAdmin) return true;
  const permissions = Object.prototype.hasOwnProperty.call(user, "admin_permissions")
    ? user.admin_permissions
    : user.permissions;
  if (!Array.isArray(permissions)) return false;
  const normalized = permissions.map((value) => String(value).toUpperCase());
  return normalized.includes(permission);
}
