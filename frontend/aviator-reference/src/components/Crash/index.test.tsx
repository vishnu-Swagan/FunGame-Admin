import React from "react";
import fs from "fs";
import path from "path";
import { act, render } from "@testing-library/react";
import Context from "../../context";
import CrashStage, { flightCurveValue, flightGeometryFor, interpolateVisualProgress } from ".";

jest.mock("../../sound", () => ({ playGameSound: jest.fn() }));

const originalRequestAnimationFrame = window.requestAnimationFrame;
const originalCancelAnimationFrame = window.cancelAnimationFrame;
const originalMatchMedia = window.matchMedia;
let animationFrameCallbacks = new Map<number, FrameRequestCallback>();
let nextAnimationFrameId = 1;

const flushAnimationFrame = (timestamp: number) => {
  const callbacks = Array.from(animationFrameCallbacks.values());
  animationFrameCallbacks.clear();
  callbacks.forEach((callback) => callback(timestamp));
};

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
  animationFrameCallbacks = new Map();
  nextAnimationFrameId = 1;
  Object.defineProperty(window, "requestAnimationFrame", {
    configurable: true,
    value: jest.fn((callback: FrameRequestCallback) => {
      const animationFrameId = nextAnimationFrameId++;
      animationFrameCallbacks.set(animationFrameId, callback);
      return animationFrameId;
    }),
  });
  Object.defineProperty(window, "cancelAnimationFrame", {
    configurable: true,
    value: jest.fn((animationFrameId: number) => {
      animationFrameCallbacks.delete(animationFrameId);
    }),
  });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: jest.fn(() => ({
      matches: false,
      media: "(prefers-reduced-motion: reduce)",
      onchange: null,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      addListener: jest.fn(),
      removeListener: jest.fn(),
      dispatchEvent: jest.fn(),
    })),
  });
});
afterEach(() => {
  if (originalRequestAnimationFrame) {
    Object.defineProperty(window, "requestAnimationFrame", {
      configurable: true,
      value: originalRequestAnimationFrame,
    });
  } else {
    delete (window as any).requestAnimationFrame;
  }
  if (originalCancelAnimationFrame) {
    Object.defineProperty(window, "cancelAnimationFrame", {
      configurable: true,
      value: originalCancelAnimationFrame,
    });
  } else {
    delete (window as any).cancelAnimationFrame;
  }
  if (originalMatchMedia) {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: originalMatchMedia,
    });
  } else {
    delete (window as any).matchMedia;
  }
  jest.useRealTimers();
});

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

test("decorative rays and glow stay scoped to the flight stage", () => {
  const { container } = render(
    <Context.Provider value={value({ GameState: "BET", latestRoundNumber: 90 })}>
      <CrashStage />
    </Context.Provider>,
  );

  const stage = container.querySelector(".space-box");
  const atmosphere = stage?.querySelector(":scope > .flight-atmosphere");
  expect(atmosphere).not.toBeNull();
  expect(atmosphere?.getAttribute("aria-hidden")).toBe("true");
  expect(atmosphere?.querySelectorAll(".flight-rays-rotor use")).toHaveLength(24);
  expect(atmosphere?.querySelectorAll(".flight-glow-core")).toHaveLength(1);
  expect(container.querySelectorAll(".flight-atmosphere")).toHaveLength(1);
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

test("visual interpolation advances toward its target on an 80 ms presentation window", () => {
  expect(interpolateVisualProgress(0.2, 0.6, 0)).toBeCloseTo(0.2);
  expect(interpolateVisualProgress(0.2, 0.6, 40)).toBeCloseTo(0.4);
  expect(interpolateVisualProgress(0.2, 0.6, 80)).toBeCloseTo(0.6);
  expect(interpolateVisualProgress(0.2, 0.6, 200)).toBeCloseTo(0.6);
});

test("logic ticks only retarget a shared RAF sample for the curve and aircraft", () => {
  jest.setSystemTime(new Date("2026-09-02T00:00:00.000Z"));
  const setCurrentTarget = jest.fn();
  const { container } = render(
    <Context.Provider value={value({ GameState: "PLAYING", time: 5000, latestRoundNumber: 91, setCurrentTarget })}>
      <CrashStage />
    </Context.Provider>,
  );

  const initialPath = container.querySelector(".curve-line")?.getAttribute("d");
  const initialPlaneTransform = container.querySelector(".plane-flight")?.getAttribute("transform");
  const initialPlaneX = container.querySelector(".plane")?.getAttribute("x");
  const initialPlaneY = container.querySelector(".plane")?.getAttribute("y");
  const targetCallsBeforeLogicTicks = setCurrentTarget.mock.calls.length;
  expect(animationFrameCallbacks.size).toBe(1);

  act(() => jest.advanceTimersByTime(200));

  expect(setCurrentTarget.mock.calls.length).toBeGreaterThan(targetCallsBeforeLogicTicks);
  expect(container.querySelector(".curve-line")?.getAttribute("d")).toBe(initialPath);
  expect(container.querySelector(".plane-flight")?.getAttribute("transform")).toBe(initialPlaneTransform);

  act(() => flushAnimationFrame(0));
  act(() => flushAnimationFrame(80));

  const trail = container.querySelector('[data-flight-trail="tail-locked"]');
  const flightPlane = container.querySelector(".plane-flight");
  expect(trail?.getAttribute("d")).not.toBe(initialPath);
  expect(flightPlane?.getAttribute("transform")).not.toBe(initialPlaneTransform);
  expect(trail?.getAttribute("data-tail-x")).toBe(flightPlane?.getAttribute("data-tail-x"));
  expect(trail?.getAttribute("data-tail-y")).toBe(flightPlane?.getAttribute("data-tail-y"));
  expect(container.querySelector(".plane")?.getAttribute("x")).toBe(initialPlaneX);
  expect(container.querySelector(".plane")?.getAttribute("y")).toBe(initialPlaneY);
  expect(flightPlane?.getAttribute("transform")).toMatch(/^translate\([^)]*\) rotate\(-/);
});

test("maps waiting, flying, coast, and reset to distinct propeller states", () => {
  const { container, rerender } = render(
    <Context.Provider value={value({ GameState: "BET", latestRoundNumber: 91 })}>
      <CrashStage />
    </Context.Provider>,
  );
  expect(container.querySelector(".space-box")?.classList.contains("phase-bet")).toBe(true);
  expect(container.querySelector(".aircraft-propeller.is-waiting")?.getAttribute("data-propeller")).toBe("stopped");

  rerender(
    <Context.Provider value={value({ GameState: "PLAYING", time: 5000, latestRoundNumber: 91 })}>
      <CrashStage />
    </Context.Provider>,
  );
  expect(container.querySelector(".aircraft-propeller.is-flying.visible")?.getAttribute("data-propeller")).toBe("spinning");

  rerender(
    <Context.Provider value={value({ GameState: "GAMEEND", currentNum: "2.40", time: 13400, latestRoundNumber: 91 })}>
      <CrashStage />
    </Context.Provider>,
  );
  expect(container.querySelector(".aircraft-propeller.is-ended.visible")?.getAttribute("data-propeller")).toBe("coasting");
  expect(container.querySelector(".plane-flight.crashed")).not.toBeNull();

  rerender(
    <Context.Provider value={value({ GameState: "BET", latestRoundNumber: 92 })}>
      <CrashStage />
    </Context.Provider>,
  );
  expect(container.querySelector(".aircraft-propeller.is-waiting")?.getAttribute("data-propeller")).toBe("stopped");
  expect(container.querySelector(".plane-flight.crashed, .plane.visible")).toBeNull();
});

test("Web Animations preserves propeller phase for coast and resets without leaked instances", () => {
  const originalAnimate = (Element.prototype as any).animate;
  const animations: any[] = [];
  const animate = jest.fn((_frames, options) => {
    const animation = {
      cancel: jest.fn(),
      pause: jest.fn(),
      play: jest.fn(),
      playState: "running",
      options,
    };
    animations.push(animation);
    return animation;
  });
  Object.defineProperty(Element.prototype, "animate", { configurable: true, value: animate });

  const { container, rerender, unmount } = render(
    <Context.Provider value={value({ GameState: "PLAYING", time: 5000, latestRoundNumber: 91 })}>
      <CrashStage />
    </Context.Provider>,
  );
  expect(animate).toHaveBeenLastCalledWith(expect.any(Array), expect.objectContaining({
    duration: 110,
    iterations: Infinity,
    easing: "linear",
  }));
  expect(container.querySelector(".aircraft-propeller")?.getAttribute("data-motion-driver")).toBe("waapi");

  rerender(
    <Context.Provider value={value({ GameState: "GAMEEND", currentNum: "2.40", time: 13400, latestRoundNumber: 91 })}>
      <CrashStage />
    </Context.Provider>,
  );
  expect(animations[0].cancel).toHaveBeenCalledTimes(1);
  expect(animate).toHaveBeenLastCalledWith(expect.any(Array), expect.objectContaining({
    duration: 200,
    iterations: 1,
    easing: "cubic-bezier(0.23, 1, 0.32, 1)",
  }));
  const coastFrames = animate.mock.calls[animate.mock.calls.length - 1][0];
  expect(coastFrames[1].transform).toBe("rotate(150deg)");

  rerender(
    <Context.Provider value={value({ GameState: "BET", latestRoundNumber: 92 })}>
      <CrashStage />
    </Context.Provider>,
  );
  expect(animations[1].cancel).toHaveBeenCalledTimes(1);
  expect((container.querySelector(".aircraft-propeller") as SVGGElement).style.transform).toBe("rotate(0deg)");
  unmount();

  if (originalAnimate) {
    Object.defineProperty(Element.prototype, "animate", { configurable: true, value: originalAnimate });
  } else {
    delete (Element.prototype as any).animate;
  }
});

test("visibility pauses decorative motion without changing the multiplier", () => {
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  const { container } = render(
    <Context.Provider value={value({ GameState: "PLAYING", currentNum: "2.45", time: 6200, latestRoundNumber: 91 })}>
      <CrashStage />
    </Context.Provider>,
  );
  const stage = container.querySelector(".space-box");
  const before = container.querySelector(".multiplier")?.textContent;
  expect(stage?.getAttribute("data-motion-paused")).toBe("false");

  Object.defineProperty(document, "hidden", { configurable: true, value: true });
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(stage?.getAttribute("data-motion-paused")).toBe("true");
  expect(container.querySelector(".multiplier")?.textContent).toBe(before);

  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(stage?.getAttribute("data-motion-paused")).toBe("false");
});

test("reduced motion freezes the visual path while the numeric multiplier remains live", () => {
  const mediaQuery = {
    matches: true,
    media: "(prefers-reduced-motion: reduce)",
    onchange: null,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    addListener: jest.fn(),
    removeListener: jest.fn(),
    dispatchEvent: jest.fn(),
  };
  Object.defineProperty(window, "matchMedia", { configurable: true, value: jest.fn(() => mediaQuery) });

  jest.setSystemTime(new Date("2026-09-02T00:00:00.000Z"));
  const { container, unmount } = render(
    <Context.Provider value={value({ GameState: "PLAYING", time: 0, latestRoundNumber: 91 })}>
      <CrashStage />
    </Context.Provider>,
  );
  const initialPath = container.querySelector(".curve-line")?.getAttribute("d");
  const initialPlane = container.querySelector(".plane-flight")?.getAttribute("transform");
  act(() => jest.advanceTimersByTime(5000));
  expect(container.querySelector(".curve-line")?.getAttribute("d")).toBe(initialPath);
  expect(container.querySelector(".plane-flight")?.getAttribute("transform")).toBe(initialPlane);
  expect(container.querySelector(".multiplier")?.textContent).toBe("1.38x");
  expect(window.requestAnimationFrame).not.toHaveBeenCalled();
  expect(animationFrameCallbacks.size).toBe(0);
  unmount();
});

test("flight geometry keeps the existing curve while deriving a restrained aircraft tangent", () => {
  const early = flightGeometryFor(0.08);
  const later = flightGeometryFor(0.72);
  expect(early.planeRotation).toBeLessThanOrEqual(-7);
  expect(early.planeRotation).toBeGreaterThanOrEqual(-12);
  expect(later.planeRotation).toBeLessThanOrEqual(-7);
  expect(later.planeRotation).toBeGreaterThanOrEqual(-12);
  expect(later.tailX).toBeGreaterThan(early.tailX);
  expect(later.tailY).toBeLessThan(early.tailY);
});

test("presentation changes preserve the production multiplier curve samples", () => {
  expect(Math.floor(flightCurveValue(1) * 100) / 100).toBe(1.06);
  expect(Math.floor(flightCurveValue(5) * 100) / 100).toBe(1.38);
});

test("motion styles use clipped transform-only atmosphere layers and reduced-motion fallbacks", () => {
  const styles = fs.readFileSync(path.resolve(__dirname, "crash.scss"), "utf8");
  expect(styles).toMatch(/\.flight-rays\s*\{[\s\S]*?width:\s*156%[\s\S]*?overflow:\s*hidden/);
  expect(styles).toMatch(/\.flight-rays-rotor\s*\{[\s\S]*?animation:\s*flightRaysRotate 70s linear infinite/);
  expect(styles).toMatch(/\.space-box\.phase-playing \.flight-glow-core,[\s\S]*?flightGlowBreath 7\.2s/);
  expect(styles).toMatch(/\.aircraft-propeller\.is-flying:not\(\[data-motion-driver="waapi"\]\),[\s\S]*?110ms linear infinite/);
  expect(styles).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.flight-rays-rotor,[\s\S]*?\.aircraft-propeller[\s\S]*?animation:\s*none !important/);
  expect(styles).not.toContain("planeCruise");
});

test("round phase changes and unmount clear scheduled flight work", () => {
  const { rerender, unmount } = render(
    <Context.Provider value={value({ GameState: "PLAYING", time: 1000, latestRoundNumber: 91 })}>
      <CrashStage />
    </Context.Provider>,
  );
  act(() => jest.advanceTimersByTime(3500));
  expect(jest.getTimerCount()).toBeLessThanOrEqual(1);
  expect(animationFrameCallbacks.size).toBe(1);

  rerender(
    <Context.Provider value={value({ GameState: "GAMEEND", currentNum: "2.40", time: 13400, latestRoundNumber: 91 })}>
      <CrashStage />
    </Context.Provider>,
  );
  expect(animationFrameCallbacks.size).toBe(0);
  rerender(
    <Context.Provider value={value({ GameState: "BET", latestRoundNumber: 92 })}>
      <CrashStage />
    </Context.Provider>,
  );
  expect(jest.getTimerCount()).toBeLessThanOrEqual(1);
  unmount();
  expect(jest.getTimerCount()).toBe(0);
  expect(animationFrameCallbacks.size).toBe(0);
});
