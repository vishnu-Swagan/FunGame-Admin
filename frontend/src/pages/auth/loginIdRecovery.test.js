import { act } from "react";
import { createRoot } from "react-dom/client";
import Login from "./Login";
import VerifyEmail from "./VerifyEmail";

const mockNavigate = jest.fn();
const mockLogin = jest.fn();
const mockPost = jest.fn();
const mockGet = jest.fn();
let mockLocationState = null;
let mockCapabilities;

jest.mock("react-router-dom", () => ({
  useNavigate: () => mockNavigate,
  useLocation: () => ({ state: mockLocationState }),
  Link: ({ children, to, ...props }) => <a href={to} {...props}>{children}</a>,
}), { virtual: true });

jest.mock("@/context/AuthContext", () => ({
  useAuth: () => ({ login: mockLogin }),
}));

jest.mock("@/lib/authCapabilities", () => ({
  ...jest.requireActual("@/lib/authCapabilities"),
  useAuthCapabilities: () => ({ loading: false, capabilities: mockCapabilities }),
}));

jest.mock("@/lib/api", () => ({
  api: {
    post: (...args) => mockPost(...args),
    get: (...args) => mockGet(...args),
  },
  errMsg: (error) => error?.response?.data?.detail?.message || error?.message || "Request failed",
  routeForUser: () => "/welcome",
}));

jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

jest.mock("@/pages/auth/AuthShell", () => ({
  AuthShell: ({ children, title }) => <main><h1>{title}</h1>{children}</main>,
}));

jest.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }) => <button {...props}>{children}</button>,
}));

jest.mock("@/components/ui/input", () => ({ Input: (props) => <input {...props} /> }));
jest.mock("@/components/ui/label", () => ({ Label: ({ children, ...props }) => <label {...props}>{children}</label> }));
jest.mock("@/components/ui/input-otp", () => ({
  InputOTP: ({ value, onChange }) => (
    <input data-testid="verification-code-input" value={value} onChange={(event) => onChange(event.target.value)} />
  ),
  InputOTPGroup: ({ children }) => <>{children}</>,
  InputOTPSlot: () => null,
}));

function change(input, value) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function render(Component) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<Component />);
    await settle();
  });
  return { container, root };
}

async function submit(form) {
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
  });
}

beforeAll(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mockNavigate.mockReset();
  mockLogin.mockReset();
  mockPost.mockReset();
  mockGet.mockReset();
  mockLocationState = null;
  mockCapabilities = {
    registration_enabled: true,
    phone_registration: true,
    email_registration: false,
    phone_contact_verification: true,
    email_contact_verification: true,
    verification_required: true,
    email_verification_required: true,
    registration_mode: "PHONE_OTP",
  };
});

afterEach(() => {
  document.body.innerHTML = "";
  jest.clearAllMocks();
});

test("phone then email verification sends the same editable Login ID on both steps", async () => {
  mockLocationState = {
    channel: "PHONE",
    identifier: "+447700900123",
    secondaryIdentifier: "player@example.com",
    loginId: "Royal.Player",
  };
  mockPost
    .mockResolvedValueOnce({ data: {
      next_verification: {
        channel: "EMAIL",
        identifier: "player@example.com",
        destination_masked: "p***@example.com",
      },
    } })
    .mockResolvedValueOnce({ data: {
      access_token: "token",
      user: { id: "player-1", role: "PLAYER", status: "ACTIVE" },
    } });
  const { container, root } = await render(VerifyEmail);

  change(container.querySelector('[data-testid="verify-login-id-input"]'), "Royal.Player.2");
  change(container.querySelector('[data-testid="verification-code-input"]'), "123456");
  change(container.querySelector('[data-testid="verify-password-input"]'), "Strong-Password-9");
  change(container.querySelector('[data-testid="verify-password-confirm-input"]'), "Strong-Password-9");
  await submit(container.querySelector("form"));

  expect(mockPost).toHaveBeenNthCalledWith(1, "/auth/verify-otp", expect.objectContaining({
    channel: "PHONE",
    identifier: "+447700900123",
    username: "Royal.Player.2",
  }));

  change(container.querySelector('[data-testid="verification-code-input"]'), "654321");
  await submit(container.querySelector("form"));

  expect(mockPost).toHaveBeenNthCalledWith(2, "/auth/verify-otp", expect.objectContaining({
    channel: "EMAIL",
    identifier: "player@example.com",
    email: "player@example.com",
    username: "Royal.Player.2",
  }));
  expect(mockLogin).toHaveBeenCalledWith("token", expect.objectContaining({ id: "player-1" }));
  await act(async () => root.unmount());
});

test("login recovery carries the pending Login ID into email verification", async () => {
  mockPost
    .mockRejectedValueOnce({ response: { data: { detail: {
      code: "CONTACT_NOT_VERIFIED",
      channel: "EMAIL",
      identifier: "player@example.com",
      login_id: "Royal.Player.2",
      message: "Verify your contact method before logging in.",
    } } } })
    .mockResolvedValueOnce({ data: {
      destination_masked: "p***@example.com",
      resend_after_seconds: 30,
    } });
  mockGet.mockResolvedValue({ data: {
    registration_enabled: true,
    phone_registration: true,
    email_registration: false,
    phone_contact_verification: true,
    email_contact_verification: true,
    verification_required: true,
    registration_mode: "PHONE_OTP",
  } });
  const { container, root } = await render(Login);
  // Pending dual-verification accounts have not claimed the Login ID yet;
  // recovery authenticates with the already verified mobile number.
  change(container.querySelector("#identifier"), "+447700900123");
  change(container.querySelector("#password"), "Strong-Password-9");
  await submit(container.querySelector("form"));

  expect(mockPost).toHaveBeenNthCalledWith(2, "/auth/resend-otp", expect.objectContaining({
    channel: "EMAIL",
    identifier: "player@example.com",
    email: "player@example.com",
  }));
  expect(mockNavigate).toHaveBeenCalledWith("/verify", { state: expect.objectContaining({
    channel: "EMAIL",
    identifier: "player@example.com",
    loginId: "Royal.Player.2",
  }) });
  await act(async () => root.unmount());
});
