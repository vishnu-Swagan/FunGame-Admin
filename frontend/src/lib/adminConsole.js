const configuredConsoleHosts = (process.env.REACT_APP_ADMIN_CONSOLE_HOSTS || "mydgp.casino,www.mydgp.casino")
  .split(",")
  .map((host) => host.trim().toLowerCase())
  .filter(Boolean);

export function isAdminConsoleHost(hostname) {
  return configuredConsoleHosts.includes(String(hostname || "").trim().toLowerCase());
}

const runtimeHostname = typeof window === "undefined" ? "" : window.location.hostname;

// The same production bundle is intentionally usable by the normal player
// site and by the isolated operator host. The operator host only renders the
// admin routes, while the existing player origin keeps its full app unchanged.
export const IS_ADMIN_CONSOLE =
  process.env.REACT_APP_ADMIN_CONSOLE === "true" || isAdminConsoleHost(runtimeHostname);

export const ADMIN_LOGIN_PATH = IS_ADMIN_CONSOLE ? "/admin/login" : "/gk-admin-portal";
export const ADMIN_LOGOUT_PATH = IS_ADMIN_CONSOLE ? ADMIN_LOGIN_PATH : "/welcome";

// A newly opened console has no remembered failover host. Route it to the
// verified branded API instead of relying on a historical Render hostname.
export function apiOriginForRuntime(defaultBackendUrl, isAdminConsole = IS_ADMIN_CONSOLE) {
  return isAdminConsole ? "https://api.chakri.casino" : defaultBackendUrl;
}
