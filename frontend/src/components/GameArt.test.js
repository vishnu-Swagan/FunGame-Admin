import { act } from "react";
import { createRoot } from "react-dom/client";
import { GameArt } from "./GameArt";

const cases = [
  {
    slug: "pappu-pictures",
    path: "/game-art/pappu-pictures.png",
    art: { from: "#004b31", to: "#00a466", accent: "#ffe34b", icon: "images", glyph: "12" },
  },
  {
    slug: "blackjack",
    path: "/game-art/blackjack.png",
    art: { from: "#08331a", to: "#1d8a4f", accent: "#ffd447", icon: "spade", glyph: "A♠" },
  },
];

beforeAll(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
});

test.each(cases)("$slug uses its canonical static asset path and falls back to branded art", ({ slug, path, art }) => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(<GameArt game={{ slug, art }} showGlints={false} />);
  });
  const image = container.querySelector("img");
  expect(image).not.toBeNull();
  expect(image.getAttribute("src")).toBe(path);

  act(() => {
    image.dispatchEvent(new Event("error", { bubbles: true }));
  });
  expect(container.querySelector("img")).toBeNull();
  expect(container.textContent).toContain(art.glyph);

  act(() => root.unmount());
  container.remove();
});
