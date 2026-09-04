import { act } from "react";
import { createRoot } from "react-dom/client";
import fs from "fs";
import path from "path";
import { GameCard } from "./GameCard";

const mockNavigate = jest.fn();
let mockUser = { role: "PLAYER", status: "ACTIVE" };

jest.mock("react-router-dom", () => ({
  useNavigate: () => mockNavigate,
}), { virtual: true });

jest.mock("@/context/AuthContext", () => ({
  useAuth: () => ({ user: mockUser, loading: false }),
}));

jest.mock("@/components/GameArt", () => ({
  GameArt: ({ game }) => <div data-testid="game-art">{game.slug}</div>,
}));

beforeAll(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mockNavigate.mockReset();
  mockUser = { role: "PLAYER", status: "ACTIVE" };
});

function renderCard(game, extra = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<GameCard game={game} {...extra} />);
  });
  return {
    container,
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

const liveAviator = { slug: "aviator", name: "Aviator", category: "Crash", status: "ENABLED" };
const comingSoonBingo = { slug: "bingo", name: "Bingo", category: "Board", status: "COMING_SOON" };

test("enabled lobby cards show a bold PLAY NOW arrow CTA and open play from the whole card", () => {
  const { container, unmount } = renderCard(liveAviator);
  const card = container.querySelector('[data-testid="game-card"]');
  const cta = container.querySelector('[data-testid="game-card-play-cta"]');

  expect(card.getAttribute("aria-label")).toBe("Play Aviator");
  expect(cta).not.toBeNull();
  expect(cta.textContent.replace(/\s+/g, " ").trim()).toContain("PLAY NOW");
  expect(cta.querySelector("b")?.textContent).toBe("PLAY NOW");
  expect(cta.querySelector("b")?.tagName).toBe("B");
  expect(cta.querySelector(".fg-play-now-cta__motion")).not.toBeNull();
  expect(cta.querySelector("svg.fg-play-now-cta__arrow")).not.toBeNull();

  act(() => card.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  expect(mockNavigate).toHaveBeenCalledWith("/games/aviator/play");

  unmount();
});

test("Coming Soon cards stay non-playable and do not show PLAY NOW", () => {
  const { container, unmount } = renderCard(comingSoonBingo);
  const card = container.querySelector('[data-testid="game-card"]');

  expect(container.querySelector('[data-testid="game-card-play-cta"]')).toBeNull();
  expect(container.textContent).not.toContain("PLAY NOW");
  expect(card.getAttribute("aria-label")).toBe("Bingo — Coming Soon");

  act(() => card.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  expect(mockNavigate).toHaveBeenCalledWith("/games/bingo");
  expect(mockNavigate).not.toHaveBeenCalledWith("/games/bingo/play");

  unmount();
});

test("favorite toggle does not launch play", () => {
  const onToggleFavorite = jest.fn();
  const { container, unmount } = renderCard(liveAviator, { onToggleFavorite });
  const toggle = container.querySelector('[data-testid="game-card-favorite-toggle"]');

  act(() => toggle.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  expect(onToggleFavorite).toHaveBeenCalledWith("aviator");
  expect(mockNavigate).not.toHaveBeenCalled();

  unmount();
});

test("signed-out play clicks open the unified login page instead of launching a table", () => {
  mockUser = null;
  const { container, unmount } = renderCard(liveAviator);
  const card = container.querySelector('[data-testid="game-card"]');

  expect(container.querySelector('[data-testid="game-card-play-cta"]')).not.toBeNull();
  act(() => card.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  expect(mockNavigate).toHaveBeenCalledWith("/?auth=login");
  expect(mockNavigate).not.toHaveBeenCalledWith("/games/aviator/play");

  unmount();
});

test("PLAY NOW CTA uses a looping CSS animation that honors reduced motion", () => {
  const css = fs.readFileSync(path.join(__dirname, "../index.css"), "utf8");
  expect(css).toContain("@keyframes fg-play-now-nudge");
  expect(css).toContain("@keyframes fg-play-now-arrow");
  expect(css).toMatch(/@keyframes fg-play-now-nudge[\s\S]*translateX\((1[0-4]|[8-9])px\)/);
  expect(css).toMatch(/@keyframes fg-play-now-arrow[\s\S]*translateX\([4-9]px\)/);
  expect(css).toMatch(/\.fg-play-now-cta__motion[\s\S]*animation:\s*fg-play-now-nudge\s+[\d.]+s\s+ease-in-out\s+infinite/);
  expect(css).toMatch(/\.fg-play-now-cta__arrow[\s\S]*animation:\s*fg-play-now-arrow\s+[\d.]+s\s+ease-in-out\s+infinite/);
  expect(css).toMatch(/\.fg-play-now-cta[\s\S]*font-weight:\s*800/);
  expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.fg-play-now-cta[\s\S]*animation:\s*none/);
});
