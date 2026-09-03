import { act } from "react";
import { createRoot } from "react-dom/client";
import fs from "fs";
import path from "path";
import { BRAND_ASSET, BrandWordmark } from "./Brand";

beforeAll(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
});

test("the shared brand component renders one page-native 3D lockup", () => {
  const container = document.createElement("div");
  const root = createRoot(container);

  act(() => root.render(<BrandWordmark logoClassName="brand-size" />));

  const lockup = container.querySelector('[role="img"]');
  expect(BRAND_ASSET).toBe("/chakri-roulette-emblem-transparent.png");
  expect(lockup?.getAttribute("aria-label")).toBe("CHAKRI.CASINO — PLAY IN THE LIGHT");
  expect(lockup?.className).toContain("brand-size");
  expect(lockup?.querySelectorAll(".chakri-logo__wheel")).toHaveLength(1);
  expect(lockup?.className).toContain("chakri-logo");
  expect(lockup?.querySelector(".chakri-logo__type")).not.toBeNull();
  expect(lockup?.querySelector("strong")?.textContent).toBe("CHAKRI.CASINO");
  expect(lockup?.querySelector("small")?.textContent).toBe("PLAY IN THE LIGHT");
  expect(lockup?.querySelector("img")?.getAttribute("src")).toBe(BRAND_ASSET);

  act(() => root.unmount());
});

test("the installed crest is a square RGBA PNG with real transparency", () => {
  const image = fs.readFileSync(path.join(__dirname, "../../public/chakri-roulette-emblem-transparent.png"));
  expect(image.subarray(1, 4).toString()).toBe("PNG");
  expect(image.readUInt32BE(16)).toBe(1254);
  expect(image.readUInt32BE(20)).toBe(1254);
  expect(image[25]).toBe(6); // PNG colour type 6 = RGBA.
});

test("the page-native lockup never paints an opaque panel", () => {
  const css = fs.readFileSync(path.join(__dirname, "Brand.css"), "utf8");
  const source = fs.readFileSync(path.join(__dirname, "Brand.js"), "utf8");
  expect(css).toContain('background: transparent');
  expect(css).toContain('--chakri-wordmark-font: Georgia, "Times New Roman", serif');
  expect(css).toContain('--chakri-gold: #efc86d');
  expect(css).toContain('--chakri-gold-soft: #f5d584');
  expect(css).toContain('--chakri-primary-hsl: 43 92% 56%');
  expect(css).toMatch(/\.chakri-logo__type strong[\s\S]*font-family:\s*var\(--chakri-wordmark-font/);
  expect(css).not.toMatch(/Gloock|Aptos|Orbitron/);
  expect(source).toContain('PLAY IN THE LIGHT');
  expect(css).not.toMatch(/background:\s*(?:#0b0c10|black|rgb\(11,\s*12,\s*16\))/i);
});

test("the offline shell also uses the transparent crest and corrected live tagline", () => {
  const serviceWorker = fs.readFileSync(path.join(__dirname, "../../public/service-worker.js"), "utf8");
  expect(serviceWorker).toContain("/chakri-roulette-emblem-transparent.png");
  expect(serviceWorker).toContain("PLAY IN THE LIGHT");
  expect(serviceWorker).not.toContain("/chakri-roulette-brand.png");
});

test("future app-icon regeneration cannot reintroduce the retired black-backed lockup", () => {
  const generator = fs.readFileSync(path.join(__dirname, "../../scripts/render_app_icons.py"), "utf8");
  expect(generator).toContain('chakri-roulette-emblem-transparent.png');
  expect(generator).not.toContain('chakri-roulette-brand.png');
  expect(generator).toContain('convert("RGBA")');
});

test("install icons use the real-alpha emblem and retired root badges stay absent", () => {
  for (const name of ["chakri-app-icon-192.png", "chakri-app-icon-512.png", "chakri-apple-touch-icon.png", "chakri-favicon.png"]) {
    const image = fs.readFileSync(path.join(__dirname, `../../public/${name}`));
    expect(image[25]).toBe(6); // PNG colour type 6 = RGBA.
  }
  for (const retired of ["chakri-roulette-brand.png", "chakri-app-icon.svg", "favicon.png", "icon-192.png", "icon-512.png", "icon-maskable-512.png"]) {
    expect(fs.existsSync(path.join(__dirname, `../../public/${retired}`))).toBe(false);
  }
});

test.each([
  "play/PlayShell.js",
  "play/GameStage.js",
  "play/arcade/Cabinet.js",
  "play/GameIntro.js",
  "../pages/play/AviatorGame.js",
  "../pages/play/cabinet/SevenUpDownCabinet.js",
  "../pages/play/cabinet/PappuPicturesCabinet.js",
  "../pages/play/cabinet/KenoCabinet.js",
])("%s keeps the website wordmark outside live gameplay", (relativePath) => {
  const source = fs.readFileSync(path.join(__dirname, relativePath), "utf8");
  expect(source).not.toContain("BrandWordmark");
});

test("the Rummy orientation overlay shows CHAKRI.CASINO through BrandWordmark", () => {
  const source = fs.readFileSync(path.join(__dirname, "../pages/play/RummyGame.js"), "utf8");
  expect(source).toContain("BrandWordmark");
  expect(source).toContain("rummy-orientation-logo");
  expect(source).not.toContain('className="rummy-brand-lockup"');
});

test("the Rummy table-selection lobby keeps the approved website branding", () => {
  const source = fs.readFileSync(path.join(__dirname, "../pages/play/RummyPremiumLobby.js"), "utf8");
  expect(source).toContain("BrandWordmark");
});

test("Roulette keeps the approved wheel-and-green-board-only presentation", () => {
  const source = fs.readFileSync(path.join(__dirname, "../pages/play/RouletteGame.js"), "utf8");
  expect(source).not.toContain("BrandWordmark");
});
