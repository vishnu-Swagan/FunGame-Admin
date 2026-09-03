import { renderToStaticMarkup } from "react-dom/server";
import Register from "./Register";
import Login from "./Login";
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

test("welcome page describes administrator review in the current manual mode", () => {
  mockLocationState = null;
  mockCapabilitiesState = {
    loading: false,
    capabilities: { registration_enabled: true, email_registration: true, phone_registration: true, verification_required: false, manual_admin_review: true, registration_mode: "ADMIN_REVIEW" },
  };
  const screen = render(Welcome);
  expect(screen.textContent).toMatch(/Admin-reviewed access/);
  expect(screen.textContent).toMatch(/reviewed by an administrator before login and play/i);
  expect(screen.textContent).not.toMatch(/mandatory mobile OTP/i);
});

test("manual-review registration requires both contacts and password confirmation", () => {
  mockLocationState = null;
  mockCapabilitiesState = {
    loading: false,
    capabilities: { registration_enabled: true, email_registration: true, phone_registration: true, verification_required: false, manual_admin_review: true, registration_mode: "ADMIN_REVIEW" },
  };
  const screen = render(Register);
  expect(screen.querySelector('#reg-login-id')).toBeNull();
  expect(screen.querySelector('#reg-contact').type).toBe("tel");
  expect(screen.querySelector('#reg-email').required).toBe(true);
  expect(screen.querySelector('#reg-password').required).toBe(true);
  expect(screen.querySelector('#reg-password-confirmation').required).toBe(true);
  expect(screen.querySelector('[data-testid="register-terms-checkbox"]')).not.toBeNull();
  expect(screen.querySelector('[data-testid="auth-primary-submit-button"]').disabled).toBe(false);
  expect(screen.querySelector('[data-testid="registration-unavailable"]')).toBeNull();
});

test("registration clearly labels manual approval without claiming an OTP", () => {
  mockLocationState = null;
  mockCapabilitiesState = {
    loading: false,
    capabilities: { registration_enabled: true, email_registration: true, phone_registration: true, verification_required: false, manual_admin_review: true, registration_mode: "ADMIN_REVIEW" },
  };
  const screen = render(Register);
  expect(screen.querySelector('[data-testid="register-verification-copy"]').textContent).toMatch(/No verification code is sent.*administrator must approve/i);
  expect(screen.querySelector('[data-testid="auth-primary-submit-button"]').textContent).toMatch(/Create account for review/);

  const login = render(Login);
  const loginIdentifier = login.querySelector('#identifier');
  expect(loginIdentifier.placeholder).toBe("Email, mobile with +country code, or your Login ID");
  expect(loginIdentifier.placeholder).not.toMatch(/\+91|GK Login ID/i);
  expect(login.querySelector('[data-testid="login-forgot-link"]')).toBeNull();
  expect(login.querySelector('[data-testid="login-manual-recovery-note"]')).not.toBeNull();
});

test("registration stays fail-closed without rendering the removed unavailable banner", () => {
  mockLocationState = null;
  mockCapabilitiesState = {
    loading: false,
    capabilities: { registration_enabled: false, email_registration: false, phone_registration: false },
  };
  const screen = render(Register);
  expect(screen.querySelector('[data-testid="registration-unavailable"]')).toBeNull();
  expect(screen.querySelector('[data-testid="auth-primary-submit-button"]').disabled).toBe(true);
});

test("phone OTP registration requires email without a Login ID field", () => {
  mockLocationState = null;
  mockCapabilitiesState = {
    loading: false,
    capabilities: {
      registration_enabled: true,
      email_registration: false,
      phone_registration: true,
      verification_required: true,
      email_verification_required: false,
      registration_mode: "PHONE_OTP",
    },
  };
  const screen = render(Register);
  expect(screen.textContent).not.toMatch(/Mobile \+ email verification/);
  expect(screen.textContent).toMatch(/one SMS code/i);
  expect(screen.querySelector('#reg-login-id')).toBeNull();
  expect(screen.querySelector('#reg-contact')).not.toBeNull();
  expect(screen.querySelector('#reg-email').required).toBe(true);
});

test("direct verification fails closed when neither delivery channel is ready", () => {
  mockLocationState = null;
  mockCapabilitiesState = {
    loading: false,
    capabilities: { registration_enabled: false, email_registration: false, phone_registration: false },
  };
  const screen = render(VerifyEmail);
  expect(screen.querySelector('[data-testid="verification-unavailable"]')).not.toBeNull();
  expect(screen.querySelector('[data-testid="verify-identifier-input"]').disabled).toBe(true);
  expect(screen.querySelector('[data-testid="verify-email-resend-button"]').disabled).toBe(true);
});

test("verification exposes the ready mobile delivery channel", () => {
  mockLocationState = null;
  mockCapabilitiesState = {
    loading: false,
    capabilities: { registration_enabled: true, email_registration: false, phone_registration: true, verification_required: true },
  };
  const screen = render(VerifyEmail);
  expect(screen.querySelector('[data-testid="verification-unavailable"]')).toBeNull();
  expect(screen.querySelector('[data-testid="verify-identifier-input"]').disabled).toBe(false);
  expect(screen.querySelector('[data-testid="verify-identifier-input"]').type).toBe("tel");
  expect(screen.querySelector('label[for="verify-identifier"]')?.textContent).toMatch(/Mobile number.*\+country code/);
  expect(screen.querySelector('[data-testid="verify-identifier-input"]').autocomplete).toBe("tel");
  expect(screen.querySelector('[data-testid="verify-identifier-input"]').placeholder).toBe("Enter with +country code");
});

test("an already delivered code stays verifiable while resend is unavailable", () => {
  mockLocationState = { channel: "PHONE", identifier: "+919876543210", loginId: "Royal.Player" };
  mockCapabilitiesState = {
    loading: false,
    capabilities: { registration_enabled: false, email_registration: false, phone_registration: false },
  };
  const screen = render(VerifyEmail);
  expect(screen.querySelector('[data-testid="verification-resend-unavailable"]')).not.toBeNull();
  expect(screen.querySelector('[data-testid="verify-email-resend-button"]').disabled).toBe(true);
  expect(screen.querySelector('[data-input-otp]').pattern).toBe("^\\d+$");
  expect(screen.querySelector('[data-testid="verify-login-id-input"]').value).toBe("Royal.Player");
  expect(screen.querySelector('[data-testid="verify-login-id-input"]').required).toBe(true);
  expect(screen.querySelector('[data-testid="verification-recovery-guidance"]')?.textContent).toMatch(/registered before.*login or account recovery/i);
  expect(screen.querySelector('a[href="/login"]')).not.toBeNull();
  expect(screen.querySelector('a[href="/forgot-password"]')).not.toBeNull();
});
