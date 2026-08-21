import { useRef } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronRight, Play, ArrowUpRight, Spade, Dices, CircleDot, Rocket } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useGames } from "@/lib/useGames";
import { GameCard } from "@/components/GameCard";
import { PageTransition, SectionTitle, EmptyState } from "@/components/common";
import { useAuth } from "@/context/AuthContext";
import { usePlayersOnline } from "@/lib/liveActivity";
import { LiveActivityBar } from "@/components/play/LiveActivityBar";
import { sfx } from "@/lib/sound";
import { GameArt } from "@/components/GameArt";
import { isGameEnabled } from "@/lib/gameAvailability";

const FLOOR_DOORS = [
  { name: "Cards", icon: Spade, copy: "Classic tables" },
  { name: "Crash", icon: Rocket, copy: "Fast rounds" },
  { name: "Dice", icon: Dices, copy: "Instant picks" },
  { name: "Wheel", icon: CircleDot, copy: "Live spins" },
];

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

/** The Home route is the brand stage. Utility chrome is intentionally removed
    above it in AppShell so the first viewport belongs to the royal lockup. */
function RoyalBrandHero({ navigate, userName }) {
  const online = usePlayersOnline("lobby");
  const soundFired = useRef(false);

  const firstTouch = () => { if (soundFired.current) return; soundFired.current = true; sfx.heroRise && sfx.heroRise(); };

  return (
    <section className="-mx-4 md:-mx-6" data-testid="home-hero" onPointerDown={firstTouch} aria-labelledby="royal-floor-welcome">
      <div className="fg-royal-hero-shell rounded-b-[38px] p-[6px] pt-0">
        <div className="fg-royal-hero-core fg-safe-top relative isolate overflow-hidden rounded-b-[32px] px-5 pb-8 pt-6 text-center">
          <div aria-hidden className="fg-royal-orbit" />
          <div aria-hidden className="fg-scanlines absolute inset-0 opacity-[0.12]" />
          <HeroSparks />

          <div className="relative z-[2] flex justify-center">
            <p id="royal-floor-welcome" className="fg-floor-welcome inline-flex items-center gap-2 rounded-full px-5 py-2.5 font-gaming text-xs font-black uppercase tracking-[0.24em] sm:text-sm">
              <span aria-hidden>◆</span> Welcome to the floor <span aria-hidden>◆</span>
            </p>
          </div>

          <img
            src="/chakri-casino-wordmark.png"
            alt="CHAKRI.CASINO — Play in gold"
            className="fg-royal-wordmark relative z-[2] mx-[-9%] mt-4 block h-auto w-[118%] max-w-none select-none"
            draggable="false"
            decoding="async"
          />

          <div className="relative z-[2] -mt-1">
            <p className="font-display text-[1.7rem] leading-none tracking-tight text-[#fff3cb] sm:text-3xl">Royal tables. Real excitement.</p>
            <p className="mx-auto mt-2 max-w-[34rem] text-sm leading-relaxed text-white/52">Your private chip-play casino floor, crafted for rich tables and fast rounds.</p>
          </div>

          <div className="relative z-[2] mt-5 flex flex-col items-center gap-3">
            <button
              data-testid="home-hero-play"
              onClick={() => { sfx.chip && sfx.chip(); navigate("/games"); }}
              className="group inline-flex min-h-[58px] items-center gap-4 rounded-full bg-gradient-to-b from-[#ffe9a3] via-[#e6b94f] to-[#ad6e13] py-1.5 pl-6 pr-1.5 font-gaming text-sm font-black uppercase tracking-[0.12em] text-[#201305] shadow-[0_16px_40px_rgba(173,110,19,0.34),inset_0_1px_0_rgba(255,255,255,0.8)] transition-[transform,filter] duration-700 ease-[cubic-bezier(0.32,0.72,0,1)] hover:-translate-y-0.5 hover:brightness-110 active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              Enter the casino
              <span className="grid h-11 w-11 place-items-center rounded-full bg-[#241706]/12 shadow-[inset_0_1px_0_rgba(255,255,255,0.35)] transition-transform duration-700 ease-[cubic-bezier(0.32,0.72,0,1)] group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:scale-105">
                <Play className="h-4 w-4 fill-current" strokeWidth={1.5} />
              </span>
            </button>
            <button
              data-testid="home-hero-browse"
              onClick={() => navigate("/games")}
              className="border-b border-[#e6b94f]/45 pb-1 font-gaming text-[11px] font-semibold uppercase tracking-[0.2em] text-[#f1d787]/75 transition-[color,transform] duration-700 ease-[cubic-bezier(0.32,0.72,0,1)] hover:-translate-y-px hover:text-[#ffe8a6]"
            >
              View all royal games
            </button>
          </div>

          <div className="relative z-[2] mx-auto mt-6 flex w-fit items-center gap-3 rounded-full bg-black/25 px-4 py-2 text-[10px] uppercase tracking-[0.16em] text-white/46">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[hsl(var(--emerald))] opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-[hsl(var(--emerald))]" />
            </span>
            <strong className="tabular-nums text-white/82">{online.toLocaleString()}</strong> players on the floor
          </div>

          <p className="relative z-[2] mt-4 font-gaming text-[9px] uppercase tracking-[0.18em] text-white/28">Welcome back, {userName}</p>
        </div>
      </div>
    </section>
  );
}

export default function Home() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { games, favorites, recent, loading, toggleFavorite } = useGames();

  const featured = games.filter((g) => g.featured).slice(0, 6);
  const recentGames = recent.map((slug) => games.find((g) => g.slug === slug)).filter(Boolean);
  const favoriteGames = favorites.map((slug) => games.find((g) => g.slug === slug)).filter(Boolean);
  const spotlight = recentGames.find(isGameEnabled) || featured.find(isGameEnabled) || games.find(isGameEnabled);

  return (
    <PageTransition className="space-y-6">
      <RoyalBrandHero navigate={navigate} userName={user?.display_name || "Player"} />

      {/* Live floor ticker */}
      <LiveActivityBar slug="chakri-lobby" />

      {loading ? (
        <div className="grid grid-cols-2 gap-3">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-[190px] rounded-2xl bg-white/5" />
          ))}
        </div>
      ) : (
        <>
          {/* A single personal recommendation gives Home a purpose beyond listing everything. */}
          {spotlight && (
            <section data-testid="home-spotlight">
              <SectionTitle className="mb-3">Your table is ready</SectionTitle>
              <button
                onClick={() => navigate(`/games/${spotlight.slug}`)}
                className="fg-home-spotlight group relative isolate w-full min-h-[224px] overflow-hidden rounded-[26px] text-left focus-visible:ring-2 focus-visible:ring-primary"
                aria-label={`Return to ${spotlight.name}`}
              >
                <GameArt game={spotlight} className="absolute inset-0 h-full w-full rounded-[26px]" glyphSize="text-7xl" />
                <div aria-hidden className="absolute inset-0 bg-gradient-to-r from-[#07080d] via-[#07080de6] to-transparent" />
                <div className="relative z-10 flex min-h-[224px] max-w-[68%] flex-col justify-end p-5">
                  <p className="font-gaming text-[10px] uppercase tracking-[0.28em] text-primary">Picked from your floor</p>
                  <h3 className="mt-1 font-display text-3xl leading-none text-white">{spotlight.name}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-white/62">{spotlight.tagline || `Return to the ${spotlight.category.toLowerCase()} table.`}</p>
                  <span className="mt-4 inline-flex w-fit items-center gap-1.5 border-b border-primary/70 pb-1 font-gaming text-xs font-bold uppercase tracking-wider text-primary">
                    Open table <ArrowUpRight className="h-3.5 w-3.5 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
                  </span>
                </div>
              </button>
            </section>
          )}

          {/* Home is a concierge: four doors, not the complete catalog. */}
          <section data-testid="home-floor-doors">
            <SectionTitle
              action={
                <button onClick={() => navigate("/games")} className="flex items-center text-xs font-semibold text-primary hover:underline focus-visible:ring-2 focus-visible:ring-primary rounded">
                  Enter lobby <ChevronRight className="h-3.5 w-3.5" />
                </button>
              }
            >
              Choose a room
            </SectionTitle>
            <div className="mt-3 grid grid-cols-2 gap-3">
              {FLOOR_DOORS.map(({ name, icon: Icon, copy }, index) => {
                const count = games.filter((game) => game.category === name).length;
                return (
                  <button
                    key={name}
                    onClick={() => navigate(`/games?category=${encodeURIComponent(name)}`)}
                    className="fg-floor-door group relative min-h-[118px] overflow-hidden rounded-[20px] border border-white/10 p-4 text-left transition-[transform,border-color] duration-200 hover:-translate-y-0.5 hover:border-primary/45 active:scale-[0.985]"
                  >
                    <span className="font-gaming text-[10px] uppercase tracking-[0.22em] text-white/42">Room 0{index + 1}</span>
                    <Icon className="absolute right-3 top-3 h-9 w-9 text-primary/55 transition-transform duration-300 group-hover:rotate-6 group-hover:scale-110" strokeWidth={1.4} />
                    <span className="mt-5 block font-display text-xl text-white">{name}</span>
                    <span className="mt-0.5 block text-xs text-white/48">{copy} · {count}</span>
                  </button>
                );
              })}
            </div>
          </section>

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

          {games.length === 0 && <EmptyState title="No games available" subtitle="Check back soon — the lobby is being stocked." />}
        </>
      )}
    </PageTransition>
  );
}
