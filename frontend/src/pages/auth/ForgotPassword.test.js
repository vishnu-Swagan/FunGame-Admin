import { act } from "react";
import { createRoot } from "react-dom/client";
import ForgotPassword from "./ForgotPassword";

const mockNavigate = jest.fn();
const mockPost = jest.fn();

jest.mock("react-router-dom", () => ({
  useNavigate: () => mockNavigate,
  Link: ({ children, to, ...props }) => <a href={to} {...props}>{children}</a>,
}), { virtual: true });

jest.mock("@/lib/api", () => ({
  api: { post: (...args) => mockPost(...args) },
  errMsg: (error) => error?.message || "Request failed",
}));

jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

jest.mock("@/pages/auth/AuthShell", () => ({
  AuthShell: ({ children, title, subtitle }) => <main><h1>{title}</h1><p data-testid="auth-subtitle">{subtitle}</p>{children}</main>,
}));

jest.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }) => <button {...props}>{children}</button>,
}));

jest.mock("@/components/ui/input", () => ({ Input: (props) => <input {...props} /> }));
jest.mock("@/components/ui/label", () => ({ Label: ({ children, ...props }) => <label {...props}>{children}</label> }));

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

async function renderForgot() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<ForgotPassword />);
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
});

afterEach(() => {
  document.body.innerHTML = "";
  jest.clearAllMocks();
});

test("forgot password copy mentions SMS OTP on a verified mobile", async () => {
  const { container, root } = await renderForgot();
  expect(container.querySelector('[data-testid="auth-subtitle"]')?.textContent).toMatch(/verified mobile number \(SMS OTP\) or email/i);
  await act(async () => root.unmount());
});

test("a mobile number posts phone identity without an email field", async () => {
  mockPost.mockResolvedValue({ data: { message: "sent", delivery_available: true } });
  const { container, root } = await renderForgot();
  change(container.querySelector("#fp-identifier"), "+91 98765-43210");
  await submit(container.querySelector("form"));
  expect(mockPost).toHaveBeenCalledWith("/auth/forgot-password", {
    identifier: "+919876543210",
    phone: "+919876543210",
  });
  expect(mockPost.mock.calls[0][1]).not.toHaveProperty("email");
  await act(async () => root.unmount());
});

test("an email still posts identifier and email together", async () => {
  mockPost.mockResolvedValue({ data: { message: "sent", delivery_available: true } });
  const { container, root } = await renderForgot();
  change(container.querySelector("#fp-identifier"), "Player@Example.com");
  await submit(container.querySelector("form"));
  expect(mockPost).toHaveBeenCalledWith("/auth/forgot-password", {
    identifier: "player@example.com",
    email: "player@example.com",
  });
  expect(mockPost.mock.calls[0][1]).not.toHaveProperty("phone");
  await act(async () => root.unmount());
});

test("password reset reuses the same phone vs email split", async () => {
  mockPost
    .mockResolvedValueOnce({ data: { message: "sent", delivery_available: true } })
    .mockResolvedValueOnce({ data: { message: "reset" } });
  const { container, root } = await renderForgot();
  change(container.querySelector("#fp-identifier"), "+447700900123");
  await submit(container.querySelector("form"));
  change(container.querySelector("#fp-code"), "123456");
  change(container.querySelector("#fp-new"), "New-Password-9");
  await submit(container.querySelector("form"));
  expect(mockPost).toHaveBeenNthCalledWith(2, "/auth/reset-password", {
    identifier: "+447700900123",
    phone: "+447700900123",
    code: "123456",
    new_password: "New-Password-9",
  });
  expect(mockPost.mock.calls[1][1]).not.toHaveProperty("email");
  expect(mockNavigate).toHaveBeenCalledWith("/?auth=login");
  await act(async () => root.unmount());
});
