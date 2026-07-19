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
  - Flagship visual realism (Aviator plane, Roulette 3D wheel/ball/table, Dice realism).
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
- **Email delivery (P1):** use a real transactional email provider for verification/reset codes.
  - Resend is now integrated (replaces demo mode).
  - Note: `onboarding@resend.dev` is **Resend TEST MODE** sender; real-user deliverability requires domain verification + updating `SENDER_EMAIL`.

**Current status (corrected):**
- ✅ Platform foundation + all 18 universal live games are running.
- ✅ Major visual/audio upgrades completed (thumbnails, Aviator, Roulette realism + 3D, Dice realism, sound engine).
- ✅ **Card games bug fixed + verified** (Teen Patti / Poker / No‑Hold / Champion Poker / Andar Bahar).
- ✅ **Slot redesigns completed + verified** (Triple Fun 777 / Joker Bonus / Lucky 8 Line now fully distinct cabinets).
- ✅ **Win confetti/coin burst completed + verified** (ResultBanner).
- ✅ **Roulette betting UX upgraded**: chips now land centered on bet spots; added split/corner bet hit‑zones + backend validation.
- ✅ **Resend email integration completed + verified** (verification/reset email delivery; demo mode replaced).
- ⏸️ Remaining work is backlog only (domain verification for Resend deliverability + enterprise admin restructure).

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
- Roulette upgraded:
  - Classic European table
  - Counterclockwise wheel behavior
  - Realistic ball motion + audio
  - **3D Roulette wheel scene (pure CSS 3D, no new deps)**
  - **Improved betting UX**: chips land centered; split/corner hit‑zones
- Dice realism: 3D rolling + real dice visuals.
- Sound for all games:
  - `/app/frontend/src/lib/sound.js` WebAudio synth engine
  - Ambient casino bed + win/lose crowd reactions + per-game cues
  - Global mute toggle persisted in `localStorage`

**3D Roulette wheel (completed, verified)**
- File: `/app/frontend/src/pages/play/RouletteGame.js`
- Implemented using CSS transforms with `perspective` and `preserve-3d`:
  1. **Perspective scene** (~860px) with wheel head tilted (`rotateX(52deg)`)
  2. **RimWall3D**: 12 stacked ring layers extruding a wooden bowl wall below the wheel face + soft ground shadow (`translateZ(-30px)`)
  3. **Turret3D**: raised golden turret (stacked discs) + cross-handles and knob at `translateZ(20–24px)` that rotates with the wheel
  4. **Ball physics upgraded to 3D**: ball transitions from rim track height to pocket height (`translateZ(20px → 5px)`) with small vertical hops synced to deflector bounces
  5. Pointer + winning-number badge remain **screen-space overlays** above the tilted scene

**Roulette bet placement flexibility (completed, verified)**
- Frontend:
  - Chips render centered on the spot (`BetChip` with framer-motion toss)
  - Added invisible hit‑zones:
    - **Split**: tap the line between 2 adjacent numbers
    - **Corner**: tap the cross where 4 numbers meet
- Backend:
  - Added validation + payouts:
    - `split` → 18x
    - `corner` → 9x
  - Validates adjacency/shape (incl. `0-1-2-3` first four; zero splits `0-1/2/3`)

---

### Phase LIVE‑6: Card Games — Bug Fix + Smoothing (Teen Patti / Poker / Champion Poker)
**Goal (P0):** Fix the user-reported “unsmooth gameplay”/buggy flow by preventing polling updates from interrupting flip/deal animations and by ensuring server phase timings align with the frontend reveal timeline.

**Status:** ✅ COMPLETED + VERIFIED

**Root cause (confirmed)**
- `useLiveRound.js` was re-anchoring the countdown deadline on every poll. Network jitter caused `countdown` to jump, making derived `elapsed` time non-monotonic. This **un-triggered** `FlipCard` deal/flip thresholds (cards appearing/disappearing, flipping back, re-dealing flicker).

**Fix (implemented)**
1. **Anchored deadlines per phase**
   - Deadline anchors once per `(round_number, phase)` and only re-syncs if drift exceeds ~450ms.
2. **Monotonic reveal clock + consumers updated**
   - New `revealElapsed` monotonic inside REVEAL.
   - `revealProgress` derived from the monotonic clock.
   - Updated to consume `revealElapsed`:
     - `/app/frontend/src/pages/play/CardDuelGame.js` (Teen Patti + Poker)
     - `/app/frontend/src/pages/play/VideoPokerGame.js` (No-Hold)
     - `/app/frontend/src/pages/play/ChampionPokerGame.js`
     - `/app/frontend/src/pages/play/AndarBaharGame.js`
3. **Tight phase transition**
   - Boundary poll triggers at countdown==0.
4. **Second timing fix discovered during slot verification**
   - `revealElapsed` reads `deadlineRef` directly so the first REVEAL render never sees stale betting-phase countdown.

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
     - Dark jester: violet neon flicker title with `VenetianMask`, harlequin diamond backdrop, neon fruit reels, **3-segment JOKER METER**.
  3. `/app/frontend/src/pages/play/slots/Lucky8LineGame.js`
     - Asian fortune: crimson/gold cabinet, swaying lanterns, full **3×3 symbol grid**, **8 numbered chasing line lamps**, center-line win emphasis.
- Routing wired:
  - `/app/frontend/src/pages/play/GamePlay.js`
    - `triple-fun` → `TripleFun777Game`
    - `joker-bonus` → `JokerBonusGame`
    - `lucky-8-line` → `Lucky8LineGame`
    - `fever-joker-bonus` & `giant-jackpot` remain on generic `SlotGame`

**New CSS animations (implemented)**
- `/app/frontend/src/App.css`
  - Reel scroll + blur, bulb blink, neon flicker, lantern sway, line flash, win glow

**New slot SFX (implemented)**
- `/app/frontend/src/lib/sound.js` additions:
  - `lever`, `reelStop`, `slotBell`, `lever777`, `jokerLaugh`, `jokerSpin`, `gong`, `coinShower`, `luckySpin`

**Verification**
- Testing agent report: **`/app/test_reports/iteration_6.json`**.

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

---

### Phase 4: Email Provider Integration (Resend) — real delivery for verification/reset
**Goal (P1):** Replace demo email verification with **real transactional delivery** for verification and password reset.

**Status:** ✅ COMPLETED + VERIFIED

**Delivered implementation**
- Dependency:
  - Installed `resend==2.34.0`
  - Backend `requirements.txt` updated
- Configuration (`/app/backend/.env`):
  - `EMAIL_PROVIDER="resend"`
  - `RESEND_API_KEY="(user-provided)"`
  - `SENDER_EMAIL="onboarding@resend.dev"`
  - Fixed a malformed `.env` line where `CORS_ORIGINS` and `JWT_SECRET` were previously merged.
- Backend implementation:
  - `/app/backend/email_service.py`
    - Added `resend` provider using `asyncio.to_thread(resend.Emails.send, params)` (non-blocking)
    - Branded HTML templates (inline CSS + table layout; includes PLAY CHIPS disclaimer)
    - Graceful error handling returning `{sent: false, provider: 'resend'}` on failure
  - `/app/backend/routes_auth.py`
    - `/register` (new + re-register), `/resend-verification`: surface `email_delivery: 'failed'` + friendly message when Resend rejects recipient (common in test-mode)
    - `/forgot-password`: keeps anti-enumeration generic response (no deliverability leakage)
    - `dev_code` no longer exposed when provider != demo (`is_dev_mode` false)
- Frontend polish:
  - `/app/frontend/src/pages/auth/Register.js` and `/VerifyEmail.js`: show warning toast when `email_delivery === 'failed'` using server message.

**Verification**
- Direct send path verified (Resend test inbox): `delivered@resend.dev` returned real `email_id`s.
- Testing agent report: **`/app/test_reports/iteration_7.json`** (initially 10/11 due to a re-register response gap).
- Follow-up fix applied to re-register path and re-verified via curl (delivery failure now correctly surfaced).

**Important caveat / deliverability constraint**
- Using `SENDER_EMAIL=onboarding@resend.dev` runs in **Resend TEST MODE**:
  - Emails only deliver to the Resend account owner’s verified addresses and Resend test inboxes (e.g. `delivered@resend.dev`).
  - For real user delivery: verify a domain in Resend and set `SENDER_EMAIL=noreply@yourdomain.com`.

---

## 3) Next Actions
1. **P1: Resend production deliverability**
   - User verifies a sending domain at resend.com → Domains.
   - Update `/app/backend/.env`: `SENDER_EMAIL` to the verified domain sender.
   - (Optional) Add DKIM/SPF/DMARC best practices as per Resend domain setup.
   - Run a backend + frontend smoke test (register/verify/reset flows).
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
  - ✅ Premium flagship visuals: Aviator plane, **Roulette 3D wheel + ball**, Dice realism.
  - ✅ Roulette bet placement feels like real felt: centered chips + split/corner line/cross hit-zones.
  - ✅ Sound enabled for all games with global mute.
- Card games (P0):
  - ✅ Teen Patti / Poker / Champion Poker are smooth, non-flickery, non-rushed.
  - ✅ Verified by **mandatory testing agent** after fix (**iteration_5.json**).
- Slots (P0):
  - ✅ 777 Triple Fun, Joker Bonus, Lucky 8 Line are clearly differentiated in theme, layout, symbols, sounds, and win animations.
  - ✅ Verified by testing agent (**iteration_6.json**).
- Win polish (P1):
  - ✅ Confetti/coin burst on wins in `ResultBanner`.
- Email (P1):
  - ✅ Resend integration operational; branded HTML emails for verification/reset.
  - ⚠️ Production deliverability depends on domain verification + updating `SENDER_EMAIL`.

---

## STATUS LOG
- ✅ Phase 1 POC complete: core workflows green in tests.
- ✅ Phase 2 complete: player app + admin console delivered.
- ✅ All 18 games converted to **universal 24/7 live rounds** (backend + frontend).
- ✅ Aviator Spribe-style universal live rounds implemented + custom plane asset.
- ✅ Roulette upgraded: realistic wheel/ball/table.
- ✅ **Roulette wheel upgraded to 3D** (CSS 3D scene + extruded bowl + 3D ball drops) — implemented in `RouletteGame.js`.
- ✅ **Roulette betting UX upgraded** (chips centered; split + corner line/cross hit zones; backend payouts/validation added).
- ✅ Game thumbnail logos cropped/applied; ENABLED badges removed from player UI.
- ✅ Dice games upgraded with real dice visuals + rolling effects.
- ✅ WebAudio sound engine (`sound.js`) added with ambient + crowd reactions.
- ✅ **Card games regression fixed + verified** (deadline anchoring + monotonic `revealElapsed` + boundary poll + stale-countdown fix). Test report: **`/app/test_reports/iteration_5.json`**.
- ✅ **Slot redesigns completed + verified** (Triple Fun 777 / Joker Bonus / Lucky 8 Line distinct cabinets + reelKit + slot SFX + CSS animations). Test report: **`/app/test_reports/iteration_6.json`**.
- ✅ **Win celebration confetti/coin burst completed + verified** (ResultBanner + `result.big`). Included in **iteration_6.json**.
- ✅ **Resend email integration completed** (replaces demo mode; branded HTML; graceful delivery failure surfacing; frontend warnings). Testing agent: **`/app/test_reports/iteration_7.json`** + follow-up fix verified.
- ⏸️ BACKLOG/BLOCKED: Master Prompt 1 enterprise admin/RBAC restructure (deferred by user).
- ⏳ NEXT: Verify Resend domain for real user deliverability and update `SENDER_EMAIL`.

**Test credentials**
- Admin: `admin@fungame.app` / `FunGame@Admin2025`
- Player: `player@fungame.app` / `Player@123`
