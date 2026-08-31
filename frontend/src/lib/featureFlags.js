function enabled(value) {
  return String(value || "").trim().toLowerCase() === "true";
}

// Build-time and fail-closed: an absent or malformed value must not expose the
// retired manual chip request/approval workflow in either frontend shell.
export const LEGACY_CHIP_REQUESTS_ENABLED = enabled(
  process.env.REACT_APP_LEGACY_CHIP_REQUESTS_ENABLED,
);
