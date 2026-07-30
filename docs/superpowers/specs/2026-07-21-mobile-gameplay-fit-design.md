# Mobile Gameplay Fit — Design (Bundle 1)

**Date:** 2026-07-21
**Status:** Approved (pending spec review)
**Scope:** Mobile play-screen UX for the ~10 standard vertical live games. Roulette (landscape) is out of scope; Aviator is adapted.

## Problem

On phones, every live game stacks vertically: `timer bar → game visual → result → bet panel → history`. The **Place Bet** button falls below the fold, so players **scroll down to bet, then scroll up to watch the result**. The betting countdown also scrolls out of view, and there is no audible warning when betting is about to close.

## Goals

1. Betting controls **and** the game result are visible without the scroll-down/scroll-up dance.
2. The **betting timeline (countdown) is pinned below the Chakri.Casino logo**, always visible while scrolling.
3. An **escalating audio alarm** fires in the final 5 seconds of betting.
4. Works on Android + iOS (TWA and PWA), all phone sizes, honoring notch/home-indicator safe areas.

## Non-goals

- Roulette layout (already a full-screen landscape screen — untouched).
- Any change to game logic, RNG, or the synchronized-round model.
- Desktop/tablet redesign (mobile-first; larger screens simply get more room).

## Architecture

### `GameStage` (new shared shell)

Replaces the current `PlayShell` + inline `LiveBar` stack for the standard games. An **app-style fixed viewport**, not a long scroll.

- **Height:** `calc(100dvh − var(--fg-header-h))`. `AppShell` measures its sticky header with a `ResizeObserver` and publishes the height as the CSS variable `--fg-header-h` on the app root (keeps notch/safe-area/disclaimer changes correct).
- **Flex column, three fixed zones + one overlay:**
  1. **Sticky game bar** (top, non-scrolling) — merges today's redundant PlayShell header and the inline `LiveBar`:
     `◀ back · Game name · ⏱ StickyTimeline (phase + progress + countdown) · 🔊 mute · 💰 balance`.
     This is the "betting timeline below the Chakri.Casino logo," always visible.
  2. **Middle** (`flex-1`, `overflow-y-auto`) — the game visual + `ResultBanner`. Scrolls **only** if a game is taller than the available space (fallback on very small phones); otherwise no scroll.
  3. **Bet dock** (bottom, non-scrolling) — each game supplies its bet controls here (see contract). Bottom padding honors `env(safe-area-inset-bottom)`.
  4. **`ExtrasSheet`** — a small handle above the dock expands a bottom sheet with history / paytable / rules on demand.
- **Bottom nav hidden on game-play routes.** `AppShell` hides its fixed bottom nav on `/games/:slug/play`, reclaiming ~72px and letting the bet dock own the bottom edge. The sticky game bar's back button provides navigation.

### `BetDock` contract

`GameStage` renders a `betDock` prop in the sticky bottom zone. Each game passes the controls it needs:

- **Stake games** (slots, wheel, keno, bingo): quick-chips + custom amount + **Place Bet** (today's `LiveBetPanel`, restyled compact for the dock).
- **Pick games** (7up7down, andar-bahar, card side bets, target): selection buttons + stake + Place Bet.
- **Aviator:** its two-panel bet + live **cash-out** button live in the dock (adapted from today's Aviator controls).

The dock is locked/disabled outside the betting window (existing behavior), except Aviator's cash-out which is enabled during flight.

### `StickyTimeline`

Compact countdown rendered inside the sticky game bar, driven by the game's `useLiveRound` state (`phase`, `countdown`, `timings`):

- Shows phase label (`PLACE BETS / NO MORE BETS / RESULT`), a thin progress bar, and the countdown number.
- **Last 5s of betting:** color ramps **amber → red** and pulses. Pulse is disabled under `prefers-reduced-motion`.

### `useBettingAlarm(phase, countdown, timings)`

- During `BETTING`, at each whole second `≤ 5`, plays a **tick that rises in pitch and gets faster** (5→1).
- At the `BETTING → REVEAL` boundary, plays a **"locked" thunk**.
- Fires **once per second per round** (guards on last-ticked second + round number).
- Respects the game mute toggle (`isMuted()`); silent when muted.
- Needs two new synth sounds in `lib/sound.js`: `tick(pitch)` and `betLock`.

## Rollout

- **New shared modules:** `GameStage`, `BetDock`, `StickyTimeline`, `ExtrasSheet`, `useBettingAlarm`.
- **`AppShell`:** publish `--fg-header-h`; hide bottom nav on game-play routes.
- **All standard vertical live games** refactored to render inside `GameStage` (visual → middle, controls → dock, history/paytable → sheet), one at a time — i.e. every live game **except Roulette** (untouched) with **Aviator** adapted separately. Covers: 7up7down, andar-bahar, bingo, keno, checker, champion-poker, video-poker, fun-target, the slots (triple-fun, lucky-8-line, joker-bonus, giant-jackpot/`SlotGame`), super-golden-wheel, the card-duels (teen-patti / poker / no-hold).
- **Aviator:** adapted so bet/cash-out lives in the dock.
- **Roulette:** untouched (landscape).
- **Checker fix (folded in):** while refactoring Checker into `GameStage`, **center the Gold vs Steel pieces/medallions correctly** in their cells/track (current layout is off-center).

## Edge cases

- **Small phones:** if the game visual + dock still exceed the viewport, only the **middle** scrolls; timeline and dock stay pinned.
- **Safe areas:** sticky bar clears the notch (top inset already handled); dock clears the home indicator (`env(safe-area-inset-bottom)`).
- **Reduced motion:** timeline pulse disabled; alarm audio still plays (gated only by mute).
- **Mute:** all alarm sounds silent when muted.
- **Phase desync/latency:** timeline reads the same anchored countdown as today's `LiveBar`; alarm guards prevent double-ticks on re-render/poll.

## Testing

- Build passes (`craco build`).
- On-device (Android TWA + iOS PWA): timeline stays pinned below the logo while scrolling; **Place Bet always reachable**; game result visible without scrolling up; ticks escalate in the last 5s and the lock thunk fires at 0; Checker pieces centered; bottom nav hidden during play; no dock/home-indicator overlap.

## Confirmed defaults

- Hide bottom nav during gameplay: **yes**.
- Merge game header + timer into one sticky bar: **yes**.
