const configuredApiUrl = (
  process.env.REACT_APP_BACKEND_URL || process.env.REACT_APP_API_URL || ""
).replace(/\/$/, "");
const rememberedApiUrl = window.localStorage.getItem("cc_api_base") || "";
const canonicalProductionHosts = new Set([
  "chakri.casino",
  "www.chakri.casino",
  "play.chakri.casino",
  "crm.chakri.casino",
  "fungame-web.onrender.com",
]);

export const apiOriginsForRuntime = (configuredUrl: string, hostname: string) => Array.from(
  new Set([
    configuredUrl,
    ...(canonicalProductionHosts.has(String(hostname || "").trim().toLowerCase())
      ? [
          "https://api.chakri.casino",
          "https://chakri-casino-api.onrender.com",
          "https://fungame-api.onrender.com",
        ]
      : []),
  ].filter(Boolean)),
);

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
