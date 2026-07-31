import { formatChips } from "@/components/common";

/**
 * The parts only some cabinets need: number grids, reel windows, wheels, the
 * hold row, the star strip.
 *
 * Split from `parts.js` so the pieces every screen uses stay together and easy
 * to find. Everything here follows the same rule as the rest of the cabinet —
 * absolute placement in canvas units, drawn rather than fetched.
 */

/* --------------------------------------------------------------- number grid */

/**
 * A grid of numbers you bet on: keno's 80, roulette's 36, the pick-a-digit row.
 *
 * `staked` maps a number to the chips on it, and the cell shows that rather
 * than only a selected state — on these machines a number carries its money,
 * which is what lets a player see a spread across the board at a glance.
 */
export const NumberGrid = ({
  numbers, cols, cell = 58, gap = 6, staked = {}, picked = [], onPick,
  disabled, style, testPrefix = "cab-num",
}) => (
  <div style={{ display: "grid", gridTemplateColumns: `repeat(${cols}, ${cell}px)`, gap, ...style }}>
    {numbers.map((n) => {
      const on = picked.includes(n);
      const money = staked[n];
      return (
        <button key={n} type="button" disabled={disabled} onClick={() => onPick && onPick(n)}
          data-testid={`${testPrefix}-${n}`}
          style={{
            height: cell, width: cell, borderRadius: 6, position: "relative",
            fontFamily: "ui-serif, Georgia, serif", fontWeight: 700,
            fontSize: cell * 0.42, fontVariantNumeric: "tabular-nums",
            color: on ? "#08202f" : "#f2ead4",
            background: on
              ? "linear-gradient(180deg,#9fd8ff,#2f7fb8)"
              : "linear-gradient(180deg, rgba(60,42,14,.85), rgba(28,18,6,.95))",
            border: `2px solid ${on ? "#ffeaa0" : "rgba(217,168,60,.55)"}`,
            boxShadow: on ? "0 0 14px rgba(120,200,255,.6)" : "inset 0 1px 0 rgba(255,235,170,.16)",
            opacity: disabled ? 0.55 : 1,
          }}>
          {n}
          {money > 0 && (
            <span style={{
              position: "absolute", right: -4, bottom: -4, minWidth: 22, height: 22,
              borderRadius: 999, background: "linear-gradient(180deg,#ffe38f,#d9a83c)",
              color: "#0a0913", fontSize: 12, fontWeight: 800, display: "grid",
              placeItems: "center", padding: "0 4px",
            }}>{formatChips(money)}</span>
          )}
        </button>
      );
    })}
  </div>
);

/* --------------------------------------------------------------- reel window */

/* The machines draw fruit and bars; the engines name symbols. Rather than ship
   art for symbols the server may rename, each is a glyph and a colour — which
   reads at reel size and cannot fall out of step with the engine. */
const SYMBOL = {
  cherry: ["🍒", "#c0182b"], lemon: ["🍋", "#d9b81e"], bell: ["🔔", "#d99a1e"],
  star: ["★", "#f0d060"], seven: ["7", "#e02020"], joker: ["🃏", "#8a2fd0"],
  coin: ["◉", "#e0b020"], bar: ["▬", "#3068c0"], gem: ["◆", "#20c0b0"],
  crown: ["♛", "#f0c040"], diamond: ["♦", "#e0e0f0"], scatter: ["✷", "#a020d0"],
  blossom: ["✿", "#e05090"], ingot: ["▰", "#d9a83c"], fish: ["🐟", "#40a0d0"],
  eight: ["8", "#e02020"], dragon: ["🐉", "#c02020"],
  CH: ["🍒", "#c0182b"], BL: ["🔔", "#d99a1e"], BR: ["▬", "#3068c0"],
  SV: ["7", "#e02020"], WD: ["★", "#f0d060"], "--": ["·", "#6a6a7a"],
  plum: ["🍇", "#8a2fd0"], grape: ["🍇", "#8a2fd0"], melon: ["🍉", "#20a050"],
};

export const Reel = ({ symbol, w = 128, h = 116, spinning, style }) => {
  const [glyph, colour] = SYMBOL[symbol] || ["?", "#8a8a9a"];
  return (
    <div style={{
      width: w, height: h, display: "grid", placeItems: "center", borderRadius: 8,
      background: "linear-gradient(180deg,#ffffff,#dfe2ea 55%,#ffffff)",
      border: "2px solid rgba(217,168,60,.7)",
      boxShadow: "inset 0 0 18px rgba(0,0,0,.28)",
      fontSize: h * 0.5, color: colour, lineHeight: 1,
      filter: spinning ? "blur(3px)" : "none", ...style,
    }}>
      {glyph}
    </div>
  );
};

/** A reel grid — 3x3 for Lucky 8, 4-across for Giant Jackpot. */
export const ReelWindow = ({ grid, cellW = 128, cellH = 116, gap = 8, spinning, style, testId = "cab-reels" }) => (
  <div style={{ display: "inline-flex", gap, padding: 10, borderRadius: 12,
                border: "3px solid var(--cab-gold-mid)",
                background: "linear-gradient(180deg, rgba(40,28,8,.9), rgba(16,10,2,.95))", ...style }}
       data-testid={testId}>
    {grid.map((col, ci) => (
      <div key={ci} style={{ display: "flex", flexDirection: "column", gap }}>
        {col.map((sym, ri) => (
          <Reel key={ri} symbol={sym} w={cellW} h={cellH} spinning={spinning} />
        ))}
      </div>
    ))}
  </div>
);

/* --------------------------------------------------------------------- wheel */

/**
 * The segmented wheel the target, checker and golden-wheel cabinets turn.
 *
 * `angle` is driven by the caller so the wheel can come to rest on the server's
 * result rather than spinning to one of its own choosing — the outcome is
 * decided before the animation starts, and the animation has to agree with it.
 */
export const Wheel = ({ labels, size = 300, angle = 0, spinning, style, testId = "cab-wheel" }) => {
  const n = labels.length;
  const step = 360 / n;
  return (
    <div style={{ width: size, height: size, position: "relative", ...style }} data-testid={testId}>
      <div style={{
        position: "absolute", inset: 0, borderRadius: "50%",
        background: "conic-gradient(" + labels.map((_, i) =>
          `${i % 2 ? "#1d4fa8" : "#e08a18"} ${i * step}deg ${(i + 1) * step}deg`).join(",") + ")",
        border: "8px solid var(--cab-gold-mid)",
        boxShadow: "0 0 0 3px rgba(0,0,0,.6), 0 8px 26px rgba(0,0,0,.6)",
        transform: `rotate(${angle}deg)`,
        transition: spinning ? "transform 3.2s cubic-bezier(.17,.67,.2,1)" : "none",
      }}>
        {labels.map((l, i) => (
          <span key={i} style={{
            position: "absolute", left: "50%", top: "50%",
            transform: `rotate(${i * step + step / 2}deg) translateY(-${size * 0.36}px)`,
            transformOrigin: "0 0", color: "#fff", fontWeight: 800,
            fontFamily: "ui-serif, Georgia, serif", fontSize: size * 0.09,
            textShadow: "0 2px 3px rgba(0,0,0,.7)",
          }}>{l}</span>
        ))}
      </div>
      {/* hub */}
      <div style={{
        position: "absolute", left: "50%", top: "50%", width: size * 0.26, height: size * 0.26,
        marginLeft: -size * 0.13, marginTop: -size * 0.13, borderRadius: "50%",
        background: "radial-gradient(circle at 38% 30%, #f7e08a, #7a5411)",
        border: "3px solid rgba(0,0,0,.5)",
      }} />
      {/* the pointer, at the top, where every one of these machines puts it */}
      <div style={{
        position: "absolute", left: "50%", top: -14, marginLeft: -12,
        width: 0, height: 0, borderLeft: "12px solid transparent",
        borderRight: "12px solid transparent", borderTop: "22px solid #e02020",
        filter: "drop-shadow(0 2px 2px rgba(0,0,0,.6))",
      }} />
    </div>
  );
};

/* ------------------------------------------------------------------ hold row */

/** A card that can be held, as the poker cabinets show it. */
export const HoldCard = ({ children, held, onToggle, disabled, w = 140, h = 196, style, testId }) => (
  <div style={{ position: "relative", ...style }} data-testid={testId}>
    {children}
    <button type="button" onClick={onToggle} disabled={disabled}
      style={{
        position: "absolute", left: "50%", top: "50%", transform: "translate(-50%,-50%)",
        width: w * 0.78, height: 34, borderRadius: 5, fontSize: 18, fontWeight: 800,
        letterSpacing: "0.08em", fontFamily: "ui-serif, Georgia, serif",
        color: held ? "#fff" : "transparent",
        background: held ? "linear-gradient(180deg,#b060f0,#7018b8)" : "transparent",
        border: held ? "2px solid #ffeaa0" : "2px solid transparent",
        boxShadow: held ? "0 3px 10px rgba(0,0,0,.6)" : "none",
        opacity: disabled ? 0.5 : 1,
      }}>
      HOLD
    </button>
  </div>
);

/* ---------------------------------------------------------------- star strip */

/** The row of stars these machines light up as a round builds. */
export const StarStrip = ({ count = 11, lit = 0, size = 30, gap = 10, style, testId = "cab-stars" }) => (
  <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap, ...style }} data-testid={testId}>
    {Array.from({ length: count }, (_, i) => (
      <span key={i} style={{
        fontSize: size, lineHeight: 1,
        color: i < lit ? "#ffd54a" : "rgba(255,213,74,.22)",
        textShadow: i < lit ? "0 0 12px rgba(255,200,60,.8)" : "none",
      }}>★</span>
    ))}
  </div>
);

/* --------------------------------------------------------------- last results */

/** The "Last 10 Data" strip the wheel machines carry. */
export const LastResults = ({ values, style, size = 24, testId = "cab-last" }) => (
  <div style={{ display: "flex", alignItems: "center", gap: 10, ...style }} data-testid={testId}>
    {values.map((v, i) => (
      <span key={i} style={{
        fontFamily: "ui-serif, Georgia, serif", fontVariantNumeric: "tabular-nums",
        fontSize: size, color: i === 0 ? "#ff6a6a" : "#f2ead4", fontWeight: 700,
      }}>{v}</span>
    ))}
  </div>
);
