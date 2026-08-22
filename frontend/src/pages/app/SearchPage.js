import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Search as SearchIcon, ArrowUpRight, Clock3, Heart, X, Sparkles } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useGames } from "@/lib/useGames";
import { PageTransition, EmptyState } from "@/components/common";
import { GameArt } from "@/components/GameArt";
import { gameStatusLabel, isGameEnabled, isReviewedGame } from "@/lib/gameAvailability";

const RECENT_SEARCHES_KEY = "chakri:recent-searches";
const QUICK_SEARCHES = ["Cards", "Rummy", "Live", "Wheel"];

export default function SearchPage() {
  const { games, favorites, toggleFavorite } = useGames();
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [recentSearches, setRecentSearches] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(RECENT_SEARCHES_KEY) || "[]").slice(0, 5);
    } catch {
      return [];
    }
  });

  const query = q.trim().toLowerCase();
  const results = query
    ? games.filter((g) => {
        const status = isGameEnabled(g) ? "live" : "coming soon";
        return [g.name, g.category, g.tagline, status].some((value) => String(value || "").toLowerCase().includes(query));
      })
    : [];

  const saveSearch = (value) => {
    const clean = value.trim();
    if (!clean) return;
    const next = [clean, ...recentSearches.filter((item) => item.toLowerCase() !== clean.toLowerCase())].slice(0, 5);
    setRecentSearches(next);
    localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(next));
  };

  const runSearch = (value) => {
    setQ(value);
    saveSearch(value);
  };

  const openGame = (game) => {
    saveSearch(q || game.name);
    navigate(`/games/${game.slug}`);
  };

  const clearRecent = () => {
    setRecentSearches([]);
    localStorage.removeItem(RECENT_SEARCHES_KEY);
  };

  return (
    <PageTransition className="space-y-6">
      <header className="pt-2 text-center">
        <span className="mx-auto grid h-12 w-12 place-items-center rounded-2xl border border-primary/25 bg-primary/10 text-primary shadow-[0_0_28px_rgba(255,199,64,0.12)]">
          <Sparkles className="h-5 w-5" />
        </span>
        <p className="mt-4 font-gaming text-[10px] uppercase tracking-[0.32em] text-primary">Find your next table</p>
        <h1 className="mt-1 font-display text-[2.55rem] leading-none tracking-tight text-white">Casino search</h1>
        <p className="mx-auto mt-2 max-w-[340px] text-sm leading-relaxed text-white/52">Search by game, room, or availability. The full catalog stays in Games.</p>
      </header>

      <form
        className="fg-search-command relative rounded-[22px] border border-primary/25 bg-white/[0.045] p-2 shadow-[0_18px_50px_rgba(0,0,0,0.36)]"
        onSubmit={(event) => { event.preventDefault(); saveSearch(q); }}
      >
        <SearchIcon className="absolute left-6 top-1/2 h-5 w-5 -translate-y-1/2 text-primary" />
        <Input
          data-testid="search-input"
          placeholder="Try “Rummy”, “Cards”, or “Live”"
          value={q}
          autoFocus
          onChange={(event) => setQ(event.target.value)}
          className="h-14 rounded-[16px] border-white/8 bg-black/25 pl-12 pr-12 text-base placeholder:text-white/30 focus-visible:ring-primary"
          aria-label="Search games"
        />
        {q && (
          <button type="button" onClick={() => setQ("")} aria-label="Clear search" className="absolute right-5 top-1/2 grid h-9 w-9 -translate-y-1/2 place-items-center rounded-xl text-white/45 hover:bg-white/8 hover:text-white">
            <X className="h-4 w-4" />
          </button>
        )}
      </form>

      {!query ? (
        <div className="space-y-7">
          <section>
            <p className="font-gaming text-[10px] uppercase tracking-[0.24em] text-white/42">Popular paths</p>
            <div className="mt-3 grid grid-cols-2 gap-3">
              {QUICK_SEARCHES.map((item, index) => (
                <button key={item} onClick={() => runSearch(item)} className="group flex min-h-[74px] items-center justify-between rounded-[18px] border border-white/10 bg-white/[0.035] px-4 text-left transition-[border-color,background-color,transform] hover:-translate-y-0.5 hover:border-primary/35 hover:bg-primary/[0.06] active:scale-[0.985]">
                  <span>
                    <span className="block font-display text-lg text-white">{item}</span>
                    <span className="mt-0.5 block text-[10px] uppercase tracking-wider text-white/38">Search 0{index + 1}</span>
                  </span>
                  <ArrowUpRight className="h-4 w-4 text-primary/65 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
                </button>
              ))}
            </div>
          </section>

          {recentSearches.length > 0 && (
            <section data-testid="search-recent">
              <div className="flex items-center justify-between">
                <p className="font-gaming text-[10px] uppercase tracking-[0.24em] text-white/42">Recent searches</p>
                <button onClick={clearRecent} className="text-xs text-white/40 hover:text-primary">Clear</button>
              </div>
              <div className="mt-2 divide-y divide-white/8 border-y border-white/8">
                {recentSearches.map((item) => (
                  <button key={item} onClick={() => runSearch(item)} className="flex min-h-[48px] w-full items-center gap-3 text-left text-sm text-white/68 transition-colors hover:text-white">
                    <Clock3 className="h-4 w-4 text-white/28" />
                    <span className="flex-1">{item}</span>
                    <ArrowUpRight className="h-3.5 w-3.5 text-white/24" />
                  </button>
                ))}
              </div>
            </section>
          )}
        </div>
      ) : results.length === 0 ? (
        <EmptyState icon={SearchIcon} title={`No results for “${q}”`} subtitle="Try a game name like Aviator, a room like Cards, or the word Live." />
      ) : (
        <section data-testid="search-results-grid">
          <div className="mb-3 flex items-end justify-between border-b border-white/10 pb-3">
            <div>
              <p className="font-gaming text-[10px] uppercase tracking-[0.24em] text-primary">Matches</p>
              <h2 className="font-display text-2xl text-white">Results for “{q}”</h2>
            </div>
            <span className="font-tech text-xs tabular-nums text-white/38">{results.length.toString().padStart(2, "0")}</span>
          </div>
          <div className="space-y-2">
            {results.map((game) => {
              const displayStatus = isReviewedGame(game) ? (game.status || "COMING_SOON") : "COMING_SOON";
              return (
                <div key={game.slug} className="fg-search-result group flex items-center gap-3 rounded-[18px] border border-white/8 bg-white/[0.025] p-2.5 transition-[border-color,background-color,transform] hover:-translate-y-px hover:border-primary/30 hover:bg-white/[0.05]">
                  <button onClick={() => openGame(game)} className="flex min-w-0 flex-1 items-center gap-3 text-left focus-visible:ring-2 focus-visible:ring-primary rounded-xl">
                    <GameArt game={game} className="h-[72px] w-[78px] shrink-0 rounded-[14px]" glyphSize="text-2xl" showGlints={false} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-display text-lg text-white">{game.name}</span>
                      <span className="mt-1 flex items-center gap-2 text-xs text-white/45">
                        <span>{game.category}</span>
                        <span aria-hidden>·</span>
                        <span className={isGameEnabled(game) ? "text-[hsl(var(--emerald))]" : "text-primary/65"}>{gameStatusLabel(displayStatus)}</span>
                      </span>
                    </span>
                  </button>
                  {isGameEnabled(game) && (
                    <button
                      aria-label={favorites.includes(game.slug) ? `Remove ${game.name} from favorites` : `Add ${game.name} to favorites`}
                      onClick={() => toggleFavorite(game.slug)}
                      className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-white/8 bg-black/20 transition-colors hover:border-primary/30"
                    >
                      <Heart className={`h-4 w-4 ${favorites.includes(game.slug) ? "fill-primary text-primary" : "text-white/45"}`} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}
    </PageTransition>
  );
}
