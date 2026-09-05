/** Front-door auth panel helpers for the single `/` experience. */

export const AUTH_PANELS = Object.freeze({
  HERO: "hero",
  LOGIN: "login",
  REGISTER: "register",
  FORGOT: "forgot",
});

const PANEL_ALIASES = Object.freeze({
  login: AUTH_PANELS.LOGIN,
  signin: AUTH_PANELS.LOGIN,
  "sign-in": AUTH_PANELS.LOGIN,
  register: AUTH_PANELS.REGISTER,
  signup: AUTH_PANELS.REGISTER,
  "sign-up": AUTH_PANELS.REGISTER,
  forgot: AUTH_PANELS.FORGOT,
  "forgot-password": AUTH_PANELS.FORGOT,
  reset: AUTH_PANELS.FORGOT,
});

/** Map a `?auth=` query value (or legacy path) onto a frontpage panel. */
export function authPanelFromQuery(value) {
  const key = String(value || "").trim().toLowerCase();
  if (!key) return AUTH_PANELS.HERO;
  return PANEL_ALIASES[key] || AUTH_PANELS.HERO;
}

/** Build a same-path search string that opens an auth panel on `/`. */
export function authSearchForPanel(panel, registrationSubmitted = false) {
  const normalized = authPanelFromQuery(panel);
  if (normalized === AUTH_PANELS.HERO) return registrationSubmitted ? "?registered=1" : "";
  const params = new URLSearchParams();
  params.set("auth", normalized);
  if (registrationSubmitted) params.set("registered", "1");
  return `?${params.toString()}`;
}

export function frontPathForAuthPanel(panel, registrationSubmitted = false) {
  return `/${authSearchForPanel(panel, registrationSubmitted)}`;
}

/** Unified player auth page used when a guest hits a play entry point. */
export function guestPlayAuthPath() {
  return frontPathForAuthPanel(AUTH_PANELS.LOGIN);
}
