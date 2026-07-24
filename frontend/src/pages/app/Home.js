import { useState, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { motion, useReducedMotion } from "framer-motion";
import { ChevronRight, Play } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useGames } from "@/lib/useGames";
import { GameCard } from "@/components/GameCard";
import { PageTransition, SectionTitle, EmptyState } from "@/components/common";
import { useAuth } from "@/context/AuthContext";
import { usePlayersOnline } from "@/lib/liveActivity";
import { LiveActivityBar } from "@/components/play/LiveActivityBar";
import { sfx } from "@/lib/sound";

const CATEGORY_ORDER = ["Cards", "Slots", "Wheel", "Numbers", "Dice", "Crash", "Board"];

const Rail = ({ children }) => (
  <div className="fg-rail flex gap-3 overflow-x-auto -mx-4 px-4 pb-1">{children}</div>
);

/** Drifting gold sparks — the ambient "4DX" layer over the hero. */
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

/** Cinematic video hero — full-bleed looping casino footage with a 4DX layer
    (parallax tilt, gold sparks, sheen), FUNGAME brand, headline + CTAs. Auto
    plays muted (autoplay policy); the cinematic sound cue fires on first tap.
    Falls back to the poster still for reduced-motion. */
function VideoHero({ navigate, userName }) {
  const reduced = useReducedMotion();
  const online = usePlayersOnline("lobby");
  const [tilt, setTilt] = useState({ x: 0, y: 0 });
  const soundFired = useRef(false);
  const videoRef = useRef(null);

  useEffect(() => {
    // some mobile browsers need an explicit play() even with the autoplay attr
    const v = videoRef.current;
    if (v && !reduced) v.play().catch(() => {});
  }, [reduced]);

  const firstTouch = () => { if (soundFired.current) return; soundFired.current = true; sfx.heroRise && sfx.heroRise(); };
  const onMove = (e) => {
    if (reduced) return;
    const r = e.currentTarget.getBoundingClientRect();
    setTilt({ x: -((e.clientY - r.top) / r.height - 0.5) * 4, y: ((e.clientX - r.left) / r.width - 0.5) * 6 });
  };
  const reset = () => setTilt({ x: 0, y: 0 });

  return (
    <div className="-mx-4 -mt-4" data-testid="home-hero">
      <div style={{ perspective: 1200 }} onPointerMove={onMove} onPointerLeave={reset} onPointerCancel={reset} onPointerDown={firstTouch}>
        <motion.div
          className="relative overflow-hidden rounded-b-[30px] border-b-2 border-primary/25 shadow-[0_26px_60px_rgba(0,0,0,0.6)]"
          style={{ height: "clamp(360px, 62vh, 520px)", transformStyle: "preserve-3d" }}
          animate={reduced ? {} : { rotateX: tilt.x, rotateY: tilt.y }}
          transition={{ type: "spring", stiffness: 120, damping: 18 }}
        >
          {/* footage (poster paints instantly; still-only for reduced-motion) */}
          {reduced ? (
            <img src="/hero/casino-hero.jpg" alt="Casino floor" className="absolute inset-0 h-full w-full object-cover" style={{ transform: "translateZ(-30px) scale(1.05)" }} />
          ) : (
            <video
              ref={videoRef}
              className="absolute inset-0 h-full w-full object-cover"
              style={{ transform: "translateZ(-30px) scale(1.06)" }}
              autoPlay muted loop playsInline preload="auto"
              poster="/hero/casino-hero.jpg"
              aria-hidden="true"
            >
              <source src="/hero/casino-hero.mp4" type="video/mp4" />
            </video>
          )}

          {/* cinematic grade + 4DX layers */}
          <div aria-hidden className="absolute inset-0" style={{ background: "linear-gradient(180deg, rgba(6,8,16,0.45) 0%, transparent 30%, rgba(6,8,16,0.55) 60%, rgba(5,7,15,0.95) 100%)" }} />
          <div aria-hidden className="absolute inset-0" style={{ background: "radial-gradient(80% 55% at 26% 14%, rgba(255,199,64,0.14), transparent 60%)" }} />
          <div aria-hidden className="fg-scanlines absolute inset-0 pointer-events-none opacity-15" />
          {!reduced && <div aria-hidden className="fg-home-sheen-el absolute inset-y-0 -left-1/3 w-1/4 pointer-events-none" style={{ background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.1), transparent)" }} />}
          {!reduced && <HeroSparks />}

          {/* top bar — brand + live floor */}
          <div className="fg-safe-top absolute inset-x-0 top-0 px-5 pt-3 flex items-center justify-between" style={{ transform: "translateZ(42px)" }}>
            <span className="font-tech font-black tracking-tight text-base drop-shadow-[0_1px_5px_rgba(0,0,0,0.85)]"><span className="text-white">FUN</span><span style={{ color: "#ffd447" }}>GAME</span></span>
            <span className="flex items-center gap-1.5 rounded-full border border-[hsl(var(--emerald)/0.4)] bg-black/40 px-2.5 py-1 backdrop-blur-sm">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full rounded-full bg-[hsl(var(--emerald))] opacity-70 animate-ping" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[hsl(var(--emerald))]" />
              </span>
              <span className="tabular-nums text-[11px] font-bold text-[hsl(var(--emerald))]">{online.toLocaleString()}</span>
              <span className="font-gaming text-[9px] tracking-wider text-white/55 uppercase">online</span>
            </span>
          </div>

          {/* headline + CTAs */}
          <div className="absolute inset-x-0 bottom-0 p-5 pb-4" style={{ transform: "translateZ(48px)" }}>
            <p className="font-gaming text-[10px] tracking-[0.4em] uppercase mb-1.5 text-primary drop-shadow-[0_1px_4px_rgba(0,0,0,0.85)]">◆ Welcome to the floor</p>
            <h1 className="font-tech font-black uppercase text-white leading-[0.9] tracking-tight text-[2.5rem]" style={{ textShadow: "0 3px 22px rgba(0,0,0,0.85), 0 0 34px rgba(255,199,64,0.3)" }}>
              Real casino<br /><span style={{ color: "#ffd447" }}>real thrill</span>
            </h1>
            <div className="mt-4 flex items-center gap-2.5">
              <button
                data-testid="home-hero-play"
                onClick={() => { sfx.chip && sfx.chip(); navigate("/games"); }}
                className="inline-flex items-center gap-2 rounded-xl bg-primary text-primary-foreground font-gaming font-bold text-sm tracking-wide uppercase px-6 py-3 min-h-[48px] cursor-pointer shadow-[0_8px_24px_rgba(255,199,64,0.45)] hover:brightness-110 active:scale-[0.98] transition-[filter,transform] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                <Play className="h-4 w-4 fill-current" /> Play now
              </button>
              <button
                data-testid="home-hero-browse"
                onClick={() => navigate("/games")}
                className="inline-flex items-center gap-1.5 rounded-xl border border-white/25 bg-white/5 backdrop-blur-sm text-white font-gaming font-semibold text-sm tracking-wide uppercase px-4 py-3 min-h-[48px] cursor-pointer hover:bg-white/12 active:scale-[0.98] transition-[background-color,transform] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                All games <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        </motion.div>
      </div>

      {/* greeting beneath the splash */}
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
      {/* Cinematic video hero */}
      <VideoHero navigate={navigate} userName={user?.display_name || "Player"} />

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
                  All games <ChevronRight className="h-3.5 w-3.5" />
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
