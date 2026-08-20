import { clearFinancialIntent, financialIntentKey } from "./financialIntent";

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

test("reuses one key for an ambiguous retry of the same financial intent", () => {
  const storage = memoryStorage();
  const first = financialIntentKey("deposit", "user-1", "amount_paise=50000", storage);
  const retry = financialIntentKey("deposit", "user-1", "amount_paise=50000", storage);
  expect(retry).toBe(first);
});

test("rotates the key when the amount or selected payout method changes", () => {
  const storage = memoryStorage();
  const first = financialIntentKey("withdrawal", "user-1", "chips=500|bank=a", storage);
  const changed = financialIntentKey("withdrawal", "user-1", "chips=500|bank=b", storage);
  expect(changed).not.toBe(first);
});

test("clears only the completed intent and not a newer in-flight one", () => {
  const storage = memoryStorage();
  const first = financialIntentKey("deposit", "user-1", "amount_paise=50000", storage);
  const newer = financialIntentKey("deposit", "user-1", "amount_paise=100000", storage);
  clearFinancialIntent("deposit", "user-1", first, storage);
  expect(financialIntentKey("deposit", "user-1", "amount_paise=100000", storage)).toBe(newer);
  clearFinancialIntent("deposit", "user-1", newer, storage);
  expect(financialIntentKey("deposit", "user-1", "amount_paise=100000", storage)).not.toBe(newer);
});
