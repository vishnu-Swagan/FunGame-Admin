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

export function isCanonicalProductionHost(hostname) {
  return canonicalProductionHosts.has(String(hostname || "").trim().toLowerCase());
}

// The same production bundle is intentionally usable by the normal player
// site and by the isolated operator host. The operator host only renders the
// admin routes, while the existing player origin keeps its full app unchanged.
export const IS_ADMIN_CONSOLE =
  process.env.REACT_APP_ADMIN_CONSOLE === "true" || isAdminConsoleHost(runtimeHostname);

export const ADMIN_LOGIN_PATH = IS_ADMIN_CONSOLE ? "/admin/login" : "/gk-admin-portal";
export const ADMIN_LOGOUT_PATH = IS_ADMIN_CONSOLE ? ADMIN_LOGIN_PATH : "/welcome";

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
