import "@/App.css";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Toaster } from "@/components/ui/sonner";
import { AuthProvider, useAuth } from "@/context/AuthContext";
import { routeForUser } from "@/lib/api";
import { PublicOnly, RequireAuth, RequireActive, RequireAdmin } from "@/components/RouteGuards";
import { LoadingScreen } from "@/components/common";
import AppShell from "@/components/AppShell";

// Auth
import Welcome from "@/pages/auth/Welcome";
import Register from "@/pages/auth/Register";
import VerifyEmail from "@/pages/auth/VerifyEmail";
import Login from "@/pages/auth/Login";
import ForgotPassword from "@/pages/auth/ForgotPassword";

// Onboarding
import OnboardingProfile from "@/pages/onboarding/OnboardingProfile";
import OnboardingReview from "@/pages/onboarding/OnboardingReview";
import OnboardingPending from "@/pages/onboarding/OnboardingPending";

// App
import Home from "@/pages/app/Home";
import Games from "@/pages/app/Games";
import GameDetail from "@/pages/app/GameDetail";
import SearchPage from "@/pages/app/SearchPage";
import { Favorites, Recent } from "@/pages/app/FavoritesRecent";
import ChipsPage from "@/pages/app/ChipsPage";
import Announcements from "@/pages/app/Announcements";
import Notifications from "@/pages/app/Notifications";
import { Profile, Security, Settings } from "@/pages/app/ProfilePages";
import Support from "@/pages/app/Support";
import GamePlay from "@/pages/play/GamePlay";

// System
import { Maintenance, Offline, UpdateRequired } from "@/pages/system/SystemScreens";

// Admin
import AdminLayout from "@/pages/admin/AdminLayout";
import AdminDashboard from "@/pages/admin/AdminDashboard";
import AdminUsers from "@/pages/admin/AdminUsers";
import AdminSignups from "@/pages/admin/AdminSignups";
import AdminChipRequests from "@/pages/admin/AdminChipRequests";
import AdminGames from "@/pages/admin/AdminGames";
import AdminAnnouncements from "@/pages/admin/AdminAnnouncements";
import AdminSettings from "@/pages/admin/AdminSettings";
import AdminSupport from "@/pages/admin/AdminSupport";

// Onboarding-only gate: ACTIVE users and admins are redirected away
function OnboardingRoute({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <LoadingScreen />;
  if (!user) return <Navigate to="/welcome" replace />;
  if (user.role === "ADMIN" || user.status === "ACTIVE") return <Navigate to={routeForUser(user)} replace />;
  return children;
}

function FallbackRedirect() {
  const { user, loading } = useAuth();
  if (loading) return <LoadingScreen />;
  return <Navigate to={routeForUser(user)} replace />;
}

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Toaster position="top-center" theme="dark" richColors closeButton />
        <Routes>
          {/* Public / auth */}
          <Route path="/" element={<PublicOnly><Welcome /></PublicOnly>} />
          <Route path="/welcome" element={<PublicOnly><Welcome /></PublicOnly>} />
          <Route path="/register" element={<PublicOnly><Register /></PublicOnly>} />
          <Route path="/verify-email" element={<PublicOnly><VerifyEmail /></PublicOnly>} />
          <Route path="/login" element={<PublicOnly><Login /></PublicOnly>} />
          <Route path="/forgot-password" element={<PublicOnly><ForgotPassword /></PublicOnly>} />

          {/* Onboarding */}
          <Route path="/onboarding/profile" element={<OnboardingRoute><OnboardingProfile /></OnboardingRoute>} />
          <Route path="/onboarding/review" element={<OnboardingRoute><OnboardingReview /></OnboardingRoute>} />
          <Route path="/onboarding/pending" element={<OnboardingRoute><OnboardingPending /></OnboardingRoute>} />

          {/* Player app (ACTIVE only) */}
          <Route element={<RequireActive><AppShell /></RequireActive>}>
            <Route path="/home" element={<Home />} />
            <Route path="/games" element={<Games />} />
            <Route path="/games/:slug" element={<GameDetail />} />
            <Route path="/games/:slug/play" element={<GamePlay />} />
            <Route path="/search" element={<SearchPage />} />
            <Route path="/favorites" element={<Favorites />} />
            <Route path="/recent" element={<Recent />} />
            <Route path="/chips" element={<ChipsPage />} />
            <Route path="/chips/request" element={<ChipsPage />} />
            <Route path="/chips/history" element={<ChipsPage />} />
            <Route path="/announcements" element={<Announcements />} />
            <Route path="/notifications" element={<Notifications />} />
            <Route path="/profile" element={<Profile />} />
            <Route path="/security" element={<Security />} />
            <Route path="/settings" element={<Settings />} />
          </Route>

          {/* Support — available to any signed-in user (incl. pending onboarding) */}
          <Route path="/support" element={<RequireAuth><Support /></RequireAuth>} />

          {/* System */}
          <Route path="/maintenance" element={<Maintenance />} />
          <Route path="/offline" element={<Offline />} />
          <Route path="/update-required" element={<UpdateRequired />} />

          {/* Admin */}
          <Route path="/admin" element={<RequireAdmin><AdminLayout /></RequireAdmin>}>
            <Route index element={<AdminDashboard />} />
            <Route path="signups" element={<AdminSignups />} />
            <Route path="users" element={<AdminUsers />} />
            <Route path="chip-requests" element={<AdminChipRequests />} />
            <Route path="support" element={<AdminSupport />} />
            <Route path="games" element={<AdminGames />} />
            <Route path="announcements" element={<AdminAnnouncements />} />
            <Route path="settings" element={<AdminSettings />} />
          </Route>

          {/* Fallback */}
          <Route path="*" element={<FallbackRedirect />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
