# 4DX Realtime Upgrade — Design

Date: 2026-07-21
Status: Approved, ready to build

## Goal
Make every FunGame game *feel* like a packed, live, high-energy casino table —
addressing the "feels coded / not realtime" perception — plus 4DX-grade rumble
and punch, per-game opening themes, and a trendy modern finish. Games are
already realtime (universal server clock, secure RNG); the gap is perception.

## Non-negotiables
- **Outcomes stay pure RNG** (`secrets.SystemRandom`), server-authoritative,
  bet-independent. Ambient activity is cosmetic only and never touches results.
- Phone-safe: CSS 3D transforms / SVG / canvas, not a heavy 3D engine.
- Respect reduced-motion + the sound/haptics toggles.

## Architecture decision
**Ambient activity is generated client-side** (seeded, drifting) — zero backend
load, instant, scales. Two players seeing different ambient feeds is fine (every
casino patron sees their own view). Real activity (already exposed for live
games via `all_bets`/`players`) is merged in when present.

## Part 1 — Live activity layer (anchor)
- `lib/liveActivity.js`:
  - `usePlayersOnline(slug)` — a "playing now" count per game that drifts
    realistically (base + slow sine + small noise), stable-ish frame to frame.
  - `useWinFeed(slug, realEvents)` — a rolling feed of `{id, name, text, amount,
    mult, tone}`; emits a new ambient event every ~1.5–4s (paced per game),
    merges any real events, caps length. Diverse name pool.
- UI: a compact **LIVE bar** in `PlayShell` (wraps all 10 games at once):
  `🟢 <N> playing` + a scrolling **win-feed** ("Rahul cashed 4.2× · +2,400").
- Live-round games: keep real `all_bets`; when sparse, top up with ambient so
  the "bets this round" panel never looks empty.

## Part 2 — 4DX punch-up
- Haptics ~2× stronger (longer durations, heavier crash/jackpot patterns) in
  `sound.js` `vibe()` calls.
- Win/crash audio louder + deeper sub-bass (raise gain on those layers).
- Global **screen-shake + flash** on big wins/crashes: a `use4DX()` hook + CSS
  keyframes (`fg-av-shake`/`fg-win-flash` exist); apply to the game stage.
- "Big win" cinematic (flash + shake + coin shower + bigger sound) on high
  multipliers, shared across games.

## Part 3 — Per-game opening theme
- Reusable `GameIntro` overlay on game mount (~1.5s), keyed by game family:
  cards shuffling (card games), reels warming (slots), wheel spinning up
  (roulette/wheel), dice tumbling (dice), balls loading (keno/bingo), plane
  taxiing (aviator). Shows game name + LIVE badge, then dissolves into the table.
- Skips on reduced-motion; shows once per game entry.

## Part 4 — Trendy + harder to predict
- Trendy = the social live-feed itself + light polish (animated gradient accents,
  subtle glass). Small pass.
- "Harder to predict" is largely **already delivered** (secure RNG + tough-logic
  rebalance: 7up7down doubles-lose, baccarat commission, andar/bahar asymmetry,
  slot/champion RTP fixes, no early reveal). Verify no new telegraphing; no
  major new work.

## Build order
1. Live activity layer → 2. 4DX punch-up → 3. Opening themes → 4. Trendy polish.
Each ships + deploys via the Render hooks and is verified live.

## Out of scope
- Backend ambient generation, real-time websockets, chat, leaderboards.
