import { act } from "react";
import { createRoot } from "react-dom/client";
import { WalletBalanceCard } from "./WalletBits";

jest.mock("@/components/common", () => ({ formatChips: (value) => Number(value || 0).toLocaleString("en-IN") }));

beforeAll(() => { global.IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(() => { document.body.innerHTML = ""; });

test("shows cleared cash, restricted bonus, withdrawal hold and pending reward separately", () => {
  const container = document.createElement("div"); document.body.appendChild(container); const root = createRoot(container);
  act(() => root.render(<WalletBalanceCard wallet={{ available_chips: 1500, withdrawable_chips: 800, restricted_bonus_chips: 400, held_withdrawal_chips: 200, pending_reward_chips: 100 }} />));
  expect(container.textContent).toContain("Withdrawable cash");
  expect(container.textContent).toContain("Restricted bonus");
  expect(container.textContent).toContain("Withdrawal hold");
  expect(container.textContent).toContain("Pending reward");
  expect(container.textContent).toContain("800");
  expect(container.textContent).toContain("400");
  act(() => root.unmount());
});
