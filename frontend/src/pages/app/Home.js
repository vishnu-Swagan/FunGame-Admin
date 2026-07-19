import { useNavigate } from "react-router-dom";
import { ChevronRight, Sparkles, Coins, Gamepad2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Carousel, CarouselContent, CarouselItem } from "@/components/ui/carousel";
import { Skeleton } from "@/components/ui/skeleton";
import { useGames } from "@/lib/useGames";
import { GameCard } from "@/components/GameCard";
import { PageTransition, SectionTitle, EmptyState } from "@/components/common";
import { useAuth } from "@/context/AuthContext";

const PROMOS = [
  {
    id: "welcome",
    icon: Sparkles,
    kicker: "THE LOUNGE IS OPEN",
    title: "Welcome to FunGame",
    text: "18 original play-chip games in one glowing midnight lobby.",
    cta: "Explore games",
    to: "/games",
  },
  {
    id: "games",
    icon: Gamepad2,
    kicker: "IN PRODUCTION",
    title: "Aviator, Teen Patti & more",
    text: "Every game unlocks the moment it passes its build gate.",
    cta: "See the lineup",
    to: "/games",
  },
  {
    id: "chips",
    icon: Coins,
    kicker: "PLAY CHIPS — NO CASH VALUE",
    title: "Top up your play chips",
    text: "Request chips and an operator will review it in minutes.",
    cta: "Request chips",
    to: "/chips/request",
  },
];

const CATEGORY_ORDER = ["Cards", "Slots", "Wheel", "Numbers", "Dice", "Crash", "Board"];

const Rail = ({ children }) => (
  <div className="fg-rail flex gap-3 overflow-x-auto -mx-4 px-4 pb-1">{children}</div>
);

export default function Home() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { games, favorites, recent, loading, toggleFavorite } = useGames();

  const featured = games.filter((g) => g.featured);
  const recentGames = recent.map((slug) => games.find((g) => g.slug === slug)).filter(Boolean);
  const favoriteGames = favorites.map((slug) => games.find((g) => g.slug === slug)).filter(Boolean);

  return (
    <PageTransition className="space-y-7">
      {/* Greeting */}
      <div>
        <p className="text-xs text-white/50">Good to see you</p>
        <h1 className="text-2xl font-bold tracking-tight">{user?.display_name || "Player"}</h1>
      </div>

      {/* Hero promo carousel */}
      <Carousel data-testid="home-promo-carousel" opts={{ loop: true }} className="w-full">
        <CarouselContent>
          {PROMOS.map(({ id, icon: Icon, kicker, title, text, cta, to }) => (
            <CarouselItem key={id} data-testid="home-promo-slide">
              <div className="relative overflow-hidden rounded-2xl bg-card/60 backdrop-blur-md border border-white/10 shadow-[0_10px_30px_rgba(0,0,0,0.35)] p-5 fg-aurora">
                <span className="fg-glint absolute top-3 right-6 text-xs text-primary">✦</span>
                <span className="fg-glint absolute top-8 right-12 text-[8px] text-white/70" style={{ animationDelay: "1.4s" }}>✦</span>
                <div className="flex items-center gap-2">
                  <Icon className="h-4 w-4 text-primary" />
                  <p className="text-[10px] tracking-[0.2em] font-bold text-primary">{kicker}</p>
                </div>
                <h2 className="mt-2 font-display text-2xl text-white">{title}</h2>
                <p className="mt-1.5 text-sm text-white/65 max-w-[300px]">{text}</p>
                <Button data-testid="home-promo-cta-button" size="sm" onClick={() => navigate(to)} className="mt-4 rounded-xl font-bold hover:brightness-110 active:scale-[0.98] transition-[filter,transform] duration-150">
                  {cta} <ChevronRight className="h-4 w-4 ml-1" />
                </Button>
              </div>
            </CarouselItem>
          ))}
        </CarouselContent>
      </Carousel>

      {loading ? (
        <div className="grid grid-cols-2 gap-3">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-[190px] rounded-2xl bg-white/5" />
          ))}
        </div>
      ) : (
        <>
          {/* Featured */}
          <section>
            <SectionTitle
              action={
                <button data-testid="home-see-all-games" onClick={() => navigate("/games")} className="text-xs font-semibold text-primary hover:underline flex items-center">
                  All 18 games <ChevronRight className="h-3.5 w-3.5" />
                </button>
              }
            >
              Featured
            </SectionTitle>
            <div className="mt-3">
              <Rail>
                {featured.map((g) => (
                  <GameCard key={g.slug} game={g} size="rail" isFavorite={favorites.includes(g.slug)} onToggleFavorite={toggleFavorite} />
                ))}
              </Rail>
            </div>
          </section>

          {/* Recently played */}
          {recentGames.length > 0 && (
            <section data-testid="home-recent-rail">
              <SectionTitle
                action={
                  <button onClick={() => navigate("/recent")} className="text-xs font-semibold text-primary hover:underline flex items-center">
                    View all <ChevronRight className="h-3.5 w-3.5" />
                  </button>
                }
              >
                Recently viewed
              </SectionTitle>
              <div className="mt-3">
                <Rail>
                  {recentGames.map((g) => (
                    <GameCard key={g.slug} game={g} size="rail" isFavorite={favorites.includes(g.slug)} onToggleFavorite={toggleFavorite} />
                  ))}
                </Rail>
              </div>
            </section>
          )}

          {/* Favorites */}
          {favoriteGames.length > 0 && (
            <section data-testid="home-favorites-rail">
              <SectionTitle
                action={
                  <button onClick={() => navigate("/favorites")} className="text-xs font-semibold text-primary hover:underline flex items-center">
                    View all <ChevronRight className="h-3.5 w-3.5" />
                  </button>
                }
              >
                Your favorites
              </SectionTitle>
              <div className="mt-3">
                <Rail>
                  {favoriteGames.map((g) => (
                    <GameCard key={g.slug} game={g} size="rail" isFavorite onToggleFavorite={toggleFavorite} />
                  ))}
                </Rail>
              </div>
            </section>
          )}

          {/* Category rails */}
          {CATEGORY_ORDER.map((cat) => {
            const inCat = games.filter((g) => g.category === cat);
            if (inCat.length === 0) return null;
            return (
              <section key={cat} data-testid={`home-category-rail-${cat.toLowerCase()}`}>
                <SectionTitle>{cat}</SectionTitle>
                <div className="mt-3">
                  <Rail>
                    {inCat.map((g) => (
                      <GameCard key={g.slug} game={g} size="rail" isFavorite={favorites.includes(g.slug)} onToggleFavorite={toggleFavorite} />
                    ))}
                  </Rail>
                </div>
              </section>
            );
          })}

          {games.length === 0 && <EmptyState title="No games available" subtitle="Check back soon — the lobby is being stocked." />}
        </>
      )}
    </PageTransition>
  );
}
