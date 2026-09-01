import { deriveAviatorElapsed, shouldAcceptAviatorSnapshot } from "./context";

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

describe("Aviator server-clock rendering", () => {
  it("accounts for response age during a live flight", () => {
    expect(deriveAviatorElapsed({
      phase: "FLYING",
      fly_elapsed: 3.2,
      server_now: 100,
    }, 100.18)).toBeCloseTo(3.38, 5);
  });

  it("keeps the betting countdown inside its server window", () => {
    expect(deriveAviatorElapsed({
      phase: "BETTING",
      betting_seconds: 5,
      phase_ends_in: 4.4,
      server_now: 100,
    }, 100.2)).toBeCloseTo(0.8, 5);
    expect(deriveAviatorElapsed({
      phase: "BETTING",
      betting_seconds: 5,
      phase_ends_in: 0,
      server_now: 100,
    }, 105)).toBe(5);
  });

  it("uses the fixed server flight duration after a crash", () => {
    expect(deriveAviatorElapsed({
      phase: "CRASHED",
      flight_seconds: 17.8,
      server_now: 100,
    }, 101)).toBe(17.8);
  });
});
