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

  expect(container.querySelector('label[for="reg-login-id"]')?.textContent).toBe("Choose Login ID");
  expect(container.querySelector("#reg-login-id")?.required).toBe(true);
  expect(container.querySelector("#reg-login-id")?.placeholder).toBe("Create your Login ID");
  expect(container.querySelector('label[for="reg-contact"]')?.textContent).toBe("Mobile number (enter with +country code)");
  expect(container.querySelector("#reg-contact")?.placeholder).toBe("Enter with +country code");
  expect(container.querySelector("#reg-country")?.value).toBe("");
  expect(container.querySelector("#reg-country option")?.textContent).toBe("Select your country");
  expect(container.querySelectorAll("#reg-country option").length).toBeGreaterThan(200);
  expect(container.querySelector("#reg-contact")?.outerHTML).not.toMatch(/\+91/);
  expect(container.textContent).not.toMatch(/GK Login ID/i);

  await act(async () => root.unmount());
});

test("manual-review registration submits both contacts and confirmed password without an OTP", async () => {
  mockPost.mockResolvedValue({ data: { review_required: true, verification_required: false } });
  const { container, root } = await renderRegister();

  change(container.querySelector("#reg-name"), "New Player");
  change(container.querySelector("#reg-login-id"), "Lucky.Player_7");
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
    username: "Lucky.Player_7",
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
  change(container.querySelector("#reg-login-id"), "Review_Player");
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
  change(container.querySelector("#reg-name"), "OTP Player");
  change(container.querySelector("#reg-login-id"), "OTP.Player");
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
  expect(mockPost.mock.calls[0][1].username).toBe("OTP.Player");
  expect(mockNavigate).toHaveBeenCalledWith("/verify", expect.objectContaining({
    state: expect.objectContaining({ channel: "PHONE", identifier: "+447700900123", loginId: "OTP.Player" }),
  }));
  await act(async () => root.unmount());
});

test("an interrupted dual-verification registration resumes on email with the chosen Login ID", async () => {
  mockCapabilities = {
    registration_enabled: true,
    email_registration: false,
    phone_registration: true,
    verification_required: true,
    email_verification_required: true,
    registration_mode: "PHONE_OTP",
  };
  mockPost.mockResolvedValue({ data: {
    channel: "EMAIL",
    challenge_id: "email-challenge-1",
    destination_masked: "r***@example.com",
    resend_after_seconds: 24,
  } });
  const { container, root } = await renderRegister();
  change(container.querySelector("#reg-name"), "Recovery Player");
  change(container.querySelector("#reg-login-id"), "Recovery.Player");
  change(container.querySelector("#reg-contact"), "+44 7700 900124");
  change(container.querySelector("#reg-email"), "Recovery@Example.com");
  change(container.querySelector("#reg-dob"), "1990-05-20");
  changeSelect(container.querySelector("#reg-country"), "GB");
  await act(async () => {
    container.querySelector('[data-testid="register-terms-checkbox"]').click();
    await settle();
  });
  await submit(container.querySelector("form"));

  expect(mockNavigate).toHaveBeenCalledWith("/verify", expect.objectContaining({
    state: expect.objectContaining({
      channel: "EMAIL",
      identifier: "recovery@example.com",
      challengeId: "email-challenge-1",
      loginId: "Recovery.Player",
    }),
  }));
  await act(async () => root.unmount());
});

test("a real submit-button click posts the live dual-verification payload", async () => {
  mockCapabilities = {
    registration_enabled: true,
    email_registration: false,
    phone_registration: true,
    verification_required: true,
    email_verification_required: true,
    registration_mode: "PHONE_OTP",
  };
  mockPost.mockResolvedValue({ data: { destination_masked: "+91******10", resend_after_seconds: 30 } });
  const { container, root } = await renderRegister();

  change(container.querySelector("#reg-name"), "Live Player");
  change(container.querySelector("#reg-login-id"), "Live.Player");
  change(container.querySelector("#reg-contact"), "+91 (98765).43210");
  change(container.querySelector("#reg-email"), "Live.Player@Example.com");
  change(container.querySelector("#reg-dob"), "1990-05-20");
  changeSelect(container.querySelector("#reg-country"), "IN");
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
    username: "Live.Player",
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
      loginId: "Live.Player",
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
    email_verification_required: true,
    registration_mode: "PHONE_OTP",
  };
  const { container, root } = await renderRegister();

  change(container.querySelector("#reg-name"), "Live Player");
  change(container.querySelector("#reg-login-id"), "Live.Player");
  change(container.querySelector("#reg-contact"), "+919876543210");
  change(container.querySelector("#reg-email"), "not-an-email");
  change(container.querySelector("#reg-dob"), "1990-05-20");
  changeSelect(container.querySelector("#reg-country"), "IN");
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
  change(container.querySelector("#reg-login-id"), "Terms.Player");
  change(container.querySelector("#reg-contact"), "+919876543210");
  change(container.querySelector("#reg-dob"), "1990-05-20");
  changeSelect(container.querySelector("#reg-country"), "IN");
  expect(container.querySelector('[data-testid="auth-primary-submit-button"]').disabled).toBe(false);
  await clickPrimarySubmit(container);

  const terms = container.querySelector('[data-testid="register-terms-checkbox"]');
  expect(mockPost).not.toHaveBeenCalled();
  expect(container.querySelector("#reg-terms-error")?.textContent).toBe("Please accept the account and play terms");
  expect(terms.getAttribute("aria-invalid")).toBe("true");
  expect(document.activeElement).toBe(terms);
  await act(async () => root.unmount());
});

test("an unsafe Login ID is rejected and focused before posting", async () => {
  const { container, root } = await renderRegister();
  change(container.querySelector("#reg-name"), "Login Player");
  change(container.querySelector("#reg-login-id"), "bad id!");
  await clickPrimarySubmit(container);

  expect(mockPost).not.toHaveBeenCalled();
  expect(container.querySelector("#reg-login-id-error")?.textContent).toMatch(/4–32 letters/);
  expect(document.activeElement).toBe(container.querySelector("#reg-login-id"));
  await act(async () => root.unmount());
});
