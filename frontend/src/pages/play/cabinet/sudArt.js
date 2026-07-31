/**
 * 7Up 7Down's ornament, drawn rather than fetched.
 *
 * The machine's furniture is baroque — scrollwork on every plaque end, a chained
 * border round each panel, a faceted star on the card backs. Shipping those as
 * images would be a dozen requests for shapes that have to stay sharp when the
 * cabinet is scaled up on a tablet, so each is a path.
 */

/** The scroll that bookends the plaques, the card strip and the Take button. */
export const Scroll = ({ w = 46, flip = false, className = "" }) => (
  <svg width={w} height={w * 0.62} viewBox="0 0 92 57" className={className} aria-hidden="true"
       style={{ transform: flip ? "scaleX(-1)" : undefined, flexShrink: 0, overflow: "visible" }}>
    <defs>
      <linearGradient id="sudScrollG" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="#fff3c8" />
        <stop offset="0.35" stopColor="#e8c261" />
        <stop offset="0.62" stopColor="#a9781f" />
        <stop offset="1" stopColor="#ffe9a6" />
      </linearGradient>
    </defs>
    <g fill="none" stroke="url(#sudScrollG)" strokeWidth="3" strokeLinecap="round">
      {/* the long sweep back toward the plaque */}
      <path d="M90 28 C70 28 58 16 44 16 C30 16 22 24 24 33 C26 41 37 42 40 35 C42 30 37 27 33 30" />
      {/* the lower curl */}
      <path d="M90 28 C72 28 62 40 50 44 C40 47 33 44 31 39" />
      {/* the leaf that sits above */}
      <path d="M62 22 C60 12 52 6 43 6 C36 6 32 10 32 14" />
      <circle cx="18" cy="14" r="3.4" />
      <circle cx="26" cy="47" r="2.6" />
    </g>
  </svg>
);

/** The corner flourish either side of the title cartouche. */
export const TitleWing = ({ w = 120, flip = false }) => (
  <svg width={w} height={w * 0.52} viewBox="0 0 120 62" aria-hidden="true"
       style={{ transform: flip ? "scaleX(-1)" : undefined, flexShrink: 0, overflow: "visible" }}>
    <g fill="none" stroke="url(#sudScrollG)" strokeWidth="2.6" strokeLinecap="round">
      <path d="M118 34 C96 34 82 18 62 16 C44 14 30 22 28 34 C26 45 38 50 44 43 C49 37 42 32 37 36" />
      <path d="M118 34 C98 36 86 48 68 52 C52 55 40 51 36 45" />
      <path d="M92 26 C88 12 76 4 62 4 C50 4 43 10 42 17" />
      <path d="M74 18 C70 10 62 8 56 11" />
      <circle cx="20" cy="20" r="4" />
      <circle cx="16" cy="46" r="3" />
      <circle cx="52" cy="4" r="2.6" />
    </g>
  </svg>
);

/* The faceted star the machine prints on the backs. Every position carries the
   same one, which is what makes the row of ten read as a deck. */
/* The faceted star the machine prints on the backs. Every position carries the
   same one, which is what makes the row of ten read as a deck. The facets are
   filled rather than outlined — drawn as strokes they washed out to a faint
   web at the size the positions actually are. */
export const CARD_BACK = encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 168" preserveAspectRatio="none">
  <defs>
    <linearGradient id="a" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#3a3168"/><stop offset="0.5" stop-color="#181240"/>
      <stop offset="1" stop-color="#2e2758"/>
    </linearGradient>
    <linearGradient id="b" x1="0" y1="0" x2="0.6" y2="1">
      <stop offset="0" stop-color="#5b4e26"/><stop offset="0.55" stop-color="#0e0b22"/>
      <stop offset="1" stop-color="#3f3518"/>
    </linearGradient>
    <linearGradient id="c" x1="1" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#4a3f1e"/><stop offset="0.5" stop-color="#0a0818"/>
      <stop offset="1" stop-color="#6a5a2c"/>
    </linearGradient>
  </defs>
  <rect width="120" height="168" rx="7" fill="#0b0820"/>
  <rect x="4" y="4" width="112" height="160" rx="5" fill="url(#a)"/>
  <g stroke="#a98f3c" stroke-width="1.1">
    <path d="M60 10 L110 60 L60 84 L10 60 Z" fill="url(#b)"/>
    <path d="M60 158 L110 108 L60 84 L10 108 Z" fill="url(#c)"/>
    <path d="M60 10 L10 60 L10 20 Z" fill="url(#c)"/>
    <path d="M60 10 L110 60 L110 20 Z" fill="url(#b)"/>
    <path d="M60 158 L10 108 L10 148 Z" fill="url(#b)"/>
    <path d="M60 158 L110 108 L110 148 Z" fill="url(#c)"/>
    <path d="M10 60 L60 84 L10 108 Z" fill="url(#b)"/>
    <path d="M110 60 L60 84 L110 108 Z" fill="url(#c)"/>
  </g>
  <g stroke="#e6c661" stroke-width="1.3" fill="none" opacity="0.9">
    <path d="M60 10 L60 158 M10 84 L110 84"/>
    <path d="M10 20 L110 148 M110 20 L10 148"/>
  </g>
  <circle cx="60" cy="84" r="7" fill="#0a0818" stroke="#e6c661" stroke-width="1.4"/>
  <rect x="2" y="2" width="116" height="164" rx="6" fill="none" stroke="#d9b95a" stroke-width="2.4"/>
</svg>`).replace(/\n\s*/g, "");
