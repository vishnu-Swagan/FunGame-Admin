import axios from "axios";
import {
  ADMIN_LOGIN_PATH,
  IS_ADMIN_CONSOLE,
  apiAlternatesForRuntime,
  apiOriginForRuntime,
  financialApiOriginForRuntime,
} from "@/lib/adminConsole";

export const APP_VERSION = "1.0.0";

/* The backend URL is baked in at build time, which makes renaming the API host a
   coordinated change: the moment its .onrender.com name changes, every already-
   built client is pointing at a host that no longer answers, and it stays broken
   until the frontend is rebuilt and redeployed.

   So the client carries the alternates too. On the first failure it tries the
   others once, keeps whichever answers, and remembers it. That turns the rename
   from a synchronised cutover into two independent deploys in either order. */
const BACKEND_URL = process.env.REACT_APP_BACKEND_URL;
const PRIMARY_BACKEND_URL = apiOriginForRuntime(BACKEND_URL);
const FINANCIAL_BACKEND_URL = financialApiOriginForRuntime(PRIMARY_BACKEND_URL);
const ALTERNATES = apiAlternatesForRuntime(PRIMARY_BACKEND_URL, BACKEND_URL);

const REMEMBERED = "cc_api_base";
const stored = typeof localStorage !== "undefined" ? localStorage.getItem(REMEMBERED) : null;
const initial = ALTERNATES.includes(stored) ? stored : ALTERNATES[0];

export const API_BASE = `${initial}/api`;
export const FINANCIAL_API_BASE = `${FINANCIAL_BACKEND_URL}/api`;

export const api = axios.create({ baseURL: API_BASE });
// Money and CRM state must never follow the general app's legacy-host failover.
// A stale backend can be healthy while carrying a different ledger/schema, so
// every payment read and mutation stays on one canonical origin for the whole
// request lifecycle. Development remains pinned to its configured local API.
export const financialApi = axios.create({ baseURL: FINANCIAL_API_BASE });

const SAFE_REPLAY_METHODS = new Set(["get", "head", "options"]);

function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name);
  const key = Object.keys(headers).find((item) => item.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : null;
}

/** A lost response must never turn one financial mutation into two. */
export function canReplayRequest(config) {
  if (config?.__noFailover) return false;
  const method = String(config?.method || "get").toLowerCase();
  return SAFE_REPLAY_METHODS.has(method) || Boolean(headerValue(config?.headers, "Idempotency-Key"));
}

export function createIdempotencyKey(prefix = "web") {
  const id = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${id}`;
}

export function financialPost(path, body, options = {}) {
  const { idempotencyKey = createIdempotencyKey("payment"), headers = {}, ...axiosOptions } = options;
  return financialApi.post(path, body, {
    ...axiosOptions,
    __noFailover: true,
    headers: { ...headers, "Idempotency-Key": idempotencyKey },
  });
}

export function financialPatch(path, body, options = {}) {
  const { idempotencyKey = createIdempotencyKey("payment"), headers = {}, ...axiosOptions } = options;
  return financialApi.patch(path, body, {
    ...axiosOptions,
    __noFailover: true,
    headers: { ...headers, "Idempotency-Key": idempotencyKey },
  });
}

/** Try the other hosts once, in order, and keep the first that answers. */
let failoverInFlight = null;
function failover() {
  if (failoverInFlight) return failoverInFlight;
  const current = api.defaults.baseURL.replace(/\/api$/, "");
  const others = ALTERNATES.filter((h) => h !== current);
  failoverInFlight = (async () => {
    for (const host of others) {
      try {
        const res = await fetch(`${host}/api/health`, { method: "GET", mode: "cors" });
        if (!res.ok) continue;
        api.defaults.baseURL = `${host}/api`;
        try { localStorage.setItem(REMEMBERED, host); } catch (e) { /* private mode */ }
        return host;
      } catch (e) { /* try the next one */ }
    }
    return null;
  })().finally(() => { failoverInFlight = null; });
  return failoverInFlight;
}

const PUBLIC_PATHS = ["/", "/welcome", "/login", "/register", "/verify", "/verify-email", "/forgot-password", "/maintenance", "/offline", "/update-required", ADMIN_LOGIN_PATH];

function attachAccessToken(config) {
  const token = localStorage.getItem("fg_token");
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
}

api.interceptors.request.use(attachAccessToken);
financialApi.interceptors.request.use(attachAccessToken);

async function handleApiError(error, allowFailover) {
    /* No response at all means the host did not answer — DNS gone, connection
       refused, CORS rejected. That is exactly what a renamed service looks like,
       so try the alternates once and replay the request. A response with a status
       means the backend is there and simply said no; that is not a failover. */
    const cfg = error?.config;
    if (allowFailover && !error?.response && cfg && !cfg.__triedFailover && canReplayRequest(cfg)) {
      cfg.__triedFailover = true;
      const host = await failover();
      if (host) {
        cfg.baseURL = `${host}/api`;
        return api.request(cfg);
      }
    }
    const status = error?.response?.status;
    const detail = error?.response?.data?.detail;
    const path = window.location.pathname;
    if (status === 401 && !PUBLIC_PATHS.includes(path)) {
      if (detail && detail.code === "SESSION_REPLACED") {
        localStorage.setItem("fg_logout_reason", detail.message || "You were signed out because this Login ID was used on another device.");
      }
      localStorage.removeItem("fg_token");
      window.location.assign(IS_ADMIN_CONSOLE ? ADMIN_LOGIN_PATH : "/login");
      return Promise.reject(error);
    }
    /* A refusal that closes the whole app to this player gets its own screen.
       Without it an excluded player taps around getting the same red toast on
       every page with nothing to do about it. Per-bet refusals (LOSS_LIMIT,
       DEPOSIT_LIMIT) are deliberately NOT here — those belong inline, next to
       the bet that was refused. */
    const CLOSED_CODES = ["SELF_EXCLUDED", "MARKET_BLOCKED", "AGE_NOT_VERIFIED", "UNDERAGE"];
    if (status === 403 && detail && CLOSED_CODES.includes(detail.code)) {
      try { localStorage.setItem("cc_block", JSON.stringify(detail)); } catch (e) { /* private mode */ }
      if (!path.startsWith("/account-closed") && !path.startsWith("/responsible-play") && !path.startsWith("/support")) {
        window.location.assign("/account-closed");
      }
    }
    if (status === 503 && detail && detail.code === "MAINTENANCE") {
      if (!path.startsWith("/maintenance") && !path.startsWith("/admin")) {
        window.location.assign("/maintenance");
      }
    }
    return Promise.reject(error);
}

api.interceptors.response.use(
  (res) => res,
  (error) => handleApiError(error, true)
);

financialApi.interceptors.response.use(
  (res) => res,
  (error) => handleApiError(error, false)
);

export function errMsg(error, fallback = "Something went wrong. Please try again.") {
  const d = error?.response?.data?.detail;
  if (!d) return error?.message || fallback;
  if (typeof d === "string") return d;
  if (d.message) return d.message;
  if (Array.isArray(d) && d[0]?.msg) return d[0].msg;
  return fallback;
}

export function errCode(error) {
  const payload = error?.response?.data;
  const detail = payload?.detail;
  if (detail && typeof detail === "object" && !Array.isArray(detail)) return detail.code || null;
  return payload?.code || null;
}

// Returns -1 if a < b, 0 if equal, 1 if a > b (semver-ish)
export function compareVersions(a, b) {
  const pa = String(a || "0").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b || "0").split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

/* Fetch a CSV through the authenticated client and hand it to the browser.
   A plain <a download> would be an unauthenticated request and come back 401 —
   the token lives in the axios interceptor, not in the cookie jar. */
export async function downloadCsv(path, fallbackName) {
  const res = await api.get(path, { responseType: "blob" });
  const disposition = res.headers["content-disposition"] || "";
  const named = disposition.match(/filename="?([^";]+)"?/);
  const url = URL.createObjectURL(res.data);
  const link = document.createElement("a");
  link.href = url;
  link.download = named ? named[1] : fallbackName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoking immediately cancels the download in Safari, which reads the blob
  // after the click returns.
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function routeForUser(user) {
  if (!user) return "/welcome";
  if (user.role === "ADMIN") return "/admin";
  // A partner has no onboarding and no wallet — the account is provisioned
  // complete, so the status ladder below does not apply to them.
  if (user.role === "DISTRIBUTOR") return "/partner";
  switch (user.status) {
    case "VERIFIED":
      return "/onboarding/profile";
    case "PROFILE_SUBMITTED":
      return "/onboarding/review";
    case "PENDING":
    case "REJECTED":
    case "SUSPENDED":
      return "/onboarding/pending";
    case "ACTIVE":
      return "/home";
    default:
      return "/welcome";
  }
}
