// Maps the live game catalog onto 3D station archetypes for the casino floor.
// Pure data + functions — no three.js imports — so it stays unit-testable.

// Station archetypes the scene knows how to build.
export const KINDS = [
  "roulette", // horizontal wheel table with orbiting ball
  "dice",     // craps-style table with tumbling dice
  "slot",     // upright cabinet with spinning reels + marquee
  "cards",    // half-moon felt table with flipping cards
  "wheel",    // big vertical fortune wheel on a stand
  "crash",    // aviator screen wall with a flying plane
  "numbers",  // keno/bingo lounge pod with a ball blower
  "board",    // checkerboard strategy table
];

// Zone anchors group station kinds into districts of the hall.
export const ZONES = {
  roulette: "centre",
  dice: "centre",
  cards: "east",
  slot: "west",
  wheel: "north",
  crash: "north",
  numbers: "south",
  board: "south",
};

// Per-slug art direction: archetype + neon accent. Anything not listed
// falls back to its catalog category, then to a slot cabinet.
const BY_SLUG = {
  "fun-roulette": { kind: "roulette", accent: "#ff3355" },
  "seven-up-down": { kind: "dice", accent: "#ffb020" },
  "7up7down": { kind: "dice", accent: "#ffb020" },
  aviator: { kind: "crash", accent: "#ff4433" },
  "giant-jackpot": { kind: "slot", accent: "#ffcc33" },
  "joker-bonus": { kind: "slot", accent: "#a058ff" },
  "fever-joker-bonus": { kind: "slot", accent: "#ff58c8" },
  "lucky-8-line": { kind: "slot", accent: "#33ddff" },
  "triple-fun": { kind: "slot", accent: "#66ff66" },
  "champion-poker": { kind: "cards", accent: "#ffd700" },
  "no-hold": { kind: "cards", accent: "#4fc3ff" },
  "fun-ab": { kind: "cards", accent: "#ff8844" },
  "andar-bahar": { kind: "cards", accent: "#ff8844" },
  "teen-patti": { kind: "cards", accent: "#ffaa22" },
  blackjack: { kind: "cards", accent: "#22e0a0" },
  poker: { kind: "cards", accent: "#e0e0ff" },
  "super-golden-wheel": { kind: "wheel", accent: "#ffd24a" },
  "golden-wheel": { kind: "wheel", accent: "#ffd24a" },
  "ice-fishing": { kind: "wheel", accent: "#7ae8ff" },
  keno: { kind: "numbers", accent: "#42a5ff" },
  bingo: { kind: "numbers", accent: "#ff6fae" },
  "fun-target": { kind: "numbers", accent: "#ff5533" },
  checker: { kind: "board", accent: "#d0a060" },
};

const BY_CATEGORY = {
  Cards: { kind: "cards", accent: "#ffb84d" },
  Slots: { kind: "slot", accent: "#ffcc33" },
  Wheel: { kind: "wheel", accent: "#ffd24a" },
  Numbers: { kind: "numbers", accent: "#42a5ff" },
  Dice: { kind: "dice", accent: "#ffb020" },
  Crash: { kind: "crash", accent: "#ff4433" },
  Board: { kind: "board", accent: "#d0a060" },
};

const FALLBACK = { kind: "slot", accent: "#ffcc33" };

export function stationForGame(game) {
  const spec =
    BY_SLUG[game.slug] || BY_CATEGORY[game.category] || FALLBACK;
  return {
    slug: game.slug,
    name: game.name || game.slug,
    tagline: game.tagline || "",
    category: game.category || "",
    kind: spec.kind,
    accent: spec.accent,
  };
}

// Deterministic floor layout: stations are distributed inside their zone,
// spaced along a line per zone so any catalog size lays out cleanly.
const ZONE_LAYOUT = {
  centre: { origin: [0, -2], step: [11, 0], facing: 0 },
  west: { origin: [-19, -12], step: [0, 6.5], facing: Math.PI / 2 },
  east: { origin: [19, -12], step: [0, 7.5], facing: -Math.PI / 2 },
  north: { origin: [-9, -24], step: [9, 0], facing: 0 },
  south: { origin: [-10, 12], step: [10, 0], facing: Math.PI },
};

export function layoutStations(games) {
  const stations = games.map(stationForGame);
  const counters = {};
  return stations.map((s) => {
    const zone = ZONES[s.kind] || "south";
    const i = (counters[zone] = (counters[zone] || 0) + 1) - 1;
    const L = ZONE_LAYOUT[zone];
    return {
      ...s,
      zone,
      position: [L.origin[0] + L.step[0] * i, 0, L.origin[1] + L.step[1] * i],
      rotationY: L.facing,
    };
  });
}
