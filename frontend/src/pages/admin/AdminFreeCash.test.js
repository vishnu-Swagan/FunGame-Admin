import { act } from "react";
import { createRoot } from "react-dom/client";
import { api } from "@/lib/api";
import AdminFreeCash from "./AdminFreeCash";

jest.mock("@/lib/api", () => ({ api: { get: jest.fn(), patch: jest.fn() }, errMsg: (error) => error.message }));
jest.mock("@/components/common", () => ({ PageTransition: ({ children }) => <div>{children}</div> }));

beforeEach(() => {
  api.get.mockResolvedValue({ data: { free_cash_claim_inr: 250, free_cash_register_min: 1, free_cash_register_max: 10, free_cash_deposit_min: 2, free_cash_deposit_max: 12, bonus_amount_inr: 500, bonus_wager_multiplier: 30, deposit_wager_multiplier: 1, bonus_duration_hours: 84, bonus_on: "first_deposit" } });
  api.patch.mockResolvedValue({ data: {} });
});

test("loads and saves existing promo settings", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => { root.render(<AdminFreeCash />); await Promise.resolve(); });
  expect(container.textContent).toContain("Free Cash & promotions");
  expect(container.textContent).toContain("Registration reward minimum");
  expect(api.get).toHaveBeenCalledWith("/admin/promo/settings");
  await act(async () => { container.querySelector("[data-testid=free-cash-save]").click(); await Promise.resolve(); });
  expect(api.patch).toHaveBeenCalledWith("/admin/promo/settings", expect.objectContaining({ free_cash_claim_inr: 250, bonus_on: "first_deposit" }));
  await act(async () => root.unmount());
});
