import { Navigate } from "react-router-dom";
import { useAuth } from "@/context/AuthContext";
import { routeForUser } from "@/lib/api";
import { guestPlayAuthPath } from "@/lib/frontDoor";
import { LoadingScreen } from "@/components/common";

/**
 * `/casino` is a play-entry bookmark (hero "Play now" / "All games" on some
 * builds). Guests open the unified auth page. ACTIVE players land on the lobby
 * games picker. Other signed-in roles keep their existing home route.
 */
export default function CasinoEntry() {
  const { user, loading } = useAuth();
  if (loading) return <LoadingScreen />;
  if (user?.role === "PLAYER" && user.status === "ACTIVE") {
    return <Navigate to="/?tab=games" replace />;
  }
  if (user) return <Navigate to={routeForUser(user)} replace />;
  return <Navigate to={guestPlayAuthPath()} replace />;
}
