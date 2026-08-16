import {
  newPointAdjustmentKey,
  pointAdjustmentHeaders,
  validatePointAdjustment,
} from "./pointAdjustment";

describe("virtual point adjustment form", () => {
  it("accepts a signed whole-number correction with an audit note", () => {
    expect(validatePointAdjustment({ amount: "-125", note: "Reverse duplicate allocation" }))
      .toEqual({ delta: -125, note: "Reverse duplicate allocation" });
  });

  it("rejects zero, fractional, out-of-range, and unaudited amounts", () => {
    expect(validatePointAdjustment({ amount: "0", note: "Reason" }).error).toMatch(/non-zero/);
    expect(validatePointAdjustment({ amount: "1.5", note: "Reason" }).error).toMatch(/whole/);
    expect(validatePointAdjustment({ amount: "1000001", note: "Reason" }).error).toMatch(/1,000,000/);
    expect(validatePointAdjustment({ amount: "10", note: "x" }).error).toMatch(/ledger note/);
  });

  it("creates a ledger-safe idempotency key", () => {
    const key = newPointAdjustmentKey({
      randomUUID: () => "d5a8a9f4-5a7e-4b08-aee0-3f99fc2e186e",
    });
    expect(key).toMatch(/^admin-points-[A-Za-z0-9-]+$/);
    expect(key.length).toBeGreaterThanOrEqual(8);
  });

  it("uses Web Crypto bytes when randomUUID is unavailable", () => {
    const key = newPointAdjustmentKey({
      getRandomValues: (bytes) => {
        bytes.fill(0xab);
        return bytes;
      },
    });
    expect(key).toBe(`admin-points-${"ab".repeat(16)}`);
  });

  it("fails closed when secure browser randomness is unavailable", () => {
    expect(() => newPointAdjustmentKey({}))
      .toThrow("Secure randomness is unavailable");
  });

  it("reuses the caller-owned key for every retry and never invents a missing one", () => {
    const key = "admin-points-d5a8a9f4-5a7e-4b08-aee0-3f99fc2e186e";
    expect(pointAdjustmentHeaders(key)).toEqual({ "X-Idempotency-Key": key });
    expect(pointAdjustmentHeaders(key)).toEqual({ "X-Idempotency-Key": key });
    expect(() => pointAdjustmentHeaders(""))
      .toThrow("stable point-adjustment retry key");
  });
});
