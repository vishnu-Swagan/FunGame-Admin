import { useState } from "react";
import { Search as SearchIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useGames } from "@/lib/useGames";
import { GameCard } from "@/components/GameCard";
import { PageTransition, EmptyState } from "@/components/common";

export default function SearchPage() {
  const { games, favorites, toggleFavorite } = useGames();
  const [q, setQ] = useState("");

  const query = q.trim().toLowerCase();
  const results = query
    ? games.filter((g) => g.name.toLowerCase().includes(query) || g.category.toLowerCase().includes(query) || g.tagline.toLowerCase().includes(query))
    : games;

  return (
    <PageTransition className="space-y-5">
      <h1 className="text-2xl font-bold tracking-tight">Search</h1>
      <div className="relative">
        <SearchIcon className="absolute left-4 top-1/2 -translate-y-1/2 h-4 w-4 text-white/40" />
        <Input
          data-testid="search-input"
          placeholder="Search games, categories…"
          value={q}
          autoFocus
          onChange={(e) => setQ(e.target.value)}
          className="h-12 rounded-xl bg-white/5 border-white/12 pl-11"
          aria-label="Search games"
        />
      </div>
      {results.length === 0 ? (
        <EmptyState icon={SearchIcon} title={`No results for “${q}”`} subtitle="Try a game name like Aviator or a category like Cards." />
      ) : (
        <div data-testid="search-results-grid" className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {results.map((g) => (
            <GameCard key={g.slug} game={g} isFavorite={favorites.includes(g.slug)} onToggleFavorite={toggleFavorite} />
          ))}
        </div>
      )}
    </PageTransition>
  );
}
