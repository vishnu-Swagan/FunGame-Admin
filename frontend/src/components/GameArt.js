import { useState } from "react";
import {
  Plane, Dices, Layers, LayoutGrid, Crown, Trophy, Flame, CircleDot, Target, Gem,
  Sparkles, Hash, Infinity as InfinityIcon, Zap, Sun, Boxes, Spade, Club,
} from "lucide-react";

const ICONS = {
  plane: Plane, dices: Dices, layers: Layers, "grid-3x3": LayoutGrid, crown: Crown,
  trophy: Trophy, flame: Flame, "circle-dot": CircleDot, target: Target, gem: Gem,
  sparkles: Sparkles, hash: Hash, infinity: InfinityIcon, zap: Zap, sun: Sun,
  boxes: Boxes, spade: Spade, club: Club,
};

// Unique silhouette language per game (original CSS compositions)
const PATTERNS = {
  aviator: "arcs",
  "seven-up-down": "dots",
  "andar-bahar": "cardfan",
  bingo: "grid",
  checker: "checker",
  "champion-poker": "chevrons",
  "fever-joker-bonus": "stripes",
  "fun-roulette": "wedges",
  "fun-target": "rings",
  "giant-jackpot": "reels",
  "joker-bonus": "diamonds",
  keno: "scatter",
  "lucky-8-line": "lines",
  "no-hold": "streaks",
  "super-golden-wheel": "wheel",
  "triple-fun": "reels",
  poker: "chevrons",
  "teen-patti": "cardfan",
};

function patternStyle(type, accent) {
  const a = accent || "#ffd447";
  switch (type) {
    case "arcs":
      return { backgroundImage: `repeating-radial-gradient(circle at 8% 92%, transparent 0 24px, ${a}26 24px 26px)` };
    case "dots":
      return { backgroundImage: `radial-gradient(${a}33 3px, transparent 4px)`, backgroundSize: "26px 26px" };
    case "grid":
      return { backgroundImage: `radial-gradient(${a}2e 2px, transparent 3px)`, backgroundSize: "18px 18px" };
    case "checker":
      return { backgroundImage: `conic-gradient(${a}1f 90deg, transparent 90deg 180deg, ${a}1f 180deg 270deg, transparent 270deg)`, backgroundSize: "34px 34px" };
    case "chevrons":
      return { backgroundImage: `repeating-linear-gradient(135deg, ${a}1c 0 10px, transparent 10px 26px)` };
    case "stripes":
      return { backgroundImage: `repeating-linear-gradient(115deg, ${a}1f 0 8px, transparent 8px 30px)` };
    case "wedges":
      return { backgroundImage: `repeating-conic-gradient(from 0deg at 85% 85%, ${a}24 0 16deg, transparent 16deg 32deg)` };
    case "rings":
      return { backgroundImage: `repeating-radial-gradient(circle at 80% 75%, ${a}2b 0 2px, transparent 2px 20px)` };
    case "reels":
      return { backgroundImage: `repeating-linear-gradient(90deg, ${a}17 0 20px, transparent 20px 42px)` };
    case "diamonds":
      return { backgroundImage: `repeating-linear-gradient(45deg, ${a}17 0 8px, transparent 8px 24px), repeating-linear-gradient(-45deg, ${a}12 0 8px, transparent 8px 24px)` };
    case "scatter":
      return { backgroundImage: `radial-gradient(${a}30 2.5px, transparent 3.5px), radial-gradient(${a}1e 2px, transparent 3px)`, backgroundSize: "42px 42px, 27px 27px", backgroundPosition: "0 0, 14px 18px" };
    case "lines":
      return { backgroundImage: `repeating-linear-gradient(0deg, ${a}1a 0 3px, transparent 3px 22px)` };
    case "streaks":
      return { backgroundImage: `repeating-linear-gradient(160deg, ${a}20 0 4px, transparent 4px 34px)` };
    case "wheel":
      return { backgroundImage: `repeating-conic-gradient(from 0deg at 50% 115%, ${a}22 0 12deg, transparent 12deg 24deg)` };
    case "cardfan":
    default:
      return {};
  }
}

export const GameArt = ({ game, className = "", glyphSize = "text-5xl", showGlints = true }) => {
  const art = game?.art || {};
  const Icon = ICONS[art.icon] || Sparkles;
  const pattern = PATTERNS[game?.slug] || "dots";
  const isCardFan = pattern === "cardfan";
  const [logoFailed, setLogoFailed] = useState(false);
  const hasLogo = !!game?.slug && !logoFailed;

  return (
    <div
      className={`game-art ${className}`}
      style={{ background: `linear-gradient(155deg, ${art.from || "#101820"}, ${art.to || "#37475a"})` }}
      aria-hidden="true"
    >
      {/* pattern layer */}
      <div className="absolute inset-0" style={patternStyle(pattern, art.accent)} />

      {hasLogo ? (
        /* official game thumbnail logo */
        <img
          src={`/game-art/${game.slug}.png`}
          alt=""
          loading="lazy"
          draggable="false"
          onError={() => setLogoFailed(true)}
          className="absolute inset-0 h-full w-full object-contain p-1.5 drop-shadow-[0_8px_18px_rgba(0,0,0,0.55)] select-none"
        />
      ) : (
        <>
          {/* card fan silhouettes for card games */}
          {isCardFan && (
            <>
              <div className="absolute right-[18%] bottom-[-12%] h-[70%] w-[34%] rounded-xl border border-white/20 bg-white/10" style={{ transform: "rotate(-14deg)" }} />
              <div className="absolute right-[8%] bottom-[-14%] h-[70%] w-[34%] rounded-xl border border-white/25 bg-white/15" style={{ transform: "rotate(-2deg)" }} />
              <div className="absolute right-[-4%] bottom-[-12%] h-[70%] w-[34%] rounded-xl border border-white/20 bg-white/10" style={{ transform: "rotate(10deg)" }} />
            </>
          )}

          {/* icon watermark */}
          <Icon className="absolute -bottom-3 -right-3 h-20 w-20 text-white opacity-[0.13]" strokeWidth={1.4} />

          {/* big glyph */}
          <span
            className={`font-display absolute left-3 bottom-1.5 ${glyphSize} leading-none text-white/90`}
            style={{ textShadow: `0 2px 14px rgba(0,0,0,0.45), 0 0 22px ${art.accent || "#ffd447"}55` }}
          >
            {art.glyph}
          </span>
        </>
      )}

      {/* star glints */}
      {showGlints && (
        <>
          <span className="fg-glint absolute top-[16%] right-[22%] text-[10px]" style={{ color: art.accent || "#ffd447" }}>✦</span>
          <span className="fg-glint absolute top-[34%] right-[10%] text-[7px]" style={{ color: "#ffffffaa", animationDelay: "1.2s" }}>✦</span>
        </>
      )}

      {/* inner highlight edge */}
      <div className="absolute inset-0 rounded-[inherit] shadow-[inset_0_1px_0_rgba(255,255,255,0.14)]" />
    </div>
  );
};
