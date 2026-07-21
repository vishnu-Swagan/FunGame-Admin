import { useState, useEffect, useRef } from "react";

/* Client-side ambient "live floor" activity PLUS a real win-event bus.
   Ambient names/events are cosmetic and never touch outcomes (those are
   server-side secure RNG). Real round-end wins (the player's own + real
   cross-player winners from the backend) are injected via the win bus so the
   feed shows genuine, synced winning announcements with real chip values. */

// Large, diverse first-name pool so ambient names don't repeat quickly.
const NAMES = [
  "Rahul", "Priya", "Wei", "Aisha", "Diego", "Sofia", "Kenji", "Fatima", "Liam", "Ananya",
  "Chen", "Zara", "Omar", "Nina", "Arjun", "Maya", "Ivan", "Lucia", "Sami", "Tara",
  "Noah", "Mei", "Kabir", "Elena", "Yusuf", "Riya", "Marco", "Hana", "Vikram", "Leila",
  "Jin", "Amara", "Tomas", "Isha", "Kofi", "Sana", "Luca", "Nadia", "Ravi", "Bianca",
  "Hugo", "Ayesha", "Dmitri", "Carmen", "Tariq", "Freya", "Sanjay", "Yuki", "Pablo", "Nour",
  "Ethan", "Lin", "Kwame", "Simone", "Farid", "Ingrid", "Rohan", "Chiara", "Bilal", "Aria",
  "Mateo", "Zoya", "Andre", "Meera", "Sven", "Layla", "Deepak", "Rosa", "Hassan", "Emi",
  "Oscar", "Nia", "Rustam", "Paula", "Imran", "Greta", "Karan", "Sora", "Felix", "Dalia",
  "Victor", "Anika", "Boris", "Camila", "Jamal", "Astrid", "Nikhil", "Yara", "Milan", "Reem",
  "Leo", "Xin", "Amir", "Valentina", "Suresh", "Freja", "Zain", "Keiko", "Bruno", "Salma",
  "Aditya", "Elif", "Cyrus", "Marta", "Rashid", "Anja", "Manish", "Hina", "Enzo", "Dina",
  "Caleb", "Ling", "Idris", "Priyanka", "Naveen", "Saskia", "Faisal", "Rin", "Gabriel", "Noor",
  "Aryan", "Vera", "Musa", "Mira", "Nils", "Amina", "Dev", "Yui", "Adrian", "Soraya",
  "Ismail", "Katya", "Rafael", "Ishaan", "Bikram", "Lena", "Zayd", "Emiko", "Matteo", "Hala",
  "Tobias", "Wen", "Karim", "Selin", "Aakash", "Freda", "Junaid", "Aiko", "Diogo", "Rania",
  "Elias", "Qing", "Nasir", "Petra", "Vishal", "Signe", "Waleed", "Nao", "Marcus", "Lamis",
  "Adnan", "Fen", "Basit", "Irisz", "Yash", "Marit", "Ziad", "Haru", "Sergio", "Widad",
  "Kiran", "Bao", "Tarek", "Oksana", "Nitin", "Elsa", "Hamza", "Miu", "Roberto", "Sahar",
];

// deterministic small hash so each game has its own crowd size
const hash = (s) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
};
const baseCount = (slug) => 140 + (hash(slug) % 260); // ~140–400
const money = () => {
  const r = Math.random();
  const v = r < 0.6 ? 50 + Math.floor(Math.random() * 950) : r < 0.9 ? 1000 + Math.floor(Math.random() * 4000) : 5000 + Math.floor(Math.random() * 20000);
  return Math.round(v / 10) * 10;
};
const fmt = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k` : `${n}`);

// Fisher–Yates
const shuffle = (arr) => {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

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

/** One ambient feed event. `name` is drawn from a no-repeat shuffle bag. */
function ambientEvent(slug, seq, name) {
  const big = Math.random() < 0.22;
  const amt = big ? 3000 + Math.floor(Math.random() * 18000) : money();
  const mult = Math.random() < 0.55 ? (1 + Math.random() * (big ? 20 : 6)).toFixed(2) : null;
  const win = Math.random() < 0.82; // feed skews to wins (it's a highlight reel)
  let text;
  if (!win) text = "placed a bet";
  else if (mult) text = `cashed ${mult}× · +${fmt(amt)}`;
  else text = `won +${fmt(amt)}`;
  return { id: `a-${seq}-${Date.now()}`, name, text, amount: win ? amt : 0, tone: big && win ? "gold" : win ? "win" : "neutral" };
}

// ---------------------------------------------------------------------------
// Real win-event bus: publishers (useLiveRound / AviatorGame) push genuine
// round-end wins here; useWinFeed subscribes and injects them into the ticker.
// ---------------------------------------------------------------------------
const winBus = {}; // slug -> { subs:Set<fn>, events:[] }
const busFor = (slug) => (winBus[slug] || (winBus[slug] = { subs: new Set(), events: [] }));

/** Format a raw win {id,name,payout,bet,mine} into a feed event. */
function winToEvent(w) {
  const big = w.payout >= 10000 || (w.bet > 0 && w.payout >= w.bet * 5 && w.payout >= 2000);
  return {
    id: String(w.id),
    name: w.mine ? "You" : w.name || "Player",
    text: `won +${fmt(w.payout)}`,
    amount: w.payout,
    tone: big ? "gold" : "win",
    real: true,
    mine: !!w.mine,
    ts: Date.now(),
  };
}

/** Publish real wins for a game. De-duped by id; newest first; keeps last 40. */
export function publishWins(slug, raws) {
  if (!raws || !raws.length) return;
  const b = busFor(slug);
  const known = new Set(b.events.map((e) => e.id));
  const fresh = raws
    .filter((w) => w && w.payout > 0 && !known.has(String(w.id)))
    .map(winToEvent);
  if (!fresh.length) return;
  b.events = [...fresh, ...b.events].slice(0, 40);
  b.subs.forEach((fn) => fn(b.events));
}

function useLiveWins(slug) {
  const [events, setEvents] = useState(() => busFor(slug).events);
  useEffect(() => {
    const b = busFor(slug);
    setEvents(b.events);
    const fn = (ev) => setEvents(ev);
    b.subs.add(fn);
    return () => b.subs.delete(fn);
  }, [slug]);
  return events;
}

/** Rolling live win-feed: real round-end wins injected on arrival, ambient
    fills the gaps. Real wins show at the moment they settle, then scroll away
    like any other item (no perpetual pinning). */
export function useWinFeed(slug) {
  const [feed, setFeed] = useState([]);
  const seqRef = useRef(0);
  const bagRef = useRef([]);
  const nextName = () => {
    if (!bagRef.current.length) bagRef.current = shuffle(NAMES);
    return bagRef.current.pop();
  };

  // Ambient stream
  useEffect(() => {
    let alive = true;
    bagRef.current = shuffle(NAMES);
    const tick = () => {
      if (!alive) return;
      setFeed((prev) => [ambientEvent(slug, seqRef.current++, nextName()), ...prev].slice(0, 18));
      timer = setTimeout(tick, 1400 + Math.random() * 2600); // 1.4–4s cadence
    };
    let timer = setTimeout(tick, 400 + Math.random() * 800);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  // Inject real wins as they arrive (own win prioritized to the very front)
  const liveWins = useLiveWins(slug);
  const seenRef = useRef(new Set());
  useEffect(() => {
    const fresh = liveWins.filter((e) => !seenRef.current.has(e.id));
    if (!fresh.length) return;
    // own win always shows; cap others per arrival so opening a game doesn't
    // flood the ticker with a burst of historical wins.
    const mine = fresh.filter((e) => e.mine);
    const others = fresh.filter((e) => !e.mine).slice(0, 4);
    const injected = [...mine, ...others];
    injected.forEach((e) => seenRef.current.add(e.id));
    setFeed((prev) => [...injected, ...prev].slice(0, 18));
  }, [liveWins]);

  return feed;
}
