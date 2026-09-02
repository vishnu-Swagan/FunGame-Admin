import { act } from "react";
import { createRoot } from "react-dom/client";
import ReferralRewards from "./ReferralRewards";

const mockReferral = jest.fn();
const mockTasks = jest.fn();
const mockClaim = jest.fn();
const mockAppeal = jest.fn();
const mockNavigate = jest.fn();
const mockIntentKey = jest.fn();
const mockClearIntent = jest.fn();
const mockRefreshUser = jest.fn();

jest.mock("react-router-dom", () => ({
  Link: ({ to, children, ...props }) => <a href={to} {...props}>{children}</a>,
  useNavigate: () => mockNavigate,
}), { virtual: true });
jest.mock("framer-motion", () => ({
  motion: {
    section: ({ children, animate, transition, initial, ...props }) => <section {...props}>{children}</section>,
    div: ({ children, animate, transition, initial, ...props }) => <div {...props}>{children}</div>,
  },
  useReducedMotion: () => true,
}));
jest.mock("@/components/common", () => ({
  PageTransition: ({ children, ...props }) => <div {...props}>{children}</div>,
  formatChips: (value) => String(value ?? 0),
}));
jest.mock("@/components/ui/button", () => ({ Button: ({ children, ...props }) => <button {...props}>{children}</button> }));
jest.mock("@/components/promotions", () => ({ formatPromotionDate: () => "05 Sep 2026, 03:30 pm UTC" }));
jest.mock("@/lib/promotionApi", () => ({ promotions: {
  referral: (...args) => mockReferral(...args),
  referralTasks: (...args) => mockTasks(...args),
  claimReferral: (...args) => mockClaim(...args),
  appealReferral: (...args) => mockAppeal(...args),
} }));
jest.mock("@/context/AuthContext", () => ({ useAuth: () => ({ user: { id: "player-1" }, refreshUser: mockRefreshUser }) }));
jest.mock("@/lib/api", () => ({ errMsg: (error, fallback) => error?.message || fallback }));
jest.mock("@/lib/financialIntent", () => ({
  financialIntentKey: (...args) => mockIntentKey(...args),
  clearFinancialIntent: (...args) => mockClearIntent(...args),
}));

const SUMMARY = {
  id: "referral-profile-1",
  invite_code: "SAFE123",
  invite_url: "https://play.example/register?invite_code=SAFE123",
  verified_reward_chips: 100,
  pending_reward_chips: 20,
  claim_threshold_chips: 100,
  remaining_chips: 0,
  progress_percent: 100,
  claimable: false,
  claim_disabled_reason: "Server verification is still pending.",
};

beforeAll(() => { global.IS_REACT_ACT_ENVIRONMENT = true; });
beforeEach(() => {
  mockReferral.mockReset().mockResolvedValue(SUMMARY);
  mockTasks.mockReset().mockResolvedValue([{ id: "task-1", task_key: "FIRST_VERIFIED_DEPOSIT", reward_chips: 20, status: "REJECTED", review_reason: "Payment verification did not pass." }]);
  mockClaim.mockReset().mockResolvedValue({ claim: { id: "claim-1", status: "CLAIMED" } });
  mockAppeal.mockReset().mockResolvedValue({ fraud_review: { status: "REJECTED", appeal_status: "PENDING", appeal_available: false } });
  mockNavigate.mockReset();
  mockIntentKey.mockReset().mockReturnValue("referral-key");
  mockClearIntent.mockReset();
  mockRefreshUser.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: jest.fn().mockResolvedValue(undefined) } });
  Object.defineProperty(navigator, "share", { configurable: true, value: undefined });
});
afterEach(() => { document.body.innerHTML = ""; });

async function renderPage() {
  const container = document.createElement("div"); document.body.appendChild(container); const root = createRoot(container);
  await act(async () => { root.render(<ReferralRewards />); await Promise.resolve(); await Promise.resolve(); });
  return { container, root };
}

function change(control, value) {
  act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set.call(control, value);
    control.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

test("100 percent remains unclaimable until the server verifies eligibility", async () => {
  const { container, root } = await renderPage();
  expect(container.querySelector('[role="progressbar"]').getAttribute("aria-valuenow")).toBe("100");
  expect(container.querySelector('[data-testid="claim-referral-button"]').disabled).toBe(true);
  expect(container.textContent).toContain("Server verification is still pending.");
  expect(container.textContent).toContain("Payment verification did not pass.");
  expect(container.textContent).toContain("does not request your contacts");
  expect(container.querySelector('[data-testid="referral-appeal-form"]')).toBeNull();

  const shareButton = [...container.querySelectorAll("button")].find((button) => button.textContent.trim() === "Share");
  await act(async () => { shareButton.click(); await Promise.resolve(); });
  expect(navigator.clipboard.writeText).toHaveBeenCalledWith(SUMMARY.invite_url);
  await act(async () => root.unmount());
});

test("server-eligible rejected relationship supports an accessible appeal with error and retry", async () => {
  const rejectedTask = {
    id: "task-appeal", referral_id: "referral-appeal-1", task_key: "FIRST_VERIFIED_DEPOSIT",
    reward_chips: 20, status: "REJECTED", review_reason: "Relationship verification was rejected.",
    fraud_review: {
      status: "REJECTED", reason_code: "DUPLICATE_ACCOUNT_REVIEW",
      appeal_status: "NOT_SUBMITTED", appeal_available: true, support_path: "/support",
    },
  };
  mockTasks
    .mockReset()
    .mockResolvedValueOnce([rejectedTask])
    .mockResolvedValueOnce([{ ...rejectedTask, fraud_review: { ...rejectedTask.fraud_review, appeal_status: "PENDING", appeal_available: false } }]);
  mockAppeal.mockRejectedValueOnce(new Error("Appeal service unavailable")).mockResolvedValueOnce({ fraud_review: { status: "REJECTED", appeal_status: "PENDING", appeal_available: false } });
  const { container, root } = await renderPage();

  const form = container.querySelector('[data-testid="referral-appeal-form"]');
  const textarea = form.querySelector("textarea");
  expect(container.textContent).toContain("DUPLICATE_ACCOUNT_REVIEW");
  expect(textarea.minLength).toBe(10);
  expect(textarea.getAttribute("aria-describedby")).toContain("-help");
  expect(form.querySelector('button[type="submit"]').disabled).toBe(true);
  change(textarea, "This is a legitimate referral relationship. Please review it.");

  await act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await Promise.resolve(); await Promise.resolve(); });
  expect(container.querySelector('[role="alert"]').textContent).toContain("Appeal service unavailable");
  expect(container.textContent).toContain("Retry appeal");

  await act(async () => { container.querySelector('[data-testid="referral-appeal-form"]').dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  expect(mockAppeal).toHaveBeenCalledTimes(2);
  expect(mockAppeal).toHaveBeenLastCalledWith("referral-appeal-1", "This is a legitimate referral relationship. Please review it.");
  expect(container.querySelector('[aria-live="polite"]').textContent).toContain("Referral appeal submitted");
  expect(container.textContent).toContain("Appeal status: PENDING");
  expect(container.querySelector('[data-testid="referral-appeal-form"]')).toBeNull();
  await act(async () => root.unmount());
});

test("claim uses an idempotency key only when server claimable is true", async () => {
  mockReferral.mockResolvedValue({ ...SUMMARY, claimable: true, claim_disabled_reason: "" });
  const { container, root } = await renderPage();
  const button = container.querySelector('[data-testid="claim-referral-button"]');
  expect(button.disabled).toBe(false);
  await act(async () => { button.click(); await Promise.resolve(); await Promise.resolve(); });
  expect(mockIntentKey).toHaveBeenCalledWith("referral-claim", "player-1", "threshold=100");
  expect(mockClaim).toHaveBeenCalledWith("referral-key");
  expect(mockClearIntent).toHaveBeenCalledWith("referral-claim", "player-1", "referral-key");
  await act(async () => root.unmount());
});

test("fails closed with a retry route when the referral service is offline", async () => {
  mockReferral.mockRejectedValue(new Error("Referral service offline"));
  mockTasks.mockRejectedValue(new Error("Tasks offline"));
  const { container, root } = await renderPage();

  expect(container.querySelector('[data-testid="referral-empty"]')).not.toBeNull();
  expect(container.textContent).toContain("Referral service offline");
  expect(container.querySelector('[data-testid="claim-referral-button"]')).toBeNull();
  expect(container.textContent).toContain("Try again");
  await act(async () => root.unmount());
});
