import { api } from "@/lib/api";
import { startPlayerPresence } from "./playerPresence";

jest.mock("@/lib/api", () => ({ api: { post: jest.fn() } }));

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  api.post.mockResolvedValue({ data: {} });
});
afterEach(() => jest.useRealTimers());

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

test("sends current-session heartbeats, pauses hidden tabs and stops on cleanup", async () => {
  const stop = startPlayerPresence();
  expect(api.post).toHaveBeenCalledWith("/auth/heartbeat", {}, { timeout: 10000, __noFailover: true });
  await settle();
  jest.advanceTimersByTime(30000);
  expect(api.post).toHaveBeenCalledTimes(2);
  await settle();
  Object.defineProperty(document, "visibilityState", { value: "hidden" });
  jest.advanceTimersByTime(60000);
  expect(api.post).toHaveBeenCalledTimes(2);
  Object.defineProperty(document, "visibilityState", { value: "visible" });
  document.dispatchEvent(new Event("visibilitychange"));
  expect(api.post).toHaveBeenCalledTimes(3);
  stop();
  await settle();
  jest.advanceTimersByTime(60000);
  document.dispatchEvent(new Event("visibilitychange"));
  expect(api.post).toHaveBeenCalledTimes(3);
});

test("slow requests do not overlap and delivery errors are safe", async () => {
  let reject;
  api.post.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  const stop = startPlayerPresence();
  jest.advanceTimersByTime(60000);
  expect(api.post).toHaveBeenCalledTimes(1);
  reject(new Error("offline"));
  await settle();
  jest.advanceTimersByTime(30000);
  expect(api.post).toHaveBeenCalledTimes(2);
  stop();
});
