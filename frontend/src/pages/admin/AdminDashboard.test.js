import { act } from "react";
import { createRoot } from "react-dom/client";
import AdminDashboard from "./AdminDashboard";
import { api } from "@/lib/api";

jest.mock("@/lib/api", () => ({ api: { get: jest.fn() } }));
jest.mock("react-router-dom", () => ({ useNavigate: () => jest.fn() }), { virtual: true });

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function renderDashboard() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<AdminDashboard />);
    await settle();
  });
  return { container, root };
}

const BASE = {
  metrics: [
    { label: "Registered players", value: 0, note: "Platform database", to: "/Admin/users" },
    { label: "Active players", value: 0, note: "Approved accounts", to: "/Admin/users?status=ACTIVE" },
  ],
  players: { total: 0, active: 0, pending: 0, suspended: 0 },
  cash_movement: { deposits: { amount_paise: 0, count: 0 }, withdrawals: { amount_paise: 0, count: 0 }, net_paise: 0, recent: [] },
  action_queue: [],
  distributors: { count: 0, top: [] },
  recent_transactions: [],
  audit_activity: [],
  maintenance_mode: false,
};

beforeAll(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => { jest.clearAllMocks(); });
afterEach(() => { document.body.innerHTML = ""; });

test("renders empty states when the dashboard service has no data", async () => {
  api.get.mockResolvedValue({ data: { ...BASE } });
  const { container, root } = await renderDashboard();

  expect(container.textContent).toContain("Operations overview");
  expect(container.textContent).toContain("Financial movement, player activity, and queues requiring attention");
  expect(container.querySelector('[data-testid="action-queue-empty"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="cash-movement-empty"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="recent-transactions-empty"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="distributor-performance-empty"]')).not.toBeNull();
  await act(async () => root.unmount());
});

test("composes cash movement, queue, distributors, transactions and audit when populated", async () => {
  api.get.mockResolvedValue({ data: {
    ...BASE,
    metrics: [{ label: "Active players", value: 12, note: "Approved accounts", to: "/Admin/users" }],
    players: { total: 20, active: 12, pending: 3, suspended: 1 },
    cash_movement: {
      deposits: { amount_paise: 500000, count: 4 },
      withdrawals: { amount_paise: 100000, count: 1 },
      net_paise: 400000,
      recent: [{ id: "upi-1", direction: "DEPOSIT", status: "CREDITED", amount_paise: 10000, source: "sgpay24", reference: "624493615902", occurred_at: "2026-08-03T12:30:00+00:00" }],
    },
    action_queue: [
      { key: "player_approvals", label: "Player approvals", count: 3, oldest: "2026-08-01T00:00:00+00:00", severity: "critical", to: "/Admin/users?status=PENDING" },
    ],
    distributors: { count: 1, top: [{ distributor_id: "d1", name: "North Hub", commission_chips: 250, ngr_chips: 4000, turnover_chips: 12000 }] },
    recent_transactions: [{ id: "t1", type: "CREDIT", kind: "ADJUST", amount: 1000, note: "Welcome play chips", created_at: "2026-08-03T00:00:00+00:00" }],
    audit_activity: [{ id: "a1", event_type: "WITHDRAWAL_MODE_CHANGED", target_type: "SETTINGS", actor: "admin", created_at: "2026-08-04T00:00:00+00:00" }],
  } });
  const { container, root } = await renderDashboard();

  expect(container.querySelector('[data-testid="cash-movement"]')?.textContent).toContain("₹5,000");
  expect(container.querySelector('[data-testid="cash-movement-transactions"]')?.textContent).toContain("Deposit credited");
  expect(container.querySelector('[data-testid="cash-movement-transactions"]')?.textContent).toContain("+₹100");
  expect(container.querySelector('[data-testid="cash-movement-transactions"]')?.textContent).toContain("624493615902");
  expect(container.querySelector('[data-testid="action-queue"]')?.textContent).toContain("Player approvals");
  expect(container.querySelector('[data-testid="distributor-performance"]')?.textContent).toContain("North Hub");
  expect(container.querySelector('[data-testid="recent-transactions"]')?.textContent).toContain("Welcome play chips");
  expect(container.querySelector('[data-testid="audit-activity"]')?.textContent).toContain("WITHDRAWAL_MODE_CHANGED");
  await act(async () => root.unmount());
});
