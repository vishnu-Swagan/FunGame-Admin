import { act } from "react";
import { createRoot } from "react-dom/client";
import { toast } from "sonner";

import { api } from "@/lib/api";
import AdminUsers from "./AdminUsers";

const mockSetSearchParams = jest.fn();

jest.mock("react-router-dom", () => ({
  useSearchParams: () => [new URLSearchParams("status=ACTIVE"), mockSetSearchParams],
}), { virtual: true });
jest.mock("sonner", () => ({ toast: { error: jest.fn(), success: jest.fn() } }));
jest.mock("@/lib/api", () => ({
  api: { get: jest.fn(), post: jest.fn(), delete: jest.fn() },
  errMsg: (error) => error?.response?.data?.detail?.message || error?.message || "Request failed",
}));
jest.mock("@/components/common", () => ({
  PageTransition: ({ children, ...props }) => <div {...props}>{children}</div>,
  UserStatusBadge: ({ status }) => <span>{status}</span>,
  EmptyState: ({ title }) => <div>{title}</div>,
  formatChips: (value) => String(value || 0),
  timeAgo: () => "today",
  AvatarBadge: () => <span>avatar</span>,
}));

const PLAYER = {
  id: "operator-player-1",
  role: "PLAYER",
  status: "ACTIVE",
  display_name: "Demo Operator Player",
  username: "GK1234567",
  email: "demo@chakri.casino",
  chip_balance: 1000,
  stats: { winning_chips: 0, loss_chips: 0 },
};

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function renderPage() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<AdminUsers />);
    await settle();
  });
  return { container, root };
}

function setInput(input, value) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeAll(() => { global.IS_REACT_ACT_ENVIRONMENT = true; });
beforeEach(() => {
  jest.clearAllMocks();
  api.get.mockResolvedValue({ data: { users: [PLAYER] } });
});
afterEach(() => { document.body.innerHTML = ""; });

test("requires typed confirmation and permanently deletes the selected player", async () => {
  api.delete.mockResolvedValue({ data: { message: "Player account deleted permanently." } });
  const { container, root } = await renderPage();

  await act(async () => {
    container.querySelector('[data-testid="admin-delete-user-button"]')
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle();
  });

  expect(document.body.textContent).toContain("Delete player account permanently?");
  expect(document.body.textContent).toContain("Demo Operator Player");
  const confirmButton = document.body.querySelector('[data-testid="admin-delete-user-confirm-button"]');
  expect(confirmButton.disabled).toBe(true);

  await act(async () => {
    setInput(document.body.querySelector('[data-testid="admin-delete-user-confirmation-input"]'), "DELETE");
    await settle();
  });
  expect(confirmButton.disabled).toBe(false);

  await act(async () => {
    confirmButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle();
  });

  expect(api.delete).toHaveBeenCalledWith("/admin/users/operator-player-1");
  expect(toast.success).toHaveBeenCalledWith("Player account deleted permanently.");
  expect(api.get).toHaveBeenCalledTimes(2);
  await act(async () => root.unmount());
});

test("keeps the confirmation open when the backend blocks financial history", async () => {
  api.delete.mockRejectedValue({
    response: { data: { detail: { message: "This player has deposit payment history." } } },
  });
  const { container, root } = await renderPage();
  await act(async () => {
    container.querySelector('[data-testid="admin-delete-user-button"]')
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle();
    setInput(document.body.querySelector('[data-testid="admin-delete-user-confirmation-input"]'), "DELETE");
    await settle();
    document.body.querySelector('[data-testid="admin-delete-user-confirm-button"]')
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle();
  });

  expect(toast.error).toHaveBeenCalledWith("This player has deposit payment history.");
  expect(document.body.textContent).toContain("Delete player account permanently?");
  expect(api.get).toHaveBeenCalledTimes(1);
  await act(async () => root.unmount());
});
