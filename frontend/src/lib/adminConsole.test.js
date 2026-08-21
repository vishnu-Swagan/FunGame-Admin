import {
  apiAlternatesForRuntime,
  apiOriginForRuntime,
  financialApiOriginForRuntime,
  isAdminConsoleHost,
  isCanonicalProductionHost,
} from "./adminConsole";

describe("isAdminConsoleHost", () => {
  it("recognizes the dedicated operator hosts", () => {
    expect(isAdminConsoleHost("crm.chakri.casino")).toBe(true);
    expect(isAdminConsoleHost("CRM.CHAKRI.CASINO")).toBe(true);
  });

  it("does not turn the player host into the restricted console", () => {
    expect(isAdminConsoleHost("chakri.casino")).toBe(false);
    expect(isAdminConsoleHost("mydgp.casino")).toBe(false);
    expect(isAdminConsoleHost("example.com")).toBe(false);
  });

  it("uses the verified branded API for a fresh dedicated-console session", () => {
    expect(apiOriginForRuntime(
      "https://old-api.example", true, "crm.chakri.casino",
    )).toBe("https://api.chakri.casino");
    expect(apiOriginForRuntime(
      "https://player-api.example", false, "chakri.casino",
    )).toBe("https://api.chakri.casino");
  });

  it("never points a staging or localhost build at production APIs", () => {
    const stagingApi = "https://chakri-api-staging.onrender.com";
    expect(isCanonicalProductionHost("release-123.onrender.com")).toBe(false);
    expect(isCanonicalProductionHost("localhost")).toBe(false);
    expect(apiOriginForRuntime(stagingApi, true, "release-123.onrender.com")).toBe(stagingApi);
    expect(financialApiOriginForRuntime(stagingApi, "release-123.onrender.com")).toBe(stagingApi);
    expect(financialApiOriginForRuntime("http://127.0.0.1:8089", "localhost"))
      .toBe("http://127.0.0.1:8089");
    expect(apiAlternatesForRuntime(
      stagingApi, stagingApi, "release-123.onrender.com",
    )).toEqual([stagingApi]);
  });

  it("pins every canonical production request to one ledger", () => {
    expect(isCanonicalProductionHost("fungame-web.onrender.com")).toBe(true);
    expect(isCanonicalProductionHost("mydgp.casino")).toBe(true);
    expect(financialApiOriginForRuntime(
      "https://configured.example", "chakri.casino",
    )).toBe("https://api.chakri.casino");
    expect(apiAlternatesForRuntime(
      "https://configured.example", "https://configured.example", "chakri.casino",
    )).toEqual(["https://api.chakri.casino"]);
  });
});
