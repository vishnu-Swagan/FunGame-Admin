import { act } from "react";
import { createRoot } from "react-dom/client";
import fs from "fs";
import path from "path";
import { nextRummyPollDelay, PlayerSeat, RummyCard } from "./RummyGame";


jest.mock("react-router-dom", () => ({ useNavigate: () => jest.fn() }), { virtual: true });
jest.mock("sonner", () => ({ toast: { info: jest.fn(), error: jest.fn() } }));
jest.mock("@/lib/api", () => ({
  api: { get: jest.fn(), post: jest.fn() },
  errCode: () => null,
  errMsg: (_error, fallback) => fallback,
}));
jest.mock("@/lib/sound", () => ({
  isMuted: () => false,
  onMuteChange: () => () => {},
  toggleMuted: jest.fn(),
  sfx: {},
}));
jest.mock("@/components/common", () => ({ formatChips: (value) => String(value ?? 0) }));


beforeAll(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
});

function renderSeat(seat, viewerSeatIndex, timer = null) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<PlayerSeat seat={seat} viewerSeatIndex={viewerSeatIndex} timer={timer} reducedMotion />);
  });
  return { container, root };
}

afterEach(() => {
  document.body.innerHTML = "";
});

test("a live user seated away from seat zero never sees a back stack on their own seat", () => {
  const viewer = { seatIndex: 3, status: "ACTIVE", displayName: "You", playerId: "PL***01", isBot: false, cardCount: 13 };
  const { container, root } = renderSeat(viewer, 3);
  expect(container.querySelector(".rummy-card-back")).toBeNull();
  act(() => root.unmount());
});

test("opponents retain hidden backs and only the active seat renders the one countdown", () => {
  const opponent = { seatIndex: 1, status: "ACTIVE", displayName: "Rival", playerId: "PL***02", isBot: false, cardCount: 13, active: true };
  const { container, root } = renderSeat(opponent, 3, 18.2);
  expect(container.querySelector(".rummy-card-back")).not.toBeNull();
  expect(container.querySelectorAll(".rummy-only-timer")).toHaveLength(1);
  expect(container.querySelector(".rummy-only-timer")?.textContent).toBe("19");
  act(() => root.unmount());
});

test("an undealt wild joker renders a placeholder instead of crashing the table", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(<RummyCard card={null} compact />));
  expect(container.querySelector(".rummy-card-placeholder")?.textContent).toBe("?");
  act(() => root.unmount());
});

test("the table consumes the shared safe viewport and never sizes itself in viewport-width units", () => {
  const css = fs.readFileSync(path.join(__dirname, "rummy.css"), "utf8");
  expect(css).toContain("width: var(--fg-usable-w, 100vw)");
  expect(css).toContain("height: var(--fg-usable-h, 100dvh)");
  expect(css).toMatch(/\.rummy-lobby::before\s*\{[^}]*position:\s*absolute/s);
  expect(css).not.toMatch(/\.rummy-table\s*\{[^}]*width:\s*[^;}]*vw/s);
});

test("state polling backs off after failures and resets after success", () => {
  expect(nextRummyPollDelay(900, false)).toBe(1800);
  expect(nextRummyPollDelay(7200, false)).toBe(8000);
  expect(nextRummyPollDelay(8000, true)).toBe(900);
});

test("state polling is recursive, abortable and never interval-overlaps", () => {
  const source = fs.readFileSync(path.join(__dirname, "RummyGame.js"), "utf8");
  expect(source).not.toContain("setInterval(");
  expect(source).toContain("pollInFlightRef.current");
  expect(source).toContain("new AbortController()");
  expect(source).toContain("pollAbortRef.current?.abort()");
});

test("the Rummy lobby uses its dedicated wide wordmark instead of stretching the catalog card", () => {
  const source = fs.readFileSync(path.join(__dirname, "RummyGame.js"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "rummy.css"), "utf8");
  expect(source).toContain('/game-brand/rummy-lobby-logo.png');
  expect(source).toContain('className="rummy-lobby-logo"');
  expect(css).toContain(".rummy-lobby-logo");
});

test("the live Rummy table uses the shared Chakri brand lockup", () => {
  const source = fs.readFileSync(path.join(__dirname, "RummyGame.js"), "utf8");
  expect(source).toContain('import { BrandWordmark } from "@/components/Brand"');
  expect(source).toContain('className="rummy-brand-lockup"');
  expect(source).not.toContain('className="rummy-brand-monogram"');
});
