# FunGame (Mobile‑first Web App) — Development Plan (Updated)

## 1) Objectives
- Deliver a **play‑chip‑only** FunGame PWA‑style web app (React + FastAPI + MongoDB) with premium, original UI and the disclaimer: **“PLAY CHIPS — NO CASH VALUE”**.
- Maintain the **core foundation** already built:
  - Auth + onboarding approval flow
  - Admin console (basic)
  - Server-authoritative chip ledger
  - Game catalog (18 games)
  - Player app UX (mobile‑first)
- **Primary objective (P0): ALL 18 games run as universal, server-synchronized live rounds 24/7**.
  - One global round state per game shared by all players.
  - Real-time sync via **polling (≈1s) + client-side interpolation**.
  - Standard loop timing for most games: **~20–30s cycles**.
- **Visual & audio premium polish (P0):** realistic casino feel across games.
  - Remove noisy UI status elements (e.g., “ENABLED” badges on thumbnails).
  - Flagship visual realism (Aviator plane, Roulette wheel/ball/table, Dice realism).
  - **Comprehensive casino audio** via WebAudio synth (ambient + win/lose crowd reactions + game-specific SFX).
- **Card games stability & realism (P0):** Teen Patti + Poker + Champion Poker must be **smooth** and **non-jarring**.
  - Fix animation/polling clashes causing flicker / state desync / rushed dealing.
  - Ensure reveal timelines stay aligned with server phases.
  - **MANDATORY:** run the testing agent after the bug fix (frontend + backend).
- **Slot differentiation (P0):** the 3 slot titles must look and feel **distinct** (real casino research), not reskins.
  - 777 Triple Fun → classic Vegas red/gold mechanical 3‑reel
  - Joker Bonus → purple/dark jester theme
  - Lucky 8 Line → Asian fortune red/gold theme with **8‑line win display**
  - Each gets its **own component** and bespoke animations/sounds.
- **Win celebration polish (P1):** add modern, satisfying win feedback (confetti/coin burst) across games.
- Defer **Master Prompt 1 enterprise admin/RBAC restructure** until after game polish is complete (confirmed).
- Keep **SMTP/SendGrid** in demo mode until credentials are provided at the end (confirmed).

**Current status (corrected):**
- ✅ Platform foundation + all 18 universal live games are running.
- ✅ Major visual/audio upgrades completed (thumbnails, Aviator, Roulette, Dice, sound engine).
- ✅ **Card games bug fixed + verified** (Teen Patti / Poker / No‑Hold / Champion Poker / Andar Bahar).
- ✅ **Slot redesigns completed + verified** (Triple Fun 777 / Joker Bonus / Lucky 8 Line now fully distinct cabinets).
- ✅ **Win confetti/coin burst completed + verified** (ResultBanner).
- ⏸️ Remaining work is backlog only (SMTP creds + enterprise admin restructure).

---

## 2) Implementation Steps

### Phase 1: Core Flow POC (Isolation) — Email verification + onboarding approval + chip request lifecycle
**Goal:** Prove the most failure‑prone workflow (multi-role state machine + notifications) works end-to-end before building full UI.

**Status:** ✅ DONE
- Verified via automated tests.

---

### Phase 2: V1 App Development (Full UX + Admin Panel)
**Goal:** Build the complete foundation app (player + admin) with consistent navigation, design system, and gating rules.

**Status:** ✅ DONE
- Player app + admin panel implemented.
- 18 games seeded and enabled.

---

### Phase LIVE‑1: Universal Live Sync Backend (All 18 games)
**Goal:** Provide a single, universally synchronized 24/7 round stream per game. Outcomes are generated once per (slug, round_number) and shared globally.

**Status:** ✅ COMPLETED

**User-confirmed design choices**
- ✅ Focus 100% on live games now; enterprise admin later.
- ✅ Use polling (≈1s) + client interpolation.
- ✅ Standard loop timing for non-aviator games (~20–30s).

**Architecture (implemented)**
- **Fixed-cycle games (16):** epoch-derived clocks with phases **BETTING → REVEAL → RESULT**.
  - Deterministic round number + phase by `time.time()`.
  - Universal outcome generated once per (slug, round_number) and stored in MongoDB (unique index).
  - Lazy, idempotent settlement on state polling.
- **Aviator (variable-length):** DB-chained rounds + background keepalive task.
  - Round phases: **BETTING (6s) → FLYING → CRASHED (4s)**.
  - Crash point pre-committed per round.
  - Manual cashout + auto-cashout settlement.

**Backend deliverables (implemented)**
- `/app/backend/live_engines.py`
- `/app/backend/routes_live.py`
- `/app/backend/server.py`
- `/app/backend/routes_games.py`

**Data collections (implemented)**
- `live_outcomes`, `live_bets` for fixed-cycle games.
- `aviator_rounds`, `aviator_bets` for Aviator.
- `game_rounds` remains the canonical per-user settled history record.

---

### Phase LIVE‑2: Aviator (Spribe‑style) + Roulette UI/Timing
**Goal:** Deliver the two flagship live games with polished mobile-first UX.

**Status:** ✅ COMPLETED

**Aviator frontend (`/app/frontend/src/pages/play/AviatorGame.js`)**
- Universal live rounds + smooth multiplier interpolation.
- Dual bet panels + auto cashout + bet queueing.
- Visual: custom plane asset integrated.

**Roulette frontend (`/app/frontend/src/pages/play/RouletteGame.js`)**
- Matches backend 30s loop.
- Realistic wheel/ball motion and classic European table layout.

---

### Phase LIVE‑3: Convert Remaining Games to Live Rounds
**Goal:** Convert all remaining game UIs and APIs to consume the universal live endpoints.

**Status:** ✅ COMPLETED

**Shared frontend infrastructure (implemented)**
- `/app/frontend/src/lib/useLiveRound.js`
- `/app/frontend/src/components/play/LiveBar.js`

**Converted games (implemented)**
- Dice: Seven-Up-Down
- Card: Teen Patti, Poker, No Hold, Champion Poker, Andar Bahar
- Others: Keno, Bingo, etc.
- Slots: fever-joker-bonus, giant-jackpot, triple-fun, joker-bonus, lucky-8-line

---

### Phase LIVE‑4: Testing, Hardening, and Fixes
**Goal:** Stabilize the live platform across all games.

**Status:** ✅ UPDATED / REGRESSIONS CLOSED
- Card game regression fixed and verified with mandatory testing agent:
  - Report: **`/app/test_reports/iteration_5.json`**
  - Backend: 100% (15/15)
  - Frontend: 100% (all 5 card games verified smooth, bets work, no console errors)
- Slot redesign + win celebration verification:
  - Report: **`/app/test_reports/iteration_6.json`**
  - Backend: 100% (6/6)
  - Frontend: 100% (all 3 new slot cabinets verified distinct with staggered stops; betting + refunds; Teen Patti regression clean)

---

### Phase LIVE‑5: Visual & Audio Polish
**Goal:** Raise realism and premium feel across the app.

**Status:** ✅ COMPLETED

**Delivered changes (implemented)**
- Removed **ENABLED** badge from player-facing thumbnails/details.
- Aviator plane asset integrated.
- Roulette upgraded: wheel + ball animation, counterclockwise wheel behavior, custom table.
- Dice realism: 3D rolling + real dice visuals.
- Sound for all games:
  - `/app/frontend/src/lib/sound.js` WebAudio synth engine
  - Ambient casino bed + win/lose crowd reactions + per-game cues
  - Global mute toggle persisted in `localStorage`

---

### Phase LIVE‑6: Card Games — Bug Fix + Smoothing (Teen Patti / Poker / Champion Poker)
**Goal (P0):** Fix the user-reported “unsmooth gameplay”/buggy flow by preventing polling updates from interrupting flip/deal animations and by ensuring server phase timings align with the frontend reveal timeline.

**Status:** ✅ COMPLETED + VERIFIED

**Root cause (confirmed)**
- `useLiveRound.js` was re-anchoring the countdown deadline on every poll. Network jitter caused `countdown` to jump, making derived `elapsed` time non-monotonic. This **un-triggered** `FlipCard` deal/flip thresholds (cards appearing/disappearing, flipping back, re-dealing flicker).

**Fix (implemented)**
1. **Anchored deadlines per phase**
   - Deadline now anchors once per `(round_number, phase)` and only re-syncs if drift exceeds ~450ms.
2. **Monotonic reveal clock + consumers updated**
   - New `revealElapsed` monotonic inside REVEAL.
   - `revealProgress` now derived from the monotonic clock (helps games like Bingo/Keno/Checker too).
   - Updated to consume `revealElapsed`:
     - `/app/frontend/src/pages/play/CardDuelGame.js` (Teen Patti + Poker)
     - `/app/frontend/src/pages/play/VideoPokerGame.js` (No-Hold)
     - `/app/frontend/src/pages/play/ChampionPokerGame.js`
     - `/app/frontend/src/pages/play/AndarBaharGame.js`
3. **Tight phase transition**
   - Boundary poll triggers at countdown==0 to reduce “late phase switch” feel.
4. **Second timing fix discovered during slot verification**
   - `revealElapsed` now reads `deadlineRef` directly (anchored synchronously in `applyState`) so the **first REVEAL render never sees stale betting-phase countdown** (previously could make reels appear pre-stopped at reveal start).

**Mandatory verification (completed)**
- Testing agent run and recorded in **`/app/test_reports/iteration_5.json`** (backend + frontend).

---

### Phase LIVE‑7: Slot Games Redesign (3 Distinct Experiences)
**Goal (P0):** Make 777 Triple Fun, Joker Bonus, Lucky 8 Line visually and structurally different, inspired by real casino slots (without copying protected art).

**Status:** ✅ COMPLETED + VERIFIED

**Delivered implementation**
- New shared reel utilities:
  - `/app/frontend/src/pages/play/slots/reelKit.js`
    - Seeded PRNG for deterministic decorative symbols
    - Staggered reel stop times: `reveal*0.42 + i*reveal*0.2`
    - `SpinStrip` + `SettledCell` primitives
- Three distinct cabinet components:
  1. `/app/frontend/src/pages/play/slots/TripleFun777Game.js`
     - Classic Vegas: red/gold marquee with blinking bulbs, chrome bezel, ivory mechanical reels with BAR/777 symbols, animated pull lever, classic paytable.
  2. `/app/frontend/src/pages/play/slots/JokerBonusGame.js`
     - Dark jester: violet neon flicker title with `VenetianMask`, harlequin diamond backdrop, neon fruit reels, **3-segment JOKER METER** that lights as wilds land + jester-laugh styling.
  3. `/app/frontend/src/pages/play/slots/Lucky8LineGame.js`
     - Asian fortune: crimson/gold cabinet, swaying lanterns, full **3×3 symbol grid** with deterministic decorative rows seeded by `round_number`, **8 numbered chasing line lamps**, center-line win emphasis.
- Routing wired:
  - `/app/frontend/src/pages/play/GamePlay.js`
    - `triple-fun` → `TripleFun777Game`
    - `joker-bonus` → `JokerBonusGame`
    - `lucky-8-line` → `Lucky8LineGame`
    - `fever-joker-bonus` & `giant-jackpot` remain on generic `SlotGame`

**New CSS animations (implemented)**
- `/app/frontend/src/App.css`
  - Reel scroll + blur
  - Bulb blink
  - Neon flicker
  - Lantern sway
  - Line flash
  - Win glow

**New slot SFX (implemented)**
- `/app/frontend/src/lib/sound.js` additions:
  - `lever`, `reelStop`, `slotBell`, `lever777`, `jokerLaugh`, `jokerSpin`, `gong`, `coinShower`, `luckySpin`

**Verification**
- Testing agent report: **`/app/test_reports/iteration_6.json`**
  - Verified distinct UIs, staggered stops via timed screenshots, betting + clear-bets refunds.

---

### Phase LIVE‑8: Win Celebration Polish (Confetti / Coin Burst)
**Goal (P1):** Add delightful, modern win feedback across games.

**Status:** ✅ COMPLETED + VERIFIED

**Delivered implementation**
- `/app/frontend/src/components/play/ResultBanner.js`
  - Confetti burst on wins (18 flecks)
  - Big-win variant: 32 pieces with gold coins when `payout >= total_bet * 5`
  - Deterministic per index; animates only transform/opacity
  - Respects `prefers-reduced-motion`
- `/app/frontend/src/lib/useLiveRound.js`
  - Adds `result.big` flag in the settled banner payload.

**Verification**
- Included in testing agent report **`iteration_6.json`**.
- Additionally visually confirmed via a Seven-Up-Down win screenshot (confetti visible inside the win banner).

---

### Phase 4: Email Provider Integration (SendGrid/SMTP) — after credentials provided
**Status:** ⏸️ PENDING (user will provide credentials at the end)
- Keep demo verification code flow until credentials provided.

---

## 3) Next Actions
1. **P2 (Backlog): SMTP/SendGrid integration**
   - Await credentials from user.
   - Switch email verification from demo mode to real delivery.
   - Run backend + frontend testing agent after integration.
2. **P2 (Backlog): Master Prompt 1 enterprise admin restructure**
   - Await user priority confirmation.
   - Implement strict RBAC, maker-checker workflows, and TOTP.
   - Add full regression test pass.

---

## 4) Success Criteria
- Platform-level:
  - Clear disclaimer: **PLAY CHIPS — NO CASH VALUE** across player app.
  - Chips remain server-authoritative; no client-side balance edits.
  - No deposit/withdraw/cash-out/payment routes exist.
- Live games:
  - ✅ **All 18 games run 24/7 universal synchronized rounds**.
  - ✅ Every player sees the same round number/phase/outcome per game.
  - ✅ Betting locks correctly at phase boundaries.
  - ✅ Settlement is idempotent and ledger-consistent.
- UX polish:
  - ✅ ENABLED badge hidden on player-facing thumbnails/details.
  - ✅ Premium flagship visuals: Aviator plane, Roulette realism, Dice realism.
  - ✅ Sound enabled for all games with global mute.
- Card games (P0):
  - ✅ Teen Patti / Poker / Champion Poker are smooth, non-flickery, non-rushed.
  - ✅ Verified by **mandatory testing agent** after fix (**iteration_5.json**).
- Slots (P0):
  - ✅ 777 Triple Fun, Joker Bonus, Lucky 8 Line are clearly differentiated in theme, layout, symbols, sounds, and win animations.
  - ✅ Verified by testing agent (**iteration_6.json**).
- Win polish (P1):
  - ✅ Confetti/coin burst on wins in `ResultBanner`.

---

## STATUS LOG
- ✅ Phase 1 POC complete: core workflows green in tests.
- ✅ Phase 2 complete: player app + admin console delivered.
- ✅ All 18 games converted to **universal 24/7 live rounds** (backend + frontend).
- ✅ Aviator Spribe-style universal live rounds implemented + custom plane asset.
- ✅ Roulette upgraded (30s loop + realistic wheel/ball + custom table).
- ✅ Game thumbnail logos cropped/applied; ENABLED badges removed from player UI.
- ✅ Dice games upgraded with real dice visuals + rolling effects.
- ✅ WebAudio sound engine (`sound.js`) added with ambient + crowd reactions.
- ✅ **Card games regression fixed + verified** (deadline anchoring + monotonic `revealElapsed` + boundary poll + stale-countdown fix). Test report: **`/app/test_reports/iteration_5.json`**.
- ✅ **Slot redesigns completed + verified** (Triple Fun 777 / Joker Bonus / Lucky 8 Line distinct cabinets + reelKit + slot SFX + CSS animations). Test report: **`/app/test_reports/iteration_6.json`**.
- ✅ **Win celebration confetti/coin burst completed + verified** (ResultBanner + `result.big`). Included in **iteration_6.json**; also visually confirmed on a win.
- ⏸️ BACKLOG/BLOCKED: Master Prompt 1 enterprise admin/RBAC restructure (deferred by user).
- ⏸️ PENDING: Real email provider integration (SendGrid/SMTP creds at end).

**Test credentials**
- Admin: `admin@fungame.app` / `FunGame@Admin2025`
- Player: `player@fungame.app` / `Player@123`
