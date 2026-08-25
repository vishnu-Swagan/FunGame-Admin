import { gateRouletteWheelAssets } from "./engine";

test("Roulette opens on the green board and never exposes the wheel shell before both wheel images load", () => {
  const phone = document.createElement("div");
  phone.dataset.mode = "result";
  phone.innerHTML = '<img class="topimg"><img class="topimg">';

  const release = gateRouletteWheelAssets(phone);
  const images = phone.querySelectorAll(".topimg");

  expect(phone.dataset.mode).toBe("bet");
  expect(phone.dataset.wheelReady).toBe("false");
  images[0].dispatchEvent(new Event("load"));
  expect(phone.dataset.wheelReady).toBe("false");
  images[1].dispatchEvent(new Event("load"));
  expect(phone.dataset.wheelReady).toBe("true");

  release();
});
