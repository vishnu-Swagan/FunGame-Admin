import { act } from "react";
import { createRoot } from "react-dom/client";
import AdminPaymentGateways from "./AdminPaymentGateways";
import { adminPayments } from "@/lib/paymentApi";

let mockUser;

jest.mock("@/lib/paymentApi", () => ({ adminPayments: {
  hubStatus: jest.fn(), gateways: jest.fn(), paymentGatewaySettings: jest.fn(),
  localAgents: jest.fn(), updateGateway: jest.fn(), testGateway: jest.fn(),
  createGateway: jest.fn(), writeGatewayCredentials: jest.fn(),
  createLocalAgent: jest.fn(), deleteLocalAgent: jest.fn(),
  savePaymentGatewaySettings: jest.fn(),
} }));
jest.mock("@/components/common", () => ({ PageTransition: ({ children, ...props }) => <div {...props}>{children}</div> }));
jest.mock("@/context/AuthContext", () => ({ useAuth: () => ({ user: mockUser }) }));

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
    root.render(<AdminPaymentGateways />);
    await settle();
  });
  return { container, root };
}

const DEFAULT_SETTINGS = {
  return_pages: { success_path: "/deposit/success", failure_path: "/deposit/failure" },
  deposits_enabled: false, withdrawals_enabled: false,
  deposit_auto_approve: false, withdrawal_auto_approve: false,
  wallet_to_wallet_enabled: false,
};

beforeAll(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  global.ResizeObserver = class ResizeObserver { observe() {} unobserve() {} disconnect() {} };
});

beforeEach(() => {
  jest.clearAllMocks();
  mockUser = { role: "ADMIN", status: "ACTIVE", admin_role: "SUPER_ADMIN", admin_permissions: [] };
  adminPayments.gateways.mockResolvedValue([]);
  adminPayments.paymentGatewaySettings.mockResolvedValue({ ...DEFAULT_SETTINGS });
  adminPayments.localAgents.mockResolvedValue([]);
});

afterEach(() => { document.body.innerHTML = ""; });

test("renders category tabs and empty states while admin API is enabled", async () => {
  adminPayments.hubStatus.mockResolvedValue({ admin: true, payments_v2: false });
  const { container, root } = await renderPage();

  expect(container.textContent).toContain("Payment gateways");
  expect(container.querySelector('[data-testid="payment-gateways-boundary"]')?.textContent).toContain("Configuration surface only");
  for (const key of ["CARD", "CRYPTO", "EWALLET", "BANK"]) {
    expect(container.querySelector(`[data-testid="category-tab-${key}"]`)).not.toBeNull();
  }
  expect(container.querySelector('[data-testid="gateways-empty"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="local-agents-empty"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="platform-settings-form"]')).not.toBeNull();
  await act(async () => root.unmount());
});

test("shows the admin-disabled notice when the gateway admin API is off", async () => {
  adminPayments.hubStatus.mockResolvedValue({ admin: false, payments_v2: false });
  const { container, root } = await renderPage();
  expect(container.querySelector('[data-testid="payment-admin-disabled"]')?.textContent)
    .toContain("PAYMENT_GATEWAY_ADMIN_ENABLED must be on");
  expect(adminPayments.gateways).not.toHaveBeenCalled();
  await act(async () => root.unmount());
});

test("renders a configured automated provider with copyable webhook and origin URLs", async () => {
  adminPayments.hubStatus.mockResolvedValue({ admin: true, payments_v2: false });
  adminPayments.gateways.mockResolvedValue([{
    id: "g1", code: "AUTO_CARD", display_name: "Automated Card", category: "CARD",
    provider_type: "AUTOMATED", mode: "SANDBOX", configured: true, connection_tested: true,
    deposits_enabled: true, withdrawals_enabled: false,
    auto_approve_deposits: false, auto_approve_withdrawals: false,
    webhook_url: "https://api.chakri.casino/api/webhooks/payments/AUTO_CARD",
    origin_verification_url: "https://api.chakri.casino/api/webhooks/payments/AUTO_CARD/origin",
    credential_hints: {},
  }]);
  const { container, root } = await renderPage();

  const card = container.querySelector('[data-testid="gateway-card-AUTO_CARD"]');
  expect(card).not.toBeNull();
  expect(card.textContent).toContain("Automated");
  expect(card.textContent).toContain("Configured");
  expect(container.querySelector('[data-testid="category-tab-CARD"]').textContent).toContain("1");
  expect(container.querySelector('[data-testid="gateway-webhook-url-AUTO_CARD"]').textContent)
    .toContain("https://api.chakri.casino/api/webhooks/payments/AUTO_CARD");
  expect(container.querySelector('[data-testid="gateway-origin-url-AUTO_CARD"]').textContent)
    .toContain("/api/webhooks/payments/AUTO_CARD/origin");
  // Auto-approve deposits is available (automated + tested + deposits enabled).
  expect(container.querySelector('[data-testid="auto-deposits-AUTO_CARD"]').getAttribute("disabled")).toBeNull();
  // Auto-approve withdrawals is blocked (withdrawals disabled).
  expect(container.querySelector('[data-testid="auto-withdrawals-AUTO_CARD"]').getAttribute("disabled")).not.toBeNull();
  await act(async () => root.unmount());
});

test("toggling enable deposits patches the gateway", async () => {
  adminPayments.hubStatus.mockResolvedValue({ admin: true, payments_v2: false });
  adminPayments.gateways.mockResolvedValue([{
    id: "g1", code: "AUTO_CARD", display_name: "Automated Card", category: "CARD",
    provider_type: "AUTOMATED", mode: "SANDBOX", configured: true, connection_tested: true,
    deposits_enabled: false, withdrawals_enabled: false,
    auto_approve_deposits: false, auto_approve_withdrawals: false,
    webhook_url: "", origin_verification_url: "", credential_hints: {},
  }]);
  adminPayments.updateGateway.mockResolvedValue({});
  const { container, root } = await renderPage();

  const toggle = container.querySelector('[data-testid="deposits-AUTO_CARD"]');
  await act(async () => {
    toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle();
  });
  expect(adminPayments.updateGateway).toHaveBeenCalledWith("g1", { deposits_enabled: true });
  await act(async () => root.unmount());
});

test("lists a local deposit method with receiving details hidden", async () => {
  adminPayments.hubStatus.mockResolvedValue({ admin: true, payments_v2: false });
  adminPayments.localAgents.mockResolvedValue([{
    id: "a1", agent_type: "UPI", agent_name: "Mumbai UPI", country_code: "IN",
    deposit_enabled: true, withdrawal_enabled: false, show_details: false,
    details: null, details_hidden: true,
  }]);
  const { container, root } = await renderPage();
  const agent = container.querySelector('[data-testid="local-agent-a1"]');
  expect(agent).not.toBeNull();
  expect(agent.textContent).toContain("Mumbai UPI");
  expect(agent.textContent).toContain("Receiving details hidden");
  await act(async () => root.unmount());
});
