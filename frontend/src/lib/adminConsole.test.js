import {
  ADMIN_LOGIN_PATH,
  ADMIN_ROOT_PATH,
  CANONICAL_ADMIN_ORIGIN,
  DISTRIBUTOR_LOGIN_PATH,
  DISTRIBUTOR_ROOT_PATH,
  apiAlternatesForRuntime,
  apiOriginForRuntime,
  canonicalAdminPathForBrowserPath,
  canonicalAdminUrlForLocation,
  enforceCanonicalAdminBrowserLocation,
  financialApiOriginForRuntime,
  isAdminConsoleHost,
  isCanonicalProductionHost,
  loginPathForBrowserPath,
} from "./adminConsole";

const browserLocation = (overrides = {}) => ({
  hostname: "fungame-web.onrender.com",
  pathname: "/Admin/login",
  protocol: "https:",
  port: "",
  search: "",
  hash: "",
  ...overrides,
});

test("browser portal routes use the canonical branded entries", () => {
  expect(ADMIN_ROOT_PATH).toBe("/Admin");
  expect(ADMIN_LOGIN_PATH).toBe("/Admin/login");
  expect(DISTRIBUTOR_ROOT_PATH).toBe("/distributor");
  expect(DISTRIBUTOR_LOGIN_PATH).toBe("/distributor/login");
  expect(loginPathForBrowserPath("/Admin/distributors", false)).toBe("/Admin/login");
  expect(loginPathForBrowserPath("/admin/distributors", false)).toBe("/Admin/login");
  expect(loginPathForBrowserPath("/gk-admin-portal/security", false)).toBe("/Admin/login");
  expect(loginPathForBrowserPath("/distributor/reports", false)).toBe("/distributor/login");
  expect(loginPathForBrowserPath("/partner/reports", false)).toBe("/distributor/login");
  expect(loginPathForBrowserPath("/Administrator", false)).toBe("/?auth=login");
  expect(loginPathForBrowserPath("/home", false)).toBe("/?auth=login");
});

describe("canonical admin browser navigation", () => {
  it("maps supported admin entries to the exact /Admin casing", () => {
    expect(CANONICAL_ADMIN_ORIGIN).toBe("https://chakri.casino");
    expect(canonicalAdminPathForBrowserPath("/Admin/distributors")).toBe("/Admin/distributors");
    expect(canonicalAdminPathForBrowserPath("/admin/distributors")).toBe("/Admin/distributors");
    expect(canonicalAdminPathForBrowserPath("/gk-admin-portal")).toBe("/Admin/login");
    expect(canonicalAdminPathForBrowserPath("/gk-admin-portal/users")).toBe("/Admin/users");
    expect(canonicalAdminPathForBrowserPath("/Administrator")).toBeNull();
    expect(canonicalAdminPathForBrowserPath("/admin-tools")).toBeNull();
  });

  it("redirects Render and legacy CRM admin paths while preserving suffix, query and hash", () => {
    expect(canonicalAdminUrlForLocation(browserLocation({
      pathname: "/Admin/distributors/JAMES1",
      search: "?tab=players&status=ACTIVE",
      hash: "#history",
    }))).toBe("https://chakri.casino/Admin/distributors/JAMES1?tab=players&status=ACTIVE#history");

    expect(canonicalAdminUrlForLocation(browserLocation({
      hostname: "crm.chakri.casino",
      pathname: "/admin/security",
      search: "?event=latest",
      hash: "#audit",
    }))).toBe("https://chakri.casino/Admin/security?event=latest#audit");
  });

  it("closes dedicated CRM root and fallback entries without taking distributor routes", () => {
    expect(canonicalAdminUrlForLocation(browserLocation({
      hostname: "crm.chakri.casino",
      pathname: "/",
      search: "?source=bookmark",
      hash: "#sign-in",
    }))).toBe("https://chakri.casino/Admin/login?source=bookmark#sign-in");
    expect(canonicalAdminUrlForLocation(browserLocation({
      hostname: "crm.chakri.casino",
      pathname: "/old-console-bookmark",
    }))).toBe("https://chakri.casino/Admin/login");
    expect(canonicalAdminUrlForLocation(browserLocation({
      hostname: "crm.chakri.casino",
      pathname: "/distributor/login",
    }))).toBeNull();
    expect(canonicalAdminUrlForLocation(browserLocation({
      hostname: "crm.chakri.casino",
      pathname: "/partner/reports",
    }))).toBeNull();
  });

  it.each([
    "www.chakri.casino",
    "play.chakri.casino",
    "mydgp.casino",
    "www.mydgp.casino",
    "chakri-casino.onrender.com",
  ])("redirects an enumerated legacy public host: %s", (hostname) => {
    expect(canonicalAdminUrlForLocation(browserLocation({ hostname })))
      .toBe("https://chakri.casino/Admin/login");
  });

  it("canonicalizes legacy paths and insecure apex admin navigation", () => {
    expect(canonicalAdminUrlForLocation(browserLocation({
      hostname: "chakri.casino",
      pathname: "/admin/users",
    }))).toBe("https://chakri.casino/Admin/users");
    expect(canonicalAdminUrlForLocation(browserLocation({
      hostname: "chakri.casino",
      pathname: "/Admin/users",
      protocol: "http:",
    }))).toBe("https://chakri.casino/Admin/users");
  });

  it("does not redirect canonical, preview, player or distributor navigation", () => {
    expect(canonicalAdminUrlForLocation(browserLocation({
      hostname: "chakri.casino",
      pathname: "/Admin/users",
    }))).toBeNull();
    expect(canonicalAdminUrlForLocation(browserLocation({
      hostname: "release-123.onrender.com",
      pathname: "/Admin/users",
    }))).toBeNull();
    expect(canonicalAdminUrlForLocation(browserLocation({ pathname: "/home" }))).toBeNull();
    expect(canonicalAdminUrlForLocation(browserLocation({ pathname: "/games/aviator" }))).toBeNull();
    expect(canonicalAdminUrlForLocation(browserLocation({ pathname: "/distributor/login" }))).toBeNull();
    expect(canonicalAdminUrlForLocation(browserLocation({ pathname: "/distributor/reports" }))).toBeNull();
  });

  it("uses a history-replacing navigation only when a redirect is required", () => {
    const replace = jest.fn();
    expect(enforceCanonicalAdminBrowserLocation(browserLocation({ replace }))).toBe(true);
    expect(replace).toHaveBeenCalledWith("https://chakri.casino/Admin/login");

    replace.mockClear();
    expect(enforceCanonicalAdminBrowserLocation(browserLocation({
      hostname: "chakri.casino",
      replace,
    }))).toBe(false);
    expect(replace).not.toHaveBeenCalled();
  });
});

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
