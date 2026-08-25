import fs from "fs";
import path from "path";

test("the scaled 7Up7Down canvas stays centered inside narrow phone viewports", () => {
  const css = fs.readFileSync(path.join(__dirname, "sevenUpDown.css"), "utf8");
  const stage = css.match(/\.j7-stage\s*\{([^}]*)\}/s)?.[1] || "";
  const table = css.match(/\.j7-table\s*\{([^}]*)\}/s)?.[1] || "";

  expect(stage).toMatch(/position:\s*relative/);
  expect(stage).toMatch(/overflow:\s*hidden/);
  expect(table).toMatch(/position:\s*absolute/);
  expect(table).toMatch(/left:\s*50%/);
  expect(table).toMatch(/top:\s*0/);
  expect(table).toMatch(/width:\s*500px/);
  expect(table).toMatch(/margin-left:\s*-250px/);
  expect(table).toMatch(/transform-origin:\s*top center/);
});
