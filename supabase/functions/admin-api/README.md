# MyDGP admin Edge API

This function is the browser-facing API for `https://mydgp.casino/admin`. It
expects Supabase to provide `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and
`SUPABASE_SERVICE_ROLE_KEY`; do not put any of those values in the web build.

Set `BOOTSTRAP_SECRET` as a short-lived Edge Function secret before calling the
one-time `POST /bootstrap/primary` route. Remove that secret after the primary
administrator has been created. The SQL migration prevents a second primary
administrator even while the secret exists.

Supported virtual-points-only routes:

- `POST /auth/login`, `GET /auth/me`, `POST /auth/logout`, `GET /system/config`
- `POST /player/auth/login`, `GET /player/session`, `GET /player/balance`
- `/admin/stats`, `/admin/users`, `/admin/point-requests`, `/admin/operators`
- `/admin/games`, `/admin/announcements`, `/admin/system`, `/admin/support`

All `payout`, `commission`, `revenue`, `distributor`, and legacy chip-request
paths return HTTP 410. Browser origins are limited to `mydgp.casino` and
`www.mydgp.casino`.

## Unity player session contract

`POST /player/auth/login` accepts an issued `login_id` (or `username`) and
`password`. It signs in only an `ACTIVE` `PLAYER` identity and returns a
Supabase access token plus a profile with no internal auth email. The operator
console and player sign-in both accept the client-compatible `GK` + seven- or
eight-digit ID forms.

Unity sends that token as `Authorization: Bearer <access_token>` to:

- `GET /player/session` for the sanitized profile, the authoritative
  virtual-points balance, and the enabled game catalogue.
- `GET /player/balance` when it needs to refresh only the balance.

The balance is derived from the immutable server ledger and fails closed if its
materialized profile projection does not match the latest ledger entry. There is
intentionally **no client-accessible balance mutation endpoint**. A Unity client
must never submit a payout, prize, credit, or arbitrary balance delta. Trusted
game-server code must settle a resolved round using the database's
`apply_game_play_points` RPC with the server-side service role and a unique,
stable round idempotency key; it must not expose that credential or RPC to the
client. Until a trusted game-resolution service is connected, Unity can display
and refresh admin-provisioned points but cannot safely persist bets or wins.
