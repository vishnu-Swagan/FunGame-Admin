import { act } from "react";
import { createRoot } from "react-dom/client";
import { AdminDeposits, AdminWithdrawals } from "./AdminPaymentPages";
import { adminPayments } from "@/lib/paymentApi";

let mockUser;

jest.mock("@/lib/paymentApi", () => ({ adminPayments: {
  deposits: jest.fn(),
  withdrawals: jest.fn(),
  resolveOperatorRequest: jest.fn(),
  withdrawalAction: jest.fn(),
} }));
jest.mock("@/components/common", () => ({
  PageTransition: ({ children }) => <div>{children}</div>,
  EmptyState: ({ title }) => <div>{title}</div>,
  formatChips: (value) => String(value ?? 0),
}));
jest.mock("@/context/AuthContext", () => ({ useAuth: () => ({ user: mockUser }) }));
jest.mock("@/components/RouteGuards", () => ({
  ADMIN_PERMISSIONS: {
    PAYMENTS_VIEW: "PAYMENTS_VIEW",
    WITHDRAWALS_APPROVE: "WITHDRAWALS_APPROVE",
    WITHDRAWALS_MARK_PAID: "WITHDRAWALS_MARK_PAID",
  },
  hasPermission: () => true,
}));
jest.mock("react-router-dom", () => ({
  useSearchParams: () => [new URLSearchParams(), jest.fn()],
}), { virtual: true });
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }), { virtual: true });
jest.mock("@/components/ui/button", () => ({ Button: ({ children, ...props }) => <button {...props}>{children}</button> }));
jest.mock("@/components/ui/input", () => ({ Input: (props) => <input {...props} /> }));
jest.mock("@/components/ui/select", () => ({
  Select: ({ children }) => <div>{children}</div>,
  SelectTrigger: ({ children }) => <div>{children}</div>,
  SelectValue: () => null,
  SelectContent: ({ children }) => <div>{children}</div>,
  SelectItem: ({ children }) => <div>{children}</div>,
}));
jest.mock("@/pages/app/wallet/WalletBits", () => ({
  PaymentStatus: ({ status }) => <span>{status}</span>,
}));
jest.mock("lucide-react", () => new Proxy({}, { get: () => () => null }), { virtual: true });

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

beforeAll(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  jest.clearAllMocks();
  mockUser = { role: "ADMIN", status: "ACTIVE", admin_permissions: [] };
  adminPayments.deposits.mockResolvedValue([{
    id: "op-dep-1",
    user_email: "player@example.test",
    amount_paise: 100000,
    chips: 1000,
    status: "PENDING",
    source: "ADMIN_REVIEW",
    created_at: "2026-09-01T02:00:00Z",
  }]);
  adminPayments.withdrawals.mockResolvedValue([{
    id: "op-wd-1",
    user_email: "player@example.test",
    amount_chips: 1000,
    amount_paise: 100000,
    status: "PENDING",
    internal_status: "PENDING",
    source: "ADMIN_REVIEW",
    bank_detail: { bank_name: "Operator Bank", account_number_masked: "••••1234" },
    created_at: "2026-09-01T02:05:00Z",
  }]);
  adminPayments.resolveOperatorRequest.mockResolvedValue({ request: { status: "APPROVED" } });
});

afterEach(() => {
  document.body.innerHTML = "";
});

test("admin deposits can approve operator buy requests", async () => {
  const { container, root } = await render(AdminDeposits);
  expect(container.querySelector('[data-testid="operator-deposit-op-dep-1"]')).not.toBeNull();
  expect(container.textContent).toContain("Admin review");
  await act(async () => {
    container.querySelector('[data-testid="approve-deposit-op-dep-1"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle();
  });
  expect(adminPayments.resolveOperatorRequest).toHaveBeenCalledWith("op-dep-1", "approve", { note: null });
  await act(async () => root.unmount());
});

test("admin withdrawals can approve operator payout requests", async () => {
  const { container, root } = await render(AdminWithdrawals);
  expect(container.querySelector('[data-testid="operator-withdrawal-op-wd-1"]')).not.toBeNull();
  const approve = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Approve");
  expect(approve).toBeTruthy();
  await act(async () => {
    approve.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle();
  });
  expect(adminPayments.resolveOperatorRequest).toHaveBeenCalledWith("op-wd-1", "approve", { note: null });
  expect(adminPayments.withdrawalAction).not.toHaveBeenCalled();
  await act(async () => root.unmount());
});
