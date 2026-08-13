import { isAdminConsoleHost } from "./adminConsole";

describe("isAdminConsoleHost", () => {
  it("recognizes the dedicated operator hosts", () => {
    expect(isAdminConsoleHost("mydgp.casino")).toBe(true);
    expect(isAdminConsoleHost("WWW.MYDGP.CASINO")).toBe(true);
  });

  it("does not turn the player host into the restricted console", () => {
    expect(isAdminConsoleHost("chakri.casino")).toBe(false);
    expect(isAdminConsoleHost("example.com")).toBe(false);
  });
});
