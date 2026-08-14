# MyDGP Mongo snapshot importer

`migration-import` is a short-lived, server-to-server Supabase Edge Function
used only during the MongoDB cutover. It has no CORS policy and rejects browser
requests. Do not expose its endpoint or any of its secrets in the Android app
or the admin web build.

## Required function secrets

- `MIGRATION_SOURCE_URL` — HTTPS base URL of the temporary source exporter,
  ending in `/api/migration-export`.
- `MIGRATION_HMAC_SECRET` — the source export signing secret.
- `MIGRATION_IMPORT_SECRET` — a different 32+ character secret supplied as
  `X-Migration-Import-Secret` on every importer request.

The importer refuses to start if any value is missing, too short, or the two
secrets are identical. Every source request gets a fresh nonce and signs the
exact exporter payload:

```text
GET\n<path-and-raw-query>\n<timestamp>\n<nonce>\n<sha256-empty-body>
```

## Resumable phases

Use `POST` with a JSON object and the import-secret header. The default action
is `run`; it starts an archive or resumes the next required phase. Large
datasets deliberately advance in bounded chunks.

```json
{ "action": "archive", "max_pages": 12, "page_limit": 50 }
```

Use the returned `run_id` to continue:

```json
{ "action": "materialize", "run_id": "<run UUID>", "max_records": 40 }
```

```json
{ "action": "validate", "run_id": "<run UUID>" }
```

The run progresses through `STARTED`, `ARCHIVED`, `MATERIALIZED`, and finally
`VALIDATED`. A partial unique index in
`20260814061000_migration_import_lock.sql` allows only one incomplete source
snapshot. Do not remove that guard during a live cutover.

## Data safety and mappings

1. Every exporter document is first stored as Canonical Extended JSON in
   `legacy_documents`, with a SHA-256 digest. A changed digest for the same
   source key stops the run; the importer never overwrites a frozen snapshot.
2. Source credential/session fields are rejected defensively. The importer
   does not read legacy passwords or hashes. New Auth users get unknown random
   passwords plus `password_reset_required`; email recovery must be explicitly
   verified and initiated through the new Supabase flow.
3. Safe structured mappings are: `users`, `games`, `announcements`,
   `system_config`, `signup_requests`, `support_messages`, `notifications`,
   and `BUY` virtual play-point requests. Existing user balances enter only
   through `adjust_play_points(..., 'MIGRATION_OPENING', ...)`, preserving the
   immutable ledger.
4. Cash-like or incompatible data—including `SELL`/`RETURN` requests,
   transaction histories, payouts, commission records, game-round records,
   and all unmapped collections—remains in the lossless archive only. It is
   never converted into new play points.
5. The known development seeds `admin@fungame.app` and
   `player@fungame.app`, plus records linked to them, are archive-only and are
   never materialized as Supabase Auth users, profiles, wallets, support,
   notifications, or requests.

After validation, disable the Mongo export route, remove all three importer
secrets, revoke the temporary management token, and retain the archive only
under the approved data-retention policy.
