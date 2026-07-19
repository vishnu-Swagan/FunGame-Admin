import axios from "axios";

export const APP_VERSION = "1.0.0";

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL;
export const API_BASE = `${BACKEND_URL}/api`;

export const api = axios.create({ baseURL: API_BASE });

const PUBLIC_PATHS = ["/", "/welcome", "/login", "/register", "/verify-email", "/forgot-password", "/maintenance", "/offline", "/update-required"];

api.interceptors.request.use((config) => {
  const token = localStorage.getItem("fg_token");
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (res) => res,
  (error) => {
    const status = error?.response?.status;
    const detail = error?.response?.data?.detail;
    const path = window.location.pathname;
    if (status === 401 && !PUBLIC_PATHS.includes(path)) {
      localStorage.removeItem("fg_token");
      window.location.assign("/login");
      return Promise.reject(error);
    }
    if (status === 503 && detail && detail.code === "MAINTENANCE") {
      if (!path.startsWith("/maintenance") && !path.startsWith("/admin")) {
        window.location.assign("/maintenance");
      }
    }
    return Promise.reject(error);
  }
);

export function errMsg(error, fallback = "Something went wrong. Please try again.") {
  const d = error?.response?.data?.detail;
  if (!d) return error?.message || fallback;
  if (typeof d === "string") return d;
  if (d.message) return d.message;
  if (Array.isArray(d) && d[0]?.msg) return d[0].msg;
  return fallback;
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

export function routeForUser(user) {
  if (!user) return "/welcome";
  if (user.role === "ADMIN") return "/admin";
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
