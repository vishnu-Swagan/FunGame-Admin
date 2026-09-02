import { formatInrPaise, isFinancialFeatureAvailable, isOperatorRailAvailable, isPlayerPaymentAvailable, normalizeWallet, rupeesToPaise, userWithdrawalStatus } from "./walletUtils";

test("parses rupees to integer paise without float arithmetic", () => {
  expect(rupeesToPaise("500")).toBe(50000);
  expect(rupeesToPaise("1,234.5")).toBe(123450);
  expect(rupeesToPaise("99.99")).toBe(9999);
  expect(rupeesToPaise("1.999")).toBeNull();
});

test("formats integer paise as INR", () => {
  expect(formatInrPaise(123450)).toContain("1,234.50");
});

test("normalizes wallet balance aliases while preserving split balances", () => {
  expect(normalizeWallet({ wallet: { available_chips: 90, cash_chips: 70, bonus_chips: 20, held_chips: 10, withdrawable_chips: 60 } })).toEqual({
    available_chips: 90,
    cash_chips: 70,
    bonus_chips: 20,
    held_chips: 10,
    withdrawable_chips: 60,
    wager_remaining_chips: 0,
  });
  expect(normalizeWallet({}, 25).available_chips).toBe(25);
});

test("collapses internal withdrawal states into clear player states", () => {
  expect(userWithdrawalStatus("PENDING")).toBe("Pending");
  expect(userWithdrawalStatus("PENDING_ADMIN")).toBe("Pending");
  expect(userWithdrawalStatus("APPROVED")).toBe("Processing");
  expect(userWithdrawalStatus("PAID")).toBe("Paid");
});

test("financial actions fail closed until both readiness and feature flags are true", () => {
  expect(isFinancialFeatureAvailable(null, "deposits")).toBe(false);
  expect(isFinancialFeatureAvailable({ ready: true, features: { real_money: false, deposits: true } }, "deposits")).toBe(false);
  expect(isFinancialFeatureAvailable({ ready: false, features: { real_money: true, deposits: true } }, "deposits")).toBe(false);
  expect(isFinancialFeatureAvailable({ ready: true, features: { real_money: true, deposits: true } }, "deposits")).toBe(true);
});

test("operator rail unlocks player money actions without flipping certified financial flags", () => {
  const dormant = {
    ready: false,
    features: { real_money: false, deposits: false, withdrawals: false },
    operator: { enabled: true, deposits_enabled: true, withdrawals_enabled: true },
  };
  expect(isFinancialFeatureAvailable(dormant, "deposits")).toBe(false);
  expect(isOperatorRailAvailable(dormant, "deposits")).toBe(true);
  expect(isPlayerPaymentAvailable(dormant, "deposits")).toBe(true);
  expect(isPlayerPaymentAvailable(dormant, "withdrawals")).toBe(true);
  expect(isOperatorRailAvailable({ operator: { enabled: false, deposits_enabled: true } }, "deposits")).toBe(false);
});
