import { shouldAcceptAviatorSnapshot } from "./context";

describe("Aviator authoritative startup and round ordering", () => {
  it("accepts the first synchronized server snapshot", () => {
    expect(shouldAcceptAviatorSnapshot(null, "", 41, "FLYING")).toBe(true);
  });

  it("rejects a late result from the previous round after the next round opens", () => {
    expect(shouldAcceptAviatorSnapshot(42, "BETTING", 41, "CRASHED")).toBe(false);
  });

  it("does not regress a live round back to betting", () => {
    expect(shouldAcceptAviatorSnapshot(42, "FLYING", 42, "BETTING")).toBe(false);
    expect(shouldAcceptAviatorSnapshot(42, "CRASHED", 42, "FLYING")).toBe(false);
  });

  it("accepts forward phase progress and the next round", () => {
    expect(shouldAcceptAviatorSnapshot(42, "BETTING", 42, "FLYING")).toBe(true);
    expect(shouldAcceptAviatorSnapshot(42, "FLYING", 42, "CRASHED")).toBe(true);
    expect(shouldAcceptAviatorSnapshot(42, "CRASHED", 43, "BETTING")).toBe(true);
  });
});
