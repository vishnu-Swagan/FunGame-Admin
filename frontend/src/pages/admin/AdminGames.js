import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { Star } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, errMsg } from "@/lib/api";
import { GameArt } from "@/components/GameArt";
import { PageTransition, GameStatusBadge } from "@/components/common";

const STATUSES = ["COMING_SOON", "ENABLED", "DISABLED", "MAINTENANCE", "UPDATE_REQUIRED", "RETIRED"];

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
                      <p className="font-display text-sm">{g.name}</p>
                    </div>
                  </TableCell>
                  <TableCell className="text-sm text-white/70">{g.category}</TableCell>
                  <TableCell><GameStatusBadge status={g.status} /></TableCell>
                  <TableCell>
                    <Select value={g.status} onValueChange={(v) => update(g.slug, { status: v })}>
                      <SelectTrigger data-testid="admin-game-status-select" className="h-9 w-[170px] rounded-lg bg-white/5 border-white/12 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {STATUSES.map((s) => (
                          <SelectItem key={s} value={s} className="text-xs">{s.replaceAll("_", " ")}</SelectItem>
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
