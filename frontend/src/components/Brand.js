/* FunGame brand system — a vector logo mark (crisp at any size) paired with the
   FUN (white) · GAME (gold) wordmark. Used everywhere: app header, admin,
   boot splash, game intros. */

export const FunGameLogo = ({ className = "h-7 w-7" }) => (
  <svg viewBox="0 0 48 48" className={className} role="img" aria-label="FunGame logo">
    <defs>
      <linearGradient id="fgLogoGold" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="#fff4cf" />
        <stop offset="0.5" stopColor="#ffca3a" />
        <stop offset="1" stopColor="#a9781a" />
      </linearGradient>
      <radialGradient id="fgLogoGlow" cx="50%" cy="40%" r="62%">
        <stop offset="0" stopColor="rgba(255,199,64,0.55)" />
        <stop offset="1" stopColor="rgba(255,199,64,0)" />
      </radialGradient>
    </defs>
    {/* token badge */}
    <rect x="3" y="3" width="42" height="42" rx="13" fill="#0b1020" stroke="url(#fgLogoGold)" strokeWidth="2.2" />
    <circle cx="24" cy="22" r="16" fill="url(#fgLogoGlow)" />
    {/* faceted diamond mark */}
    <path d="M24 10 L35 21 L24 38 L13 21 Z" fill="url(#fgLogoGold)" stroke="#7a5200" strokeWidth="0.6" />
    <path d="M24 10 L35 21 L24 23.5 Z" fill="#ffffff" opacity="0.42" />
    <path d="M13 21 L24 23.5 L24 38 Z" fill="#000000" opacity="0.16" />
    <path d="M35 21 L24 23.5 L24 38 Z" fill="#000000" opacity="0.08" />
    <circle cx="21.5" cy="18.5" r="1.7" fill="#fff" opacity="0.92" />
  </svg>
);

/** FUN (white) · GAME (gold) wordmark, optionally with the logo mark. */
export const BrandWordmark = ({ logoClassName = "h-7 w-7", textClassName = "text-lg", showLogo = true, className = "" }) => (
  <span className={`inline-flex items-center gap-2 ${className}`}>
    {showLogo && <FunGameLogo className={logoClassName} />}
    <span className={`font-tech font-black tracking-tight leading-none ${textClassName}`}>
      <span className="text-white">FUN</span>
      <span style={{ color: "#ffca3a" }}>GAME</span>
    </span>
  </span>
);
