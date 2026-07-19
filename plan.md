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
  - Add `POST /api/auth/logout` to release the session.
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
- 🔄 **NEW (IN PROGRESS):** single-session enforcement + SELL request flow + admin user ledger stats.

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

### Phase LIVE‑11 (NEW): Session Management + Manual Chip Selling + Admin Ledger Stats
**Goal (P0/P1):** Enforce single-session logins, shift chips→points to admin-approved SELL requests, and provide admin-wide aggregated user stats.

**Status:** 🔄 IN PROGRESS

#### LIVE‑11A (P0) — Single active login session per user (kick-out model)
**Backend changes**
- Data model:
  - Add `active_session_id: str | null` to `users`.
- JWT changes:
  - `create_access_token(user_id, role, sid)` includes a `sid` claim.
- Login behavior (`POST /api/auth/login`):
  - On successful login generate new `sid` (UUID).
  - Persist to `users.active_session_id`.
  - Return JWT with `sid` claim.
  - This invalidates previous sessions for that user.
- Auth validation (`get_current_user` in `auth_utils.py`):
  - Decode JWT.
  - Load user.
  - Verify `payload.sid == user.active_session_id`.
  - If mismatch: raise **401** with detail `{code: 'SESSION_REPLACED', message: 'Logged in on another device'}`.
- Logout endpoint:
  - `POST /api/auth/logout` clears `active_session_id` if it matches current token’s `sid` (safe, idempotent).

**Frontend changes**
- Axios interceptor (`frontend/src/lib/api.js`):
  - On 401 with `detail.code === 'SESSION_REPLACED'`:
    - Clear token.
    - Redirect to `/login?reason=session_replaced`.
- Login page (`Login.js`):
  - If `reason=session_replaced`, show message: “You were logged out because this Login ID was used on another device.”
- Optional: on manual logout in UI, call `/auth/logout` before clearing token.

**Acceptance criteria**
- Same Login ID cannot be active simultaneously on two devices.
- First device gets logged out on next API call after second login.

Files
- Backend: `/app/backend/auth_utils.py`, `/app/backend/routes_auth.py`, `/app/backend/models.py`
- Frontend: `/app/frontend/src/lib/api.js`, `/app/frontend/src/context/AuthContext.js`, `/app/frontend/src/pages/auth/Login.js`

---

#### LIVE‑11B (P0) — Chips → Points becomes admin-approved SELL request (1:1)
**Core rules (confirmed)**
- **1 chip = 1 point**
- **Deduct chips only on admin approval**
- If user lacks chips at approval time: approval fails; request stays **PENDING**
- **Points → Chips remains instant**

**Backend changes**
- Data model:
  - Extend `chip_requests` documents with `type: 'BUY' | 'SELL'`.
  - Backfill existing chip requests as `type='BUY'`.
- Player flow:
  - Replace `POST /api/chips/convert` for `CHIPS_TO_POINTS` with `POST /api/chips/request` using `type='SELL'`.
  - Keep `POINTS_TO_CHIPS` conversion route intact (either same endpoint direction or a dedicated points->chips route).
  - Deprecate or restrict `CHIPS_TO_POINTS` instant conversion in `routes_player.py` (return 410/400 with clear message).
- Admin flow:
  - Update `POST /api/admin/chip-requests/{id}/approve`:
    - If `type=='BUY'`: existing behavior (credit chips).
    - If `type=='SELL'`: attempt atomic `debit_chips(user_id, amount, note='Sold X chips for points', ref=request_id)`.
      - If insufficient chips: error and keep request PENDING.
      - If success: credit points (`$inc points_balance`) and create `points_transactions` CREDIT entry.
  - Update deny endpoint to work for both types.

**Frontend changes**
- Player Chips page (`ChipsPage.js`):
  - Remove/disable “Sell chips → points” instant converter.
  - Add a **Sell chips request** UI that creates a `type='SELL'` chip request.
  - Keep “Points → chips” converter intact.
- Admin Chip Requests (`AdminChipRequests.js`):
  - Add a **Type** column and type-aware confirmation copy.
  - Approval button triggers chip credit for BUY, points credit for SELL.

Files
- Backend: `/app/backend/routes_player.py`, `/app/backend/routes_admin.py`, `/app/backend/models.py`, `/app/backend/ledger.py`
- Frontend: `/app/frontend/src/pages/app/ChipsPage.js`, `/app/frontend/src/pages/admin/AdminChipRequests.js`

---

#### LIVE‑11C (P1) — Admin detailed user stats (deposits / won / lost)
**Backend changes**
- Update `GET /api/admin/users` to return per-user aggregates from `chip_transactions`:
  - Use Mongo aggregation with `$group` per user.
  - Categorize via `note` patterns using `$regexMatch` (as per current ledger notes used by games/admin flows):
    - **Deposits**: chip credits from “Chip request approved”, “Welcome play chips”, “account provisioned by admin”
    - **Winning chips**: credits containing “win (round”, “cashout”, or known win notes
    - **Loss chips**: sum of **DEBIT** bets (exclude refund/cancel credits such as “refunded”, “cancelled”)
  - Return these alongside base user fields.

**Frontend changes**
- Update Admin Users table (`AdminUsers.js`) to add columns:
  - Deposits, Won, Lost
  - Keep existing chip balance + points balance.

Files
- Backend: `/app/backend/routes_admin.py` (aggregation), ensure uses `chip_transactions`
- Frontend: `/app/frontend/src/pages/admin/AdminUsers.js`

---

#### LIVE‑11D — Testing & Verification (MANDATORY)
- Backend testing agent:
  - Validate session invalidation behavior (sid mismatch → 401 SESSION_REPLACED).
  - Validate SELL request approval behavior (insufficient chips keeps PENDING; successful approval debits chips + credits points + logs ledgers).
  - Validate `/admin/users` aggregation outputs sane values.
- Frontend testing agent:
  - Login multi-device simulation (token A invalid after login B).
  - Chips page: SELL request submission + history.
  - Admin chip requests: approve SELL updates points; approve BUY credits chips.
  - Admin users page shows new columns.

---

## 3) Next Actions
1. **P0: LIVE‑11A — Single active session enforcement** (backend + frontend handling)
2. **P0: LIVE‑11B — Chips→Points via admin-approved SELL requests** (remove instant CHIPS→POINTS)
3. **P1: LIVE‑11C — Admin user ledger aggregates (deposits/won/lost)**
4. **Run full backend + frontend testing agent** and write new report.
5. **P1: Resend production deliverability**
   - Verify sending domain in Resend.
   - Update `SENDER_EMAIL`.
   - Smoke test password reset emails.
6. **P2 (Backlog): Master Prompt 1 enterprise admin restructure**
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
- Account provisioning:
  - ✅ Signup request → admin assigns login/password → user logs in via login ID.
  - ✅ Legacy accounts can still log in via email.
- Sessions (NEW):
  - ✅ **One active session per Login ID**; second login invalidates previous.
  - ✅ Previous session receives 401 `SESSION_REPLACED` on next API call and is redirected to login.
  - ✅ Logout clears the current session.
- Economy (UPDATED):
  - ✅ Chips → Points only through **admin-approved SELL requests** (1:1).
  - ✅ Chips deducted **only on approval**; insufficient chips prevents approval and request stays PENDING.
  - ✅ Points → Chips still instant.
- Admin auditing (NEW):
  - ✅ Admin Users shows per-user: balance, deposits, won, lost.
- Testing:
  - ✅ Mandatory testing agent run after LIVE‑11 changes and report saved.

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
- 🔄 LIVE‑11 started: single-session auth + SELL requests + admin aggregates (pending implementation + testing).

**Test credentials**
- Admin: `admin@fungame.app` / `FunGame@Admin2025`
- Player: `player@fungame.app` / `Player@123`
