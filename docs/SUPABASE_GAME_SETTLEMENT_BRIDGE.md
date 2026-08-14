# Trusted Supabase game-settlement bridge

## Scope and safety boundary

This is a **virtual-play-points-only** bridge for the MyDGP game runtime.  It
does not add a browser or Unity endpoint that can mutate a balance.  Unity
continues to send ordinary authenticated gameplay actions to a trusted server;
the trusted resolver applies the already-existing FastAPI rules and then emits
one server-created settlement command.

```text
Unity APK
  | player JWT + requested game action only
  v
FastAPI game rules / trusted resolver
  | timestamped HMAC (private service-to-service route only)
  v
FastAPI settlement bridge
  | Render-only Supabase service-role credential
  v
Supabase apply_game_play_points RPC -> immutable play_point_ledger
```

The APK never contains either `SUPABASE_GAME_SETTLEMENT_SERVICE_ROLE_KEY` or
`GAME_SETTLEMENT_INTERNAL_HMAC_SECRET`, and it never supplies `delta`,
`balance_after`, or a payout to the bridge.

## Initial route contract

The private endpoint is:

```text
POST /api/internal/game-settlements
```

It is hidden from OpenAPI and returns `404` while the feature is disabled. It
is for a separate trusted resolution worker only—not a mobile/web client.

Required headers:

```text
X-Game-Settlement-Timestamp: <Unix seconds, within 90 seconds>
X-Game-Settlement-Nonce: <new 16–128 character base64url nonce>
X-Game-Settlement-Signature: <lowercase HMAC-SHA256 hex>
Content-Type: application/json
```

Sign the exact UTF-8 value below using `GAME_SETTLEMENT_INTERNAL_HMAC_SECRET`:

```text
POST\n
/api/internal/game-settlements\n
<timestamp>\n
<nonce>\n
SHA256_HEX_OF_RAW_REQUEST_BODY
```

Example body (only a trusted resolver may create it):

```json
{
  "player_profile_id": "7f78c0b1-225b-4cab-9ee8-45a0d649c6d3",
  "game_slug": "seven-up-down",
  "round_id": "live:seven-up-down:123456",
  "event_id": "bet:9309a193-2528-4d98-a5ed-0c621eef41f4",
  "action": "PRIZE",
  "amount": 50,
  "note": "Server resolved winning bet"
}
```

`action` is one of `STAKE`, `PRIZE`, or `REFUND`; it determines the sign.  The
bridge rejects an arbitrary `delta`, an unknown game, malformed UUID, invalid
identifier, oversized amount, stale signature, reused nonce, or invalid HMAC.
It creates a stable idempotency key:

```text
game-v1:<game_slug>:<round_id>:<event_id>:<action-lowercase>
```

That becomes the key passed to Supabase's `apply_game_play_points` RPC.  A
retry therefore returns the same immutable ledger receipt instead of applying
the point movement twice.

## Feature configuration

Do **not** set these on a live service until the cutover checklist below is
complete.  Omitting `SUPABASE_GAME_SETTLEMENT_ENABLED` or setting it to any
value except exactly `true` leaves the bridge inert and creates no new MongoDB
collection/index.

```dotenv
SUPABASE_GAME_SETTLEMENT_ENABLED=true
SUPABASE_GAME_SETTLEMENT_URL=https://<project-ref>.supabase.co
SUPABASE_GAME_SETTLEMENT_SERVICE_ROLE_KEY=<Render-secret-only>
SUPABASE_GAME_SETTLEMENT_ALLOWED_SLUGS=seven-up-down,fun-roulette
SUPABASE_GAME_SETTLEMENT_TIMEOUT_SECONDS=5
GAME_SETTLEMENT_INTERNAL_HMAC_SECRET=<at-least-32-random-characters>
```

The allowlist is required and must be a subset of these reviewed launch games:

| Unity game | FastAPI slug | Existing server authority |
| --- | --- | --- |
| 7Up7Down | `seven-up-down` | `routes_live` fixed-cycle outcome + `settle_bet` |
| Fun AB | `andar-bahar` | `routes_live` fixed-cycle outcome + `settle_bet` |
| Triple Fun | `triple-fun` | `routes_live` fixed-cycle outcome + `settle_bet` |
| Roulette | `fun-roulette` | `routes_games` dedicated roulette rules |
| Fun Target | `fun-target` | `routes_live` fixed-cycle outcome + `settle_bet` |
| Bingo | `bingo` | `routes_live` fixed-cycle outcome + `settle_bet` |
| Joker Bonus | `joker-bonus` | `routes_live` fixed-cycle outcome + `settle_bet` |
| Giant Jackpot | `giant-jackpot` | `routes_live` fixed-cycle outcome + `settle_bet` |
| Golden Wheel | `super-golden-wheel` | `routes_live` fixed-cycle outcome + `settle_bet` |
| Keno | `keno` | `routes_live` fixed-cycle outcome + `settle_bet` |
| Checker | `checker` | `routes_live` fixed-cycle outcome + `settle_bet` |
| Lucky 8 Line | `lucky-8-line` | `routes_live` fixed-cycle outcome + `settle_bet` |
| Fever Joker Bonus | `fever-joker-bonus` | `routes_live` fixed-cycle outcome + `settle_bet` |
| No Hold | `no-hold` | `routes_live` fixed-cycle outcome + `settle_bet` |
| Champion Poker | `champion-poker` | `routes_live` fixed-cycle outcome + `settle_bet` |

The bridge intentionally does not enable Aviator, Blackjack, Teen Patti, Poker
or Ice Fishing yet.  Aviator and Blackjack have multi-action/mid-round
settlement semantics and need their own reviewed idempotency/outbox mapping.

## Required cutover work before enabling even one game

1. Migrate/recreate the real player accounts in Supabase, then store a verified
   Supabase profile UUID mapping for every FastAPI player identity. Never guess
   by display name, email, or login text.
2. Refactor the existing server paths so every accepted stake, payout, refund,
   undo/cancel, and void produces exactly one bridge command.  In particular:
   - `routes_live.live_place_bet` -> `STAKE`
   - `routes_live._live_settle_user` -> `PRIZE`
   - `routes_live.live_clear_bets` -> `REFUND`
   - `routes_games.roulette_place_bet` -> `STAKE`
   - `routes_games._roulette_settle_user` -> `PRIZE`
   - roulette clear/undo -> `REFUND`
3. Use a transactional outbox or make Supabase the sole points ledger first.
   Do **not** enable a naïve Mongo + Supabase dual-write: a timeout between the
   two databases can otherwise make balances disagree.
4. Deploy the resolver inside the private service network, keep the HMAC secret
   in the server secret manager, and restrict the internal route by network
   policy/IP allowlist in addition to HMAC.
5. Run staged replay tests for every action type. Repeating an action ten times
   must yield one Supabase ledger record and one identical receipt.
6. Reconcile old and new ledger balances, then enable one allowlisted game in
   staging before adding the remaining games.

## Verification

The bridge's focused test has no network or live-data dependency:

```bash
python backend/test_trusted_game_settlement.py
```

It verifies that the default configuration is inert, a service-role key stays
server-side, only the fixed Supabase RPC is called, directions/idempotency are
server-derived, unreviewed games and bad profile IDs are rejected, and the
private route rejects both bad HMACs and replayed nonces.
