# FunGame (Mobile‑first Web App) — Development Plan (Updated)

## 1) Objectives
- Deliver a **play‑chip‑only** FunGame PWA‑style web app (React + FastAPI + MongoDB) with premium, original UI and the disclaimer: **“PLAY CHIPS — NO CASH VALUE”**.
- Maintain the **core foundation** already built:
  - Auth + onboarding approval flow
  - Admin console (basic)
  - Server-authoritative chip ledger
  - Game catalog (18 games)
  - Player app UX (mobile‑first)
- **Current primary objective (P0): Convert ALL 18 games to universal, server-synchronized live rounds running 24/7**.
  - One global round state per game (and per table) shared by all players.
  - Real-time sync via **polling (≈1s) + client-side interpolation** for smooth animation.
  - Standard loop timing for most games: **~20–30s cycles**.
- **Aviator (P0):** Implement a Spribe-style crash game experience (original UI assets; mimic concept/flow, not copied art).
- **Roulette (P0):** Refine to a **30-second continuous live loop** and upgrade visuals to match user expectation (green board + chips + spin wheel with white ball).
- Defer **Master Prompt 1 enterprise admin/RBAC restructure** until after live games are completed (confirmed by user).
- Keep **SMTP/SendGrid** in demo mode until credentials are provided at the end (confirmed by user).

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
- 18 games seeded and enabled (gameplay v1 migration applied).

---

### Phase LIVE‑1: Universal Live Sync Backend (All 18 games) — **In Progress**
**Goal:** Provide a single, universally synchronized 24/7 round stream per game. Outcomes are server-generated once per (slug, round_number) and shared globally.

**User-confirmed design choices**
- ✅ Focus 100% on live games now; enterprise admin later.
- ✅ Use polling (≈1s) + client interpolation.
- ✅ Standard loop timing for non-aviator games (~20–30s).

**Architecture**
- **Fixed-cycle games (most of the 18):** epoch-derived rounds (like current live roulette).
  - Deterministic round number + phase by `time.time()`.
  - Outcome generated once per round and persisted (unique index ensures one outcome per round).
  - Lazy, idempotent settlement on state polling.
- **Variable-length game (Aviator):** DB-chained rounds + background keepalive task.
  - Round phases: BETTING → FLYING → CRASHED/RESULT.
  - Crash point pre-committed per round.
  - Auto-cashout + manual cashout settlement.

**Backend work items**
1. Extend `/app/backend/live_engines.py`
   - Standardize:
     - cycle config per game (bet/reveal/result)
     - `generate_outcome(slug)` (already present for many)
     - `validate_selection(slug, selection)`
     - `settle_bet(slug, outcome, selection, amount, ...)`
     - `summarize_outcome(slug, outcome)`
   - Add Aviator live round state generator:
     - BETTING window (~6s)
     - FLYING multiplier curve `e^(0.12t)` until crash
     - CRASHED/RESULT window (~4s)
     - Round history list for UI
2. Create new live routes module (recommended): `/app/backend/routes_live.py`
   - Generic fixed-cycle endpoints:
     - `GET  /api/live/{slug}/state`
     - `POST /api/live/{slug}/bets`
     - `POST /api/live/{slug}/bets/clear` (optional per game)
   - Aviator endpoints:
     - `GET  /api/live/aviator/state`
     - `POST /api/live/aviator/bets` (supports optional `auto_cashout`)
     - `POST /api/live/aviator/cashout`
     - `POST /api/live/aviator/bets/cancel` (during BETTING)
3. Update `/app/backend/server.py`
   - Include `routes_live`.
   - Add DB indexes:
     - `live_outcomes`: unique `(slug, round_number)`
     - `live_bets`: `(user_id, slug, round_number, status)`
     - `aviator_rounds`: unique `round_number`
     - `aviator_bets`: `(user_id, round_number, status)`
   - Lifespan background task:
     - `advance_aviator()` every 1s (ensures 24/7 chaining even with low traffic).
4. Update `/app/backend/routes_games.py`
   - Convert remaining `/games/{slug}/play` pathways to live:
     - Return `409 {code: "LIVE_ROUNDS"}` for all live-converted games.
   - Keep `/games/{slug}/history` for unified history backed by `game_rounds`.
5. Roulette timing update
   - Change roulette round timing to **30 seconds** (BET 20 / SPIN 6 / RESULT 4).

**Data collections**
- `live_outcomes`, `live_bets` for fixed-cycle games.
- `aviator_rounds`, `aviator_bets` for Aviator.
- `game_rounds` remains the canonical per-user settled history record.

**Testing (backend)**
- Add curl/pytest smoke tests:
  - Round clock invariants (phase changes at correct boundaries).
  - Outcome uniqueness under concurrent access.
  - Idempotent settlement correctness.
  - Insufficient chips behavior.

---

### Phase LIVE‑2: Aviator (Spribe‑style) + Roulette UI/Timing — **Not Started**
**Goal:** Deliver the two flagship live games with polished mobile-first UX.

**Aviator frontend (`/app/frontend/src/pages/play/AviatorGame.js`)**
- Convert from per-user stateful rounds to **universal live rounds**:
  - Betting countdown synced to server.
  - FLYING animation using client interpolation.
  - Manual cashout + auto-cashout.
  - Round history strip (recent crash multipliers).
  - Live bets feed (sanitized) (optional, P1 if needed).
- Visual spec (original assets):
  - Sky/gradient scene + plane animation at curve tip.
  - Large multiplier typography.
  - Dual bet panels consistent with crash-game norms.

**Roulette frontend (`/app/frontend/src/pages/play/RouletteGame.js`)**
- Update client expectations to the **30s loop**.
- Ensure UI includes:
  - Green board with numbers
  - Chips selector and on-board markers
  - Wheel with **white ball** (already present; refine realism)
  - Better spin feel aligned to SPIN window (6s)

**Testing (frontend)**
- Verify timer sync stability under refresh.
- Ensure betting locks close correctly.
- Ensure settlement banner shows once per round.

---

### Phase LIVE‑3: Convert Remaining Games to Live Rounds — **Not Started**
**Goal:** Convert all other game UIs and APIs to consume the universal live endpoints.

**Frontend work items**
- Add shared live client hook: `/app/frontend/src/lib/useLiveRound.js`
  - Polling, server clock offset, phase timers, optimistic UI where safe.
- Add shared components:
  - `LiveBar` (phase label + countdown)
  - `LiveBetPanel` (chip/bet + selection)
  - `LiveResultBanner` (result + payout)

**Games to convert**
- Seven-Up-Down (Dice)
- Fun Target
- Super Golden Wheel
- Checker
- Teen Patti
- Poker
- No Hold
- Champion Poker
- Andar Bahar
- Keno
- Bingo
- 5 Slots: Fever Joker Bonus / Giant Jackpot / Joker Bonus / Lucky 8 Line / Triple Fun

**Backend support**
- Ensure `live_engines.py` outcome/settlement supports each slug.
- Standardize selection schemas per game kind.

---

### Phase LIVE‑4: Testing, Hardening, and Fixes — **Not Started**
**Goal:** Stabilize the live platform across all games.

**Work items**
- Backend:
  - Load testing for polling endpoints.
  - Verify unique outcome generation under concurrency.
  - Settlement idempotency + ledger correctness.
- Frontend:
  - Regression pass across all games and chip balance.
  - Mobile performance checks (60fps interpolation where needed).
- Automated tests:
  - Extend pytest for live endpoints and settlement.
  - Add RTL smoke tests for key live UIs (roulette + aviator at minimum).

---

### Phase 4: Email Provider Integration (SendGrid/SMTP) — after credentials provided
**Status:** ⏸️ PENDING (user will provide credentials at the end)
- Keep demo verification code flow until credentials provided.

---

## 3) Next Actions
1. **Implement Phase LIVE‑1 backend**
   - Create `routes_live.py`, wire into `server.py`, add indexes.
   - Finalize `live_engines.py` for all slugs + Aviator live manager.
   - Convert remaining `/games/{slug}/play` to `LIVE_ROUNDS` gating.
   - Update roulette backend timing to **30s**.
2. **Implement Phase LIVE‑2 UI upgrades**
   - Aviator Spribe-style experience (universal live).
   - Roulette UI polish + 30s loop alignment.
3. Convert remaining games to live UIs (Phase LIVE‑3).
4. Run full backend + frontend testing (Phase LIVE‑4).
5. After completion, request SMTP credentials and integrate SendGrid/SMTP (Phase 4).

---

## 4) Success Criteria
- Platform-level:
  - Clear disclaimer: **PLAY CHIPS — NO CASH VALUE** across player app.
  - Chips remain server-authoritative; no client-side balance edits.
  - No deposit/withdraw/cash-out/payment routes exist.
- Live games:
  - **All 18 games run 24/7 universal synchronized rounds**.
  - Every player sees the same round number/phase/outcome per game.
  - Betting locks correctly at phase boundaries.
  - Settlement is **idempotent** and ledger-consistent.
- Flagship titles:
  - **Aviator** behaves like a crash game with smooth interpolation and correct cashout logic.
  - **Roulette** runs on an exact **30s** loop with green board, chips, and wheel + white ball.
- Quality:
  - Automated smoke tests + manual regression pass succeed.

---

## STATUS LOG
- ✅ Phase 1 POC complete: core workflows green in tests.
- ✅ Phase 2 complete: player app + admin console delivered.
- ✅ Gameplay v1 complete: all 18 games playable via server-authoritative instant/stateful engines.
- ✅ Live European Roulette v1 complete: universal synchronized rounds implemented and tested.
- ✅ User confirmed priorities:
  - Games first; enterprise admin later.
  - Polling + interpolation.
  - Standard 20–30s loops.
  - SMTP stays demo until end.
- 🟡 **IN PROGRESS:** Phase LIVE‑1 — building universal live engine system (`/app/backend/live_engines.py` exists and includes generators/settlement helpers; needs full routing + Aviator live loop + full conversion).
- ⏸️ **BACKLOG/BLOCKED:** Master Prompt 1 enterprise admin/RBAC restructure (deferred by user).
- ⏸️ **PENDING:** Real email provider integration (SendGrid/SMTP creds at end).

**Test credentials**
- Admin: `admin@fungame.app` / `FunGame@Admin2025`
- Player: `player@fungame.app` / `Player@123`
