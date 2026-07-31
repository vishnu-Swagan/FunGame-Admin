import { formatChips } from "@/components/common";

/**
 * The cabinet's parts. Every game is assembled from these, which is what makes
 * fifteen screens one look rather than fifteen.
 *
 * They take absolute positions in canvas units, because that is how the
 * reference layouts are composed — a paytable is not "in a column", it is at a
 * point, flanking the cards. `at()` is the only positioning idiom here, and it
 * keeps each game file reading as a description of its own screen.
 */

/** Place a part on the canvas. Coordinates are the design units from Cabinet. */
export const at = (x, y, w, h) => ({
  position: "absolute", left: x, top: y,
  ...(w != null ? { width: w } : null),
  ...(h != null ? { height: h } : null),
});

/** Centre a part horizontally on the canvas at a given y. */
export const atMid = (canvasW, w, y, h) => at((canvasW - w) / 2, y, w, h);

/* -------------------------------------------------------------- ornament */

/**
 * The filigree end-cap that bookends every plaque on these machines.
 *
 * Drawn rather than fetched: fifteen screens carrying a dozen of these each
 * would be a lot of image requests for a shape that is one path, and a path
 * stays crisp when the whole cabinet is scaled up on a tablet.
 */
export const Filigree = ({ size = 26, flip = false, opacity = 0.9 }) => (
  <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true"
       style={{ transform: flip ? "scaleX(-1)" : undefined, opacity, flexShrink: 0 }}>
    <g fill="none" stroke="url(#cabFil)" strokeWidth="2.1" strokeLinecap="round">
      <defs>
        <linearGradient id="cabFil" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffeaa0" />
          <stop offset="0.5" stopColor="#d9a83c" />
          <stop offset="1" stopColor="#7a5411" />
        </linearGradient>
      </defs>
      <path d="M30 16 C24 16 20 12 16 12 C11 12 8 15 8 18 C8 21 11 22 13 20 C15 18 13 16 11 17" />
      <path d="M30 16 C24 16 20 20 16 20 C12 20 10 23 11 26" />
      <circle cx="6" cy="10" r="2.1" />
    </g>
  </svg>
);

/* --------------------------------------------------------------- plaques */

/**
 * A labelled readout — Score, Winner, Bet.
 *
 * The label sits above the field in an italic serif and the value inside it,
 * which is the arrangement on every machine in the reference set and the reason
 * a player can find their balance on a screen they have never seen before.
 */
export const Plaque = ({ label, value, width = 320, height = 46, labelSize = 30, valueSize = 26, style, testId }) => (
  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, ...style }} data-testid={testId}>
    {label && <span className="cab-script" style={{ fontSize: labelSize, lineHeight: 1 }}>{label}</span>}
    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
      <Filigree size={height * 0.62} />
      <div className="cab-plaque cab-gold-face" style={{ width, height }}>
        <div className="cab-plaque-field" style={{ fontSize: valueSize }}>{value}</div>
      </div>
      <Filigree size={height * 0.62} flip />
    </div>
  </div>
);

/** The game's name, in the gold the machines use for it. */
export const TitleBoard = ({ children, size = 54, style }) => (
  <div className="cab-title" style={{ fontSize: size, lineHeight: 1.05, textAlign: "center", ...style }}>
    {children}
  </div>
);

/* -------------------------------------------------------------- paytable */

/**
 * A price list. `rows` is [label, value] pairs and alternate rows take the
 * second colour, matching the machines.
 *
 * Values are multiplied by the staked amount when a bet is on, exactly as the
 * reference does — the whole list rescales the moment a chip is laid, which is
 * the single most useful thing these screens do and the reason the paytable is
 * the biggest element on them.
 */
export const Paytable = ({ rows, multiplier = 1, style, rowSize = 17, testId }) => (
  <div className="cab-paytable" style={{ padding: "12px 16px", borderRadius: 8, ...style }} data-testid={testId}>
    {rows.map(([label, value], i) => (
      <div key={label} className={`cab-paytable-row ${i % 2 ? "cab-row-b" : "cab-row-a"}`}
           style={{ fontSize: rowSize, lineHeight: 1.62 }}>
        <span>{label}</span>
        <span>{formatChips(Math.round(value * multiplier))}</span>
      </div>
    ))}
  </div>
);

/* --------------------------------------------------------------- controls */

/** A cabinet button. `tone` picks the lit states the machines use. */
export const CabButton = ({ children, tone, style, size = 26, ...rest }) => (
  <button
    type="button"
    className={`cab-btn ${tone === "armed" ? "cab-btn-armed" : tone === "hot" ? "cab-btn-hot" : tone === "take" ? "cab-btn-take" : ""}`}
    style={{ fontSize: size, ...style }}
    {...rest}
  >
    {children}
  </button>
);

/** The denomination chips, on their rail. */
export const ChipRail = ({ chips, value, onPick, size = 62, gap = 22, style, testId = "cab-chips" }) => (
  <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap, ...style }} data-testid={testId}>
    {chips.map((c) => (
      <button key={c} type="button" onClick={() => onPick(c)} aria-pressed={value === c}
        data-testid={`cab-chip-${c}`}
        className={`cab-chip ${value === c ? "cab-chip-on" : ""}`}
        style={{ height: size, width: size, fontSize: c >= 1000 ? size * 0.26 : size * 0.32 }}>
        {c >= 1000 ? `${c / 1000}k` : c}
      </button>
    ))}
  </div>
);

/** The betting countdown, in its ring. */
export const Dial = ({ seconds, size = 96, style, testId = "cab-dial" }) => {
  const n = Math.max(0, Math.ceil(seconds || 0));
  return (
    <div className={`cab-dial ${n <= 3 && n > 0 ? "cab-dial-urgent" : ""}`}
         style={{ height: size, width: size, fontSize: size * 0.42, ...style }} data-testid={testId}>
      {String(n).padStart(2, "0")}
    </div>
  );
};

/**
 * The message rail along the bottom edge.
 *
 * Every one of these machines keeps a sentence on screen at all times telling
 * the player what the game is waiting for — "Please Bet to Start Game",
 * "Bet Time Over", "You Lost! Try Again". It is the whole of the game's state
 * communication and it is why they are playable without instructions.
 */
export const Marquee = ({ children, style, size = 22, testId = "cab-marquee" }) => (
  <div className="cab-marquee" style={{ fontSize: size, ...style }} data-testid={testId}>
    {children}
  </div>
);

/* ------------------------------------------------------------------ cards */

const SUIT = { s: ["♠", "#14141c"], c: ["♣", "#14141c"], h: ["♥", "#c01526"], d: ["♦", "#c01526"] };

/** A dealt card, or its back when `card` is missing. */
export const Card = ({ card, w = 78, h = 108, style }) => {
  if (!card) return <div className="cab-cardback" style={{ width: w, height: h, ...style }} />;
  const [glyph, colour] = SUIT[card.suit] || SUIT.s;
  return (
    <div className="cab-card" style={{ width: w, height: h, position: "relative", ...style }}>
      <span style={{ position: "absolute", top: 3, left: 5, fontSize: h * 0.2, color: colour, lineHeight: 1 }}>{card.rank}</span>
      <span style={{ position: "absolute", top: h * 0.2 + 4, left: 5, fontSize: h * 0.16, color: colour, lineHeight: 1 }}>{glyph}</span>
      <span style={{ fontSize: h * 0.34, color: colour }}>{glyph}</span>
      <span style={{ position: "absolute", bottom: 3, right: 5, fontSize: h * 0.2, color: colour, lineHeight: 1, transform: "rotate(180deg)" }}>{card.rank}</span>
    </div>
  );
};
