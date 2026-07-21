import { useState, useEffect, useRef } from "react";

/* Client-side ambient "live floor" activity. Cosmetic only — it never touches
   game outcomes (those are server-side secure RNG). Makes tables feel busy
   even before there's a big real crowd; real events can be merged on top. */

const NAMES = [
  "Rahul", "Priya", "Wei", "Aisha", "Diego", "Sofia", "Kenji", "Fatima", "Liam", "Ananya",
  "Chen", "Zara", "Omar", "Nina", "Arjun", "Maya", "Ivan", "Lucia", "Sami", "Tara",
  "Noah", "Mei", "Kabir", "Elena", "Yusuf", "Riya", "Marco", "Hana", "Vikram", "Leila",
  "Jin", "Amara", "Tomas", "Isha", "Kofi", "Sana", "Luca", "Nadia", "Ravi", "Bianca",
];

// deterministic small hash so each game has its own crowd size
const hash = (s) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
};
const baseCount = (slug) => 140 + (hash(slug) % 260); // ~140–400
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const money = () => {
  const r = Math.random();
  const v = r < 0.6 ? 50 + Math.floor(Math.random() * 950) : r < 0.9 ? 1000 + Math.floor(Math.random() * 4000) : 5000 + Math.floor(Math.random() * 20000);
  return Math.round(v / 10) * 10;
};
const fmt = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k` : `${n}`);

/** Playing-now count that drifts realistically. */
export function usePlayersOnline(slug) {
  const [n, setN] = useState(() => baseCount(slug));
  useEffect(() => {
    const id = setInterval(() => {
      setN((prev) => {
        const wave = Math.round(Math.sin(Date.now() / 42000 + hash(slug)) * 55);
        const target = baseCount(slug) + wave;
        const drift = Math.round((Math.random() - 0.5) * 10);
        return Math.max(40, Math.round(prev * 0.72 + (target + drift) * 0.28));
      });
    }, 2600);
    return () => clearInterval(id);
  }, [slug]);
  return n;
}

/** One ambient feed event. Slightly game-flavoured via the verb pool. */
function ambientEvent(slug, seq) {
  const big = Math.random() < 0.22;
  const amt = big ? 3000 + Math.floor(Math.random() * 18000) : money();
  const mult = Math.random() < 0.55 ? (1 + Math.random() * (big ? 20 : 6)).toFixed(2) : null;
  const name = pick(NAMES);
  const win = Math.random() < 0.82; // feed skews to wins (it's a highlight reel)
  let text;
  if (!win) text = "placed a bet";
  else if (mult) text = `cashed ${mult}× · +${fmt(amt)}`;
  else text = `won +${fmt(amt)}`;
  return { id: `a-${seq}-${Date.now()}`, name, text, amount: win ? amt : 0, tone: big && win ? "gold" : win ? "win" : "neutral" };
}

/** Rolling live win-feed: ambient events merged with any real ones. */
export function useWinFeed(slug, realEvents = []) {
  const [feed, setFeed] = useState([]);
  const seqRef = useRef(0);
  useEffect(() => {
    let alive = true;
    const tick = () => {
      if (!alive) return;
      setFeed((prev) => [ambientEvent(slug, seqRef.current++), ...prev].slice(0, 18));
      const next = 1400 + Math.random() * 2600; // 1.4–4s cadence
      timer = setTimeout(tick, next);
    };
    let timer = setTimeout(tick, 400 + Math.random() * 800);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [slug]);
  // merge real events (newest first) ahead of ambient
  if (realEvents && realEvents.length) {
    return [...realEvents, ...feed].slice(0, 18);
  }
  return feed;
}
