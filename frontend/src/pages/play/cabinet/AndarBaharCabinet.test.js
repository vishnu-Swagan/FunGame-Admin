import fs from "fs";
import path from "path";

const component = fs.readFileSync(path.join(__dirname, "AndarBaharCabinet.js"), "utf8");
const styles = fs.readFileSync(path.join(__dirname, "andarBahar.css"), "utf8");

test("Andar Bahar has no dealer image or video layer", () => {
  expect(component).not.toMatch(/dealer-(?:stage|ambient|idle|loop)\.(?:jpg|mp4)/);
  expect(component).not.toMatch(/<video\b/);
  expect(component).not.toMatch(/ab-dealer-/);
});

test("the royal table fills the complete 1600 by 900 game canvas", () => {
  expect(component).toContain('id="ab-royal-felt"');
  expect(component).toContain('id="ab-royal-wood"');
  expect(component).toContain('<rect x="18" y="68" width="1564" height="598"');
  expect(component).toContain('data-testid="andar-bahar-canvas"');
  expect(styles).toMatch(/\.ab-table-cover,\s*\.ab-canvas\s*\{[^}]*width:\s*1600px;[^}]*height:\s*900px;/s);
});

test("the game preserves the shared safe viewport without double-applying insets", () => {
  expect(styles).not.toMatch(/\.ab-cabinet\.cab-viewport\s*\{/);
  expect(styles).toMatch(/\.ab-more-games\s*\{[^}]*top:\s*0;[^}]*left:\s*0;/s);
  expect(styles).toMatch(/\.ab-top-actions\s*\{[^}]*top:\s*10px;[^}]*right:\s*14px;/s);
});

test("live round timing and server-backed betting remain wired", () => {
  expect(component).toContain("useLiveRound");
  expect(component).toContain("bettingOpenAt");
  expect(component).toContain("dealerFrameAt");
  expect(component).toContain("placeBet");
});
