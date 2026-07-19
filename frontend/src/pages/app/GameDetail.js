import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { ArrowLeft, Heart, Play, Info, ListChecks } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api, errMsg } from "@/lib/api";
import { GameArt } from "@/components/GameArt";
import { GameStatusBadge, PageTransition, Disclaimer } from "@/components/common";

export default function GameDetail() {
  const { slug } = useParams();
  const navigate = useNavigate();
  const [game, setGame] = useState(null);
  const [isFav, setIsFav] = useState(false);
  const [loading, setLoading] = useState(true);
  const [playBusy, setPlayBusy] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    api
      .get(`/games/${slug}`)
      .then(({ data }) => {
        if (!active) return;
        setGame(data.game);
        setIsFav(data.is_favorite);
      })
      .catch(() => {
        toast.error("Game not found");
        navigate("/games");
      })
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [slug, navigate]);

  const toggleFav = async () => {
    try {
      const { data } = await api.post(`/games/${slug}/favorite`);
      setIsFav(data.action === "added");
      toast.success(data.action === "added" ? "Added to favorites" : "Removed from favorites");
    } catch (e) {
      toast.error(errMsg(e));
    }
  };

  const tryPlay = async () => {
    setPlayBusy(true);
    try {
      await api.post(`/games/${slug}/play`);
    } catch (e) {
      // Server always refuses at this gate — surface its message
      toast.info(errMsg(e, "This game is not playable yet."));
    } finally {
      setPlayBusy(false);
    }
  };

  if (loading || !game) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-[220px] rounded-2xl bg-white/5" />
        <Skeleton className="h-8 w-1/2 rounded-lg bg-white/5" />
        <Skeleton className="h-24 rounded-2xl bg-white/5" />
      </div>
    );
  }

  return (
    <PageTransition className="space-y-5" data-testid="game-detail-page">
      <button
        data-testid="game-detail-back-button"
        onClick={() => navigate(-1)}
        aria-label="Go back"
        className="h-10 w-10 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full border border-white/10 bg-white/5 hover:bg-white/10 transition-[background-color] duration-150"
      >
        <ArrowLeft className="h-4 w-4 text-white/85" />
      </button>

      {/* Hero art */}
      <div className="relative">
        <GameArt game={game} className="h-[220px] rounded-2xl" glyphSize="text-7xl" />
        <GameStatusBadge status={game.status} pulse={game.status === "COMING_SOON"} className="absolute top-3 left-3" />
        <button
          data-testid="favorite-toggle-button"
          onClick={toggleFav}
          aria-label={isFav ? "Remove from favorites" : "Add to favorites"}
          className="absolute top-3 right-3 h-10 w-10 flex items-center justify-center rounded-full bg-black/35 hover:bg-black/50 border border-white/10 transition-[background-color] duration-150"
        >
          <Heart className={`h-5 w-5 ${isFav ? "fill-[hsl(var(--magenta))] text-[hsl(var(--magenta))]" : "text-white/85"}`} />
        </button>
      </div>

      <div>
        <p className="text-xs font-semibold tracking-[0.18em] text-primary uppercase">{game.category}</p>
        <h1 className="font-display text-4xl text-white mt-1">{game.name}</h1>
        <p className="text-sm text-white/60 mt-1.5">{game.tagline}</p>
      </div>

      <Button
        data-testid="game-detail-play-button"
        onClick={tryPlay}
        disabled={playBusy}
        variant="outline"
        className="w-full h-13 min-h-[52px] rounded-xl text-base font-bold border-[hsl(var(--cyan)/0.4)] bg-[hsl(var(--cyan)/0.08)] text-[hsl(var(--cyan))] hover:bg-[hsl(var(--cyan)/0.14)]"
      >
        <Play className="h-5 w-5 mr-2" />
        {game.status === "COMING_SOON" ? "Coming soon" : game.status === "MAINTENANCE" ? "Under maintenance" : game.status === "ENABLED" ? "Play" : "Unavailable"}
      </Button>

      <div className="rounded-2xl bg-card/55 backdrop-blur-md border border-white/10 p-4">
        <p className="text-sm font-semibold flex items-center gap-2">
          <Info className="h-4 w-4 text-primary" /> About this game
        </p>
        <p className="mt-2 text-sm text-white/70 leading-relaxed">{game.description}</p>
      </div>

      <div className="rounded-2xl bg-card/55 backdrop-blur-md border border-white/10 p-4">
        <p className="text-sm font-semibold flex items-center gap-2">
          <ListChecks className="h-4 w-4 text-primary" /> Rules & paytable
        </p>
        <p className="mt-2 text-sm text-white/55 leading-relaxed">
          Full rules, bet controls and history unlock when {game.name} passes its build gate. Every round outcome is decided by the server — never the client.
        </p>
      </div>

      <Disclaimer />
    </PageTransition>
  );
}
