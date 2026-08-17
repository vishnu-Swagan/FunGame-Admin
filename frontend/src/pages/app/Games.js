import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Skeleton } from "@/components/ui/skeleton";
import { useGames } from "@/lib/useGames";
import { GameCard } from "@/components/GameCard";
import { PageTransition, EmptyState } from "@/components/common";
import { Gamepad2, Sparkles } from "lucide-react";

const CATEGORIES = ["All", "Cards", "Slots", "Wheel", "Numbers", "Dice", "Crash", "Board"];

export default function Games() {
  const navigate = useNavigate();
  const { games, favorites, loading, toggleFavorite } = useGames();
  const [cat, setCat] = useState("All");

  const filtered = cat === "All" ? games : games.filter((g) => g.category === cat);

  return (
    <PageTransition className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Game lobby</h1>
        <p className="text-sm text-white/55 mt-1">{games.length} original games — statuses update live from the server.</p>
      </div>

      {/* 3D casino floor entry */}
      <button
        data-testid="floor-banner"
        onClick={() => navigate("/floor")}
        className="relative w-full overflow-hidden rounded-2xl border border-amber-300/25 bg-gradient-to-r from-[#1b1020] via-[#241228] to-[#120a18] p-4 text-left hover:border-amber-300/50 transition group"
      >
        <div className="absolute -right-6 -top-8 w-40 h-40 rounded-full bg-amber-400/15 blur-2xl group-hover:bg-amber-400/25 transition" />
        <div className="flex items-center gap-2 text-[10px] font-semibold tracking-[0.3em] text-amber-300">
          <Sparkles className="w-3.5 h-3.5" /> NEW
        </div>
        <div className="text-lg font-black mt-1">Enter the 3D Casino Floor</div>
        <div className="text-xs text-white/55 mt-0.5">Walk a cinematic hall — every game is a table on the floor. Headphones on.</div>
      </button>

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
