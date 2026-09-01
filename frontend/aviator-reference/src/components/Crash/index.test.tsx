import React from "react";
import fs from "fs";
import path from "path";
import { act, render } from "@testing-library/react";
import Context from "../../context";
import WebGLStarter from ".";

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

test("the aircraft artwork is the approved red side-profile propeller plane", () => {
	const craft = fs.readFileSync(
		path.resolve(__dirname, "../../assets/images/aviator-craft.svg"),
		"utf8",
	);

	expect(craft).toContain('data-flight-profile="side-view"');
	expect(craft).toContain('viewBox="0 0 300 112"');
	expect(craft).toContain('id="propeller"');
	expect(craft).toContain("propeller-spin");
	// A recognisable aircraft, not a bare blob: fuselage, wing and cockpit.
	expect(craft).toContain("craft-body");
	expect(craft).toContain("craft-wing");
	// Never a rocket / animated sprite.
	expect(craft).not.toContain("rocket");
	expect(craft).not.toContain(".gif");
	expect(craft).not.toContain('viewBox="0 0 220 92"');
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
  expect(stage?.getAttribute("data-renderer-mode")).toBe("pending");
  expect(stage?.classList.contains("renderer-pending")).toBe(true);
  expect(container.querySelector(".aviator-renderer-gate")?.textContent).toContain("Synchronising live round");
  expect(container.querySelector(".flight-stage")).toBeNull();
  expect(container.querySelector(".flight-curve")).toBeNull();
  expect(container.querySelector(".plane")).toBeNull();
  expect(container.querySelector(".multiplier")?.textContent).toBe("");

	act(() => jest.advanceTimersByTime(5000));
	expect(stage?.getAttribute("data-renderer-mode")).toBe("pending");
	expect(container.querySelector(".plane")).toBeNull();
});

test("the waiting phase shows the logo and loading bar with no aircraft", () => {
	const { container } = render(
		<Context.Provider value={value({ GameState: "BET", currentNum: "1", time: 0, latestRoundNumber: 92 })}>
			<WebGLStarter />
		</Context.Provider>,
	);

	const stage = container.querySelector(".space-box");
	expect(stage?.getAttribute("data-renderer-mode")).toBe("flight");
	expect(stage?.classList.contains("flight-visual-ready")).toBe(true);
	expect(container.querySelector(".flight-stage")).not.toBeNull();
	// No plane and no growing curve while waiting.
	expect(container.querySelector(".plane")).toBeNull();
	expect(container.querySelector(".flight-curve")).toBeNull();
	// Waiting UI is present.
	const logo = container.querySelector(".center-logo");
	expect(logo).not.toBeNull();
	expect(logo?.classList.contains("hide")).toBe(false);
	expect(container.querySelector(".loading-container")?.classList.contains("show-loading")).toBe(true);
	// The multiplier is not shown during betting.
	expect(container.querySelector(".multiplier")?.textContent).toBe("");
});

test("the playing phase renders one aircraft riding the tip of the red flight curve", () => {
	const { container } = render(
		<Context.Provider value={value({ GameState: "PLAYING", currentNum: "2.45", time: 6200, latestRoundNumber: 91 })}>
			<WebGLStarter />
		</Context.Provider>,
	);

	const stage = container.querySelector(".space-box");
	expect(stage?.getAttribute("data-server-state-ready")).toBe("true");
	expect(stage?.getAttribute("data-renderer-ready")).toBe("true");
	expect(stage?.getAttribute("data-renderer-mode")).toBe("flight");
	expect(stage?.classList.contains("flight-visual-ready")).toBe(true);

	// Exactly one aircraft, and it is visible during flight.
	expect(container.querySelectorAll(".plane")).toHaveLength(1);
	expect(container.querySelector(".plane.visible")).not.toBeNull();

	// A filled red curve is drawn.
	const curve = container.querySelector(".flight-curve");
	expect(curve).not.toBeNull();
	expect(curve?.querySelector(".curve-fill")?.getAttribute("d")).toMatch(/^M .*Z$/);
	expect(curve?.querySelector(".curve-line")).not.toBeNull();

	// The plane is anchored on the curve with a tangent rotation.
	const anchor = container.querySelector(".plane-anchor") as HTMLElement;
	expect(anchor).not.toBeNull();
	expect(anchor.style.left).toMatch(/px$/);
	expect(anchor.style.top).toMatch(/px$/);
	expect(anchor.style.transform).toContain("rotate(");

	expect(container.querySelector(".multiplier")?.textContent).toMatch(/x$/);
});

test("the aircraft climbs and pitches up as the flight advances", () => {
	const { container } = render(
		<Context.Provider value={value({ GameState: "PLAYING", currentNum: "1.20", time: 0, latestRoundNumber: 93 })}>
			<WebGLStarter />
		</Context.Provider>,
	);

	const anchor = () => container.querySelector(".plane-anchor") as HTMLElement;
	const angleFrom = (el: HTMLElement) => {
		const match = el.style.transform.match(/rotate\((-?\d+(?:\.\d+)?)deg\)/);
		return match ? Number(match[1]) : 0;
	};

	act(() => jest.advanceTimersByTime(40));
	const earlyLeft = parseFloat(anchor().style.left);
	const earlyTop = parseFloat(anchor().style.top);

	act(() => jest.advanceTimersByTime(4000));
	const laterLeft = parseFloat(anchor().style.left);
	const laterTop = parseFloat(anchor().style.top);

	// Moves to the right and upward (top decreases) over time.
	expect(laterLeft).toBeGreaterThan(earlyLeft);
	expect(laterTop).toBeLessThan(earlyTop);
	// Nose pitches up (negative rotation) as it climbs.
	expect(angleFrom(anchor())).toBeLessThan(0);
});

test("a crash shows FLEW AWAY, a red multiplier and the plane flying away once", () => {
	const { container } = render(
		<Context.Provider value={value({ GameState: "GAMEEND", currentNum: "3.10", time: 6800, latestRoundNumber: 94 })}>
			<WebGLStarter />
		</Context.Provider>,
	);

	const stage = container.querySelector(".space-box");
	expect(stage?.getAttribute("data-renderer-mode")).toBe("flight");

	expect(container.querySelector(".flew-away.show")).not.toBeNull();
	expect(container.querySelector(".multiplier.crashed")).not.toBeNull();
	expect(container.querySelector(".multiplier")?.textContent).toMatch(/x$/);

	// A single aircraft flying away — never two planes on screen.
	expect(container.querySelectorAll(".plane")).toHaveLength(1);
	expect(container.querySelector(".plane.crashed")).not.toBeNull();
	expect(container.querySelector(".plane-anchor.crashed")).not.toBeNull();
});
