import { act } from "react";
import { createRoot } from "react-dom/client";
import fs from "fs";
import path from "path";
import { randomFillSync } from "crypto";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { financialApi, createIdempotencyKey } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { createChickenRoadAudio } from "./chickenRoadAudio";
import { verifyChickenRoadFairness } from "./chickenRoadFairness";
import LiveChickenRoadGame from "./LiveChickenRoadGame";
import { RoadDialog } from "./ChickenRoadView";

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
jest.mock("./chickenRoadFairness", () => ({ ...jest.requireActual("./chickenRoadFairness"), verifyChickenRoadFairness: jest.fn() }));

const fullLadders = {
  easy: [106, 113, 120, 127, 134, 142, 151, 160, 169, 180, 190, 202, 214],
  medium: [112, 128, 147, 170, 198, 233, 276, 332, 403, 496, 620, 691, 890],
  hard: [135, 183, 247, 333, 449, 606, 818, 1104, 1490, 2011, 2715, 3665, 4947],
  hardcore: [150, 225, 338, 507, 760, 1140, 1709, 2563, 3845, 5767, 8650, 12975, 19462],
};

const rules = {
  version: "chicken-road-proposal-v2", approval: "APPROVED", rtp_bps: 9000,
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
const originalWidth = window.innerWidth;
const originalHeight = window.innerHeight;
const originalOrientation = Object.getOwnPropertyDescriptor(window.screen, "orientation");

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
  verifyChickenRoadFairness.mockReset();
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
  window.innerWidth = 1024; window.innerHeight = 768;
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => {
  if (root) act(() => root.unmount());
  container.remove(); jest.clearAllTimers(); jest.useRealTimers();
  window.matchMedia = originalMatchMedia;
  window.innerWidth = originalWidth; window.innerHeight = originalHeight;
  if (originalOrientation) Object.defineProperty(window.screen, "orientation", originalOrientation); else delete window.screen.orientation;
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
const orient = (width, height) => act(() => {
  window.innerWidth = width; window.innerHeight = height;
  window.dispatchEvent(new Event("resize"));
});

test("portrait requires rotation and returning to landscape never starts or duplicates a wager", async () => {
  orient(390, 844);
  await mount();
  expect(byId("road-landscape-prompt").textContent).toContain("Rotate your device");
  expect(container.querySelector('.road-viewport').hidden).toBe(true);
  expect(container.querySelector('.road-dock').hidden).toBe(true);
  expect(byId("road-play").disabled).toBe(true);
  expect(document.activeElement.textContent).toBe("Rotate your device");
  await click(byId("road-play"));
  expect(financialApi.post).not.toHaveBeenCalled();
  const reads = financialApi.get.mock.calls.length;

  orient(844, 390);
  expect(byId("road-landscape-prompt")).toBeNull();
  expect(container.querySelector('.road-dock').hidden).toBe(false);
  expect(byId("road-play").disabled).toBe(false);
  orient(390, 844); orient(844, 390);
  expect(financialApi.get).toHaveBeenCalledTimes(reads);
  expect(financialApi.post).not.toHaveBeenCalled();
  expect(createChickenRoadAudio).toHaveBeenCalledTimes(1);
});

test("a touch device keyboard cannot make portrait count as a physical landscape rotation", async () => {
  const orientation = { type: "portrait-primary", addEventListener: jest.fn(), removeEventListener: jest.fn() };
  Object.defineProperty(window.screen, "orientation", { configurable: true, value: orientation });
  window.matchMedia = jest.fn((query) => ({ matches: query === "(pointer: coarse)", addEventListener: jest.fn(), removeEventListener: jest.fn() }));
  orient(390, 300); // The keyboard has reduced the available height.
  await mount();
  expect(byId("road-landscape-prompt")).not.toBeNull();
  expect(byId("road-play").disabled).toBe(true);
  orientation.type = "landscape-primary";
  orient(844, 390);
  expect(byId("road-landscape-prompt")).toBeNull();
  expect(byId("road-play").disabled).toBe(false);
  expect(financialApi.post).not.toHaveBeenCalled();
});

test("rotation preserves the confirmed round and offers cash-out without a crossing in portrait", async () => {
  server = initial({ balance: 900, active_round: round({ version: 7, cashout_amount: 137 }) });
  await mount();
  orient(390, 844);
  expect(byId("road-go").disabled).toBe(true);
  expect(byId("road-portrait-cashout").disabled).toBe(false);
  expect(byId("road-portrait-cashout").textContent).toContain("137");
  await click(byId("road-go"));
  expect(financialApi.post).not.toHaveBeenCalled();
  financialApi.post.mockImplementation(async (url, body) => {
    expect(url).toBe("/live/chicken-road/cashout");
    const ended = round({ status: "CASHED", version: 8, cashout_amount: 0, payout: 137 });
    server = initial({ balance: 1037, latest_round: ended });
    return { data: receipt(body, ended, 1037) };
  });
  await click(byId("road-portrait-cashout"), 2);
  expect(financialApi.post).toHaveBeenCalledTimes(1);
  expect(financialApi.post.mock.calls[0][1]).toMatchObject({ round_id: "live-round-1", expected_version: 7 });
  expect(byId("road-portrait-cashout")).toBeNull();
  const visibleResult = byId("road-landscape-prompt").querySelector('.road-landscape-result[role="status"]');
  expect(visibleResult.textContent).toContain("Cashed out");
  expect(visibleResult.textContent).toContain("+137 chips");
  expect(container.querySelectorAll('.road-landscape-result, .road-result.success')).toHaveLength(1);
  orient(844, 390);
  expect(phase()).toBe("cashed_out");
  expect(byId("road-balance").textContent).toContain("1,037");
});

test("portrait retains an uncertain crossing for GET reconciliation but cannot retry it until landscape", async () => {
  server = initial({ balance: 900, active_round: round() });
  await mount();
  financialApi.post.mockRejectedValue(new Error("Lost crossing response"));
  await click(byId("road-go"));
  const saved = pendingAction();
  orient(390, 844);
  expect(byId("road-landscape-prompt").textContent).toContain("Pending action: one crossing");
  expect(button("Retry same action")).toBeUndefined();
  await click(button("Check round"));
  expect(pendingAction()).toEqual(saved);
  expect(financialApi.post).toHaveBeenCalledTimes(1);
  orient(844, 390);
  expect(button("Retry same action")).toBeDefined();
  expect(pendingAction()).toEqual(saved);
  expect(financialApi.post).toHaveBeenCalledTimes(1);
});

test("portrait can retry only the original pending cashout without another wager", async () => {
  server = initial({ balance: 900, active_round: round() });
  await mount();
  financialApi.post.mockRejectedValue(new Error("Lost cash-out response"));
  await click(byId("road-cashout"));
  const saved = pendingAction();
  orient(390, 844);
  expect(button("Retry same action")).toBeDefined();
  expect(byId("road-portrait-cashout").disabled).toBe(true);
  financialApi.post.mockImplementation(async (url, body) => {
    expect(url).toBe("/live/chicken-road/cashout");
    const ended = round({ status: "CASHED", version: 2, cashout_amount: 0, payout: 106 });
    server = initial({ balance: 1006, latest_round: ended });
    return { data: receipt(body, ended, 1006) };
  });
  await click(button("Retry same action"));
  expect(financialApi.post).toHaveBeenCalledTimes(2);
  expect(financialApi.post.mock.calls[1][1]).toEqual(saved.body);
  expect(financialApi.post.mock.calls[1][2].headers["Idempotency-Key"]).toBe(saved.operationId);
  expect(pendingAction()).toBeNull();
  expect(byId("road-portrait-cashout")).toBeNull();
});

test("an in-flight crossing completes once after rotating without losing its receipt", async () => {
  server = initial({ balance: 900, active_round: round() });
  await mount();
  const response = deferred(); let sent;
  financialApi.post.mockImplementation(async (_url, body) => { sent = body; return response.promise; });
  await click(byId("road-go"));
  const saved = pendingAction();
  orient(390, 844);
  expect(pendingAction()).toEqual(saved);
  const advanced = round({ version: 2, lane: 2, multiplier_hundredths: 113, cashout_amount: 113 });
  server = initial({ balance: 900, active_round: advanced });
  response.resolve({ data: receipt(sent, advanced) }); await flush(); advance();
  expect(byId("road-portrait-cashout").textContent).toContain("113");
  expect(pendingAction()).toBeNull();
  expect(financialApi.post).toHaveBeenCalledTimes(1);
  orient(844, 390);
  expect(byId("road-cashout").textContent).toContain("113");
  expect(financialApi.post).toHaveBeenCalledTimes(1);
});

test("portrait shows a collision only after an in-flight crossing is confirmed", async () => {
  server = initial({ balance: 900, active_round: round() });
  await mount();
  const response = deferred(); let sent;
  financialApi.post.mockImplementation(async (_url, body) => { sent = body; return response.promise; });
  await click(byId("road-go"));
  orient(390, 844);
  expect(byId("road-landscape-prompt").querySelector('.road-landscape-result')).toBeNull();
  const crashed = round({ status: "CRASHED", version: 2, lane: 2, multiplier_hundredths: 0, cashout_amount: 0 });
  server = initial({ balance: 900, latest_round: crashed });
  response.resolve({ data: receipt(sent, crashed) }); await flush();
  expect(byId("road-landscape-prompt").querySelector('.road-landscape-result')).toBeNull();
  advance();
  const result = byId("road-landscape-prompt").querySelector('.road-landscape-result[role="status"]');
  expect(result.textContent).toContain("The crossing ended");
  expect(result.textContent).not.toContain("Cashed out");
  expect(byId("road-portrait-cashout")).toBeNull();
  expect(financialApi.post).toHaveBeenCalledTimes(1);
});

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

test("rules disclose every conditional lane risk and inactivity settlement without placing a wager", async () => {
  server = initial({ rules: { ...rules, max_lanes: 13, difficulties: rules.difficulties.map((item) => ({ ...item, multipliers_hundredths: fullLadders[item.id] })) } });
  await mount();
  expect(container.querySelector('.road-risk [title]').title).toBe("Next lane 1 collision: 15.09% (16/106)");
  await click(button("Game rules"));
  const text = container.querySelector('[role="dialog"]').textContent;
  expect(text).toContain("After 15 minutes without a crossing or cash-out");
  expect(text).toContain("Reconnecting does not reset that deadline");
  expect(text).toContain("19.64% (22/112)");
  expect(text).toContain("33.33% (45/135)");
  expect(text).toContain("40.00% (60/150)");
  expect(text.match(/Lane 13:/g)).toHaveLength(4);
  expect(text).toContain("not independent certification");
  expect(button("Verify last round")).toBeUndefined();
  expect(financialApi.post).not.toHaveBeenCalled();
  expect(financialApi.get.mock.calls.every(([url]) => !url.endsWith("/fairness"))).toBe(true);
});

test("an active historical round discloses risk from its locked table rather than new-round configuration", async () => {
  server = initial({ active_round: round({ rules_version: "chicken-road-proposal-v1", multipliers_hundredths: fullLadders.easy }) });
  await mount();
  expect(container.querySelector('.road-risk [title]').title).toBe("Next lane 2 collision: 6.19% (7/113)");
  await click(container.querySelector('button[aria-label="How to play"]'));
  expect(container.querySelector('[role="dialog"]').textContent).toContain("under your round's locked rules (chicken-road-proposal-v1)");
  expect(button("Verify last round")).toBeUndefined();
  expect(financialApi.post).not.toHaveBeenCalled();
});

test("terminal proof checks are read-only, bind the known round, and show success only after verification", async () => {
  const terminal = round({ status: "CASHED", version: 2, cashout_amount: 0, payout: 106 });
  server = initial({ latest_round: terminal });
  const proof = { round_id: terminal.id, server_seed: "a".repeat(64) };
  financialApi.get.mockImplementation(async (url) => ({ data: url.endsWith("/fairness") ? proof : server }));
  const verification = deferred();
  verifyChickenRoadFairness.mockReturnValueOnce(verification.promise);
  await mount();
  await click(button("Game rules"));
  await click(button("Verify last round"));
  expect(button("Checking proof…").disabled).toBe(true);
  expect(container.textContent).not.toContain("Verified mathematical consistency");
  expect(verifyChickenRoadFairness).toHaveBeenCalledWith(proof, terminal);
  verification.resolve({ checkedLanes: 1, payout: 106 }); await flush();
  expect(container.textContent).toContain("Verified mathematical consistency for 1 attempted lane(s)");
  expect(container.textContent).toContain("recorded payout of 106 chips");
  expect(financialApi.get).toHaveBeenCalledWith("/live/chicken-road/rounds/live-round-1/fairness", { timeout: 15000, __noFailover: true });
  expect(financialApi.post).not.toHaveBeenCalled();
});

test("a final proof disclosure stays in the reusable dialog keyboard focus cycle", async () => {
  act(() => root.render(<RoadDialog title="Round verification" onClose={jest.fn()}>
    <button>Verify last round</button><details><summary>Revealed proof</summary><pre>Verified evidence</pre></details>
  </RoadDialog>));
  const verify = button("Verify last round");
  const summary = container.querySelector('.road-dialog summary');
  const close = container.querySelector('button[aria-label="Close dialog"]');
  expect(summary.textContent).toBe("Revealed proof");
  // This jsdom version lacks native summary focusability. Match the browser's
  // built-in tab stop without changing the production disclosure markup.
  summary.tabIndex = 0;

  verify.focus();
  const forward = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
  act(() => verify.dispatchEvent(forward));
  // jsdom does not perform native Tab movement. It must remain unprevented
  // here so the browser can move from Verify to the following summary.
  expect(forward.defaultPrevented).toBe(false);
  summary.focus();
  expect(document.activeElement).toBe(summary);
  const wrapForward = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
  act(() => summary.dispatchEvent(wrapForward));
  expect(wrapForward.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(close);

  const wrapBackward = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
  act(() => close.dispatchEvent(wrapBackward));
  expect(wrapBackward.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(summary);
  await click(summary);
  expect(summary.parentElement.open).toBe(true);
  expect(financialApi.post).not.toHaveBeenCalled();
});

test.each(["network", "verification"])("a %s failure does not present a verified round or change funds", async (failureKind) => {
  server = initial({ latest_round: round({ status: "CRASHED", cashout_amount: 0, multiplier_hundredths: 0 }) });
  financialApi.get.mockImplementation(async (url) => {
    if (url.endsWith("/fairness")) {
      if (failureKind === "network") throw new Error("Proof unavailable");
      return { data: { round_id: "live-round-1" } };
    }
    return { data: server };
  });
  verifyChickenRoadFairness.mockRejectedValueOnce(new Error("Commitment mismatch"));
  await mount();
  await click(button("Game rules"));
  await click(button("Verify last round"));
  expect(container.textContent).toContain("Not verified:");
  expect(container.textContent).not.toContain("Verified mathematical consistency");
  expect(byId("road-balance").getAttribute("aria-label")).toBe("Balance 1,000 chips");
  expect(financialApi.post).not.toHaveBeenCalled();
});

test("Game rules displays the server's 90% RTP and all four unchanged payout ladders", async () => {
  await mount();
  await click(button("Game rules"));
  const dialog = container.querySelector('[role="dialog"]');
  expect(dialog.textContent).toContain("Theoretical return to player: 90%.");
  expect(dialog.textContent).not.toContain("97%");
  expect(dialog.textContent).toContain("This is a long-run average, not a promise for an individual round.");
  for (const configuration of rules.difficulties) {
    expect(dialog.textContent).toContain(`${configuration.label}: ${configuration.multipliers_hundredths.map((value) => `${(value / 100).toFixed(2)}×`).join(" · ")}`);
  }
  expect(financialApi.post).not.toHaveBeenCalled();
});

test("an older active round keeps its payout and distinguishes new-round rules", async () => {
  server = initial({ balance: 900, active_round: round({ rules_version: "chicken-road-proposal-v1" }) });
  await mount();
  expect(byId("road-cashout").textContent).toContain("106");
  expect(container.querySelector('.road-coin[aria-label="1.06 times, current multiplier"]')).not.toBeNull();
  await click(button("Game rules"));
  const dialog = container.querySelector('[role="dialog"]');
  expect(dialog.textContent).toContain("Rules for new rounds");
  expect(dialog.textContent).toContain("Your current round uses its locked rules (chicken-road-proposal-v1)");
  expect(dialog.textContent).toContain("The rules below apply only to new rounds; your current payout table and cash-out amount are unchanged.");
  expect(dialog.textContent).toContain("Theoretical return to player: 90%.");
  expect(financialApi.post).not.toHaveBeenCalled();
});

test("stale preparation refreshes rules without a stake and requires a new Play gesture", async () => {
  server = initial({ rules: { ...rules, version: "chicken-road-proposal-v1", rtp_bps: 9700 } });
  await mount();
  server = initial();
  await click(byId("road-play"));
  expect(financialApi.post).toHaveBeenCalledTimes(1);
  expect(financialApi.post.mock.calls[0][0]).toBe("/live/chicken-road/prepare");
  expect(pendingAction()).toBeNull();
  expect(container.textContent).toContain("Review the updated rules and press Play again.");
  expect(byId("road-play").disabled).toBe(false);
  expect(byId("road-balance").getAttribute("aria-label")).toBe("Balance 1,000 chips");
  await click(button("Game rules"));
  expect(container.querySelector('[role="dialog"]').textContent).toContain("Theoretical return to player: 90%.");
  await click(container.querySelector('[aria-label="Close dialog"]'));
  financialApi.post.mockImplementation(async (url, body) => {
    if (url.endsWith("/prepare")) return { data: prepared(body) };
    server = initial({ balance: 900, active_round: round() });
    return { data: receipt(body) };
  });
  await click(byId("road-play"));
  expect(financialApi.post).toHaveBeenCalledTimes(3);
  expect(financialApi.post.mock.calls[1][1].operation_id).not.toBe(financialApi.post.mock.calls[0][1].operation_id);
  expect(financialApi.post.mock.calls[2][1].rules_version).toBe("chicken-road-proposal-v2");
  advance();
  expect(phase()).toBe("playing");
});

test("a failed rule refresh after stale preparation stays locked without auto-submitting", async () => {
  server = initial({ rules: { ...rules, version: "chicken-road-proposal-v1", rtp_bps: 9700 } });
  await mount();
  server = initial();
  financialApi.get.mockRejectedValueOnce(new Error("State offline"));
  await click(byId("road-play"));
  expect(pendingAction()).toBeNull();
  expect(byId("road-play").disabled).toBe(true);
  expect(container.textContent).toContain("Reconnect to load the current rules.");
  expect(financialApi.post).toHaveBeenCalledTimes(1);
  await click(button("Check round"));
  expect(byId("road-play").disabled).toBe(false);
  expect(financialApi.post).toHaveBeenCalledTimes(1);
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

test.each([
  ["CHICKEN_ROAD_WALLET_UNAVAILABLE", 503, "Wallet service is temporarily unavailable"],
  ["CHICKEN_ROAD_WALLET_RECONCILIATION_REQUIRED", 409, "Your wallet needs a review"],
  ["CHICKEN_ROAD_STORAGE_UNAVAILABLE", 409, "Chicken Road is unavailable"],
])("%s explains the service/account problem without claiming a lost connection", async (code, status, title) => {
  const message = "Wallet account needs support before live play.";
  financialApi.get.mockRejectedValue({ response: { status, data: { detail: { code, message } } } });
  await mount();
  expect(container.textContent).toContain(title);
  expect(container.querySelector('.road-connection').textContent).toContain(message);
  expect(container.textContent).not.toContain("Connection interrupted");
  expect(byId("road-play").disabled).toBe(true);
  orient(390, 844);
  expect(byId("road-landscape-prompt").textContent).toContain(title);
  expect(byId("road-landscape-prompt").textContent).toContain(message);
  expect(financialApi.post).not.toHaveBeenCalled();
});

test("a network error still reports interruption and keeps wagering disabled", async () => {
  financialApi.get.mockRejectedValue(new Error("Network unavailable"));
  await mount();
  expect(container.textContent).toContain("Connection interrupted");
  expect(container.textContent).not.toContain("Your wallet needs a review");
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
  for (const file of ["LiveChickenRoadGame.js", "chickenRoadLiveClient.js", "chickenRoadFairness.js", "ChickenRoadView.js"]) {
    const source = fs.readFileSync(path.join(__dirname, file), "utf8");
    expect(source).not.toMatch(/from\s+["'][^"']*(?:chickenRoadDemo|ChickenRoadGame)["']/);
    expect(source).not.toMatch(/createDemoState|transitionDemoState|MEDIUM_MULTIPLIERS/);
  }
  const app = fs.readFileSync(path.resolve(__dirname, "../../../App.js"), "utf8");
  expect(app).toMatch(/process\.env\.NODE_ENV === "development"\s*\? require\("@\/pages\/play\/chicken-road\/ChickenRoadGame"\)/);
  expect(app).toMatch(/if \(process\.env\.NODE_ENV === "development" && window\.location\.pathname === "\/__preview\/chicken-road"\)/);
  const gameplay = fs.readFileSync(path.resolve(__dirname, "../GamePlay.js"), "utf8");
  expect(gameplay).toContain('"chicken-road": LiveChickenRoadGame');
  expect(gameplay).not.toMatch(/from\s+["'][^"']*\/ChickenRoadGame["']/);
});
