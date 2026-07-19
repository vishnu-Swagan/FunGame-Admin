# FunGame (Mobile‑first Web App) — Development Plan (Updated)

## 1) Objectives
- Deliver a **play‑chip‑only** FunGame PWA‑style web app (React + FastAPI + MongoDB) with premium, original UI and the disclaimer: **“PLAY CHIPS — NO CASH VALUE”**.
- Maintain the **core foundation** already built:
  - Auth + onboarding approval flow
  - Admin console
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
  - **Comprehensive casino audio** via WebAudio synth (ambient + win/lose crowd reactions + game-specific SFX), with user overrides.
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
- Defer **Master Prompt 1 enterprise admin/RBAC restructure** until after current P0s are complete.
- **Email delivery (P1):** use a real transactional email provider for password resets and system notifications.
  - Resend is integrated.
  - Note: `onboarding@resend.dev` is **Resend TEST MODE** sender; real-user deliverability requires domain verification + updating `SENDER_EMAIL`.

### NEW Objectives (P0) — Provisioning + Sessions + Economy Controls + Admin Audit
- **Admin‑provisioned accounts (P0):** new users do **NOT** receive a password at signup.
  - New users submit a **signup request** with: **Full Name, Email ID, Date of Birth, Phone Number (with country code)**.
  - Admin verifies and **assigns unique Login ID (username) + password**.
  - Login accepts **username OR email** (legacy accounts keep email login).
  - Admin-created users are **pre‑verified**.
  - Resend remains for **password reset**.
- **Single active login session per Login ID (P0):**
  - **Same Login ID/password cannot be used on another device at the same time.**
  - Enforce by storing `active_session_id` on the user doc and embedding `sid` in JWT.
  - If another device logs in, older tokens are rejected on their next API call with **401** + code **`SESSION_REPLACED`**.
  - Add `POST /api/auth/logout` to revoke the session (revoked-marker invalidates all tokens).
  - Frontend shows a clear “logged in on another device” message on the login screen.
- **Chips → Points conversion (P0): Admin-approved SELL requests (no instant conversion)**
  - Players submit a **SELL** request instead of converting instantly.
  - **Rate: 1 chip = 1 point.**
  - **Deduct chips ONLY on admin approval** (user-confirmed choice).
  - If user lacks chips at approval time, approval fails and request remains **PENDING**.
  - Continue to support **Points → Chips instant conversion** (unchanged).
  - Reuse `chip_requests` collection with a **`type` field: `BUY` | `SELL`**.
- **Admin audit visibility (P1):** Admin Users view shows:
  - Current chip balance, points balance
  - Total deposits (chip credits from approved BUY requests + welcome/provision credits)
  - Total winning chips (credits from game wins/cashouts)
  - Total loss chips (debits from bets; excluding refunds/cancel credits)

**Current status (corrected):**
- ✅ Platform foundation + all 18 universal live games are running.
- ✅ Major visual/audio upgrades completed (thumbnails, Aviator, Roulette realism + 3D, Dice realism, sound engine).
- ✅ Card games bug fixed + verified (Teen Patti / Poker / No‑Hold / Champion Poker / Andar Bahar).
- ✅ Slot redesigns completed + verified (Triple Fun 777 / Joker Bonus / Lucky 8 Line now fully distinct cabinets).
- ✅ Win confetti/coin burst completed + verified (ResultBanner).
- ✅ Roulette betting UX upgraded: split/corner hit‑zones + backend validation.
- ✅ 2026 polish additions: auto-fit rendering (FitWidth), roulette cinematic camera zoom, background music disabled, Aviator sound set to flight-engine only.
- ✅ Resend email integration completed + verified.
- ✅ LIVE‑10 completed + verified 100%: points economy + admin-provisioned accounts.
- ✅ **LIVE‑11 completed + verified**: single-session enforcement + admin-approved SELL requests + admin user ledger stats.

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
  - **Improved betting UX**: chips land centered; split/corner hit‑zones + backend validation
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
  - Aviator uses **flight engine only**.

**Verification**
- Frontend regression report: **`/app/test_reports/iteration_8.json`**.

---

### Phase LIVE‑10: Points Economy + Admin‑Provisioned Accounts
**Goal (P0):** Implement conversion between chips and points, and change signup to an admin‑approved provisioning model.

**Status:** ✅ COMPLETED + VERIFIED (100%)
- Verification: **`/app/test_reports/iteration_9.json`** (backend 24/24 + full frontend flows)

#### LIVE‑10A — Points economy baseline
**Status:** ✅ DELIVERED
- Users have `points_balance`.
- `points_transactions` ledger exists.
- Admin can adjust points with safeguards.

#### LIVE‑10B — Signup request + admin assigned login/password
**Status:** ✅ DELIVERED
- Public signup disabled.
- Signup requests + admin approval provisioning flow implemented.
- Login accepts username OR email.

---

### Phase LIVE‑11: Session Management + Manual Chip Selling + Admin Ledger Stats
**Goal (P0/P1):** Enforce single-session logins, shift chips→points to admin-approved SELL requests, and provide admin-wide aggregated user stats.

**Status:** ✅ COMPLETED + VERIFIED
- Verification: **`/app/test_reports/iteration_10.json`** (backend 30/30 pass; frontend flows verified)

#### LIVE‑11A (P0) — Single active login session per user (kick-out model)
**Implemented**
- Server-side session tracking:
  - `users.active_session_id` stored in MongoDB.
  - JWT includes `sid` claim.
- Login behavior (`POST /api/auth/login`):
  - Generates new session ID (`sid`) and stores it in `users.active_session_id`.
  - Invalidates prior sessions for that Login ID.
- Auth validation (`get_current_user`):
  - Compares token `sid` with `users.active_session_id`.
  - Mismatch → **401** with `detail.code = SESSION_REPLACED`.
- Logout endpoint (`POST /api/auth/logout`):
  - Sets `active_session_id` to a **revoked-marker**, invalidating all existing tokens.

**Frontend behavior**
- Axios interceptor catches `SESSION_REPLACED` and:
  - Clears token
  - Stores a one-time logout reason
  - Redirects to `/login`
- Login screen displays `data-testid="session-replaced-notice"` banner.
- `AuthContext.logout()` calls `/auth/logout` best-effort before clearing local auth.

#### LIVE‑11B (P0) — Chips → Points becomes admin-approved SELL request (1:1)
**Implemented rules**
- **1 chip = 1 point**
- **Deduct chips only on admin approval**
- If insufficient chips at approval time: approval fails and request remains **PENDING**
- **Points → Chips remains instant**

**Backend changes (implemented)**
- Instant `CHIPS_TO_POINTS` conversion blocked:
  - `POST /api/chips/convert` with `direction=CHIPS_TO_POINTS` returns **400** with guidance.
- New endpoint:
  - `POST /api/chips/sell-request` creates a `chip_requests` doc with `type='SELL'` (min 500, must be ≤ current balance, max 3 pending).
- Existing buy chip request flow retained:
  - `POST /api/chips/request` now creates `type='BUY'`.
- Admin approvals:
  - `POST /api/admin/chip-requests/{id}/approve`:
    - BUY → credits chips (unchanged)
    - SELL → debits chips and credits points 1:1 + ledger entries
  - Deny works for both; SELL deny leaves chips untouched.

**Frontend changes (implemented)**
- `ChipsPage.js`:
  - “Sell chips → points” now submits a sell request (`Request sale`) instead of instant conversion.
  - History shows BUY/SELL badges.
- `AdminChipRequests.js`:
  - Adds **Type** column (SELL → POINTS / BUY).
  - Type-aware dialogs + toasts.

#### LIVE‑11C (P1) — Admin detailed user stats (deposits / won / lost)
**Backend changes (implemented)**
- `GET /api/admin/users` returns a per-user `stats` object:
  - `total_deposits`, `winning_chips`, `loss_chips`
  - Aggregated from `chip_transactions` using note-regex categorization.

**Frontend changes (implemented)**
- `AdminUsers.js` shows Deposits / Won / Lost columns.

---

## 3) Next Actions
1. **P1: Resend production deliverability**
   - Verify sending domain in Resend
   - Update `SENDER_EMAIL`
   - Smoke test password reset emails with real inboxes
2. **P2 (Backlog): Master Prompt 1 enterprise admin restructure** *(await explicit user go-ahead)*
   - Strict RBAC
   - Maker-checker workflows
   - TOTP

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
- Account provisioning:
  - ✅ Signup request → admin assigns login/password → user logs in via login ID.
  - ✅ Legacy accounts can still log in via email.
- Sessions:
  - ✅ **One active session per Login ID**; second login invalidates previous.
  - ✅ Previous session receives 401 `SESSION_REPLACED` on next API call and is redirected to login with a clear notice.
  - ✅ Logout revokes the active session server-side.
- Economy:
  - ✅ Chips → Points only through **admin-approved SELL requests** (1:1).
  - ✅ Chips deducted **only on approval**; insufficient chips prevents approval and request remains PENDING.
  - ✅ Points → Chips still instant.
- Admin auditing:
  - ✅ Admin Users shows per-user: balance, deposits, won, lost.
- Testing:
  - ✅ Mandatory testing agent run after LIVE‑11 changes and report saved (**`/app/test_reports/iteration_10.json`**).

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
- ✅ LIVE‑10 completed: points economy + admin-provisioned accounts verified (**iteration_9.json**).
- ✅ **LIVE‑11 completed: sessions + SELL approvals + admin aggregates verified (**iteration_10.json**).**

**Test credentials**
- Admin: `admin@fungame.app` / `FunGame@Admin2025`
- Player: `player@fungame.app` / `Player@123`
