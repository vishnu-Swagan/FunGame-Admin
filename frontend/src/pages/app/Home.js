import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { ChevronRight, Play, Users, Spade, Cherry, Dices, Hash, CircleDot, TrendingUp, LayoutGrid } from "lucide-react";
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

/* ---- cinematic casino scene — 100% crisp CSS (no raster) ---- */
const RouletteWheel = ({ reduced, size = 186 }) => (
  <div className="relative" style={{ width: size, height: size, filter: "drop-shadow(0 14px 26px rgba(0,0,0,0.6))" }}>
    <div className="absolute inset-0 rounded-full" style={{ background: "conic-gradient(#fff2c0,#c9931a,#fff6d6,#a8760f,#ffe08a,#c9931a,#fff2c0)", boxShadow: "0 0 40px rgba(255,199,64,0.4), inset 0 3px 10px rgba(255,255,255,0.5), inset 0 -6px 14px rgba(0,0,0,0.55)" }} />
    <div className="absolute rounded-full" style={{ inset: "6%", background: "#0a0d16", boxShadow: "inset 0 2px 12px rgba(0,0,0,0.85)" }} />
    <motion.div className="absolute rounded-full overflow-hidden" style={{ inset: "10%" }} animate={reduced ? {} : { rotate: 360 }} transition={{ duration: 26, ease: "linear", repeat: Infinity }}>
      <div className="absolute inset-0 rounded-full" style={{ background: "repeating-conic-gradient(#9c1f1f 0 18deg, #16161c 18deg 36deg)" }} />
      <div className="absolute inset-0 rounded-full" style={{ background: "conic-gradient(#128a3e 0 9deg, transparent 9deg 360deg)" }} />
      <div className="absolute inset-0 rounded-full" style={{ background: "repeating-conic-gradient(rgba(255,212,71,0.5) 0 0.6deg, transparent 0.6deg 18deg)" }} />
      <div className="absolute rounded-full" style={{ inset: "27%", background: "radial-gradient(circle at 40% 32%, #fff2c0, #c9931a 60%, #7a5200)", boxShadow: "0 0 14px rgba(0,0,0,0.5)" }} />
    </motion.div>
    <div className="absolute rounded-full grid place-items-center" style={{ inset: "40%", background: "radial-gradient(circle at 40% 32%, #fff6d6, #c9931a 62%, #6e4a0c)", border: "1.5px solid #fff2c0" }}>
      <span className="rounded-[2px]" style={{ width: 8, height: 8, background: "linear-gradient(135deg,#eaf6ff,#7fb2d8)", transform: "rotate(45deg)", boxShadow: "0 0 8px rgba(180,230,255,0.9)" }} />
    </div>
    <div className="absolute left-1/2 -translate-x-1/2 rounded-full" style={{ top: "8%", width: 7, height: 7, background: "radial-gradient(circle at 35% 30%, #fff, #cfd8e8)", boxShadow: "0 0 9px rgba(255,255,255,0.95)" }} />
  </div>
);
const Chip = ({ c, edge, style }) => (
  <div className="absolute rounded-full" style={{ width: 44, height: 44, background: `radial-gradient(circle at 40% 34%, ${c}, ${edge})`, border: "3px dashed rgba(255,255,255,0.6)", boxShadow: "0 6px 12px rgba(0,0,0,0.5), inset 0 2px 4px rgba(255,255,255,0.35)", ...style }} />
);
const ChipStack = () => (
  <div className="relative" style={{ width: 50, height: 74 }}>
    <Chip c="#1a1a1a" edge="#000" style={{ bottom: 0 }} />
    <Chip c="#c02626" edge="#7f1414" style={{ bottom: 9 }} />
    <Chip c="#2f6fd0" edge="#1a3f80" style={{ bottom: 18 }} />
    <Chip c="#f5b312" edge="#a8760f" style={{ bottom: 27 }} />
  </div>
);
const SceneCard = ({ rank, suit, red, rot, style }) => (
  <div className="absolute rounded-md bg-white flex flex-col justify-between p-1" style={{ width: 40, height: 56, transform: `rotate(${rot}deg)`, boxShadow: "0 6px 14px rgba(0,0,0,0.55)", border: "1px solid #d7dbe6", ...style }}>
    <span className="font-black leading-none" style={{ fontSize: 12, color: red ? "#d4152a" : "#14151c" }}>{rank}</span>
    <span className="self-center leading-none" style={{ fontSize: 18, color: red ? "#d4152a" : "#14151c" }}>{suit}</span>
  </div>
);
function CasinoStage({ accent = "#ffd447", reduced }) {
  return (
    <div className="absolute inset-0 overflow-hidden" style={{ transform: "translateZ(-30px)" }}>
      <div className="absolute inset-0" style={{ background: "radial-gradient(120% 90% at 50% 6%, #17233f 0%, #0b1222 46%, #05070f 100%)" }} />
      <div aria-hidden className="absolute inset-0" style={{ background: `conic-gradient(from 200deg at 50% -12%, transparent, ${accent}22 8%, transparent 17%, transparent 44%, ${accent}1c 52%, transparent 60%)`, opacity: 0.9 }} />
      {[["12%", "24%", 26, 0.45], ["82%", "16%", 34, 0.38], ["66%", "60%", 20, 0.5], ["24%", "70%", 16, 0.45], ["48%", "30%", 44, 0.24]].map(([l, t, s, o], i) => (
        <span key={i} aria-hidden className="absolute rounded-full" style={{ left: l, top: t, width: s, height: s, background: accent, opacity: o, filter: "blur(9px)" }} />
      ))}
      <div aria-hidden className="absolute inset-x-[-10%] bottom-[-30%] h-[70%] rounded-[50%]" style={{ background: "radial-gradient(60% 100% at 50% 0%, #15713e 0%, #0c4a28 55%, transparent 78%)", boxShadow: "inset 0 8px 30px rgba(0,0,0,0.5)" }} />
      <div className="absolute" style={{ right: "5%", top: "15%" }}><RouletteWheel reduced={reduced} size={188} /></div>
      <div className="absolute" style={{ left: "9%", bottom: "22%" }}><ChipStack /></div>
      <div className="absolute" style={{ left: "29%", bottom: "18%" }}>
        <SceneCard rank="A" suit="♠" red={false} rot={-12} />
        <SceneCard rank="K" suit="♥" red rot={7} style={{ left: 22 }} />
      </div>
      <div aria-hidden className="absolute inset-0" style={{ boxShadow: "inset 0 0 120px rgba(0,0,0,0.72)" }} />
    </div>
  );
}

/* category → crisp vector emblem (no raster, no emoji) — used on thumbnail chips */
const CAT_ICON = { Cards: Spade, Slots: Cherry, Dice: Dices, Numbers: Hash, Wheel: CircleDot, Crash: TrendingUp, Board: LayoutGrid };
const artOf = (g) => g?.art || { from: "#1b2140", to: "#3b4a86", accent: "#ffd447" };

/** Full-bleed cinematic hero — a AAA game-website intro rendered 100% in
    vector/CSS/SVG (per-game colour grade, energy aurora, geometric grid,
    glowing emblem) so it stays razor-sharp at every resolution and DPI —
    no raster art, no blur. Parallax tilt, scanlines, sparks, dual CTAs. */
function CinematicHero({ games, navigate, userName }) {
  const reduced = useReducedMotion();
  const [idx, setIdx] = useState(0);
  const [tilt, setTilt] = useState({ x: 0, y: 0 });
  const paused = useRef(false);
  const soundFired = useRef(false);
  useEffect(() => {
    if (reduced || games.length <= 1) return;
    const id = setInterval(() => { if (!paused.current) setIdx((v) => (v + 1) % games.length); }, 5600);
    return () => clearInterval(id);
  }, [reduced, games.length]);
  const g = games.length ? games[idx % games.length] : null;
  const online = usePlayersOnline(g ? g.slug : "lobby");
  if (!g) return null;
  const art = artOf(g);
  const firstTouch = () => { if (soundFired.current) return; soundFired.current = true; sfx.heroRise && sfx.heroRise(); };

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
      <div style={{ perspective: 1200 }} onPointerMove={onMove} onPointerLeave={reset} onPointerCancel={reset} onPointerDown={firstTouch}>
        <motion.div
          className="relative overflow-hidden rounded-b-[30px] border-b-2 shadow-[0_26px_60px_rgba(0,0,0,0.6)]"
          style={{ height: "clamp(384px, 66vh, 540px)", transformStyle: "preserve-3d", borderColor: `${art.accent}44` }}
          animate={reduced ? {} : { rotateX: tilt.x, rotateY: tilt.y }}
          transition={{ type: "spring", stiffness: 120, damping: 18 }}
        >
          {/* ---- cinematic casino stage (crisp CSS scene, tinted per title) ---- */}
          <CasinoStage accent={art.accent} reduced={reduced} />

          {/* crisp SVG geometric grid */}
          <svg aria-hidden className="absolute inset-0 h-full w-full pointer-events-none" style={{ opacity: 0.13 }} preserveAspectRatio="none">
            <defs><pattern id="fg-hero-grid" width="36" height="36" patternUnits="userSpaceOnUse"><path d="M36 0H0V36" fill="none" stroke="#ffffff" strokeWidth="0.6" /></pattern></defs>
            <rect width="100%" height="100%" fill="url(#fg-hero-grid)" />
          </svg>

          {/* grade + scanlines + sheen + sparks */}
          <div aria-hidden className="absolute inset-0" style={{ background: "linear-gradient(180deg, rgba(6,10,20,0.32) 0%, transparent 32%, rgba(6,10,20,0.82) 74%, #060a14 100%)" }} />
          <div aria-hidden className="fg-scanlines absolute inset-0 pointer-events-none opacity-40" />
          {!reduced && <div aria-hidden className="fg-home-sheen-el absolute inset-y-0 -left-1/3 w-1/4 pointer-events-none" style={{ background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.13), transparent)" }} />}
          {!reduced && <HeroSparks />}

          {/* top status bar — live floor */}
          <div className="fg-safe-top absolute inset-x-0 top-0 px-5 pt-3 flex items-center justify-between" style={{ transform: "translateZ(42px)" }}>
            <span className="font-tech font-black tracking-tight text-sm drop-shadow-[0_1px_5px_rgba(0,0,0,0.8)]"><span className="text-white">FUN</span><span style={{ color: "#ffd447" }}>GAME</span></span>
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
            <p className="font-gaming text-[10px] tracking-[0.4em] uppercase mb-1.5 drop-shadow-[0_1px_4px_rgba(0,0,0,0.8)]" style={{ color: art.accent }}>◆ Featured on the floor</p>
            <AnimatePresence mode="wait">
              <motion.h1
                key={g.slug}
                initial={{ opacity: 0, y: reduced ? 0 : 14 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.4, ease: "easeOut" }}
                className="font-tech font-black uppercase text-white leading-[0.92] tracking-tight text-[2.4rem] max-w-[320px]"
                style={{ textShadow: `0 3px 22px rgba(0,0,0,0.8), 0 0 34px ${art.accent}44` }}
              >
                {g.name}
              </motion.h1>
            </AnimatePresence>
            {g.tagline && <p className="mt-2 text-sm text-white/75 max-w-[300px] line-clamp-2 leading-snug">{g.tagline}</p>}

            <div className="mt-3.5 flex items-center gap-2.5">
              <button
                data-testid="home-spotlight-play"
                onClick={() => { sfx.chip && sfx.chip(); navigate(`/games/${g.slug}`); }}
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

            {/* crisp vector thumbnail reel — colour chips + emblem, no raster */}
            {games.length > 1 && (
              <div className="fg-rail mt-4 flex gap-2 overflow-x-auto -mx-1 px-1 pb-0.5">
                {games.map((gg, i) => {
                  const a = artOf(gg);
                  const Ic = CAT_ICON[gg.category] || CircleDot;
                  return (
                    <button
                      key={gg.slug}
                      data-testid={`home-hero-thumb-${gg.slug}`}
                      onClick={() => pick(i)}
                      aria-label={`Show ${gg.name}`}
                      className={`relative shrink-0 h-12 w-[70px] rounded-lg overflow-hidden border-2 grid place-items-center cursor-pointer transition-[border-color,transform,opacity] duration-150 active:scale-95 ${i === idx ? "shadow-[0_0_14px_rgba(255,199,64,0.5)]" : "opacity-60 hover:opacity-100"}`}
                      style={{ background: `linear-gradient(150deg, ${a.from}, ${a.to})`, borderColor: i === idx ? art.accent : "rgba(255,255,255,0.15)" }}
                    >
                      <Ic className="h-5 w-5" style={{ color: "#fff", filter: `drop-shadow(0 0 4px ${a.accent})` }} strokeWidth={1.6} />
                      {i !== idx && <span aria-hidden className="absolute inset-0 bg-black/30" />}
                    </button>
                  );
                })}
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
