# Spec: operator-issued credential reset

Status: draft, awaiting decisions in §9
Author: drafted 2026-08-16
Scope: `admin-api`, one migration, one admin console page

## 1. Why

A player who forgets their password or transfer PIN currently has no recovery
path at all. The only route is an operator creating a second account, which
strands the first account's points and pollutes the ledger with a duplicate
identity.

The reference operator solved this with a back-office table. From the supplied
screenshot:

| Member ID | Required | Reset Status |
|---|---|---|
| GK00272341 | Need Both | 8601-XFWHMIRN |

with actions **Change Pin Password** and **Reset Member ID**, and a confirmation
reading *"Reset Pin Password Change Successfully."*

That shape is the starting point. It is **not** evidence: no reset logic exists
anywhere in the recovered client, because this was a server-side tool. Nothing
below is a parity claim.

## 2. What the shape implies

- **Reset Status is a handoff code.** `8601-XFWHMIRN` is 4 digits, a hyphen, and
  9 uppercase letters. It exists so an operator can read a credential to a
  player down a phone without either party typing a password into a chat.
- **"Required" is per-credential state.** "Need Both" implies the other values
  are "Need Password", "Need PIN", and none. So the two credentials reset
  independently.
- **Two distinct operations.** Changing credentials is routine. Reissuing a
  member ID is identity rotation and is much rarer.

## 3. Model

MyDGP has two player credentials:

| Credential | Stored | Used for |
|---|---|---|
| Password | `auth.users.encrypted_password` (Supabase Auth) | signing in |
| Transfer PIN | `player_transfer_pins.pin_hash` (bcrypt) | authorising a point transfer |

So **Change Pin Password** maps to resetting either or both. **Reset Member ID**
maps to issuing a new `GK` login id.

### 3.1 New table

```
player_credential_resets
  id                uuid pk
  player_id         uuid not null -> profiles(id)
  scope             enum ('PASSWORD', 'PIN', 'BOTH')
  code_hash         text not null          -- bcrypt; the code is never stored
  code_prefix       text not null          -- the "8601" half, for operator lookup
  status            enum ('PENDING','REDEEMED','EXPIRED','CANCELLED')
  issued_by         uuid not null -> profiles(id)
  issued_at         timestamptz not null default now()
  expires_at        timestamptz not null
  redeemed_at       timestamptz
  failed_attempts   int not null default 0
  locked_until      timestamptz
  unique (player_id) where status = 'PENDING'   -- one live code per player
```

The code is hashed, exactly like the transfer PIN. An operator who can read the
table cannot recover a live code — they can only issue a fresh one, which is
recorded against their own id.

### 3.2 Why not store the code in clear

The screenshot shows the code sitting in a list view. That means every operator
with list access can read every player's live credential. For a points system
with a collector account that is a standing insider risk. **The code is shown
exactly once, at issue time, to the operator who issued it** — the same rule the
create-player screen already follows for passwords.

This is a deliberate departure from the reference screenshot. §9 records it as a
decision to confirm.

## 4. Flow

### 4.1 Issue

1. Operator opens the player row, picks scope, presses **Issue reset code**.
2. Server generates `NNNN-LLLLLLLLL` from `crypto.getRandomValues` with rejection
   sampling (no modulo bias), stores its bcrypt hash plus the 4-digit prefix,
   sets `expires_at = now() + 24h`, cancels any prior PENDING row for that player.
3. Response returns the code **once**. Console displays it with a copy button and
   the same "record it now" treatment as a new player's password.
4. An audit row is written: actor, player, scope. Never the code.

### 4.2 Redeem

Player enters the code in the client, then chooses their new password and/or PIN.

`POST /player/credential-reset/redeem` — unauthenticated, because a player who
forgot their password cannot hold a token.

```
{ "login_id": "GK00272341", "code": "8601-XFWHMIRN",
  "new_password": "...", "new_pin": "1234" }
```

Server: look up PENDING row by `player_id` + prefix, verify bcrypt, check expiry,
apply only the fields the scope permits, mark `REDEEMED`, clear PIN lockout,
audit.

### 4.3 Rate limiting

Reused verbatim from the transfer PIN, including the lesson that produced it:
**a wrong code RETURNS a status rather than raising**, because raising aborts the
transaction and rolls back the `failed_attempts` increment, leaving the counter
permanently at zero. That exact bug shipped in `submit_point_transfer` and was
only caught by executing it. See `20260815130500`.

- 5 wrong attempts locks that code for 15 minutes
- 10 per hour per IP on the unauthenticated endpoint
- A locked code can still be cancelled and reissued by an operator

## 5. Reset Member ID

Separate, rarer, and more dangerous. Changing `login_id`:

- **is safe for the ledger** — every ledger row references `player_id` (uuid),
  never the login id, so points and history follow the player automatically
- **is not safe for support** — the old id may be written on a slip of paper, so
  the previous value must remain searchable

Therefore:

```
player_login_id_history
  player_id, previous_login_id, changed_by, changed_at, reason
```

New id is generated by the same `generatePlayerLoginId()` as account creation, so
format stays `GK` + 8 digits. Restricted to **PRIMARY** administrators. Refused
while the player has a PENDING transfer, since a transfer receipt shows the
sender's login id and would then name an id that no longer exists.

## 6. API

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/admin/users/:id/credential-reset` | admin | issue a code, returns it once |
| GET | `/admin/users/:id/credential-reset` | admin | status only, never the code |
| DELETE | `/admin/users/:id/credential-reset` | admin | cancel a pending code |
| POST | `/admin/users/:id/reset-login-id` | **primary** | issue a new GK id |
| POST | `/player/credential-reset/redeem` | none | redeem, set new credentials |

All writes go through `SECURITY DEFINER` RPCs that assert the actor and write an
audit row, matching every other mutation in this codebase. The tables get
`SELECT`-only grants to `service_role` — see `20260816001000`, where three tables
with RLS-but-no-grants made the admin console show zero games in production.

## 7. Console

New **Reset credentials** action on the player row in `AdminUsers`, opening a
dialog with:

- scope radio: Password · Transfer PIN · Both  (mirrors "Required")
- issue button, then the code shown once with copy, expiry, and a warning
- pending state showing scope, expiry, attempts used, and a Cancel action
- **Reset Member ID** behind a separate confirm, primary-only, showing the
  old and new id

## 8. Tests

SQL suite (`supabase/tests/`), following `point_transfer_test.sql`:

- issue → redeem sets exactly the credentials in scope, and no others
- a redeemed code cannot be redeemed twice
- an expired code is refused
- a wrong code **increments the counter and that increment survives** — the
  regression that matters most
- 5 wrong attempts lock; the correct code is then refused
- issuing a second code cancels the first
- a non-admin cannot issue; a non-primary cannot reset a member id
- points and ledger are untouched by any reset
- login id rotation preserves balance, ledger and transfer history

## 9. Decisions needed

1. **Code shown once, or listed like the screenshot?** Recommend once. Listing it
   makes every live credential readable by every operator.
2. **Expiry.** Recommend 24h. The reference shows no expiry, which means codes
   live forever.
3. **Does redeeming force the player to choose new credentials, or is the code
   itself the new password?** Recommend choose-your-own: a code readable by an
   operator should never become a standing password.
4. **Who may issue?** Recommend any operator for password/PIN, PRIMARY only for
   member id.
5. **Does the player client have a redeem screen?** If not, this is operator-only
   until the Unity work lands, and the operator sets the credential directly.

## 10. Estimate

Migration and RPCs ~200 lines, endpoints ~150, console dialog ~200, SQL tests
~150. The unknown is item 5: without a client redeem screen, the flow ends at the
operator and the code has nowhere to be typed.
