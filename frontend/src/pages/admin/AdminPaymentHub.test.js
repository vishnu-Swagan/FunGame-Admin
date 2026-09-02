import { act } from "react";
import { createRoot } from "react-dom/client";
import AdminPaymentHub from "./AdminPaymentHub";
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

const leftoverCopy = [
  "callback registration blocked",
  "no provider webhook URL is exposed",
  "No V2 callback is registration-ready",
  "No callback is ready to register",
  "V2 webhook evidence preview",
  "Blocked by bridge gate",
  "The CRM cannot approve or enable a provider or route while the bridge gate is blocked.",
  "Save disabled provider draft",
  "Saving draft…",
  "Stores a disabled draft only",
];

function expectNoLeftoverCopy(text) {
  leftoverCopy.forEach((phrase) => {
    expect(text.toLowerCase()).not.toContain(phrase.toLowerCase());
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
  adminPayments.createGateway.mockResolvedValue({ id: "gateway-1", is_enabled: false });
});

afterEach(() => {
  document.body.innerHTML = "";
});

test("admin flag off still identifies registration as available without loading gateways", async () => {
  adminPayments.hubStatus.mockResolvedValue({
    payments_v2: false, admin: false, live_allowed: false,
    installed_adapters: ["GENERIC_REST"],
  });
  const { container, root } = await renderHub();
  const text = container.textContent;

  expect(text).toContain("Provider registration is available here");
  expect(text).toContain("PAYMENT_GATEWAY_ADMIN_ENABLED must be on in Render");
  expect(container.querySelector('[data-testid="add-provider-form"]')).toBeNull();
  expect(adminPayments.gateways).not.toHaveBeenCalled();
  expectNoLeftoverCopy(text);
  await act(async () => root.unmount());
});

test("copyable webhook URLs render and Enable is gated while payments_v2 is false", async () => {
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
    status: "ACTIVE", is_enabled: false,
    webhook_url: "https://api.chakri.test/api/webhooks/payments/PROVIDER_ONE",
  }]);
  adminPayments.routes.mockResolvedValue([{
    id: "route-1", name: "Primary pay-in", direction: "PAYIN",
    payment_method: "ALL", currency: "INR", priority: 10, is_enabled: true,
  }]);
  adminPayments.paymentApprovals.mockResolvedValue([{
    id: "approval-1", action_type: "GATEWAY_ACTIVATION", target_type: "PAYMENT_GATEWAY",
    target_id: "gateway-1", status: "PENDING",
  }]);
  const { container, root } = await renderHub();
  const text = container.textContent;

  expect(container.querySelector('[data-testid="add-provider-form"]')).toBeTruthy();
  expect(container.querySelector('[data-testid="gateway-webhook-url-PROVIDER_ONE"]')?.textContent)
    .toContain("https://api.chakri.test/api/webhooks/payments/PROVIDER_ONE");
  expect(container.querySelector('[data-testid="gateway-v1-webhook-url-PROVIDER_ONE"]')?.textContent)
    .toContain("https://api.chakri.test/api/payments/webhooks/provider_one");
  expect(container.querySelector('[data-testid="webhook-tab-v2-PROVIDER_ONE"]')?.textContent)
    .toContain("https://api.chakri.test/api/webhooks/payments/PROVIDER_ONE");
  expect(container.querySelector('[data-testid="webhook-tab-v1-PROVIDER_ONE"]')?.textContent)
    .toContain("https://api.chakri.test/api/payments/webhooks/provider_one");
  expect(text).toContain("Webhook URLs for provider dashboards");
  expect(text).toContain("Save provider");
  expect(text).toContain("Enable requires PAYMENTS_V2_ENABLED");
  expect(container.querySelector('[data-testid="gateway-enable-blocked-PROVIDER_ONE"]')).toBeTruthy();
  expect(text).toContain("PENDING");
  expect(text).toContain("Enabled");
  expect(text).toContain("Provider registration is available here");
  expectNoLeftoverCopy(text);
  expect(adminPayments.requestGatewayActivation).not.toHaveBeenCalled();
  expect(adminPayments.approveGatewayActivation).not.toHaveBeenCalled();
  await act(async () => root.unmount());
});

test("webhook tab shows URL patterns when no gateways exist", async () => {
  mockUser = { role: "ADMIN", status: "ACTIVE", admin_role: "SUPER_ADMIN", admin_permissions: [] };
  adminPayments.hubStatus.mockResolvedValue({
    payments_v2: false, admin: true, live_allowed: false,
    webhook_base_url: "https://api.chakri.test",
  });
  const { container, root } = await renderHub();
  const text = container.textContent;

  expect(container.querySelector('[data-testid="add-provider-form"]')).toBeTruthy();
  expect(container.querySelector('[data-testid="webhook-v2-pattern"]')?.textContent)
    .toContain("https://api.chakri.test/api/webhooks/payments/{GATEWAY_CODE}");
  expect(container.querySelector('[data-testid="webhook-v1-pattern"]')?.textContent)
    .toContain("https://api.chakri.test/api/payments/webhooks/{provider_name}");
  expect(text).toContain("Webhook URLs for provider dashboards");
  expectNoLeftoverCopy(text);
  await act(async () => root.unmount());
});

test("Enable is available when payments_v2 is on", async () => {
  mockUser = { role: "ADMIN", status: "ACTIVE", admin_role: "SUPER_ADMIN", admin_permissions: [] };
  adminPayments.hubStatus.mockResolvedValue({
    payments_v2: true, admin: true, live_allowed: false,
    webhook_base_url: "https://api.chakri.test",
  });
  adminPayments.gateways.mockResolvedValue([{
    id: "gateway-1", code: "PROVIDER_ONE", display_name: "Provider One",
    environment: "SANDBOX", adapter_type: "GENERIC_REST", health_status: "NOT_RUN",
    status: "DISABLED", is_enabled: false,
    webhook_url: "https://api.chakri.test/api/webhooks/payments/PROVIDER_ONE",
  }]);
  const { container, root } = await renderHub();
  const buttonLabels = [...container.querySelectorAll("button")].map((button) => button.textContent).join(" | ");

  expect(container.querySelector('[data-testid="gateway-enable-blocked-PROVIDER_ONE"]')).toBeNull();
  expect(buttonLabels).toMatch(/Enable/);
  expect(container.querySelector('[data-testid="gateway-webhook-url-PROVIDER_ONE"]')).toBeTruthy();
  await act(async () => root.unmount());
});

test("provider onboarding submits a saved provider without enabling it", async () => {
  mockUser = { role: "ADMIN", status: "ACTIVE", admin_role: "SUPER_ADMIN", admin_permissions: [] };
  adminPayments.hubStatus.mockResolvedValue({
    payments_v2: false, admin: true, live_allowed: false,
    webhook_base_url: "https://api.chakri.test",
  });
  const { container, root } = await renderHub();

  change(container.querySelector("#gateway-code"), "provider_one");
  change(container.querySelector("#gateway-name"), "Provider One");
  change(container.querySelector("#gateway-url"), "https://sandbox.provider.example");
  await act(async () => {
    container.querySelector('[data-testid="add-provider-form"]')
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
