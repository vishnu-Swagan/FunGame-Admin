# MyDGP production launch checklist

MyDGP is a Unity Android client plus a React administrator console, backed by Supabase Auth, Postgres, and Edge Functions, with static downloads hosted on Hostinger. It is a virtual-play-points product only: cash, deposits, withdrawals, purchases, and payments remain disabled.

Estimated time: 30–60 minutes for the already-built admin/server rollout; Android time depends on a successful signed Unity build; each game remains a separate release gate until its exact client timing, result, payout, and ledger behavior is proven. Incremental hosting cost is £0 beyond the existing Hostinger and paid Supabase subscriptions; usage overages follow those plans.

Legend: 🧑 You · 🤖 Agent · 🤝 Together

## Phase 0 — release blockers

- [x] 🤖 **Deploy the server control plane** — 20 minutes. Apply the Supabase migrations and deploy `admin-api` and `game-api`; keep unauthenticated table/RPC access revoked.

  > Verify Supabase migration history, deploy both Edge Functions, and prove unauthenticated admin/player requests return 401 while the `https://mydgp.casino` CORS preflight returns 204.

  **You'll know it worked when:** local and remote migrations align, both APIs answer, and protected routes reject anonymous requests.

- [x] 🤖 **Fix cross-round idempotency reconciliation** — complete. An idempotency key is a retry identifier that prevents the same button press from charging twice. A lost response near a round boundary now returns the original receipt; an uncommitted stale request is rejected before a wager mutation.

  > Make game-action retries resolve by player, session, idempotency key, and canonical request before current-round action gating. Add regression tests and a forward-only migration. Keep every game resolver disabled.

  **You'll know it worked when:** a replay before, during, and after a phase boundary returns one immutable action receipt and never creates a second ledger debit.

- [ ] 🤖 **Remove the remote migration importer and its migration-only secrets** — 5 minutes. Its source is archived and excluded from the deployable function surface, but the old privileged function still exists in the Supabase project.

  > After explicit deletion approval, delete only `migration-import` and unset `MIGRATION_IMPORT_SECRET`, `MIGRATION_HMAC_SECRET`, and `MIGRATION_SOURCE_URL`; leave the audit archive and migration history intact.

  **You'll know it worked when:** Supabase lists only `admin-api` and `game-api`, and the retired importer URL returns 404.

- [x] 🤖 **Build a new signed Android APK** — done 2026-08-16: `FunGame-release.apk` (211,034,661 bytes, sha256 5251103b…) built via `tools/unity.sh android-release`, signed with the pinned `chakri-upload` key (`FA:E1:C0:02…`), includes the Supabase client, transfer dialog wiring and today's fixes. — 20–60 minutes. The published APK predates the Supabase login/lobby/session client and cannot use the new backend.

  > Load the six signing inputs from a private shell (keystore path outside the repository, alias, both passwords, pinned certificate SHA-256, and apksigner path), build the current Unity project as a signed Android release, and report the APK SHA-256 without exposing credentials.

  **You'll know it worked when:** the APK build timestamp follows the Supabase Unity source changes and signature verification passes.

## Phase 1 — admin and identity

- [x] 🤖 **Provision accounts only through the admin API** — 15 minutes. Public registration and demo-player creation are disabled; administrators create a unique `GK` player ID, temporary password, and optional opening virtual points.

  > Verify the player-provisioning RPC creates one Supabase Auth user, one ACTIVE PLAYER profile, and one immutable opening ledger entry under a retry-safe key.

  **You'll know it worked when:** duplicate retries return the same account and no second opening credit is written.

- [x] 🤖 **Connect point adjustments to the immutable ledger** — 15 minutes. The browser submits a signed-in administrator request; the server writes the balance and audit entry atomically.

  > Test positive and negative whole-point adjustments, limits, notes, idempotency, insufficient-balance rejection, role enforcement, and reconciliation between profile balance and the latest ledger entry.

  **You'll know it worked when:** each accepted adjustment has one ledger receipt and the displayed balance equals `balance_after`.

- [ ] 🧑 **Rotate the production administrator password** — 5 minutes. Do this directly in the administrator account/security screen; never paste the new password into chat or commit it to code. No added cost.

  **You'll know it worked when:** the old password fails and the new password opens the Supabase-backed administrator console.

## Phase 2 — web deployment

- [x] 🤖 **Upload the fresh admin bundle to Hostinger** — complete. `public_html/admin` now contains the reviewed `/admin` build, including the hidden `.htaccess`; the root download index and downloadable files were preserved.

  > Back up the current `public_html/admin`, upload and extract the prepared MyDGP admin ZIP into that directory, purge Hostinger CDN cache, and verify deep-link fallback at `/admin/login`.

  **Verified (updated 2026-08-16):** `https://mydgp.casino/admin/` serves `main.77a8ec08.js` — the rebuilt console with the Point Collector page, auto-issued GK+8 credentials and runtime promotion controls. Deep links return 200 and `/admin/point-collector` renders authenticated with live ledger data. The bundle is reproducible from `frontend/build` at commit 6c517e7+; prior folder retained as `public_html/admin.rollback-20260816`.

- [x] 🤖 **Publish the new APK without changing download names** — done 2026-08-16: the download is Supabase Storage (`releases/FunGame.apk`), not Hostinger; prior build backed up server-side as `FunGame.rollback-20260816.apk`, new build uploaded with upsert, public content-length verified byte-exact and first-KB compared identical. Same signing key, so installed apps update in place. — 10 minutes. Back up the current `FunGame.apk`, upload the newly signed build under the same public filename, and keep Windows files unchanged.

  > Compare the existing and new APK hashes, create a recoverable backup, upload the signed replacement to the current download directory, purge CDN cache, and verify the public Content-Length and SHA-256 hash.

  **You'll know it worked when:** the public `FunGame.apk` hash equals the new local release hash and installs successfully on the test device.

## Phase 3 — game-by-game release gates

- [ ] 🤝 **Prove and register one resolver per game** — timing varies by title. A resolver is server code that owns the round clock, outcome, payout, and ledger settlement. Database switches cannot substitute for this code.

  > For one named game, implement its versioned resolver from observed client evidence, add timing/action/result/payout/ledger/idempotency tests, run Unity integration tests, register that exact ruleset, and leave every other title disabled.

  **You'll know it worked when:** the title passes the evidence matrix and a full authenticated stake → reveal → settlement → balance refresh test with no client-supplied outcome or balance.

- [ ] 🤖 **Promote only a passing title** — 5 minutes per game. Set catalog/runtime availability to `ENABLED` and parity to `QA_VERIFIED` only after its resolver is registered and all tests pass.

  > Promote the verified game/ruleset in one transaction, confirm the lobby advertises it, confirm all unverified games remain unavailable, and exercise switch-off/refund behavior.

  **You'll know it worked when:** the selected title opens from the live lobby and disabling it immediately closes sessions and safely refunds any open virtual-point wager.

## Phase 4 — production smoke test and operations

- [ ] 🤝 **Run a real-user smoke test** — 15 minutes. Create one controlled player through admin, sign in with its `GK` ID and password, assign a small virtual-point balance, open only a verified title, complete a round, and reconcile the ledger. Delete no production records during this test.

  > Record request IDs and ledger receipts for account creation, point credit, session open, stake, result, payout/refund, and logout; redact tokens and passwords from the report.

  **You'll know it worked when:** admin, Android, Edge Functions, and Postgres show the same player, round, result, and final virtual-point balance.

- [ ] 🧑 **Confirm backups and monitoring** — 10 minutes. In Supabase, verify the paid plan's database backup schedule and set alerts for Edge Function failures and database usage; in Hostinger, keep the admin/APK backups until the smoke test passes. No new service is required.

  **You'll know it worked when:** a recent restore point is visible and there is a documented rollback copy of the prior admin bundle and APK.
