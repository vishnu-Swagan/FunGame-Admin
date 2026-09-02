import React from "react";
import fs from "fs";
import path from "path";
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
jest.mock("../../assets/images/aviator-craft.svg", () => ({
	__esModule: true,
	default: "aviator-craft.svg",
	ReactComponent: (props: React.SVGProps<SVGSVGElement>) => (
		<svg {...props} data-flight-profile="side-view">
			<g className="plane-body" />
			<g id="propeller" className="plane-propeller" />
		</svg>
	),
}));

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

test("the fallback uses the approved side-profile propeller aircraft", () => {
	const craft = fs.readFileSync(
		path.resolve(__dirname, "../../assets/images/aviator-craft.svg"),
		"utf8",
	);

	expect(craft).toContain('data-flight-profile="side-view"');
	expect(craft).toContain('viewBox="0 0 300 112"');
	expect(craft).toContain('class="plane-body"');
	expect(craft).toContain('id="propeller"');
	expect(craft).toContain('class="plane-propeller"');
	expect(craft).not.toContain("<style>");
	expect(craft).not.toContain('viewBox="0 0 220 92"');
});

test("decorative atmosphere is scoped to the flight stage and hidden from assistive technology", () => {
	const { container, rerender } = render(
		<Context.Provider value={value({ GameState: "BET", latestRoundNumber: 90 })}>
			<WebGLStarter />
		</Context.Provider>,
	);

	const stage = container.querySelector(".space-box");
	const atmosphere = stage?.querySelector(":scope > .flight-atmosphere");
	expect(atmosphere).not.toBeNull();
	expect(atmosphere?.getAttribute("aria-hidden")).toBe("true");
	expect(atmosphere?.querySelectorAll(".flight-rays")).toHaveLength(1);
	expect(atmosphere?.querySelectorAll(".flight-rays-rotor use")).toHaveLength(24);
	expect(atmosphere?.querySelectorAll(".flight-glow")).toHaveLength(1);
	expect(atmosphere?.querySelectorAll(".flight-glow-core")).toHaveLength(1);

	rerender(
		<Context.Provider value={value({ GameState: "PLAYING", latestRoundNumber: 90 })}>
			<WebGLStarter />
		</Context.Provider>,
	);
	expect(stage?.querySelectorAll(":scope > .flight-atmosphere")).toHaveLength(1);
});

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

test("an authoritative round renders immediately without a WebGL startup window", () => {
  const { container } = render(
    <Context.Provider value={value({ GameState: "GAMEEND", currentNum: "87.40", time: 12000, latestRoundNumber: 90 })}>
      <WebGLStarter />
    </Context.Provider>,
  );

  const stage = container.querySelector(".space-box");
  expect(stage?.getAttribute("data-server-state-ready")).toBe("true");
  expect(stage?.getAttribute("data-renderer-ready")).toBe("true");
  expect(stage?.getAttribute("data-renderer-mode")).toBe("react");
  expect(stage?.classList.contains("fallback-visual-ready")).toBe(true);
  expect(container.querySelector(".fallback-flight-visual")).not.toBeNull();
});

test("the server-driven React renderer is the primary aircraft and multiplier surface", () => {
	const { container } = render(
		<Context.Provider value={value({ GameState: "PLAYING", currentNum: "2.45", time: 6200, latestRoundNumber: 91 })}>
			<WebGLStarter />
		</Context.Provider>,
	);

	const stage = container.querySelector(".space-box");
	expect(stage?.getAttribute("data-server-state-ready")).toBe("true");
	expect(stage?.getAttribute("data-renderer-ready")).toBe("true");
	expect(stage?.getAttribute("data-renderer-mode")).toBe("react");
	expect(stage?.classList.contains("fallback-visual-ready")).toBe(true);
	expect(container.querySelector('[data-testid="unity-stage"]')).toBeNull();
	expect(container.querySelector(".fallback-flight-visual")).not.toBeNull();
	expect(container.querySelector(".flight-curve")).not.toBeNull();
	expect(container.querySelector(".plane.visible")).not.toBeNull();
	expect(container.querySelectorAll(".plane")).toHaveLength(1);
	expect(container.querySelector(".plane-craft .plane-propeller")).not.toBeNull();
	expect(container.querySelector(".multiplier")?.textContent).toMatch(/x$/);
	expect(aviatorUnityContext.send).not.toHaveBeenCalled();
});

test("maps round phases to deterministic plane and propeller states", () => {
	const { container, rerender } = render(
		<Context.Provider value={value({ GameState: "BET", latestRoundNumber: 91 })}>
			<WebGLStarter />
		</Context.Provider>,
	);
	act(() => jest.advanceTimersByTime(3500));

	expect(container.querySelector(".space-box")?.classList.contains("phase-bet")).toBe(true);
	expect(container.querySelector(".plane")?.classList.contains("is-waiting")).toBe(true);
	expect(container.querySelector(".plane")?.classList.contains("visible")).toBe(false);

	rerender(
		<Context.Provider value={value({ GameState: "PLAYING", currentNum: "1.38", time: 5000, latestRoundNumber: 91 })}>
			<WebGLStarter />
		</Context.Provider>,
	);
	expect(container.querySelector(".space-box")?.classList.contains("phase-playing")).toBe(true);
	expect(container.querySelector(".plane.is-flying.visible")).not.toBeNull();

	rerender(
		<Context.Provider value={value({ GameState: "GAMEEND", currentNum: "2.40", time: 13400, latestRoundNumber: 91 })}>
			<WebGLStarter />
		</Context.Provider>,
	);
	expect(container.querySelector(".plane.is-ended.crashed")).not.toBeNull();

	rerender(
		<Context.Provider value={value({ GameState: "BET", latestRoundNumber: 92 })}>
			<WebGLStarter />
		</Context.Provider>,
	);
	expect(container.querySelector(".plane.is-waiting")).not.toBeNull();
	expect(container.querySelector(".plane.visible, .plane.crashed")).toBeNull();
});

test("keeps flight positioning, exit motion, aircraft body, and propeller rotation isolated", () => {
	const { container } = render(
		<Context.Provider value={value({ GameState: "PLAYING", currentNum: "2.45", time: 6200, latestRoundNumber: 91 })}>
			<WebGLStarter />
		</Context.Provider>,
	);
	act(() => jest.advanceTimersByTime(3500));

	const position = container.querySelector('[data-motion-role="flight-position"]');
	const exit = position?.querySelector('[data-motion-role="flight-exit"]');
	const craft = exit?.querySelector('[data-motion-role="aircraft-art"]');
	expect(position?.getAttribute("style")).toContain("translate3d");
	expect(position?.getAttribute("style")).not.toMatch(/(?:left|bottom):/);
	expect(exit).not.toBeNull();
	expect(craft?.querySelector(".plane-body")).not.toBeNull();
	expect(craft?.querySelector(".plane-propeller")).not.toBeNull();
	expect(craft?.querySelector(".plane-body")?.classList.contains("plane-propeller")).toBe(false);
});

test("document visibility pauses decorative motion without changing the round value", () => {
	Object.defineProperty(document, "hidden", { configurable: true, value: false });
	const { container } = render(
		<Context.Provider value={value({ GameState: "PLAYING", currentNum: "2.45", time: 6200, latestRoundNumber: 91 })}>
			<WebGLStarter />
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

test("phase changes and unmount clear scheduled flight work", () => {
	const { rerender, unmount } = render(
		<Context.Provider value={value({ GameState: "PLAYING", time: 1000, latestRoundNumber: 91 })}>
			<WebGLStarter />
		</Context.Provider>,
	);
	act(() => jest.advanceTimersByTime(3500));
	expect(jest.getTimerCount()).toBeLessThanOrEqual(1);

	rerender(
		<Context.Provider value={value({ GameState: "GAMEEND", currentNum: "2.40", time: 13400, latestRoundNumber: 91 })}>
			<WebGLStarter />
		</Context.Provider>,
	);
	rerender(
		<Context.Provider value={value({ GameState: "BET", latestRoundNumber: 92 })}>
			<WebGLStarter />
		</Context.Provider>,
	);
	expect(jest.getTimerCount()).toBeLessThanOrEqual(1);
	unmount();
	expect(jest.getTimerCount()).toBe(0);
});

test("Web Animations preserves propeller phase for the crash coast and resets cleanly", () => {
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
			<WebGLStarter />
		</Context.Provider>,
	);
	expect(animate).toHaveBeenLastCalledWith(expect.any(Array), expect.objectContaining({
		duration: 110,
		iterations: Infinity,
		easing: "linear",
	}));
	expect(container.querySelector(".plane-propeller")?.getAttribute("data-motion-driver")).toBe("waapi");

	rerender(
		<Context.Provider value={value({ GameState: "GAMEEND", currentNum: "2.40", time: 13400, latestRoundNumber: 91 })}>
			<WebGLStarter />
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
			<WebGLStarter />
		</Context.Provider>,
	);
	expect(animations[1].cancel).toHaveBeenCalledTimes(1);
	expect((container.querySelector(".plane-propeller") as SVGGraphicsElement).style.transform).toBe("rotate(0deg)");
	unmount();

	if (originalAnimate) {
		Object.defineProperty(Element.prototype, "animate", { configurable: true, value: originalAnimate });
	} else {
		delete (Element.prototype as any).animate;
	}
});

test("reduced motion keeps the aircraft at a stable launch pose", () => {
	const originalMatchMedia = window.matchMedia;
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
	Object.defineProperty(window, "matchMedia", {
		configurable: true,
		value: jest.fn(() => mediaQuery),
	});

	const { container, unmount } = render(
		<Context.Provider value={value({ GameState: "PLAYING", time: 0, latestRoundNumber: 91 })}>
			<WebGLStarter />
		</Context.Provider>,
	);
	const initialTransform = container.querySelector(".plane")?.getAttribute("style");
	const initialCurveOffset = container.querySelector(".curve-line")?.getAttribute("style");
	const initialCurveFill = container.querySelector(".curve-fill")?.getAttribute("style");
	act(() => jest.advanceTimersByTime(5000));
	expect(container.querySelector(".plane")?.getAttribute("style")).toBe(initialTransform);
	expect(container.querySelector(".curve-line")?.getAttribute("style")).toBe(initialCurveOffset);
	expect(container.querySelector(".curve-fill")?.getAttribute("style")).toBe(initialCurveFill);
	expect(initialTransform).toContain("translate3d");
	unmount();

	if (originalMatchMedia) {
		Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia });
	} else {
		delete (window as any).matchMedia;
	}
});

test("presentation changes preserve the existing multiplier curve samples", () => {
	jest.setSystemTime(new Date("2026-09-02T00:00:00.000Z"));
	const { container } = render(
		<Context.Provider value={value({ GameState: "PLAYING", time: 0, latestRoundNumber: 91 })}>
			<WebGLStarter />
		</Context.Provider>,
	);

	act(() => jest.advanceTimersByTime(1000));
	expect(container.querySelector(".multiplier")?.textContent).toBe("1.06x");
	act(() => jest.advanceTimersByTime(4000));
	expect(container.querySelector(".multiplier")?.textContent).toBe("1.38x");
});

test("motion styles use scoped GPU layers with reduced-motion and responsive fallbacks", () => {
	const styles = fs.readFileSync(path.resolve(__dirname, "crash.scss"), "utf8");
	expect(styles).toMatch(/\.flight-rays\s*\{[\s\S]*?width:\s*156%/);
	expect(styles).toMatch(/\.flight-rays-rotor\s*\{[\s\S]*?animation:\s*flightRaysRotate 70s linear infinite/);
	expect(styles).not.toContain("max(280cqw, 280cqh)");
	expect(styles).toMatch(/\.space-box\.phase-playing \.flight-glow-core,[\s\S]*?animation:\s*flightGlowBreath 7\.2s/);
	expect(styles).toMatch(/\.flight-atmosphere\s*\{[\s\S]*?pointer-events:\s*none/);
	expect(styles).toMatch(/\.plane\.is-flying \.plane-propeller:not\(\[data-motion-driver="waapi"\]\),[\s\S]*?110ms linear infinite/);
	expect(styles).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.flight-rays-rotor,[\s\S]*?\.plane-propeller[\s\S]*?animation:\s*none !important/);
	expect(styles).toContain("@media (max-width: 992px)");
	expect(styles).toContain("@media (max-width: 520px)");
});

test("the React presentation renderer stays primary across round phases", () => {
	const playingState = value({ GameState: "PLAYING", currentNum: "2.45", time: 6200, latestRoundNumber: 91 });
	const { container, rerender } = render(
		<Context.Provider value={playingState}>
			<WebGLStarter />
		</Context.Provider>,
	);

	expect(container.querySelector(".space-box")?.getAttribute("data-renderer-mode")).toBe("react");
	expect(container.querySelector(".fallback-flight-visual")).not.toBeNull();
	expect(container.querySelector('[data-testid="unity-stage"]')).toBeNull();
	expect(aviatorUnityContext.on).not.toHaveBeenCalled();

	rerender(
		<Context.Provider value={value({ GameState: "BET", currentNum: "1", time: 0, latestRoundNumber: 92 })}>
			<WebGLStarter />
		</Context.Provider>,
	);
	expect(container.querySelector(".space-box")?.getAttribute("data-renderer-mode")).toBe("react");
	expect(container.querySelector(".fallback-flight-visual")).not.toBeNull();
});
