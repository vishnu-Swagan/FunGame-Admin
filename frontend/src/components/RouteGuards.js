import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "@/context/AuthContext";
import { routeForUser } from "@/lib/api";
import { guestPlayAuthPath } from "@/lib/frontDoor";
import { ADMIN_LOGIN_PATH, DISTRIBUTOR_LOGIN_PATH, IS_ADMIN_CONSOLE } from "@/lib/adminConsole";
import { LoadingScreen } from "@/components/common";
import { ADMIN_PERMISSIONS, hasPermission, isActiveAdmin } from "@/lib/adminPermissions";

export function PublicOnly({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <LoadingScreen />;
  if (user && IS_ADMIN_CONSOLE && !isActiveAdmin(user)) return children;
  if (user) return <Navigate to={routeForUser(user)} replace />;
  return children;
}

/** A role-specific portal login may replace an unrelated remembered session,
 * but it never shows a second login form to an account already in that portal. */
export function PortalPublicOnly({ role, children }) {
  const { user, loading } = useAuth();
  if (loading) return <LoadingScreen />;
  if (!user) return children;
  if (role === "ADMIN" && isActiveAdmin(user)) return <Navigate to="/Admin/dashboard" replace />;
  if (role === "DISTRIBUTOR" && user.role === "DISTRIBUTOR" && user.status === "ACTIVE") return <Navigate to={routeForUser(user)} replace />;
  return children;
}

export function RequireAuth({ children }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <LoadingScreen />;
  if (!user) return <Navigate to={guestPlayAuthPath()} state={{ from: location }} replace />;
  return children;
}

export function RequireActive({ children }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <LoadingScreen />;
  if (!user) return <Navigate to={guestPlayAuthPath()} state={{ from: location }} replace />;
  if (user.role !== "PLAYER" || user.status !== "ACTIVE") return <Navigate to={routeForUser(user)} replace />;
  return children;
}

export function RequirePartner({ children, allowPasswordChange = false }) {
  const { user, loading } = useAuth();
  if (loading) return <LoadingScreen />;
  if (!user) return <Navigate to={DISTRIBUTOR_LOGIN_PATH} replace />;
  // Anyone else goes to wherever they do belong rather than to the login page —
  // an admin who follows a partner link is signed in, just not as a partner.
  if (user.role !== "DISTRIBUTOR") return <Navigate to={routeForUser(user)} replace />;
  if (user.status !== "ACTIVE") return <Navigate to={DISTRIBUTOR_LOGIN_PATH} replace />;
  if (user.password_change_required && !allowPasswordChange) {
    return <Navigate to="/distributor/change-password" replace />;
  }
  return children;
}

export function RequireAdmin({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <LoadingScreen />;
  // `/Admin` is the canonical same-origin operator entry on every deployed
  // host. A signed-out visit must never fall through to the player welcome page.
  if (!user) return <Navigate to={ADMIN_LOGIN_PATH} replace />;
  if (user.role !== "ADMIN") return <Navigate to={routeForUser(user)} replace />;
  if (!isActiveAdmin(user)) return <Navigate to={ADMIN_LOGIN_PATH} replace />;
  return children;
}

export function RequirePermission({ permission, children }) {
  const { user, loading } = useAuth();
  if (loading) return <LoadingScreen />;
  if (!hasPermission(user, permission)) return <Navigate to="/Admin/dashboard" replace />;
  return children;
}

export { ADMIN_PERMISSIONS, hasPermission, isActiveAdmin };
