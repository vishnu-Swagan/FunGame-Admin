import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import {
  ArrowRight,
  Building2,
  CircleUserRound,
  Eye,
  EyeOff,
  LockKeyhole,
  ShieldCheck,
  UsersRound,
} from "lucide-react";
import { api, errMsg, routeForUser } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { IS_ADMIN_CONSOLE } from "@/lib/adminConsole";
import { BrandWordmark } from "@/components/Brand";
import "@/pages/admin/admin-crm.css";

const WORKSPACES = [
  {
    id: "admin",
    role: "ADMIN",
    label: "Admin CRM",
    description: "Operations, finance, games, and security",
    icon: Building2,
  },
  {
    id: "distributor",
    role: "DISTRIBUTOR",
    label: "Distributor Portal",
    description: "Attributed performance and commission",
    icon: UsersRound,
  },
  {
    id: "player",
    role: "PLAYER",
    label: "Player App",
    description: "Games, wallet, payments, and support",
    icon: CircleUserRound,
  },
];

export default function AdminLogin() {
  const navigate = useNavigate();
  const { login } = useAuth();
  const [workspace, setWorkspace] = useState("admin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      const { data } = await api.post("/auth/login", { email, password });
      const selected = WORKSPACES.find((item) => item.id === workspace);
      if (data.user.role !== selected.role) {
        toast.error(`This account is not assigned to the ${selected.label} workspace.`);
        return;
      }

      login(data.access_token, data.user);
      if (data.user.role === "ADMIN") {
        navigate("/admin/dashboard", { replace: true });
      } else if (IS_ADMIN_CONSOLE) {
        window.location.assign("https://play.chakri.casino/login");
      } else {
        navigate(routeForUser(data.user), { replace: true });
      }
    } catch (error) {
      toast.error(errMsg(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="crm-login-page" data-testid="admin-login">
      <section className="crm-login-brand-panel" aria-label="Chakri platform">
        <div className="crm-login-brand-lockup">
          <BrandWordmark logoClassName="crm-login-brand-logo" />
        </div>

        <div className="crm-login-statement">
          <span>One governed platform</span>
          <h1>Operate every game and wallet movement with traceability.</h1>
          <p>Role-isolated workspaces connect platform operations, distributor reporting, and the player experience.</p>
        </div>

        <div className="crm-login-trust">
          <ShieldCheck size={20} />
          <span>
            <strong>Security by default</strong>
            <small>RBAC, immutable ledger records, audit trails, and protected sessions.</small>
          </span>
        </div>
      </section>

      <section className="crm-login-form-panel">
        <div className="crm-login-form-wrap">
          <header>
            <span className="crm-mobile-login-mark">
              <BrandWordmark logoClassName="crm-mobile-brand-logo" />
            </span>
            <h2>Sign in</h2>
            <p>Choose the workspace assigned to your account.</p>
          </header>

          <div className="crm-login-role-grid" role="group" aria-label="Choose workspace">
            {WORKSPACES.map(({ id, label, description, icon: Icon }) => (
              <button
                key={id}
                type="button"
                className={workspace === id ? "active" : ""}
                onClick={() => setWorkspace(id)}
              >
                <Icon size={19} strokeWidth={1.7} />
                <span>
                  <strong>{label}</strong>
                  <small>{description}</small>
                </span>
              </button>
            ))}
          </div>

          <form className="crm-login-form" onSubmit={submit}>
            <label className="crm-login-field" htmlFor="admin-email">
              <span>Email address</span>
              <input
                id="admin-email"
                data-testid="admin-login-email-input"
                type="email"
                required
                autoComplete="username"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>

            <label className="crm-login-field" htmlFor="admin-password">
              <span>Password</span>
              <div className="crm-password-control">
                <LockKeyhole size={17} />
                <input
                  id="admin-password"
                  data-testid="admin-login-password-input"
                  type={showPassword ? "text" : "password"}
                  required
                  autoComplete="current-password"
                  placeholder="Enter your password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
                <button
                  type="button"
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  onClick={() => setShowPassword((value) => !value)}
                >
                  {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
                </button>
              </div>
            </label>

            <div className="crm-login-form-meta">
              <span>For password recovery, contact an authorized platform administrator.</span>
            </div>

            <button
              data-testid="admin-login-submit"
              className="crm-login-submit"
              type="submit"
              disabled={busy || !email || !password}
            >
              {busy ? "Signing in..." : "Sign in securely"}
              {!busy && <ArrowRight size={16} />}
            </button>
          </form>
        </div>
      </section>
    </main>
  );
}
