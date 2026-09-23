import { findCatalogGame, GAME_STATUS, gameStatusLabel, isComingSoonError, isGameEnabled, isReviewedGame, REVIEWED_GAME_SLUGS } from "./gameAvailability";

test("only reviewed games with the server ENABLED status are playable", () => {
  expect(isGameEnabled({ slug: "aviator", status: GAME_STATUS.LIVE })).toBe(true);
  expect(isGameEnabled({ slug: "bingo", status: GAME_STATUS.LIVE })).toBe(false);
  expect(isGameEnabled({ slug: "aviator", status: GAME_STATUS.COMING_SOON })).toBe(false);
  expect(isGameEnabled({ slug: "aviator", status: GAME_STATUS.MAINTENANCE })).toBe(false);
  expect(isGameEnabled(null)).toBe(false);
});

test("status labels use player-facing language", () => {
  expect(gameStatusLabel("ENABLED")).toBe("Live");
  expect(gameStatusLabel("COMING_SOON")).toBe("Coming Soon");
  expect(gameStatusLabel("MAINTENANCE")).toBe("Maintenance");
});

test("recognises the canonical and legacy coming-soon error codes", () => {
  expect(isComingSoonError({ response: { data: { detail: { code: "GAME_COMING_SOON" } } } })).toBe(true);
  expect(isComingSoonError({ response: { data: { detail: { code: "COMING_SOON" } } } })).toBe(true);
});

test("supported live views include Chicken Road but still require server publication", () => {
  expect(REVIEWED_GAME_SLUGS.size).toBe(11);
  expect(["aviator", "seven-up-down", "fun-roulette", "keno", "pappu-pictures", "andar-bahar", "teen-patti", "poker", "blackjack", "rummy"].every(isReviewedGame)).toBe(true);
  expect(isReviewedGame("bingo")).toBe(false);
  expect(isGameEnabled({ slug: "chicken-road", status: GAME_STATUS.COMING_SOON })).toBe(false);
  expect(isGameEnabled({ slug: "chicken-road", status: GAME_STATUS.MAINTENANCE })).toBe(false);
  expect(isGameEnabled({ slug: "chicken-road", status: GAME_STATUS.LIVE })).toBe(true);
});

test("a locked detail can be recovered from the public catalogue", () => {
  const game = findCatalogGame({ games: [{ slug: "bingo", status: "COMING_SOON" }] }, "BINGO");
  expect(game).toEqual({ slug: "bingo", status: "COMING_SOON" });
  expect(findCatalogGame({ games: [] }, "missing")).toBeNull();
});
