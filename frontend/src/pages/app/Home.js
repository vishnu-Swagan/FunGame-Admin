import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { ChevronRight, Play, Users } from "lucide-react";
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

/** Drifting gold sparks — the "4DX" ambient layer over the hero. */
const HeroSparks = () => (
  <div aria-hidden="true" className="absolute inset-0 overflow-hidden pointer-events-none" style={{ transform: "translateZ(24px)" }}>
    {[8, 22, 37, 51, 63, 74, 86, 94].map((left, idx) => (
      <span
        key={left}
        className="fg-home-float absolute bottom-2 h-1.5 w-1.5 rounded-full"
        style={{
          left: `${left}%`,
          background: idx % 3 === 0 ? "#fff2c8" : "#ffd447",
          boxShadow: "0 0 6px rgba(255,212,71,0.9)",
          animationDelay: `${(idx % 5) * 0.9}s`,
          animationDuration: `${4 + (idx % 4) * 0.7}s`,
        }}
      />
    ))}
  </div>
);

/** Cinematic 3D marquee — parallax mouse/tilt, layered depth, drifting sparks,
    a sweeping sheen and a pulsing neon frame. The lobby's showpiece. */
function Spotlight({ games, navigate }) {
  const reduced = useReducedMotion();
  const [i, setI] = useState(0);
  const [tilt, setTilt] = useState({ x: 0, y: 0 });
  useEffect(() => {
    if (reduced || games.length <= 1) return;
    const id = setInterval(() => setI((v) => (v + 1) % games.length), 5200);
    return () => clearInterval(id);
  }, [reduced, games.length]);
  const g = games.length ? games[i % games.length] : null;
  const online = usePlayersOnline(g ? g.slug : "lobby");
  if (!g) return null;

  const onMove = (e) => {
    if (reduced) return;
    const r = e.currentTarget.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width - 0.5;
    const py = (e.clientY - r.top) / r.height - 0.5;
    setTilt({ x: -py * 9, y: px * 12 });
  };
  const reset = () => setTilt({ x: 0, y: 0 });

  return (
    <div style={{ perspective: 1100 }} onPointerMove={onMove} onPointerLeave={reset} onPointerCancel={reset} data-testid="home-spotlight">
      <motion.div
        className="fg-home-frame relative overflow-hidden rounded-3xl border border-primary/30 shadow-[0_22px_50px_rgba(0,0,0,0.55)]"
        style={{ height: 244, transformStyle: "preserve-3d" }}
        animate={reduced ? {} : { rotateX: tilt.x, rotateY: tilt.y }}
        transition={{ type: "spring", stiffness: 140, damping: 17 }}
      >
        {/* recessed art layer (parallax depth) with slow ken-burns */}
        <div className="absolute inset-0" style={{ transform: "translateZ(-40px) scale(1.16)" }}>
          <AnimatePresence mode="wait">
            <motion.img
              key={g.slug}
              src={`/game-art/${g.slug}.png`}
              alt=""
              draggable="false"
              initial={{ opacity: 0, scale: reduced ? 1 : 1.1 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: reduced ? 0.2 : 0.8, ease: "easeOut" }}
              className="absolute inset-0 h-full w-full object-cover"
              onError={(e) => { e.currentTarget.style.display = "none"; }}
            />
          </AnimatePresence>
        </div>
        {/* scrim for text contrast */}
        <div aria-hidden="true" className="absolute inset-0" style={{ background: "linear-gradient(90deg, rgba(6,10,20,0.95) 0%, rgba(6,10,20,0.68) 46%, rgba(6,10,20,0.15) 100%)" }} />
        {/* top spotlight glow */}
        <div aria-hidden="true" className="absolute inset-0" style={{ background: "radial-gradient(80% 60% at 18% -10%, rgba(255,199,64,0.22), transparent 60%)" }} />
        {/* sweeping sheen */}
        {!reduced && (
          <div aria-hidden="true" className="absolute inset-y-0 -left-1/3 w-1/4 pointer-events-none fg-home-sheen-el" style={{ background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.16), transparent)" }} />
        )}
        {!reduced && <HeroSparks />}

        {/* foreground content lifted toward the viewer for real 3D pop */}
        <div className="relative z-10 h-full flex flex-col justify-between p-5" style={{ transform: "translateZ(46px)" }}>
          <div className="flex items-center gap-2">
            <span className="text-[10px] tracking-[0.3em] font-extrabold text-primary drop-shadow-[0_1px_4px_rgba(0,0,0,0.7)]">★ SPOTLIGHT</span>
            <span className="flex items-center gap-1.5 rounded-full border border-[hsl(var(--emerald)/0.4)] bg-[hsl(var(--emerald)/0.12)] px-2 py-0.5 backdrop-blur-sm">
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
            <h2 className="font-display text-[2rem] leading-tight bg-gradient-to-br from-white via-[#ffe9ad] to-primary bg-clip-text text-transparent drop-shadow-[0_2px_10px_rgba(0,0,0,0.7)]">{g.name}</h2>
            {g.tagline && <p className="mt-1 text-sm text-white/75 max-w-[250px] line-clamp-2">{g.tagline}</p>}
            <button
              data-testid="home-spotlight-play"
              onClick={() => navigate(`/games/${g.slug}`)}
              className="mt-3 inline-flex items-center gap-1.5 rounded-xl bg-primary text-primary-foreground font-bold text-sm px-5 py-2.5 min-h-[44px] shadow-[0_6px_20px_rgba(255,199,64,0.4)] hover:brightness-110 active:scale-[0.98] transition-[filter,transform] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
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
      </motion.div>
    </div>
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
        <p className="text-xs tracking-[0.2em] text-white/45 font-semibold uppercase">Good to see you</p>
        <h1 className="text-[1.7rem] font-bold tracking-tight bg-gradient-to-r from-white via-[#ffe9ad] to-primary bg-clip-text text-transparent">{user?.display_name || "Player"}</h1>
      </div>

      {/* Cinematic 3D spotlight */}
      {!loading && featured.length > 0 && <Spotlight games={featured} navigate={navigate} />}

      {/* Live floor ticker */}
      <LiveActivityBar slug="fungame-lobby" />

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
