import React from "react";
import { act, render } from "@testing-library/react";
import Context from "../../context";
import CrashStage from ".";

jest.mock("../../sound", () => ({ playGameSound: jest.fn() }));

const value = (overrides = {}) => ({
  GameState: "",
  currentNum: "1",
  time: 0,
  latestRoundNumber: 0,
  setCurrentTarget: jest.fn(),
  ...overrides,
}) as any;

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
});
afterEach(() => jest.useRealTimers());

test("cold startup keeps a neutral synchronization gate until server state arrives", () => {
  const { container } = render(
    <Context.Provider value={value()}>
      <CrashStage />
    </Context.Provider>,
  );

  const stage = container.querySelector(".space-box");
  expect(stage?.getAttribute("data-server-state-ready")).toBe("false");
  expect(stage?.getAttribute("data-renderer-ready")).toBe("false");
  expect(stage?.getAttribute("data-renderer-mode")).toBe("pending");
  expect(container.querySelector(".aviator-renderer-gate")?.textContent).toContain("Synchronising live round");
  expect(container.querySelector(".native-flight-visual")).toBeNull();
  expect(container.querySelector(".multiplier")?.textContent).toBe("");
});

test("an authoritative round renders immediately without a WebGL startup delay", () => {
  const { container } = render(
    <Context.Provider value={value({ GameState: "GAMEEND", currentNum: "87.40", time: 12000, latestRoundNumber: 90 })}>
      <CrashStage />
    </Context.Provider>,
  );

  const stage = container.querySelector(".space-box");
  expect(stage?.getAttribute("data-server-state-ready")).toBe("true");
  expect(stage?.getAttribute("data-renderer-ready")).toBe("true");
  expect(stage?.getAttribute("data-renderer-mode")).toBe("native");
  expect(container.querySelector(".native-flight-visual")).not.toBeNull();
  expect(container.querySelector(".multiplier")?.textContent).toBe("87.40x");
  expect(container.querySelector(".round-state")?.textContent).toContain("#90");
});

test("a new round starts with no leftover curved flight trail", () => {
  const { container } = render(
    <Context.Provider value={value({ GameState: "BET", time: 1200, latestRoundNumber: 91 })}>
      <CrashStage />
    </Context.Provider>,
  );

  expect(container.querySelector(".native-flight-visual")).not.toBeNull();
  expect(container.querySelector(".flight-trail")).toBeNull();
  expect(container.querySelector('[data-flight-trail="tail-locked"]')).toBeNull();
  expect(container.querySelector(".curve-fill")).toBeNull();
  expect(container.querySelector(".curve-tip")).toBeNull();
  expect(container.querySelector(".plane.visible")).toBeNull();
});

test("a live flight advances smoothly from the compensated server time", () => {
  const setCurrentTarget = jest.fn();
  const { container } = render(
    <Context.Provider value={value({ GameState: "PLAYING", currentNum: "2.45", time: 6200, latestRoundNumber: 91, setCurrentTarget })}>
      <CrashStage />
    </Context.Provider>,
  );

  act(() => jest.advanceTimersByTime(80));

  const trail = container.querySelector('[data-flight-trail="tail-locked"]');
  const flightPlane = container.querySelector(".plane-flight");
  expect(trail).not.toBeNull();
  expect(container.querySelector(".plane.visible")).not.toBeNull();
  expect(container.querySelectorAll(".plane")).toHaveLength(1);
  expect(container.querySelector(".plane")?.getAttribute("data-flight-style")).toBe("attachment-line-art");
  expect(container.querySelector(".plane")?.getAttribute("data-aircraft-asset")).toBe("transparent-png");
  expect(container.querySelector(".aircraft-sprite.visible")).not.toBeNull();
  expect(container.querySelector(".aircraft-propeller.visible")?.getAttribute("data-propeller")).toBe("spinning");
  expect(container.querySelectorAll(".aircraft-propeller")).toHaveLength(1);
  expect(trail?.getAttribute("data-tail-x")).toBe(flightPlane?.getAttribute("data-tail-x"));
  expect(trail?.getAttribute("data-tail-y")).toBe(flightPlane?.getAttribute("data-tail-y"));
  expect(container.querySelector(".multiplier")?.textContent).toMatch(/x$/);
  expect(setCurrentTarget).toHaveBeenCalled();
});
