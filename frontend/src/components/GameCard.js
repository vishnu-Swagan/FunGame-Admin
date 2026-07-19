import { useNavigate } from "react-router-dom";
import { Heart } from "lucide-react";
import { GameArt } from "@/components/GameArt";
import { GameStatusBadge } from "@/components/common";

export const GameCard = ({ game, isFavorite, onToggleFavorite, size = "grid" }) => {
  const navigate = useNavigate();
  const wide = size === "rail";

  return (
    <div
      data-testid="game-card"
      role="button"
      tabIndex={0}
      aria-label={`${game.name} — ${game.status.replaceAll("_", " ")}`}
      onClick={() => navigate(`/games/${game.slug}`)}
      onKeyDown={(e) => e.key === "Enter" && navigate(`/games/${game.slug}`)}
      className={`group relative overflow-hidden rounded-2xl bg-card/55 backdrop-blur-md border border-white/10 shadow-[0_10px_30px_rgba(0,0,0,0.35)] cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring transition-[transform,box-shadow] duration-200 hover:-translate-y-0.5 hover:shadow-[0_16px_40px_rgba(0,0,0,0.45)] active:scale-[0.985] ${wide ? "w-[150px] shrink-0" : ""}`}
    >
      <GameArt game={game} className={`${wide ? "h-[110px]" : "h-[120px] sm:h-[140px]"} rounded-t-2xl`} glyphSize={wide ? "text-3xl" : "text-4xl"} />

      <GameStatusBadge status={game.status} pulse={game.status === "COMING_SOON"} className="absolute top-2.5 left-2.5" />

      {onToggleFavorite && (
        <button
          data-testid="game-card-favorite-toggle"
          aria-label={isFavorite ? `Remove ${game.name} from favorites` : `Add ${game.name} to favorites`}
          onClick={(e) => {
            e.stopPropagation();
            onToggleFavorite(game.slug);
          }}
          className="absolute top-2 right-2 h-9 w-9 min-h-[36px] flex items-center justify-center rounded-full bg-black/30 hover:bg-black/45 border border-white/10 transition-[background-color] duration-150"
        >
          <Heart className={`h-4 w-4 ${isFavorite ? "fill-[hsl(var(--magenta))] text-[hsl(var(--magenta))]" : "text-white/80"}`} />
        </button>
      )}

      <div className="p-3">
        <p className="font-display text-[15px] leading-tight text-white">{game.name}</p>
        <p className="text-xs text-white/55 mt-0.5">{game.category}</p>
      </div>
    </div>
  );
};
