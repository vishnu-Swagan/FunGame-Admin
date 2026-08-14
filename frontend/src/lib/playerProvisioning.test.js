import {
  buildPlayerCreatePayload,
  normalizePlayerLoginId,
  validatePlayerProvisioning,
} from "./playerProvisioning";

describe("player provisioning form", () => {
  const validValues = {
    loginId: "gk1234567",
    fullName: "Ravi Kumar",
    password: "TempPass7",
    passwordConfirmation: "TempPass7",
    startingPoints: "",
  };

  it("normalizes a valid Login ID and omits optional opening points", () => {
    expect(normalizePlayerLoginId(" gk1234567 ")).toBe("GK1234567");
    expect(validatePlayerProvisioning(validValues)).toBeNull();
    expect(buildPlayerCreatePayload(validValues)).toEqual({
      login_id: "GK1234567",
      full_name: "Ravi Kumar",
      password: "TempPass7",
    });
  });

  it("accepts the eight-digit client Login ID form", () => {
    const legacyLength = { ...validValues, loginId: "GK00290877" };
    expect(validatePlayerProvisioning(legacyLength)).toBeNull();
    expect(buildPlayerCreatePayload(legacyLength).login_id).toBe("GK00290877");
  });

  it("rejects malformed IDs, mismatched passwords, and invalid point amounts", () => {
    expect(validatePlayerProvisioning({ ...validValues, loginId: "GK123" }))
      .toBe("Login ID must be GK followed by seven or eight digits.");
    expect(validatePlayerProvisioning({ ...validValues, passwordConfirmation: "different" }))
      .toBe("The temporary passwords do not match.");
    expect(validatePlayerProvisioning({ ...validValues, startingPoints: "1.5" }))
      .toBe("Initial virtual points must be a whole number from 0 to 1,000,000.");
  });

  it("includes an operator-entered opening balance only when supplied", () => {
    expect(buildPlayerCreatePayload({ ...validValues, startingPoints: "250" }))
      .toMatchObject({ starting_points: 250 });
  });
});
