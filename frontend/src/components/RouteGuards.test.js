import { act } from "react";
import { createRoot } from "react-dom/client";
import { ADMIN_PERMISSIONS, hasPermission, isActiveAdmin } from "../lib/adminPermissions";
import { useAuth } from "@/context/AuthContext";
import { RequireAdmin } from "./RouteGuards";

jest.mock("@/context/AuthContext", () => ({ useAuth: jest.fn() }));
jest.mock("react-router-dom", () => ({
  Navigate: ({ to }) => <span data-navigate-to={to}>{to}</span>,
  useLocation: () => ({ pathname: "/Admin" }),
}), { virtual: true });

beforeAll(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
});

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

test("distributor CRM permissions remain independently scoped", () => {
  const viewer = { role: "ADMIN", status: "ACTIVE", admin_permissions: [ADMIN_PERMISSIONS.DISTRIBUTORS_VIEW] };
  expect(hasPermission(viewer, ADMIN_PERMISSIONS.DISTRIBUTORS_VIEW)).toBe(true);
  expect(hasPermission(viewer, ADMIN_PERMISSIONS.DISTRIBUTORS_MANAGE)).toBe(false);
  expect(hasPermission(viewer, ADMIN_PERMISSIONS.DISTRIBUTORS_CREDENTIALS)).toBe(false);
});

test("pre-RBAC administrators retain the CRM read surfaces during migration", () => {
  const legacyAdmin = { role: "ADMIN", status: "ACTIVE" };
  expect(hasPermission(legacyAdmin, ADMIN_PERMISSIONS.DISTRIBUTORS_VIEW)).toBe(true);
  expect(hasPermission(legacyAdmin, ADMIN_PERMISSIONS.PAYMENTS_VIEW)).toBe(true);
  expect(hasPermission(legacyAdmin, ADMIN_PERMISSIONS.AUDIT_VIEW)).toBe(true);
  expect(hasPermission(legacyAdmin, ADMIN_PERMISSIONS.GATEWAY_VIEW)).toBe(true);
  expect(hasPermission(legacyAdmin, ADMIN_PERMISSIONS.GATEWAY_CREATE)).toBe(true);
  expect(hasPermission(legacyAdmin, ADMIN_PERMISSIONS.GATEWAY_UPDATE_NON_SECRET_CONFIG)).toBe(true);
  expect(hasPermission(legacyAdmin, ADMIN_PERMISSIONS.GATEWAY_TEST)).toBe(true);
  expect(hasPermission(legacyAdmin, ADMIN_PERMISSIONS.WITHDRAWALS_APPROVE)).toBe(false);
  expect(hasPermission(legacyAdmin, ADMIN_PERMISSIONS.GATEWAY_ACTIVATE)).toBe(false);
  expect(hasPermission(legacyAdmin, ADMIN_PERMISSIONS.PAYMENT_SETTINGS_WRITE)).toBe(false);
});

test("a bootstrap admin with an empty grant list still reaches CRM payment configuration", () => {
  const bootstrap = { role: "ADMIN", status: "ACTIVE", admin_permissions: [] };
  expect(hasPermission(bootstrap, ADMIN_PERMISSIONS.PAYMENTS_VIEW)).toBe(true);
  expect(hasPermission(bootstrap, ADMIN_PERMISSIONS.GATEWAY_CREATE)).toBe(true);
  expect(hasPermission(bootstrap, ADMIN_PERMISSIONS.GATEWAY_ACTIVATE)).toBe(false);
  expect(hasPermission(bootstrap, ADMIN_PERMISSIONS.DISTRIBUTORS_MANAGE)).toBe(false);
  expect(hasPermission(bootstrap, ADMIN_PERMISSIONS.PAYMENT_SETTINGS_WRITE)).toBe(false);
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

test("a signed-out same-origin /Admin visit opens the dedicated admin login", async () => {
  useAuth.mockReturnValue({ user: null, loading: false });
  const container = document.createElement("div");
  const root = createRoot(container);

  await act(async () => {
    root.render(<RequireAdmin><span>private admin</span></RequireAdmin>);
  });

  expect(container.querySelector("[data-navigate-to]")?.getAttribute("data-navigate-to"))
    .toBe("/Admin/login");
  expect(container.textContent).not.toContain("/welcome");
  await act(async () => root.unmount());
});
