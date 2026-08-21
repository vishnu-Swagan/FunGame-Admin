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

test("manual-review registration submits both contacts and confirmed password without an OTP", async () => {
  mockPost.mockResolvedValue({ data: { review_required: true, verification_required: false } });
  const { container, root } = await renderRegister();

  change(container.querySelector("#reg-name"), "New Player");
  change(container.querySelector("#reg-contact"), "+91 98765-43210");
  change(container.querySelector("#reg-email"), "New.Player@Example.com");
  change(container.querySelector("#reg-dob"), "1990-05-20");
  change(container.querySelector("#reg-country"), "India");
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
    full_name: "New Player",
    date_of_birth: "1990-05-20",
    country: "India",
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
  change(container.querySelector("#reg-country"), "India");
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
  mockPost.mockResolvedValue({ data: { destination_masked: "+91******77", resend_after_seconds: 30 } });
  const { container, root } = await renderRegister();
  change(container.querySelector("#reg-name"), "OTP Player");
  change(container.querySelector("#reg-contact"), "+919999888877");
  change(container.querySelector("#reg-email"), "Optional@Example.com");
  change(container.querySelector("#reg-dob"), "1990-05-20");
  change(container.querySelector("#reg-country"), "India");
  await act(async () => {
    container.querySelector('[data-testid="register-terms-checkbox"]').click();
    await settle();
  });
  await submit(container.querySelector("form"));

  expect(mockPost.mock.calls[0][1]).not.toHaveProperty("password");
  expect(mockNavigate).toHaveBeenCalledWith("/verify", expect.objectContaining({
    state: expect.objectContaining({ channel: "PHONE", identifier: "+919999888877" }),
  }));
  await act(async () => root.unmount());
});
