import { CHICKEN_ROAD_API, createChickenRoadLiveClient, validateLiveState } from "./chickenRoadLiveClient";

jest.mock("@/lib/api", () => ({ financialApi: {}, createIdempotencyKey: jest.fn() }));

const rules = {
  version: "test-rules-v1", approval: "APPROVED", min_stake: 100, max_stake: 1000, stake_step: 100,
  difficulties: [{ id: "medium", label: "Medium", multipliers_hundredths: [112, 128] }],
};
const state = (overrides = {}) => ({ mode: "live", enabled: true, rules, balance: 1000, active_round: null, latest_round: null, ...overrides });
const round = (overrides = {}) => ({ id: "round-1", status: "PLAYING", version: 1, amount: 100, difficulty: "medium", lane: 1, multiplier_hundredths: 112, cashout_amount: 112, payout: 0, rules_version: rules.version, multipliers_hundredths: [112, 128], ...overrides });
const result = (operationId, overrides = {}) => ({ operation_id: operationId, result: "hopped", balance: 900, round: round(), ...overrides });
const commitment = (operationId) => ({ operation_id: operationId, commitment_id: "commit-1", server_seed_hash: "b".repeat(64), rules_version: rules.version });

function memoryStorage() {
  const values = new Map();
  return { getItem: jest.fn((key) => values.get(key) || null), setItem: jest.fn((key, value) => values.set(key, value)), removeItem: jest.fn((key) => values.delete(key)) };
}

function setup(overrides = {}) {
  let sequence = 0;
  const transport = { get: jest.fn().mockResolvedValue({ data: state() }), post: jest.fn() };
  const storage = memoryStorage();
  const options = { userId: "player-1", transport, storage, keyFactory: (kind) => `${kind}-${++sequence}`, seedFactory: jest.fn(() => "a".repeat(64)), ...overrides };
  const client = createChickenRoadLiveClient(options);
  return { client, ...options };
}

test("initial reconciliation only reads authenticated live state and never places a wager", async () => {
  const { client, transport } = setup();
  expect(await client.reconcile()).toEqual({ state: state(), pending: null, confirmed: null, rejection: null });
  expect(transport.get).toHaveBeenCalledWith(`${CHICKEN_ROAD_API}/state`, { timeout: 15000, __noFailover: true });
  expect(transport.post).not.toHaveBeenCalled();
});

test("Play persists both stages and generates its client seed only after the server commitment", async () => {
  const { client, transport, seedFactory } = setup();
  transport.post.mockImplementation(async (path, body, options) => {
    expect(client.readPending().body).toEqual(body);
    expect(options.headers["Idempotency-Key"]).toBe(body.operation_id);
    expect(options.__noFailover).toBe(true);
    expect(options.signal).toBeUndefined();
    if (path.endsWith("/prepare")) {
      expect(seedFactory).not.toHaveBeenCalled();
      return { data: commitment(body.operation_id) };
    }
    expect(seedFactory).toHaveBeenCalledTimes(1);
    expect(body).toMatchObject({ amount: 100, difficulty: "medium", client_seed: "a".repeat(64), commitment_id: "commit-1", rules_version: rules.version });
    return { data: result(body.operation_id) };
  });
  const receipt = await client.play({ amount: 100, difficulty: "medium", rulesVersion: rules.version });
  expect(receipt.balance).toBe(900);
  expect(transport.post.mock.calls.map(([path]) => path)).toEqual([`${CHICKEN_ROAD_API}/prepare`, `${CHICKEN_ROAD_API}/play`]);
  expect(client.readPending()).toBeNull();
});

test("lost Play response survives a new client and explicit retry uses the exact body and key", async () => {
  const setupValue = setup();
  const { client, transport, seedFactory } = setupValue;
  transport.post.mockImplementation(async (path, body) => {
    if (path.endsWith("/prepare")) return { data: commitment(body.operation_id) };
    throw new Error("Network timeout");
  });
  await expect(client.play({ amount: 100, difficulty: "medium", rulesVersion: rules.version })).rejects.toThrow("Network timeout");
  const saved = client.readPending();
  expect(saved.kind).toBe("play");
  const nextClient = createChickenRoadLiveClient(setupValue);
  expect(nextClient.readPending()).toEqual(saved);
  await expect(nextClient.play({ amount: 100, difficulty: "medium", rulesVersion: rules.version })).rejects.toMatchObject({ code: "CHICKEN_ROAD_PENDING" });
  transport.post.mockResolvedValueOnce({ data: result(saved.operationId) });
  expect((await nextClient.retryPending()).round.id).toBe("round-1");
  const first = transport.post.mock.calls[1];
  const retry = transport.post.mock.calls[2];
  expect(retry).toEqual(first);
  expect(seedFactory).toHaveBeenCalledTimes(1);
  expect(nextClient.readPending()).toBeNull();
});

test("a missing receipt never causes a POST or releases the pending action", async () => {
  const { client, transport } = setup();
  transport.post.mockRejectedValue(new Error("Network timeout"));
  await expect(client.advance("go", round())).rejects.toThrow();
  const saved = client.readPending();
  transport.get.mockImplementation(async (path) => ({ data: path.includes("/operations/") ? { found: false, operation_id: saved.operationId } : state({ active_round: round(), balance: 900 }) }));
  const reconciled = await client.reconcile();
  expect(reconciled.pending).toEqual(saved);
  expect(reconciled.state.balance).toBe(900);
  expect(transport.post).toHaveBeenCalledTimes(1);
});

test("accepted receipt reconciliation reads a fresh balance after confirmation and clears only its action", async () => {
  const { client, transport } = setup();
  transport.post.mockRejectedValue(new Error("Response lost"));
  await expect(client.advance("cashout", round())).rejects.toThrow();
  const saved = client.readPending();
  const settled = result(saved.operationId, { result: "cashed_out", balance: 1012, round: round({ status: "CASHED", version: 2, payout: 112, cashout_amount: 0 }) });
  transport.get.mockImplementation(async (path) => ({ data: path.includes("/operations/") ? { found: true, ...settled } : state({ balance: 1020, latest_round: settled.round }) }));
  const reconciled = await client.reconcile();
  expect(reconciled.confirmed).toEqual({ found: true, ...settled });
  expect(reconciled.state.balance).toBe(1020);
  expect(reconciled.pending).toBeNull();
  expect(transport.get.mock.calls[0][0]).toContain("/operations/");
  expect(transport.get.mock.calls[1][0]).toBe(`${CHICKEN_ROAD_API}/state`);
  expect(transport.post).toHaveBeenCalledTimes(1);
});

test("a durable rejected receipt unlocks controls without replaying or inventing a settlement", async () => {
  const { client, transport } = setup();
  transport.post.mockRejectedValue(new Error("Version conflict"));
  await expect(client.advance("go", round())).rejects.toThrow();
  const saved = client.readPending();
  const error = { status_code: 409, code: "ROUND_VERSION_CONFLICT", message: "The round changed." };
  transport.get.mockImplementation(async (path) => ({ data: path.includes("/operations/") ? { found: true, operation_id: saved.operationId, status: "REJECTED", error } : state({ active_round: round({ version: 2, lane: 2 }) }) }));
  const reconciled = await client.reconcile();
  expect(reconciled.pending).toBeNull();
  expect(reconciled.rejection).toEqual(error);
  expect(reconciled.confirmed).toBeNull();
  expect(transport.post).toHaveBeenCalledTimes(1);
});

test("recovering a preparation receipt does not automatically continue into a new wager", async () => {
  const { client, transport, seedFactory } = setup();
  transport.post.mockRejectedValue(new Error("Preparation response lost"));
  await expect(client.play({ amount: 100, difficulty: "medium", rulesVersion: rules.version })).rejects.toThrow();
  const saved = client.readPending();
  transport.get.mockImplementation(async (path) => ({ data: path.includes("/operations/") ? { found: true, ...commitment(saved.operationId) } : state() }));
  expect((await client.reconcile()).pending).toEqual(saved);
  expect(seedFactory).not.toHaveBeenCalled();
  expect(transport.post).toHaveBeenCalledTimes(1);
});

test.each(["go", "cashout"])("%s sends only the current round id and exact server version", async (kind) => {
  const { client, transport } = setup();
  transport.post.mockImplementation(async (_path, body) => ({ data: result(body.operation_id, {
    result: kind === "cashout" ? "cashed_out" : "hopped",
    round: round({ version: 8, status: kind === "cashout" ? "CASHED" : "PLAYING" }),
  }) }));
  await client.advance(kind, round({ version: 7 }));
  expect(transport.post.mock.calls[0][1]).toEqual({ operation_id: `chicken-${kind}-1`, round_id: "round-1", expected_version: 7 });
});

test("storage failure prevents sending a stake that cannot survive reload", async () => {
  const storage = memoryStorage();
  storage.setItem.mockImplementation(() => { throw new Error("Quota exceeded"); });
  const { client, transport } = setup({ storage });
  await expect(client.play({ amount: 100, difficulty: "medium", rulesVersion: rules.version })).rejects.toMatchObject({ code: "CHICKEN_ROAD_STORAGE" });
  expect(transport.post).not.toHaveBeenCalled();
});

test("pending actions are isolated by authenticated user", async () => {
  const { client, transport, storage } = setup();
  transport.post.mockRejectedValue(new Error("timeout"));
  await expect(client.advance("go", round())).rejects.toThrow();
  const other = createChickenRoadLiveClient({ userId: "player-2", transport, storage });
  expect(other.readPending()).toBeNull();
  expect(client.readPending().userId).toBe("player-1");
});

test.each([
  { mode: "demo" }, { balance: -1 }, { balance: 12.5 }, { balance: "1000" },
  { active_round: { id: "incomplete" } }, { rules: { ...rules, difficulties: [] } },
])("invalid state %p is rejected rather than replaced with a local balance or rules", (invalid) => {
  expect(() => validateLiveState(state(invalid))).toThrow();
});

test("malformed successful responses retain their key for receipt reconciliation", async () => {
  const { client, transport } = setup();
  transport.post.mockResolvedValue({ data: { result: "hopped", balance: 900 } });
  await expect(client.advance("go", round())).rejects.toThrow("could not be verified");
  expect(client.readPending().body.expected_version).toBe(1);
});
