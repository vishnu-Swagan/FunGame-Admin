# MyDGP player game API (v1)

This is a server-authoritative, virtual-play-points-only session boundary for
the Unity cabinets. It is a foundation only: this change does **not** deploy
the function, enable any runtime, or alter player accounts.

Every call needs only the authenticated player's Supabase access token:

```http
Authorization: Bearer <Supabase player access token>
Accept: application/json
```

Unity must never receive a service-role key, player password, refresh token,
or a client-side balance adjustment path.

## Exact Unity routes

Base after a future deployment:

```text
https://<project-ref>.supabase.co/functions/v1/game-api
```

| Method | Route | Request |
| --- | --- | --- |
| `GET` | `/player/lobby` | — |
| `POST` | `/sessions` | `{"game_slug":"fun-roulette"}` |
| `GET` | `/sessions/{id}` | — |
| `POST` | `/sessions/{id}/actions` | documented intent below |
| `GET` | `/sessions/{id}/events?after=42` | — |

All successful responses include:

```json
{"schema_version":1,"status":"ok"}
```

The lobby response also contains the authenticated `player` and a top-level
non-negative integer `balance`. Session and action replies include the exact
requested `session_id`, `cursor`, non-null `allowed_actions`, and a full
`state` object. Its mandatory fields are `round_number`, `phase`,
`phase_ends_in`, `balance`, `my_total`, `min_bet`, `max_bet`, `last_payout`,
`reveal_seconds`, `outcome_json`, `my_bets`, `paytable`, `history`, `readouts`,
`options`, `reveal`, and `allowed_actions`. Amounts outside Unity's signed
32-bit range are rejected by the server instead of rounded.

## Action intent

The only accepted request keys are `action`, optional `selection`, optional
`amount`, and `idempotency_key`:

```json
{
  "action":"place_bet",
  "selection":"straight:17",
  "amount":10,
  "idempotency_key":"new-client-key-per-button-press"
}
```

The wire verbs are exactly `place_bet`, `clear_bets`, `cancel_bet`,
`repeat_bets`, `deal`, `collect_full`, `collect_half`, `gamble`, `hold`,
`release`, and `cash_out`. The server derives the player, session, round,
balance, outcome, payout and ledger details itself. Requests containing those
server-owned fields are rejected.

Only generic clocked-table `place_bet`, `clear_bets`, and `cancel_bet` paths
are represented in this foundation. Every other cabinet-specific verb fails
closed until that cabinet's resolver is parity-reviewed. Unity additionally
refuses buttons omitted from the latest `allowed_actions` state.

## Runtime gates and catalog

`20260814063000_live_game_sessions.sql` seeds all 15 catalog mappings with
`availability = DISABLED`. The database allows a session only when the catalog
game is `ENABLED`, the runtime is `ENABLED`, and the runtime is
`QA_VERIFIED`. It also checks active player status, exclusions, and maintenance
mode inside the privileged procedure.

The map covers: 7Up7Down, Fun AB, Triple Fun, Fun Roulette, Fun Target, Bingo,
Joker Bonus, Giant Jackpot, Golden Wheel, Keno, Checker, Lucky 8 Line, Fever
Joker Bonus, No Hold, and Champion Poker. The map preserves each catalog,
Unity tile, Unity scene, engine slug, action aliases, and source-derived
timing. It intentionally leaves uncertain client rules disabled—especially
Triple Fun and Golden Wheel, whose current local engines are not client-parity
proof.

The schema stores immutable idempotent actions, server-created clocked rounds
with SHA-256 outcome commitments, wagers linked to the existing immutable
play-points ledger, and an append-only per-player event outbox. New tables and
RPCs are revoked from `anon` and `authenticated`; only the Edge function's
server credentials invoke the privileged procedures.

## Verification performed locally

The pure contract tests are runnable without a deployed project:

```bash
node --experimental-strip-types <Deno-test shim for game-core.test.ts>
git diff --check -- supabase/functions/game-api supabase/migrations/20260814063000_live_game_sessions.sql
```

Native `deno check` is currently blocked on this workstation by a Homebrew
dynamic-library code-signature failure. Before deployment, run `deno fmt`,
`deno check`, `deno lint`, and `deno test` in a healthy Deno environment, then
apply the migration to a staging Supabase project and test the Unity endpoint
against a real player JWT. Do not promote a runtime to `QA_VERIFIED` or
`ENABLED` until its rule, timing, settlement, and visual/reveal tests pass.
