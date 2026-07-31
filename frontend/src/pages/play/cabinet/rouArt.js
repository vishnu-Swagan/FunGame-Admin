/**
 * Fun Roulette's ornament.
 *
 * The machine's frame is baroque — a wide scrolled crest across the top, gold
 * filigree caps on every plaque, and sparkle stars at their corners. Those are
 * what make the felt read as a cabinet rather than a web page, and they are the
 * whole difference between the reference and a green rectangle with buttons.
 *
 * Drawn as paths so they stay sharp when the cabinet scales up.
 */

const GOLD = (
  <defs>
    <linearGradient id="rouGold" x1="0" y1="0" x2="0.6" y2="1">
      <stop offset="0" stopColor="#fff6d4" />
      <stop offset="0.28" stopColor="#f0d182" />
      <stop offset="0.52" stopColor="#a9781f" />
      <stop offset="0.74" stopColor="#e8c775" />
      <stop offset="1" stopColor="#7a5411" />
    </linearGradient>
    <linearGradient id="rouGoldSoft" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stopColor="#f7e6ae" />
      <stop offset="0.5" stopColor="#c2a054" />
      <stop offset="1" stopColor="#6d4a10" />
    </linearGradient>
  </defs>
);

/**
 * The crest across the top of the table.
 *
 * One half is drawn and mirrored, because the reference's is symmetrical and a
 * hand-drawn second half would only be nearly so.
 */
export const Crest = ({ w = 1600, opacity = 0.9 }) => (
  <svg width={w} height={w * 0.115} viewBox="0 0 1600 184" aria-hidden="true"
       style={{ opacity, display: "block" }}>
    {GOLD}
    {[false, true].map((flip) => (
      <g key={String(flip)} transform={flip ? "translate(1600,0) scale(-1,1)" : undefined}
         fill="none" stroke="url(#rouGold)" strokeLinecap="round">
        {/* the long sweep in from the edge */}
        <path d="M60 26 C210 26 300 60 420 74 C540 88 640 66 706 30" strokeWidth="7" />
        <path d="M78 44 C220 48 310 84 430 98 C548 112 650 92 716 56" strokeWidth="4" />
        {/* the volutes hanging under it */}
        <path d="M250 40 C238 74 254 104 288 108 C316 111 330 92 322 74 C314 57 292 60 292 76" strokeWidth="5" />
        <path d="M430 76 C414 112 432 144 468 146 C496 148 508 128 498 111 C489 95 468 100 470 116" strokeWidth="5" />
        <path d="M140 32 C126 60 138 84 164 86 C186 88 196 72 188 58" strokeWidth="4" />
        {/* the leaves that sit on the sweep */}
        <path d="M330 52 C348 24 396 16 424 34" strokeWidth="4" />
        <path d="M520 78 C544 52 590 48 614 66" strokeWidth="4" />
        <path d="M196 30 C214 8 254 4 274 18" strokeWidth="3.5" />
        {/* buds */}
        <circle cx="60" cy="26" r="6" fill="url(#rouGoldSoft)" stroke="none" />
        <circle cx="288" cy="108" r="5" fill="url(#rouGoldSoft)" stroke="none" />
        <circle cx="468" cy="146" r="5" fill="url(#rouGoldSoft)" stroke="none" />
      </g>
    ))}
  </svg>
);

/**
 * The filigree cap on the end of a plaque. The reference puts one on each side
 * of the clock, the results, the zoom toggle, Take, Bet Ok and the footer.
 */
export const Cap = ({ h = 44, flip = false, opacity = 1 }) => (
  <svg width={h * 1.15} height={h} viewBox="0 0 66 58" aria-hidden="true"
       style={{ transform: flip ? "scaleX(-1)" : undefined, flexShrink: 0, opacity, overflow: "visible" }}>
    {GOLD}
    <g fill="none" stroke="url(#rouGold)" strokeWidth="3.4" strokeLinecap="round">
      <path d="M64 29 C48 29 40 14 26 14 C14 14 8 22 11 31 C14 39 26 40 28 33 C30 27 23 24 20 28" />
      <path d="M64 29 C50 30 42 43 30 47 C20 50 12 46 10 39" />
      <path d="M44 20 C41 9 32 3 22 4" />
      <circle cx="6" cy="12" r="3.6" fill="url(#rouGoldSoft)" stroke="none" />
      <circle cx="8" cy="50" r="2.8" fill="url(#rouGoldSoft)" stroke="none" />
    </g>
  </svg>
);

/** The four-point sparkle the machine scatters at the plaque corners. */
export const Sparkle = ({ size = 26, style }) => (
  <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true" style={{ position: "absolute", ...style }}>
    <defs>
      <radialGradient id="rouSpark" cx="50%" cy="50%" r="50%">
        <stop offset="0" stopColor="#ffffff" stopOpacity="1" />
        <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
      </radialGradient>
    </defs>
    <circle cx="20" cy="20" r="9" fill="url(#rouSpark)" />
    <path d="M20 0 L23 17 L40 20 L23 23 L20 40 L17 23 L0 20 L17 17 Z" fill="#ffffff" opacity="0.95" />
  </svg>
);

/** The gem that sits on the title banner. */
export const Gem = ({ size = 34 }) => (
  <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
    <defs>
      <linearGradient id="rouGem" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="#ffffff" />
        <stop offset="0.4" stopColor="#cfe9ff" />
        <stop offset="1" stopColor="#5a9fd4" />
      </linearGradient>
    </defs>
    <g stroke="#ffffff" strokeWidth="0.8" fill="url(#rouGem)">
      <path d="M20 4 L32 15 L20 36 L8 15 Z" />
      <path d="M8 15 L32 15" fill="none" />
      <path d="M20 4 L20 36" fill="none" opacity="0.6" />
    </g>
  </svg>
);
