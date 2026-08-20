import { renderToStaticMarkup } from "react-dom/server";
import Register from "./Register";
import Welcome from "./Welcome";

let mockCapabilitiesState;

jest.mock("@/lib/authCapabilities", () => ({
  useAuthCapabilities: () => mockCapabilitiesState,
  registrationChannelAvailable: (capabilities, channel) => Boolean(
    capabilities?.registration_enabled
      && (channel === "PHONE" ? capabilities.phone_registration : capabilities.email_registration),
  ),
}));

jest.mock("react-router-dom", () => {
  const React = require("react");
  return {
    useNavigate: () => jest.fn(),
    Link: ({ children, to, ...props }) => React.createElement("a", { href: to, ...props }, children),
  };
}, { virtual: true });

function render(Component) {
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(<Component />);
  return container;
}

test("welcome page fails closed when no registration delivery channel is ready", () => {
  mockCapabilitiesState = {
    loading: false,
    capabilities: { registration_enabled: false, email_registration: false, phone_registration: false },
  };
  const screen = render(Welcome);
  expect(screen.querySelector('[data-testid="welcome-register-button"]').disabled).toBe(true);
  expect(screen.querySelector('[data-testid="welcome-registration-unavailable"]')).not.toBeNull();
});

test("registration disables an unavailable channel but keeps the ready channel usable", () => {
  mockCapabilitiesState = {
    loading: false,
    capabilities: { registration_enabled: true, email_registration: true, phone_registration: false },
  };
  const screen = render(Register);
  expect(screen.querySelector('[data-testid="register-channel-email"]').disabled).toBe(false);
  expect(screen.querySelector('[data-testid="register-channel-phone"]').disabled).toBe(true);
  expect(screen.querySelector('[data-testid="auth-primary-submit-button"]').disabled).toBe(false);
});
