import { payments, responseRows } from "./paymentApi";

const mockFinancialGet = jest.fn();
const mockFinancialPost = jest.fn();
const mockIdempotentPost = jest.fn();

jest.mock("@/lib/api", () => ({
  financialApi: {
    get: (...args) => mockFinancialGet(...args),
    post: (...args) => mockFinancialPost(...args),
  },
  financialPost: (...args) => mockIdempotentPost(...args),
}));

beforeEach(() => {
  jest.clearAllMocks();
});

test("payment response rows accept the canonical key and a rollout alias", () => {
  expect(responseRows({ audit: [{ id: "a" }] }, "audit", ["events"])).toEqual([{ id: "a" }]);
  expect(responseRows({ events: [{ id: "legacy" }] }, "audit", ["events"])).toEqual([{ id: "legacy" }]);
  expect(responseRows({}, "audit", ["events"])).toEqual([]);
});

test("operator deposit sends the caller idempotency key", async () => {
  mockIdempotentPost.mockResolvedValue({ data: { checkout_url: "https://root.sgpay24.com/pay/1" } });

  await expect(payments.createOperatorDeposit(250000, "deposit-key-123")).resolves.toEqual({
    checkout_url: "https://root.sgpay24.com/pay/1",
  });
  expect(mockIdempotentPost).toHaveBeenCalledWith("/payments/operator/deposits", {
    amount_paise: 250000,
    note: null,
  }, { idempotencyKey: "deposit-key-123" });
});

test("deposit refresh uses the authenticated financial client without failover", async () => {
  mockFinancialPost.mockResolvedValue({ data: { deposit: { id: "dep-1", status: "CREDITED" } } });

  await expect(payments.refreshDeposit("dep/1")).resolves.toEqual({ id: "dep-1", status: "CREDITED" });
  expect(mockFinancialPost).toHaveBeenCalledWith(
    "/payments/deposits/dep%2F1/refresh",
    {},
    { __noFailover: true },
  );
});

test("UTR claim is submitted to the authenticated deposit endpoint", async () => {
  mockFinancialPost.mockResolvedValue({ data: { deposit: { id: "dep-1", status: "PENDING" } } });

  await expect(payments.submitDepositUtr("dep/1", "123456789012")).resolves.toEqual({
    id: "dep-1",
    status: "PENDING",
  });
  expect(mockFinancialPost).toHaveBeenCalledWith(
    "/payments/deposits/dep%2F1/utr",
    { utr: "123456789012" },
    { __noFailover: true },
  );
});
