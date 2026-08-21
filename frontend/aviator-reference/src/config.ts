const configuredApiUrl = (
  process.env.REACT_APP_BACKEND_URL || process.env.REACT_APP_API_URL || ""
).replace(/\/$/, "");
const rememberedApiUrl = window.localStorage.getItem("cc_api_base") || "";
const canonicalProductionHosts = new Set([
  "chakri.casino",
  "www.chakri.casino",
  "play.chakri.casino",
  "crm.chakri.casino",
  "mydgp.casino",
  "www.mydgp.casino",
  "fungame-web.onrender.com",
]);

export const apiOriginsForRuntime = (configuredUrl: string, hostname: string) => {
  const isCanonicalProduction = canonicalProductionHosts.has(
    String(hostname || "").trim().toLowerCase(),
  );
  // Never let a live Aviator session cross between API hosts/ledgers. Preview,
  // staging, and local builds remain pinned to their explicitly configured API.
  return isCanonicalProduction
    ? ["https://api.chakri.casino"]
    : Array.from(new Set([configuredUrl].filter(Boolean)));
};

const knownApiUrls = apiOriginsForRuntime(configuredApiUrl, window.location.hostname);

// The game is a same-site micro-app, but the API is deployed separately. Only
// accept a remembered host that is safe for this runtime hostname. Preview,
// staging, and local builds must never fall back to a production ledger.
export const apiBaseUrl = knownApiUrls.includes(rememberedApiUrl)
  ? rememberedApiUrl
  : knownApiUrls[0] || window.location.origin;

export const config = {
  development: false,
  debug: true,
  appKey: "crash-0.1.0",
  api: `${apiBaseUrl}/api`,
  wss: apiBaseUrl,
};

export const gameAssetUrl = (path: string) =>
  `${process.env.PUBLIC_URL || ""}/${path.replace(/^\//, "")}`;

export const authHeaders = () => {
  const token = window.localStorage.getItem("fg_token");
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
};
