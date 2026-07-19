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
  - **Comprehensive casino audio** via WebAudio synth (ambient + win/lose crowd reactions + per-game SFX).
- **Card games stability & realism (P0):** Teen Patti + Poker + Champion Poker must be **smooth** and **non-jarring**.
  - Fix animation/polling clashes causing flicker / state desync / rushed dealing.
  - Ensure reveal timelines stay aligned with server phases.
  - **MANDATORY:** run the testing agent after the bug fix (frontend + backend).
- **Slot differentiation (P0):** the 3 slot titles must look and feel **distinct** (real casino research), not reskins.
  - 777 Triple Fun → classic Vegas red/gold mechanical 3‑reel
  - Joker Bonus → purple/dark jester theme
  - Lucky 8 Line → Asian fortune red/gold theme with **8‑line win display**
  - Each gets its **own component** and bespoke animations/sounds.
- Defer **Master Prompt 1 enterprise admin/RBAC restructure** until after game polish is complete (confirmed).
- Keep **SMTP/SendGrid** in demo mode until credentials are provided at the end (confirmed).

**Current status (corrected):**
- ✅ Platform foundation + all 18 universal live games are running.
- ✅ Major visual/audio upgrades completed (thumbnails, Aviator, Roulette, Dice, sound engine).
- ⚠️ **P0 regression:** Card games (Teen Patti/Poker/Champion Poker) reported “unsmooth”/buggy; previous edits attempted but not verified.
- ⏳ Slot redesigns + win confetti polish not started.

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
- Slots (currently too similar): 777 Triple Fun, Joker Bonus, Lucky 8 Line (plus other slot titles)

---

### Phase LIVE‑4: Testing, Hardening, and Fixes
**Goal:** Stabilize the live platform across all games.

**Status:** ⚠️ PARTIAL / NEEDS UPDATE
- A previous test report exists (`/app/test_reports/iteration_4.json`), but the **card-game bug fix was not verified** with the mandatory testing agent after subsequent edits.
- This phase must be re-opened specifically for the reported card-game regression.

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

**Status:** 🔥 IN PROGRESS (must be verified)

**Primary suspected root cause**
- `useLiveRound.js` polling (≈1s) may be overwriting animation state mid-reveal, causing:
  - flicker/jumps
  - cards “re-dealing”
  - abrupt state resets

**Work items**
1. **Frontend smoothing / state management**
   - Audit and update:
     - `/app/frontend/src/pages/play/CardDuelGame.js`
     - `/app/frontend/src/pages/play/VideoPokerGame.js`
     - `/app/frontend/src/pages/play/ChampionPokerGame.js`
     - `/app/frontend/src/lib/useLiveRound.js`
   - Implement an animation-safe strategy (one or more):
     - derive card-reveal progress purely from server `phase` + `countdown` (no local re-deal state)
     - freeze per-round “presentation state” keyed by `round_number` until phase changes
     - ignore mid-phase outcome refreshes unless `round_number` advances
   - Ensure `FlipCard` usage does not re-mount unexpectedly (stable keys and stable layout slots).

2. **Backend/Timing validation**
   - Confirm `/app/backend/live_engines.py` card-game phase durations match frontend flip cadence.
   - Ensure state payloads are stable within a phase (no unnecessary reshaping that triggers re-render thrash).

3. **MANDATORY verification (immediately after fix)**
   - Run **testing agent** for both:
     - Backend: live endpoints + phase correctness
     - Frontend: card pages load + stable animations (no console errors)
   - Save a new test report under `/app/test_reports/` (next iteration number).

**Exit criteria**
- Teen Patti / Poker / Champion Poker deal and flip smoothly with no flicker.
- No state desync between server phase and presented cards.
- Testing agent confirms green.

---

### Phase LIVE‑7: Slot Games Redesign (3 Distinct Experiences)
**Goal (P0):** Make 777 Triple Fun, Joker Bonus, Lucky 8 Line visually and structurally different, inspired by real casino slots (without copying protected art).

**Status:** ⏳ NOT STARTED

**Approach**
- Create **separate components** (recommended) instead of a single `SlotGame.js` skin:
  - `/app/frontend/src/pages/play/slots/TripleFun777Game.js`
  - `/app/frontend/src/pages/play/slots/JokerBonusGame.js`
  - `/app/frontend/src/pages/play/slots/Lucky8LineGame.js`
- Shared low-level reel/spin logic can remain in a common module, but **UI layout, symbols, sounds, and win presentation must differ**.

**Theme specs (user-approved)**
1. **777 Triple Fun**
   - Classic Vegas red/gold, chrome trims, mechanical 3‑reel vibe
   - Bold “SEVENS” focus, lever/knob styling, incandescent glow
2. **Joker Bonus**
   - Purple/dark jester theme, neon accents
   - Joker wild emphasis, bonus meter / “jester laugh” styling
3. **Lucky 8 Line**
   - Asian fortune red/gold theme (lanterns/fortune motifs)
   - Explicit **8‑line win display** and line highlight animations

**Deliverables**
- Distinct symbol sets (vector/CSS-based or generated assets) + unique reel frames.
- Distinct spin SFX + win stingers (via `sound.js`).
- Distinct win animations (glow, shake, count-up, line highlights).

**Verification**
- Frontend testing agent: pages render, spins animate, no console errors.

---

### Phase LIVE‑8: Win Celebration Polish (Confetti / Coin Burst)
**Goal (P1):** Add delightful, modern win feedback across games.

**Status:** ⏳ NOT STARTED

**Work items**
- Enhance `/app/frontend/src/components/play/ResultBanner.js`:
  - Confetti burst on win
  - Coin sparkle/burst variant for big wins
  - Respect global mute and reduced-motion preferences

---

### Phase 4: Email Provider Integration (SendGrid/SMTP) — after credentials provided
**Status:** ⏸️ PENDING (user will provide credentials at the end)
- Keep demo verification code flow until credentials provided.

---

## 3) Next Actions
1. **P0: Fix card games regression (Teen Patti / Poker / Champion Poker)**
   - Implement animation-safe state + timing alignment.
   - **Run mandatory testing agent (frontend + backend)** and publish new test report.
2. **P0: Redesign 3 slot games into distinct components**
   - Implement themes + unique symbols/sounds/win animations.
   - Run frontend test pass.
3. **P1: Confetti/coin burst for wins**
   - Update `ResultBanner.js` and verify across a sample of games.
4. **Backlog (blocked by user inputs / priority):**
   - SMTP/SendGrid integration (credentials pending).
   - Master Prompt 1 enterprise admin/RBAC restructure (after games).

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
  - ⏳ Teen Patti / Poker / Champion Poker are smooth, non-flickery, non-rushed.
  - ⏳ Verified by **mandatory testing agent** after fix.
- Slots (P0):
  - ⏳ 777 Triple Fun, Joker Bonus, Lucky 8 Line are clearly differentiated in theme, layout, symbols, sounds, and win animations.
- Win polish (P1):
  - ⏳ Confetti/coin burst on wins in `ResultBanner`.

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
- 🔥 **IN PROGRESS:** Fix card-game “unsmooth” bug (Teen Patti/Poker/Champion Poker) + **mandatory testing agent** verification.
- ⏳ NOT STARTED: 3 slot redesigns (777 Triple Fun / Joker Bonus / Lucky 8 Line) into distinct components.
- ⏳ NOT STARTED: Confetti/coin burst win polish.
- ⏸️ BACKLOG/BLOCKED: Master Prompt 1 enterprise admin/RBAC restructure (deferred by user).
- ⏸️ PENDING: Real email provider integration (SendGrid/SMTP creds at end).

**Test credentials**
- Admin: `admin@fungame.app` / `FunGame@Admin2025`
- Player: `player@fungame.app` / `Player@123`
