// Shared cinematic slot celebration FX (coin shower + gold burst).
// CSS keyframes live in index.css: fg-coin, fg-win-flash, fg-neon.

const COIN_SEED = Array.from({ length: 26 }, (_, i) => ({
  left: (i * 37) % 100,
  delay: (((i * 53) % 100) / 100) * 0.5,
  dur: 0.9 + ((i * 29) % 60) / 100,
  size: 12 + ((i * 17) % 10),
}));

export const CoinShower = ({ color = "#ffd447", dark = "#b8860b" }) => (
  <div className="pointer-events-none absolute inset-0 overflow-hidden z-30" aria-hidden="true">
    {COIN_SEED.map((c, i) => (
      <span
        key={i}
        className="fg-coin rounded-full"
        style={{
          left: `${c.left}%`,
          top: -20,
          width: c.size,
          height: c.size,
          animationDelay: `${c.delay}s`,
          animationDuration: `${c.dur}s`,
          background: `radial-gradient(circle at 35% 30%, #fff6c8, ${color} 45%, ${dark})`,
          boxShadow: `0 0 6px ${color}cc, inset -1px -2px 2px rgba(0,0,0,0.3)`,
        }}
      />
    ))}
  </div>
);

export const WinBurst = ({ mult, color = "#ffd447", showAt = 12 }) => (
  <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center" aria-hidden="true">
    <div
      className="fg-win-flash absolute h-40 w-40 rounded-full"
      style={{ background: `radial-gradient(circle, ${color}e6, ${color}4d 45%, transparent 70%)` }}
    />
    {mult >= showAt && (
      <p className="relative font-display text-5xl fg-neon" style={{ color }}>
        {mult}x
      </p>
    )}
  </div>
);
