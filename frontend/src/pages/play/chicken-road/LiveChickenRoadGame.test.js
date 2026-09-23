import { act } from "react";
import { createRoot } from "react-dom/client";
import fs from "fs";
import path from "path";
import { randomFillSync } from "crypto";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { financialApi, createIdempotencyKey } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { createChickenRoadAudio } from "./chickenRoadAudio";
import LiveChickenRoadGame from "./LiveChickenRoadGame";

// CRA's Jest resolver predates package exports; load the real router's CJS
// build rather than mocking Link/navigation. Node supplies jsdom's missing API.
jest.mock("react-router-dom", () => {
  global.TextEncoder = require("util").TextEncoder;
  return jest.requireActual("react-router/dist/development/index.js");
}, { virtual: true });
jest.mock("@/lib/api", () => ({
  financialApi: { get: jest.fn(), post: jest.fn() },
  createIdempotencyKey: jest.fn(),
  errMsg: (error, fallback) => error?.response?.data?.detail?.message || error?.message || fallback,
}));
jest.mock("@/context/AuthContext", () => ({ useAuth: jest.fn() }));
jest.mock("./chickenRoadAudio", () => ({ createChickenRoadAudio: jest.fn() }));

const rules = {
  version: "test-live-rules-v1", approval: "APPROVED", rtp_bps: 9700,
  min_stake: 100, max_stake: 1000, stake_step: 100, max_lanes: 2,
  difficulties: [
    { id: "easy", label: "Easy", multipliers_hundredths: [106, 113] },
    { id: "medium", label: "Medium", multipliers_hundredths: [112, 128] },
    { id: "hard", label: "Hard", multipliers_hundredths: [135, 183] },
    { id: "hardcore", label: "Hardcore", multipliers_hundredths: [150, 225] },
  ],
};
const initial = (overrides = {}) => ({ mode: "live", enabled: true, balance: 1000, rules, active_round: null, latest_round: null, ...overrides });
const round = (overrides = {}) => ({ id: "live-round-1", status: "PLAYING", version: 1, lane: 1, amount: 100, difficulty: "easy", multiplier_hundredths: 106, cashout_amount: 106, payout: 0, rules_version: rules.version, multipliers_hundredths: [106, 113], ...overrides });
const receipt = (body, value = round(), balance = 900) => ({ operation_id: body.operation_id, result: value.status === "CRASHED" ? "crashed" : value.status === "CASHED" ? "cashed_out" : "hopped", balance, round: value });
const prepared = (body) => ({ operation_id: body.operation_id, commitment_id: "live-commit-1", server_seed_hash: "b".repeat(64), rules_version: rules.version });
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

let container;
let root;
let server;
let audio;
let sequence;
let user;
const setUser = jest.fn();
const originalMatchMedia = window.matchMedia;
const originalHidden = Object.getOwnPropertyDescriptor(document, "hidden");
const originalActEnvironment = global.IS_REACT_ACT_ENVIRONMENT;
const originalCrypto = Object.getOwnPropertyDescriptor(window, "crypto");

beforeAll(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(window, "crypto", { configurable: true, value: { getRandomValues: (bytes) => randomFillSync(bytes) } });
});
afterAll(() => {
  global.IS_REACT_ACT_ENVIRONMENT = originalActEnvironment;
  if (originalCrypto) Object.defineProperty(window, "crypto", originalCrypto); else delete window.crypto;
});
beforeEach(() => {
  jest.useFakeTimers(); jest.clearAllMocks();
  localStorage.clear(); sequence = 0;
  user = { id: "live-player-1", role: "PLAYER", status: "ACTIVE", chip_balance: 77777 };
  useAuth.mockImplementation(() => ({ user, loading: false, setUser }));
  createIdempotencyKey.mockImplementation((prefix) => `${prefix}-${++sequence}`);
  server = initial();
  financialApi.get.mockImplementation(async (url) => ({ data: url.includes("/operations/") ? { found: false, operation_id: decodeURIComponent(url.split("/").pop()) } : server }));
  financialApi.post.mockImplementation(async (url, body) => {
    if (url.endsWith("/prepare")) return { data: prepared(body) };
    throw new Error("Unexpected mutation");
  });
  audio = { unlock: jest.fn().mockResolvedValue(true), setMuted: jest.fn(), playWalk: jest.fn().mockReturnValue(true), playFire: jest.fn(), stopAll: jest.fn(), dispose: jest.fn() };
  createChickenRoadAudio.mockReturnValue(audio);
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  window.matchMedia = jest.fn(() => ({ matches: false, addEventListener: jest.fn(), removeEventListener: jest.fn() }));
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => {
  if (root) act(() => root.unmount());
  container.remove(); jest.clearAllTimers(); jest.useRealTimers();
  window.matchMedia = originalMatchMedia;
  if (originalHidden) Object.defineProperty(document, "hidden", originalHidden); else delete document.hidden;
});

function Lobby() {
  const { user: currentUser } = useAuth();
  return <div data-testid="lobby">{currentUser?.id}</div>;
}
const mount = async () => { await act(async () => { root.render(<MemoryRouter initialEntries={["/games/chicken-road/play"]}>
  <Routes><Route path="/games/chicken-road/play" element={<LiveChickenRoadGame />} /><Route path="/games" element={<Lobby />} /></Routes>
</MemoryRouter>); }); };
const flush = async () => { await act(async () => { await Promise.resolve(); }); };
const byId = (id) => container.querySelector(`[data-testid="${id}"]`);
const button = (text) => [...container.querySelectorAll("button")].find((element) => element.textContent === text);
const phase = () => byId("chicken-road").dataset.phase;
const click = async (element, count = 1) => { await act(async () => { for (let i = 0; i < count; i += 1) element.dispatchEvent(new MouseEvent("click", { bubbles: true })); }); };
const advance = (time = 480) => { act(() => jest.advanceTimersByTime(time)); };
const pendingAction = () => JSON.parse(localStorage.getItem("cc_chicken_road_pending_v1:live-player-1") || "null");

test("loading never substitutes an auth-cache balance, local payouts, or simulated play", async () => {
  const response = deferred(); financialApi.get.mockReturnValue(response.promise);
  await mount();
  expect(byId("road-balance").getAttribute("aria-label")).toBe("Balance unavailable");
  expect(byId("road-play").disabled).toBe(true);
  expect(container.textContent).toContain("Connecting to Chicken Road");
  expect(container.querySelectorAll('.road-segments button')).toHaveLength(0);
  expect(financialApi.post).not.toHaveBeenCalled();
  response.resolve({ data: server }); await flush();
  expect(byId("road-balance").getAttribute("aria-label")).toBe("Balance 1,000 chips");
  expect(container.textContent).not.toMatch(/demo|scripted|preview/i);
});

test("all four difficulty controls and payout labels come from server configuration", async () => {
  await mount();
  expect([...container.querySelectorAll('.road-segments button')].map((node) => node.textContent)).toEqual(["Easy", "Medium", "Hard", "Hardcore"]);
  for (const item of rules.difficulties) {
    await click(button(item.label));
    expect(button(item.label).getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector(`.road-coin[aria-label="${(item.multipliers_hundredths[0] / 100).toFixed(2)} times"]`)).not.toBeNull();
  }
  expect(container.querySelector('input[aria-label="Stake"]').value).toBe("100");
  expect(financialApi.post).not.toHaveBeenCalled();
});

test.each(["easy", "medium", "hard", "hardcore"])("%s Play waits for the server, submits once, and displays its exact money values", async (difficulty) => {
  await mount();
  const configuration = rules.difficulties.find((item) => item.id === difficulty);
  await click(button(configuration.label));
  const response = deferred(); let sent;
  financialApi.post.mockImplementation(async (url, body) => {
    if (url.endsWith("/prepare")) return { data: prepared(body) };
    sent = body; return response.promise;
  });
  await click(byId("road-play"), 2);
  expect(phase()).toBe("idle");
  expect(byId("road-balance").getAttribute("aria-label")).toBe("Balance 1,000 chips");
  expect(sent).toMatchObject({ amount: 100, difficulty, rules_version: rules.version });
  expect(sent.client_seed).toMatch(/^[0-9a-f]{64}$/);
  expect(financialApi.post).toHaveBeenCalledTimes(2);
  expect(pendingAction().body).toEqual(sent);
  const confirmed = round({ difficulty, multipliers_hundredths: configuration.multipliers_hundredths,
    multiplier_hundredths: configuration.multipliers_hundredths[0], cashout_amount: 137 });
  server = initial({ balance: 863, active_round: confirmed });
  response.resolve({ data: receipt(sent, confirmed, 863) }); await flush();
  expect(phase()).toBe("hopping");
  expect(byId("road-go").disabled).toBe(true);
  expect(byId("road-balance").getAttribute("aria-label")).toBe("Balance 863 chips");
  expect(byId("road-cashout").textContent).toContain("137");
  advance();
  expect(phase()).toBe("playing");
  expect(pendingAction()).toBeNull();
  expect(financialApi.post).toHaveBeenCalledTimes(2);
});

test("mount reconnects an active server round and cash-out sends its exact version once", async () => {
  server = initial({ balance: 900, active_round: round({ version: 7, cashout_amount: 137 }) });
  await mount();
  expect(phase()).toBe("playing");
  expect(byId("road-cashout").textContent).toContain("137");
  expect(financialApi.post).not.toHaveBeenCalled();
  financialApi.post.mockImplementation(async (_url, body) => {
    const ended = round({ status: "CASHED", version: 8, cashout_amount: 0, payout: 137 });
    server = initial({ balance: 1037, latest_round: ended });
    return { data: receipt(body, ended, 1037) };
  });
  await click(byId("road-cashout"), 2);
  expect(financialApi.post).toHaveBeenCalledTimes(1);
  expect(financialApi.post.mock.calls[0][1]).toMatchObject({ round_id: "live-round-1", expected_version: 7 });
  expect(phase()).toBe("cashed_out");
  expect(byId("road-balance").getAttribute("aria-label")).toBe("Balance 1,037 chips");
  expect(container.textContent).toContain("+137 chips");
});

test("paused new activity still allows a confirmed active round to cash out", async () => {
  server = initial({ enabled: false, balance: 900, active_round: round() });
  await mount();
  expect(container.textContent).toContain("New crossings are paused");
  expect(byId("road-go").disabled).toBe(true);
  expect(byId("road-cashout").disabled).toBe(false);
  financialApi.post.mockImplementation(async (url, body) => {
    expect(url).toBe("/live/chicken-road/cashout");
    const ended = round({ status: "CASHED", version: 2, cashout_amount: 0, payout: 106 });
    server = initial({ enabled: false, balance: 1006, latest_round: ended });
    return { data: receipt(body, ended, 1006) };
  });
  await click(byId("road-cashout"));
  expect(phase()).toBe("cashed_out");
  expect(byId("road-play").disabled).toBe(true);
  expect(financialApi.post).toHaveBeenCalledTimes(1);
});

test("a lost response and online reconnection never auto-submit or infer a collision", async () => {
  await mount();
  financialApi.post.mockImplementation(async (url, body) => {
    if (url.endsWith("/prepare")) return { data: prepared(body) };
    throw new Error("Network timeout");
  });
  await click(byId("road-play"));
  const saved = pendingAction();
  expect(saved.kind).toBe("play");
  expect(container.textContent).toContain("Connection interrupted");
  expect(phase()).toBe("idle");
  expect(byId("road-play").disabled).toBe(true);
  await act(async () => { window.dispatchEvent(new Event("online")); });
  expect(container.textContent).toContain("Action awaiting confirmation");
  expect(pendingAction()).toEqual(saved);
  expect(financialApi.post).toHaveBeenCalledTimes(2);
  expect(audio.playFire).not.toHaveBeenCalled();
  financialApi.post.mockImplementation(async (_url, body) => {
    server = initial({ balance: 900, active_round: round() });
    return { data: receipt(body) };
  });
  await click(button("Retry same action"));
  expect(financialApi.post.mock.calls[2][1]).toEqual(saved.body);
  expect(financialApi.post.mock.calls[2][2].headers["Idempotency-Key"]).toBe(saved.operationId);
  advance();
  expect(phase()).toBe("playing");
  expect(financialApi.post).toHaveBeenCalledTimes(3);
});

test("receipt recovery confirms a missed settlement without issuing another POST", async () => {
  server = initial({ balance: 900, active_round: round() });
  await mount();
  financialApi.post.mockRejectedValue(new Error("Lost cash-out response"));
  await click(byId("road-cashout"));
  const saved = pendingAction();
  const ended = round({ status: "CASHED", version: 2, cashout_amount: 0, payout: 106 });
  server = initial({ balance: 1006, latest_round: ended });
  financialApi.get.mockImplementation(async (url) => ({ data: url.includes("/operations/") ? { found: true, ...receipt(saved.body, ended, 1006) } : server }));
  await click(button("Check round"));
  expect(phase()).toBe("cashed_out");
  expect(pendingAction()).toBeNull();
  expect(financialApi.post).toHaveBeenCalledTimes(1);
  expect(byId("road-balance").getAttribute("aria-label")).toBe("Balance 1,006 chips");
});

test("unmount preserves an in-flight durable key and remount only reads reconciliation", async () => {
  await mount();
  const response = deferred(); let sent;
  financialApi.post.mockImplementation(async (url, body) => {
    if (url.endsWith("/prepare")) return { data: prepared(body) };
    sent = body; return response.promise;
  });
  await click(byId("road-play"));
  const saved = pendingAction();
  act(() => root.unmount()); root = createRoot(container);
  await mount();
  expect(pendingAction()).toEqual(saved);
  expect(financialApi.post).toHaveBeenCalledTimes(2);
  server = initial({ balance: 900, active_round: round() });
  response.resolve({ data: receipt(sent) }); await flush();
  expect(pendingAction()).toBeNull();
  await click(button("Check round"));
  expect(phase()).toBe("playing");
  expect(financialApi.post).toHaveBeenCalledTimes(2);
});

test("an unapproved backend and a disabled-service response cannot enable Play", async () => {
  server = initial({ rules: { ...rules, approval: "UNAPPROVED" } });
  await mount();
  expect(container.textContent).toContain("Chicken Road is unavailable");
  expect(byId("road-play").disabled).toBe(true);
  financialApi.get.mockRejectedValue({ response: { status: 503, data: { detail: { code: "CHICKEN_ROAD_DISABLED", message: "This game is paused." } } } });
  await click(button("Check round"));
  expect(container.textContent).toContain("Chicken Road is unavailable");
  expect(financialApi.post).not.toHaveBeenCalled();
});

test("the dormant backend's GAME_COMING_SOON response is unavailable, not a network outage", async () => {
  financialApi.get.mockRejectedValue({ response: { status: 409, data: { detail: { code: "GAME_COMING_SOON" } } } });
  await mount();
  expect(container.textContent).toContain("Chicken Road is unavailable");
  expect(container.textContent).not.toContain("Connection interrupted");
  expect(byId("road-play").disabled).toBe(true);
  expect(financialApi.post).not.toHaveBeenCalled();
});

test("a GAME_COMING_SOON recovery response does not discard an uncertain action", async () => {
  server = initial({ balance: 900, active_round: round() });
  await mount();
  financialApi.post.mockRejectedValue(new Error("Lost crossing response"));
  await click(byId("road-go"));
  const saved = pendingAction();
  financialApi.get.mockRejectedValue({ response: { status: 409, data: { detail: { code: "GAME_COMING_SOON" } } } });
  await click(button("Check round"));
  expect(container.textContent).toContain("Chicken Road is unavailable");
  expect(pendingAction()).toEqual(saved);
  expect(byId("road-go").disabled).toBe(true);
  expect(financialApi.post).toHaveBeenCalledTimes(1);
});

test("restored collision is read-only and does not replay fire or sound", async () => {
  server = initial({ balance: 900, latest_round: round({ status: "CRASHED", cashout_amount: 0, multiplier_hundredths: 0 }) });
  await mount();
  expect(phase()).toBe("crashed");
  expect(container.querySelector(".road-fx-burst")).toBeNull();
  expect(audio.playFire).not.toHaveBeenCalled();
  expect(audio.unlock).not.toHaveBeenCalled();
  expect(financialApi.post).not.toHaveBeenCalled();
});

test("GO moves and plays collision effects only after its server result is received", async () => {
  server = initial({ balance: 900, active_round: round() });
  await mount();
  const response = deferred(); let sent;
  financialApi.post.mockImplementation(async (_url, body) => { sent = body; return response.promise; });
  await click(byId("road-go"), 2);
  expect(phase()).toBe("playing");
  expect(container.querySelector(".road-character-layer").style.getPropertyValue("--lane")).toBe("1");
  expect(audio.playWalk).not.toHaveBeenCalled();
  expect(audio.playFire).not.toHaveBeenCalled();
  expect(financialApi.post).toHaveBeenCalledTimes(1);
  expect(container.querySelector(".road-fx-escape")).toBeNull();
  const collision = round({ status: "CRASHED", version: 2, lane: 2, cashout_amount: 0, multiplier_hundredths: 0 });
  server = initial({ balance: 900, latest_round: collision });
  response.resolve({ data: receipt(sent, collision) }); await flush();
  expect(phase()).toBe("hopping");
  expect(container.querySelector(".road-fx-escape")).toBeNull();
  expect(audio.playWalk).toHaveBeenCalledTimes(1);
  expect(audio.playFire).not.toHaveBeenCalled();
  advance();
  expect(phase()).toBe("crashed");
  expect(container.querySelector(".road-fx-burst")).not.toBeNull();
  expect(audio.playFire).toHaveBeenCalledTimes(1);
  expect(byId("road-balance").getAttribute("aria-label")).toBe("Balance 900 chips");
});

test("a safe departure flame waits for a confirmed safe server response", async () => {
  server = initial({ balance: 900, active_round: round() });
  await mount();
  const response = deferred(); let sent;
  financialApi.post.mockImplementation(async (_url, body) => { sent = body; return response.promise; });
  await click(byId("road-go"));
  expect(container.querySelector(".road-fx-escape")).toBeNull();
  const safe = round({ version: 2, lane: 2, multiplier_hundredths: 113, cashout_amount: 113 });
  server = initial({ balance: 900, active_round: safe });
  response.resolve({ data: receipt(sent, safe) }); await flush();
  expect(phase()).toBe("hopping");
  const burst = container.querySelector('.road-lane[data-state="passed"] .road-fx-escape');
  expect(burst).not.toBeNull();
  expect(container.querySelector('.road-lane[data-state="next"] .road-fx-burst')).toBeNull();
  advance();
  expect(phase()).toBe("playing");
  expect(container.querySelector(".road-fx-escape")).toBe(burst);
  expect(container.querySelector('[aria-label="Roasted chicken after a collision"]')).toBeNull();
  expect(audio.playFire).not.toHaveBeenCalled();
  expect(financialApi.post).toHaveBeenCalledTimes(1);
});

test("no signed-in player means no game network request and no wagering controls", async () => {
  user = null;
  await mount();
  expect(container.textContent).toContain("Sign in to play");
  expect(byId("road-play").disabled).toBe(true);
  expect(financialApi.get).not.toHaveBeenCalled();
  expect(financialApi.post).not.toHaveBeenCalled();
});

test.each([false, true])("the lobby exit stays available with an active round (pending offline action: %s)", async (offline) => {
  server = initial({ balance: 900, active_round: round() });
  await mount();
  if (offline) {
    financialApi.post.mockRejectedValue(new Error("Lost crossing response"));
    await click(byId("road-go"));
    expect(container.textContent).toContain("Connection interrupted");
    expect(byId("road-go").disabled).toBe(true);
    expect(pendingAction().kind).toBe("go");
  }
  const saved = pendingAction();
  const mutations = financialApi.post.mock.calls.length;
  await click(container.querySelector('button[aria-label="Game menu"]'));
  const exit = container.querySelector('.road-dialog a[href="/games"]');
  expect(exit.textContent).toBe("Back to lobby");
  expect(exit.hasAttribute("aria-disabled")).toBe(false);
  const locationBefore = window.location.href;
  let defaultPrevented;
  const observeClick = (event) => { defaultPrevented = event.defaultPrevented; };
  document.addEventListener("click", observeClick, { once: true });
  await act(async () => { exit.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })); });
  expect(defaultPrevented).toBe(true);
  expect(byId("lobby").textContent).toBe("live-player-1");
  expect(window.location.href).toBe(locationBefore);
  expect(byId("chicken-road")).toBeNull();
  expect(pendingAction()).toEqual(saved);
  expect(financialApi.post).toHaveBeenCalledTimes(mutations);
  act(() => root.unmount()); root = null;
  expect(pendingAction()).toEqual(saved);
  expect(financialApi.post).toHaveBeenCalledTimes(mutations);
});

test("live and neutral view modules cannot import the development simulator", () => {
  for (const file of ["LiveChickenRoadGame.js", "chickenRoadLiveClient.js", "ChickenRoadView.js"]) {
    const source = fs.readFileSync(path.join(__dirname, file), "utf8");
    expect(source).not.toMatch(/from\s+["'][^"']*(?:chickenRoadDemo|ChickenRoadGame)["']/);
    expect(source).not.toMatch(/createDemoState|transitionDemoState|MEDIUM_MULTIPLIERS/);
  }
});
