import "@/App.css";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Toaster } from "@/components/ui/sonner";
import IosInstallHint from "@/components/IosInstallHint";
import { AuthProvider, useAuth } from "@/context/AuthContext";
import { routeForUser } from "@/lib/api";
import { IS_ADMIN_CONSOLE, ADMIN_LOGIN_PATH } from "@/lib/adminConsole";
import { PublicOnly, RequireAuth, RequireActive, RequireAdmin, RequirePartner } from "@/components/RouteGuards";
import { LoadingScreen } from "@/components/common";
import AppShell from "@/components/AppShell";

// Auth
import Welcome from "@/pages/auth/Welcome";
import VerifyEmail from "@/pages/auth/VerifyEmail";
import Login from "@/pages/auth/Login";
import AdminLogin from "@/pages/auth/AdminLogin";
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
import ResponsiblePlay from "@/pages/app/ResponsiblePlay";
import GamePlay from "@/pages/play/GamePlay";
import SevenUpDownCabinet from "@/pages/play/cabinet/SevenUpDownCabinet";

// System
import { Maintenance, Offline, UpdateRequired } from "@/pages/system/SystemScreens";
import AccountClosed from "@/pages/system/AccountClosed";

// Admin
import AdminLayout from "@/pages/admin/AdminLayout";
import AdminDashboard from "@/pages/admin/AdminDashboard";
import AdminUsers from "@/pages/admin/AdminUsers";
import AdminSignups from "@/pages/admin/AdminSignups";
import AdminChipRequests from "@/pages/admin/AdminChipRequests";
import AdminGames from "@/pages/admin/AdminGames";
import AdminAnnouncements from "@/pages/admin/AdminAnnouncements";
import AdminSettings from "@/pages/admin/AdminSettings";
import AdminDistributors from "@/pages/admin/AdminDistributors";
import AdminCommission from "@/pages/admin/AdminCommission";
import AdminPayouts from "@/pages/admin/AdminPayouts";
import AdminSupport from "@/pages/admin/AdminSupport";
import AdminCompliance from "@/pages/admin/AdminCompliance";

// Partner portal (distributors)
import PartnerLayout from "@/pages/partner/PartnerLayout";
import PartnerDashboard from "@/pages/partner/PartnerDashboard";
import PartnerRevenue from "@/pages/partner/PartnerRevenue";
import PartnerStatements from "@/pages/partner/PartnerStatements";
import PartnerPlayers from "@/pages/partner/PartnerPlayers";

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

function AdminConsoleApp() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Toaster position="top-center" theme="dark" richColors closeButton />
        <Routes>
          <Route path={ADMIN_LOGIN_PATH} element={<PublicOnly><AdminLogin /></PublicOnly>} />
          <Route path="/admin" element={<RequireAdmin><AdminLayout /></RequireAdmin>}>
            <Route index element={<AdminDashboard />} />
            <Route path="signups" element={<AdminSignups />} />
            <Route path="users" element={<AdminUsers />} />
            <Route path="chip-requests" element={<AdminChipRequests />} />
            <Route path="distributors" element={<AdminDistributors />} />
            <Route path="commission" element={<AdminCommission />} />
            <Route path="payouts" element={<AdminPayouts />} />
            <Route path="compliance" element={<AdminCompliance />} />
            <Route path="support" element={<AdminSupport />} />
            <Route path="games" element={<AdminGames />} />
            <Route path="announcements" element={<AdminAnnouncements />} />
            <Route path="settings" element={<AdminSettings />} />
          </Route>
          <Route path="*" element={<Navigate to="/admin" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}

function PlayerApp() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Toaster position="top-center" theme="dark" richColors closeButton />
        <Routes>
          {process.env.NODE_ENV === "development" && (
            <Route path="/__preview/seven-up-down" element={<SevenUpDownCabinet game={{ slug: "seven-up-down", name: "7up7down", demo: true }} />} />
          )}
          {/* Public / auth */}
          <Route path="/" element={<PublicOnly><Welcome /></PublicOnly>} />
          <Route path="/welcome" element={<PublicOnly><Welcome /></PublicOnly>} />
          {/* Signup removed — accounts are provisioned by the admin. Old links go to login. */}
          <Route path="/register" element={<Navigate to="/login" replace />} />
          <Route path="/verify-email" element={<PublicOnly><VerifyEmail /></PublicOnly>} />
          <Route path="/login" element={<PublicOnly><Login /></PublicOnly>} />
          {/* Private operator sign-in — separate, unlinked admin URL */}
          <Route path="/gk-admin-portal" element={<PublicOnly><AdminLogin /></PublicOnly>} />
          <Route path="/forgot-password" element={<PublicOnly><ForgotPassword /></PublicOnly>} />

          {/* Onboarding */}
          <Route path="/onboarding/profile" element={<OnboardingRoute><OnboardingProfile /></OnboardingRoute>} />
          <Route path="/onboarding/review" element={<OnboardingRoute><OnboardingReview /></OnboardingRoute>} />
          <Route path="/onboarding/pending" element={<OnboardingRoute><OnboardingPending /></OnboardingRoute>} />

          {/* Player app (ACTIVE only) */}
          <Route element={<RequireActive><AppShell /></RequireActive>}>
            <Route path="/home" element={<Home />} />
            <Route path="/games" element={<Games />} />
            {/* Direct launch URL requested by the operator. caseSensitive keeps
                the normal lowercase /games/aviator detail page intact. */}
            <Route
              path="/games/Aviator"
              caseSensitive
              element={<Navigate to="/games/aviator/play" replace />}
            />
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

          {/* Support and responsible play — reachable by any signed-in user,
              including one who has excluded themselves. Putting these behind
              RequireActive would shut a player out of the screen that explains
              why they are shut out, and out of the way back. */}
          <Route path="/support" element={<RequireAuth><Support /></RequireAuth>} />
          <Route path="/responsible-play" element={<RequireAuth><ResponsiblePlay /></RequireAuth>} />
          <Route path="/account-closed" element={<RequireAuth><AccountClosed /></RequireAuth>} />

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
            <Route path="distributors" element={<AdminDistributors />} />
            <Route path="commission" element={<AdminCommission />} />
            <Route path="payouts" element={<AdminPayouts />} />
            <Route path="compliance" element={<AdminCompliance />} />
            <Route path="support" element={<AdminSupport />} />
            <Route path="games" element={<AdminGames />} />
            <Route path="announcements" element={<AdminAnnouncements />} />
            <Route path="settings" element={<AdminSettings />} />
          </Route>

          {/* Partner portal — distributors only; no wallet, no games */}
          <Route path="/partner" element={<RequirePartner><PartnerLayout /></RequirePartner>}>
            <Route index element={<PartnerDashboard />} />
            <Route path="revenue" element={<PartnerRevenue />} />
            <Route path="statements" element={<PartnerStatements />} />
            <Route path="players" element={<PartnerPlayers />} />
          </Route>

          {/* Fallback */}
          <Route path="*" element={<FallbackRedirect />} />
        </Routes>
        <IosInstallHint />
      </AuthProvider>
    </BrowserRouter>
  );
}

export default function App() {
  return IS_ADMIN_CONSOLE ? <AdminConsoleApp /> : <PlayerApp />;
}
