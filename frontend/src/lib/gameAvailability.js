export const GAME_STATUS = Object.freeze({
  LIVE: "ENABLED",
  COMING_SOON: "COMING_SOON",
  MAINTENANCE: "MAINTENANCE",
});

export const REVIEWED_GAME_SLUGS = new Set([
  "aviator", "seven-up-down", "fun-roulette", "keno", "pappu-pictures",
  "andar-bahar", "teen-patti", "poker", "blackjack",
  "rummy",
]);

export function isReviewedGame(gameOrSlug) {
  const slug = typeof gameOrSlug === "string" ? gameOrSlug : gameOrSlug?.slug;
  return REVIEWED_GAME_SLUGS.has(String(slug || "").toLowerCase());
}

export function isGameEnabled(game) {
  return isReviewedGame(game) && game?.status === GAME_STATUS.LIVE;
}

export function findCatalogGame(payload, slug) {
  const games = Array.isArray(payload?.games) ? payload.games : [];
  const canonical = String(slug || "").trim().toLowerCase();
  return games.find((game) => String(game?.slug || "").toLowerCase() === canonical) || null;
}

export function gameStatusLabel(status) {
  if (status === GAME_STATUS.LIVE) return "Live";
  if (status === GAME_STATUS.COMING_SOON) return "Coming Soon";
  if (status === GAME_STATUS.MAINTENANCE) return "Maintenance";
  return String(status || "Unavailable").replaceAll("_", " ");
}

export function isComingSoonError(error) {
  const detail = error?.response?.data?.detail;
  return detail?.code === "GAME_COMING_SOON" || detail?.code === "COMING_SOON";
}
