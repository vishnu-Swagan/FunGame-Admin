export const LOGIN_SURFACES = Object.freeze({
  PLAYER: "PLAYER",
  ADMIN: "ADMIN",
  DISTRIBUTOR: "DISTRIBUTOR",
});

const KNOWN_SURFACES = new Set(Object.values(LOGIN_SURFACES));

/**
 * Every login entry point identifies its intended workspace. The server checks
 * this after password verification and before writing a session, preventing a
 * correct operator password entered on the player page from replacing an
 * existing operator session.
 */
export function loginRequestPayload(identifier, password, surface) {
  const loginSurface = String(surface || "").toUpperCase();
  if (!KNOWN_SURFACES.has(loginSurface)) {
    throw new Error("Unknown login surface");
  }
  return {
    identifier,
    // Retained while older API deployments still read the legacy field.
    email: identifier,
    password,
    login_surface: loginSurface,
  };
}
