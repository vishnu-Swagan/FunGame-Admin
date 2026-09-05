import { act } from "react";
import { createRoot } from "react-dom/client";
import FreeCash from "./FreeCash";
import { promoApi } from "@/lib/promoApi";

jest.mock("@/lib/promoApi", () => ({
  promoApi: {
    state: jest.fn(),
    claimFreeCash: jest.fn(),
  },
}));

beforeAll(() => { global.IS_REACT_ACT_ENVIRONMENT = true; });
beforeEach(() => {
  promoApi.state.mockResolvedValue({ free_cash: { rules: [] } });
});
afterEach(() => {
  document.body.innerHTML = "";
  document.body.style.overflow = "";
});

test("keeps the Free Cash sheet vertically scrollable while the page behind it is locked", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<FreeCash open onClose={() => {}} initial={{ rules: Array.from({ length: 16 }, (_, index) => `Rule ${index + 1}`) }} />);
    await Promise.resolve();
  });

  const modal = container.querySelector('[data-testid="free-cash-modal"]');
  const sheet = container.querySelector('[data-testid="free-cash-sheet"]');
  expect(modal.className).toContain("overflow-y-auto");
  expect(sheet.className).toContain("overflow-y-auto");
  expect(sheet.className).not.toContain("overflow-hidden");
  expect(document.body.style.overflow).toBe("hidden");

  await act(async () => root.unmount());
  expect(document.body.style.overflow).toBe("");
});
