import { act } from "react";
import { createRoot } from "react-dom/client";
import { Profile } from "./ProfilePages";
import { resolvePersonalAvatarUrl } from "@/components/ProfileAvatar";

const mockNavigate = jest.fn();
const mockLogout = jest.fn();
const mockSetUser = jest.fn();
const mockApiPatch = jest.fn();
const mockApiPost = jest.fn();
const mockApiPut = jest.fn();
let mockUser;

jest.mock("react-router-dom", () => ({ useNavigate: () => mockNavigate }), { virtual: true });
jest.mock("@/context/AuthContext", () => ({ useAuth: () => ({ user: mockUser, setUser: mockSetUser, logout: mockLogout }) }));
jest.mock("@/lib/api", () => ({
  api: {
    defaults: { baseURL: "https://api.chakri.test/api" },
    patch: (...args) => mockApiPatch(...args),
    post: (...args) => mockApiPost(...args),
    put: (...args) => mockApiPut(...args),
  },
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
  mockApiPost.mockReset();
  mockApiPut.mockReset();
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
    avatar: "star",
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

test("profile editor exposes all 60 searchable portraits and saves a selected preset", async () => {
  mockApiPatch.mockResolvedValue({
    data: { message: "Game profile updated.", profile: { display_name: "Lucky Player", avatar: "star", profile_updated_at: "2026-08-21T11:59:00Z" } },
  });
  mockApiPut.mockResolvedValue({
    data: { message: "Avatar updated.", profile: { display_name: "Lucky Player", avatar: "avatar-42", avatar_source: "PRESET", profile_updated_at: "2026-08-21T12:00:00Z" } },
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<Profile />));

  await act(async () => container.querySelector('[data-testid="profile-edit-open"]').click());
  expect(container.querySelectorAll('[data-testid^="profile-edit-avatar-avatar-"]')).toHaveLength(60);
  const search = container.querySelector('[data-testid="profile-avatar-search"]');
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(search, "42");
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(container.querySelectorAll('[data-testid^="profile-edit-avatar-avatar-"]')).toHaveLength(1);

  const input = container.querySelector('[data-testid="profile-edit-display-name"]');
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, " Lucky Player ");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    container.querySelector('[data-testid="profile-edit-avatar-avatar-42"]').click();
  });
  await act(async () => {
    container.querySelector('[data-testid="profile-edit-form"]').dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(mockApiPatch).toHaveBeenCalledWith("/profile", { display_name: "Lucky Player" });
  expect(mockApiPut).toHaveBeenCalledWith("/profile/avatar", { avatar: "avatar-42" });
  expect(mockUser).toMatchObject({
    display_name: "Lucky Player",
    avatar: "avatar-42",
    avatar_url: null,
    avatar_source: "PRESET",
    email: "new.player@example.com",
    country: "India",
    chip_balance: 0,
    contact_verified: false,
  });
  expect(container.querySelector('[data-testid="profile-edit-form"]')).toBeNull();
  await act(async () => root.unmount());
});

test("personal avatar picker rejects unsupported or oversized files before upload", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<Profile />));
  await act(async () => container.querySelector('[data-testid="profile-edit-open"]').click());

  const upload = container.querySelector('[data-testid="profile-avatar-upload-input"]');
  const unsupported = new File(["not-an-image"], "notes.txt", { type: "text/plain" });
  Object.defineProperty(upload, "files", { configurable: true, value: [unsupported] });
  await act(async () => upload.dispatchEvent(new Event("change", { bubbles: true })));
  expect(container.querySelector('[data-testid="profile-avatar-upload-error"]')?.textContent).toMatch(/PNG, JPG, or WebP/i);
  expect(mockApiPost).not.toHaveBeenCalled();

  const oversized = new File([new Uint8Array(5 * 1024 * 1024 + 1)], "large.png", { type: "image/png" });
  Object.defineProperty(upload, "files", { configurable: true, value: [oversized] });
  await act(async () => upload.dispatchEvent(new Event("change", { bubbles: true })));
  expect(container.querySelector('[data-testid="profile-avatar-upload-error"]')?.textContent).toMatch(/5 MB or smaller/i);
  expect(mockApiPost).not.toHaveBeenCalled();
  await act(async () => root.unmount());
});

test("personal avatar upload sends authenticated multipart profile data and merges the response", async () => {
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  URL.createObjectURL = jest.fn(() => "blob:avatar-preview");
  URL.revokeObjectURL = jest.fn();
  mockApiPost.mockResolvedValue({
    data: {
      message: "Avatar updated.",
      profile: {
        display_name: "Portrait Player",
        avatar: "avatar-07",
        avatar_url: "/api/avatars/uploads/upload-player-1?v=2",
        avatar_source: "UPLOAD",
        avatar_upload_id: "upload-player-1",
        profile_updated_at: "2026-08-23T10:00:00Z",
      },
    },
  });
  mockApiPatch.mockResolvedValue({
    data: { message: "Game profile updated.", profile: { display_name: "Portrait Player", profile_updated_at: "2026-08-23T09:59:00Z" } },
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<Profile />));
  await act(async () => container.querySelector('[data-testid="profile-edit-open"]').click());

  const input = container.querySelector('[data-testid="profile-edit-display-name"]');
  const upload = container.querySelector('[data-testid="profile-avatar-upload-input"]');
  const file = new File([new Uint8Array([137, 80, 78, 71])], "portrait.png", { type: "image/png" });
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, " Portrait Player ");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    Object.defineProperty(upload, "files", { configurable: true, value: [file] });
    upload.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(container.querySelector('[data-testid="profile-avatar-upload-ready"]')?.textContent).toContain("portrait.png");
  expect(container.querySelector('[data-testid="profile-edit-current-avatar"] img')?.getAttribute("src")).toBe("blob:avatar-preview");

  await act(async () => {
    container.querySelector('[data-testid="profile-edit-form"]').dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(mockApiPost).toHaveBeenCalledTimes(1);
  const [endpoint, body] = mockApiPost.mock.calls[0];
  expect(endpoint).toBe("/profile/avatar/upload");
  expect(body).toBeInstanceOf(FormData);
  expect(body.get("file")).toBe(file);
  expect(body.get("display_name")).toBeNull();
  expect(mockApiPatch).toHaveBeenCalledWith("/profile", { display_name: "Portrait Player" });
  expect(mockApiPut).not.toHaveBeenCalled();
  expect(mockUser).toMatchObject({
    display_name: "Portrait Player",
    avatar: "avatar-07",
    avatar_url: "/api/avatars/uploads/upload-player-1?v=2",
    avatar_source: "UPLOAD",
    avatar_upload_id: "upload-player-1",
    email: "new.player@example.com",
    chip_balance: 0,
  });
  expect(container.querySelector('[data-testid="profile-edit-form"]')).toBeNull();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:avatar-preview");
  await act(async () => root.unmount());
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
});

test("uploaded avatar paths resolve against the authenticated API origin", () => {
  expect(resolvePersonalAvatarUrl("/api/avatars/uploads/abc?v=1")).toBe("https://api.chakri.test/api/avatars/uploads/abc?v=1");
  expect(resolvePersonalAvatarUrl("https://cdn.chakri.test/avatar.webp")).toBe("https://cdn.chakri.test/avatar.webp");
  expect(resolvePersonalAvatarUrl("javascript:alert(1)")).toBeNull();
});

test("personal avatar upload failure stays editable and exposes a retryable error", async () => {
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  URL.createObjectURL = jest.fn(() => "blob:failed-preview");
  URL.revokeObjectURL = jest.fn();
  mockApiPost.mockRejectedValue(new Error("Upload service unavailable"));
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<Profile />));
  await act(async () => container.querySelector('[data-testid="profile-edit-open"]').click());

  const upload = container.querySelector('[data-testid="profile-avatar-upload-input"]');
  const file = new File([new Uint8Array([1, 2, 3])], "portrait.webp", { type: "image/webp" });
  Object.defineProperty(upload, "files", { configurable: true, value: [file] });
  await act(async () => upload.dispatchEvent(new Event("change", { bubbles: true })));
  await act(async () => {
    container.querySelector('[data-testid="profile-edit-form"]').dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(container.querySelector('[data-testid="profile-edit-form"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="profile-avatar-upload-error"]')?.textContent).toContain("Upload service unavailable");
  expect(container.querySelector('[data-testid="profile-edit-error"]')?.textContent).toContain("Upload service unavailable");
  expect(container.querySelector('[data-testid="profile-edit-save"]')?.disabled).toBe(false);
  await act(async () => root.unmount());
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
});
