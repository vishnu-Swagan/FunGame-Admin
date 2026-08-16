const configuredConsoleHosts = (process.env.REACT_APP_ADMIN_CONSOLE_HOSTS || "mydgp.casino,www.mydgp.casino")
  .split(",")
  .map((host) => host.trim().toLowerCase())
  .filter(Boolean);

export function isAdminConsoleHost(hostname) {
  return configuredConsoleHosts.includes(String(hostname || "").trim().toLowerCase());
}

const runtimeHostname = typeof window === "undefined" ? "" : window.location.hostname;

// The dedicated operator console is a separate Supabase control plane. This is
// intentionally the complete Edge Function path (rather than just an origin):
// admin requests must never pick up the player API's `/api` suffix or Render
// fallback hosts.
export const SUPABASE_ADMIN_API_ORIGIN =
  "https://otlhseyofakjiridxthb.supabase.co/functions/v1/admin-api";

// The same production bundle is intentionally usable by the normal player
// site and by the isolated operator host. The operator host only renders the
// admin routes, while the existing player origin keeps its full app unchanged.
export const IS_ADMIN_CONSOLE =
  process.env.REACT_APP_ADMIN_CONSOLE === "true" || isAdminConsoleHost(runtimeHostname);

export const ADMIN_LOGIN_PATH = IS_ADMIN_CONSOLE ? "/admin/login" : "/gk-admin-portal";
export const ADMIN_LOGOUT_PATH = IS_ADMIN_CONSOLE ? ADMIN_LOGIN_PATH : "/welcome";

// The operator console lives beside a legacy player application during the
// cutover. Never let a player-site bearer token be picked up by the console,
// or let an operator token leak back to the legacy origin/build.
export const AUTH_TOKEN_STORAGE_KEY = IS_ADMIN_CONSOLE ? "mydgp_admin_token" : "fg_token";
export const LOGOUT_REASON_STORAGE_KEY = IS_ADMIN_CONSOLE ? "mydgp_admin_logout_reason" : "fg_logout_reason";

// The player app retains its configured backend. The isolated administrator
// console has exactly one backend: its Supabase Edge Function.
export function apiOriginForRuntime(defaultBackendUrl, isAdminConsole = IS_ADMIN_CONSOLE) {
  return isAdminConsole ? SUPABASE_ADMIN_API_ORIGIN : defaultBackendUrl;
}
