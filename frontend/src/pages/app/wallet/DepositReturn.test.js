import { act } from "react";
import { createRoot } from "react-dom/client";
import DepositReturn, { DEPOSIT_REFRESH_INTERVAL_MS } from "./DepositReturn";

const mockNavigate = jest.fn();
const mockRefreshUser = jest.fn();
const mockRefreshDeposit = jest.fn();
const mockSubmitDepositUtr = jest.fn();
let mockDepositId = "deposit-1";

jest.mock("react-router-dom", () => ({
  useNavigate: () => mockNavigate,
  useParams: () => ({ depositId: mockDepositId }),
  useSearchParams: () => [new URLSearchParams()],
}), { virtual: true });

jest.mock("@/context/AuthContext", () => ({
  useAuth: () => ({ refreshUser: mockRefreshUser }),
}));

jest.mock("@/lib/paymentApi", () => ({ payments: {
  refreshDeposit: (...args) => mockRefreshDeposit(...args),
  submitDepositUtr: (...args) => mockSubmitDepositUtr(...args),
} }));

jest.mock("lucide-react", () => new Proxy({}, { get: () => () => null }), { virtual: true });
jest.mock("@/components/common", () => ({ PageTransition: ({ children, ...props }) => <div {...props}>{children}</div> }));
jest.mock("@/components/ui/button", () => ({ Button: ({ children, ...props }) => <button {...props}>{children}</button> }));
jest.mock("@/components/ui/input", () => ({ Input: (props) => <input {...props} /> }));
jest.mock("@/pages/app/wallet/WalletBits", () => ({ PaymentStatus: ({ status }) => <span>{status}</span> }));
jest.mock("@/lib/api", () => ({ errMsg: (error, fallback) => error?.message || fallback }));

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
    root.render(<DepositReturn />);
    await settle();
  });
  return { container, root };
}

beforeAll(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  jest.useFakeTimers();
  mockDepositId = "deposit-1";
  mockNavigate.mockReset();
  mockRefreshUser.mockReset().mockResolvedValue(undefined);
  mockRefreshDeposit.mockReset();
  mockSubmitDepositUtr.mockReset();
});

afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
  document.body.innerHTML = "";
});

test("refreshes UPI status immediately and about every seven seconds until credited", async () => {
  mockRefreshDeposit
    .mockResolvedValueOnce({ id: "deposit-1", status: "PENDING", source: "SGPAY24_UPI" })
    .mockResolvedValueOnce({ id: "deposit-1", status: "CREDITED", source: "SGPAY24_UPI" });
  const { container, root } = await renderPage();

  expect(mockRefreshDeposit).toHaveBeenCalledTimes(1);
  expect(mockRefreshDeposit).toHaveBeenLastCalledWith("deposit-1");
  expect(container.textContent).toContain("UPI payment being verified");

  await act(async () => {
    jest.advanceTimersByTime(DEPOSIT_REFRESH_INTERVAL_MS);
    await settle();
  });

  expect(mockRefreshDeposit).toHaveBeenCalledTimes(2);
  expect(mockRefreshUser).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain("Chips credited");
  expect(container.textContent).toContain("verified by our server");

  await act(async () => {
    jest.advanceTimersByTime(DEPOSIT_REFRESH_INTERVAL_MS * 2);
    await settle();
  });
  expect(mockRefreshDeposit).toHaveBeenCalledTimes(2);
  await act(async () => root.unmount());
});

test("shows terminal failed UPI copy and stops polling", async () => {
  mockRefreshDeposit.mockResolvedValue({ id: "deposit-1", status: "FAILED", source: "SGPAY24_UPI" });
  const { container, root } = await renderPage();

  expect(container.textContent).toContain("UPI payment failed");
  expect(container.textContent).toContain("No chips were credited");
  await act(async () => {
    jest.advanceTimersByTime(DEPOSIT_REFRESH_INTERVAL_MS * 2);
    await settle();
  });
  expect(mockRefreshDeposit).toHaveBeenCalledTimes(1);
  await act(async () => root.unmount());
});

test("submits a normalized UTR claim for authenticated SgPay verification", async () => {
  mockRefreshDeposit.mockResolvedValue({ id: "deposit-1", status: "PENDING", source: "SGPAY24_UPI" });
  mockSubmitDepositUtr.mockResolvedValue({ id: "deposit-1", status: "PENDING", source: "SGPAY24_UPI" });
  const { container, root } = await renderPage();
  const input = container.querySelector('[data-testid="deposit-utr"]');

  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, " UTR-123456 ");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    container.querySelector('[data-testid="deposit-utr-form"]').dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
  });

  expect(mockSubmitDepositUtr).toHaveBeenCalledWith("deposit-1", "UTR-123456");
  expect(container.textContent).toContain("matching it with SgPay");
  expect(container.textContent).toContain("never credits chips by itself");
  await act(async () => root.unmount());
});
