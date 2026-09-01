import { act } from "react";
import { createRoot } from "react-dom/client";
import AdminPaymentHub, { v1WebhookUrlFor } from "./AdminPaymentHub";
import { adminPayments } from "@/lib/paymentApi";

let mockUser;

jest.mock("@/lib/paymentApi", () => ({ adminPayments: {
  hubStatus: jest.fn(), gateways: jest.fn(), routes: jest.fn(),
  hubWebhookEvents: jest.fn(), hubActivity: jest.fn(), paymentApprovals: jest.fn(),
  createGateway: jest.fn(), writeGatewayCredentials: jest.fn(), testGateway: jest.fn(),
  createRoute: jest.fn(), requestGatewayActivation: jest.fn(),
  approveGatewayActivation: jest.fn(), requestRouteActivation: jest.fn(),
  approveRouteActivation: jest.fn(), disableGateway: jest.fn(),
} }));
jest.mock("@/components/common", () => ({ PageTransition: ({ children, ...props }) => <div {...props}>{children}</div> }));
jest.mock("@/context/AuthContext", () => ({ useAuth: () => ({ user: mockUser }) }));
jest.mock("@/components/ui/tabs", () => ({
  Tabs: ({ children }) => <div>{children}</div>,
  TabsList: ({ children }) => <div>{children}</div>,
  TabsTrigger: ({ children }) => <button type="button">{children}</button>,
  TabsContent: ({ children }) => <div>{children}</div>,
}));

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function renderHub() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<AdminPaymentHub />);
    await settle();
  });
  return { container, root };
}

function change(input, value) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeAll(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

beforeEach(() => {
  jest.clearAllMocks();
  mockUser = {
    role: "ADMIN", status: "ACTIVE", admin_role: "OPERATIONS",
    admin_permissions: ["PAYMENTS_VIEW"],
  };
  adminPayments.gateways.mockResolvedValue([]);
  adminPayments.routes.mockResolvedValue([]);
  adminPayments.hubWebhookEvents.mockResolvedValue([]);
  adminPayments.hubActivity.mockResolvedValue([]);
  adminPayments.paymentApprovals.mockResolvedValue([]);
  adminPayments.createGateway.mockResolvedValue({ id: "gateway-draft-1", is_enabled: false });
});

afterEach(() => {
  document.body.innerHTML = "";
});

test("payment hub loads providers even when a stale hub.admin flag is false", async () => {
  adminPayments.hubStatus.mockResolvedValue({
    payments_v2: false, admin: false, live_allowed: false,
    installed_adapters: ["GENERIC_REST"],
  });
  const { container, root } = await renderHub();

  expect(container.textContent).toContain("Payment gateways");
  expect(container.querySelector('[data-testid="payment-hub-boundary"]')?.textContent)
    .toContain("Provider registration is available here");
  expect(container.textContent).not.toContain("PAYMENT_GATEWAY_ADMIN_ENABLED must be on in Render");
  expect(container.textContent).toContain("wallet credit/debit");
  expect(adminPayments.gateways).toHaveBeenCalled();
  await act(async () => root.unmount());
});

test("shows provider webhook URLs and copy controls while V2 activation remains blocked", async () => {
  mockUser = { role: "ADMIN", status: "ACTIVE", admin_role: "SUPER_ADMIN", admin_permissions: [] };
  adminPayments.hubStatus.mockResolvedValue({
    payments_v2: false, admin: true, live_allowed: false,
    webhook_base_url: "https://api.chakri.test",
    v1_provider_code: "provider_one",
    v1_webhook_url: "https://api.chakri.test/api/payments/webhooks/provider_one",
  });
  adminPayments.gateways.mockResolvedValue([{
    id: "gateway-1", code: "PROVIDER_ONE", display_name: "Provider One",
    environment: "LIVE", adapter_type: "GENERIC_REST", health_status: "HEALTHY",
    status: "DRAFT", is_enabled: false,
    webhook_url: "https://api.chakri.test/api/webhooks/payments/PROVIDER_ONE",
  }, {
    id: "gateway-2", code: "PROVIDER_TWO", display_name: "Provider Two",
    environment: "SANDBOX", adapter_type: "GENERIC_REST", health_status: "NOT_RUN",
    status: "DRAFT", is_enabled: false,
    webhook_url: "https://api.chakri.test/api/webhooks/payments/PROVIDER_TWO",
  }]);
  const { container, root } = await renderHub();
  const text = container.textContent;

  expect(text).toContain("https://api.chakri.test/api/webhooks/payments/PROVIDER_ONE");
  expect(text).toContain("https://api.chakri.test/api/webhooks/payments/PROVIDER_TWO");
  expect(text).toContain("https://api.chakri.test/api/payments/webhooks/provider_one");
  expect(container.querySelector('[data-testid="gateway-v1-webhook-url-PROVIDER_TWO"]')).toBeNull();
  expect(container.querySelectorAll('[aria-label="Copy Provider webhook URL"]')).toHaveLength(2);
  expect(container.querySelector('[aria-label="Copy V1 callback (if this provider still uses it)"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="gateway-enable-blocked-PROVIDER_ONE"]')?.disabled).toBe(true);
  expect(container.querySelector('[data-testid="gateway-enable-blocked-PROVIDER_TWO"]')?.disabled).toBe(true);
  expect(text).toContain("Enable/activation requires PAYMENTS_V2_ENABLED in Render");
  expect(adminPayments.requestGatewayActivation).not.toHaveBeenCalled();
  expect(adminPayments.approveGatewayActivation).not.toHaveBeenCalled();
  await act(async () => root.unmount());
});

test("never constructs a V1 callback for an unconfigured provider", () => {
  const status = {
    webhook_base_url: "https://api.chakri.test",
    v1_provider_code: "provider_one",
    v1_webhook_url: "https://api.chakri.test/api/payments/webhooks/provider_one",
  };

  expect(v1WebhookUrlFor({ code: "PROVIDER_ONE" }, status))
    .toBe("https://api.chakri.test/api/payments/webhooks/provider_one");
  expect(v1WebhookUrlFor({ code: "PROVIDER_TWO" }, status)).toBe("");
  expect(v1WebhookUrlFor({ code: "PROVIDER_TWO" }, { webhook_base_url: "https://api.chakri.test" })).toBe("");
});

test("provider onboarding submits a sandbox configuration-only disabled draft", async () => {
  mockUser = { role: "ADMIN", status: "ACTIVE", admin_role: "SUPER_ADMIN", admin_permissions: [] };
  adminPayments.hubStatus.mockResolvedValue({ payments_v2: false, admin: true, live_allowed: false });
  const { container, root } = await renderHub();

  change(container.querySelector("#gateway-code"), "provider_one");
  change(container.querySelector("#gateway-name"), "Provider One");
  change(container.querySelector("#gateway-url"), "https://sandbox.provider.example");
  await act(async () => {
    container.querySelector('[data-testid="provider-draft-form"]')
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
  });

  expect(adminPayments.createGateway).toHaveBeenCalledTimes(1);
  const submitted = adminPayments.createGateway.mock.calls[0][0];
  expect(submitted).toMatchObject({
    code: "PROVIDER_ONE", display_name: "Provider One",
    adapter_type: "GENERIC_REST", environment: "SANDBOX",
    base_url: "https://sandbox.provider.example", non_secret_config: {},
  });
  expect(submitted).not.toHaveProperty("is_enabled");
  expect(adminPayments.requestGatewayActivation).not.toHaveBeenCalled();
  expect(adminPayments.approveGatewayActivation).not.toHaveBeenCalled();
  await act(async () => root.unmount());
});
