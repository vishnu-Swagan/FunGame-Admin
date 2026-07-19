# FunGame (Mobile‑first Web App) — Development Plan (Updated)

## 1) Objectives
- Deliver a **play‑chip‑only** FunGame PWA‑style web app (React + FastAPI + MongoDB) with premium, original UI and the disclaimer: **“PLAY CHIPS — NO CASH VALUE”**.
- Maintain the **core foundation** already built:
  - Auth + onboarding approval flow (legacy)
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
- **Email delivery (P1):** use a real transactional email provider for password resets and system notifications.
  - Resend is integrated.
  - Note: `onboarding@resend.dev` is **Resend TEST MODE** sender; real-user deliverability requires domain verification + updating `SENDER_EMAIL`.

### NEW Objectives (P0) — Account Provisioning + Points Economy
- **Admin‑provisioned accounts (P0):** new users do **NOT** receive a password at signup.
  - New users submit a **signup request** with: **Full Name, Email ID, Date of Birth, Phone Number (with country code)**.
  - Admin verifies and **assigns unique Login ID (username) + password**.
  - Login accepts **username OR email** (legacy accounts keep email login).
  - Signup no longer depends on email verification for onboarding; admin-created users are **pre‑verified**.
  - Resend remains for **password reset**.
- **Chips ⇄ Points conversion (P0):**
  - Users can **sell chips to admin and receive points instantly**.
  - **Minimum conversion amount: 500**.
  - **Rate: 1 chip = 1 point**.
  - **Bidirectional** conversion supported (**points → chips** also allowed, same rate).
  - Points are shown on profile/admin and have their own transaction log.

**Current status (corrected):**
- ✅ Platform foundation + all 18 universal live games are running.
- ✅ Major visual/audio upgrades completed (thumbnails, Aviator, Roulette realism + 3D, Dice realism, sound engine).
- ✅ Card games bug fixed + verified (Teen Patti / Poker / No‑Hold / Champion Poker / Andar Bahar).
- ✅ Slot redesigns completed + verified (Triple Fun 777 / Joker Bonus / Lucky 8 Line now fully distinct cabinets).
- ✅ Win confetti/coin burst completed + verified (ResultBanner).
- ✅ Roulette betting UX upgraded: chips now land centered on bet spots; split/corner bet hit‑zones + backend validation.
- ✅ 2026 polish additions: auto-fit rendering on any mobile device (FitWidth), roulette cinematic camera zoom during spin, background music disabled, Aviator sound set to flight-engine only.
- ✅ Resend email integration completed + verified (verification/reset email delivery; demo mode replaced).
- 🟡 **NEW (IN PROGRESS): LIVE‑10 Points economy + admin-provisioned accounts**.
- ⏸️ Remaining backlog: Resend domain verification for real deliverability + enterprise admin restructure.

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

---

### Phase LIVE‑2: Aviator (Spribe‑style) + Roulette UI/Timing
**Goal:** Deliver the two flagship live games with polished mobile-first UX.

**Status:** ✅ COMPLETED

---

### Phase LIVE‑3: Convert Remaining Games to Live Rounds
**Goal:** Convert all remaining game UIs and APIs to consume the universal live endpoints.

**Status:** ✅ COMPLETED

---

### Phase LIVE‑4: Testing, Hardening, and Fixes
**Goal:** Stabilize the live platform across all games.

**Status:** ✅ UPDATED / REGRESSIONS CLOSED
- Card game regression fixed and verified with mandatory testing agent:
  - Report: **`/app/test_reports/iteration_5.json`**
- Slot redesign + win celebration verification:
  - Report: **`/app/test_reports/iteration_6.json`**

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

---

### Phase LIVE‑6: Card Games — Bug Fix + Smoothing (Teen Patti / Poker / Champion Poker)
**Goal (P0):** Fix user-reported “unsmooth gameplay” by preventing polling updates from interrupting deal/flip animations.

**Status:** ✅ COMPLETED + VERIFIED
- Root cause: non-monotonic reveal timeline due to deadline re-anchoring each poll.
- Fix: anchored deadline per phase + monotonic `revealElapsed` + boundary poll + stale-countdown fix.
- Verification: **`/app/test_reports/iteration_5.json`**.

---

### Phase LIVE‑7: Slot Games Redesign (3 Distinct Experiences)
**Goal (P0):** Make 777 Triple Fun, Joker Bonus, Lucky 8 Line visually and structurally different.

**Status:** ✅ COMPLETED + VERIFIED
- Implemented 3 bespoke cabinet components + reelKit.
- Verification: **`/app/test_reports/iteration_6.json`**.

---

### Phase LIVE‑8: Win Celebration Polish (Confetti / Coin Burst)
**Goal (P1):** Add delightful win feedback across games.

**Status:** ✅ COMPLETED + VERIFIED

---

### Phase 4: Email Provider Integration (Resend) — real delivery for verification/reset
**Goal (P1):** Replace demo email verification with real transactional delivery.

**Status:** ✅ COMPLETED + VERIFIED
- Resend provider added + branded HTML templates + graceful failure handling.
- Verification: **`/app/test_reports/iteration_7.json`** + follow-up curl verification.

---

### Phase LIVE‑9: 2026 UX Polish — Responsive rendering + Camera + Sound tuning
**Goal:** Make the app render perfectly across all mobile device sizes and add cinematic game presentation.

**Status:** ✅ COMPLETED + VERIFIED

**Delivered**
- **Auto-fit rendering on any mobile screen**
  - New `FitWidth` component + applied to roulette board, 3 slot cabinets, and 5-card rows.
  - `viewport-fit=cover` added.
  - `overflow-x: hidden` guard.
- **Roulette cinematic camera**
  - Dolly-in zoom (scale ~1.34) during spin; pull-back after result.
- **Sound changes**
  - Background casino music disabled.
  - Aviator uses **flight engine only** (multiplier-driven pitch climb + doppler fly-away); all other Aviator sounds disabled.

**Verification**
- Frontend regression report: **`/app/test_reports/iteration_8.json`**.

---

### Phase LIVE‑10: Points Economy + Admin‑Provisioned Accounts (NEW)
**Goal (P0):** Implement conversion between chips and points, and change signup to an admin‑approved provisioning model.

**Status:** 🟡 IN PROGRESS

#### LIVE‑10A — Chips ⇄ Points conversion (instant)
**Backend**
- Data model:
  - Add `points_balance: int` to `users` (default 0) OR introduce a dedicated `points_balance` field while keeping chips separate.
  - Add new collection `points_transactions` (ledger-style log) OR extend `chip_transactions` with an additional currency field.
- New player endpoint:
  - `POST /api/player/chips/convert`
    - Body: `{ direction: 'CHIPS_TO_POINTS'|'POINTS_TO_CHIPS', amount: int }`
    - Enforce **min amount 500**.
    - Atomic balance checks and updates.
    - Write transaction entries for both sides.
- Admin UI/data:
  - Admin should see points balance per user.
  - Admin can adjust points if needed (`POST /api/admin/users/{id}/points/adjust`).

**Frontend**
- Player:
  - Chips page: add **Points card** + converter UI.
  - Profile: show points and chips.
- Admin:
  - Users list: show points balance + adjust action.

#### LIVE‑10B — Signup request + admin assigned login/password
**New flow**
1. Player submits **Signup Request**:
   - Full Name, Email, Date of Birth, Phone with country code.
2. Admin reviews request, then **assigns unique Login ID + password**.
3. User logs in with **Login ID (preferred)** or email (legacy).

**Backend**
- Models to add:
  - `SignupRequestCreate` (full_name, email, dob, phone)
  - `AdminSignupApprove` (login_id, password, starting_chips?, note?)
- Auth changes:
  - `/auth/register` becomes disabled for new users (return `410 Gone` or a message telling to use signup request).
  - New public endpoint: `POST /auth/signup-request`.
  - Login request model changes: `LoginRequest.email` becomes a generic `identifier: str` (username or email).
  - Login logic: find by `login_id` OR `email`.
- Admin endpoints:
  - `GET /admin/signup-requests` (list PENDING)
  - `POST /admin/signup-requests/{id}/approve` → create ACTIVE user with `login_id` and `password_hash`, pre-verified
  - `POST /admin/signup-requests/{id}/reject`
  - Stats: add `pending_signups` count.

**Frontend**
- Replace `Register.js` with "Request Account" form (Full Name/Email/DOB/Phone).
- Update `Welcome.js` call-to-action to "Request Account".
- Update `Login.js`: field label "Login ID or Email".
- Admin:
  - Add `AdminSignups.js` page with approve dialog (generate username/password) and reject.
  - Add Admin nav item + route in `App.js`.

**Testing (MANDATORY due to auth change)**
- Backend tests:
  - Create signup request → approve → login with username → access player routes.
  - Reject flow.
  - Legacy email login still works.
  - Conversion endpoint (both directions) min 500 enforcement.
- Frontend tests:
  - Signup request UI → admin approves → login using assigned ID.
  - Chips ↔ points conversion UI.

---

## 3) Next Actions
1. **P0: Complete LIVE‑10**
   - Implement chips ⇄ points conversion + admin visibility/adjustment.
   - Replace register with signup request flow + admin provisioning.
   - Run mandatory testing agent regression across backend + frontend.
2. **P1: Resend production deliverability**
   - Verify sending domain in Resend.
   - Update `SENDER_EMAIL`.
   - Smoke test register/request + reset flows.
3. **P2 (Backlog): Master Prompt 1 enterprise admin restructure**
   - Strict RBAC, maker-checker workflows, TOTP.

---

## 4) Success Criteria
- Platform-level:
  - Clear disclaimer: **PLAY CHIPS — NO CASH VALUE** across player app.
  - Chips remain server-authoritative; no client-side balance edits.
  - No deposit/withdraw/cash-out/payment routes exist.
- Live games:
  - ✅ All 18 games run 24/7 universal synchronized rounds.
  - ✅ Every player sees the same round number/phase/outcome per game.
- UX polish:
  - ✅ Premium flagship visuals, 3D roulette, dice realism.
  - ✅ Responsive on any mobile screen.
  - ✅ Roulette cinematic camera.
  - ✅ Background music disabled.
  - ✅ Aviator sound = flight engine only.
- Economy:
  - 🟡 Chips ⇄ points conversion works instantly, min 500, 1:1, with full transaction logs.
- Account provisioning:
  - 🟡 Signup request → admin assigns login/password → user logs in via login ID.
  - ✅ Legacy accounts can still log in via email.
- Testing:
  - Mandatory testing agent run after LIVE‑10 changes (auth + economy).

---

## STATUS LOG
- ✅ Phase 1 POC complete.
- ✅ Phase 2 complete.
- ✅ All 18 games converted to universal 24/7 live rounds.
- ✅ Roulette upgraded to realistic + 3D + improved betting UX.
- ✅ Card games bug fixed + verified (**iteration_5.json**).
- ✅ Slot redesigns verified (**iteration_6.json**).
- ✅ Resend integration verified (**iteration_7.json**).
- ✅ Responsive + roulette camera + sound changes verified (**iteration_8.json**).
- 🟡 **LIVE‑10 started:** points economy + admin-provisioned accounts.
- ⏸️ Backlog: Resend domain verification, enterprise admin restructure.

**Test credentials**
- Admin: `admin@fungame.app` / `FunGame@Admin2025`
- Player: `player@fungame.app` / `Player@123`
