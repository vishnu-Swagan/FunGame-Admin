import { createIdempotencyKey, financialApi } from "@/lib/api";

export const CHICKEN_ROAD_API = "/live/chicken-road";
const STORAGE_PREFIX = "cc_chicken_road_pending_v1:";
const REQUEST_OPTIONS = { timeout: 15000, __noFailover: true };
const ACTIONS = new Set(["prepare", "play", "go", "cashout"]);
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const identifier = (value) => typeof value === "string" && value.length > 0;

function problem(message, code = "CHICKEN_ROAD_PROTOCOL") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function validateLadder(ladder) {
  if (!Array.isArray(ladder) || !ladder.length || ladder.length > 100 || !ladder.every((value) => integer(value) && value >= 100)) {
    throw problem("The game returned an invalid payout table. Please reconnect.");
  }
}

export function validateLiveRound(round) {
  if (!round || !identifier(round.id) || !["PLAYING", "CRASHED", "CASHED"].includes(round.status)
    || !integer(round.version) || round.version < 1 || !integer(round.lane) || round.lane < 1 || !integer(round.amount) || round.amount < 1
    || !identifier(round.difficulty) || !integer(round.multiplier_hundredths)
    || !integer(round.cashout_amount) || !integer(round.payout)) {
    throw problem("The round could not be verified. Reconnect before continuing.");
  }
  validateLadder(round.multipliers_hundredths);
  if (round.lane > round.multipliers_hundredths.length) throw problem("The server returned an invalid lane.");
  return round;
}

export function validateLiveState(state) {
  if (!state || state.mode !== "live" || typeof state.enabled !== "boolean" || !integer(state.balance)) {
    throw problem("The live game is unavailable. Please reconnect.");
  }
  const rules = state.rules;
  if (!rules || !identifier(rules.version) || !integer(rules.min_stake) || !integer(rules.max_stake)
    || rules.min_stake < 1 || rules.max_stake < rules.min_stake || !integer(rules.stake_step) || rules.stake_step < 1
    || !Array.isArray(rules.difficulties) || !rules.difficulties.length) {
    throw problem("The game rules could not be verified. Please reconnect.");
  }
  const ids = new Set();
  rules.difficulties.forEach((difficulty) => {
    if (!identifier(difficulty.id) || !identifier(difficulty.label) || ids.has(difficulty.id)) throw problem("The difficulty settings are invalid.");
    ids.add(difficulty.id);
    validateLadder(difficulty.multipliers_hundredths);
  });
  if (state.active_round) {
    validateLiveRound(state.active_round);
    if (state.active_round.status !== "PLAYING") throw problem("The active round could not be verified.");
  }
  if (state.latest_round) validateLiveRound(state.latest_round);
  return state;
}

function defaultStorage() {
  try { return window.localStorage; } catch { return null; }
}

function clientSeed() {
  const secureCrypto = typeof window === "undefined" ? null : window.crypto;
  if (!secureCrypto?.getRandomValues) throw problem("Secure randomness is unavailable in this browser.", "CHICKEN_ROAD_BROWSER");
  const bytes = new Uint8Array(32);
  secureCrypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

/** Canonical authenticated transport with one durable, exact action per user.
 * Requests deliberately outlive their React caller; an unmount never erases an
 * uncertain stake. Reconciliation performs GETs only. Replaying a POST requires
 * a fresh explicit retry and retains its original operation id and body.
 */
export function createChickenRoadLiveClient({ userId, transport = financialApi, storage = defaultStorage(), keyFactory = createIdempotencyKey, seedFactory = clientSeed } = {}) {
  if (!identifier(userId)) throw problem("Sign in to play Chicken Road.", "CHICKEN_ROAD_AUTH");
  const storageKey = `${STORAGE_PREFIX}${encodeURIComponent(userId)}`;

  const readPending = () => {
    try {
      if (!storage) throw new Error("Storage is unavailable");
      const raw = storage.getItem(storageKey);
      if (!raw) return null;
      const saved = JSON.parse(raw);
      if (saved?.schema !== 1 || saved.userId !== userId || !ACTIONS.has(saved.kind)
        || !identifier(saved.operationId) || saved.body?.operation_id !== saved.operationId) throw new Error("Invalid pending action");
      return saved;
    } catch {
      throw problem("Your pending action cannot be read safely. Enable local storage and reconnect before playing.", "CHICKEN_ROAD_STORAGE");
    }
  };

  const savePending = (pending) => {
    try {
      if (!storage) throw new Error("Storage is unavailable");
      const serialized = JSON.stringify(pending);
      storage.setItem(storageKey, serialized);
      if (storage.getItem(storageKey) !== serialized) throw new Error("Storage did not persist the action");
    } catch {
      throw problem("This browser cannot safely save your action. Enable local storage before placing a stake.", "CHICKEN_ROAD_STORAGE");
    }
  };

  const clearPending = (operationId) => {
    // A late response must not erase a newer action or another user's intent.
    if (readPending()?.operationId === operationId) storage.removeItem(storageKey);
  };

  const createPending = (kind, body, intent) => {
    const operationId = keyFactory(`chicken-${kind}`);
    const pending = { schema: 1, userId, kind, operationId, body: { ...body, operation_id: operationId }, ...(intent ? { intent } : {}) };
    savePending(pending);
    return pending;
  };

  const assertNoPending = () => {
    if (readPending()) throw problem("Check the previous action before starting another.", "CHICKEN_ROAD_PENDING");
  };

  const getState = async () => {
    const { data } = await transport.get(`${CHICKEN_ROAD_API}/state`, REQUEST_OPTIONS);
    return validateLiveState(data);
  };

  const receipt = async (operationId) => {
    const { data } = await transport.get(`${CHICKEN_ROAD_API}/operations/${encodeURIComponent(operationId)}`, REQUEST_OPTIONS);
    if (!data || data.operation_id !== operationId || typeof data.found !== "boolean") throw problem("The action receipt could not be verified.");
    return data;
  };

  const validateMutation = (data, pending) => {
    if (!data || data.operation_id !== pending.operationId || !integer(data.balance)
      || !["hopped", "crashed", "cashed_out"].includes(data.result)) throw problem("The action response could not be verified. Check its status before continuing.");
    validateLiveRound(data.round);
    if (data.round.status !== { hopped: "PLAYING", crashed: "CRASHED", cashed_out: "CASHED" }[data.result]) throw problem("The result and round do not match. Check the action receipt.");
    if (pending.kind === "cashout" && data.result !== "cashed_out") throw problem("The cash-out receipt could not be verified.");
    if (pending.kind === "play" && (data.round.amount !== pending.body.amount || data.round.difficulty !== pending.body.difficulty)) throw problem("The stake receipt does not match your action.");
    if (pending.kind !== "play" && data.round.id !== pending.body.round_id) throw problem("The receipt belongs to a different round.");
    return data;
  };

  const checkPreparation = (data, pending) => {
    if (pending.kind !== "prepare" || !data || data.operation_id !== pending.operationId
      || !identifier(data.commitment_id) || !identifier(data.server_seed_hash)
      || !identifier(data.rules_version) || !identifier(pending.intent?.rules_version)) {
      throw problem("The seed commitment could not be verified. Check the pending action.");
    }
    if (data.rules_version === pending.intent.rules_version) return null;
    // Only a confirmed, unchanged PREPARE can be retired: its /play request
    // has not been created or dispatched. Never clear a money action here.
    const current = readPending();
    if (JSON.stringify(current) !== JSON.stringify(pending)) throw problem("The pending action changed. Reconnect before continuing.");
    clearPending(pending.operationId);
    return {
      code: "CHICKEN_ROAD_RULES_CHANGED",
      message: "The rules changed before this play was submitted. Review the updated rules and press Play again.",
    };
  };

  const postPending = async (pending) => {
    const { data } = await transport.post(`${CHICKEN_ROAD_API}/${pending.kind}`, pending.body, {
      ...REQUEST_OPTIONS,
      headers: { "Idempotency-Key": pending.operationId },
    });
    if (pending.kind === "prepare") {
      const changed = checkPreparation(data, pending);
      if (changed) throw problem(changed.message, changed.code);
      if (readPending()?.operationId !== pending.operationId) throw problem("The pending action changed. Reconnect before continuing.");
      // The server commitment exists before this browser generates its seed.
      const next = createPending("play", {
        commitment_id: data.commitment_id,
        client_seed: seedFactory(),
        amount: pending.intent.amount,
        difficulty: pending.intent.difficulty,
        rules_version: pending.intent.rules_version,
      });
      return postPending(next);
    }
    validateMutation(data, pending);
    clearPending(pending.operationId);
    return data;
  };

  const play = async ({ amount, difficulty, rulesVersion }) => {
    assertNoPending();
    if (!integer(amount) || amount < 1 || !identifier(difficulty) || !identifier(rulesVersion)) throw problem("Choose a valid stake and difficulty.");
    const pending = createPending("prepare", {}, { amount, difficulty, rules_version: rulesVersion });
    return postPending(pending);
  };

  const advance = async (kind, round) => {
    assertNoPending();
    if (!["go", "cashout"].includes(kind)) throw problem("Unknown round action.");
    validateLiveRound(round);
    if (round.status !== "PLAYING") throw problem("This round has already ended.");
    return postPending(createPending(kind, { round_id: round.id, expected_version: round.version }));
  };

  const retryPending = async () => {
    const pending = readPending();
    if (!pending) throw problem("There is no pending action to retry.");
    return postPending(pending);
  };

  const reconcile = async () => {
    const pending = readPending();
    let rejection = null;
    let confirmed = null;
    if (pending) {
      const found = await receipt(pending.operationId);
      if (found.found && readPending()?.operationId === pending.operationId) {
        if (found.status === "REJECTED") {
          if (!identifier(found.error?.message) || !identifier(found.error?.code)) throw problem("The rejected action receipt could not be verified.");
          rejection = found.error;
          clearPending(pending.operationId);
        } else if (pending.kind !== "prepare") {
          confirmed = validateMutation(found, pending);
          clearPending(pending.operationId);
        } else {
          rejection = checkPreparation(found, pending);
        }
      }
    }
    // Read after the receipt so an older balance cannot overwrite settlement.
    const state = await getState();
    return { state, pending: readPending(), confirmed, rejection };
  };

  return { getState, readPending, play, advance, retryPending, reconcile };
}
