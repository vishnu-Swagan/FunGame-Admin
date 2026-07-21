import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { ChevronRight, Play, Users, Gem } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useGames } from "@/lib/useGames";
import { GameCard } from "@/components/GameCard";
import { PageTransition, SectionTitle, EmptyState } from "@/components/common";
import { useAuth } from "@/context/AuthContext";
import { usePlayersOnline } from "@/lib/liveActivity";
import { LiveActivityBar } from "@/components/play/LiveActivityBar";

const CATEGORY_ORDER = ["Cards", "Slots", "Wheel", "Numbers", "Dice", "Crash", "Board"];

const Rail = ({ children }) => (
  <div className="fg-rail flex gap-3 overflow-x-auto -mx-4 px-4 pb-1">{children}</div>
);

/** Cinematic rotating spotlight for the featured games — the lobby marquee. */
function Spotlight({ games, navigate }) {
  const reduced = useReducedMotion();
  const [i, setI] = useState(0);
  useEffect(() => {
    if (reduced || games.length <= 1) return;
    const id = setInterval(() => setI((v) => (v + 1) % games.length), 5200);
    return () => clearInterval(id);
  }, [reduced, games.length]);
  const g = games.length ? games[i % games.length] : null;
  const online = usePlayersOnline(g ? g.slug : "lobby");
  if (!g) return null;
  return (
    <div
      className="relative overflow-hidden rounded-2xl border-2 border-primary/40 shadow-[0_16px_40px_rgba(0,0,0,0.5)]"
      style={{ height: 208 }}
      data-testid="home-spotlight"
    >
      <AnimatePresence mode="wait">
        <motion.img
          key={g.slug}
          src={`/game-art/${g.slug}.png`}
          alt=""
          draggable="false"
          initial={{ opacity: 0, scale: reduced ? 1 : 1.06 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduced ? 0.2 : 0.7, ease: "easeOut" }}
          className="absolute inset-0 h-full w-full object-cover"
          onError={(e) => { e.currentTarget.style.display = "none"; }}
        />
      </AnimatePresence>
      {/* scrim for text contrast */}
      <div aria-hidden="true" className="absolute inset-0" style={{ background: "linear-gradient(90deg, rgba(6,10,20,0.94) 0%, rgba(6,10,20,0.7) 45%, rgba(6,10,20,0.25) 100%)" }} />
      <div className="fg-accent-line absolute bottom-0 left-0 right-0" aria-hidden="true" />
      <div className="relative z-10 h-full flex flex-col justify-between p-5">
        <div className="flex items-center gap-2">
          <span className="text-[10px] tracking-[0.3em] font-extrabold text-primary">★ SPOTLIGHT</span>
          <span className="flex items-center gap-1.5 rounded-full border border-[hsl(var(--emerald)/0.4)] bg-[hsl(var(--emerald)/0.1)] px-2 py-0.5">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full rounded-full bg-[hsl(var(--emerald))] opacity-70 animate-ping" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[hsl(var(--emerald))]" />
            </span>
            <Users className="h-3 w-3 text-white/55" />
            <span className="tabular-nums text-[10px] font-bold text-[hsl(var(--emerald))]">{online.toLocaleString()}</span>
            <span className="text-[9px] text-white/50">playing</span>
          </span>
        </div>
        <div>
          <h2 className="font-display text-3xl text-white leading-tight drop-shadow-[0_2px_8px_rgba(0,0,0,0.6)]">{g.name}</h2>
          {g.tagline && <p className="mt-1 text-sm text-white/70 max-w-[240px] line-clamp-2">{g.tagline}</p>}
          <button
            data-testid="home-spotlight-play"
            onClick={() => navigate(`/games/${g.slug}`)}
            className="mt-3 inline-flex items-center gap-1.5 rounded-xl bg-primary text-primary-foreground font-bold text-sm px-4 py-2.5 min-h-[44px] hover:brightness-110 active:scale-[0.98] transition-[filter,transform] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <Play className="h-4 w-4 fill-current" /> Play now
          </button>
        </div>
        {/* progress dots */}
        {games.length > 1 && (
          <div className="absolute top-5 right-5 flex gap-1.5">
            {games.map((_, idx) => (
              <span key={idx} className={`h-1.5 rounded-full transition-all duration-300 ${idx === i % games.length ? "w-4 bg-primary" : "w-1.5 bg-white/30"}`} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Growing Giant-Jackpot teaser that deep-links into the game. */
function JackpotTeaser({ navigate }) {
  const [n, setN] = useState(4231900);
  useEffect(() => {
    const id = setInterval(() => setN((v) => v + Math.floor(Math.random() * 45 + 12)), 1200);
    return () => clearInterval(id);
  }, []);
  return (
    <button
      data-testid="home-jackpot-teaser"
      onClick={() => navigate("/games/giant-jackpot")}
      className="w-full flex items-center gap-3 rounded-2xl border-2 border-[#c9a227]/60 p-3.5 min-h-[44px] active:scale-[0.99] transition-transform duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background overflow-hidden relative"
      style={{ background: "linear-gradient(90deg, #2a1330, #17091f)" }}
      aria-label="Play Giant Jackpot"
    >
      <div aria-hidden="true" className="absolute inset-0 pointer-events-none" style={{ background: "radial-gradient(120% 90% at 100% 50%, rgba(255,199,64,0.16), transparent 60%)" }} />
      <div className="h-10 w-10 shrink-0 rounded-xl flex items-center justify-center relative" style={{ background: "radial-gradient(circle at 40% 30%, #ffe08a, #b8860b)" }}>
        <Gem className="h-5 w-5 text-[#3a2a00]" />
      </div>
      <div className="min-w-0 flex-1 text-left relative">
        <p className="text-[9px] font-extrabold tracking-[0.3em] text-[#f0d488]">★ GIANT JACKPOT</p>
        <p className="font-display text-xl fg-neon tabular-nums" style={{ color: "#ffd447" }}>{n.toLocaleString()}</p>
      </div>
      <span className="relative flex items-center gap-1 text-xs font-bold text-primary shrink-0">Play <ChevronRight className="h-4 w-4" /></span>
    </button>
  );
}

export default function Home() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { games, favorites, recent, loading, toggleFavorite } = useGames();

  const featured = games.filter((g) => g.featured);
  const recentGames = recent.map((slug) => games.find((g) => g.slug === slug)).filter(Boolean);
  const favoriteGames = favorites.map((slug) => games.find((g) => g.slug === slug)).filter(Boolean);

  return (
    <PageTransition className="space-y-6">
      {/* Greeting */}
      <div>
        <p className="text-xs text-white/50">Good to see you</p>
        <h1 className="text-2xl font-bold tracking-tight">{user?.display_name || "Player"}</h1>
      </div>

      {/* Cinematic spotlight */}
      {!loading && featured.length > 0 && <Spotlight games={featured} navigate={navigate} />}

      {/* Live floor ticker */}
      <LiveActivityBar slug="fungame-lobby" />

      {/* Giant Jackpot teaser */}
      <JackpotTeaser navigate={navigate} />

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
                <button data-testid="home-see-all-games" onClick={() => navigate("/games")} className="text-xs font-semibold text-primary hover:underline flex items-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded">
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
                  <button onClick={() => navigate("/recent")} className="text-xs font-semibold text-primary hover:underline flex items-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded">
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
                  <button onClick={() => navigate("/favorites")} className="text-xs font-semibold text-primary hover:underline flex items-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded">
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
