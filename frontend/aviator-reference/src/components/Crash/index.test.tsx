import React from "react";
import { act, render } from "@testing-library/react";
import Context from "../../context";
import WebGLStarter from ".";
import { aviatorUnityContext } from "../../unity";

jest.mock("react-unity-webgl", () => () => <div data-testid="unity-stage" />);
jest.mock("../../unity", () => ({
  aviatorUnityContext: {
    on: jest.fn(),
    removeEventListener: jest.fn(),
    send: jest.fn(),
  },
}));
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

test("cold startup without server state keeps the neutral renderer gate", () => {
  const { container } = render(
    <Context.Provider value={value()}>
      <WebGLStarter />
    </Context.Provider>,
  );

  const stage = container.querySelector(".space-box");
  expect(stage?.getAttribute("data-server-state-ready")).toBe("false");
  expect(stage?.getAttribute("data-renderer-ready")).toBe("false");
  expect(stage?.classList.contains("renderer-pending")).toBe(true);
  expect(container.querySelector(".aviator-renderer-gate")?.textContent).toContain("Synchronising live round");
  expect(container.querySelector(".fallback-flight-visual")).toBeNull();
  expect(container.querySelector(".flight-curve")).toBeNull();
  expect(container.querySelector(".plane")).toBeNull();
  expect(container.querySelector(".multiplier")?.textContent).toBe("");

	act(() => jest.advanceTimersByTime(5000));
	expect(stage?.getAttribute("data-renderer-mode")).toBe("pending");
	expect(container.querySelector(".fallback-flight-visual")).toBeNull();
});

test("an authoritative round stays covered during the bounded Unity startup window", () => {
  const { container } = render(
    <Context.Provider value={value({ GameState: "GAMEEND", currentNum: "87.40", time: 12000, latestRoundNumber: 90 })}>
      <WebGLStarter />
    </Context.Provider>,
  );

  const stage = container.querySelector(".space-box");
  expect(stage?.getAttribute("data-server-state-ready")).toBe("true");
  expect(stage?.getAttribute("data-renderer-ready")).toBe("false");
  expect(stage?.classList.contains("renderer-pending")).toBe(true);
  expect(container.querySelector(".fallback-flight-visual")).toBeNull();
});

test("a stalled Unity load falls back to the server-driven aircraft and multiplier", () => {
	const { container } = render(
		<Context.Provider value={value({ GameState: "PLAYING", currentNum: "2.45", time: 6200, latestRoundNumber: 91 })}>
			<WebGLStarter />
		</Context.Provider>,
	);

	act(() => jest.advanceTimersByTime(3500));

	const stage = container.querySelector(".space-box");
	expect(stage?.getAttribute("data-server-state-ready")).toBe("true");
	expect(stage?.getAttribute("data-renderer-ready")).toBe("true");
	expect(stage?.getAttribute("data-renderer-mode")).toBe("fallback");
	expect(stage?.classList.contains("fallback-visual-ready")).toBe(true);
	expect(container.querySelector(".fallback-flight-visual")).not.toBeNull();
	expect(container.querySelector(".flight-curve")).not.toBeNull();
	expect(container.querySelector(".plane.visible")).not.toBeNull();
	expect(container.querySelector(".multiplier")?.textContent).toMatch(/x$/);
	expect(aviatorUnityContext.send).not.toHaveBeenCalled();
});

test("a late Unity load takes over only after the next BET phase is synchronised", () => {
	const playingState = value({ GameState: "PLAYING", currentNum: "2.45", time: 6200, latestRoundNumber: 91 });
	const { container, rerender } = render(
		<Context.Provider value={playingState}>
			<WebGLStarter />
		</Context.Provider>,
	);

	act(() => jest.advanceTimersByTime(3500));
	expect(container.querySelector(".space-box")?.getAttribute("data-renderer-mode")).toBe("fallback");

	const loadedHandler = (aviatorUnityContext.on as jest.Mock).mock.calls.find(([event]) => event === "loaded")?.[1];
	act(() => loadedHandler());
	act(() => jest.advanceTimersByTime(40));

	expect(container.querySelector(".space-box")?.getAttribute("data-renderer-mode")).toBe("fallback");
	expect(container.querySelector(".fallback-flight-visual")).not.toBeNull();

	rerender(
		<Context.Provider value={value({ GameState: "BET", currentNum: "1", time: 0, latestRoundNumber: 92 })}>
			<WebGLStarter />
		</Context.Provider>,
	);
	act(() => jest.advanceTimersByTime(40));

	expect(container.querySelector(".space-box")?.getAttribute("data-renderer-mode")).toBe("unity");
	expect(container.querySelector(".fallback-flight-visual")).toBeNull();
});
