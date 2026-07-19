import { useNavigate } from "react-router-dom";
import { Heart, Clock, Gamepad2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useGames } from "@/lib/useGames";
import { GameCard } from "@/components/GameCard";
import { PageTransition, EmptyState } from "@/components/common";

export function Favorites() {
  const navigate = useNavigate();
  const { games, favorites, toggleFavorite } = useGames();
  const favGames = favorites.map((slug) => games.find((g) => g.slug === slug)).filter(Boolean);

  return (
    <PageTransition className="space-y-5">
      <h1 className="text-2xl font-bold tracking-tight">Favorites</h1>
      {favGames.length === 0 ? (
        <EmptyState
          icon={Heart}
          title="No favorites yet"
          subtitle="Tap the heart on any game card to save it here."
          action={
            <Button data-testid="favorites-browse-button" size="sm" onClick={() => navigate("/games")} className="rounded-xl font-bold mt-1">
              <Gamepad2 className="h-4 w-4 mr-1.5" /> Browse games
            </Button>
          }
        />
      ) : (
        <div data-testid="favorites-grid" className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {favGames.map((g) => (
            <GameCard key={g.slug} game={g} isFavorite onToggleFavorite={toggleFavorite} />
          ))}
        </div>
      )}
    </PageTransition>
  );
}

export function Recent() {
  const navigate = useNavigate();
  const { games, favorites, recent, toggleFavorite } = useGames();
  const recentGames = recent.map((slug) => games.find((g) => g.slug === slug)).filter(Boolean);

  return (
    <PageTransition className="space-y-5">
      <h1 className="text-2xl font-bold tracking-tight">Recently viewed</h1>
      {recentGames.length === 0 ? (
        <EmptyState
          icon={Clock}
          title="Nothing here yet"
          subtitle="Games you open will appear here for quick access."
          action={
            <Button data-testid="recent-browse-button" size="sm" onClick={() => navigate("/games")} className="rounded-xl font-bold mt-1">
              <Gamepad2 className="h-4 w-4 mr-1.5" /> Browse games
            </Button>
          }
        />
      ) : (
        <div data-testid="recent-grid" className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {recentGames.map((g) => (
            <GameCard key={g.slug} game={g} isFavorite={favorites.includes(g.slug)} onToggleFavorite={toggleFavorite} />
          ))}
        </div>
      )}
    </PageTransition>
  );
}
