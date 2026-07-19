import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Wrench, WifiOff, ArrowUpCircle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/context/AuthContext";
import { routeForUser, APP_VERSION, compareVersions } from "@/lib/api";
import { Disclaimer } from "@/components/common";

const Shell = ({ icon: Icon, iconClass, title, children, testId }) => (
  <div className="App fg-noise min-h-dvh bg-background flex items-center justify-center px-5" data-testid={testId}>
    <div className="fg-aurora absolute top-0 left-0 right-0 h-[160px] pointer-events-none" />
    <div className="relative z-[2] w-full max-w-[400px] rounded-2xl bg-card/60 backdrop-blur-md border border-white/10 p-8 text-center shadow-[0_10px_30px_rgba(0,0,0,0.35)]">
      <p className="font-display text-lg text-primary">FunGame</p>
      <div className="mt-6 flex justify-center">
        <div className={`h-16 w-16 rounded-2xl flex items-center justify-center border ${iconClass}`}>
          <Icon className="h-7 w-7" />
        </div>
      </div>
      <h1 className="mt-5 text-2xl font-bold tracking-tight">{title}</h1>
      {children}
      <Disclaimer className="mt-7" />
    </div>
  </div>
);

export function Maintenance() {
  const navigate = useNavigate();
  const { user, config, refreshConfig } = useAuth();

  useEffect(() => {
    const t = setInterval(async () => {
      const cfg = await refreshConfig();
      if (cfg && !cfg.maintenance_mode) {
        navigate(user ? routeForUser(user) : "/welcome", { replace: true });
      }
    }, 15000);
    return () => clearInterval(t);
  }, [refreshConfig, navigate, user]);

  useEffect(() => {
    if (config && !config.maintenance_mode) {
      navigate(user ? routeForUser(user) : "/welcome", { replace: true });
    }
  }, [config, navigate, user]);

  return (
    <Shell icon={Wrench} iconClass="bg-[hsl(var(--magenta)/0.1)] border-[hsl(var(--magenta)/0.3)] text-[hsl(var(--magenta))]" title="Scheduled maintenance" testId="maintenance-screen">
      <p className="mt-2 text-sm text-white/65 leading-relaxed">
        {config?.maintenance_message || "FunGame is under maintenance. Please check back soon."}
      </p>
      <Button
        data-testid="maintenance-retry-button"
        variant="outline"
        onClick={async () => {
          const cfg = await refreshConfig();
          if (cfg && !cfg.maintenance_mode) navigate(user ? routeForUser(user) : "/welcome", { replace: true });
        }}
        className="mt-6 w-full h-11 rounded-xl border-white/15 bg-white/5 hover:bg-white/10"
      >
        <RefreshCw className="h-4 w-4 mr-2" /> Check again
      </Button>
    </Shell>
  );
}

export function Offline() {
  const navigate = useNavigate();
  const { user } = useAuth();
  useEffect(() => {
    const on = () => navigate(user ? routeForUser(user) : "/welcome", { replace: true });
    window.addEventListener("online", on);
    return () => window.removeEventListener("online", on);
  }, [navigate, user]);

  return (
    <Shell icon={WifiOff} iconClass="bg-white/5 border-white/15 text-white/70" title="You are offline" testId="offline-screen">
      <p className="mt-2 text-sm text-white/65">Check your connection. We will reconnect automatically.</p>
      <Button data-testid="offline-retry-button" variant="outline" onClick={() => window.location.reload()} className="mt-6 w-full h-11 rounded-xl border-white/15 bg-white/5 hover:bg-white/10">
        <RefreshCw className="h-4 w-4 mr-2" /> Retry
      </Button>
    </Shell>
  );
}

export function UpdateRequired() {
  const navigate = useNavigate();
  const { user, config, refreshConfig } = useAuth();

  useEffect(() => {
    if (config && compareVersions(APP_VERSION, config.min_client_version) >= 0) {
      navigate(user ? routeForUser(user) : "/welcome", { replace: true });
    }
  }, [config, navigate, user]);

  return (
    <Shell icon={ArrowUpCircle} iconClass="bg-primary/10 border-primary/30 text-primary" title="Update required" testId="update-required-screen">
      <p className="mt-2 text-sm text-white/65 leading-relaxed">
        A newer version of FunGame is required (you have v{APP_VERSION}, minimum is v{config?.min_client_version}). Refresh to get the latest version.
      </p>
      <Button
        data-testid="update-refresh-button"
        onClick={async () => {
          await refreshConfig();
          window.location.reload();
        }}
        className="mt-6 w-full h-11 rounded-xl font-bold"
      >
        <RefreshCw className="h-4 w-4 mr-2" /> Refresh app
      </Button>
    </Shell>
  );
}
