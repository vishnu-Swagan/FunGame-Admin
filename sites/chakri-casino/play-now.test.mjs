import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const css = fs.readFileSync(path.join(dir, "play-now.css"), "utf8");
const jsx = fs.readFileSync(path.join(dir, "GameCard.jsx"), "utf8");
const hero = fs.readFileSync(path.join(dir, "HeroPlayNow.jsx"), "utf8");
const preview = fs.readFileSync(path.join(dir, "preview.html"), "utf8");

test("ready marketing cards use bold PLAY NOW + arrow and keep the play href", () => {
  assert.match(jsx, /<b>PLAY NOW<\/b>/);
  assert.match(jsx, /play-button-motion/);
  assert.match(jsx, /play-button-arrow/);
  assert.match(jsx, /href=\{playHref\}/);
  assert.match(jsx, /\/games\/\$\{game\.slug\}\/play/);
  assert.match(jsx, /className="game-card-hit"/);
  assert.match(jsx, /aria-label=\{`Play \$\{game\.name\}`\}/);
});

test("Coming Soon cards stay disabled and never show PLAY NOW", () => {
  const component = jsx.slice(0, jsx.indexOf("Minified-source swap"));
  assert.match(component, /play-button is-disabled/);
  assert.match(component, /is not currently available/);
  const disabled = component.slice(component.indexOf("play-button is-disabled"));
  assert.doesNotMatch(disabled, /PLAY NOW/);
  assert.match(component, /<b>PLAY NOW<\/b>/);
});

test("CSS loops both the PLAY NOW label and the arrow and honors reduced motion", () => {
  assert.match(css, /@keyframes chakri-play-now-nudge/);
  assert.match(css, /@keyframes chakri-play-now-arrow/);
  assert.match(css, /translate3d\(14px, 0, 0\)/);
  assert.match(css, /translate3d\(10px, 0, 0\)/);
  assert.match(css, /\.play-button-motion[\s\S]*animation:\s*chakri-play-now-nudge\s+0\.95s\s+ease-in-out\s+infinite/);
  assert.match(css, /\.play-button-arrow[\s\S]*animation:\s*chakri-play-now-arrow\s+0\.95s\s+ease-in-out\s+infinite/);
  assert.match(css, /\.play-button:not\(\.is-disabled\)[\s\S]*font-weight:\s*800/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*animation:\s*none/);
  assert.match(css, /a\.play-button:not\(\.is-disabled\)::after/);
});

test("hero Play now also loops and preview keeps Coming Soon as a non-link", () => {
  assert.match(hero, /hero-play-now-motion/);
  assert.match(hero, /Play now/);
  assert.match(preview, /<b>PLAY NOW<\/b>/);
  assert.match(preview, /game-card-hit/);
  assert.match(preview, /Bingo is not currently available/);
  assert.doesNotMatch(preview.split("Bingo")[1].slice(0, 800), /href="\/games\/bingo/);
});
