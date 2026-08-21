import { useSearchParams } from "react-router-dom";
import { Skeleton } from "@/components/ui/skeleton";
import { useGames } from "@/lib/useGames";
import { GameCard } from "@/components/GameCard";
import { PageTransition, EmptyState } from "@/components/common";
import { Gamepad2, Radio, Layers3 } from "lucide-react";
import { isGameEnabled } from "@/lib/gameAvailability";

const CATEGORIES = ["All", "Cards", "Slots", "Wheel", "Numbers", "Dice", "Crash", "Board"];

export default function Games() {
  const { games, favorites, loading, toggleFavorite } = useGames();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedCategory = searchParams.get("category");
  const cat = CATEGORIES.includes(requestedCategory) ? requestedCategory : "All";

  const filtered = cat === "All" ? games : games.filter((g) => g.category === cat);
  const liveGames = filtered.filter(isGameEnabled);
  const previewGames = filtered.filter((game) => !isGameEnabled(game));

  const chooseCategory = (category) => {
    if (category === "All") setSearchParams({});
    else setSearchParams({ category });
  };

  return (
    <PageTransition className="space-y-6">
      <header className="fg-games-index relative overflow-hidden rounded-[26px] border border-primary/20 px-5 pb-5 pt-6">
        <p className="font-gaming text-[10px] uppercase tracking-[0.32em] text-primary">The complete collection</p>
        <div className="mt-2 flex items-end justify-between gap-4">
          <div>
            <h1 className="font-display text-[2.45rem] leading-[0.95] tracking-tight text-white">Game index</h1>
            <p className="mt-2 max-w-[310px] text-sm leading-relaxed text-white/55">Browse every table by room. Availability is synced with the casino floor.</p>
          </div>
          <span className="font-tech text-4xl font-black tabular-nums text-primary/90">{games.length.toString().padStart(2, "0")}</span>
        </div>
        <div className="mt-5 grid grid-cols-2 gap-2 border-t border-white/10 pt-4">
          <div className="flex items-center gap-2 text-xs text-white/58"><Radio className="h-4 w-4 text-[hsl(var(--emerald))]" /> <strong className="tabular-nums text-white">{games.filter(isGameEnabled).length}</strong> live now</div>
          <div className="flex items-center gap-2 text-xs text-white/58"><Layers3 className="h-4 w-4 text-primary" /> <strong className="tabular-nums text-white">{CATEGORIES.length - 1}</strong> rooms</div>
        </div>
      </header>

      {/* The catalog owns filters; Home and Search do not repeat this control. */}
      <div className="fg-rail -mx-4 flex gap-2 overflow-x-auto border-y border-white/8 bg-white/[0.025] px-4 py-3">
        {CATEGORIES.map((c) => (
          <button
            key={c}
            data-testid={`games-category-filter-${c.toLowerCase()}`}
            onClick={() => chooseCategory(c)}
            className={`shrink-0 rounded-lg px-4 py-2 min-h-[38px] font-gaming text-[11px] font-semibold uppercase tracking-wider border transition-[background-color,color,transform] duration-150 active:scale-[0.98] ${
              cat === c ? "bg-primary text-primary-foreground border-primary shadow-[0_5px_18px_rgba(255,199,64,0.2)]" : "bg-white/[0.035] text-white/65 border-white/10 hover:bg-white/10"
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
        <div data-testid="games-grid" className="space-y-8">
          {liveGames.length > 0 && (
            <section>
              <div className="mb-3 flex items-end justify-between">
                <div>
                  <p className="font-gaming text-[10px] uppercase tracking-[0.25em] text-[hsl(var(--emerald))]">Accepting players</p>
                  <h2 className="font-display text-2xl text-white">Live tables</h2>
                </div>
                <span className="font-tech text-xs tabular-nums text-white/40">{liveGames.length.toString().padStart(2, "0")}</span>
              </div>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
                {liveGames.map((game) => (
                  <GameCard key={game.slug} game={game} isFavorite={favorites.includes(game.slug)} onToggleFavorite={toggleFavorite} />
                ))}
              </div>
            </section>
          )}

          {previewGames.length > 0 && (
            <section className="border-t border-white/10 pt-6">
              <div className="mb-3 flex items-end justify-between">
                <div>
                  <p className="font-gaming text-[10px] uppercase tracking-[0.25em] text-primary/75">In the vault</p>
                  <h2 className="font-display text-2xl text-white">Coming to the floor</h2>
                </div>
                <span className="font-tech text-xs tabular-nums text-white/40">{previewGames.length.toString().padStart(2, "0")}</span>
              </div>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
                {previewGames.map((game) => (
                  <GameCard key={game.slug} game={game} isFavorite={favorites.includes(game.slug)} onToggleFavorite={toggleFavorite} />
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </PageTransition>
  );
}
