import { act } from "react";
import { createRoot } from "react-dom/client";
import AdminPaymentHub from "./AdminPaymentHub";
import { adminPayments } from "@/lib/paymentApi";

jest.mock("@/lib/paymentApi", () => ({ adminPayments: {
  hubStatus: jest.fn(), gateways: jest.fn(), routes: jest.fn(),
  hubWebhookEvents: jest.fn(), hubActivity: jest.fn(), paymentApprovals: jest.fn(),
} }));
jest.mock("@/components/common", () => ({ PageTransition: ({ children, ...props }) => <div {...props}>{children}</div> }));
jest.mock("@/context/AuthContext", () => ({ useAuth: () => ({ user: { role: "ADMIN", status: "ACTIVE", admin_role: "OPERATIONS", admin_permissions: ["PAYMENTS_VIEW"] } }) }));

beforeAll(() => { global.IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(() => jest.clearAllMocks());

test("payment hub fails closed and does not load financial collections while disabled", async () => {
  adminPayments.hubStatus.mockResolvedValue({ payments_v2: false, admin: false, live_allowed: false, installed_adapters: ["MOCK_SANDBOX", "GENERIC_REST"] });
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => { root.render(<AdminPaymentHub />); await Promise.resolve(); });
  expect(container.textContent).toContain("Universal payment hub");
  expect(container.textContent).toContain("Payment hub is safely disabled");
  expect(container.textContent).toContain("Locked");
  expect(adminPayments.gateways).not.toHaveBeenCalled();
  await act(async () => root.unmount());
});
