import { renderToStaticMarkup } from "react-dom/server";
import Register from "./Register";
import VerifyEmail from "./VerifyEmail";
import Welcome from "./Welcome";

let mockCapabilitiesState;
let mockLocationState;

jest.mock("@/lib/authCapabilities", () => ({
  ...jest.requireActual("@/lib/authCapabilities"),
  useAuthCapabilities: () => mockCapabilitiesState,
}));

jest.mock("@/context/AuthContext", () => ({
  useAuth: () => ({ login: jest.fn() }),
}));

jest.mock("react-router-dom", () => {
  const React = require("react");
  return {
    useNavigate: () => jest.fn(),
    useLocation: () => ({ state: mockLocationState }),
    Link: ({ children, to, ...props }) => React.createElement("a", { href: to, ...props }, children),
  };
}, { virtual: true });

function render(Component) {
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(<Component />);
  return container;
}

test("welcome page removes the unavailable warning while registration itself remains gated", () => {
  mockLocationState = null;
  mockCapabilitiesState = {
    loading: false,
    capabilities: { registration_enabled: false, email_registration: false, phone_registration: false },
  };
  const screen = render(Welcome);
  expect(screen.querySelector('[data-testid="welcome-register-button"]').disabled).toBe(false);
  expect(screen.querySelector('[data-testid="welcome-registration-unavailable"]')).toBeNull();
});

test("registration disables an unavailable channel but keeps the ready channel usable", () => {
  mockLocationState = null;
  mockCapabilitiesState = {
    loading: false,
    capabilities: { registration_enabled: true, email_registration: true, phone_registration: false },
  };
  const screen = render(Register);
  expect(screen.querySelector('[data-testid="register-channel-email"]').disabled).toBe(false);
  expect(screen.querySelector('[data-testid="register-channel-phone"]').disabled).toBe(true);
  expect(screen.querySelector('[data-testid="auth-primary-submit-button"]').disabled).toBe(false);
  expect(screen.querySelector('[data-testid="registration-unavailable"]')).toBeNull();
});

test("registration stays fail-closed without rendering the removed unavailable banner", () => {
  mockLocationState = null;
  mockCapabilitiesState = {
    loading: false,
    capabilities: { registration_enabled: false, email_registration: false, phone_registration: false },
  };
  const screen = render(Register);
  expect(screen.querySelector('[data-testid="registration-unavailable"]')).toBeNull();
  expect(screen.querySelector('[data-testid="register-channel-email"]').disabled).toBe(true);
  expect(screen.querySelector('[data-testid="register-channel-phone"]').disabled).toBe(true);
  expect(screen.querySelector('[data-testid="auth-primary-submit-button"]').disabled).toBe(true);
});

test("direct verification fails closed when neither delivery channel is ready", () => {
  mockLocationState = null;
  mockCapabilitiesState = {
    loading: false,
    capabilities: { registration_enabled: false, email_registration: false, phone_registration: false },
  };
  const screen = render(VerifyEmail);
  expect(screen.querySelector('[data-testid="verification-unavailable"]')).not.toBeNull();
  expect(screen.querySelector('[data-testid="verify-channel-email"]').disabled).toBe(true);
  expect(screen.querySelector('[data-testid="verify-channel-phone"]').disabled).toBe(true);
  expect(screen.querySelector('[data-testid="verify-identifier-input"]').disabled).toBe(true);
  expect(screen.querySelector('[data-testid="verify-email-resend-button"]').disabled).toBe(true);
});

test("verification exposes only the ready delivery channel", () => {
  mockLocationState = null;
  mockCapabilitiesState = {
    loading: false,
    capabilities: { registration_enabled: true, email_registration: true, phone_registration: false },
  };
  const screen = render(VerifyEmail);
  expect(screen.querySelector('[data-testid="verification-unavailable"]')).toBeNull();
  expect(screen.querySelector('[data-testid="verify-channel-email"]').disabled).toBe(false);
  expect(screen.querySelector('[data-testid="verify-channel-phone"]').disabled).toBe(true);
  expect(screen.querySelector('[data-testid="verify-identifier-input"]').disabled).toBe(false);
});

test("an already delivered code stays verifiable while resend is unavailable", () => {
  mockLocationState = { channel: "PHONE", identifier: "+919876543210" };
  mockCapabilitiesState = {
    loading: false,
    capabilities: { registration_enabled: false, email_registration: false, phone_registration: false },
  };
  const screen = render(VerifyEmail);
  expect(screen.querySelector('[data-testid="verification-resend-unavailable"]')).not.toBeNull();
  expect(screen.querySelector('[data-testid="verify-email-resend-button"]').disabled).toBe(true);
});
