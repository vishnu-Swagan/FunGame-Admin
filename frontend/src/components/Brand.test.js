import { act } from "react";
import { createRoot } from "react-dom/client";
import fs from "fs";
import path from "path";
import { BRAND_ASSET, BrandWordmark } from "./Brand";

beforeAll(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
});

test("the shared brand component renders the approved wide lockup", () => {
  const container = document.createElement("div");
  const root = createRoot(container);

  act(() => root.render(<BrandWordmark logoClassName="brand-size" />));

  const image = container.querySelector("img");
  expect(BRAND_ASSET).toBe("/chakri-roulette-brand.png");
  expect(image?.getAttribute("src")).toBe(BRAND_ASSET);
  expect(image?.getAttribute("alt")).toBe("CHAKRI.CASINO");
  expect(image?.getAttribute("width")).toBe("1600");
  expect(image?.getAttribute("height")).toBe("400");
  expect(image?.className).toContain("brand-size");

  act(() => root.unmount());
});

test("the installed source artwork keeps its 4:1 dimensions", () => {
  const image = fs.readFileSync(path.join(__dirname, "../../public/chakri-roulette-brand.png"));
  expect(image.subarray(1, 4).toString()).toBe("PNG");
  expect(image.readUInt32BE(16)).toBe(1600);
  expect(image.readUInt32BE(20)).toBe(400);
});

test.each([
  "play/PlayShell.js",
  "play/GameStage.js",
  "play/arcade/Cabinet.js",
  "../pages/play/RummyGame.js",
  "../pages/play/RouletteGame.js",
  "../pages/play/AviatorGame.js",
  "../pages/play/cabinet/SevenUpDownCabinet.js",
  "../pages/play/cabinet/PappuPicturesCabinet.js",
  "../pages/play/cabinet/KenoCabinet.js",
])("%s carries the shared brand lockup", (relativePath) => {
  const source = fs.readFileSync(path.join(__dirname, relativePath), "utf8");
  expect(source).toContain("BrandWordmark");
});
