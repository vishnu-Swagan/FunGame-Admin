import { act } from "react";
import { createRoot } from "react-dom/client";
import { api } from "@/lib/api";
import AdminPlayerLoginStats from "./AdminPlayerLoginStats";

jest.mock("@/lib/api", () => ({ api: { get: jest.fn() }, errMsg: (error) => error.message }));
const stats = {
  generated_at: "2026-09-06T09:00:00Z", online_window_seconds: 90, list_limit: 100,
  total_players: 5, online_now: 1, players_logged_in_24h: 3,
  online_players: [{ id: "p1", display_name: "Live Player", username: "GK1234567", online: true }],
  recent_logins: [{ id: "p2", display_name: "Previous Player", online: false, last_login_at: "2026-09-06T08:00:00Z" }],
};
let root;
let container;
beforeAll(() => { global.IS_REACT_ACT_ENVIRONMENT = true; });
beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  api.get.mockResolvedValue({ data: stats });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  jest.useRealTimers();
});
const render = async () => act(async () => { root.render(<AdminPlayerLoginStats />); });

test("shows live players and recent logins with accurate definitions", async () => {
  await render();
  expect(api.get).toHaveBeenCalledWith("/admin/player-login-stats", { timeout: 10000, __noFailover: true });
  expect(container.textContent).toContain("Live Player");
  expect(container.textContent).toContain("last 90 seconds");
  await act(async () => {
    [...container.querySelectorAll("button")].find((button) => button.textContent === "Recent logins").click();
  });
  expect(container.textContent).toContain("Previous Player");
  expect(container.textContent).toContain("Offline");
  expect(container.textContent).toContain("unique players, not login attempts");
});

test("refreshes every 10 seconds and stops when closed", async () => {
  await render();
  await act(async () => { jest.advanceTimersByTime(10000); });
  expect(api.get).toHaveBeenCalledTimes(2);
  Object.defineProperty(document, "visibilityState", { value: "hidden" });
  await act(async () => { jest.advanceTimersByTime(10000); });
  expect(api.get).toHaveBeenCalledTimes(2);
  await act(async () => root.unmount());
  await act(async () => { jest.advanceTimersByTime(10000); });
  expect(api.get).toHaveBeenCalledTimes(2);
});

test("keeps last successful values and labels stale data after a failed refresh", async () => {
  await render();
  api.get.mockRejectedValue(new Error("Network unavailable"));
  await act(async () => { jest.advanceTimersByTime(10000); });
  expect(container.querySelector('[role="alert"]').textContent).toContain("Showing the last successful update");
  expect(container.textContent).toContain("Live Player");
});

test("renders empty state without inventing players", async () => {
  api.get.mockResolvedValue({ data: { ...stats, online_now: 0, online_players: [] } });
  await render();
  expect(container.textContent).toContain("No players online right now.");
});
