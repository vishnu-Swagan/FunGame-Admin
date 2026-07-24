import { useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useReducedMotion } from "framer-motion";
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

/** Cinematic video hero — a full-width 16:9 banner of the looping casino
    footage (so the whole neon sign stays visible, not cropped), with the
    FUNGAME brand + live count overlaid on top and the headline + CTAs in a
    panel below. Auto-plays muted (autoplay policy); the sound cue fires on
    first tap. Falls back to the poster still for reduced-motion. */
function VideoHero({ navigate, userName }) {
  const reduced = useReducedMotion();
  const online = usePlayersOnline("lobby");
  const soundFired = useRef(false);
  const videoRef = useRef(null);

  useEffect(() => {
    const v = videoRef.current;
    if (v && !reduced) v.play().catch(() => {}); // some browsers need explicit play()
  }, [reduced]);

  const firstTouch = () => { if (soundFired.current) return; soundFired.current = true; sfx.heroRise && sfx.heroRise(); };

  return (
    <div className="-mx-4 -mt-4" data-testid="home-hero" onPointerDown={firstTouch}>
      <div className="relative overflow-hidden rounded-b-[26px] border-b-2 border-primary/25 shadow-[0_22px_54px_rgba(0,0,0,0.55)]">
        {/* full 16:9 video banner — the whole CASINO sign stays visible */}
        <div className="relative w-full bg-[#05070f]" style={{ aspectRatio: "16 / 9" }}>
          {reduced ? (
            <img src="/hero/casino-hero.jpg" alt="Casino" className="absolute inset-0 h-full w-full object-cover" />
          ) : (
            <video ref={videoRef} className="absolute inset-0 h-full w-full object-cover" autoPlay muted loop playsInline preload="auto" poster="/hero/casino-hero.jpg" aria-hidden="true">
              <source src="/hero/casino-hero.mp4" type="video/mp4" />
            </video>
          )}
          {/* light top grade + fade into the panel */}
          <div aria-hidden className="absolute inset-0" style={{ background: "linear-gradient(180deg, rgba(6,8,16,0.5) 0%, transparent 24%, transparent 60%, rgba(5,7,15,0.95) 100%)" }} />
          <div aria-hidden className="fg-scanlines absolute inset-0 pointer-events-none opacity-12" />
          {!reduced && <div aria-hidden className="fg-home-sheen-el absolute inset-y-0 -left-1/3 w-1/4 pointer-events-none" style={{ background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.1), transparent)" }} />}
          {!reduced && <HeroSparks />}
          {/* brand + live floor */}
          <div className="fg-safe-top absolute inset-x-0 top-0 px-4 pt-3 flex items-center justify-between">
            <span className="font-tech font-black tracking-tight text-base drop-shadow-[0_1px_5px_rgba(0,0,0,0.9)]"><span className="text-white">FUN</span><span style={{ color: "#ffd447" }}>GAME</span></span>
            <span className="flex items-center gap-1.5 rounded-full border border-[hsl(var(--emerald)/0.4)] bg-black/45 px-2.5 py-1 backdrop-blur-sm">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full rounded-full bg-[hsl(var(--emerald))] opacity-70 animate-ping" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[hsl(var(--emerald))]" />
              </span>
              <span className="tabular-nums text-[11px] font-bold text-[hsl(var(--emerald))]">{online.toLocaleString()}</span>
              <span className="font-gaming text-[9px] tracking-wider text-white/55 uppercase">online</span>
            </span>
          </div>
        </div>

        {/* headline + CTAs panel */}
        <div className="relative px-5 pt-3 pb-4" style={{ background: "linear-gradient(180deg, #05070f, #0a0e1a)" }}>
          <p className="font-gaming text-[10px] tracking-[0.4em] uppercase mb-1 text-primary">◆ Welcome to the floor</p>
          <h1 className="font-tech font-black uppercase text-white leading-[0.92] tracking-tight text-[2rem]" style={{ textShadow: "0 0 30px rgba(255,199,64,0.25)" }}>
            Real casino <span style={{ color: "#ffd447" }}>real thrill</span>
          </h1>
          <div className="mt-3 flex items-center gap-2.5">
            <button
              data-testid="home-hero-play"
              onClick={() => { sfx.chip && sfx.chip(); navigate("/games"); }}
              className="inline-flex items-center gap-2 rounded-xl bg-primary text-primary-foreground font-gaming font-bold text-sm tracking-wide uppercase px-6 py-3 min-h-[48px] cursor-pointer shadow-[0_8px_24px_rgba(255,199,64,0.4)] hover:brightness-110 active:scale-[0.98] transition-[filter,transform] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              <Play className="h-4 w-4 fill-current" /> Play now
            </button>
            <button
              data-testid="home-hero-browse"
              onClick={() => navigate("/games")}
              className="inline-flex items-center gap-1.5 rounded-xl border border-white/25 bg-white/5 text-white font-gaming font-semibold text-sm tracking-wide uppercase px-4 py-3 min-h-[48px] cursor-pointer hover:bg-white/12 active:scale-[0.98] transition-[background-color,transform] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              All games <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
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
