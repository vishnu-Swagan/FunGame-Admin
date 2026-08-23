import { useEffect, useMemo, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import {
  Bell,
  Calculator,
  ChevronDown,
  FileText,
  Gamepad2,
  Gift,
  LayoutDashboard,
  LogOut,
  Menu,
  MessagesSquare,
  Network,
  Search,
  Settings,
  ShieldCheck,
  Users,
  X,
} from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { ADMIN_LOGOUT_PATH } from "@/lib/adminConsole";
import { ADMIN_PERMISSIONS, hasPermission } from "@/components/RouteGuards";
import { BrandWordmark } from "@/components/Brand";
import "@/pages/admin/admin-crm.css";

const NAV_GROUPS = [
  {
    items: [
      { to: "/Admin/dashboard", label: "Dashboard", icon: LayoutDashboard, end: true, testId: "admin-nav-dashboard" },
    ],
  },
  {
    label: "People",
    items: [
      { to: "/Admin/players", label: "Players", icon: Users, matches: ["/Admin/players", "/Admin/users"], testId: "admin-nav-users" },
      { to: "/Admin/distributors", label: "Distributors", icon: Network, permission: ADMIN_PERMISSIONS.DISTRIBUTORS_VIEW, testId: "admin-nav-distributors" },
      { to: "/Admin/commission", label: "Commission", icon: Calculator, testId: "admin-nav-commission" },
    ],
  },
  {
    label: "Virtual chips",
    items: [
      { to: "/Admin/bonuses", label: "Chip requests", icon: Gift, matches: ["/Admin/bonuses", "/Admin/chip-requests"], testId: "admin-nav-chip-requests" },
    ],
  },
  {
    label: "Platform",
    items: [
      { to: "/Admin/games/catalog", label: "Games", icon: Gamepad2, matches: ["/Admin/games"], testId: "admin-nav-games" },
      { to: "/Admin/reports", label: "Reports", icon: FileText, matches: ["/Admin/reports", "/Admin/compliance"], testId: "admin-nav-compliance" },
      { to: "/Admin/support", label: "Support", icon: MessagesSquare, testId: "admin-nav-support" },
      { to: "/Admin/notifications", label: "Notifications", icon: Bell, matches: ["/Admin/notifications", "/Admin/announcements"], testId: "admin-nav-announcements" },
    ],
  },
  {
    label: "Control",
    items: [
      {
        to: "/Admin/security",
        label: "Security & audit",
        icon: ShieldCheck,
        permission: ADMIN_PERMISSIONS.AUDIT_VIEW,
        matches: ["/Admin/security", "/Admin/payment-audit", "/Admin/kyc"],
        testId: "admin-nav-payment-audit",
      },
      { to: "/Admin/settings", label: "Settings", icon: Settings, testId: "admin-nav-settings" },
    ],
  },
];

const FLAT_NAV = NAV_GROUPS.flatMap((group) => group.items);

function initialsFor(user) {
  const identity = user?.name || user?.username || user?.email || "Admin";
  return identity
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "AD";
}

export default function AdminLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout } = useAuth();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    document.body.classList.add("crm-admin-active");
    return () => document.body.classList.remove("crm-admin-active");
  }, []);

  const visibleGroups = useMemo(
    () => NAV_GROUPS.map((group) => ({
      ...group,
      items: group.items.filter((item) => !item.permission || hasPermission(user, item.permission)),
    })).filter((group) => group.items.length),
    [user],
  );

  const searchResults = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const available = visibleGroups.flatMap((group) => group.items);
    return normalized ? available.filter((item) => item.label.toLowerCase().includes(normalized)) : available;
  }, [query, visibleGroups]);

  const activeItem = FLAT_NAV.find((item) => {
    if (item.end) return location.pathname === item.to || (item.label === "Dashboard" && location.pathname === "/Admin");
    return (item.matches || [item.to]).some((path) => location.pathname.startsWith(path));
  });
  const activeGroup = NAV_GROUPS.find((group) => group.items.some((item) => item === activeItem));

  const go = (to) => {
    navigate(to);
    setSearchOpen(false);
    setSidebarOpen(false);
    setQuery("");
  };

  const signOut = () => {
    logout();
    navigate(ADMIN_LOGOUT_PATH);
  };

  return (
    <div className="crm-admin app-shell" data-testid="admin-shell">
      <a className="skip-link" href="#admin-content">Skip to content</a>

      {sidebarOpen && (
        <button
          type="button"
          className="sidebar-scrim"
          aria-label="Close navigation"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <aside className={`sidebar ${sidebarOpen ? "is-open" : ""}`} aria-label="Admin navigation">
        <div className="brand-lockup" data-testid="admin-logo">
          <BrandWordmark logoClassName="admin-brand-logo" />
          <button type="button" className="sidebar-close" aria-label="Close navigation" onClick={() => setSidebarOpen(false)}>
            <X size={18} />
          </button>
        </div>

        <nav className="sidebar-nav">
          {visibleGroups.map((group, groupIndex) => (
            <div className="nav-group" key={group.label || `primary-${groupIndex}`}>
              {group.label && <span className="nav-group-label">{group.label}</span>}
              {group.items.map(({ to, label, icon: Icon, end, matches, testId }) => {
                const forcedActive = (matches || []).some((path) => location.pathname.startsWith(path));
                return (
                  <NavLink
                    key={to}
                    to={to}
                    end={end}
                    data-testid={testId}
                    onClick={() => setSidebarOpen(false)}
                    className={({ isActive }) => `nav-link ${isActive || forcedActive || (label === "Dashboard" && location.pathname === "/Admin") ? "active" : ""}`}
                  >
                    <Icon size={17} strokeWidth={1.8} />
                    <span>{label}</span>
                  </NavLink>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="environment-status"><span /> Production · live service</div>
          <button type="button" data-testid="admin-logout-button" onClick={signOut}>
            <LogOut size={16} /> Sign out
          </button>
        </div>
      </aside>

      <div className="shell-main">
        <header className="topbar" data-testid="admin-topbar">
          <button type="button" className="icon-button mobile-menu" aria-label="Open navigation" onClick={() => setSidebarOpen(true)}>
            <Menu size={18} />
          </button>

          <div className="breadcrumbs" aria-label="Breadcrumb">
            <span>Admin CRM</span>
            {activeGroup?.label && <span>{activeGroup.label}</span>}
            <span>{activeItem?.label || "Dashboard"}</span>
          </div>

          <div className="topbar-actions">
            <button type="button" className="global-search" onClick={() => setSearchOpen((value) => !value)} aria-expanded={searchOpen}>
              <Search size={15} />
              <span>Search workspace</span>
              <kbd>⌘ K</kbd>
            </button>
            <button type="button" className="icon-button has-alert" aria-label="Open notifications" onClick={() => navigate("/Admin/notifications")}>
              <Bell size={17} />
            </button>
            <div className="role-switcher role-fixed" aria-label="Current administrator">
              <span className="avatar">{initialsFor(user)}</span>
              <span className="role-person">
                <strong>{user?.name || user?.username || "Platform administrator"}</strong>
                <small>{user?.email || "Admin CRM"}</small>
              </span>
              <ChevronDown size={14} />
            </div>
          </div>

          {searchOpen && (
            <div className="command-search-panel" role="dialog" aria-label="Search workspace">
              <div className="command-search">
                <Search size={16} />
                <input
                  autoFocus
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") setSearchOpen(false);
                    if (event.key === "Enter" && searchResults[0]) go(searchResults[0].to);
                  }}
                  placeholder="Search pages and controls"
                  aria-label="Search pages and controls"
                />
                <span>Esc to close</span>
              </div>
              <div className="command-results">
                {searchResults.slice(0, 8).map((item) => (
                  <button key={item.to} type="button" onClick={() => go(item.to)}>
                    <item.icon size={16} />
                    <span>{item.label}</span>
                  </button>
                ))}
                {!searchResults.length && <p>No workspace pages match “{query}”.</p>}
              </div>
            </div>
          )}
        </header>

        <main id="admin-content" className="page-content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
