import React from "react";
import { render } from "@testing-library/react";
import Context from "../../context";
import WebGLStarter from ".";

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

test("cold startup exposes only the neutral renderer gate and never a fallback flight", () => {
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
});

test("an authoritative ended-round value stays covered until the approved renderer is synchronized", () => {
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
