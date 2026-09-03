import { act } from "react";
import { createRoot } from "react-dom/client";
import AdminPlayHistory from "./AdminPlayHistory";

const mockChipTransactions = jest.fn();
let mockSearch = new URLSearchParams();

jest.mock("react-router-dom", () => ({
  useSearchParams: () => [mockSearch, jest.fn()],
}), { virtual: true });

jest.mock("@/lib/paymentApi", () => ({
  adminPayments: { chipTransactions: (...args) => mockChipTransactions(...args) },
}));

jest.mock("@/lib/api", () => ({
  errMsg: (error, fallback) => error?.message || fallback || "Request failed",
}));

jest.mock("sonner", () => ({ toast: { error: jest.fn() } }), { virtual: true });

jest.mock("lucide-react", () => ({ History: () => null, Search: () => null }), { virtual: true });

jest.mock("@/components/common", () => ({
  PageTransition: ({ children, ...props }) => <div {...props}>{children}</div>,
  EmptyState: ({ title }) => <div>{title}</div>,
  formatChips: (value) => String(value ?? 0),
}));

jest.mock("@/components/ui/button", () => ({ Button: ({ children, ...props }) => <button {...props}>{children}</button> }));
jest.mock("@/components/ui/input", () => ({ Input: (props) => <input {...props} /> }));

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeAll(() => { global.IS_REACT_ACT_ENVIRONMENT = true; });

beforeEach(() => {
  mockSearch = new URLSearchParams();
  mockChipTransactions.mockReset().mockResolvedValue([
    { id: "t1", user_id: "u1", user_name: "Asha", kind: "PAYOUT", amount: 80, balance_after: 180, game: "Roulette", created_at: "2026-09-03T04:00:00Z" },
    { id: "t2", user_id: "u1", user_name: "Asha", kind: "STAKE", amount: 50, balance_after: 100, game: "Roulette", created_at: "2026-09-03T03:59:00Z" },
    { id: "t3", user_id: "u1", user_name: "Asha", kind: "DEPOSIT", amount: 500, balance_after: 150, created_at: "2026-09-03T03:00:00Z" },
  ]);
});

afterEach(() => { document.body.innerHTML = ""; });

test("Admin play history lists won and lost chip rows and hides buys on the play tab", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<AdminPlayHistory />);
    await settle();
  });
  expect(container.querySelector('[data-testid="admin-play-history"]')).not.toBeNull();
  expect(mockChipTransactions).toHaveBeenCalled();
  const rows = container.querySelectorAll('[data-testid="admin-history-row"]');
  expect(rows).toHaveLength(2);
  expect(container.textContent).toContain("Won");
  expect(container.textContent).toContain("Lost");
  expect(container.textContent).toContain("Asha");
  expect(container.textContent).not.toContain("Buy");
  await act(async () => root.unmount());
});
