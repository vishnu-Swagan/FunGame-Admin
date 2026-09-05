import { act } from "react";
import { createRoot } from "react-dom/client";

import { financialApi } from "@/lib/api";
import AdminPromotions, { promotionAdminApi } from "./AdminPromotions";

let mockUser;

jest.mock("@/lib/api", () => ({
  financialApi: { get: jest.fn(), post: jest.fn() },
  errMsg: (error, fallback) => error?.message || fallback,
}));
jest.mock("@/context/AuthContext", () => ({ useAuth: () => ({ user: mockUser }) }));
jest.mock("@/components/common", () => ({
  PageTransition: ({ children, ...props }) => <div {...props}>{children}</div>,
  formatChips: (value) => Number(value || 0).toLocaleString("en-IN"),
}));
jest.mock("@/components/AdminStepUpDialog", () => ({
  __esModule: true,
  default: ({ open }) => open ? <div data-testid="step-up-dialog" /> : null,
  requiresAdminStepUp: () => false,
}));
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }));

const READINESS = {
  core: { ready: true, schema_version: 1, errors: [] },
  wager: {
    enabled: false,
    requirements: {
      regulatory_approved: false,
      real_money_enabled: false,
      feature_enabled: false,
      promotion_core_ready: true,
      financial_core_ready: false,
      game_wallet_code_certified: false,
      financial_game_wallet_integration_attested: false,
      promotion_wallet_integration_attested: false,
    },
  },
  referral: {
    enabled: false,
    requirements: {
      regulatory_approved: false,
      real_money_enabled: false,
      feature_enabled: false,
      promotion_core_ready: true,
      financial_core_ready: false,
    },
  },
  randomized_rewards_approved: false,
};

const ACTIVE_VERSION = {
  id: "gold-mission:2", campaign_id: "gold-mission", campaign_type: "WAGER",
  version: 2, status: "ACTIVE", title: "Gold mission", terms_version: "terms-2",
  terms_text: "Qualifying settled wagers count toward the disclosed target only.",
  terms_hash: "abcdef0123456789", starts_at: "2026-09-01T00:00:00Z",
  ends_at: "2026-09-30T00:00:00Z", jurisdictions: ["IN"],
  reward_type: "BONUS_CHIPS", reward_chips: 500, incentive_products: ["CASINO"],
  wager_multiplier_bps: 50000, duration_hours: 72, claim_finality_hours: 24,
  settlement_finality_policy_version: "settlement-v1",
  default_contribution_bps: 10000,
  max_qualifying_stake_chips: 1000, eligible_source_buckets: ["CASH", "BONUS"],
  per_user_cap_chips: 1000, daily_cap_chips: 5000, campaign_cap_chips: 50000,
  allowed_games: ["aviator"], excluded_games: ["demo"], forfeit_allowed: false,
  responsible_gambling_rules: {
    schema_version: "promotion-rg-v1",
    account_eligibility: "ACTIVE_VERIFIED_PLAYER",
    self_exclusion: "BLOCK_NEW_PARTICIPATION",
    jurisdiction: "REGISTERED_COUNTRY_ALLOWLIST",
    player_limits: "APPLY_PLATFORM_LIMITS",
    support_route: "/responsible-play",
  },
};

const CAMPAIGN = { id: "gold-mission", campaign_type: "WAGER", status: "ACTIVE", latest_version: 2, active_version: 2 };
const TASK = {
  id: "task-1", kind: "TASK", referral_id: "referral-1",
  task_key: "FIRST_ELIGIBLE_DEPOSIT", status: "PENDING", reward_chips: 100,
  verify_after: "2026-09-05T10:00:00Z",
  fraud_review: { status: "REVIEW_REQUIRED", reason_code: "MANUAL_REVIEW_REQUIRED" },
};

function installApi({ version = ACTIVE_VERSION, task = TASK } = {}) {
  financialApi.get.mockImplementation(async (path) => {
    if (path === "/admin/promotions/readiness") return { data: READINESS };
    if (path === "/admin/promotions/campaigns") return { data: { campaigns: [{ ...CAMPAIGN, status: version.status, latest_version: version.version, active_version: version.status === "ACTIVE" ? version.version : null }] } };
    if (path === "/admin/promotions/campaigns/gold-mission") return { data: { campaign: CAMPAIGN, versions: [version] } };
    if (path === "/admin/promotions/referral-tasks") return { data: { tasks: [task] } };
    if (path === "/admin/promotions/audit") return { data: { audits: [{ id: "audit-1", actor: "admin-2", action: "CAMPAIGN_VERSION_APPROVED", entity_type: "CAMPAIGN", entity_id: "gold-mission", reason: "Independent review", metadata: { campaign_version: 2 }, created_at: "2026-09-02T08:00:00Z" }], total: 1 } };
    if (path === "/admin/promotions/missions/mission-1") return { data: { mission: { id: "mission-1", campaign_id: "gold-mission", campaign_version: 2, status: "ACTIVE", progress: { settled_chips: 300, pending_chips: 50, target_chips: 1000, percent: 30 } }, events: [{ id: "event-1", bet_id: "bet-1", game: "aviator", stake_chips: 100, contribution_chips: 100, status: "SETTLED" }] } };
    if (path === "/admin/promotions/referrals/referral-1") return { data: { referral: { id: "referral-1", device_fingerprint: "must-never-render" }, fraud_review: { status: task.fraud_review?.status || "REVIEW_REQUIRED", signal_names: ["shared_device"], reason_code: task.fraud_review?.reason_code || "MANUAL_REVIEW_REQUIRED", appeal_status: "NOT_SUBMITTED", appeal_available: false, support_path: "/support" }, events: [], tasks: [task] } };
    throw new Error(`Unexpected GET ${path}`);
  });
  financialApi.post.mockImplementation(async (path, body) => {
    if (path.endsWith("/approve")) return { data: { version: { ...version, status: "APPROVED" } } };
    if (path.endsWith("/activate")) return { data: { version: { ...version, status: "ACTIVE" } } };
    if (path === "/admin/promotions/missions/mission-1/reconcile") return { data: { mission_id: "mission-1", matches: false, stored: { settled_chips: 300, pending_chips: 50 }, expected: { settled_chips: 325, pending_chips: 25 }, authoritative_event_count: 4, repaired: false, issues: { missing_derived_events: ["stake:4"] } } };
    if (path === "/admin/promotions/referral-tasks/task-1/review") return { data: { task: { ...task, status: body.approve ? "VERIFIED" : "REJECTED" } } };
    if (path === "/admin/promotions/referrals/referral-1/fraud-review") return { data: { fraud_review: { status: body.decision === "CLEAR" ? "CLEARED" : "REJECTED", reason_code: body.reason_code } } };
    throw new Error(`Unexpected POST ${path}`);
  });
}

beforeAll(() => { global.IS_REACT_ACT_ENVIRONMENT = true; });
beforeEach(() => {
  jest.clearAllMocks();
  mockUser = {
    role: "ADMIN", status: "ACTIVE", admin_role: "OPERATIONS",
    admin_permissions: ["PROMOTIONS_VIEW", "PROMOTION_AUDIT_VIEW"],
  };
  installApi();
});
afterEach(() => { document.body.innerHTML = ""; });

async function settle() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

async function renderPage() {
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(<AdminPromotions />); await settle(); });
  return { container, root };
}

function change(control, value) {
  act(() => {
    const prototype = control.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(control, value);
    control.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

test("renders fail-closed readiness, immutable terms and sanitized audit history", async () => {
  const { container, root } = await renderPage();
  const text = container.textContent;

  expect(container.querySelector('[data-testid="promotion-dormant-notice"]')).not.toBeNull();
  expect(text).toContain("Production promotion features remain dormant");
  expect(text).toContain("REGULATORY_APPROVED");
  expect(text).toContain("GAME_WALLET_INTEGRATION_READY");
  expect(text).toContain("Randomized rewards");
  expect(text).toContain("Immutable snapshot");
  expect(text).toContain("terms-2");
  expect(text).toContain("promotion-rg-v1");
  expect(text).toContain("Claim finality");
  expect(text).toContain("Finality policy");
  expect(text).toContain("settlement-v1");
  expect(text).toContain("Per-player reward cap");
  expect(text).toContain("Daily liability cap");
  expect(text).toContain("Campaign liability cap");
  expect(text).toContain("Campaign Version Approved");
  expect(container.querySelector('[data-testid="approve-campaign-version"]')).toBeNull();
  expect(container.querySelector('[data-testid="activate-campaign-version"]')).toBeNull();
  await act(async () => root.unmount());
});

test("PROMOTIONS_MANAGE permits reasoned approval while activation remains Super Admin only", async () => {
  const draft = { ...ACTIVE_VERSION, version: 3, id: "gold-mission:3", status: "DRAFT" };
  mockUser = { ...mockUser, admin_permissions: ["PROMOTIONS_VIEW", "PROMOTIONS_MANAGE", "PROMOTIONS_ACTIVATE", "PROMOTION_AUDIT_VIEW"] };
  installApi({ version: draft });
  const { container, root } = await renderPage();

  expect(container.querySelector('[data-testid="approve-campaign-version"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="activate-campaign-version"]')).toBeNull();
  change(container.querySelector('textarea[aria-label="Campaign approval or activation reason"]'), "Independent legal and product review");
  await act(async () => { container.querySelector('[data-testid="approve-campaign-version"]').click(); await settle(); });
  expect(financialApi.post).toHaveBeenCalledWith(
    "/admin/promotions/campaigns/gold-mission/versions/3/approve",
    { reason: "Independent legal and product review" }, { __noFailover: true },
  );
  await act(async () => root.unmount());
});

test("mission lookup shows authoritative contributions and dry reconciliation never requests repair", async () => {
  mockUser = { ...mockUser, admin_permissions: ["PROMOTIONS_VIEW", "PROMOTIONS_MANAGE", "PROMOTION_AUDIT_VIEW"] };
  const { container, root } = await renderPage();
  change(container.querySelector('input[aria-label="Mission ID"]'), "mission-1");
  await act(async () => { container.querySelector('input[aria-label="Mission ID"]').closest("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await settle(); });

  expect(container.textContent).toContain("bet-1");
  expect(container.querySelector('[role="progressbar"]').getAttribute("aria-valuenow")).toBe("30");
  change(container.querySelector('input[aria-label="Mission reconciliation reason"]'), "Routine ledger verification");
  await act(async () => { container.querySelector('[data-testid="reconcile-mission"]').click(); await settle(); });

  expect(financialApi.post).toHaveBeenCalledWith(
    "/admin/promotions/missions/mission-1/reconcile",
    { repair: false, reason: "Routine ledger verification" }, { __noFailover: true },
  );
  expect(container.querySelector('[data-testid="reconciliation-result"]')).not.toBeNull();
  expect(container.textContent).toContain("repair performed: no");
  expect(container.textContent).toContain("Missing Derived Events 1");
  await act(async () => root.unmount());
});

test("referral review exposes signal names but never raw device evidence", async () => {
  const { container, root } = await renderPage();
  await act(async () => { container.querySelector('[data-testid="inspect-referral-review"]').click(); await settle(); });

  const review = container.querySelector('[data-testid="referral-fraud-review"]');
  expect(review.textContent).toContain("shared_device");
  expect(review.textContent).toContain("MANUAL_REVIEW_REQUIRED");
  expect(container.textContent).not.toContain("must-never-render");
  expect(container.querySelector('[data-testid="approve-referral-task"]')).toBeNull();
  await act(async () => root.unmount());
});

test("PROMOTIONS_MANAGE records a reasoned relationship decision while task approval remains gated", async () => {
  mockUser = { ...mockUser, admin_permissions: ["PROMOTIONS_VIEW", "PROMOTIONS_MANAGE", "PROMOTION_AUDIT_VIEW"] };
  const { container, root } = await renderPage();
  expect(container.querySelector('[data-testid="approve-referral-task"]')).toBeNull();
  expect(container.textContent).toContain("until the server reports this referral relationship as CLEARED");
  await act(async () => { container.querySelector('[data-testid="inspect-referral-review"]').click(); await settle(); });

  change(container.querySelector('input[aria-label="Referral fraud review reason code"]'), "MANUAL_REVIEW_COMPLETE");
  change(container.querySelector('textarea[aria-label="Referral fraud review reason"]'), "Independent relationship evidence reviewed");
  await act(async () => { container.querySelector('[data-testid="submit-referral-fraud-review"]').click(); await settle(); });

  expect(financialApi.post).toHaveBeenCalledWith(
    "/admin/promotions/referrals/referral-1/fraud-review",
    { decision: "CLEAR", reason_code: "MANUAL_REVIEW_COMPLETE", reason: "Independent relationship evidence reviewed" },
    { __noFailover: true },
  );
  expect(container.textContent).not.toContain("must-never-render");
  await act(async () => root.unmount());
});

test("task review controls appear only after the server reports the relationship CLEARED", async () => {
  mockUser = { ...mockUser, admin_permissions: ["PROMOTIONS_VIEW", "PROMOTIONS_MANAGE", "PROMOTION_AUDIT_VIEW"] };
  installApi({ task: { ...TASK, fraud_review: { status: "CLEARED", reason_code: "MANUAL_REVIEW_COMPLETE" } } });
  const { container, root } = await renderPage();
  expect(container.querySelector('[data-testid="approve-referral-task"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="reject-referral-task"]')).not.toBeNull();
  await act(async () => root.unmount());
});

test("an approved campaign exposes activation only to a Super Admin", async () => {
  const approved = { ...ACTIVE_VERSION, status: "APPROVED" };
  mockUser = { role: "ADMIN", status: "ACTIVE", admin_role: "SUPER_ADMIN", admin_permissions: [] };
  installApi({ version: approved });
  const { container, root } = await renderPage();
  expect(container.querySelector('[data-testid="activate-campaign-version"]')).not.toBeNull();
  expect(container.textContent).toContain("Activation is Super Admin only");
  await act(async () => root.unmount());
});

test("privileged API calls send only the explicit reason and review decision", async () => {
  await promotionAdminApi.activateCampaign("gold-mission", 2, "Approved launch window");
  await promotionAdminApi.reviewReferralTask("task-1", false, "Duplicate account evidence reviewed");
  await promotionAdminApi.reviewReferralFraud("referral-1", "REJECT", "MULTI_ACCOUNT_CONFIRMED", "Independent evidence confirmed a duplicate account");

  expect(financialApi.post).toHaveBeenNthCalledWith(
    1, "/admin/promotions/campaigns/gold-mission/versions/2/activate",
    { reason: "Approved launch window" }, { __noFailover: true },
  );
  expect(financialApi.post).toHaveBeenNthCalledWith(
    2, "/admin/promotions/referral-tasks/task-1/review",
    { approve: false, reason: "Duplicate account evidence reviewed" }, { __noFailover: true },
  );
  expect(financialApi.post).toHaveBeenNthCalledWith(
    3, "/admin/promotions/referrals/referral-1/fraud-review",
    { decision: "REJECT", reason_code: "MULTI_ACCOUNT_CONFIRMED", reason: "Independent evidence confirmed a duplicate account" }, { __noFailover: true },
  );
});
