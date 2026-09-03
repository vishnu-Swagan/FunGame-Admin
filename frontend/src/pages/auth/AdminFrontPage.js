import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "@/context/AuthContext";
import { routeForUser } from "@/lib/api";
import { ADMIN_LOGIN_PATH } from "@/lib/adminConsole";
import { LoadingScreen } from "@/components/common";
import { isActiveAdmin } from "@/lib/adminPermissions";
import AdminLogin from "@/pages/auth/AdminLogin";
import AdminLayout from "@/pages/admin/AdminLayout";

/**
 * Same-origin Admin CRM front door on chakri.casino/Admin:
 * - logged out (or inactive admin) at /Admin → existing Admin CRM login UI
 * - logged-in ADMIN → AdminLayout with nested /Admin/... CRM routes
 * - other /Admin/* while signed out → bounce to /Admin (not a separate login URL)
 */
export default function AdminFrontPage() {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) return <LoadingScreen />;

  if (user && isActiveAdmin(user)) {
    return <AdminLayout />;
  }

  if (user && user.role !== "ADMIN") {
    return <Navigate to={routeForUser(user)} replace />;
  }

  const path = location.pathname;
  const atFrontDoor = path === ADMIN_LOGIN_PATH || path === `${ADMIN_LOGIN_PATH}/`;
  if (atFrontDoor) {
    return <AdminLogin role="ADMIN" />;
  }
  return <Navigate to={ADMIN_LOGIN_PATH} replace />;
}
