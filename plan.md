# FunGame (Mobile‑first Web App) — Development Plan

## 1) Objectives
- Deliver a **play‑chip‑only** FunGame PWA‑style web app (React + FastAPI + MongoDB) with a premium, original UI (no copied assets) and clear banner: **“PLAY CHIPS — NO CASH VALUE”**.
- Implement full **backend + admin panel**: auth, onboarding approval, chips (requests + history), game catalog (18 games), announcements, notifications, maintenance + min client version gating.
- Foundation gate: **0 playable games**; all 18 show as **COMING_SOON** (or server status), game detail pages exist but cannot start rounds.
- Build with **demo-mode email verification** now; plug in SendGrid/SMTP later via an abstracted EmailService.

## 2) Implementation Steps

### Phase 1: Core Flow POC (Isolation) — Email verification + onboarding approval + chip request lifecycle
**Goal:** Prove the most failure‑prone workflow (multi-role state machine + notifications) works end-to-end before building full UI.

**User stories (POC)**
1. As a new user, I can register and receive a verification code (demo) so I can verify my email.
2. As a verified user, I can submit onboarding profile data and be marked PENDING for approval.
3. As an admin, I can approve/reject a pending user so they become ACTIVE/REJECTED.
4. As an ACTIVE user, I can submit a chip request so I can receive play chips.
5. As an admin, I can approve/deny chip requests and the user sees updated balance + notification.

**Backend (POC endpoints + models)**
- Data models: User, Session/Token, EmailVerification, OnboardingProfile, ChipTransaction, ChipRequest, Notification, Announcement, Game, SystemConfig.
- Auth: register/login, bcrypt password hashing, JWT access + refresh, secure cookie or localStorage strategy (decide and implement consistently).
- Verification (demo): generate code, store hashed code + expiry; return code in response **only when** `APP_ENV=development`.
- Onboarding: profile submit → review snapshot → status=PENDING until admin approval.
- Chips: server-authoritative balance via transactions ledger; chip requests create pending request; admin approve creates credit transaction; deny records denial.
- Notifications: create on approval/denial events.
- Admin RBAC: role=ADMIN; seed admin.

**POC execution**
- Create a minimal CLI or pytest script hitting API:
  - register → verify → submit onboarding → admin approve → request chips → admin approve → verify balance + notifications.
- Do not proceed until this script is green.

### Phase 2: V1 App Development (Full UX + Admin Panel)
**Goal:** Build the complete foundation app (player + admin) with consistent navigation, design system, and gating rules.

**User stories (V1 player app)**
1. As a user, I can complete auth + onboarding and clearly see whether I’m PENDING/ACTIVE so I know what I can access.
2. As an ACTIVE user, I can browse the lobby and see **all 18 games** with status badges so I know what’s available.
3. As a user, I can open any game detail page and see rules/status, but I cannot start gameplay until enabled.
4. As a user, I can request play chips and view request/transaction history so I understand my balance.
5. As a user, I can read announcements and see notifications so I stay informed.

**User stories (V1 admin panel)**
1. As an admin, I can approve/reject onboarding users so I control access.
2. As an admin, I can approve/deny chip requests so chip grants are controlled.
3. As an admin, I can set game statuses (e.g., COMING_SOON/MAINTENANCE) so availability is centralized.
4. As an admin, I can create/edit announcements so players see updates.
5. As an admin, I can enable maintenance mode and set min client version so I can block navigation when needed.

**Frontend build**
- App shell: mobile-first max-width layout, top header (balance + profile), **bottom nav** (Home/Games/Chips/Inbox/Profile).
- Routes (web equivalents):
  - Public: /welcome /register /verify-email /login /forgot-password
  - Onboarding: /onboarding/profile /onboarding/review /onboarding/pending
  - App: /home /games /games/:slug /search /favorites /recent /chips /chips/request /chips/history /announcements /notifications /profile /security /settings
  - System: /maintenance /offline /update-required
  - Admin: /admin /admin/users /admin/chip-requests /admin/games /admin/announcements /admin/settings
- Design system: Tailwind + shadcn/ui theme tokens for midnight background, gold accents, glass cards, focus rings, reduced-motion support.
- Game catalog: seed + render exactly 18 cards; each with distinct **original** gradient/key-art styling (CSS/Skia-like effects not required on web).
- Gating:
  - PENDING/SUSPENDED/REJECTED blocked from app areas; show clear status screen and CTA.
  - Maintenance mode blocks player navigation globally; admin still accessible.
  - Update-required shows /update-required when server requires higher version.
- Data/state:
  - React Query for server state; Zod validation for API payloads.
  - Recent/favorites stored per-user (server) or local (MVP local, with clear plan to server later).

**Backend completion (beyond POC)**
- Games: CRUD for admin, list for players; statuses enforced.
- Announcements: CRUD admin; list/detail player.
- Notifications: list/mark-read.
- SystemConfig: maintenance toggle, minClientVersion.
- Seeds: admin user, 18 games (COMING_SOON), 2–3 announcements, 1 ACTIVE test player.

**End of Phase 2**
- Run one full E2E pass (manual + automated smoke) across:
  - register/verify/onboard/pending → admin approve → lobby access → chip request → admin approve → history updates.

### Phase 3: Testing, Hardening, Accessibility, and Policy Enforcement
**User stories (quality)**
1. As a user, I can use the app with keyboard/screen reader labels and clear focus order.
2. As a motion-sensitive user, I can enable reduced motion and avoid heavy animations.
3. As a user, I can recover from offline/timeout states and understand what to do next.
4. As an admin, I can safely operate without leaking sensitive logs.
5. As a product owner, I can verify there are **no payment/cash-out paths** anywhere.

**Work items**
- Automated tests:
  - Backend: pytest for auth, onboarding transitions, chip ledger invariants, maintenance/update gating.
  - Frontend: RTL tests for route guards, 18-game rendering, chips request flow.
- Security/reliability:
  - Rate limiting (basic), token expiry/refresh, secure headers, input validation (Zod + Pydantic).
  - Global error boundaries, retry policies, offline screen.
- Accessibility pass: aria-labels, contrast checks, focus states, reduced motion toggle.

### Phase 4: Email Provider Integration (SendGrid/SMTP) — after credentials provided
**User stories (email)**
1. As a registering user, I receive a real verification email so I can verify without demo codes.
2. As a user, I can request a new verification email if I missed it.
3. As an admin, I can see email delivery errors in a safe, non-sensitive log.
4. As a user, I can reset my password via email.
5. As an operator, I can switch providers via env config without code changes.

**Work items**
- Implement EmailService provider(s) behind interface; add env-based configuration.
- Add provider-specific best-practice settings (sender verification, rate limits).
- Turn off demo-code surfacing in production.

## 3) Next Actions
1. Define schemas + seed plan (users/roles/statuses, games list, chip ledger) and implement Phase 1 POC endpoints.
2. Implement POC script/tests and get them green.
3. Build player UI routes + admin panel routes (Phase 2) wired to proven APIs.
4. Run end-to-end testing pass; fix UX and gating issues.
5. After app is stable, request SendGrid/SMTP credentials and implement Phase 4.

## 4) Success Criteria
- Auth + onboarding works: register → verify (demo) → profile/review → PENDING → admin approval → ACTIVE.
- Admin panel works: approve users, approve/deny chip requests, manage games + announcements, toggle maintenance.
- Lobby shows exactly **18 games**, each non-playable with correct status badge.
- Chips: balance is server-authoritative; requests + history work; no client-side balance edits.
- System enforcement: maintenance/update-required blocks player navigation.
- No payment/deposit/withdraw/cash-out functionality or routes exist.
- Tests cover key invariants (status gating, 18 games present, no gameplay start, chip ledger correctness).
---
## STATUS LOG
- [DONE] Phase 1 POC: backend built, test_core.py 37/37 checks green (auth, onboarding approval, chip ledger, gating, maintenance, no payment routes)
- [DONE] Phase 2: full player frontend (welcome/register/verify/login/forgot, onboarding x3, home lobby w/ hero carousel + rails, games grid 18, game detail, search, favorites, recent, chips wallet, announcements, notifications, profile/security/settings, maintenance/offline/update-required) + admin panel (dashboard, users, chip-requests, games, announcements, system)
- [IN PROGRESS] Phase 2: E2E testing via testing agent
- [PENDING] Phase 4: real email provider (user will supply SendGrid/SMTP creds at the end; demo mode active: dev_code shown on screen)
- Credentials: admin@fungame.app / FunGame@Admin2025 ; player@fungame.app / Player@123 (see /app/memory/test_credentials.md)
- [DONE] Gameplay v1: real server-authoritative engines for ALL 18 games (routes_games.py + game_engines.py + ledger.py), all games ENABLED, play UIs at /games/{slug}/play. Bug "Gameplay engine ships in a later build gate" FIXED and verified by testing agent (iteration_2.json: 100% backend 25/25, 100% frontend).
- [OPEN] Master Prompt 1 (enterprise core API + admin console: RBAC 12 roles, TOTP MFA, double-entry ledger, maker/checker, audit hash-chain, /api/v1) — awaiting user's answers to 5 clarifying questions before restructure.
- [PENDING] Real email provider (SendGrid/SMTP) — user will provide credentials at the end.
