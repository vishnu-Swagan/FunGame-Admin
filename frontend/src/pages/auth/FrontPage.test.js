import { act } from "react";
import { createRoot } from "react-dom/client";
import FrontPage from "./FrontPage";

let mockUser = null;
let mockSearch = "";
const mockNavigate = jest.fn();

jest.mock("@/context/AuthContext", () => ({
  useAuth: () => ({ user: mockUser, loading: false, login: jest.fn() }),
}));

jest.mock("@/lib/authCapabilities", () => ({
  ...jest.requireActual("@/lib/authCapabilities"),
  useAuthCapabilities: () => ({
    loading: false,
    capabilities: {
      registration_enabled: true,
      email_registration: false,
      phone_registration: true,
      email_password_reset: true,
      phone_password_reset: true,
      registration_mode: "PHONE_OTP",
    },
  }),
}));

jest.mock("react-router-dom", () => {
  const React = require("react");
  return {
    useNavigate: () => mockNavigate,
    useLocation: () => ({ pathname: "/", search: mockSearch, state: null }),
    useSearchParams: () => [new URLSearchParams(mockSearch.replace(/^\?/, "")), jest.fn()],
    Navigate: ({ to }) => React.createElement("span", { "data-navigate-to": typeof to === "string" ? to : to?.pathname }, "nav"),
    Link: ({ children, to, ...props }) => React.createElement("a", { href: to, ...props }, children),
  };
}, { virtual: true });

jest.mock("@/components/AppShell", () => ({
  __esModule: true,
  default: ({ children }) => <div data-testid="mock-app-shell">{children}</div>,
}));

jest.mock("@/pages/app/PlayerLobby", () => ({
  __esModule: true,
  default: () => <div data-testid="frontpage-active-lobby">lobby</div>,
}));

jest.mock("framer-motion", () => ({
  motion: {
    div: ({ children, ...props }) => <div {...props}>{children}</div>,
  },
}));

beforeAll(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
});

async function renderFront() {
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => {
    root.render(<FrontPage />);
  });
  return { container, root };
}

test("logged-out frontpage exposes login register and forgot without leaving /", async () => {
  mockUser = null;
  mockSearch = "";
  mockNavigate.mockClear();
  const { container, root } = await renderFront();
  expect(container.querySelector('[data-testid="frontpage"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="welcome-login-button"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="welcome-register-button"]')).not.toBeNull();

  await act(async () => {
    container.querySelector('[data-testid="welcome-login-button"]').click();
  });
  expect(mockNavigate).toHaveBeenCalledWith({ pathname: "/", search: "?auth=login" }, { replace: true });

  mockSearch = "?auth=login";
  await act(async () => {
    root.render(<FrontPage />);
  });
  expect(container.querySelector('[data-testid="frontpage-login-panel"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="frontpage-tab-register"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="frontpage-tab-forgot"]')).not.toBeNull();

  await act(async () => {
    container.querySelector('[data-testid="frontpage-tab-register"]').click();
  });
  expect(mockNavigate).toHaveBeenCalledWith({ pathname: "/", search: "?auth=register" }, { replace: true });

  mockSearch = "?auth=forgot";
  await act(async () => {
    root.render(<FrontPage />);
  });
  expect(container.querySelector('[data-testid="frontpage-forgot-panel"]')).not.toBeNull();
  await act(async () => root.unmount());
});

test("ACTIVE player lobby renders on the frontpage", async () => {
  mockUser = { role: "PLAYER", status: "ACTIVE", display_name: "Ace" };
  mockSearch = "";
  const { container, root } = await renderFront();
  expect(container.querySelector('[data-testid="mock-app-shell"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="frontpage-active-lobby"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="frontpage"]')).toBeNull();
  await act(async () => root.unmount());
});
