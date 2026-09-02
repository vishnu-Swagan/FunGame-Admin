import { act } from "react";
import { createRoot } from "react-dom/client";
import BankDetailsPage from "./BankDetailsPage";
import { payments } from "@/lib/paymentApi";

const mockNavigate = jest.fn();

jest.mock("react-router-dom", () => ({
  useNavigate: () => mockNavigate,
  useLocation: () => ({ state: { returnTo: "/chips/withdraw" } }),
}), { virtual: true });
jest.mock("@/lib/paymentApi", () => ({ payments: {
  wallet: jest.fn(),
  bankDetails: jest.fn(),
  saveBankDetail: jest.fn(),
  removeBankDetail: jest.fn(),
} }));
jest.mock("@/lib/api", () => ({ errMsg: (error) => error?.message || "Request failed" }));
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() } }), { virtual: true });
jest.mock("@/components/common", () => ({ PageTransition: ({ children }) => <div>{children}</div> }));
jest.mock("@/components/ui/button", () => ({ Button: ({ children, ...props }) => <button {...props}>{children}</button> }));
jest.mock("@/components/ui/input", () => ({ Input: (props) => <input {...props} /> }));
jest.mock("@/components/ui/label", () => ({ Label: ({ children, ...props }) => <label {...props}>{children}</label> }));
jest.mock("lucide-react", () => new Proxy({}, { get: () => () => null }), { virtual: true });

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeAll(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  jest.clearAllMocks();
  payments.wallet.mockResolvedValue({
    financial: {
      ready: false,
      features: { real_money: false, withdrawals: false },
      operator: { enabled: true, withdrawals_enabled: true },
    },
  });
  payments.bankDetails.mockResolvedValue([]);
  payments.saveBankDetail.mockResolvedValue({ id: "bank-1", bank_name: "HDFC Bank" });
});

afterEach(() => {
  document.body.innerHTML = "";
});

test("operator rail unlocks bank account entry while certified withdrawals stay closed", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<BankDetailsPage />);
    await settle();
  });

  const submit = container.querySelector('[data-testid="bank-details-form"] button[type="submit"]');
  expect(submit.disabled).toBe(false);
  expect(submit.textContent).toContain("Add bank account");
  expect(container.textContent).not.toContain("Bank details are temporarily unavailable");
  await act(async () => root.unmount());
});
