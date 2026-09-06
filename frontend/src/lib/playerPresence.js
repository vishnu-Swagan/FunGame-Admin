import { api } from "@/lib/api";

// Presence means an authenticated tab was visible recently, not just that an
// account is approved. Hidden/closed tabs naturally age out on the server.
export function startPlayerPresence() {
  let stopped = false;
  let inFlight = false;
  const heartbeat = async () => {
    if (stopped || inFlight || document.visibilityState === "hidden") return;
    inFlight = true;
    try {
      await api.post("/auth/heartbeat", {}, { timeout: 10000, __noFailover: true });
    } catch (_error) {
      // Presence must not interrupt gameplay. Authentication failures continue
      // through the shared API session-expiry handler.
    } finally {
      inFlight = false;
    }
  };
  heartbeat();
  const timer = window.setInterval(heartbeat, 30000);
  document.addEventListener("visibilitychange", heartbeat);
  return () => {
    stopped = true;
    window.clearInterval(timer);
    document.removeEventListener("visibilitychange", heartbeat);
  };
}
