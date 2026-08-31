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

test("payment hub fails closed and identifies the CRM as a no-traffic preview", async () => {
  adminPayments.hubStatus.mockResolvedValue({
    payments_v2: false, admin: false, live_allowed: false,
    installed_adapters: ["GENERIC_REST"],
  });
  const { container, root } = await renderHub();

  expect(container.textContent).toContain("Payment gateway configuration preview");
  expect(container.querySelector('[data-testid="payment-preview-boundary"]')?.textContent)
    .toContain("Configuration preview · no player traffic");
  expect(container.textContent).toContain("Gateway configuration API is disabled");
  expect(container.textContent).toContain("Player wallet ↔ V2 bridge uncertified");
  expect(container.textContent).not.toContain("Active providers");
  expect(container.textContent).not.toContain("Live traffic activation");
  expect(adminPayments.gateways).not.toHaveBeenCalled();
  await act(async () => root.unmount());
});

test("even enabled V2 records expose no callback or payment-enablement control", async () => {
  mockUser = { role: "ADMIN", status: "ACTIVE", admin_role: "SUPER_ADMIN", admin_permissions: [] };
  adminPayments.hubStatus.mockResolvedValue({
    payments_v2: true, admin: true, live_allowed: true,
    webhook_base_url: "https://api.chakri.test",
  });
  adminPayments.gateways.mockResolvedValue([{
    id: "gateway-1", code: "PROVIDER_ONE", display_name: "Provider One",
    environment: "LIVE", adapter_type: "GENERIC_REST", health_status: "HEALTHY",
    status: "ACTIVE", is_enabled: true,
    webhook_url: "https://api.chakri.test/api/webhooks/payments/PROVIDER_ONE",
  }]);
  adminPayments.routes.mockResolvedValue([{
    id: "route-1", name: "Primary pay-in", direction: "PAYIN",
    payment_method: "ALL", currency: "INR", priority: 10, is_enabled: true,
  }]);
  adminPayments.paymentApprovals.mockResolvedValue([{
    id: "approval-1", action_type: "ACTIVATE", target_type: "PAYMENT_GATEWAY",
    target_id: "gateway-1",
  }]);
  const { container, root } = await renderHub();
  const text = container.textContent;
  const buttonLabels = [...container.querySelectorAll("button")].map((button) => button.textContent).join(" | ");

  expect(text).toContain("Configuration preview · no player traffic");
  expect(text).toContain("Production contract metadata · draft only");
  expect(text).toContain("Config check: HEALTHY · not traffic readiness");
  expect(text).toContain("Stored enabled · not player-routed");
  expect(text).toContain("V2 callback registration blocked");
  expect(text).toContain("No V2 callback is registration-ready");
  expect(text).toContain("The CRM cannot approve or enable a provider or route");
  expect(text).toContain("Save disabled provider draft");
  expect(text).not.toContain("https://api.chakri.test/api/webhooks/payments/PROVIDER_ONE");
  expect(text).not.toContain("LIVE contract");
  expect(buttonLabels).not.toMatch(/request activation|approve|enable|copy webhook/i);
  expect(adminPayments.requestGatewayActivation).not.toHaveBeenCalled();
  expect(adminPayments.approveGatewayActivation).not.toHaveBeenCalled();
  expect(adminPayments.requestRouteActivation).not.toHaveBeenCalled();
  expect(adminPayments.approveRouteActivation).not.toHaveBeenCalled();
  await act(async () => root.unmount());
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
