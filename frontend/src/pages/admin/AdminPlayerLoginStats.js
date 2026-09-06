import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { api, errMsg } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

function when(value) {
  if (!value) return "Not recorded";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not recorded" : date.toLocaleString();
}

export default function AdminPlayerLoginStats() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState("online");
  const refresh = useRef(() => {});

  useEffect(() => {
    let active = true;
    let inFlight = false;
    const load = async () => {
      if (!active || inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      setLoading(true);
      try {
        const result = await api.get("/admin/player-login-stats", { timeout: 10000, __noFailover: true });
        if (active) {
          setData(result.data);
          setError("");
        }
      } catch (e) {
        if (active) setError(errMsg(e));
      } finally {
        inFlight = false;
        if (active) setLoading(false);
      }
    };
    refresh.current = load;
    load();
    const timer = window.setInterval(load, 10000);
    document.addEventListener("visibilitychange", load);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
    };
  }, []);

  const rows = (view === "online" ? data?.online_players : data?.recent_logins) || [];
  return (
    <section className="crm-panel" aria-label="Live player login stats">
      <header className="crm-panel-header">
        <div>
          <h2>Live login stats</h2>
          <p>Updates every 10 seconds. Online means a signed-in tab was visible in the last {data?.online_window_seconds || 90} seconds.</p>
        </div>
        <Button variant="outline" size="sm" disabled={loading} onClick={() => refresh.current()}>
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Refresh stats
        </Button>
      </header>
      <div className="crm-panel-body space-y-4">
        {error && <p role="alert" className="text-red-400">Could not refresh login stats. {error} {data ? "Showing the last successful update." : ""}</p>}
        {!data ? <p role="status">{loading ? "Loading login stats…" : "Login stats are unavailable. Try Refresh stats."}</p> : <>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3" aria-label="Login totals">
            {[
              ["Online now", data.online_now],
              ["Players logged in · last 24 hours", data.players_logged_in_24h],
              ["Total players", data.total_players],
            ].map(([label, value]) => <div key={label} className="rounded-xl border border-white/10 p-4">
              <p className="text-xs text-white/60">{label}</p>
              <p className="text-2xl font-semibold mt-1">{value}</p>
            </div>)}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="crm-filter-tabs" aria-label="Login stats view">
              <button className={view === "online" ? "active" : ""} aria-pressed={view === "online"} onClick={() => setView("online")}>Online players</button>
              <button className={view === "recent" ? "active" : ""} aria-pressed={view === "recent"} onClick={() => setView("recent")}>Recent logins</button>
            </div>
            <small className="text-white/50">{error ? "Last successful update" : "Updated"}: {when(data.generated_at)}</small>
          </div>
          <p className="text-xs text-white/50">{view === "online" ? `Showing up to ${data.list_limit} online players.` : `Latest login per player, up to ${data.list_limit} players. The 24-hour count is unique players, not login attempts.`}</p>
          {rows.length === 0 ? <p>{view === "online" ? "No players online right now." : "No player logins recorded yet."}</p> : <div className="overflow-x-auto">
            <Table>
              <TableHeader><TableRow><TableHead>Player</TableHead><TableHead>Presence</TableHead><TableHead>Last login</TableHead><TableHead>Last seen</TableHead></TableRow></TableHeader>
              <TableBody>{rows.map((player) => <TableRow key={player.id}>
                <TableCell><strong>{player.display_name || player.username || player.id}</strong><div className="text-xs text-white/50">{player.username ? `@${player.username}` : player.id}</div></TableCell>
                <TableCell><span className={player.online ? "text-emerald-400" : "text-white/50"}>{player.online ? "Online" : "Offline"}</span></TableCell>
                <TableCell>{when(player.last_login_at)}</TableCell>
                <TableCell>{when(player.last_seen_at)}</TableCell>
              </TableRow>)}</TableBody>
            </Table>
          </div>}
        </>}
      </div>
    </section>
  );
}
