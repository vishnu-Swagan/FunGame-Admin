import { financialApi, financialPost } from "@/lib/api";

const ROOT = "/promotions";

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function integer(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

export function clampPromotionPercent(value) {
  return Math.min(100, Math.max(0, integer(value)));
}

export function isPromotionPolicyVersion(value) {
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/.test(String(value || ""));
}

export function normalizeOffer(raw) {
  const offer = object(raw);
  const reward = object(offer.reward);
  const rules = object(offer.contribution_rules || offer.rules);
  const quote = object(offer.quote);
  const jurisdictions = Array.isArray(offer.jurisdictions) ? offer.jurisdictions : [];
  const terms = Array.isArray(offer.significant_terms)
    ? offer.significant_terms
    : offer.terms_text ? [String(offer.terms_text)] : [];
  return {
    ...offer,
    id: String(offer.id || offer.campaign_id || ""),
    campaign_id: String(offer.campaign_id || offer.id || ""),
    campaign_version: integer(offer.campaign_version || offer.version, 1),
    name: String(offer.name || offer.title || "Bonus mission"),
    description: String(offer.description || offer.terms_text || "Complete qualifying play to unlock the separate reward."),
    terms_version: String(offer.terms_version || ""),
    jurisdiction: String(offer.jurisdiction || (jurisdictions.length === 1 ? jurisdictions[0] : "")),
    jurisdictions,
    deposit_amount_paise: integer(quote.deposit_amount_paise ?? offer.deposit_amount_paise ?? offer.minimum_deposit_paise),
    deposit_chips: integer(quote.deposit_chips ?? offer.deposit_chips),
    target_chips: integer(quote.target_chips ?? offer.target_chips ?? offer.wager_target_chips),
    wager_multiplier_bps: integer(offer.wager_multiplier_bps),
    duration_hours: integer(offer.duration_hours),
    claim_finality_hours: integer(offer.claim_finality_hours),
    settlement_finality_policy_version: String(offer.settlement_finality_policy_version || ""),
    deadline_at: quote.deadline_preview_at || offer.deadline_at || null,
    rate_version: String(quote.rate_version || offer.rate_version || ""),
    quote_token: String(quote.quote_token || offer.quote_token || ""),
    quote_expires_at: quote.quote_expires_at || offer.quote_expires_at || null,
    timezone: String(offer.timezone || "UTC"),
    reward: {
      type: String(reward.type || offer.reward_type || "BONUS_CHIPS"),
      chips: integer(reward.chips ?? offer.reward_chips),
      paise: integer(reward.paise ?? offer.reward_paise),
    },
    contribution_rules: {
      default_bps: integer(rules.default_bps, 10000),
      game_bps: object(rules.game_bps),
      max_qualifying_stake_chips: integer(rules.max_qualifying_stake_chips),
      allowed_games: Array.isArray(rules.allowed_games) ? rules.allowed_games : [],
      excluded_games: Array.isArray(rules.excluded_games) ? rules.excluded_games : [],
      eligible_source_buckets: Array.isArray(rules.eligible_source_buckets) ? rules.eligible_source_buckets : [],
    },
    significant_terms: terms,
    withdrawal_consequence: String(offer.withdrawal_consequence || offer.forfeit_disclosure || "Deposited cash remains withdrawable. Only an unearned reward may be forfeited under the accepted terms."),
  };
}

export function normalizeMission(raw) {
  if (!raw || typeof raw !== "object") return null;
  const mission = object(raw);
  const progress = object(mission.progress);
  const reward = object(mission.reward);
  const deposit = object(mission.deposit);
  const rules = object(mission.contribution_rules);
  const settled = integer(progress.settled_chips ?? mission.settled_contribution_chips);
  const pending = integer(progress.pending_chips ?? mission.pending_settlement_chips);
  const target = integer(progress.target_chips ?? mission.target_chips);
  const finality = object(mission.claim_finality);
  const status = String(mission.status || "ACTIVE").toUpperCase();
  return {
    ...mission,
    id: String(mission.id || mission.mission_id || ""),
    status,
    campaign_id: String(mission.campaign_id || ""),
    campaign_version: integer(mission.campaign_version, 1),
    terms_version: String(mission.terms_version || ""),
    settlement_finality_policy_version: String(mission.settlement_finality_policy_version || finality.policy_version || ""),
    jurisdiction: String(mission.jurisdiction || ""),
    activated_at: mission.activated_at || null,
    deadline_at: mission.deadline_at || null,
    timezone: String(mission.timezone || "UTC"),
    server_time: mission.server_time || null,
    deposit: {
      id: String(deposit.id || mission.deposit_id || ""),
      chips: integer(deposit.chips || mission.deposit_chips),
      amount_paise: integer(deposit.amount_paise || mission.deposit_amount_paise),
    },
    reward: {
      type: String(reward.type || mission.reward_type || "BONUS_CHIPS"),
      chips: integer(reward.chips ?? mission.reward_chips),
      paise: integer(reward.paise ?? mission.reward_paise),
    },
    progress: {
      target_chips: target,
      settled_chips: settled,
      pending_chips: pending,
      remaining_chips: integer(progress.remaining_chips ?? mission.remaining_chips, Math.max(0, target - settled)),
      percent: clampPromotionPercent(progress.percent ?? mission.progress_percent),
      percent_basis_points: integer(progress.percent_basis_points),
    },
    // Eligibility is fail-closed and server-owned. A displayed 100% value or a
    // stray boolean must never bypass the persisted mission state.
    claimable: status === "CLAIMABLE" && mission.claimable === true,
    claim_finality: {
      status: String(finality.status || "NOT_STARTED").toUpperCase(),
      window_hours: integer(finality.window_hours),
      policy_version: String(finality.policy_version || mission.settlement_finality_policy_version || ""),
      target_achieved_at: finality.target_achieved_at || null,
      started_at: finality.started_at || null,
      finality_at: finality.finality_at || null,
      satisfied_at: finality.satisfied_at || null,
      reason: finality.reason ? String(finality.reason) : null,
      remaining_seconds: Math.max(0, integer(finality.remaining_seconds)),
    },
    forfeit_allowed: mission.forfeit_allowed === true,
    contribution_rules: {
      default_bps: integer(rules.default_bps, 10000),
      game_bps: object(rules.game_bps),
      max_qualifying_stake_chips: integer(rules.max_qualifying_stake_chips),
      allowed_games: Array.isArray(rules.allowed_games) ? rules.allowed_games : [],
      excluded_games: Array.isArray(rules.excluded_games) ? rules.excluded_games : [],
      eligible_source_buckets: Array.isArray(rules.eligible_source_buckets) ? rules.eligible_source_buckets : [],
    },
  };
}

export function normalizeReferral(raw) {
  if (!raw || typeof raw !== "object") return null;
  const value = object(raw);
  const profile = object(value.referral || value.profile || value);
  const rewards = object(value.rewards || profile.rewards);
  const progress = object(value.progress || rewards.progress);
  return {
    ...profile,
    invite_code: String(profile.invite_code || value.invite_code || ""),
    invite_url: String(profile.invite_url || value.invite_url || profile.referral_url || value.referral_url || ""),
    verified_reward_chips: integer(rewards.verified_amount ?? value.verified_reward_chips ?? value.verified_chips ?? progress.verified_chips),
    pending_reward_chips: integer(rewards.pending_amount ?? value.pending_reward_chips ?? value.pending_chips ?? progress.pending_chips),
    claim_threshold_chips: integer(rewards.claim_threshold ?? value.claim_threshold_chips ?? value.threshold_chips ?? progress.target_chips),
    remaining_chips: integer(rewards.remaining ?? value.remaining_chips ?? progress.remaining_chips),
    progress_percent: clampPromotionPercent(rewards.progress_percent ?? value.progress_percent ?? progress.percent),
    claimable: rewards.claimable === true,
    claim_disabled_reason: String(rewards.disabled_reason || rewards.claim_disabled_reason || value.claim_disabled_reason || "Complete and verify the required tasks before claiming."),
    tasks: Array.isArray(value.tasks) ? value.tasks : [],
  };
}

export const promotions = {
  async offers(depositAmountPaise) {
    const params = Number.isSafeInteger(Number(depositAmountPaise)) && Number(depositAmountPaise) > 0
      ? { deposit_amount_paise: Number(depositAmountPaise) }
      : {};
    const { data } = await financialApi.get(`${ROOT}/offers`, { params });
    const rows = data?.offers || data?.items || [];
    return Array.isArray(rows) ? rows.map(normalizeOffer) : [];
  },
  async acceptOffer(campaignId, body, idempotencyKey) {
    const { data } = await financialPost(`${ROOT}/offers/${encodeURIComponent(campaignId)}/accept`, body, { idempotencyKey });
    return data?.consent || data;
  },
  async activeMission() {
    const { data } = await financialApi.get(`${ROOT}/missions/active`);
    const value = data && Object.prototype.hasOwnProperty.call(data, "mission") ? data.mission : data;
    return normalizeMission(value);
  },
  async mission(id) {
    const { data } = await financialApi.get(`${ROOT}/missions/${encodeURIComponent(id)}`);
    return {
      mission: normalizeMission(data?.mission || data),
      events: Array.isArray(data?.events) ? data.events : [],
    };
  },
  async claimMission(id, idempotencyKey) {
    const { data } = await financialPost(`${ROOT}/missions/${encodeURIComponent(id)}/claim`, {}, { idempotencyKey });
    return { ...data, mission: normalizeMission(data?.mission) };
  },
  async forfeitMission(id, reason, idempotencyKey) {
    const { data } = await financialPost(`${ROOT}/missions/${encodeURIComponent(id)}/forfeit`, { reason }, { idempotencyKey });
    return { ...data, mission: normalizeMission(data?.mission) };
  },
  async referral() {
    const { data } = await financialApi.get(`${ROOT}/referrals/me`);
    return normalizeReferral(data);
  },
  async referralTasks() {
    const { data } = await financialApi.get(`${ROOT}/referrals/tasks`);
    const rows = data?.tasks || data?.items || [];
    return Array.isArray(rows) ? rows : [];
  },
  async claimReferral(idempotencyKey) {
    const { data } = await financialPost(`${ROOT}/referrals/claim`, {}, { idempotencyKey });
    return { ...data, referral: normalizeReferral(data?.referral) };
  },
  async appealReferral(referralId, reason) {
    const { data } = await financialApi.post(
      `${ROOT}/referrals/${encodeURIComponent(referralId)}/appeal`,
      { reason },
      { __noFailover: true },
    );
    return data;
  },
};
