import { stationForGame, layoutStations, KINDS } from "./catalog3d";

const CHAKRI_SLUGS = [
  "seven-up-down", "aviator", "bingo", "champion-poker", "checker",
  "fever-joker-bonus", "fun-ab", "fun-roulette", "fun-target",
  "giant-jackpot", "joker-bonus", "keno", "lucky-8-line", "no-hold",
  "super-golden-wheel", "triple-fun",
];

test("every Chakri title maps to a known station archetype", () => {
  for (const slug of CHAKRI_SLUGS) {
    const s = stationForGame({ slug, name: slug, category: "" });
    expect(KINDS).toContain(s.kind);
    expect(s.accent).toMatch(/^#[0-9a-f]{6}$/i);
  }
});

test("unknown slugs fall back to their catalog category", () => {
  const s = stationForGame({ slug: "brand-new-game", category: "Cards" });
  expect(s.kind).toBe("cards");
});

test("unknown slug and category fall back to a slot cabinet", () => {
  const s = stationForGame({ slug: "mystery", category: "Weird" });
  expect(s.kind).toBe("slot");
});

test("layout gives every station a unique floor position", () => {
  const games = CHAKRI_SLUGS.map((slug) => ({ slug, name: slug }));
  const placed = layoutStations(games);
  expect(placed).toHaveLength(CHAKRI_SLUGS.length);
  const keys = new Set(placed.map((p) => p.position.join(",")));
  expect(keys.size).toBe(placed.length);
  for (const p of placed) {
    expect(Number.isFinite(p.position[0])).toBe(true);
    expect(Number.isFinite(p.position[2])).toBe(true);
  }
});
