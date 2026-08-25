import { act } from "react";
import { createRoot } from "react-dom/client";
import fs from "fs";
import path from "path";

import RummyRoyalSettlement, {
  normalizeSettlementGroups,
  RUMMY_ROYAL_SETTLEMENT_PHASES,
} from "./RummyRoyalSettlement";
import { RUMMY_SETTLEMENT_AUDIO_CUES } from "./rummyAudio";


jest.mock("@/components/common", () => ({ formatChips: (value) => String(value ?? 0) }));

const cards = [
  { id: "c1", rank: 3, suit: "H", code: "3H" },
  { id: "c2", rank: 4, suit: "H", code: "4H" },
  { id: "c3", rank: 5, suit: "H", code: "5H" },
  { id: "c4", rank: 7, suit: "C", code: "7C" },
  { id: "c5", rank: 8, suit: "C", code: "8C" },
  { id: "c6", rank: 9, suit: "C", code: "9C" },
  { id: "c7", rank: 11, suit: "S", code: "JS" },
  { id: "c8", rank: 11, suit: "H", code: "JH" },
  { id: "c9", rank: 11, suit: "D", code: "JD" },
  { id: "c10", rank: 13, suit: "S", code: "KS" },
  { id: "c11", rank: 13, suit: "H", code: "KH" },
  { id: "c12", rank: 13, suit: "D", code: "KD" },
  { id: "c13", rank: 0, suit: "J", code: "PJ", printedJoker: true },
];

const winnerGroups = [
  { label: "PURE_SEQUENCE", cardIds: ["c1", "c2", "c3"] },
  { label: "PURE_SEQUENCE", cardIds: ["c4", "c5", "c6"] },
  { label: "SET", cardIds: ["c7", "c8", "c9"] },
  { label: "SET", cardIds: ["c10", "c11", "c12", "c13"] },
];

const result = {
  settledAt: "2026-08-23T10:00:00.000Z",
  winnerSeat: 0,
  winnerName: "You",
  payoutChips: 725,
  reason: "VALID_DECLARATION",
  rows: [
    { seatIndex: 0, playerId: "P1", displayName: "You", status: "WON", points: 0, chipDelta: 725, cards, groups: winnerGroups },
    { seatIndex: 1, playerId: "P2", displayName: "Maya", status: "LOST", points: 34, chipDelta: -100, cards: cards.slice(0, 4), groups: [] },
  ],
};

beforeAll(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  jest.useFakeTimers();
  window.requestAnimationFrame = (callback) => window.setTimeout(() => callback(Date.now()), 16);
  window.cancelAnimationFrame = (id) => window.clearTimeout(id);
});

afterEach(() => {
  document.body.innerHTML = "";
  jest.clearAllTimers();
  jest.useRealTimers();
});

async function render(element) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(element);
    await Promise.resolve();
  });
  return { container, root };
}

async function click(element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
  });
}

async function pressKey(key, options = {}) {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options }));
    await Promise.resolve();
  });
}

test("server settlement drives a gated in-table celebration and exact premium summary", async () => {
  const onLobby = jest.fn();
  const onSkip = jest.fn();
  const onPhaseChange = jest.fn();
  const onCue = jest.fn();
  const { container, root } = await render(
    <RummyRoyalSettlement
      result={result}
      viewerSeatIndex={0}
      onLobby={onLobby}
      onSkip={onSkip}
      onPhaseChange={onPhaseChange}
      onCue={onCue}
      autoAdvance={false}
    />,
  );

  const dialog = container.querySelector('[data-testid="rummy-royal-settlement"]');
  expect(dialog.dataset.phase).toBe(RUMMY_ROYAL_SETTLEMENT_PHASES.CELEBRATION);
  expect(dialog.getAttribute("aria-busy")).toBe("true");
  expect(document.activeElement).toBe(dialog);
  expect(container.querySelectorAll(".rrs-particles i")).toHaveLength(18);
  expect(container.querySelector(".rrs-win-ribbon")?.textContent).toContain("CHAKRI WIN");
  expect(container.querySelector(".rrs-payout")?.getAttribute("aria-label")).toBe("725 chips payout");
  expect(container.querySelector(".rrs-showcase-hand")?.querySelectorAll(".rrs-card")).toHaveLength(13);
  expect(container.querySelector(".rrs-showcase-hand")?.textContent).toContain("PURE SEQUENCE");
  expect(container.querySelector(".rrs-skip")).toBeNull();

  await act(async () => { jest.advanceTimersByTime(179); });
  expect(onCue).not.toHaveBeenCalled();
  await act(async () => { jest.advanceTimersByTime(1); });
  expect(onCue).toHaveBeenLastCalledWith(RUMMY_SETTLEMENT_AUDIO_CUES.CARD_SETTLE);
  await act(async () => { jest.advanceTimersByTime(469); });
  expect(onCue).toHaveBeenCalledWith(RUMMY_SETTLEMENT_AUDIO_CUES.GROUP_VALIDATION);
  await act(async () => { jest.advanceTimersByTime(1); });
  expect(onCue).toHaveBeenCalledWith(RUMMY_SETTLEMENT_AUDIO_CUES.ROYAL_RISE);
  await act(async () => { jest.advanceTimersByTime(49); });
  expect(container.querySelector(".rrs-skip")).toBeNull();
  await act(async () => { jest.advanceTimersByTime(1); });
  const continueButton = container.querySelector(".rrs-skip");
  expect(continueButton).not.toBeNull();
  await click(continueButton);

  expect(onSkip).toHaveBeenCalledTimes(1);
  expect(onPhaseChange).toHaveBeenCalledWith(RUMMY_ROYAL_SETTLEMENT_PHASES.SUMMARY);
  expect(onCue).toHaveBeenCalledWith(RUMMY_SETTLEMENT_AUDIO_CUES.FINAL_PAYOUT);
  expect(dialog.dataset.phase).toBe(RUMMY_ROYAL_SETTLEMENT_PHASES.SUMMARY);
  expect(dialog.getAttribute("aria-busy")).toBe("false");
  expect(container.querySelector('[data-testid="rrs-summary-stage"]')).not.toBeNull();
  expect(container.querySelector(".rrs-final-hand")?.querySelectorAll(".rrs-card")).toHaveLength(13);
  expect(container.querySelectorAll(".rrs-standing-rows > article")).toHaveLength(2);
  expect(container.querySelector(".rrs-summary-hero .rrs-payout")?.dataset.payoutChips).toBe("725");
  const lobbyButton = container.querySelector(".rrs-summary-actions button");
  expect(document.activeElement).toBe(lobbyButton);

  await pressKey("Tab");
  expect(document.activeElement).toBe(lobbyButton);
  await pressKey("Tab", { shiftKey: true });
  expect(document.activeElement).toBe(lobbyButton);
  await pressKey("Escape");
  expect(onLobby).toHaveBeenCalledTimes(1);

  act(() => root.unmount());
});

test("reduced motion renders the exact final settlement immediately without particles", async () => {
  const { container, root } = await render(
    <RummyRoyalSettlement result={result} viewerSeatIndex={1} onLobby={jest.fn()} reducedMotion />,
  );
  const dialog = container.querySelector('[data-testid="rummy-royal-settlement"]');
  expect(dialog.dataset.phase).toBe(RUMMY_ROYAL_SETTLEMENT_PHASES.SUMMARY);
  expect(dialog.dataset.reducedMotion).toBe("true");
  expect(container.querySelector(".rrs-particles")).toBeNull();
  expect(container.querySelector("#rrs-title")?.textContent).toBe("You wins");
  expect(container.querySelector(".rrs-summary-hero .rrs-payout strong")?.textContent).toBe("725");
  expect(container.querySelector(".rrs-final-hand")?.querySelectorAll(".rrs-card")).toHaveLength(13);
  act(() => root.unmount());
});

test("group normalization never fabricates a valid classification", () => {
  const neutral = normalizeSettlementGroups({ cards: cards.slice(0, 3), groups: [] });
  expect(neutral).toHaveLength(1);
  expect(neutral[0]).toMatchObject({ label: "FINAL HAND", tone: "neutral", authoritative: false });

  const partial = normalizeSettlementGroups({
    cards: cards.slice(0, 4),
    groups: [{ label: "PURE_SEQUENCE", cardIds: ["c1", "c2", "c3"] }],
  });
  expect(partial.map(({ label }) => label)).toEqual(["PURE SEQUENCE", "UNGROUPED"]);
  expect(partial[1]).toMatchObject({ tone: "ruby", authoritative: true });
});

test("settlement motion stays bounded, GPU-oriented and reduced-motion aware", () => {
  const css = fs.readFileSync(path.join(__dirname, "rummy-royal-settlement.css"), "utf8");
  expect(css).toContain("@media (prefers-reduced-motion: reduce)");
  expect(css).toContain("@keyframes rrs-coin-fall");
  expect(css).not.toMatch(/transition:\s*all/i);
  expect(css).not.toMatch(/scale\(0\)/);
  expect(css).not.toMatch(/animation[^;{}]*ease-in(?:\s|;)/i);
  expect(css).not.toMatch(/@keyframes[^{}]*\{[^{}]*(?:width|height|margin|padding|top|left):/s);
});
