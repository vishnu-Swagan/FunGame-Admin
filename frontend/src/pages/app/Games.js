import { useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { useGames } from "@/lib/useGames";
import { GameCard } from "@/components/GameCard";
import { PageTransition, EmptyState } from "@/components/common";
import { Gamepad2 } from "lucide-react";

const CATEGORIES = ["All", "Cards", "Slots", "Wheel", "Numbers", "Dice", "Crash", "Board"];

export default function Games() {
  const { games, favorites, loading, toggleFavorite } = useGames();
  const [cat, setCat] = useState("All");

  const filtered = cat === "All" ? games : games.filter((g) => g.category === cat);

  return (
    <PageTransition className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Game lobby</h1>
        <p className="text-sm text-white/55 mt-1">{games.length} original games — statuses update live from the server.</p>
      </div>

      {/* Category chips */}
      <div className="fg-rail flex gap-2 overflow-x-auto -mx-4 px-4">
        {CATEGORIES.map((c) => (
          <button
            key={c}
            data-testid={`games-category-filter-${c.toLowerCase()}`}
            onClick={() => setCat(c)}
            className={`shrink-0 rounded-full px-4 py-2 min-h-[36px] text-xs font-semibold border transition-[background-color,color] duration-150 ${
              cat === c ? "bg-primary text-primary-foreground border-primary" : "bg-white/5 text-white/70 border-white/10 hover:bg-white/10"
            }`}
          >
            {c}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {[...Array(6)].map((_, i) => (
            <Skeleton key={i} className="h-[190px] rounded-2xl bg-white/5" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState icon={Gamepad2} title="No games in this category" subtitle="Try another category." />
      ) : (
        <div data-testid="games-grid" className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {filtered.map((g) => (
            <GameCard key={g.slug} game={g} isFavorite={favorites.includes(g.slug)} onToggleFavorite={toggleFavorite} />
          ))}
        </div>
      )}
    </PageTransition>
  );
}
