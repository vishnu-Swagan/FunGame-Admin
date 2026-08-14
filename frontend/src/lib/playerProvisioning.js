// Both forms exist in the recovered client protocol. The admin console accepts
// either so a real client-issued GK ID does not fail before it reaches the
// server, while the server remains the final authority.
export const PLAYER_LOGIN_ID_PATTERN = /^GK[0-9]{7,8}$/;

export function normalizePlayerLoginId(value) {
  return String(value || "").trim().toUpperCase();
}

/**
 * Validate the values entered in the MyDGP operator console before they are
 * sent to the server. The API repeats every check; this merely prevents an
 * operator from discovering a typo after an account has already been made.
 */
export function validatePlayerProvisioning({
  loginId,
  fullName,
  password,
  passwordConfirmation,
  startingPoints,
}) {
  const normalizedLoginId = normalizePlayerLoginId(loginId);
  if (!PLAYER_LOGIN_ID_PATTERN.test(normalizedLoginId)) {
    return "Login ID must be GK followed by seven or eight digits.";
  }

  const normalizedName = String(fullName || "").trim();
  if (normalizedName.length < 1 || normalizedName.length > 120) {
    return "Player name must be between 1 and 120 characters.";
  }

  const enteredPassword = String(password || "");
  if (enteredPassword !== enteredPassword.trim()) {
    return "Temporary password cannot start or end with a space.";
  }
  if (enteredPassword.length < 7 || enteredPassword.length > 128) {
    return "Temporary password must be between 7 and 128 characters.";
  }
  if (enteredPassword !== String(passwordConfirmation || "")) {
    return "The temporary passwords do not match.";
  }

  const rawPoints = String(startingPoints ?? "").trim();
  if (rawPoints && (!/^[0-9]+$/.test(rawPoints) || Number(rawPoints) > 1_000_000)) {
    return "Initial virtual points must be a whole number from 0 to 1,000,000.";
  }

  return null;
}

/**
 * The temporary password is intentionally only present in this in-memory
 * request payload. Callers must clear their form state after the request and
 * must never put it in localStorage, a URL, analytics, or a toast message.
 */
export function buildPlayerCreatePayload(values) {
  const payload = {
    login_id: normalizePlayerLoginId(values.loginId),
    full_name: String(values.fullName || "").trim(),
    password: String(values.password || ""),
  };
  const rawPoints = String(values.startingPoints ?? "").trim();
  if (rawPoints) payload.starting_points = Number(rawPoints);
  return payload;
}
