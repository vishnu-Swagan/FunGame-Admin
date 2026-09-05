import { act } from "react";
import { createRoot } from "react-dom/client";
import BonusMission, { MissionStateNotice } from "./BonusMission";

const mockMissionDetail = jest.fn();
const mockActiveMission = jest.fn();
const mockClaimMission = jest.fn();
const mockForfeitMission = jest.fn();
const mockNavigate = jest.fn();
const mockIntentKey = jest.fn();
const mockClearIntent = jest.fn();
const mockRefreshUser = jest.fn();

jest.mock("react-router-dom", () => ({
  Link: ({ to, children, ...props }) => <a href={to} {...props}>{children}</a>,
  useNavigate: () => mockNavigate,
  useParams: () => ({ missionId: "mission-1" }),
}), { virtual: true });
jest.mock("framer-motion", () => ({
  motion: { section: ({ children, animate, transition, initial, ...props }) => <section {...props}>{children}</section> },
  useReducedMotion: () => true,
}));
jest.mock("@/components/common", () => ({
  PageTransition: ({ children, ...props }) => <div {...props}>{children}</div>,
  formatChips: (value) => String(value ?? 0),
}));
jest.mock("@/components/ui/button", () => ({ Button: ({ children, ...props }) => <button {...props}>{children}</button> }));
jest.mock("@/components/promotions", () => ({
  PromotionProgress: ({ mission }) => <div role="progressbar" aria-valuenow={mission.progress.percent}>{mission.progress.percent}%</div>,
  ClaimFinalityNotice: ({ mission }) => mission.status === "PENDING_SETTLEMENT" && mission.claim_finality?.status === "PENDING" ? <div data-testid="claim-finality-notice">Verifying settled wagers · 04 Sep 2026, 03:30 pm UTC · server time</div> : null,
  MissionDeadline: () => <div>Absolute deadline</div>,
  formatPromotionDate: () => "05 Sep 2026, 03:30 pm UTC",
  isClaimFinalityPending: (mission) => mission?.status === "PENDING_SETTLEMENT" && mission?.claim_finality?.status === "PENDING",
  rewardLabel: (reward) => `${reward.chips || 0} restricted bonus`,
}));
jest.mock("@/lib/promotionApi", () => ({
  normalizeMission: (value) => value,
  promotions: {
    mission: (...args) => mockMissionDetail(...args),
    activeMission: (...args) => mockActiveMission(...args),
    claimMission: (...args) => mockClaimMission(...args),
    forfeitMission: (...args) => mockForfeitMission(...args),
  },
}));
jest.mock("@/context/AuthContext", () => ({ useAuth: () => ({ user: { id: "player-1" }, refreshUser: mockRefreshUser }) }));
jest.mock("@/lib/api", () => ({ errMsg: (error, fallback) => error?.message || fallback }));
jest.mock("@/lib/financialIntent", () => ({
  financialIntentKey: (...args) => mockIntentKey(...args),
  clearFinancialIntent: (...args) => mockClearIntent(...args),
}));

const BASE_MISSION = {
  id: "mission-1",
  status: "PENDING_SETTLEMENT",
  claimable: false,
  forfeit_allowed: false,
  campaign_version: 2,
  terms_version: "terms-2",
  jurisdiction: "IN-TEST",
  deadline_at: "2026-09-05T10:00:00Z",
  timezone: "UTC",
  reward: { type: "BONUS_CHIPS", chips: 500 },
  progress: { target_chips: 1000, settled_chips: 1000, pending_chips: 0, remaining_chips: 0, percent: 100 },
  claim_finality: { status: "PENDING", window_hours: 24, policy_version: "settlement-v1", target_achieved_at: "2026-09-03T10:00:00Z", finality_at: "2026-09-04T10:00:00Z", remaining_seconds: 3600 },
  contribution_rules: { default_bps: 10000, max_qualifying_stake_chips: 200, allowed_games: ["Aviator"], excluded_games: [] },
};

beforeAll(() => { global.IS_REACT_ACT_ENVIRONMENT = true; });
beforeEach(() => {
  mockMissionDetail.mockReset();
  mockActiveMission.mockReset();
  mockClaimMission.mockReset();
  mockForfeitMission.mockReset();
  mockNavigate.mockReset();
  mockIntentKey.mockReset().mockReturnValue("claim-key");
  mockClearIntent.mockReset();
  mockRefreshUser.mockReset().mockResolvedValue(undefined);
});
afterEach(() => { document.body.innerHTML = ""; });

async function renderPage(mission) {
  mockMissionDetail.mockResolvedValue({ mission, events: [] });
  const container = document.createElement("div"); document.body.appendChild(container); const root = createRoot(container);
  await act(async () => { root.render(<BonusMission />); await Promise.resolve(); await Promise.resolve(); });
  return { container, root };
}

test("100 percent pending finality stays disabled and shows the absolute server review window", async () => {
  const { container, root } = await renderPage(BASE_MISSION);
  expect(container.querySelector('[role="progressbar"]').getAttribute("aria-valuenow")).toBe("100");
  expect(container.querySelector('[data-testid="claim-bonus-button"]').disabled).toBe(true);
  expect(container.textContent).toContain("Verifying settled wagers");
  expect(container.textContent).toContain("04 Sep 2026, 03:30 pm UTC");
  expect(container.textContent).toContain("Settlement-finality policy settlement-v1");
  expect(container.querySelector('[data-testid="bonus-claim-receipt"]')).toBeNull();
  await act(async () => root.unmount());
});

test("server-confirmed claimable state submits one idempotent claim", async () => {
  const mission = { ...BASE_MISSION, status: "CLAIMABLE", claimable: true, claim_finality: { ...BASE_MISSION.claim_finality, status: "SATISFIED", remaining_seconds: 0 } };
  mockClaimMission.mockResolvedValue({ mission: { ...mission, status: "CLAIMED", claimable: false }, claim: { id: "claim-1", status: "CLAIMED", claimed_at: "2026-09-04T10:01:00Z" } });
  const { container, root } = await renderPage(mission);
  const button = container.querySelector('[data-testid="claim-bonus-button"]');
  expect(button.disabled).toBe(false);
  await act(async () => { button.click(); await Promise.resolve(); await Promise.resolve(); });
  expect(mockIntentKey).toHaveBeenCalledWith("bonus-claim", "player-1", "mission=mission-1");
  expect(mockClaimMission).toHaveBeenCalledWith("mission-1", "claim-key");
  expect(mockClearIntent).toHaveBeenCalledWith("bonus-claim", "player-1", "claim-key");
  expect(mockRefreshUser).toHaveBeenCalled();
  expect(container.querySelector('[data-testid="bonus-claim-receipt"]')).not.toBeNull();
  await act(async () => root.unmount());
});

test("does not show a success receipt when the claim response is not final", async () => {
  const mission = { ...BASE_MISSION, status: "CLAIMABLE", claimable: true, claim_finality: { ...BASE_MISSION.claim_finality, status: "SATISFIED" } };
  mockClaimMission.mockResolvedValue({ mission: { ...mission, status: "CLAIMABLE", claimable: true }, claim: { id: "claim-pending", status: "PENDING" } });
  const { container, root } = await renderPage(mission);
  await act(async () => { container.querySelector('[data-testid="claim-bonus-button"]').click(); await Promise.resolve(); await Promise.resolve(); });
  expect(container.querySelector('[data-testid="bonus-claim-receipt"]')).toBeNull();
  expect(container.textContent).toContain("server has not finalized this reward claim yet");
  expect(mockClearIntent).not.toHaveBeenCalled();
  await act(async () => root.unmount());
});

test("shows a retryable offline error without deriving mission eligibility", async () => {
  mockMissionDetail.mockRejectedValue(new Error("Network unavailable"));
  const container = document.createElement("div"); document.body.appendChild(container); const root = createRoot(container);
  await act(async () => { root.render(<BonusMission />); await Promise.resolve(); await Promise.resolve(); });

  expect(container.querySelector('[data-testid="bonus-mission-error"]')).not.toBeNull();
  expect(container.textContent).toContain("Network unavailable");
  expect(container.querySelector('[data-testid="claim-bonus-button"]')).toBeNull();
  expect(container.textContent).toContain("Try again");
  await act(async () => root.unmount());
});

test.each([
  ["PAUSED_FOR_REVIEW", "Progress paused for review"],
  ["EXPIRED", "Mission expired"],
  ["CLAIMED", "Reward claimed"],
  ["FORFEITED", "Deposited cash was not forfeited"],
])("explains the %s state without relying on color", (status, copy) => {
  const container = document.createElement("div"); document.body.appendChild(container); const root = createRoot(container);
  act(() => root.render(<MissionStateNotice mission={{ status }} />));
  expect(container.textContent).toContain(copy);
  act(() => root.unmount());
});
