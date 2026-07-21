# Mobile Gameplay Fit (Bundle 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every standard vertical live game fit the phone screen — bet controls and result visible without scrolling — with the betting countdown pinned below the FunGame logo and an escalating audio alarm in the last 5 seconds of betting.

**Architecture:** A new shared `GameStage` shell renders each game as a fixed-height app viewport: a sticky merged game-bar/timeline on top, a `flex-1` middle that scrolls only if a game overflows, and a sticky bet dock at the bottom, with a pull-up extras sheet. `AppShell` publishes its header height as a CSS variable and hides the bottom nav during play. A `useBettingAlarm` hook drives escalating ticks + a lock thunk.

**Tech Stack:** React 19 (CRA + craco), Tailwind, framer-motion, the existing WebAudio synth engine in `frontend/src/lib/sound.js`, the `useLiveRound` live-round hook.

## Global Constraints

- **Primary verification gate:** `cd frontend && CI=false npx craco build` compiles with "Compiled successfully." (there is no established frontend unit-test runner; build + on-device check is the gate). Pure logic gets a Jest/RTL test where noted (`CI=false npx craco test --watchAll=false <path>`).
- **No game-logic / RNG / synchronized-round changes.** Layout, presentation, and audio only.
- **Roulette (`RouletteGame.js`) is untouched** (already full-screen landscape).
- **Mobile-first**, honor safe areas: top inset already handled in `AppShell` header; dock must pad `env(safe-area-inset-bottom)`.
- **Mute:** every alarm sound must check `isMuted()` from `@/lib/sound` and stay silent when muted.
- **Reduced motion:** timeline pulse uses `@media (prefers-reduced-motion: reduce)` to disable animation; audio still plays.
- **Deploy after merge:** frontend deploy hook (kept in session context, not in repo). Backend unchanged — no backend deploy needed.
- **Commit style:** end messages with the repo's Co-Authored-By trailer.

---

### Task 1: Add `tick(pitch)` and `betLock` synth sounds

**Files:**
- Modify: `frontend/src/lib/sound.js` (add two entries to the exported `sfx` object; reuse the existing `tone()`/`noise()` primitives and master bus already defined in the file).

**Interfaces:**
- Produces: `sfx.tick(step)` where `step` is `1..5` (1 = final tick, highest pitch); `sfx.betLock()` (a low "clunk"). Both no-arg-safe and mute-aware via the engine's existing gating.

- [ ] **Step 1: Read the existing engine** to match its primitive signatures.

Run: `sed -n '1,60p' frontend/src/lib/sound.js` and locate the `tone(...)` / `noise(...)` helpers and how existing `sfx.*` entries are written (e.g. `chip`, `reelStop`).

- [ ] **Step 2: Add the two sounds** to the `sfx` object, following the exact `tone()`/`noise()` signature found in Step 1. Reference implementation (adapt argument order to the real helper):

```js
// Escalating countdown tick: higher pitch + shorter as `step` -> 1 (final second).
tick: (step = 3) => {
  const s = Math.max(1, Math.min(5, step));
  const freq = 520 + (6 - s) * 120;      // 5->640, 1->1120 Hz (rises toward zero)
  tone({ freq, type: "square", dur: 0.05, gain: 0.16 });
  vibe && vibe([0, s <= 2 ? 30 : 16]);   // stronger buzz on the last two ticks (if vibe helper exists)
},
// Bets locked: a short low wooden clunk.
betLock: () => {
  tone({ freq: 150, type: "sine", dur: 0.14, gain: 0.28 });
  noise({ dur: 0.06, gain: 0.14 });
  vibe && vibe([0, 60]);
},
```

- [ ] **Step 3: Build.** Run: `cd frontend && CI=false npx craco build` → Expected: "Compiled successfully."

- [ ] **Step 4: Commit.**

```bash
git add frontend/src/lib/sound.js
git commit -m "sound: add escalating tick(step) + betLock sfx"
```

---

### Task 2: `useBettingAlarm` hook

**Files:**
- Create: `frontend/src/lib/useBettingAlarm.js`
- Test: `frontend/src/lib/useBettingAlarm.test.js`

**Interfaces:**
- Consumes: `sfx.tick`, `sfx.betLock`, `isMuted` from `@/lib/sound`.
- Produces: `useBettingAlarm({ phase, countdown, roundNumber })` — a hook with no return value. During `phase === "BETTING"` it fires `sfx.tick(step)` once for each whole second `5,4,3,2,1` remaining, and `sfx.betLock()` once when `phase` leaves `BETTING`. De-dupes on `(roundNumber, second)` and on the lock transition.

- [ ] **Step 1: Write the failing test** (pure scheduling logic — extract a helper `alarmStep(countdown)` that maps a countdown to a tick step or null so it is unit-testable).

```js
// frontend/src/lib/useBettingAlarm.test.js
import { alarmStep } from "./useBettingAlarm";

test("alarmStep maps last 5 whole seconds to steps 5..1", () => {
  expect(alarmStep(5.9)).toBe(5);
  expect(alarmStep(4.2)).toBe(4);
  expect(alarmStep(1.0)).toBe(1);
});
test("alarmStep is null above 5s and at/below 0", () => {
  expect(alarmStep(6.1)).toBeNull();
  expect(alarmStep(0)).toBeNull();
});
```

- [ ] **Step 2: Run test, expect fail.** Run: `cd frontend && CI=false npx craco test --watchAll=false src/lib/useBettingAlarm.test.js` → Expected: FAIL ("alarmStep is not a function").

- [ ] **Step 3: Implement the hook + helper.**

```js
// frontend/src/lib/useBettingAlarm.js
import { useEffect, useRef } from "react";
import { sfx, isMuted } from "@/lib/sound";

/** Whole-second countdown -> tick step 5..1, else null (only the final 5s). */
export function alarmStep(countdown) {
  const s = Math.ceil(countdown);
  return s >= 1 && s <= 5 ? s : null;
}

/** Escalating end-of-betting alarm. Ticks 5..1 during BETTING, thunk at lock. */
export function useBettingAlarm({ phase, countdown, roundNumber }) {
  const lastTickRef = useRef(""); // `${round}:${step}` already played
  const lockedRoundRef = useRef(null);
  const prevPhaseRef = useRef(phase);

  useEffect(() => {
    if (phase === "BETTING") {
      const step = alarmStep(countdown);
      if (step != null && !isMuted()) {
        const key = `${roundNumber}:${step}`;
        if (lastTickRef.current !== key) {
          lastTickRef.current = key;
          sfx.tick && sfx.tick(step);
        }
      }
    }
    if (prevPhaseRef.current === "BETTING" && phase !== "BETTING") {
      if (lockedRoundRef.current !== roundNumber) {
        lockedRoundRef.current = roundNumber;
        if (!isMuted()) sfx.betLock && sfx.betLock();
      }
    }
    prevPhaseRef.current = phase;
  }, [phase, countdown, roundNumber]);
}
```

- [ ] **Step 4: Run test, expect pass.** Run: `cd frontend && CI=false npx craco test --watchAll=false src/lib/useBettingAlarm.test.js` → Expected: PASS.

- [ ] **Step 5: Build + commit.**

```bash
cd frontend && CI=false npx craco build   # Compiled successfully
git add frontend/src/lib/useBettingAlarm.js frontend/src/lib/useBettingAlarm.test.js
git commit -m "feat: useBettingAlarm hook (escalating ticks + lock thunk, mute-aware)"
```

---

### Task 3: AppShell — publish `--fg-header-h`, hide bottom nav during play

**Files:**
- Modify: `frontend/src/components/AppShell.js` (header ref + ResizeObserver → set `--fg-header-h`; conditionally hide the fixed bottom nav on game-play routes).

**Interfaces:**
- Produces: CSS variable `--fg-header-h` on the `.App` root equal to the sticky header's rendered height; bottom `<nav>` not rendered when `location.pathname` matches `/games/<slug>/play`.

- [ ] **Step 1: Add the header measurement.** In `AppShell`, add `const headerRef = useRef(null)` on the `<header>`, and:

```js
useEffect(() => {
  const el = headerRef.current;
  if (!el) return;
  const root = el.closest(".App") || document.documentElement;
  const set = () => root.style.setProperty("--fg-header-h", `${el.offsetHeight}px`);
  set();
  const ro = new ResizeObserver(set);
  ro.observe(el);
  window.addEventListener("orientationchange", set);
  return () => { ro.disconnect(); window.removeEventListener("orientationchange", set); };
}, []);
```

Attach `ref={headerRef}` to the existing `<header>` element.

- [ ] **Step 2: Hide bottom nav on play routes.** Compute `const onPlay = /\/games\/[^/]+\/play$/.test(location.pathname);` and wrap the bottom `<nav>` render in `{!onPlay && ( ... )}`. Also drop the content wrapper's bottom padding on play (`pb-[calc(96px+env(safe-area-inset-bottom))]` → `onPlay ? "pb-0" : "pb-[calc(96px+env(safe-area-inset-bottom))]"`).

- [ ] **Step 3: Build.** `cd frontend && CI=false npx craco build` → "Compiled successfully."

- [ ] **Step 4: Commit.**

```bash
git add frontend/src/components/AppShell.js
git commit -m "AppShell: publish --fg-header-h; hide bottom nav on game-play routes"
```

---

### Task 4: `StickyTimeline` component

**Files:**
- Create: `frontend/src/components/play/StickyTimeline.js`
- Modify: `frontend/src/index.css` (add `fg-timeline-pulse` keyframe, reduced-motion guarded).

**Interfaces:**
- Consumes: live-round `phase`, `countdown`, `state.timings`.
- Produces: `<StickyTimeline phase countdown timings labels />` — a compact bar (phase label + progress + countdown) that ramps amber→red and pulses in the last 5s of betting.

- [ ] **Step 1: CSS.** Append to `frontend/src/index.css`:

```css
@keyframes fg-timeline-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.55; } }
.fg-timeline-alarm { animation: fg-timeline-pulse 0.5s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) { .fg-timeline-alarm { animation: none; } }
```

- [ ] **Step 2: Component.**

```jsx
// frontend/src/components/play/StickyTimeline.js
import { Timer } from "lucide-react";

const PHASE = { BETTING: "PLACE BETS", REVEAL: "NO MORE BETS", RESULT: "RESULT" };

export const StickyTimeline = ({ phase, countdown, timings, labels = {} }) => {
  const betting = phase === "BETTING";
  const secs = Math.ceil(countdown || 0);
  const alarm = betting && secs <= 5 && secs >= 1;
  const total = timings?.bet || 13;
  const pct = betting ? Math.min(100, Math.max(0, (countdown / total) * 100)) : 100;
  const tone = alarm ? "#ef4444" : betting ? "hsl(var(--emerald))" : phase === "REVEAL" ? "hsl(var(--magenta))" : "hsl(var(--primary))";
  return (
    <div className={`flex items-center gap-2 ${alarm ? "fg-timeline-alarm" : ""}`} data-testid="sticky-timeline">
      <Timer className="h-3.5 w-3.5 shrink-0" style={{ color: tone }} />
      <span className="text-[10px] font-extrabold tracking-wider shrink-0" style={{ color: tone }}>
        {labels[phase] ?? PHASE[phase] ?? "SYNCING…"}
      </span>
      <div className="flex-1 h-1.5 rounded-full bg-white/8 overflow-hidden">
        <div className="h-full rounded-full transition-[width] duration-200" style={{ width: `${pct}%`, background: tone }} />
      </div>
      <span data-testid="sticky-timer" className="tabular-nums font-display text-lg leading-none shrink-0" style={{ color: tone }}>{secs}</span>
    </div>
  );
};
```

- [ ] **Step 3: Build + commit.**

```bash
cd frontend && CI=false npx craco build
git add frontend/src/components/play/StickyTimeline.js frontend/src/index.css
git commit -m "feat: StickyTimeline (amber->red alarm ramp, reduced-motion safe)"
```

---

### Task 5: `BetDock` + `ExtrasSheet` components

**Files:**
- Create: `frontend/src/components/play/BetDock.js`
- Create: `frontend/src/components/play/ExtrasSheet.js`

**Interfaces:**
- Produces:
  - `<BetDock>{children}</BetDock>` — a sticky-bottom, safe-area-padded container that holds a game's bet controls.
  - `<ExtrasSheet>{children}</ExtrasSheet>` — a collapsible bottom sheet with a handle; collapsed by default; expands over the dock.

- [ ] **Step 1: BetDock.**

```jsx
// frontend/src/components/play/BetDock.js
export const BetDock = ({ children }) => (
  <div
    className="shrink-0 border-t border-white/10 bg-[hsl(var(--background)/0.92)] backdrop-blur-xl px-3 pt-2.5"
    style={{ paddingBottom: "calc(0.625rem + env(safe-area-inset-bottom))" }}
    data-testid="bet-dock"
  >
    {children}
  </div>
);
```

- [ ] **Step 2: ExtrasSheet.**

```jsx
// frontend/src/components/play/ExtrasSheet.js
import { useState } from "react";
import { ChevronUp } from "lucide-react";

export const ExtrasSheet = ({ children, label = "History & info" }) => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        data-testid="extras-sheet-toggle"
        onClick={() => setOpen((o) => !o)}
        className="shrink-0 w-full flex items-center justify-center gap-1.5 py-1.5 text-[11px] font-semibold text-white/55 border-t border-white/8"
      >
        <ChevronUp className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} /> {label}
      </button>
      {open && (
        <div data-testid="extras-sheet" className="shrink-0 max-h-[42vh] overflow-y-auto px-3 pb-3 space-y-3 border-t border-white/8 bg-black/25">
          {children}
        </div>
      )}
    </>
  );
};
```

- [ ] **Step 3: Build + commit.**

```bash
cd frontend && CI=false npx craco build
git add frontend/src/components/play/BetDock.js frontend/src/components/play/ExtrasSheet.js
git commit -m "feat: BetDock (sticky bottom, safe-area) + ExtrasSheet (pull-up)"
```

---

### Task 6: `GameStage` shell

**Files:**
- Create: `frontend/src/components/play/GameStage.js`

**Interfaces:**
- Consumes: `StickyTimeline`, `BetDock`, `ExtrasSheet`, `useBettingAlarm`, `isMuted`/`toggleMuted`/`onMuteChange` from `@/lib/sound`, `useNavigate`.
- Produces: `<GameStage game balance live={{phase,countdown,timings,roundNumber}} betDock extras labels>{middle}</GameStage>` — the fixed-viewport shell (sticky game bar → scrollable middle → dock → sheet). Fires `useBettingAlarm` internally.

- [ ] **Step 1: Component.**

```jsx
// frontend/src/components/play/GameStage.js
import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, Coins, Volume2, VolumeX } from "lucide-react";
import { isMuted, toggleMuted, onMuteChange } from "@/lib/sound";
import { formatChips } from "@/components/common";
import { StickyTimeline } from "@/components/play/StickyTimeline";
import { BetDock } from "@/components/play/BetDock";
import { ExtrasSheet } from "@/components/play/ExtrasSheet";
import { useBettingAlarm } from "@/lib/useBettingAlarm";

export const GameStage = ({ game, balance, live, betDock, extras, labels, children }) => {
  const navigate = useNavigate();
  const [muted, setMuted] = useState(isMuted());
  useEffect(() => onMuteChange(setMuted), []);
  useBettingAlarm({ phase: live?.phase, countdown: live?.countdown ?? 0, roundNumber: live?.roundNumber });

  return (
    <div
      className="flex flex-col"
      style={{ height: "calc(100dvh - var(--fg-header-h, 56px))" }}
      data-testid="game-stage"
    >
      {/* sticky game bar (below the FunGame logo) */}
      <div className="shrink-0 px-3 pt-2 pb-2 border-b border-white/10 bg-[hsl(var(--background)/0.9)] backdrop-blur-xl space-y-1.5">
        <div className="flex items-center gap-2">
          <button data-testid="play-back-button" onClick={() => navigate(`/games/${game.slug}`)} aria-label="Back"
            className="h-8 w-8 flex items-center justify-center rounded-full border border-white/10 bg-white/5 active:scale-95">
            <ArrowLeft className="h-4 w-4 text-white/85" />
          </button>
          <h1 className="flex-1 truncate font-display text-lg text-white">{game.name}</h1>
          <button data-testid="play-sound-toggle" onClick={toggleMuted} aria-label={muted ? "Unmute" : "Mute"}
            className={`h-8 w-8 flex items-center justify-center rounded-full border ${muted ? "border-white/10 bg-white/5" : "border-primary/35 bg-primary/10"}`}>
            {muted ? <VolumeX className="h-4 w-4 text-white/60" /> : <Volume2 className="h-4 w-4 text-primary" />}
          </button>
          <div data-testid="play-balance" className="flex items-center gap-1 rounded-full border border-primary/35 bg-primary/10 px-2 py-1">
            <Coins className="h-3.5 w-3.5 text-primary" />
            <span className="tabular-nums text-xs font-bold text-primary">{balance === null ? "…" : formatChips(balance)}</span>
          </div>
        </div>
        <StickyTimeline phase={live?.phase} countdown={live?.countdown} timings={live?.timings} labels={labels} />
      </div>

      {/* middle — scrolls only if the game overflows */}
      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3" data-testid="game-stage-middle">
        {children}
      </div>

      {/* extras sheet (pull-up) then the bet dock */}
      {extras ? <ExtrasSheet>{extras}</ExtrasSheet> : null}
      <BetDock>{betDock}</BetDock>
    </div>
  );
};
```

- [ ] **Step 2: Build + commit.**

```bash
cd frontend && CI=false npx craco build
git add frontend/src/components/play/GameStage.js
git commit -m "feat: GameStage fixed-viewport shell (sticky bar/timeline + middle + dock + sheet)"
```

---

### Task 7: Reference migration — `SlotGame` (covers giant-jackpot & the slots)

**Files:**
- Modify: `frontend/src/pages/play/SlotGame.js`

**Interfaces:**
- Consumes: `GameStage`. Keeps using `useLiveRound`.
- Produces: the migration **recipe** every later game task follows.

**Migration recipe (apply verbatim to each game):**
1. Read the current file. Identify three groups in the current `return`: **(A) game visual + `ResultBanner`**, **(B) bet controls** (the `LiveBetPanel` / selection buttons / place / clear), **(C) extras** (`HistoryStrip`, `LastResults`, paytable/rules text).
2. Replace the `PlayShell` wrapper with `GameStage`. Remove the standalone `LiveBar` (its countdown now lives in the sticky timeline; a compact `LastResults`/phase can stay in the middle if desired).
3. Pass groups: `children` = **A**, `betDock` = **B**, `extras` = **C**. Pass `live={{ phase, countdown, timings: state?.timings, roundNumber: state?.round_number }}` and `balance`, `game`.
4. Build; on-device check that Place Bet is docked and the visual fits.

- [ ] **Step 1: Read** `frontend/src/pages/play/SlotGame.js` and locate the reel cabinet (A), the chip tray / `LiveBetPanel` (B), and `HistoryStrip`/paytable (C).

- [ ] **Step 2: Rewrite the `return`** using `GameStage`:

```jsx
return (
  <GameStage
    game={game}
    balance={balance}
    live={{ phase, countdown, timings: state?.timings, roundNumber: state?.round_number }}
    labels={{ REVEAL: "SPINNING…" }}
    betDock={
      <LiveBetPanel
        amount={amount} setAmount={setAmount} onPlace={() => placeBet(null, amount)}
        betting={betting} placing={placing} label="Spin" myTotal={myTotal}
      />
    }
    extras={<HistoryStrip history={history} />}
  >
    {/* A: reel cabinet + ResultBanner (unchanged markup) */}
    {/* ...existing cabinet JSX... */}
    <ResultBanner result={result} />
  </GameStage>
);
```

Update imports: add `GameStage`; drop `PlayShell`/`LiveBar` if now unused.

- [ ] **Step 3: Build.** `cd frontend && CI=false npx craco build` → "Compiled successfully."

- [ ] **Step 4: Commit.**

```bash
git add frontend/src/pages/play/SlotGame.js
git commit -m "SlotGame: migrate to GameStage (docked bet + sticky timeline)"
```

---

### Task 8: Migrate the remaining stake/pick games (one commit each)

**Files (modify each, applying the Task 7 recipe):**
- `frontend/src/pages/play/WheelGame.js` — dock = `LiveBetPanel` + the clear-bets button; extras = `HistoryStrip`.
- `frontend/src/pages/play/DiceGame.js` — dock = up/seven/down selection + stake + place; extras = history.
- `frontend/src/pages/play/AndarBaharGame.js` — dock = Andar/Bahar selection + stake + place; extras = history.
- `frontend/src/pages/play/KenoGame.js` — **middle** keeps the number grid (picking numbers is gameplay); dock = stake + place; extras = paytable + history.
- `frontend/src/pages/play/BingoGame.js` — middle = card; dock = stake + place; extras = history.
- `frontend/src/pages/play/TargetGame.js` — dock = number picker + stake + place; extras = history.
- `frontend/src/pages/play/CardDuelGame.js` — dock = side selection + stake + place; extras = history.
- `frontend/src/pages/play/ChampionPokerGame.js` — dock = stake + place; extras = paytable + history.
- `frontend/src/pages/play/VideoPokerGame.js` — dock = stake + place; extras = paytable + history.
- `frontend/src/pages/play/slots/TripleFun777Game.js`, `Lucky8LineGame.js`, `JokerBonusGame.js` — same as SlotGame (dock = stake + place; extras = paytable/history).

**Interfaces:** each consumes `GameStage`; no new produced interface.

- [ ] **Step 1:** For each file above, apply the Task 7 recipe: read it, split into A/B/C, wrap in `GameStage`, move bet controls to `betDock`, extras to `extras`.
- [ ] **Step 2:** After each file, `cd frontend && CI=false npx craco build` → "Compiled successfully."
- [ ] **Step 3:** Commit per game: `git commit -m "<slug>: migrate to GameStage"`.

*(Split across subagents/commits; do not batch all into one commit — one reviewable deliverable per game.)*

---

### Task 9: Aviator — adapt bet/cash-out into the dock

**Files:**
- Modify: `frontend/src/pages/play/AviatorGame.js`

**Interfaces:** consumes `GameStage`.

- [ ] **Step 1: Read** `AviatorGame.js`. Middle (A) = the flight scene + multiplier + `all_bets` panel; dock (B) = the two `BetSlot` panels (bet / cancel / cash-out); extras (C) = history + rules.
- [ ] **Step 2: Wrap in `GameStage`.** Aviator has no `useLiveRound`; pass `live={{ phase: st?.phase, countdown, timings: { bet: st?.betting_seconds || 6 }, roundNumber: st?.round_number }}` using the fields Aviator already tracks. The two `BetSlot`s go in `betDock` (they remain interactive during flight for cash-out). Keep the flight scene in `children`.
- [ ] **Step 3:** Build → "Compiled successfully." Commit `git commit -m "Aviator: bet/cash-out in GameStage dock"`.

---

### Task 10: Checker — migrate + center Gold vs Steel pieces

**Files:**
- Modify: `frontend/src/pages/play/CheckerGame.js`

**Interfaces:** consumes `GameStage`.

- [ ] **Step 1: Read** `CheckerGame.js`. Find the Gold/Steel medallion rows / capture track that render off-center.
- [ ] **Step 2: Fix centering.** Ensure each medallion cell uses `flex items-center justify-center` and the board/track container is centered (`mx-auto`, equal column widths via `grid-cols-*` with `place-items-center`, no stray asymmetric padding/margins). Both Gold and Steel columns must be symmetric.
- [ ] **Step 3: Migrate** to `GameStage` per the Task 7 recipe (board in middle, stake+place in dock, history in extras).
- [ ] **Step 4:** Build → "Compiled successfully." Commit `git commit -m "Checker: migrate to GameStage + center Gold/Steel pieces"`.

---

### Task 11: Cleanup + full verification

**Files:**
- Modify: `frontend/src/components/play/PlayShell.js` (only if now unused by every game — otherwise leave for Roulette/any remaining consumer).

- [ ] **Step 1: Grep** remaining `PlayShell` consumers: `grep -rn "PlayShell" frontend/src/pages/play`. If only Roulette (which is exempt) or none use it, leave `PlayShell.js` as-is (do not delete — Roulette may import `HistoryStrip` from it). Confirm no game still renders the old inline `LiveBar` alongside `GameStage`.
- [ ] **Step 2: Full build.** `cd frontend && CI=false npx craco build` → "Compiled successfully."
- [ ] **Step 3: On-device checklist** (Android TWA + iOS PWA): sticky timeline stays pinned below the FunGame logo while scrolling; Place Bet always reachable without scrolling; result visible without scrolling up; last-5s ticks escalate + lock thunk at 0; timeline ramps amber→red; bottom nav hidden during play; dock clears the home indicator; Checker Gold/Steel centered.
- [ ] **Step 4: Commit** any cleanup. Deploy via the frontend deploy hook.

---

## Self-Review

- **Spec coverage:** Fit-to-screen shell → Tasks 6–10. Sticky timeline below logo → Tasks 3,4,6. Escalating alarm → Tasks 1,2,6. Bottom-nav hidden + merged header → Task 3,6. Aviator dock → Task 9. Roulette untouched → constraint + Task 11 grep. Checker centering → Task 10. Extras sheet → Task 5. All spec sections mapped. ✅
- **Placeholders:** Migration tasks use a **documented recipe** (Task 7) with a worked code example rather than repeating full before/after for 14 varied files whose current contents must be read at execution — each migration task states the exact file, the A/B/C split, and the specific controls that move to the dock. This is the pragmatic granularity; every task still ends in a build gate + commit.
- **Type/name consistency:** `alarmStep`, `useBettingAlarm({phase,countdown,roundNumber})`, `GameStage({game,balance,live,betDock,extras,labels,children})`, `StickyTimeline({phase,countdown,timings,labels})`, `BetDock`, `ExtrasSheet`, `--fg-header-h`, `sfx.tick(step)`, `sfx.betLock()` — used consistently across tasks. ✅
