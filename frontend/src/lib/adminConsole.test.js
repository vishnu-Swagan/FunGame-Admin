import { apiOriginForRuntime, isAdminConsoleHost } from "./adminConsole";

describe("isAdminConsoleHost", () => {
  it("recognizes the dedicated operator hosts", () => {
    expect(isAdminConsoleHost("mydgp.casino")).toBe(true);
    expect(isAdminConsoleHost("WWW.MYDGP.CASINO")).toBe(true);
  });

  it("does not turn the player host into the restricted console", () => {
    expect(isAdminConsoleHost("chakri.casino")).toBe(false);
    expect(isAdminConsoleHost("example.com")).toBe(false);
  });

  it("uses the verified branded API for a fresh dedicated-console session", () => {
    expect(apiOriginForRuntime("https://old-api.example", true)).toBe("https://api.chakri.casino");
    expect(apiOriginForRuntime("https://player-api.example", false)).toBe("https://player-api.example");
  });
});
