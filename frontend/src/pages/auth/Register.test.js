import { act } from "react";
import { createRoot } from "react-dom/client";
import Register from "./Register";

const mockNavigate = jest.fn();
const mockPost = jest.fn();
let mockCapabilities;

jest.mock("react-router-dom", () => ({
  useNavigate: () => mockNavigate,
  Link: ({ children, to, ...props }) => <a href={to} {...props}>{children}</a>,
}), { virtual: true });

jest.mock("@/lib/authCapabilities", () => ({
  ...jest.requireActual("@/lib/authCapabilities"),
  useAuthCapabilities: () => ({
    loading: false,
    capabilities: mockCapabilities,
  }),
}));

jest.mock("@/lib/api", () => ({
  api: { post: (...args) => mockPost(...args) },
  errMsg: (error) => error?.message || "Request failed",
}));

jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

jest.mock("@/pages/auth/AuthShell", () => ({
  AuthShell: ({ children, title, subtitle }) => <main><h1>{title}</h1><p>{subtitle}</p>{children}</main>,
}));

jest.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }) => <button {...props}>{children}</button>,
}));

jest.mock("@/components/ui/input", () => ({ Input: (props) => <input {...props} /> }));
jest.mock("@/components/ui/label", () => ({ Label: ({ children, ...props }) => <label {...props}>{children}</label> }));
jest.mock("@/components/ui/checkbox", () => ({
  Checkbox: ({ checked, onCheckedChange, ...props }) => (
    <button type="button" role="checkbox" aria-checked={checked} onClick={() => onCheckedChange(!checked)} {...props} />
  ),
}));

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

function change(input, value) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function changeSelect(select, value) {
  act(() => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function renderRegister() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<Register />);
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

async function clickPrimarySubmit(container) {
  await act(async () => {
    container.querySelector('[data-testid="auth-primary-submit-button"]').click();
    await settle();
  });
}

beforeAll(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mockNavigate.mockReset();
  mockPost.mockReset();
  mockCapabilities = {
    registration_enabled: true,
    email_registration: true,
    phone_registration: true,
    verification_required: false,
    manual_admin_review: true,
    registration_mode: "ADMIN_REVIEW",
  };
});

afterEach(() => {
  document.body.innerHTML = "";
  jest.clearAllMocks();
});

test("registration uses globally neutral phone and country guidance", async () => {
  const { container, root } = await renderRegister();

  expect(container.querySelector("#reg-login-id")).toBeNull();
  expect(container.querySelector('[data-testid="register-login-id-input"]')).toBeNull();
  expect(container.querySelector('label[for="reg-contact"]')?.textContent).toBe("Mobile number (enter with +country code)");
  expect(container.querySelector("#reg-contact")?.placeholder).toBe("Enter with +country code");
  expect(container.querySelector("#reg-country")?.value).toBe("IN");
  expect(container.querySelector("#reg-country option")?.textContent).toBe("Select your country");
  expect(container.querySelectorAll("#reg-country option").length).toBeGreaterThan(200);
  expect(container.querySelector("#reg-contact")?.outerHTML).not.toMatch(/\+91/);
  expect(container.textContent).not.toMatch(/GK Login ID/i);
  expect(container.textContent).not.toMatch(/Choose Login ID/i);

  await act(async () => root.unmount());
});

test("manual-review registration submits both contacts and confirmed password without an OTP", async () => {
  mockPost.mockResolvedValue({ data: { review_required: true, verification_required: false } });
  const { container, root } = await renderRegister();

  change(container.querySelector("#reg-name"), "New Player");
  change(container.querySelector("#reg-contact"), "+91 98765-43210");
  change(container.querySelector("#reg-email"), "New.Player@Example.com");
  change(container.querySelector("#reg-dob"), "1990-05-20");
  changeSelect(container.querySelector("#reg-country"), "IN");
  change(container.querySelector("#reg-password"), "Strong-Password-9");
  change(container.querySelector("#reg-password-confirmation"), "Strong-Password-9");
  await act(async () => {
    container.querySelector('[data-testid="register-terms-checkbox"]').click();
    await settle();
  });
  await submit(container.querySelector("form"));

  expect(mockPost).toHaveBeenCalledWith("/auth/register", expect.objectContaining({
    channel: "PHONE",
    identifier: "+919876543210",
    phone: "+919876543210",
    email: "new.player@example.com",
    username: "p919876543210",
    full_name: "New Player",
    date_of_birth: "1990-05-20",
    country: "IN",
    accepted_terms: true,
    password: "Strong-Password-9",
    password_confirmation: "Strong-Password-9",
  }));
  expect(mockNavigate).toHaveBeenCalledWith("/login", {
    state: { registrationSubmitted: true },
  });
  await act(async () => root.unmount());
});

test("mismatched passwords are rejected before the registration API call", async () => {
  const { container, root } = await renderRegister();
  change(container.querySelector("#reg-name"), "Review Player");
  change(container.querySelector("#reg-contact"), "+919999888877");
  change(container.querySelector("#reg-email"), "review@example.com");
  change(container.querySelector("#reg-dob"), "1990-05-20");
  changeSelect(container.querySelector("#reg-country"), "IN");
  change(container.querySelector("#reg-password"), "Strong-Password-9");
  change(container.querySelector("#reg-password-confirmation"), "Different-Password-9");
  await act(async () => {
    container.querySelector('[data-testid="register-terms-checkbox"]').click();
    await settle();
  });
  await submit(container.querySelector("form"));

  expect(mockPost).not.toHaveBeenCalled();
  expect(mockNavigate).not.toHaveBeenCalled();
  await act(async () => root.unmount());
});

test("the retained phone-OTP mode still sends no pre-verification password", async () => {
  mockCapabilities = {
    registration_enabled: true,
    email_registration: false,
    phone_registration: true,
    verification_required: true,
    registration_mode: "PHONE_OTP",
  };
  mockPost.mockResolvedValue({ data: { destination_masked: "+44******23", resend_after_seconds: 30 } });
  const { container, root } = await renderRegister();
  expect(container.querySelector('[data-testid="register-verification-copy"]')?.textContent).toMatch(/one SMS code/i);
  expect(container.textContent).toMatch(/Virtual chips have no cash value/);
  expect(container.textContent).not.toMatch(/email code/i);
  change(container.querySelector("#reg-name"), "OTP Player");
  change(container.querySelector("#reg-contact"), "+44 7700 900123");
  change(container.querySelector("#reg-email"), "Optional@Example.com");
  change(container.querySelector("#reg-dob"), "1990-05-20");
  changeSelect(container.querySelector("#reg-country"), "GB");
  await act(async () => {
    container.querySelector('[data-testid="register-terms-checkbox"]').click();
    await settle();
  });
  await submit(container.querySelector("form"));

  expect(mockPost.mock.calls[0][1]).not.toHaveProperty("password");
  expect(mockPost.mock.calls[0][1].username).toBe("p447700900123");
  expect(mockNavigate).toHaveBeenCalledWith("/verify", expect.objectContaining({
    state: expect.objectContaining({
      channel: "PHONE",
      identifier: "+447700900123",
      loginId: "p447700900123",
      loginIdAutoGenerated: true,
    }),
  }));
  await act(async () => root.unmount());
});

test("a real submit-button click posts the phone-OTP payload with a generated Login ID", async () => {
  mockCapabilities = {
    registration_enabled: true,
    email_registration: false,
    phone_registration: true,
    verification_required: true,
    email_verification_required: false,
    registration_mode: "PHONE_OTP",
  };
  mockPost.mockResolvedValue({ data: { destination_masked: "+91******10", resend_after_seconds: 30 } });
  const { container, root } = await renderRegister();

  change(container.querySelector("#reg-name"), "Live Player");
  change(container.querySelector("#reg-contact"), "+91 (98765).43210");
  change(container.querySelector("#reg-email"), "Live.Player@Example.com");
  change(container.querySelector("#reg-dob"), "1990-05-20");
  expect(container.querySelector("#reg-country")?.value).toBe("IN");
  await act(async () => {
    container.querySelector('[data-testid="register-terms-checkbox"]').click();
    await settle();
  });
  await clickPrimarySubmit(container);

  expect(mockPost).toHaveBeenCalledTimes(1);
  expect(mockPost).toHaveBeenCalledWith("/auth/register", {
    channel: "PHONE",
    identifier: "+919876543210",
    phone: "+919876543210",
    email: "live.player@example.com",
    username: "p919876543210",
    full_name: "Live Player",
    date_of_birth: "1990-05-20",
    country: "IN",
    accepted_terms: true,
  });
  expect(mockNavigate).toHaveBeenCalledWith("/verify", expect.objectContaining({
    state: expect.objectContaining({
      channel: "PHONE",
      identifier: "+919876543210",
      secondaryIdentifier: "live.player@example.com",
      loginId: "p919876543210",
      loginIdAutoGenerated: true,
    }),
  }));
  await act(async () => root.unmount());
});

test("an invalid required email is explained inline and focused without posting", async () => {
  mockCapabilities = {
    registration_enabled: true,
    email_registration: false,
    phone_registration: true,
    verification_required: true,
    email_verification_required: false,
    registration_mode: "PHONE_OTP",
  };
  const { container, root } = await renderRegister();

  change(container.querySelector("#reg-name"), "Live Player");
  change(container.querySelector("#reg-contact"), "+919876543210");
  change(container.querySelector("#reg-email"), "not-an-email");
  change(container.querySelector("#reg-dob"), "1990-05-20");
  await act(async () => {
    container.querySelector('[data-testid="register-terms-checkbox"]').click();
    await settle();
  });
  await clickPrimarySubmit(container);

  expect(mockPost).not.toHaveBeenCalled();
  expect(container.querySelector("#reg-email-error")?.textContent).toBe("Enter a valid email address");
  expect(container.querySelector("#reg-email").getAttribute("aria-invalid")).toBe("true");
  expect(document.activeElement).toBe(container.querySelector("#reg-email"));
  await act(async () => root.unmount());
});

test("unchecked terms remain actionable and receive accessible feedback", async () => {
  mockCapabilities = {
    registration_enabled: true,
    email_registration: false,
    phone_registration: true,
    verification_required: true,
    registration_mode: "PHONE_OTP",
  };
  const { container, root } = await renderRegister();

  change(container.querySelector("#reg-name"), "Terms Player");
  change(container.querySelector("#reg-contact"), "+919876543210");
  change(container.querySelector("#reg-email"), "terms@example.com");
  change(container.querySelector("#reg-dob"), "1990-05-20");
  expect(container.querySelector('[data-testid="auth-primary-submit-button"]').disabled).toBe(false);
  await clickPrimarySubmit(container);

  const terms = container.querySelector('[data-testid="register-terms-checkbox"]');
  expect(mockPost).not.toHaveBeenCalled();
  expect(container.querySelector("#reg-terms-error")?.textContent).toBe("Please accept the account and play terms");
  expect(terms.getAttribute("aria-invalid")).toBe("true");
  expect(document.activeElement).toBe(terms);
  await act(async () => root.unmount());
});
