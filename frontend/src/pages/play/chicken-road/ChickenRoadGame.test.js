import { act } from "react";
import { createRoot } from "react-dom/client";
import fs from "fs";
import path from "path";
import { api } from "@/lib/api";
import ChickenRoadGame from "./ChickenRoadGame";
import { createChickenRoadAudio } from "./chickenRoadAudio";
import { MEDIUM_MULTIPLIERS } from "./chickenRoadDemo";

jest.mock("@/lib/api", () => ({ api: { get: jest.fn(), post: jest.fn() } }));
jest.mock("./chickenRoadAudio", () => ({ createChickenRoadAudio: jest.fn() }));

const HOP_MS = 480;
const SOUND_KEY = "chakri.chicken-road.sound-muted";
const originalFetch = global.fetch;
const originalMatchMedia = window.matchMedia;
const originalActEnvironment = global.IS_REACT_ACT_ENVIRONMENT;
const originalHiddenDescriptor = Object.getOwnPropertyDescriptor(document, "hidden");
let container;
let root;
let xhrOpen;
let audio;
let previousSoundPreference;

beforeAll(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  previousSoundPreference = window.localStorage.getItem(SOUND_KEY);
  window.localStorage.removeItem(SOUND_KEY);
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  createChickenRoadAudio.mockReset();
  createChickenRoadAudio.mockImplementation(() => {
    audio = {
      unlock: jest.fn().mockResolvedValue(false),
      setMuted: jest.fn(),
      playWalk: jest.fn().mockReturnValue(false),
      playFire: jest.fn().mockReturnValue(false),
      stopAll: jest.fn(),
      dispose: jest.fn(),
    };
    return audio;
  });
  global.fetch = jest.fn();
  xhrOpen = jest.spyOn(XMLHttpRequest.prototype, "open").mockImplementation(() => {});
  window.matchMedia = jest.fn(() => ({
    matches: false,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
  }));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<ChickenRoadGame />));
});

afterEach(() => {
  if (root) act(() => root.unmount());
  container.remove();
  jest.clearAllTimers();
  jest.useRealTimers();
  try {
    expect(api.get).not.toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(xhrOpen).not.toHaveBeenCalled();
  } finally {
    xhrOpen.mockRestore();
    global.fetch = originalFetch;
    window.matchMedia = originalMatchMedia;
    if (originalHiddenDescriptor) Object.defineProperty(document, "hidden", originalHiddenDescriptor);
    else delete document.hidden;
    if (previousSoundPreference === null) window.localStorage.removeItem(SOUND_KEY);
    else window.localStorage.setItem(SOUND_KEY, previousSoundPreference);
  }
});

afterAll(() => {
  global.IS_REACT_ACT_ENVIRONMENT = originalActEnvironment;
});

function element(selector) {
  const result = container.querySelector(selector);
  if (!result) throw new Error(`Expected rendered element: ${selector}`);
  return result;
}

const byTestId = (id) => element(`[data-testid="${id}"]`);
const phase = () => byTestId("chicken-road").dataset.phase;
const stakeInput = () => element('input[aria-label="Demo stake"]');
const difficultyButtons = () => [...container.querySelectorAll('[role="group"][aria-label="Difficulty"] button')];
const difficultyButton = (label) => difficultyButtons().find((button) => button.textContent === label);

function click(button, count = 1) {
  act(() => {
    for (let index = 0; index < count; index += 1) {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }
  });
}

function advance(milliseconds = HOP_MS) {
  act(() => jest.advanceTimersByTime(milliseconds));
}

function setStake(value) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  act(() => {
    const input = stakeInput();
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function expectBalance(credits) {
  expect(byTestId("road-balance").getAttribute("aria-label")).toBe(`Demo balance ${credits} credits`);
}

function playAndLand() {
  click(byTestId("road-play"));
  advance();
}

function setDocumentHidden(hidden) {
  Object.defineProperty(document, "hidden", { configurable: true, value: hidden });
  act(() => document.dispatchEvent(new Event("visibilitychange")));
}

function deferredUnlock() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

test("initial screen identifies a scripted demo with no wallet or network dependency", () => {
  expect(phase()).toBe("idle");
  expectBalance("1,000");
  expect(stakeInput().value).toBe("3");
  expect(byTestId("road-play").disabled).toBe(false);
  expect(difficultyButton("Medium").getAttribute("aria-pressed")).toBe("true");
  expect(container.textContent).toContain("Demo credits only");
  expect(container.textContent).toContain("Scripted outcomes, not real odds");
  expect(container.textContent).toContain("No money or wallet connection");
  expect(container.querySelectorAll(".road-fx-ambient")).toHaveLength(MEDIUM_MULTIPLIERS.length);
  for (const file of ["ChickenRoadGame.js", "chickenRoadDemo.js"]) {
    const source = fs.readFileSync(path.join(__dirname, file), "utf8");
    expect(source).not.toMatch(/\bfrom\s+["'][^"']*(?:\/api|axios|wallet|auth)[^"']*["']/);
    expect(source).not.toMatch(/\b(?:fetch|XMLHttpRequest|WebSocket)\s*\(/);
  }
});

test("Play attempts lane one and reveals its 1.12 multiplier after the 480 ms crossing", () => {
  click(byTestId("road-play"));
  expect(phase()).toBe("hopping");
  expect(byTestId("road-go").disabled).toBe(true);
  expect(byTestId("road-cashout").disabled).toBe(true);
  expect(container.querySelector('.road-coin[aria-label="1.12 times, current multiplier"]')).toBeNull();
  advance(HOP_MS - 1);
  expect(phase()).toBe("hopping");
  advance(1);
  expect(phase()).toBe("playing");
  expectBalance("997");
  expect(element('.road-coin[aria-label="1.12 times, current multiplier"]')).toBeTruthy();
  expect(byTestId("road-cashout").textContent).toContain("3.36");
  expect(byTestId("road-go").disabled).toBe(false);
  expect(container.querySelector('.road-lane[data-state="current"] .road-fx-ambient')).toBeNull();
  expect(container.querySelector('.road-lane[data-state="next"] .road-fx-ambient')).not.toBeNull();
});

test("two Play clicks in one act start only one crossing and deduct only one stake", () => {
  click(byTestId("road-play"), 2);
  expect(phase()).toBe("hopping");
  expect(jest.getTimerCount()).toBe(1);
  advance();
  expect(phase()).toBe("playing");
  expectBalance("997");
  expect(element('.road-coin[aria-label="1.12 times, current multiplier"]')).toBeTruthy();
  expect(container.querySelectorAll('.road-lane[data-state="passed"]')).toHaveLength(0);
});

test("two GO clicks in one act advance one lane without another stake deduction", () => {
  playAndLand();
  click(byTestId("road-go"), 2);
  expect(phase()).toBe("hopping");
  expect(jest.getTimerCount()).toBe(1);
  advance();
  expectBalance("997");
  expect(element('.road-coin[aria-label="1.28 times, current multiplier"]')).toBeTruthy();
  expect(container.querySelectorAll('.road-lane[data-state="passed"]')).toHaveLength(1);
  expect(byTestId("road-cashout").textContent).toContain("3.84");
});

test("stake, presets, limits, and difficulty remain locked during movement and an active round", () => {
  click(byTestId("road-play"));
  const lockedControls = () => [...container.querySelectorAll(".road-stake button, .road-stake input, .road-segments button")];
  expect(lockedControls().every((control) => control.disabled)).toBe(true);
  advance();
  expect(lockedControls().every((control) => control.disabled)).toBe(true);
  click(difficultyButton("Hard"));
  expect(difficultyButton("Medium").getAttribute("aria-pressed")).toBe("true");
  expect(stakeInput().value).toBe("3");
  click(byTestId("road-cashout"));
  expect(lockedControls().every((control) => !control.disabled)).toBe(true);
});

test("rapid cash-out clicks credit 3.36 once and show a completed result", () => {
  playAndLand();
  click(byTestId("road-cashout"), 2);
  expect(phase()).toBe("cashed_out");
  expectBalance("1,000.36");
  expect(element('[role="status"]').textContent).toContain("1.12x · Cashed out");
  expect(element('[role="status"]').textContent).toContain("+3.36 demo credits");
  expect(container.querySelector('[data-testid="road-cashout"]')).toBeNull();
  expect(container.querySelector('[data-testid="road-go"]')).toBeNull();
  expect(byTestId("road-play").disabled).toBe(false);
  advance(HOP_MS * 3);
  expectBalance("1,000.36");
});

test("Hard explains missing rules and disables Play until Medium is restored", () => {
  click(difficultyButton("Hard"));
  expect(difficultyButton("Hard").getAttribute("aria-pressed")).toBe("true");
  expect(element('[role="alert"]').textContent).toContain("odds and payout table are not supplied");
  expect(byTestId("road-play").disabled).toBe(true);
  click(byTestId("road-play"));
  expect(phase()).toBe("idle");
  expectBalance("1,000");
  expect(jest.getTimerCount()).toBe(0);
  click(difficultyButton("Medium"));
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(byTestId("road-play").disabled).toBe(false);
});

test("scripted lane-six collision renders the crash, the next first hop crashes, and a third round can start", () => {
  playAndLand();
  for (let lane = 2; lane <= 6; lane += 1) {
    click(byTestId("road-go"));
    expect(phase()).toBe("hopping");
    advance();
  }
  expect(phase()).toBe("crashed");
  expectBalance("997");
  expect(container.querySelectorAll('.road-lane[data-state="crashed"]')).toHaveLength(1);
  expect(container.querySelectorAll('.road-lane[data-state="crashed"] .road-fx-contour')).toHaveLength(4);
  expect(container.querySelector('.road-lane[data-state="crashed"] .road-fx-ambient')).toBeNull();
  expect(element('[aria-label="Roasted chicken after a collision"]')).toBeTruthy();
  expect(element('[role="status"]').textContent).toContain("Oh, cluck!");
  expect(byTestId("road-play").disabled).toBe(false);

  click(byTestId("road-play"));
  expect(phase()).toBe("hopping");
  expect(container.querySelector('[aria-label="Roasted chicken after a collision"]')).toBeNull();
  advance();
  expect(phase()).toBe("crashed");
  expectBalance("994");
  expect(element(".road-character-layer").style.getPropertyValue("--lane")).toBe("1");
  expect(container.querySelectorAll('.road-lane[data-state="passed"]')).toHaveLength(0);

  playAndLand();
  expect(phase()).toBe("playing");
  expectBalance("991");
  expect(element('.road-coin[aria-label="1.12 times, current multiplier"]')).toBeTruthy();
  click(byTestId("road-cashout"));
  expectBalance("994.36");
});

test("Last demo round updates when a cash-out is followed by a collision", () => {
  playAndLand();
  click(byTestId("road-cashout"));
  expect(element(".road-history").textContent).toBe("Last demo round: +3.36 credits");
  playAndLand();
  expect(phase()).toBe("crashed");
  expect(element(".road-history").textContent).toBe("Last demo round: collision");
});

test.each([
  ["cashed_out", 1, "997.36"],
  ["crashed", 6, "994"],
])("replay after %s at lane %i commits the home position before its single next crossing", (previousPhase, previousLane, finalBalance) => {
  playAndLand();
  if (previousPhase === "cashed_out") {
    click(byTestId("road-cashout"));
  } else {
    for (let lane = 2; lane <= previousLane; lane += 1) {
      click(byTestId("road-go"));
      advance();
    }
  }
  expect(phase()).toBe(previousPhase);
  expect(element(".road-character-layer").style.getPropertyValue("--lane")).toBe(String(previousLane));
  expect(jest.getTimerCount()).toBe(0);

  const game = byTestId("chicken-road");
  const originalRead = game.getBoundingClientRect.bind(game);
  const committedFrames = [];
  const layoutRead = jest.spyOn(game, "getBoundingClientRect").mockImplementation(() => {
    committedFrames.push({
      lane: element(".road-character-layer").style.getPropertyValue("--lane"),
      camera: element(".road-track").style.getPropertyValue("--camera"),
      resetting: game.classList.contains("is-resetting"),
      hopping: element(".road-character-layer").classList.contains("is-hopping"),
      phase: game.dataset.phase,
    });
    return originalRead();
  });
  try {
    click(byTestId("road-play"));
    expect(layoutRead).toHaveBeenCalledTimes(1);
    expect(committedFrames).toEqual([{ lane: "0", camera: "0", resetting: true, hopping: false, phase: "idle" }]);
    expect(game.classList.contains("is-resetting")).toBe(false);
    expect(phase()).toBe("hopping");
    expect(element(".road-character-layer").style.getPropertyValue("--lane")).toBe("1");
    expect(jest.getTimerCount()).toBe(1);
    advance(HOP_MS - 1);
    expect(phase()).toBe("hopping");
    advance(1);
    expect(phase()).toBe("crashed");
    expect(element(".road-character-layer").style.getPropertyValue("--lane")).toBe("1");
    expectBalance(finalBalance);
    expect(jest.getTimerCount()).toBe(0);
    advance();
    expectBalance(finalBalance);
    expect(layoutRead).toHaveBeenCalledTimes(1);
  } finally {
    layoutRead.mockRestore();
  }
});

test("compact-screen camera remains one lane across after the second 480 ms crossing", () => {
  window.matchMedia.mockImplementation((query) => ({
    media: query,
    matches: query === "(max-width: 600px)",
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
  }));
  act(() => root.render(<ChickenRoadGame key="compact-screen" />));
  expect(window.matchMedia).toHaveBeenCalledWith("(max-width: 600px)");
  expect(window.matchMedia).toHaveBeenCalledWith("(prefers-reduced-motion: reduce)");
  expect(element(".road-track").style.getPropertyValue("--camera")).toBe("0");
  click(byTestId("road-play"));
  advance(HOP_MS - 1);
  expect(phase()).toBe("hopping");
  advance(1);
  expect(phase()).toBe("playing");
  expect(element(".road-track").style.getPropertyValue("--camera")).toBe("0");
  click(byTestId("road-go"));
  expect(phase()).toBe("hopping");
  expect(element(".road-track").style.getPropertyValue("--camera")).toBe("1");
  advance();
  expect(phase()).toBe("playing");
  expect(element(".road-track").style.getPropertyValue("--camera")).toBe("1");
  expect(element(".road-character-layer").style.getPropertyValue("--lane")).toBe("2");
});

test("the fourth scripted round crosses 6.91 to 8.90 and automatically cashes out once", () => {
  for (const collisionLane of [6, 1, 4]) {
    playAndLand();
    for (let lane = 2; lane <= collisionLane; lane += 1) {
      click(byTestId("road-go"));
      advance();
    }
    expect(phase()).toBe("crashed");
    expect(element(".road-character-layer").style.getPropertyValue("--lane")).toBe(String(collisionLane));
  }
  expectBalance("991");
  playAndLand();
  for (let lane = 2; lane < MEDIUM_MULTIPLIERS.length; lane += 1) {
    click(byTestId("road-go"));
    advance();
  }
  expect(phase()).toBe("playing");
  expectBalance("988");
  expect(element('.road-coin[aria-label="6.91 times, current multiplier"]')).toBeTruthy();
  expect(byTestId("road-cashout").textContent).toContain("20.73");
  click(byTestId("road-go"));
  expect(phase()).toBe("hopping");
  advance();
  expect(phase()).toBe("cashed_out");
  expectBalance("1,014.7");
  expect(element('.road-coin[aria-label="8.90 times, current multiplier"]')).toBeTruthy();
  expect(element('[role="status"]').textContent).toContain("+26.7 demo credits");
  expect(byTestId("road-play").disabled).toBe(false);
  expect(container.querySelector('[data-testid="road-cashout"]')).toBeNull();
  expect(container.querySelector('[data-testid="road-go"]')).toBeNull();
  expect(jest.getTimerCount()).toBe(0);
  advance(HOP_MS * 2);
  expectBalance("1,014.7");
});

test.each(["", "0", "0.99", "-3", "1.001", "1001", "not-a-number"])("invalid or unaffordable stake %p disables Play", (value) => {
  setStake(value);
  expect(byTestId("road-play").disabled).toBe(true);
  click(byTestId("road-play"));
  expect(phase()).toBe("idle");
  expectBalance("1,000");
  expect(jest.getTimerCount()).toBe(0);
});

test("minimum, maximum, and preset controls choose valid demo-credit amounts", () => {
  setStake("0.50");
  click(element('[aria-label="Minimum demo stake"]'));
  expect(stakeInput().value).toBe("1");
  expect(byTestId("road-play").disabled).toBe(false);
  click(element('[aria-label="Maximum demo stake"]'));
  expect(stakeInput().value).toBe("1000");
  expect(byTestId("road-play").disabled).toBe(false);
  click(element(".road-presets button"));
  expect(stakeInput().value).toBe("2");
  playAndLand();
  expectBalance("998");
  expect(byTestId("road-cashout").textContent).toContain("2.24");
});

test("help opens with focus in the dialog and Escape restores focus to its trigger", () => {
  const help = element('[aria-label="How to play"]');
  help.focus();
  click(help);
  const dialog = element('[role="dialog"]');
  expect(dialog.getAttribute("aria-modal")).toBe("true");
  expect(document.getElementById(dialog.getAttribute("aria-labelledby")).textContent).toBe("How to play");
  expect(dialog.textContent).toContain("The chicken attempts the first lane");
  expect(document.activeElement).toBe(element('[aria-label="Close dialog"]'));
  act(() => document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(help);
});

test.each([
  ["How to play", "How to play"],
  ["Preview rules & limits", "About this preview"],
])("switching Game menu to %s keeps focus inside the dialog and restores the original trigger on Escape", (linkText, expectedTitle) => {
  const menuTrigger = element('[aria-label="Game menu"]');
  menuTrigger.focus();
  click(menuTrigger);
  const menuDialog = element('[role="dialog"]');
  const menuLink = [...menuDialog.querySelectorAll("button")].find((button) => button.textContent === linkText);
  expect(menuLink).toBeTruthy();
  // MouseEvent dispatch does not apply a browser's native focus behavior.
  // Focus the menu link so removing it exercises the actual focus-loss bug.
  menuLink.focus();
  expect(document.activeElement).toBe(menuLink);
  click(menuLink);
  const nextDialog = element('[role="dialog"]');
  expect(document.getElementById(nextDialog.getAttribute("aria-labelledby")).textContent).toBe(expectedTitle);
  expect(nextDialog.contains(document.activeElement)).toBe(true);
  expect(document.activeElement).toBe(element('[aria-label="Close dialog"]'));
  act(() => document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(menuTrigger);
});

test("unmounting during a crossing cancels its pending settlement timer", () => {
  click(byTestId("road-play"));
  expect(jest.getTimerCount()).toBe(1);
  act(() => root.unmount());
  root = null;
  expect(jest.getTimerCount()).toBe(0);
  expect(() => advance()).not.toThrow();
  expect(container.childElementCount).toBe(0);
});

test("mount is silent and opening help does not unlock or play audio", () => {
  expect(createChickenRoadAudio).toHaveBeenCalledTimes(1);
  expect(audio.setMuted).toHaveBeenCalledWith(false);
  expect(audio.unlock).not.toHaveBeenCalled();
  expect(audio.playWalk).not.toHaveBeenCalled();
  expect(audio.playFire).not.toHaveBeenCalled();
  expect(audio.stopAll).not.toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(0);
  click(element('[aria-label="How to play"]'));
  expect(audio.unlock).not.toHaveBeenCalled();
  expect(audio.playWalk).not.toHaveBeenCalled();
  expect(audio.playFire).not.toHaveBeenCalled();
});

test("a valid Play gesture unlocks walking audio once despite same-act duplicate clicks", async () => {
  audio.unlock.mockResolvedValue(true);
  audio.playWalk.mockReturnValue(true);
  click(byTestId("road-play"), 2);
  await act(async () => { await Promise.resolve(); });
  // Drain React's queued act microtasks without advancing the crossing clock.
  advance(0);
  expect(audio.stopAll).toHaveBeenCalledTimes(1);
  expect(audio.unlock).toHaveBeenCalledTimes(1);
  expect(audio.playWalk).toHaveBeenCalledTimes(1);
  expect(audio.playWalk).toHaveBeenCalledWith(HOP_MS);
  expect(audio.playFire).not.toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(1);
  advance();
  click(byTestId("road-go"), 2);
  await act(async () => { await Promise.resolve(); });
  advance(0);
  expect(audio.unlock).toHaveBeenCalledTimes(2);
  expect(audio.playWalk).toHaveBeenCalledTimes(2);
  expect(jest.getTimerCount()).toBe(1);
});

test("a pending successful unlock starts walking while the original crossing is still active", async () => {
  const pending = deferredUnlock();
  audio.unlock.mockReturnValueOnce(pending.promise);
  click(byTestId("road-play"));
  expect(audio.playWalk).toHaveBeenCalledTimes(1);
  expect(audio.playWalk).toHaveLastReturnedWith(false);
  audio.playWalk.mockReturnValue(true);
  await act(async () => {
    pending.resolve(true);
    await Promise.resolve();
  });
  advance(0);
  expect(phase()).toBe("hopping");
  expect(audio.unlock).toHaveBeenCalledTimes(1);
  expect(audio.playWalk).toHaveBeenCalledTimes(2);
  expect(audio.playWalk).toHaveLastReturnedWith(true);
  const remainingDuration = audio.playWalk.mock.calls[1][0];
  expect(remainingDuration).toBeGreaterThan(60);
  expect(remainingDuration).toBeLessThanOrEqual(HOP_MS);
  expect(jest.getTimerCount()).toBe(1);
  advance();
  expect(phase()).toBe("playing");
  expect(audio.playWalk).toHaveBeenCalledTimes(2);
});

test("collision plays fire once only after the crossing completes", () => {
  audio.playWalk.mockReturnValue(true);
  playAndLand();
  expect(audio.playFire).not.toHaveBeenCalled();
  click(byTestId("road-cashout"));
  click(byTestId("road-play"), 2);
  expect(phase()).toBe("hopping");
  expect(audio.playFire).not.toHaveBeenCalled();
  advance(HOP_MS - 1);
  expect(audio.playFire).not.toHaveBeenCalled();
  advance(1);
  expect(phase()).toBe("crashed");
  expect(audio.playFire).toHaveBeenCalledTimes(1);
  advance(HOP_MS * 3);
  expect(audio.playFire).toHaveBeenCalledTimes(1);
});

test("muting through Game menu persists the choice and suppresses walking and fire", () => {
  click(element('[aria-label="Game menu"]'));
  click(element('[aria-label="Mute game sounds"]'));
  expect(audio.setMuted).toHaveBeenLastCalledWith(true);
  expect(window.localStorage.getItem(SOUND_KEY)).toBe("true");
  expect(element('[aria-label="Turn game sounds on"]').getAttribute("aria-pressed")).toBe("false");
  click(element('[aria-label="Close dialog"]'));
  playAndLand();
  click(byTestId("road-cashout"));
  playAndLand();
  expect(phase()).toBe("crashed");
  expect(audio.unlock).not.toHaveBeenCalled();
  expect(audio.playWalk).not.toHaveBeenCalled();
  expect(audio.playFire).not.toHaveBeenCalled();

  const previousAudio = audio;
  act(() => root.render(<ChickenRoadGame key="saved-mute" />));
  expect(previousAudio.dispose).toHaveBeenCalledTimes(1);
  expect(audio).not.toBe(previousAudio);
  expect(audio.setMuted).toHaveBeenCalledWith(true);
  click(element('[aria-label="Game menu"]'));
  click(element('[aria-label="Turn game sounds on"]'));
  expect(audio.setMuted).toHaveBeenLastCalledWith(false);
  expect(audio.unlock).toHaveBeenCalledTimes(1);
  expect(window.localStorage.getItem(SOUND_KEY)).toBe("false");
  expect(audio.playWalk).not.toHaveBeenCalled();
  expect(audio.playFire).not.toHaveBeenCalled();
});

test("hiding the tab stops audio and an old unlock cannot resume walking after it returns", async () => {
  const pending = deferredUnlock();
  audio.unlock.mockReturnValueOnce(pending.promise);
  click(byTestId("road-play"));
  expect(audio.playWalk).toHaveBeenCalledTimes(1);
  expect(audio.playWalk).toHaveLastReturnedWith(false);
  expect(audio.stopAll).toHaveBeenCalledTimes(1);
  setDocumentHidden(true);
  expect(byTestId("chicken-road").classList.contains("is-background")).toBe(true);
  expect(audio.stopAll).toHaveBeenCalledTimes(2);
  setDocumentHidden(false);
  expect(byTestId("chicken-road").classList.contains("is-background")).toBe(false);
  await act(async () => {
    pending.resolve(true);
    await Promise.resolve();
  });
  expect(phase()).toBe("hopping");
  expect(audio.playWalk).toHaveBeenCalledTimes(1);
  expect(audio.unlock).toHaveBeenCalledTimes(1);
  advance();
  expect(phase()).toBe("playing");
  expect(audio.playFire).not.toHaveBeenCalled();
});

test("a collision resolved in a hidden tab stays silent when the tab returns", () => {
  audio.playWalk.mockReturnValue(true);
  playAndLand();
  click(byTestId("road-cashout"));
  click(byTestId("road-play"));
  setDocumentHidden(true);
  advance();
  expect(phase()).toBe("crashed");
  expect(audio.playFire).not.toHaveBeenCalled();
  setDocumentHidden(false);
  advance();
  expect(audio.playFire).not.toHaveBeenCalled();
});

test("unmount disposes audio, removes visibility handling, and cancels a pending unlock", async () => {
  const pending = deferredUnlock();
  audio.unlock.mockReturnValueOnce(pending.promise);
  click(byTestId("road-play"));
  expect(audio.playWalk).toHaveBeenCalledTimes(1);
  act(() => root.unmount());
  root = null;
  expect(audio.dispose).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(0);
  const stopsAtUnmount = audio.stopAll.mock.calls.length;
  setDocumentHidden(true);
  setDocumentHidden(false);
  expect(audio.stopAll).toHaveBeenCalledTimes(stopsAtUnmount);
  await act(async () => {
    pending.resolve(true);
    await Promise.resolve();
  });
  expect(audio.playWalk).toHaveBeenCalledTimes(1);
  expect(audio.playFire).not.toHaveBeenCalled();
  expect(audio.dispose).toHaveBeenCalledTimes(1);
});

test("blink animation is enabled only after its SVG image loads and disabled on error", () => {
  const chicken = element(".road-chicken--alive");
  const blink = element("image.road-chicken-frame--blink");
  expect(chicken.classList.contains("has-blink")).toBe(false);
  expect(blink.getAttribute("href")).toBe("/games/chicken-road/chicken-blink.png");
  act(() => blink.dispatchEvent(new Event("load", { bubbles: true })));
  expect(chicken.classList.contains("has-blink")).toBe(true);
  act(() => blink.dispatchEvent(new Event("error", { bubbles: true })));
  expect(chicken.classList.contains("has-blink")).toBe(false);
});

test("a collision replaces the blinking character with the roast and removes its blink image", () => {
  act(() => element("image.road-chicken-frame--blink").dispatchEvent(new Event("load", { bubbles: true })));
  expect(element(".road-chicken--alive").classList.contains("has-blink")).toBe(true);
  playAndLand();
  click(byTestId("road-cashout"));
  playAndLand();
  expect(phase()).toBe("crashed");
  expect(container.querySelector(".road-chicken--alive")).toBeNull();
  expect(container.querySelector("image.road-chicken-frame--blink")).toBeNull();
  expect(element('[aria-label="Roasted chicken after a collision"]')).toBeTruthy();
});
