import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import {
  ArrowRight,
  Building2,
  Eye,
  EyeOff,
  LockKeyhole,
  ShieldCheck,
  UsersRound,
} from "lucide-react";
import { api, errMsg } from "@/lib/api";
import { loginRequestPayload } from "@/lib/loginSurface";
import { useAuth } from "@/context/AuthContext";
import { BrandWordmark } from "@/components/Brand";
import "@/pages/admin/admin-crm.css";

const WORKSPACES = {
  ADMIN: {
    role: "ADMIN",
    label: "Admin CRM",
    description: "Players, distributors, games, support, and platform controls",
    icon: Building2,
    destination: "/Admin/dashboard",
    identifierLabel: "Administrator email or Login ID",
  },
  DISTRIBUTOR: {
    role: "DISTRIBUTOR",
    label: "Distributor Portal",
    description: "Attributed performance, commission records, reports, and support",
    icon: UsersRound,
    destination: "/distributor/dashboard",
    identifierLabel: "Distributor Login ID or email",
  },
};

export default function AdminLogin({ role = "ADMIN" }) {
  const navigate = useNavigate();
  const { login } = useAuth();
  const workspace = WORKSPACES[role] || WORKSPACES.ADMIN;
  const WorkspaceIcon = workspace.icon;
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      const { data } = await api.post(
        "/auth/login",
        loginRequestPayload(identifier, password, workspace.role),
      );
      if (data.user.role !== workspace.role) {
        toast.error(`This account is not assigned to the ${workspace.label}.`);
        return;
      }

      login(data.access_token, data.user);
      navigate(
        data.user.role === "DISTRIBUTOR" && data.user.password_change_required
          ? "/distributor/change-password"
          : workspace.destination,
        { replace: true },
      );
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
          <h1>{role === "ADMIN" ? "Operate the platform with traceability." : "See the activity attributed to your network."}</h1>
          <p>Role-isolated workspaces keep administration, distributor reporting, and the player experience separate.</p>
        </div>

        <div className="crm-login-trust">
          <ShieldCheck size={20} />
          <span>
            <strong>Security by default</strong>
            <small>Role-based access, audit trails, and protected sessions.</small>
          </span>
        </div>
      </section>

      <section className="crm-login-form-panel">
        <div className="crm-login-form-wrap">
          <header>
            <h2>{workspace.label}</h2>
            <p>Use the credentials assigned to this workspace.</p>
          </header>

          <div className="crm-login-role-grid" aria-label="Selected workspace">
            <div className="active" role="status">
              <WorkspaceIcon size={19} strokeWidth={1.7} />
              <span>
                <strong>{workspace.label}</strong>
                <small>{workspace.description}</small>
              </span>
            </div>
          </div>

          <form className="crm-login-form" onSubmit={submit}>
            <label className="crm-login-field" htmlFor="portal-identifier">
              <span>{workspace.identifierLabel}</span>
              <input
                id="portal-identifier"
                data-testid="admin-login-email-input"
                type="text"
                required
                autoComplete="username"
                value={identifier}
                onChange={(event) => setIdentifier(event.target.value)}
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
              disabled={busy || !identifier || !password}
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
