import { canReplayRequest, errCode, financialApi, FINANCIAL_API_BASE } from "./api";

test("network failover replays reads but not unkeyed money mutations", () => {
  expect(canReplayRequest({ method: "get" })).toBe(true);
  expect(canReplayRequest({ method: "post", headers: {} })).toBe(false);
  expect(canReplayRequest({ method: "post", headers: { "Idempotency-Key": "stable-key" } })).toBe(true);
  expect(canReplayRequest({ method: "patch", headers: { "idempotency-key": "stable-key" } })).toBe(true);
  expect(canReplayRequest({ method: "post", __noFailover: true, headers: { "Idempotency-Key": "stable-key" } })).toBe(false);
});

test("extracts structured API error codes", () => {
  expect(errCode({ response: { data: { detail: { code: "GAME_COMING_SOON" } } } })).toBe("GAME_COMING_SOON");
  expect(errCode({ response: { data: { code: "FAILED" } } })).toBe("FAILED");
  expect(errCode(new Error("network"))).toBeNull();
});

test("financial traffic is pinned to one API origin", () => {
  expect(financialApi.defaults.baseURL).toBe(FINANCIAL_API_BASE);
  expect(FINANCIAL_API_BASE).not.toContain("fungame-api.onrender.com");
});
