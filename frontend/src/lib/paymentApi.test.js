import { adminPayments, payments, responseRows } from "./paymentApi";
import { financialApi } from "@/lib/api";

const mockFinancialPost = jest.fn();

jest.mock("@/lib/api", () => ({
  financialApi: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
  financialPost: (...args) => mockFinancialPost(...args),
}));

test("payment response rows accept the canonical key and a rollout alias", () => {
  expect(responseRows({ audit: [{ id: "a" }] }, "audit", ["events"])).toEqual([{ id: "a" }]);
  expect(responseRows({ events: [{ id: "legacy" }] }, "audit", ["events"])).toEqual([{ id: "legacy" }]);
  expect(responseRows({}, "audit", ["events"])).toEqual([]);
});

test("deposit attaches only an explicit server consent id", async () => {
  mockFinancialPost.mockResolvedValueOnce({ data: { id: "deposit-1" } });
  await payments.createDeposit(50000, "deposit-key");
  expect(mockFinancialPost).toHaveBeenLastCalledWith("/payments/deposits", { amount_paise: 50000 }, { idempotencyKey: "deposit-key" });

  mockFinancialPost.mockResolvedValueOnce({ data: { id: "deposit-2" } });
  await payments.createDeposit(50000, "deposit-key-2", { promotionConsentId: "consent-1" });
  expect(mockFinancialPost).toHaveBeenLastCalledWith("/payments/deposits", {
    amount_paise: 50000,
    promotion_consent_id: "consent-1",
  }, { idempotencyKey: "deposit-key-2" });
});

test.each([
  ["retryOperatorPayout", "retry-payout"],
  ["syncOperatorPayout", "sync-payout"],
])("%s does not fail over or create another payout request", async (method, endpoint) => {
  financialApi.post.mockResolvedValueOnce({ data: { request: { id: "operator/request" } } });
  await expect(adminPayments[method]("operator/request")).resolves.toEqual({ request: { id: "operator/request" } });
  expect(financialApi.post).toHaveBeenLastCalledWith(
    `/admin/payments/operator-requests/operator%2Frequest/${endpoint}`, {}, { __noFailover: true },
  );
});
