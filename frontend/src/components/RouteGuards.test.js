import { ADMIN_PERMISSIONS, hasPermission, isActiveAdmin } from "../lib/adminPermissions";

test("admin financial permissions fail closed when claims are absent", () => {
  expect(hasPermission({ role: "ADMIN" }, ADMIN_PERMISSIONS.PAYMENTS_VIEW)).toBe(false);
  expect(hasPermission({ role: "PLAYER", permissions: ["*"] }, ADMIN_PERMISSIONS.PAYMENTS_VIEW)).toBe(false);
  expect(hasPermission({ role: "ADMIN", status: "ACTIVE", permissions: ["*"] }, ADMIN_PERMISSIONS.PAYMENTS_VIEW)).toBe(false);
});

test("explicit permissions grant only their matching controls", () => {
  const admin = { role: "ADMIN", status: "ACTIVE", admin_permissions: [ADMIN_PERMISSIONS.PAYMENTS_VIEW, ADMIN_PERMISSIONS.WITHDRAWALS_APPROVE] };
  expect(hasPermission(admin, ADMIN_PERMISSIONS.PAYMENTS_VIEW)).toBe(true);
  expect(hasPermission(admin, ADMIN_PERMISSIONS.WITHDRAWALS_APPROVE)).toBe(true);
  expect(hasPermission(admin, ADMIN_PERMISSIONS.WITHDRAWALS_MARK_PAID)).toBe(false);
  expect(hasPermission(admin, ADMIN_PERMISSIONS.PAYMENT_SETTINGS_WRITE)).toBe(false);
});

test("an empty canonical permission list does not revive legacy permissions", () => {
  const revoked = {
    role: "ADMIN",
    status: "ACTIVE",
    admin_permissions: [],
    permissions: [ADMIN_PERMISSIONS.PAYMENTS_VIEW],
  };
  expect(hasPermission(revoked, ADMIN_PERMISSIONS.PAYMENTS_VIEW)).toBe(false);
});

test("only an explicit SUPER_ADMIN can access payment settings", () => {
  expect(hasPermission({ role: "ADMIN", status: "ACTIVE", admin_role: "SUPER_ADMIN" }, ADMIN_PERMISSIONS.PAYMENT_SETTINGS_WRITE)).toBe(true);
  expect(hasPermission({ role: "ADMIN", status: "ACTIVE", permissions: [ADMIN_PERMISSIONS.PAYMENT_SETTINGS_WRITE] }, ADMIN_PERMISSIONS.PAYMENT_SETTINGS_WRITE)).toBe(false);
});

test("inactive administrators cannot enter privileged routes", () => {
  expect(isActiveAdmin({ role: "ADMIN", status: "ACTIVE" })).toBe(true);
  expect(isActiveAdmin({ role: "ADMIN", status: "SUSPENDED" })).toBe(false);
  expect(hasPermission({ role: "ADMIN", status: "SUSPENDED", admin_role: "SUPER_ADMIN" }, ADMIN_PERMISSIONS.PAYMENTS_VIEW)).toBe(false);
});
