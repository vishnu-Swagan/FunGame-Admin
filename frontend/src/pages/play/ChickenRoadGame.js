import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/context/AuthContext";
import { API_BASE } from "@/lib/api";

/**
 * The live Chicken Road surface is an isolated same-origin Canvas 2D micro-app
 * (public/chicken-road-live), embedded exactly like the Aviator cabinet so its
 * dense game-specific renderer and Web Audio engine stay out of the React
 * bundle. Authentication (the fg_token in localStorage) and the chip balance
 * still come from the same session; the API origin is handed to the frame so it
 * always talks to the same backend the lounge does.
 */
export default function ChickenRoadGame() {
  const navigate = useNavigate();
  const { setUser } = useAuth();

  useEffect(() => {
    const receive = (event) => {
      if (event.origin !== window.location.origin || event.data?.source !== "chakri-chicken-road") return;
      if (event.data.type === "exit") {
        navigate("/games/chicken-road");
        return;
      }
      if (event.data.type === "balance" && Number.isFinite(Number(event.data.balance))) {
        const balance = Number(event.data.balance);
        setUser((current) => {
          if (!current || Number(current.chip_balance) === balance) return current;
          return { ...current, chip_balance: balance };
        });
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [navigate, setUser]);

  const apiOrigin = String(API_BASE || "").replace(/\/api\/?$/, "");
  const src = `/chicken-road-live/index.html?v=20260902&api=${encodeURIComponent(apiOrigin)}`;

  return (
    <div className="fixed inset-0 z-[100] bg-[#0a0705]">
      <iframe
        data-testid="chicken-road-live-game"
        title="Chicken Road live game"
        src={src}
        allow="autoplay; fullscreen"
        style={{
          position: "fixed",
          left: "calc(var(--fg-viewport-left, 0px) + var(--fg-safe-left, 0px))",
          top: "calc(var(--fg-viewport-top, 0px) + var(--fg-safe-top, 0px))",
          width: "var(--fg-usable-w, 100vw)",
          height: "var(--fg-usable-h, 100dvh)",
          border: 0,
          background: "#0a0705",
          boxShadow: "0 0 0 100vmax #0a0705",
          zIndex: 100,
        }}
      />
    </div>
  );
}