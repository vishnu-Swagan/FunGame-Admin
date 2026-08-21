import { act } from "react";
import { createRoot } from "react-dom/client";
import { Profile } from "./ProfilePages";

const mockNavigate = jest.fn();
const mockLogout = jest.fn();
const mockSetUser = jest.fn();
const mockApiPatch = jest.fn();
let mockUser;

jest.mock("react-router-dom", () => ({ useNavigate: () => mockNavigate }), { virtual: true });
jest.mock("@/context/AuthContext", () => ({ useAuth: () => ({ user: mockUser, setUser: mockSetUser, logout: mockLogout }) }));
jest.mock("@/lib/api", () => ({
  api: { patch: (...args) => mockApiPatch(...args) },
  errMsg: (error) => error?.message || "Request failed",
  APP_VERSION: "1.0.0",
}));
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }));
jest.mock("@/components/common", () => ({
  PageTransition: ({ children, ...props }) => <div {...props}>{children}</div>,
  AvatarBadge: ({ avatarKey }) => <div data-avatar={avatarKey} />,
  UserStatusBadge: ({ status }) => <span>{status}</span>,
  Disclaimer: () => null,
  formatChips: (value) => String(value ?? 0),
  AVATARS: [{ key: "star" }, { key: "crown" }],
}));
jest.mock("@/components/ui/button", () => ({ Button: ({ children, ...props }) => <button {...props}>{children}</button> }));
jest.mock("@/components/ui/input", () => ({ Input: (props) => <input {...props} /> }));
jest.mock("@/components/ui/label", () => ({ Label: ({ children, ...props }) => <label {...props}>{children}</label> }));

beforeAll(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mockNavigate.mockReset();
  mockLogout.mockReset();
  mockSetUser.mockReset();
  mockApiPatch.mockReset();
  mockUser = {
    id: "player-1",
    role: "PLAYER",
    status: "ACTIVE",
    login_id: "GK1234567",
    display_name: "New Player",
    email: "new.player@example.com",
    country: "India",
    chip_balance: 0,
    activation_mode: "SELF_SERVICE_NO_OTP",
    contact_verification_status: "DEFERRED",
    contact_verified: false,
  };
  mockSetUser.mockImplementation((updater) => {
    mockUser = typeof updater === "function" ? updater(mockUser) : updater;
  });
});

afterEach(() => {
  document.body.innerHTML = "";
  jest.clearAllMocks();
});

test("game profile exposes operator-review account state and the chip-request entry point", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<Profile />));

  expect(container.querySelector('[data-testid="profile-account-details"]')?.textContent).toMatch(/GK1234567.*new.player@example.com.*India/i);
  expect(container.querySelector('[data-testid="profile-contact-verification"]')?.textContent).toBe("OTP deferred");
  expect(container.querySelector('[data-testid="profile-link-settings"]')?.textContent).toMatch(/Account settings/i);

  await act(async () => container.querySelector('[data-testid="profile-link-request-chips"]').click());
  expect(mockNavigate).toHaveBeenCalledWith("/chips/request");
  await act(async () => root.unmount());
});

test("profile editor updates only display name and avatar in the game account", async () => {
  mockApiPatch.mockResolvedValue({
    data: { message: "Game profile updated.", profile: { display_name: "Lucky Player", avatar: "crown", profile_updated_at: "2026-08-21T12:00:00Z" } },
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<Profile />));

  await act(async () => container.querySelector('[data-testid="profile-edit-open"]').click());
  const input = container.querySelector('[data-testid="profile-edit-display-name"]');
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, " Lucky Player ");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    container.querySelector('[data-testid="profile-edit-avatar-crown"]').click();
  });
  await act(async () => {
    container.querySelector('[data-testid="profile-edit-form"]').dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(mockApiPatch).toHaveBeenCalledWith("/profile", { display_name: "Lucky Player", avatar: "crown" });
  expect(mockUser).toMatchObject({
    display_name: "Lucky Player",
    avatar: "crown",
    email: "new.player@example.com",
    country: "India",
    chip_balance: 0,
    contact_verified: false,
  });
  expect(container.querySelector('[data-testid="profile-edit-form"]')).toBeNull();
  await act(async () => root.unmount());
});
