import { act } from "react";
import { createRoot } from "react-dom/client";
import { AdminDeposits, AdminKyc, AdminWithdrawals } from "./AdminPaymentPages";
import { adminPayments } from "@/lib/paymentApi";
import { toast } from "sonner";

let mockUser;
let mockStepUpProps;

jest.mock("@/lib/paymentApi", () => ({ adminPayments: {
  deposits: jest.fn(),
  withdrawals: jest.fn(),
  resolveOperatorRequest: jest.fn(),
  withdrawalAction: jest.fn(),
  retryOperatorPayout: jest.fn(),
  syncOperatorPayout: jest.fn(),
  kyc: jest.fn(),
  reviewKyc: jest.fn(),
  requestPlayerVerification: jest.fn(),
  reviewPlayerAge: jest.fn(),
  reviewPlayerMobile: jest.fn(),
} }));
jest.mock("@/components/AdminStepUpDialog", () => ({
  __esModule: true,
  default: (props) => {
    mockStepUpProps = props;
    return props.open ? <div>
      <button data-testid="mock-admin-step-up" onClick={async () => { await props.onVerified(); props.onCancel(); }}>
        Complete administrator verification
      </button>
      <button data-testid="mock-admin-step-up-cancel" onClick={props.onCancel}>Cancel verification</button>
    </div> : null;
  },
  requiresAdminStepUp: (error) => ["ADMIN_MFA_REQUIRED", "ADMIN_STEP_UP_REQUIRED"]
    .includes(error?.response?.data?.detail?.code),
}));
jest.mock("@/components/common", () => ({
  PageTransition: ({ children }) => <div>{children}</div>,
  EmptyState: ({ title }) => <div>{title}</div>,
  formatChips: (value) => String(value ?? 0),
}));
jest.mock("@/context/AuthContext", () => ({ useAuth: () => ({ user: mockUser }) }));
jest.mock("@/components/RouteGuards", () => jest.requireActual("@/lib/adminPermissions"));
jest.mock("react-router-dom", () => ({
  useSearchParams: () => [new URLSearchParams(), jest.fn()],
}), { virtual: true });
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }), { virtual: true });
jest.mock("@/components/ui/button", () => ({ Button: ({ children, ...props }) => <button {...props}>{children}</button> }));
jest.mock("@/components/ui/input", () => ({ Input: (props) => <input {...props} /> }));
jest.mock("@/components/ui/select", () => ({
  Select: ({ children }) => <div>{children}</div>,
  SelectTrigger: ({ children }) => <div>{children}</div>,
  SelectValue: () => null,
  SelectContent: ({ children }) => <div>{children}</div>,
  SelectItem: ({ children }) => <div>{children}</div>,
}));
jest.mock("@/pages/app/wallet/WalletBits", () => ({
  PaymentStatus: ({ status }) => <span>{status}</span>,
}));
jest.mock("lucide-react", () => new Proxy({}, { get: () => () => null }), { virtual: true });

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function render(Component) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<Component />);
    await settle();
  });
  return { container, root };
}

beforeAll(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  jest.resetAllMocks();
  mockStepUpProps = null;
  mockUser = { role: "ADMIN", status: "ACTIVE", admin_role: "SUPER_ADMIN", admin_permissions: [] };
  adminPayments.deposits.mockResolvedValue([{
    id: "op-dep-1",
    user_email: "player@example.test",
    amount_paise: 100000,
    chips: 1000,
    status: "PENDING",
    source: "ADMIN_REVIEW",
    created_at: "2026-09-01T02:00:00Z",
  }]);
  adminPayments.withdrawals.mockResolvedValue([{
    id: "op-wd-1",
    user_email: "player@example.test",
    amount_chips: 1000,
    amount_paise: 100000,
    status: "PENDING",
    internal_status: "PENDING",
    source: "ADMIN_REVIEW",
    bank_detail: { bank_name: "Operator Bank", account_number_masked: "••••1234" },
    created_at: "2026-09-01T02:05:00Z",
  }]);
  adminPayments.resolveOperatorRequest.mockResolvedValue({ request: { status: "APPROVED" } });
  adminPayments.retryOperatorPayout.mockResolvedValue({ request: { payout_status: "PROCESSING" } });
  adminPayments.syncOperatorPayout.mockResolvedValue({ request: { payout_status: "PROCESSING" } });
  adminPayments.kyc.mockResolvedValue([{
    id: "player-kyc-1",
    email_masked: "p•••@example.test",
    phone_masked: "••••1234",
    phone_available: true,
    contact_verified: true,
    age_verified: false,
    age_verification_status: "NOT_REQUESTED",
    country: "India",
    kyc_status: "UNVERIFIED",
  }]);
});

afterEach(() => {
  document.body.innerHTML = "";
});

test("admin deposits can approve operator buy requests", async () => {
  const { container, root } = await render(AdminDeposits);
  expect(container.querySelector('[data-testid="operator-deposit-op-dep-1"]')).not.toBeNull();
  expect(container.textContent).toContain("Admin review");
  await act(async () => {
    container.querySelector('[data-testid="approve-deposit-op-dep-1"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle();
  });
  expect(adminPayments.resolveOperatorRequest).toHaveBeenCalledWith("op-dep-1", "approve", { note: null });
  await act(async () => root.unmount());
});

test.each([503, null])("hosted deposit shows only sanitized checkout code and HTTP status %s", async (httpStatus) => {
  adminPayments.deposits.mockResolvedValue([{
    id: "hosted-failed", source: "UPI_HOSTED", status: "CREATED", amount_paise: 10000,
    checkout_diagnostics: { code: "PROVIDER_HTTP_ERROR", http_status: httpStatus, raw_body: "PRIVATE_PROVIDER_RESPONSE" },
  }]);
  const { container, root } = await render(AdminDeposits);
  const diagnostic = container.querySelector('[data-testid="checkout-diagnostic-hosted-failed"]');
  expect(diagnostic.textContent).toBe(`Checkout diagnostic: PROVIDER_HTTP_ERROR${httpStatus ? ` · HTTP ${httpStatus}` : ""}`);
  expect(container.textContent).not.toContain("PRIVATE_PROVIDER_RESPONSE");
  expect(buttonByText(container, "Approve")).toBeUndefined();
  await act(async () => root.unmount());
});

test("admin withdrawals can approve operator payout requests", async () => {
  const { container, root } = await render(AdminWithdrawals);
  expect(container.querySelector('[data-testid="operator-withdrawal-op-wd-1"]')).not.toBeNull();
  const approve = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Approve");
  expect(approve).toBeTruthy();
  await act(async () => {
    approve.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle();
  });
  expect(adminPayments.resolveOperatorRequest).toHaveBeenCalledWith("op-wd-1", "approve", { note: null });
  expect(adminPayments.withdrawalAction).not.toHaveBeenCalled();
  await act(async () => root.unmount());
});

test("KYC verification opens admin step-up and retries the exact action", async () => {
  adminPayments.reviewKyc
    .mockRejectedValueOnce({
      response: { data: { detail: {
        code: "ADMIN_MFA_REQUIRED",
        message: "Administrator 2FA enrollment and verification are required.",
      } } },
    })
    .mockResolvedValueOnce({ message: "KYC verified" });
  const { container, root } = await render(AdminKyc);
  const reason = container.querySelector('input[placeholder="Verification reason / instructions (required)"]');
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  await act(async () => {
    valueSetter.call(reason, "Identity documents checked");
    reason.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
  });
  const verifyKyc = Array.from(container.querySelectorAll("button"))
    .find((button) => button.textContent === "Verify KYC");
  await act(async () => {
    verifyKyc.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle();
  });
  expect(container.querySelector('[data-testid="mock-admin-step-up"]')).not.toBeNull();
  expect(adminPayments.reviewKyc).toHaveBeenCalledWith(
    "player-kyc-1", "VERIFIED", "Identity documents checked",
  );
  await act(async () => {
    container.querySelector('[data-testid="mock-admin-step-up"]')
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle();
  });
  expect(adminPayments.reviewKyc).toHaveBeenCalledTimes(2);
  expect(adminPayments.reviewKyc).toHaveBeenLastCalledWith(
    "player-kyc-1", "VERIFIED", "Identity documents checked",
  );
  await act(async () => root.unmount());
});

test("admin verification page does not expose manual age controls", async () => {
  const { container, root } = await render(AdminKyc);
  expect(container.textContent).not.toContain("Age not verified");
  expect(Array.from(container.querySelectorAll("button")).some(
    (button) => ["Request age", "Verify age"].includes(button.textContent),
  )).toBe(false);
  await act(async () => root.unmount());
});

const stepUpError = { response: { data: { detail: {
  code: "ADMIN_STEP_UP_REQUIRED", message: "Recent administrator verification required",
} } } };

function grant(...permissions) {
  mockUser = { role: "ADMIN", status: "ACTIVE", admin_role: "FINANCE", admin_permissions: permissions };
}

function buttonByText(container, text) {
  return Array.from(container.querySelectorAll("button")).find((button) => button.textContent === text);
}

async function click(button) {
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle();
  });
}

async function inputValue(input, value) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
  });
}

test("payments-view permission cannot approve or reject operator deposits", async () => {
  grant("PAYMENTS_VIEW");
  const { container, root } = await render(AdminDeposits);
  expect(buttonByText(container, "Approve")).toBeUndefined();
  expect(buttonByText(container, "Reject")).toBeUndefined();
  expect(adminPayments.resolveOperatorRequest).not.toHaveBeenCalled();
  await act(async () => root.unmount());
});

test("deposit step-up retries the original rejection once, preserving its reason", async () => {
  grant("PAYMENTS_RECONCILE");
  adminPayments.resolveOperatorRequest.mockRejectedValueOnce(stepUpError).mockResolvedValueOnce({});
  const { container, root } = await render(AdminDeposits);
  const note = container.querySelector('input[placeholder="Note or rejection reason"]');
  await inputValue(note, "Original audit reason");
  await click(buttonByText(container, "Reject"));
  expect(mockStepUpProps.open).toBe(true);
  expect(buttonByText(container, "Approve").disabled).toBe(true);
  await inputValue(note, "Changed after verification opened");
  const verify = mockStepUpProps.onVerified;
  await act(async () => { await Promise.all([verify(), verify()]); await settle(); });
  expect(adminPayments.resolveOperatorRequest).toHaveBeenCalledTimes(2);
  expect(adminPayments.resolveOperatorRequest.mock.calls).toEqual([
    ["op-dep-1", "reject", { reason: "Original audit reason" }],
    ["op-dep-1", "reject", { reason: "Original audit reason" }],
  ]);
  expect(mockStepUpProps.open).toBe(false);
  await act(async () => root.unmount());
});

test("cancelling deposit step-up does not resubmit or retain the pending action", async () => {
  adminPayments.resolveOperatorRequest.mockRejectedValueOnce(stepUpError);
  const { container, root } = await render(AdminDeposits);
  await click(buttonByText(container, "Approve"));
  const staleVerify = mockStepUpProps.onVerified;
  await click(container.querySelector('[data-testid="mock-admin-step-up-cancel"]'));
  await act(async () => { await staleVerify(); await settle(); });
  expect(adminPayments.resolveOperatorRequest).toHaveBeenCalledTimes(1);
  expect(mockStepUpProps.open).toBe(false);
  await act(async () => root.unmount());
});

test.each([
  [["PAYMENTS_VIEW"], false, false],
  [["WITHDRAWALS_APPROVE"], false, true],
  [["WITHDRAWALS_MARK_PAID"], false, false],
  [["WITHDRAWALS_APPROVE", "WITHDRAWALS_MARK_PAID"], true, true],
])("operator withdrawal gates match financial permissions %j", async (permissions, approve, reject) => {
  grant(...permissions);
  const { container, root } = await render(AdminWithdrawals);
  expect(Boolean(buttonByText(container, "Approve"))).toBe(approve);
  expect(Boolean(buttonByText(container, "Reject"))).toBe(reject);
  await act(async () => root.unmount());
});

test("withdrawal approval retries only after step-up and does not loop when verification is rejected again", async () => {
  adminPayments.resolveOperatorRequest.mockRejectedValue(stepUpError);
  const { container, root } = await render(AdminWithdrawals);
  await click(buttonByText(container, "Approve"));
  expect(adminPayments.resolveOperatorRequest).toHaveBeenCalledTimes(1);
  expect(mockStepUpProps.open).toBe(true);
  await click(container.querySelector('[data-testid="mock-admin-step-up"]'));
  expect(adminPayments.resolveOperatorRequest).toHaveBeenCalledTimes(2);
  expect(adminPayments.resolveOperatorRequest).toHaveBeenLastCalledWith("op-wd-1", "approve", { note: null });
  expect(mockStepUpProps.open).toBe(false);
  expect(toast.error).toHaveBeenCalled();
  await act(async () => root.unmount());
});

test("rapid repeat withdrawal approval clicks submit only one request", async () => {
  let complete;
  adminPayments.resolveOperatorRequest.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
  const { container, root } = await render(AdminWithdrawals);
  const approve = buttonByText(container, "Approve");
  await act(async () => {
    approve.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    approve.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle();
  });
  expect(adminPayments.resolveOperatorRequest).toHaveBeenCalledTimes(1);
  await act(async () => { complete({}); await settle(); });
  await act(async () => root.unmount());
});

test("provider errors are displayed without automatically repeating a withdrawal action", async () => {
  adminPayments.resolveOperatorRequest.mockRejectedValue({ response: { data: { detail: {
    code: "PROVIDER_UNAVAILABLE", message: "Provider unavailable",
  } } } });
  const { container, root } = await render(AdminWithdrawals);
  await click(buttonByText(container, "Approve"));
  expect(adminPayments.resolveOperatorRequest).toHaveBeenCalledTimes(1);
  expect(mockStepUpProps.open).toBe(false);
  expect(toast.error).toHaveBeenCalled();
  await act(async () => root.unmount());
});

test("non-operator withdrawal action retains its endpoint and payment reference through step-up", async () => {
  grant("WITHDRAWALS_MARK_PAID");
  adminPayments.withdrawals.mockResolvedValue([{
    id: "financial-wd", source: "PROVIDER", internal_status: "PROCESSING", withdrawal_mode: "MANUAL",
    amount_chips: 100, amount_paise: 10000,
  }]);
  adminPayments.withdrawalAction.mockRejectedValueOnce(stepUpError).mockResolvedValueOnce({});
  const { container, root } = await render(AdminWithdrawals);
  await inputValue(container.querySelector('input[placeholder="Provider/payment reference"]'), "Original reference");
  await click(buttonByText(container, "Mark paid"));
  await click(container.querySelector('[data-testid="mock-admin-step-up"]'));
  expect(adminPayments.withdrawalAction.mock.calls).toEqual([
    ["financial-wd", "mark-paid", { provider_reference: "Original reference" }],
    ["financial-wd", "mark-paid", { provider_reference: "Original reference" }],
  ]);
  expect(adminPayments.resolveOperatorRequest).not.toHaveBeenCalled();
  await act(async () => root.unmount());
});

function pendingPayout(status = "PREPARATION_FAILED") {
  adminPayments.withdrawals.mockResolvedValue([{
    id: "op-wd-payout", source: "ADMIN_REVIEW", status: "APPROVED", internal_status: "APPROVED",
    payout_status: status, amount_chips: 100, amount_paise: 10000,
  }]);
}

test.each([
  [["PAYMENTS_VIEW"], false, false],
  [["WITHDRAWALS_MARK_PAID"], true, false],
  [["PAYMENTS_RECONCILE"], false, true],
])("operator payout retry and sync have distinct permissions %j", async (permissions, retry, sync) => {
  grant(...permissions);
  pendingPayout();
  const { container, root } = await render(AdminWithdrawals);
  expect(Boolean(buttonByText(container, "Retry SgPay payout"))).toBe(retry);
  expect(Boolean(buttonByText(container, "Check SgPay payout status"))).toBe(sync);
  await act(async () => root.unmount());
});

test.each([
  ["Retry SgPay payout", "retryOperatorPayout"],
  ["Check SgPay payout status", "syncOperatorPayout"],
])("%s uses its exact endpoint with one verified retry", async (label, method) => {
  pendingPayout();
  adminPayments[method].mockRejectedValueOnce(stepUpError).mockResolvedValueOnce({});
  const { container, root } = await render(AdminWithdrawals);
  await click(buttonByText(container, label));
  expect(mockStepUpProps.open).toBe(true);
  const verify = mockStepUpProps.onVerified;
  await act(async () => { await Promise.all([verify(), verify()]); await settle(); });
  expect(adminPayments[method]).toHaveBeenCalledTimes(2);
  expect(adminPayments[method]).toHaveBeenLastCalledWith("op-wd-payout");
  expect(adminPayments.resolveOperatorRequest).not.toHaveBeenCalled();
  expect(adminPayments.withdrawalAction).not.toHaveBeenCalled();
  await act(async () => root.unmount());
});

test("paid payouts expose neither retry nor sync controls", async () => {
  pendingPayout("PAID");
  const { container, root } = await render(AdminWithdrawals);
  expect(buttonByText(container, "Retry SgPay payout")).toBeUndefined();
  expect(buttonByText(container, "Check SgPay payout status")).toBeUndefined();
  await act(async () => root.unmount());
});

test("a legacy sync error response is not reported as successful provider confirmation", async () => {
  pendingPayout("PROCESSING");
  adminPayments.syncOperatorPayout.mockResolvedValueOnce({ payout: { error: "PRIVATE_PROVIDER_DIAGNOSTIC" } });
  const { container, root } = await render(AdminWithdrawals);
  await click(buttonByText(container, "Check SgPay payout status"));
  expect(toast.success).not.toHaveBeenCalled();
  expect(toast.error).toHaveBeenCalledWith("Could not confirm payout status. No new payout was sent. Check the status again later.");
  expect(container.textContent).not.toContain("PRIVATE_PROVIDER_DIAGNOSTIC");
  expect(adminPayments.retryOperatorPayout).not.toHaveBeenCalled();
  expect(adminPayments.syncOperatorPayout).toHaveBeenCalledTimes(1);
  await act(async () => root.unmount());
});

test.each(["PROCESSING", "SUBMITTED", "QUEUED", "PENDING", "UNKNOWN", "SUBMITTING", "SUBMISSION_UNKNOWN", "FAILED", ""])(
  "an unresolved %s payout offers a status check, never a resubmission", async (status) => {
    pendingPayout(status);
    const { container, root } = await render(AdminWithdrawals);
    expect(buttonByText(container, "Retry SgPay payout")).toBeUndefined();
    expect(buttonByText(container, "Check SgPay payout status")).toBeTruthy();
    await act(async () => root.unmount());
  },
);
