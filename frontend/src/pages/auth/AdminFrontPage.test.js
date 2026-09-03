import { act } from "react";
import { createRoot } from "react-dom/client";
import AdminFrontPage from "./AdminFrontPage";

let mockUser = null;
let mockPathname = "/Admin";

jest.mock("@/context/AuthContext", () => ({
  useAuth: () => ({ user: mockUser, loading: false, login: jest.fn() }),
}));

jest.mock("react-router-dom", () => {
  const React = require("react");
  return {
    useNavigate: () => jest.fn(),
    useLocation: () => ({ pathname: mockPathname, search: "", hash: "" }),
    Navigate: ({ to }) => React.createElement("span", { "data-navigate-to": to }, to),
    Outlet: () => React.createElement("div", { "data-testid": "outlet" }, "outlet"),
    NavLink: ({ children, to, ...props }) => React.createElement("a", { href: to, ...props }, children),
    Link: ({ children, to, ...props }) => React.createElement("a", { href: to, ...props }, children),
  };
}, { virtual: true });

jest.mock("@/pages/auth/AdminLogin", () => ({
  __esModule: true,
  default: ({ role }) => <div data-testid="admin-login" data-role={role}>crm-login</div>,
}));

jest.mock("@/pages/admin/AdminLayout", () => ({
  __esModule: true,
  default: () => <div data-testid="admin-layout">layout</div>,
}));

beforeAll(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
});

async function renderFront() {
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => {
    root.render(<AdminFrontPage />);
  });
  return { container, root };
}

test("Admin CRM front door shows login on /Admin when logged out without needing /Admin/login", async () => {
  mockUser = null;
  mockPathname = "/Admin";
  const { container, root } = await renderFront();
  expect(container.querySelector('[data-testid="admin-login"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="admin-login"]')?.getAttribute("data-role")).toBe("ADMIN");
  expect(container.querySelector('[data-testid="admin-layout"]')).toBeNull();
  expect(container.querySelector("[data-navigate-to]")).toBeNull();
  await act(async () => root.unmount());
});

test("signed-out /Admin/dashboard lands on the /Admin login front door", async () => {
  mockUser = null;
  mockPathname = "/Admin/dashboard";
  const { container, root } = await renderFront();
  expect(container.querySelector("[data-navigate-to]")?.getAttribute("data-navigate-to")).toBe("/Admin");
  expect(container.querySelector('[data-testid="admin-login"]')).toBeNull();
  await act(async () => root.unmount());
});

test("active admin on /Admin gets the CRM shell without a login page hop", async () => {
  mockUser = { role: "ADMIN", status: "ACTIVE" };
  mockPathname = "/Admin";
  const { container, root } = await renderFront();
  expect(container.querySelector('[data-testid="admin-layout"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="admin-login"]')).toBeNull();
  await act(async () => root.unmount());
});
