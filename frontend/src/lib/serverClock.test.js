import {
  bettingControlsOpen,
  CLIENT_BETTING_GUARD_SECONDS,
  secondsUntil,
  serverSyncedDeadline,
} from "./serverClock";

test("server deadline compensates with the request midpoint", () => {
  expect(serverSyncedDeadline({
    serverNowSeconds: 100,
    secondsLeft: 5,
    requestStartedAtMs: 1000,
    receivedAtMs: 1400,
  })).toBe(6200);
});

test("absolute server deadline uses the midpoint fallback without an initial server sample", () => {
  expect(serverSyncedDeadline({
    serverNowSeconds: 102,
    serverDeadlineSeconds: 105,
    secondsLeft: 5,
    requestStartedAtMs: 1000,
    receivedAtMs: 1400,
  })).toBe(4200);
});

test("two server timestamps remove handler time using NTP offset", () => {
  expect(serverSyncedDeadline({
    serverSampledAtSeconds: 10.1,
    serverNowSeconds: 10.5,
    serverDeadlineSeconds: 15.1,
    secondsLeft: 5,
    requestStartedAtMs: 1000,
    receivedAtMs: 1600,
  })).toBeCloseTo(6100, 6);
});

test("server deadline falls back to receipt time without a valid server clock", () => {
  expect(serverSyncedDeadline({
    serverNowSeconds: undefined,
    secondsLeft: 5,
    requestStartedAtMs: 1000,
    receivedAtMs: 1400,
  })).toBe(6400);
  expect(serverSyncedDeadline({
    serverNowSeconds: null,
    serverDeadlineSeconds: null,
    secondsLeft: 5,
    requestStartedAtMs: 1000,
    receivedAtMs: 1400,
  })).toBe(6400);
  expect(secondsUntil(6400, 2400)).toBe(4);
});

test("client closes before the backend mutation guard", () => {
  expect(CLIENT_BETTING_GUARD_SECONDS).toBeGreaterThan(0.4);
  expect(bettingControlsOpen("BETTING", 0.501)).toBe(true);
  expect(bettingControlsOpen("BETTING", 0.5)).toBe(false);
  expect(bettingControlsOpen("BETTING", 0.401)).toBe(false);
  expect(bettingControlsOpen("REVEAL", 12)).toBe(false);
});
