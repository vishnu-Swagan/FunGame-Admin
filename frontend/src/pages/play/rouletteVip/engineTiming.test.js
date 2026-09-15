import { mountRoulette } from "./engine";

let root;
let engine;
let frames;
let frameId;
let perfNow;

function renderFrame(at) {
  perfNow = at;
  const pending = Array.from(frames.values());
  frames.clear();
  pending.forEach((callback) => callback(at));
}

function state(phase, secondsLeft, roundSecondsLeft, extra = {}) {
  return {
    phase, secondsLeft, roundSecondsLeft,
    roundNumber: "roulette-v2:opaque-round",
    phaseDeadlineMs: Date.now() + secondsLeft * 1000,
    roundDeadlineMs: Date.now() + roundSecondsLeft * 1000,
    ...extra,
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(1000000);
  frames = new Map();
  frameId = 0;
  perfNow = 0;
  window.matchMedia = jest.fn(() => ({ matches: false, addEventListener: jest.fn(), removeEventListener: jest.fn() }));
  jest.spyOn(performance, "now").mockImplementation(() => perfNow);
  jest.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  jest.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => frames.delete(id));
  root = document.createElement("div");
  document.body.appendChild(root);
  engine = mountRoulette(root, { soundOn: false });
  renderFrame(0);
  renderFrame(0);
});

afterEach(() => {
  engine?.destroy();
  root?.remove();
  jest.restoreAllMocks();
  jest.useRealTimers();
});

test("startup is neutral, then the default clock uses the complete 70-second round", () => {
  expect(root.querySelector("#btsec").textContent).toBe("—");
  engine.applyState(state("BETTING", 50, 70));
  expect(root.querySelector("#btsec").textContent).toBe("70");
  expect(root.querySelector("#bettimer em").textContent).toBe("BET 50s");
  expect(Number(root.querySelector("#btval").style.strokeDashoffset)).toBe(0);
  jest.advanceTimersByTime(35000);
  expect(root.querySelector("#btsec").textContent).toBe("35");
  expect(root.querySelector("#bettimer em").textContent).toBe("BET 15s");
  expect(Number(root.querySelector("#btval").style.strokeDashoffset)).toBeCloseTo(Math.PI * 28, 1);
});

test("live timing remains authoritative and local time never opens a new phase", () => {
  engine.applyState(state("SPINNING", 7, 12, { timing: { bettingSeconds: 13, spinSeconds: 7, resultSeconds: 5, roundSeconds: 25 } }));
  expect(root.querySelector("#btsec").textContent).toBe("12");
  expect(root.querySelector("#bettimer em").textContent).toBe("SPIN 7s");
  expect(Number(root.querySelector("#btval").style.strokeDashoffset)).toBeCloseTo(2 * Math.PI * 28 * (1 - 12 / 25), 1);
  jest.advanceTimersByTime(12000);
  expect(root.querySelector("#bettimer").dataset.phase).toBe("spinning");
  expect(root.querySelector("#phone").dataset.betOpen).toBe("false");
  expect(root.querySelector("#btsec").textContent).toBe("0");
});

test("late spin finishes within its remaining 200ms instead of extending into RESULT", () => {
  engine.applyState(state("SPINNING", 0.2, 10.2, { winningNumber: "17" }));
  expect(frames.size).toBe(1);
  renderFrame(199);
  expect(frames.size).toBe(1);
  renderFrame(200);
  expect(frames.size).toBe(0);
  expect(root.querySelector("#ball").classList.contains("fast")).toBe(false);
});

test("first joining during RESULT parks the supplied winner without an extra animation", () => {
  const requestCount = window.requestAnimationFrame.mock.calls.length;
  engine.applyState(state("RESULT", 10, 10, { winningNumber: "00" }));
  expect(window.requestAnimationFrame).toHaveBeenCalledTimes(requestCount);
  expect(frames.size).toBe(0);
  expect(root.querySelector("#phone").dataset.mode).toBe("result");
  expect(root.querySelector("#pocket").textContent).toBe("00");
  expect(root.querySelector("#bettimer em").textContent).toBe("NEXT 10s");
});

test("server RESULT immediately cancels an unfinished spin and preserves its pocket", () => {
  engine.applyState(state("SPINNING", 10, 20, { winningNumber: "17" }));
  renderFrame(2000);
  expect(frames.size).toBe(1);
  engine.applyState(state("RESULT", 10, 10, { winningNumber: "17" }));
  expect(frames.size).toBe(0);
  const position = root.querySelector("#ball").getAttribute("style");
  renderFrame(10000);
  expect(root.querySelector("#ball").getAttribute("style")).toBe(position);
  expect(root.querySelector("#pocket").textContent).toBe("17");
});

test("an already expired spin deadline does not launch a local replacement spin", () => {
  engine.applyState(state("SPINNING", 0, 10, { winningNumber: "17" }));
  expect(frames.size).toBe(0);
  expect(root.querySelector("#phone").dataset.betOpen).toBe("false");
});
