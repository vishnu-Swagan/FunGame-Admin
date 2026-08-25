import { act } from "react";
import { createRoot } from "react-dom/client";
import { api } from "@/lib/api";
import { adminPayments } from "@/lib/paymentApi";
import { AdminMonitoring, AdminPaymentGateways, AdminSecurityAudit } from "./AdminOperationsPages";

jest.mock("@/lib/api", () => ({ api: { get: jest.fn() } }));
jest.mock("@/lib/paymentApi", () => ({
  adminPayments: { settings: jest.fn(), audit: jest.fn() },
}));
jest.mock("@/components/common", () => ({
  PageTransition: ({ children, className }) => <div className={className}>{children}</div>,
}));

beforeAll(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
});

async function render(Component) {
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => {
    root.render(<Component />);
    await Promise.resolve();
  });
  return { container, root };
}

afterEach(() => {
  jest.clearAllMocks();
});

test("payment gateways reports the chips-only provider boundary", async () => {
  adminPayments.settings.mockResolvedValue({
    mode_version: 3,
    updated_at: "2026-08-25T08:00:00Z",
    financial: {
      ready: false,
      schema_version: 7,
      features: { real_money: false, deposits: false, withdrawals: false, automatic_withdrawals: false },
    },
  });
  const { container, root } = await render(AdminPaymentGateways);

  expect(container.textContent).toContain("Payment gateways");
  expect(container.textContent).toContain("Virtual chips");
  expect(container.textContent).toContain("Provider connection boundary");
  expect(container.textContent).toContain("Inactive");
  expect(adminPayments.settings).toHaveBeenCalledTimes(1);
  await act(async () => root.unmount());
});

test("system monitoring combines live health, platform, and TeleSign evidence", async () => {
  api.get.mockImplementation(async (path) => ({ data: ({
    "/health": { status: "ok", gameplay_ready: true, crm_ready: true },
    "/admin/stats": { total_users: 14, active_users: 12, enabled_games: 10, total_games: 22, pending_chip_requests: 2 },
    "/admin/system": { config: { maintenance_mode: false } },
    "/admin/telesign": { credentials_ready: true, products: { verify: { enabled: true } }, usage: { screened_players: 8, flagged_players: 1 } },
  })[path] }));
  const { container, root } = await render(AdminMonitoring);

  expect(container.textContent).toContain("System monitoring");
  expect(container.textContent).toContain("14");
  expect(container.textContent).toContain("10/22");
  expect(container.textContent).toContain("Trust provider status");
  expect(api.get).toHaveBeenCalledTimes(4);
  await act(async () => root.unmount());
});

test("security and audit renders protected server events", async () => {
  adminPayments.audit.mockResolvedValue([{
    id: "audit-1",
    action: "PAYMENT_GATEWAY_SETTINGS_CHANGED",
    actor_id: "admin-1",
    target_type: "PAYMENT_GATEWAY_SETTINGS",
    created_at: "2026-08-25T08:14:54.544Z",
  }]);
  const { container, root } = await render(AdminSecurityAudit);

  expect(container.textContent).toContain("Security and audit");
  expect(container.textContent).toContain("PAYMENT_GATEWAY_SETTINGS_CHANGED");
  expect(container.textContent).toContain("Role-based authorization");
  expect(adminPayments.audit).toHaveBeenCalledTimes(1);
  await act(async () => root.unmount());
});
