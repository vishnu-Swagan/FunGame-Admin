import { act } from "react";
import { createRoot } from "react-dom/client";
import ChipsPage from "./ChipsPage";

const mockNavigate = jest.fn();
const mockApiGet = jest.fn();
const mockApiPost = jest.fn();

jest.mock("react-router-dom", () => ({
  useNavigate: () => mockNavigate,
  useLocation: () => ({ pathname: "/chips/request" }),
}), { virtual: true });

jest.mock("@/context/AuthContext", () => ({
  useAuth: () => ({ user: { id: "player-1", chip_balance: 250 }, refreshUser: jest.fn() }),
}));

jest.mock("@/lib/api", () => ({
  api: {
    get: (...args) => mockApiGet(...args),
    post: (...args) => mockApiPost(...args),
  },
  errMsg: (error) => error?.message || "Request failed",
}));

jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() } }));

jest.mock("@/components/common", () => ({
  PageTransition: ({ children, ...props }) => <div {...props}>{children}</div>,
  EmptyState: ({ title }) => <div>{title}</div>,
  Disclaimer: () => null,
  formatChips: (value) => String(value ?? 0),
}));

jest.mock("@/pages/app/wallet/WalletBits", () => ({
  WalletBalanceCard: () => <div data-testid="wallet-balance-card" />,
  PaymentRow: () => <div data-testid="payment-row" />,
}));

jest.mock("@/components/ui/tabs", () => ({
  Tabs: ({ children }) => <div>{children}</div>,
  TabsList: ({ children }) => <div>{children}</div>,
  TabsTrigger: ({ children, ...props }) => <button {...props}>{children}</button>,
  TabsContent: ({ children, value }) => value === "request" ? <div>{children}</div> : null,
}));

jest.mock("@/components/ui/button", () => ({ Button: ({ children, ...props }) => <button {...props}>{children}</button> }));
jest.mock("@/components/ui/input", () => ({ Input: (props) => <input {...props} /> }));
jest.mock("@/components/ui/textarea", () => ({ Textarea: (props) => <textarea {...props} /> }));

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

async function renderPage() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<ChipsPage />);
    await settle();
  });
  return { container, root };
}

function change(element, value) {
  act(() => {
    const prototype = element instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeAll(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mockNavigate.mockReset();
  mockApiGet.mockReset();
  mockApiPost.mockReset();
  mockApiGet.mockResolvedValue({ data: { requests: [{ id: "request-1", amount: 500, status: "PENDING" }] } });
  mockApiPost.mockResolvedValue({ data: { message: "Chip request submitted for review." } });
});

afterEach(() => {
  document.body.innerHTML = "";
  jest.clearAllMocks();
});

test("play chips always use an operator-reviewed request", async () => {
  const { container, root } = await renderPage();
  expect(container.querySelector('[data-testid="deposit-form"]')).toBeNull();
  expect(container.querySelector('[data-testid="manual-chip-request-form"]')).not.toBeNull();
  expect(mockApiGet).toHaveBeenCalledWith("/chips/requests");

  change(container.querySelector('[data-testid="manual-chip-request-amount"]'), "2500");
  change(container.querySelector('[data-testid="manual-chip-request-note"]'), "Investor demo account");
  await act(async () => {
    container.querySelector('[data-testid="manual-chip-request-form"]').dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
  });

  expect(mockApiPost).toHaveBeenCalledWith("/chips/request", {
    amount: 2500,
    note: "Investor demo account",
  });
  expect(mockApiGet).toHaveBeenCalledWith("/chips/requests");
  await act(async () => root.unmount());
});

test("no payment-provider UI is rendered", async () => {
  const { container, root } = await renderPage();
  expect(container.querySelector('[data-testid="deposit-form"]')).toBeNull();
  expect(container.querySelector('[data-testid="withdrawal-form"]')).toBeNull();
  expect(container.querySelector('[data-testid="manual-chip-request-form"]')).not.toBeNull();
  await act(async () => root.unmount());
});
