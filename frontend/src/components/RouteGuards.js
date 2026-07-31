import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "@/context/AuthContext";
import { routeForUser } from "@/lib/api";
import { LoadingScreen } from "@/components/common";

export function PublicOnly({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <LoadingScreen />;
  if (user) return <Navigate to={routeForUser(user)} replace />;
  return children;
}

export function RequireAuth({ children }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <LoadingScreen />;
  if (!user) return <Navigate to="/welcome" state={{ from: location }} replace />;
  return children;
}

export function RequireActive({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <LoadingScreen />;
  if (!user) return <Navigate to="/welcome" replace />;
  if (user.role !== "ADMIN" && user.status !== "ACTIVE") {
    return <Navigate to={routeForUser(user)} replace />;
  }
  return children;
}

export function RequirePartner({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <LoadingScreen />;
  if (!user) return <Navigate to="/login" replace />;
  // Anyone else goes to wherever they do belong rather than to the login page —
  // an admin who follows a partner link is signed in, just not as a partner.
  if (user.role !== "DISTRIBUTOR") return <Navigate to={routeForUser(user)} replace />;
  return children;
}

export function RequireAdmin({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <LoadingScreen />;
  if (!user) return <Navigate to="/welcome" replace />;
  if (user.role !== "ADMIN") return <Navigate to="/home" replace />;
  return children;
}
