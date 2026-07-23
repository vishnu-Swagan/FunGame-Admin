/* Premium Las-Vegas-style slot symbols — glossy, gradient, depth. Shared across
   all slot games so the whole suite reads like a real casino machine.
   <SlotSymbol id="seven" size={40} win /> */

const G = ({ id, stops }) => (
  <radialGradient id={id} cx="38%" cy="30%" r="75%">
    {stops.map(([o, c], i) => <stop key={i} offset={`${o}%`} stopColor={c} />)}
  </radialGradient>
);
const shine = <ellipse cx="36" cy="26" rx="20" ry="9" fill="#fff" opacity="0.35" />;

const SYMBOLS = {
  seven: (
    <>
      <defs><linearGradient id="s7" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#ff6b6b" /><stop offset="45%" stopColor="#e11d1d" /><stop offset="100%" stopColor="#7f1010" /></linearGradient></defs>
      <text x="50" y="70" textAnchor="middle" fontSize="72" fontWeight="900" fontFamily="'Orbitron',sans-serif" fill="url(#s7)" stroke="#ffd447" strokeWidth="2.5" paintOrder="stroke" style={{ filter: "drop-shadow(0 3px 4px rgba(0,0,0,0.5))" }}>7</text>
    </>
  ),
  bar: (
    <>
      <defs><linearGradient id="sbar" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#3a3330" /><stop offset="100%" stopColor="#141010" /></linearGradient></defs>
      <rect x="14" y="34" width="72" height="32" rx="6" fill="url(#sbar)" stroke="#ffd447" strokeWidth="2.5" />
      <text x="50" y="57" textAnchor="middle" fontSize="22" fontWeight="900" fill="#ffd447" letterSpacing="3">BAR</text>
    </>
  ),
  bell: (
    <>
      <defs>{G({ id: "sbell", stops: [[0, "#fff6c8"], [45, "#ffca3a"], [100, "#a9781a"] ] })}</defs>
      <path d="M50 16 C36 16 30 28 30 44 C30 58 22 64 20 70 L80 70 C78 64 70 58 70 44 C70 28 64 16 50 16 Z" fill="url(#sbell)" stroke="#7a5200" strokeWidth="2" />
      <ellipse cx="50" cy="76" rx="9" ry="6" fill="url(#sbell)" stroke="#7a5200" strokeWidth="1.5" />
      <circle cx="50" cy="12" r="5" fill="url(#sbell)" stroke="#7a5200" strokeWidth="1.5" />
      {shine}
    </>
  ),
  cherry: (
    <>
      <defs>{G({ id: "scher", stops: [[0, "#ff8a8a"], [45, "#e0294a"], [100, "#8f1020"] ] })}</defs>
      <path d="M46 20 Q66 22 74 44" fill="none" stroke="#2f7d32" strokeWidth="3.5" strokeLinecap="round" />
      <path d="M46 20 Q40 40 32 60" fill="none" stroke="#2f7d32" strokeWidth="3.5" strokeLinecap="round" />
      <path d="M44 16 Q56 10 66 18 Q54 20 44 24 Z" fill="#3ba03f" />
      <circle cx="32" cy="68" r="17" fill="url(#scher)" stroke="#6a0f1a" strokeWidth="1.5" />
      <circle cx="70" cy="62" r="17" fill="url(#scher)" stroke="#6a0f1a" strokeWidth="1.5" />
      <ellipse cx="27" cy="62" rx="6" ry="3.5" fill="#fff" opacity="0.4" />
    </>
  ),
  lemon: (
    <>
      <defs>{G({ id: "slem", stops: [[0, "#fff6b0"], [50, "#ffd21e"], [100, "#c78a08"] ] })}</defs>
      <ellipse cx="50" cy="50" rx="34" ry="26" fill="url(#slem)" stroke="#9a6c05" strokeWidth="2" transform="rotate(-18 50 50)" />
      <ellipse cx="42" cy="40" rx="14" ry="6" fill="#fff" opacity="0.4" transform="rotate(-18 50 50)" />
    </>
  ),
  plum: (
    <>
      <defs>{G({ id: "splum", stops: [[0, "#d9b3ff"], [45, "#8b3fd0"], [100, "#4a1873"] ] })}</defs>
      <circle cx="50" cy="54" r="30" fill="url(#splum)" stroke="#3a1259" strokeWidth="2" />
      <path d="M50 24 Q56 14 66 16 Q60 24 52 28 Z" fill="#3ba03f" />
      <ellipse cx="42" cy="44" rx="9" ry="5" fill="#fff" opacity="0.35" />
    </>
  ),
  grape: (
    <>
      <defs>{G({ id: "sgr", stops: [[0, "#c9a0ff"], [45, "#7b3fbe"], [100, "#3d1c6e"] ] })}</defs>
      {[[38, 40], [54, 40], [46, 52], [62, 52], [42, 64], [58, 64], [50, 76]].map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r="9" fill="url(#sgr)" stroke="#2f1259" strokeWidth="1" />
      ))}
      <path d="M50 34 Q56 22 68 24" fill="none" stroke="#3ba03f" strokeWidth="3" strokeLinecap="round" />
    </>
  ),
  melon: (
    <>
      <defs>{G({ id: "smel", stops: [[0, "#bff5c0"], [45, "#3fbe5a"], [100, "#1c6e33"] ] })}</defs>
      <circle cx="50" cy="52" r="30" fill="url(#smel)" stroke="#155226" strokeWidth="2" />
      {[20, 35, 50, 65, 80].map((x) => <path key={x} d={`M${x} 26 Q${x + 4} 52 ${x} 78`} fill="none" stroke="#155226" strokeWidth="1.5" opacity="0.5" />)}
      <ellipse cx="42" cy="42" rx="9" ry="5" fill="#fff" opacity="0.35" />
    </>
  ),
  coin: (
    <>
      <defs>{G({ id: "scoin", stops: [[0, "#fff4cf"], [50, "#ffcf3a"], [100, "#a9781a"] ] })}</defs>
      <circle cx="50" cy="50" r="32" fill="url(#scoin)" stroke="#7a5200" strokeWidth="2.5" />
      <circle cx="50" cy="50" r="24" fill="none" stroke="#c48f10" strokeWidth="2" />
      <text x="50" y="60" textAnchor="middle" fontSize="26" fontWeight="900" fill="#8a6a14">$</text>
      {shine}
    </>
  ),
  gem: (
    <>
      <defs><linearGradient id="sgem" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stopColor="#a5f3ff" /><stop offset="50%" stopColor="#22b8d6" /><stop offset="100%" stopColor="#0e5e78" /></linearGradient></defs>
      <path d="M50 18 L78 40 L50 84 L22 40 Z" fill="url(#sgem)" stroke="#0a4256" strokeWidth="2" />
      <path d="M50 18 L78 40 L50 46 Z" fill="#fff" opacity="0.4" />
      <path d="M22 40 L50 46 L50 84 Z" fill="#000" opacity="0.14" />
    </>
  ),
  crown: (
    <>
      <defs>{G({ id: "scrown", stops: [[0, "#fff4cf"], [50, "#ffcf3a"], [100, "#a9781a"] ] })}</defs>
      <path d="M18 66 L24 34 L38 52 L50 28 L62 52 L76 34 L82 66 Z" fill="url(#scrown)" stroke="#7a5200" strokeWidth="2" strokeLinejoin="round" />
      <rect x="18" y="66" width="64" height="10" rx="2" fill="url(#scrown)" stroke="#7a5200" strokeWidth="1.5" />
      <circle cx="50" cy="26" r="4" fill="#e0294a" /><circle cx="24" cy="34" r="3.5" fill="#22b8d6" /><circle cx="76" cy="34" r="3.5" fill="#22b8d6" />
    </>
  ),
  diamond: (
    <>
      <defs><linearGradient id="sdia" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stopColor="#e6ccff" /><stop offset="50%" stopColor="#9d7bff" /><stop offset="100%" stopColor="#4a1f9e" /></linearGradient></defs>
      <path d="M30 30 L70 30 L84 44 L50 86 L16 44 Z" fill="url(#sdia)" stroke="#2e1266" strokeWidth="2" strokeLinejoin="round" />
      <path d="M30 30 L50 44 L70 30 Z" fill="#fff" opacity="0.45" />
      <path d="M16 44 L50 44 L50 86 Z" fill="#000" opacity="0.12" />
    </>
  ),
  star: (
    <>
      <defs>{G({ id: "sstar", stops: [[0, "#fff6c8"], [50, "#ffca3a"], [100, "#b8860b"] ] })}</defs>
      <path d="M50 14 L61 40 L88 42 L67 60 L74 86 L50 71 L26 86 L33 60 L12 42 L39 40 Z" fill="url(#sstar)" stroke="#7a5200" strokeWidth="2" strokeLinejoin="round" />
      <path d="M50 14 L61 40 L50 44 Z" fill="#fff" opacity="0.4" />
    </>
  ),
  scatter: (
    <>
      <defs>{G({ id: "sscat", stops: [[0, "#ffd1ec"], [50, "#ff4f9a"], [100, "#a01055"] ] })}</defs>
      <path d="M50 12 L58 38 L84 34 L64 52 L80 74 L50 62 L20 74 L36 52 L16 34 L42 38 Z" fill="url(#sscat)" stroke="#7a0f43" strokeWidth="2" strokeLinejoin="round" />
      <circle cx="50" cy="50" r="9" fill="#fff" opacity="0.5" />
      <text x="50" y="86" textAnchor="middle" fontSize="12" fontWeight="900" fill="#ff9ac7">SCAT</text>
    </>
  ),
  joker: (
    <>
      <defs>{G({ id: "sjok", stops: [[0, "#f9d976"], [50, "#e0a500"], [100, "#8a5a00"] ] })}</defs>
      <path d="M50 20 C34 20 24 34 24 52 C24 70 36 82 50 82 C64 82 76 70 76 52 C76 34 66 20 50 20 Z" fill="url(#sjok)" stroke="#5c3d00" strokeWidth="2" />
      <path d="M30 26 L24 12 L38 20 Z" fill="#e0294a" /><path d="M70 26 L76 12 L62 20 Z" fill="#7b3fbe" /><path d="M50 16 L50 6" stroke="#5c3d00" strokeWidth="2" />
      <circle cx="24" cy="12" r="3" fill="#ffd447" /><circle cx="76" cy="12" r="3" fill="#ffd447" /><circle cx="50" cy="6" r="3" fill="#ffd447" />
      <ellipse cx="41" cy="48" rx="4" ry="6" fill="#1a1030" /><ellipse cx="59" cy="48" rx="4" ry="6" fill="#1a1030" />
      <path d="M38 64 Q50 74 62 64" fill="none" stroke="#1a1030" strokeWidth="3" strokeLinecap="round" />
    </>
  ),
};

export function SlotSymbol({ id, size = 44, win = false, dim = false }) {
  const inner = SYMBOLS[id];
  if (!inner) return null; // blank / unknown reel position
  return (
    <svg
      width={size} height={size} viewBox="0 0 100 100"
      style={{ opacity: dim ? 0.5 : 1, filter: win ? "drop-shadow(0 0 8px rgba(255,212,71,0.95))" : "drop-shadow(0 2px 3px rgba(0,0,0,0.4))", transition: "filter 200ms" }}
      aria-hidden="true"
    >
      {inner}
    </svg>
  );
}
