import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/context/AuthContext";
import { BrandWordmark } from "@/components/Brand";

/**
 * The reference Aviator is deliberately built as an isolated React 18 app.
 * Its original global SCSS and Unity loader can therefore run unchanged next
 * to the React 19 website without leaking styles into the casino catalogue.
 * Authentication and balance still come from the same origin/session.
 */
export default function AviatorGame() {
  const navigate = useNavigate();
  const { setUser } = useAuth();

  useEffect(() => {
    const receive = (event) => {
      if (event.origin !== window.location.origin || event.data?.source !== "chakri-aviator") return;
      if (event.data.type === "exit") {
        navigate("/games/aviator");
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

  return (
    <div className="fixed inset-0 z-[100] bg-[#08090b]">
      <BrandWordmark className="standalone-game-brand" logoClassName="standalone-game-brand-logo" />
      {/* Version the document URL so browsers that cached Render's former
          X-Frame-Options: DENY response do not keep showing a blocked frame. */}
      <iframe
        data-testid="aviator-reference-game"
        title="Aviator live game"
        src="/aviator-live/index.html?v=20260818-frame-policy"
        allow="autoplay; fullscreen"
        style={{
          position: "fixed",
          left: "calc(var(--fg-viewport-left, 0px) + var(--fg-safe-left, 0px))",
          top: "calc(var(--fg-viewport-top, 0px) + var(--fg-safe-top, 0px))",
          width: "var(--fg-usable-w, 100vw)",
          height: "var(--fg-usable-h, 100dvh)",
          border: 0,
          background: "#08090b",
          boxShadow: "0 0 0 100vmax #08090b",
          zIndex: 100,
        }}
      />
    </div>
  );
}
