import { clampPromotionPercent, normalizeMission, normalizeOffer, normalizeReferral, promotions } from "./promotionApi";

const mockGet = jest.fn();
const mockPost = jest.fn();
const mockFinancialPost = jest.fn();

jest.mock("@/lib/api", () => ({
  financialApi: { get: (...args) => mockGet(...args), post: (...args) => mockPost(...args) },
  financialPost: (...args) => mockFinancialPost(...args),
}));

beforeEach(() => {
  mockGet.mockReset();
  mockPost.mockReset();
  mockFinancialPost.mockReset();
});

test("mission normalization accepts only server fields and caps display percentage", () => {
  const mission = normalizeMission({
    mission_id: "mission-1",
    status: "claimable",
    claimable: true,
    deadline_at: "2026-09-05T10:00:00Z",
    reward: { chips: 500 },
    progress: { target_chips: 1000, settled_chips: 1000, pending_chips: 20, remaining_chips: 0, percent: 109 },
    claim_finality: { status: "SATISFIED", window_hours: 24, policy_version: "settlement-v1", finality_at: "2026-09-04T10:00:00Z", satisfied_at: "2026-09-04T10:01:00Z", remaining_seconds: 0 },
  });
  expect(mission).toMatchObject({ id: "mission-1", status: "CLAIMABLE", claimable: true });
  expect(mission.progress).toEqual(expect.objectContaining({ target_chips: 1000, settled_chips: 1000, pending_chips: 20, remaining_chips: 0, percent: 100 }));
  expect(mission.claim_finality).toEqual(expect.objectContaining({ status: "SATISFIED", window_hours: 24, policy_version: "settlement-v1", remaining_seconds: 0 }));
  expect(mission.settlement_finality_policy_version).toBe("settlement-v1");
  expect(clampPromotionPercent(-9)).toBe(0);
  expect(clampPromotionPercent(51)).toBe(51);
});

test("100 percent pending finality stays unclaimable until the server persists CLAIMABLE", () => {
  const mission = normalizeMission({
    id: "mission-finality",
    status: "PENDING_SETTLEMENT",
    claimable: true,
    progress: { target_chips: 1000, settled_chips: 1000, remaining_chips: 0, percent: 100 },
    claim_finality: { status: "PENDING", window_hours: 24, target_achieved_at: "2026-09-03T10:00:00Z", finality_at: "2026-09-04T10:00:00Z", remaining_seconds: 3600 },
  });
  expect(mission.claimable).toBe(false);
  expect(mission.claim_finality).toMatchObject({ status: "PENDING", window_hours: 24, remaining_seconds: 3600 });
});

test("offer and referral normalization preserve integer server values", () => {
  expect(normalizeOffer({ campaign_id: "campaign-1", version: 3, claim_finality_hours: 24, settlement_finality_policy_version: "settlement-v1", reward_chips: 250, terms_version: "terms-3", jurisdiction: "IN", quote: { deposit_amount_paise: 50000, deposit_chips: 500, target_chips: 5000, rate_version: "rate-1", quote_token: "quote-token-1", quote_expires_at: "2026-09-02T10:10:00Z" } })).toMatchObject({ id: "campaign-1", campaign_version: 3, claim_finality_hours: 24, settlement_finality_policy_version: "settlement-v1", reward: { chips: 250 }, terms_version: "terms-3", jurisdiction: "IN", target_chips: 5000, rate_version: "rate-1", quote_token: "quote-token-1" });
  expect(normalizeReferral({ referral: { invite_url: "https://example.test/i/a" }, rewards: { verified_amount: 80, claim_threshold: 100, remaining: 20, progress_percent: 80, disabled_reason: "REFERRAL_FRAUD_REVIEW_REQUIRED" } })).toMatchObject({ verified_reward_chips: 80, claim_threshold_chips: 100, remaining_chips: 20, progress_percent: 80, claim_disabled_reason: "REFERRAL_FRAUD_REVIEW_REQUIRED" });
  expect(normalizeReferral({ referral: { claimable: true }, rewards: { claimable: false } }).claimable).toBe(false);
});

test("player promotion mutations carry idempotency keys and exact ids", async () => {
  mockFinancialPost.mockResolvedValueOnce({ data: { consent: { id: "consent-1" } } });
  await promotions.acceptOffer("campaign/1", { terms_accepted: true }, "consent-key");
  expect(mockFinancialPost).toHaveBeenCalledWith("/promotions/offers/campaign%2F1/accept", { terms_accepted: true }, { idempotencyKey: "consent-key" });

  mockFinancialPost.mockResolvedValueOnce({ data: { mission: { id: "mission-1", status: "CLAIMED" } } });
  await promotions.claimMission("mission/1", "claim-key");
  expect(mockFinancialPost).toHaveBeenLastCalledWith("/promotions/missions/mission%2F1/claim", {}, { idempotencyKey: "claim-key" });
});

test("active mission remains null when the server returns no mission", async () => {
  mockGet.mockResolvedValueOnce({ data: { mission: null } });
  await expect(promotions.activeMission()).resolves.toBeNull();
});

test("offer quotes request the exact integer deposit amount from the server", async () => {
  mockGet.mockResolvedValueOnce({ data: { offers: [] } });
  await promotions.offers(125000);
  expect(mockGet).toHaveBeenCalledWith("/promotions/offers", { params: { deposit_amount_paise: 125000 } });
});

test("player referral appeal posts only the explicit server relationship id and reason", async () => {
  mockPost.mockResolvedValueOnce({ data: { fraud_review: { status: "REJECTED", appeal_status: "PENDING" } } });
  await promotions.appealReferral("referral/1", "The relationship is legitimate and should be reviewed.");
  expect(mockPost).toHaveBeenCalledWith(
    "/promotions/referrals/referral%2F1/appeal",
    { reason: "The relationship is legitimate and should be reviewed." },
    { __noFailover: true },
  );
});
