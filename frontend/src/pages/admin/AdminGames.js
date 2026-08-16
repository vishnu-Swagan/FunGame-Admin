import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { Star } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, errMsg } from "@/lib/api";
import { GameArt } from "@/components/GameArt";
import { PageTransition, GameStatusBadge } from "@/components/common";
import { IS_ADMIN_CONSOLE } from "@/lib/adminConsole";

const STATUSES = ["COMING_SOON", "ENABLED", "DISABLED", "MAINTENANCE", "UPDATE_REQUIRED", "RETIRED"];
// Mirrors the game_parity_state / game_runtime_availability enums. The server
// re-validates both and refuses ENABLED without QA_VERIFIED regardless of this.
const PARITY_STATES = ["BLOCKED", "DERIVED", "QA_VERIFIED"];
const AVAILABILITIES = ["DISABLED", "MAINTENANCE", "ENABLED"];

export default function AdminGames() {
  const [games, setGames] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get("/admin/games");
      setGames(data.games || []);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const update = async (slug, patch) => {
    // optimistic
    setGames((prev) => prev.map((g) => (g.slug === slug ? { ...g, ...patch } : g)));
    try {
      await api.patch(`/admin/games/${slug}`, patch);
      toast.success("Game updated");
    } catch (e) {
      toast.error(errMsg(e));
      load();
    }
  };

  // Promotion is a separate route because it writes the server runtime record
  // rather than the operator-visible catalogue row, and is audited on its own.
  const updateRuntime = async (slug, patch) => {
    // optimistic
    setGames((prev) => prev.map((g) => (g.slug === slug ? { ...g, runtime: { ...g.runtime, ...patch } } : g)));
    try {
      const { data } = await api.patch(`/admin/games/${slug}/runtime`, patch);
      setGames((prev) =>
        prev.map((g) =>
          g.slug === slug
            ? {
                ...g,
                runtime: data.runtime,
                runtime_ready_for_enable: data.runtime_ready_for_enable,
                // A verified runtime is only public while the catalogue row is
                // ENABLED too; this keeps both badges honest without a refetch.
                runtime_available: data.runtime_ready_for_enable && g.status === "ENABLED",
              }
            : g,
        ),
      );
      toast.success("Game runtime updated");
    } catch (e) {
      toast.error(errMsg(e));
      load();
    }
  };

  return (
    <PageTransition className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Games</h1>
        <p className="text-sm text-white/55 mt-1">{games.length} registered · statuses are enforced by the server on every play attempt.</p>
      </div>

      {loading ? (
        <div className="h-40 rounded-2xl fg-shimmer border border-white/5" />
      ) : (
        <div className="rounded-2xl border border-white/10 overflow-x-auto">
          <Table data-testid="admin-games-table">
            <TableHeader>
              <TableRow className="border-white/10 hover:bg-transparent">
                <TableHead className="text-white/50">Game</TableHead>
                <TableHead className="text-white/50">Category</TableHead>
                <TableHead className="text-white/50">Status</TableHead>
                {IS_ADMIN_CONSOLE && <TableHead className="text-white/50">Live runtime</TableHead>}
                {IS_ADMIN_CONSOLE && <TableHead className="text-white/50">Set runtime</TableHead>}
                <TableHead className="text-white/50">Set status</TableHead>
                <TableHead className="text-white/50 text-center">Featured</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {games.map((g) => (
                <TableRow key={g.slug} data-testid="admin-game-row" className="border-white/5 hover:bg-white/5">
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <GameArt game={g} className="h-10 w-14 rounded-lg" glyphSize="text-sm" showGlints={false} />
                      <div>
                        <p className="font-display text-sm">{g.name}</p>
                        {IS_ADMIN_CONSOLE && !g.runtime_ready_for_enable && (
                          <p data-testid="admin-game-runtime-blocked" className="mt-0.5 max-w-[240px] text-[10px] leading-snug text-amber-300/80">
                            {g.runtime?.disabled_reason || "Awaiting server parity verification"}
                          </p>
                        )}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="text-sm text-white/70">{g.category}</TableCell>
                  <TableCell><GameStatusBadge status={g.status} /></TableCell>
                  {IS_ADMIN_CONSOLE && (
                    <TableCell>
                      <span className={`text-[11px] font-semibold ${g.runtime_ready_for_enable ? "text-emerald-300" : "text-amber-300"}`}>
                        {g.runtime_ready_for_enable
                          ? (g.runtime_available ? "Live" : "Verified")
                          : g.runtime?.parity_state || "Not configured"}
                      </span>
                    </TableCell>
                  )}
                  {IS_ADMIN_CONSOLE && (
                    <TableCell>
                      <div className="flex flex-col gap-1.5">
                        <Select value={g.runtime?.parity_state || ""} onValueChange={(v) => updateRuntime(g.slug, { parity_state: v })}>
                          <SelectTrigger data-testid="admin-game-parity-select" className="h-9 w-[170px] rounded-lg bg-white/5 border-white/12 text-xs" disabled={!g.runtime} aria-label={`Parity state for ${g.name}`}>
                            <SelectValue placeholder="No runtime" />
                          </SelectTrigger>
                          <SelectContent>
                            {PARITY_STATES.map((s) => (
                              <SelectItem key={s} value={s} className="text-xs">
                                {s.replaceAll("_", " ")}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Select value={g.runtime?.availability || ""} onValueChange={(v) => updateRuntime(g.slug, { availability: v })}>
                          <SelectTrigger data-testid="admin-game-availability-select" className="h-9 w-[170px] rounded-lg bg-white/5 border-white/12 text-xs" disabled={!g.runtime} aria-label={`Runtime availability for ${g.name}`}>
                            <SelectValue placeholder="No runtime" />
                          </SelectTrigger>
                          <SelectContent>
                            {AVAILABILITIES.map((a) => (
                              <SelectItem
                                key={a}
                                value={a}
                                // The database CHECK forbids this pair, so the
                                // console refuses it rather than sending a
                                // request that can only come back rejected.
                                disabled={a === "ENABLED" && g.runtime?.parity_state !== "QA_VERIFIED"}
                                className="text-xs"
                              >
                                {a === "ENABLED" && g.runtime?.parity_state !== "QA_VERIFIED"
                                  ? "ENABLED (needs QA VERIFIED)"
                                  : a}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </TableCell>
                  )}
                  <TableCell>
                    <Select value={g.status} onValueChange={(v) => update(g.slug, { status: v })}>
                      <SelectTrigger data-testid="admin-game-status-select" className="h-9 w-[170px] rounded-lg bg-white/5 border-white/12 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {STATUSES.map((s) => (
                          <SelectItem
                            key={s}
                            value={s}
                            // Preserve a previously misconfigured ENABLED
                            // value long enough for an operator to change it
                            // back, while preventing a blocked cabinet from
                            // being promoted from any other state in the UI.
                            disabled={IS_ADMIN_CONSOLE && s === "ENABLED" && !g.runtime_ready_for_enable && g.status !== "ENABLED"}
                            className="text-xs"
                          >
                            {s === "ENABLED" && IS_ADMIN_CONSOLE && !g.runtime_ready_for_enable
                              ? "ENABLED (runtime blocked)"
                              : s.replaceAll("_", " ")}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell className="text-center">
                    <div className="flex items-center justify-center gap-1.5">
                      <Star className={`h-3.5 w-3.5 ${g.featured ? "text-primary fill-primary" : "text-white/25"}`} />
                      <Switch data-testid="admin-game-featured-switch" checked={!!g.featured} onCheckedChange={(v) => update(g.slug, { featured: v })} aria-label={`Feature ${g.name}`} />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </PageTransition>
  );
}
