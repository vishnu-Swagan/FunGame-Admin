import "@/App.css";
import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import { Toaster } from "@/components/ui/sonner";
import IosInstallHint from "@/components/IosInstallHint";
import { AuthProvider, useAuth } from "@/context/AuthContext";
import { routeForUser } from "@/lib/api";
import { IS_ADMIN_CONSOLE, ADMIN_LOGIN_PATH } from "@/lib/adminConsole";
import { LEGACY_CHIP_REQUESTS_ENABLED } from "@/lib/featureFlags";
import { ADMIN_PERMISSIONS, PortalPublicOnly, PublicOnly, RequireAuth, RequireActive, RequireAdmin, RequirePartner, RequirePermission } from "@/components/RouteGuards";
import { LoadingScreen } from "@/components/common";
import AppShell from "@/components/AppShell";

// Auth
import Welcome from "@/pages/auth/Welcome";
import Register from "@/pages/auth/Register";
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
import BankDetailsPage from "@/pages/app/wallet/BankDetailsPage";
import DepositReturn from "@/pages/app/wallet/DepositReturn";
import Support from "@/pages/app/Support";
import ResponsiblePlay from "@/pages/app/ResponsiblePlay";
import { LegalRouterPage } from "@/pages/legal/LegalPages";
import GamePlay from "@/pages/play/GamePlay";
import SevenUpDownCabinet from "@/pages/play/cabinet/SevenUpDownCabinet";
import KenoCabinet from "@/pages/play/cabinet/KenoCabinet";
import AndarBaharCabinet from "@/pages/play/cabinet/AndarBaharCabinet";
import PappuPicturesCabinet from "@/pages/play/cabinet/PappuPicturesCabinet";
import RouletteGame from "@/pages/play/RouletteGame";
import RummyGame from "@/pages/play/RummyGame";

// System
import { Maintenance, Offline, UpdateRequired } from "@/pages/system/SystemScreens";
import AccountClosed from "@/pages/system/AccountClosed";

// Admin
import AdminLayout from "@/pages/admin/AdminLayout";
import AdminDashboard from "@/pages/admin/AdminDashboard";
import AdminUsers from "@/pages/admin/AdminUsers";
import AdminChipRequests from "@/pages/admin/AdminChipRequests";
import AdminGames from "@/pages/admin/AdminGames";
import AdminAnnouncements from "@/pages/admin/AdminAnnouncements";
import AdminSettings from "@/pages/admin/AdminSettings";
import AdminDistributors from "@/pages/admin/AdminDistributors";
import AdminCommission from "@/pages/admin/AdminCommission";
import AdminSupport from "@/pages/admin/AdminSupport";
import AdminCompliance from "@/pages/admin/AdminCompliance";
import {
  AdminDeposits,
  AdminKyc,
  AdminPaymentAudit,
  AdminPaymentEvents,
  AdminPaymentSettings,
  AdminWalletLedger,
  AdminWithdrawals,
} from "@/pages/admin/AdminPaymentPages";
import AdminPlayHistory from "@/pages/admin/AdminPlayHistory";
import AdminPaymentHub from "@/pages/admin/AdminPaymentHub";
import AdminPaymentGateways from "@/pages/admin/AdminPaymentGateways";
import { AdminMonitoring, AdminSecurityAudit } from "@/pages/admin/AdminOperationsPages";

// Partner portal (distributors)
import PartnerLayout from "@/pages/partner/PartnerLayout";
import PartnerDashboard from "@/pages/partner/PartnerDashboard";
import PartnerRevenue from "@/pages/partner/PartnerRevenue";
import PartnerStatements from "@/pages/partner/PartnerStatements";
import PartnerPlayers from "@/pages/partner/PartnerPlayers";
import PartnerProfile from "@/pages/partner/PartnerProfile";
import PartnerTransactions from "@/pages/partner/PartnerTransactions";
import PartnerPasswordChange from "@/pages/partner/PartnerPasswordChange";

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

/** Preserve the complete suffix, query and hash while retiring historical
 * browser routes. This changes only frontend URLs; API `/admin/*` calls stay
 * untouched. */
function LegacyPathRedirect({ from, to, emptyTo }) {
  const location = useLocation();
  const suffix = location.pathname.slice(from.length);
  const destination = !suffix && emptyTo ? emptyTo : `${to}${suffix}`;
  return <Navigate to={`${destination}${location.search}${location.hash}`} replace />;
}

function AdminConsoleApp() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Toaster position="top-center" theme="dark" richColors closeButton />
        <Routes>
          <Route path={ADMIN_LOGIN_PATH} caseSensitive element={<PortalPublicOnly role="ADMIN"><AdminLogin role="ADMIN" /></PortalPublicOnly>} />
          <Route path="/distributor/login" caseSensitive element={<PortalPublicOnly role="DISTRIBUTOR"><AdminLogin role="DISTRIBUTOR" /></PortalPublicOnly>} />
          <Route path="/distributor/change-password" caseSensitive element={<RequirePartner allowPasswordChange><PartnerPasswordChange /></RequirePartner>} />
          <Route path="/Admin" caseSensitive element={<RequireAdmin><AdminLayout /></RequireAdmin>}>
            <Route index element={<Navigate to="dashboard" replace />} />
            <Route path="dashboard" element={<AdminDashboard />} />
            <Route path="players" element={<AdminUsers />} />
            <Route path="finance/*" element={<Navigate to="/Admin/dashboard" replace />} />
            <Route path="payment-gateways" element={<RequirePermission permission={ADMIN_PERMISSIONS.PAYMENTS_VIEW}><AdminPaymentGateways /></RequirePermission>} />
            <Route path="payment-hub" element={<RequirePermission permission={ADMIN_PERMISSIONS.PAYMENTS_VIEW}><AdminPaymentHub /></RequirePermission>} />
            <Route path="bonuses" element={LEGACY_CHIP_REQUESTS_ENABLED ? <AdminChipRequests /> : <Navigate to="/Admin/dashboard" replace />} />
            <Route path="games/catalog" element={<AdminGames />} />
            <Route path="reports" element={<AdminCompliance />} />
            <Route path="notifications" element={<AdminAnnouncements />} />
            <Route path="security" element={<RequirePermission permission={ADMIN_PERMISSIONS.AUDIT_VIEW}><AdminSecurityAudit /></RequirePermission>} />
            <Route path="monitoring" element={<AdminMonitoring />} />
            <Route path="signups" element={<Navigate to="/Admin/users?status=PENDING" replace />} />
            <Route path="users" element={<AdminUsers />} />
            <Route path="chip-requests" element={LEGACY_CHIP_REQUESTS_ENABLED ? <AdminChipRequests /> : <Navigate to="/Admin/dashboard" replace />} />
            <Route path="kyc" element={<RequirePermission permission={ADMIN_PERMISSIONS.KYC_VIEW}><AdminKyc /></RequirePermission>} />
            <Route path="deposits" element={<RequirePermission permission={ADMIN_PERMISSIONS.PAYMENTS_VIEW}><AdminDeposits /></RequirePermission>} />
            <Route path="withdrawals" element={<RequirePermission permission={ADMIN_PERMISSIONS.PAYMENTS_VIEW}><AdminWithdrawals /></RequirePermission>} />
            <Route path="payment-events" element={<RequirePermission permission={ADMIN_PERMISSIONS.PAYMENTS_VIEW}><AdminPaymentEvents /></RequirePermission>} />
            <Route path="wallet-ledger" element={<RequirePermission permission={ADMIN_PERMISSIONS.LEDGER_VIEW}><AdminWalletLedger /></RequirePermission>} />
            <Route path="play-history" element={<AdminPlayHistory />} />
            <Route path="payment-audit" element={<RequirePermission permission={ADMIN_PERMISSIONS.AUDIT_VIEW}><AdminPaymentAudit /></RequirePermission>} />
            <Route path="payment-settings" element={<RequirePermission permission={ADMIN_PERMISSIONS.PAYMENT_SETTINGS_WRITE}><AdminPaymentSettings /></RequirePermission>} />
            <Route path="distributors" element={<RequirePermission permission={ADMIN_PERMISSIONS.DISTRIBUTORS_VIEW}><AdminDistributors /></RequirePermission>} />
            <Route path="commission" element={<AdminCommission />} />
            <Route path="payouts" element={<Navigate to="/Admin/commission" replace />} />
            <Route path="compliance" element={<AdminCompliance />} />
            <Route path="support" element={<AdminSupport />} />
            <Route path="games" element={<AdminGames />} />
            <Route path="announcements" element={<AdminAnnouncements />} />
            <Route path="settings" element={<AdminSettings />} />
          </Route>
          <Route path="/distributor" caseSensitive element={<RequirePartner><PartnerLayout /></RequirePartner>}>
            <Route index element={<Navigate to="dashboard" replace />} />
            <Route path="dashboard" element={<PartnerDashboard />} />
            <Route path="my-commission" element={<PartnerStatements />} />
            <Route path="my-players" element={<PartnerPlayers />} />
            <Route path="notifications" element={<Notifications />} />
            <Route path="profile" element={<PartnerProfile />} />
            <Route path="reports" element={<PartnerRevenue />} />
            <Route path="support" element={<Support />} />
            <Route path="transactions" element={<PartnerTransactions />} />
          </Route>
          <Route path="/admin" caseSensitive element={<LegacyPathRedirect from="/admin" to="/Admin" />} />
          <Route path="/admin/*" caseSensitive element={<LegacyPathRedirect from="/admin" to="/Admin" />} />
          <Route path="/gk-admin-portal" caseSensitive element={<LegacyPathRedirect from="/gk-admin-portal" to="/Admin" emptyTo="/Admin/login" />} />
          <Route path="/gk-admin-portal/*" caseSensitive element={<LegacyPathRedirect from="/gk-admin-portal" to="/Admin" emptyTo="/Admin/login" />} />
          <Route path="/partner" caseSensitive element={<LegacyPathRedirect from="/partner" to="/distributor" />} />
          <Route path="/partner/*" caseSensitive element={<LegacyPathRedirect from="/partner" to="/distributor" />} />
          <Route path="*" element={<Navigate to="/Admin/dashboard" replace />} />
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
            <>
              <Route path="/__preview/seven-up-down" element={<SevenUpDownCabinet game={{ slug: "seven-up-down", name: "7up7down", demo: true }} />} />
              <Route path="/__preview/keno" element={<KenoCabinet game={{ slug: "keno", name: "Keno", demo: true }} />} />
              <Route path="/__preview/andar-bahar" element={<AndarBaharCabinet game={{ slug: "andar-bahar", name: "Andar Bahar", demo: true }} />} />
              <Route path="/__preview/american-roulette" element={<RouletteGame game={{ slug: "fun-roulette", name: "American Roulette", demo: true }} />} />
              <Route path="/__preview/pappu-pictures" element={<PappuPicturesCabinet game={{ slug: "pappu-pictures", name: "Pappu Pictures", demo: true }} />} />
              <Route path="/__preview/rummy" element={<RummyGame game={{ slug: "rummy", name: "Rummy", demo: true }} />} />
            </>
          )}
          {/* Public / auth */}
          <Route path="/" element={<PublicOnly><Welcome /></PublicOnly>} />
          <Route path="/welcome" element={<PublicOnly><Welcome /></PublicOnly>} />
          <Route path="/register" element={<PublicOnly><Register /></PublicOnly>} />
          <Route path="/verify" element={<PublicOnly><VerifyEmail /></PublicOnly>} />
          <Route path="/verify-email" element={<PublicOnly><VerifyEmail /></PublicOnly>} />
          <Route path="/login" element={<PublicOnly><Login /></PublicOnly>} />
          {/* Canonical, same-origin operator entries. Player login never stores
              an admin or distributor token. */}
          <Route path={ADMIN_LOGIN_PATH} caseSensitive element={<PortalPublicOnly role="ADMIN"><AdminLogin role="ADMIN" /></PortalPublicOnly>} />
          <Route path="/distributor/login" caseSensitive element={<PortalPublicOnly role="DISTRIBUTOR"><AdminLogin role="DISTRIBUTOR" /></PortalPublicOnly>} />
          <Route path="/distributor/change-password" caseSensitive element={<RequirePartner allowPasswordChange><PartnerPasswordChange /></RequirePartner>} />
          <Route path="/Admin" caseSensitive element={<RequireAdmin><AdminLayout /></RequireAdmin>}>
            <Route index element={<Navigate to="dashboard" replace />} />
            <Route path="dashboard" element={<AdminDashboard />} />
            <Route path="players" element={<AdminUsers />} />
            <Route path="finance/*" element={<Navigate to="/Admin/dashboard" replace />} />
            <Route path="payment-gateways" element={<RequirePermission permission={ADMIN_PERMISSIONS.PAYMENTS_VIEW}><AdminPaymentGateways /></RequirePermission>} />
            <Route path="payment-hub" element={<RequirePermission permission={ADMIN_PERMISSIONS.PAYMENTS_VIEW}><AdminPaymentHub /></RequirePermission>} />
            <Route path="bonuses" element={LEGACY_CHIP_REQUESTS_ENABLED ? <AdminChipRequests /> : <Navigate to="/Admin/dashboard" replace />} />
            <Route path="games/catalog" element={<AdminGames />} />
            <Route path="reports" element={<AdminCompliance />} />
            <Route path="notifications" element={<AdminAnnouncements />} />
            <Route path="security" element={<RequirePermission permission={ADMIN_PERMISSIONS.AUDIT_VIEW}><AdminSecurityAudit /></RequirePermission>} />
            <Route path="monitoring" element={<AdminMonitoring />} />
            <Route path="signups" element={<Navigate to="/Admin/users?status=PENDING" replace />} />
            <Route path="users" element={<AdminUsers />} />
            <Route path="chip-requests" element={LEGACY_CHIP_REQUESTS_ENABLED ? <AdminChipRequests /> : <Navigate to="/Admin/dashboard" replace />} />
            <Route path="kyc" element={<RequirePermission permission={ADMIN_PERMISSIONS.KYC_VIEW}><AdminKyc /></RequirePermission>} />
            <Route path="deposits" element={<RequirePermission permission={ADMIN_PERMISSIONS.PAYMENTS_VIEW}><AdminDeposits /></RequirePermission>} />
            <Route path="withdrawals" element={<RequirePermission permission={ADMIN_PERMISSIONS.PAYMENTS_VIEW}><AdminWithdrawals /></RequirePermission>} />
            <Route path="payment-events" element={<RequirePermission permission={ADMIN_PERMISSIONS.PAYMENTS_VIEW}><AdminPaymentEvents /></RequirePermission>} />
            <Route path="wallet-ledger" element={<RequirePermission permission={ADMIN_PERMISSIONS.LEDGER_VIEW}><AdminWalletLedger /></RequirePermission>} />
            <Route path="play-history" element={<AdminPlayHistory />} />
            <Route path="payment-audit" element={<RequirePermission permission={ADMIN_PERMISSIONS.AUDIT_VIEW}><AdminPaymentAudit /></RequirePermission>} />
            <Route path="payment-settings" element={<RequirePermission permission={ADMIN_PERMISSIONS.PAYMENT_SETTINGS_WRITE}><AdminPaymentSettings /></RequirePermission>} />
            <Route path="distributors" element={<RequirePermission permission={ADMIN_PERMISSIONS.DISTRIBUTORS_VIEW}><AdminDistributors /></RequirePermission>} />
            <Route path="commission" element={<AdminCommission />} />
            <Route path="payouts" element={<Navigate to="/Admin/commission" replace />} />
            <Route path="compliance" element={<AdminCompliance />} />
            <Route path="support" element={<AdminSupport />} />
            <Route path="games" element={<AdminGames />} />
            <Route path="announcements" element={<AdminAnnouncements />} />
            <Route path="settings" element={<AdminSettings />} />
          </Route>
          <Route path="/admin" caseSensitive element={<LegacyPathRedirect from="/admin" to="/Admin" />} />
          <Route path="/admin/*" caseSensitive element={<LegacyPathRedirect from="/admin" to="/Admin" />} />
          <Route path="/gk-admin-portal" caseSensitive element={<LegacyPathRedirect from="/gk-admin-portal" to="/Admin" emptyTo="/Admin/login" />} />
          <Route path="/gk-admin-portal/*" caseSensitive element={<LegacyPathRedirect from="/gk-admin-portal" to="/Admin" emptyTo="/Admin/login" />} />
          <Route path="/forgot-password" element={<PublicOnly><ForgotPassword /></PublicOnly>} />

          {/* Public company / legal pages (readable without an account). */}
          <Route path="/about" element={<LegalRouterPage />} />
          <Route path="/terms" element={<LegalRouterPage />} />
          <Route path="/privacy" element={<LegalRouterPage />} />
          <Route path="/cookies" element={<LegalRouterPage />} />
          <Route path="/contact" element={<LegalRouterPage />} />
          <Route path="/fair-play" element={<LegalRouterPage />} />
          <Route path="/responsible-gaming" element={<LegalRouterPage />} />

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
            <Route path="/chips/deposit" element={<ChipsPage />} />
            <Route path="/chips/deposit/return" element={<DepositReturn />} />
            <Route path="/chips/deposit/return/:depositId" element={<DepositReturn />} />
            <Route path="/chips/withdraw" element={<ChipsPage />} />
            <Route path="/chips/activity" element={<ChipsPage />} />
            <Route path="/chips/request" element={<Navigate to="/chips" replace />} />
            <Route path="/chips/history" element={<Navigate to="/chips/activity" replace />} />
            <Route path="/announcements" element={<Announcements />} />
            <Route path="/notifications" element={<Notifications />} />
            <Route path="/profile" element={<Profile />} />
            <Route path="/profile/bank-details" element={<BankDetailsPage />} />
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

          {/* Distributor portal — role-isolated; no wallet and no games. */}
          <Route path="/distributor" caseSensitive element={<RequirePartner><PartnerLayout /></RequirePartner>}>
            <Route index element={<Navigate to="dashboard" replace />} />
            <Route path="dashboard" element={<PartnerDashboard />} />
            <Route path="my-commission" element={<PartnerStatements />} />
            <Route path="my-players" element={<PartnerPlayers />} />
            <Route path="notifications" element={<Notifications />} />
            <Route path="profile" element={<PartnerProfile />} />
            <Route path="reports" element={<PartnerRevenue />} />
            <Route path="support" element={<Support />} />
            <Route path="transactions" element={<PartnerTransactions />} />
          </Route>
          <Route path="/partner" caseSensitive element={<LegacyPathRedirect from="/partner" to="/distributor" />} />
          <Route path="/partner/*" caseSensitive element={<LegacyPathRedirect from="/partner" to="/distributor" />} />

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
