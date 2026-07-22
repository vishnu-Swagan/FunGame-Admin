import { useState, useEffect, useRef } from "react";
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

/** Full-bleed cinematic hero — a AAA game-website intro. Rotating featured game
    behind a heavy cinematic grade, parallax tilt, scanlines + sparks, a bold
    game-engine title, dual CTAs and a thumbnail reel to jump between titles. */
function CinematicHero({ games, navigate, userName }) {
  const reduced = useReducedMotion();
  const [idx, setIdx] = useState(0);
  const [tilt, setTilt] = useState({ x: 0, y: 0 });
  const paused = useRef(false);
  useEffect(() => {
    if (reduced || games.length <= 1) return;
    const id = setInterval(() => { if (!paused.current) setIdx((v) => (v + 1) % games.length); }, 5600);
    return () => clearInterval(id);
  }, [reduced, games.length]);
  const g = games.length ? games[idx % games.length] : null;
  const online = usePlayersOnline(g ? g.slug : "lobby");
  if (!g) return null;

  const onMove = (e) => {
    if (reduced) return;
    const r = e.currentTarget.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width - 0.5;
    const py = (e.clientY - r.top) / r.height - 0.5;
    setTilt({ x: -py * 5, y: px * 7 });
  };
  const reset = () => setTilt({ x: 0, y: 0 });
  const pick = (i) => { paused.current = true; setIdx(i); };

  return (
    <div className="-mx-4 -mt-4" data-testid="home-hero">
      <div style={{ perspective: 1200 }} onPointerMove={onMove} onPointerLeave={reset} onPointerCancel={reset}>
        <motion.div
          className="relative overflow-hidden rounded-b-[30px] border-b-2 border-primary/30 shadow-[0_26px_60px_rgba(0,0,0,0.6)]"
          style={{ height: "clamp(384px, 66vh, 540px)", transformStyle: "preserve-3d" }}
          animate={reduced ? {} : { rotateX: tilt.x, rotateY: tilt.y }}
          transition={{ type: "spring", stiffness: 120, damping: 18 }}
        >
          {/* recessed cinematic art with slow ken-burns */}
          <div className="absolute inset-0" style={{ transform: "translateZ(-34px) scale(1.16)" }}>
            <AnimatePresence mode="wait">
              <motion.img
                key={g.slug}
                src={`/game-art/${g.slug}.png`}
                alt=""
                draggable="false"
                initial={{ opacity: 0, scale: reduced ? 1 : 1.12 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: reduced ? 0.2 : 0.9, ease: "easeOut" }}
                className="absolute inset-0 h-full w-full object-cover"
                onError={(e) => { e.currentTarget.style.display = "none"; }}
              />
            </AnimatePresence>
          </div>
          {/* cinematic grade: vertical fade to the page + top spotlight */}
          <div aria-hidden className="absolute inset-0" style={{ background: "linear-gradient(180deg, rgba(6,10,20,0.55) 0%, rgba(6,10,20,0.15) 30%, rgba(6,10,20,0.8) 72%, #060a14 100%)" }} />
          <div aria-hidden className="absolute inset-0" style={{ background: "radial-gradient(95% 62% at 22% 8%, rgba(255,199,64,0.18), transparent 55%)" }} />
          <div aria-hidden className="fg-scanlines absolute inset-0 pointer-events-none opacity-50" />
          {!reduced && <div aria-hidden className="fg-home-sheen-el absolute inset-y-0 -left-1/3 w-1/4 pointer-events-none" style={{ background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.13), transparent)" }} />}
          {!reduced && <HeroSparks />}

          {/* top status bar — brand wordmark + live floor */}
          <div className="fg-safe-top absolute inset-x-0 top-0 px-5 pt-3 flex items-center justify-between" style={{ transform: "translateZ(42px)" }}>
            <span className="font-tech text-base tracking-[0.22em] text-white drop-shadow-[0_1px_6px_rgba(0,0,0,0.8)]">FUN<span className="text-primary">GAME</span></span>
            <span className="flex items-center gap-1.5 rounded-full border border-[hsl(var(--emerald)/0.4)] bg-black/35 px-2.5 py-1 backdrop-blur-sm">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full rounded-full bg-[hsl(var(--emerald))] opacity-70 animate-ping" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[hsl(var(--emerald))]" />
              </span>
              <span className="tabular-nums text-[11px] font-bold text-[hsl(var(--emerald))]">{online.toLocaleString()}</span>
              <span className="font-gaming text-[9px] tracking-wider text-white/55 uppercase">online</span>
            </span>
          </div>

          {/* headline block, lifted toward the viewer */}
          <div className="absolute inset-x-0 bottom-0 p-5 pb-4" style={{ transform: "translateZ(48px)" }}>
            <p className="font-gaming text-[10px] tracking-[0.4em] text-primary uppercase mb-1.5 drop-shadow-[0_1px_4px_rgba(0,0,0,0.8)]">◆ Featured on the floor</p>
            <AnimatePresence mode="wait">
              <motion.h1
                key={g.slug}
                initial={{ opacity: 0, y: reduced ? 0 : 14 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.4, ease: "easeOut" }}
                className="font-tech font-black uppercase text-white leading-[0.92] tracking-tight text-[2.3rem] max-w-[320px]"
                style={{ textShadow: "0 3px 22px rgba(0,0,0,0.75), 0 0 30px rgba(255,199,64,0.18)" }}
              >
                {g.name}
              </motion.h1>
            </AnimatePresence>
            {g.tagline && <p className="mt-2 text-sm text-white/75 max-w-[300px] line-clamp-2 leading-snug">{g.tagline}</p>}

            <div className="mt-3.5 flex items-center gap-2.5">
              <button
                data-testid="home-spotlight-play"
                onClick={() => navigate(`/games/${g.slug}`)}
                className="inline-flex items-center gap-2 rounded-xl bg-primary text-primary-foreground font-gaming font-bold text-sm tracking-wide uppercase px-6 py-3 min-h-[48px] shadow-[0_8px_24px_rgba(255,199,64,0.45)] hover:brightness-110 active:scale-[0.98] transition-[filter,transform] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                <Play className="h-4 w-4 fill-current" /> Play now
              </button>
              <button
                data-testid="home-hero-browse"
                onClick={() => navigate("/games")}
                className="inline-flex items-center gap-1.5 rounded-xl border border-white/25 bg-white/5 backdrop-blur-sm text-white font-gaming font-semibold text-sm tracking-wide uppercase px-4 py-3 min-h-[48px] hover:bg-white/12 active:scale-[0.98] transition-[background-color,transform] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                All games <ChevronRight className="h-4 w-4" />
              </button>
            </div>

            {/* thumbnail reel — jump between featured titles */}
            {games.length > 1 && (
              <div className="fg-rail mt-4 flex gap-2 overflow-x-auto -mx-1 px-1 pb-0.5">
                {games.map((gg, i) => (
                  <button
                    key={gg.slug}
                    data-testid={`home-hero-thumb-${gg.slug}`}
                    onClick={() => pick(i)}
                    aria-label={`Show ${gg.name}`}
                    className={`relative shrink-0 h-12 w-[70px] rounded-lg overflow-hidden border-2 transition-[border-color,transform] duration-150 active:scale-95 ${i === idx ? "border-primary shadow-[0_0_14px_rgba(255,199,64,0.5)]" : "border-white/15 opacity-70 hover:opacity-100"}`}
                  >
                    <img src={`/game-art/${gg.slug}.png`} alt="" draggable="false" className="h-full w-full object-cover" onError={(e) => { e.currentTarget.style.display = "none"; }} />
                    {i !== idx && <span aria-hidden className="absolute inset-0 bg-black/40" />}
                  </button>
                ))}
              </div>
            )}
          </div>
        </motion.div>
      </div>

      {/* compact greeting beneath the splash */}
      <div className="px-4 pt-4">
        <p className="font-gaming text-[10px] tracking-[0.3em] text-white/40 uppercase">Welcome back, player</p>
        <h2 className="text-xl font-bold tracking-tight bg-gradient-to-r from-white via-[#ffe9ad] to-primary bg-clip-text text-transparent">{userName}</h2>
      </div>
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
      {/* Full-bleed cinematic game-website hero */}
      {!loading && featured.length > 0 && (
        <CinematicHero games={featured} navigate={navigate} userName={user?.display_name || "Player"} />
      )}

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
              Trending now
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
