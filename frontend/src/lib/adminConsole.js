const configuredConsoleHosts = (
  process.env.REACT_APP_ADMIN_CONSOLE_HOSTS ||
  "crm.chakri.casino"
)
  .split(",")
  .map((host) => host.trim().toLowerCase())
  .filter(Boolean);

export function isAdminConsoleHost(hostname) {
  return configuredConsoleHosts.includes(String(hostname || "").trim().toLowerCase());
}

const runtimeHostname = typeof window === "undefined" ? "" : window.location.hostname;

const canonicalProductionHosts = new Set([
  "chakri.casino",
  "www.chakri.casino",
  "play.chakri.casino",
  "crm.chakri.casino",
  "mydgp.casino",
  "www.mydgp.casino",
  // This is the currently deployed Render-hosted player application.
  "fungame-web.onrender.com",
]);

const CANONICAL_ADMIN_HOSTNAME = "chakri.casino";
export const CANONICAL_ADMIN_ORIGIN = "https://chakri.casino";

// These hosts have previously exposed the player bundle or operator console.
// Redirect only browser admin entries: the distributor and player surfaces on
// the same hosts remain available, and server-side proxy fetches never execute
// this runtime code.
const legacyAdminBrowserHosts = new Set([
  ...canonicalProductionHosts,
  "chakri-casino.onrender.com",
]);
const dedicatedLegacyAdminHosts = new Set(["crm.chakri.casino"]);

export function isCanonicalProductionHost(hostname) {
  return canonicalProductionHosts.has(String(hostname || "").trim().toLowerCase());
}

// The same production bundle is intentionally usable by the normal player
// site and by the isolated operator host. The operator host only renders the
// admin routes, while the existing player origin keeps its full app unchanged.
export const IS_ADMIN_CONSOLE =
  process.env.REACT_APP_ADMIN_CONSOLE === "true" || isAdminConsoleHost(runtimeHostname);

// Browser paths are deliberately case-sensitive and branded. Backend API paths
// remain lowercase `/admin/*`; changing those would break the existing service
// contract. All legacy browser entries are canonicalised in App.js.
export const ADMIN_ROOT_PATH = "/Admin";
/** Same-origin CRM front door on chakri.casino (crm.chakri.casino is retired). */
export const ADMIN_LOGIN_PATH = "/Admin";
export const ADMIN_LOGOUT_PATH = ADMIN_LOGIN_PATH;
/** Legacy login URL; App redirects it to ADMIN_LOGIN_PATH. */
export const ADMIN_LOGIN_LEGACY_PATH = "/Admin/login";
export const DISTRIBUTOR_ROOT_PATH = "/distributor";
export const DISTRIBUTOR_LOGIN_PATH = "/distributor/login";

/** Admin sign-in destination (always the /Admin front door). */
export function adminLoginPathForConsole(_isAdminConsole = IS_ADMIN_CONSOLE) {
  return ADMIN_LOGIN_PATH;
}

function hasPathPrefix(pathname, prefix) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function isDistributorBrowserPath(pathname) {
  return hasPathPrefix(pathname, DISTRIBUTOR_ROOT_PATH) || hasPathPrefix(pathname, "/partner");
}

/** Return the exact branded admin path for a supported browser entry. */
export function canonicalAdminPathForBrowserPath(pathname) {
  const path = String(pathname || "");
  // Collapse the retired login URL onto the /Admin front door before other
  // /Admin/* prefix handling, so bookmarks and host redirects stay consistent.
  if (path === ADMIN_LOGIN_LEGACY_PATH || path === `${ADMIN_LOGIN_LEGACY_PATH}/`) {
    return ADMIN_LOGIN_PATH;
  }
  if (hasPathPrefix(path, ADMIN_ROOT_PATH)) return path;
  if (path === "/admin/login" || path === "/admin/login/") return ADMIN_LOGIN_PATH;
  if (hasPathPrefix(path, "/admin")) {
    return `${ADMIN_ROOT_PATH}${path.slice("/admin".length)}`;
  }
  if (path === "/gk-admin-portal") return ADMIN_LOGIN_PATH;
  if (path.startsWith("/gk-admin-portal/")) {
    return `${ADMIN_ROOT_PATH}${path.slice("/gk-admin-portal".length)}`;
  }
  return null;
}

/**
 * Resolve a browser-only canonical redirect for an admin URL. Query and hash
 * are copied byte-for-byte from Location. Non-admin routes deliberately return
 * null so player and distributor access is unchanged.
 */
export function canonicalAdminUrlForLocation(locationLike) {
  const hostname = String(locationLike?.hostname || "").trim().toLowerCase();
  if (!legacyAdminBrowserHosts.has(hostname)) return null;

  const pathname = String(locationLike?.pathname || "");
  const requestedAdminPath = canonicalAdminPathForBrowserPath(pathname);
  // Retired crm.chakri.casino (and other legacy hosts): send bookmarks to the
  // live same-origin Admin front door on chakri.casino. Distributor routes stay
  // untouched. Path mapping prefers /Admin over the legacy /Admin/login URL.
  const canonicalPath = requestedAdminPath || (
    dedicatedLegacyAdminHosts.has(hostname) && !isDistributorBrowserPath(pathname)
      ? ADMIN_LOGIN_PATH
      : null
  );
  if (!canonicalPath) return null;

  const protocol = String(locationLike?.protocol || "").toLowerCase();
  const port = String(locationLike?.port || "");
  const isCanonicalLocation =
    hostname === CANONICAL_ADMIN_HOSTNAME &&
    protocol === "https:" &&
    (!port || port === "443") &&
    pathname === canonicalPath;
  if (isCanonicalLocation) return null;

  return `${CANONICAL_ADMIN_ORIGIN}${canonicalPath}${String(locationLike?.search || "")}${String(locationLike?.hash || "")}`;
}

/** Start a history-replacing browser navigation before React renders. */
export function enforceCanonicalAdminBrowserLocation(locationLike) {
  const destination = canonicalAdminUrlForLocation(locationLike);
  if (!destination) return false;
  locationLike.replace(destination);
  return true;
}

export function loginPathForBrowserPath(pathname, isAdminConsole = IS_ADMIN_CONSOLE) {
  const path = String(pathname || "");
  if (canonicalAdminPathForBrowserPath(path)) return ADMIN_LOGIN_PATH;
  if (isDistributorBrowserPath(path)) return DISTRIBUTOR_LOGIN_PATH;
  // IS_ADMIN_CONSOLE builds (retired dedicated host / staging flag) still land
  // on the Admin front door rather than the player auth panel.
  return isAdminConsole ? ADMIN_LOGIN_PATH : "/?auth=login";
}

// A newly opened console has no remembered failover host. Route it to the
// verified branded API instead of relying on a historical Render hostname.
export function apiOriginForRuntime(
  defaultBackendUrl,
  _isAdminConsole = IS_ADMIN_CONSOLE,
  hostname = runtimeHostname,
) {
  return isCanonicalProductionHost(hostname)
    ? "https://api.chakri.casino"
    : defaultBackendUrl;
}

// A staging/preview build is also compiled with NODE_ENV=production. Runtime
// hostname—not build mode—is therefore the only safe way to decide whether a
// financial request may use the canonical production API.
export function financialApiOriginForRuntime(defaultBackendUrl, hostname = runtimeHostname) {
  return isCanonicalProductionHost(hostname)
    ? "https://api.chakri.casino"
    : defaultBackendUrl;
}

export function apiAlternatesForRuntime(
  primaryBackendUrl,
  configuredBackendUrl,
  hostname = runtimeHostname,
) {
  if (isCanonicalProductionHost(hostname)) {
    // A player session must never migrate between ledgers. Historical Render
    // service names can be healthy while carrying different data or code, so
    // canonical production hosts have exactly one allowed API origin.
    return ["https://api.chakri.casino"];
  }
  return [...new Set([primaryBackendUrl, configuredBackendUrl].filter(Boolean))];
}
