# Game API and Unity integration review

**Review date:** 2026-08-14

**Scope**

- chakri-unity/unity/Assets/Scripts/Runtime/GameApiContract.cs
- chakri-unity/unity/Assets/Scripts/Runtime/SupabaseGameServer.cs
- chakri-unity/unity/Assets/Scripts/Runtime/RuntimeServiceConfig.cs
- supabase/functions/game-api/index.ts
- supabase/functions/game-api/game-core.ts

This is a read-only integration review. No game code was changed by this
reviewer, no function was deployed, and no game was enabled.

## Current status

The current source now has a deliberately Unity-shaped server adapter. The
following transport pieces match when the current source and current migration
are deployed together:

- the approved HTTPS Supabase Edge base URL;
- bearer-only active PLAYER authentication;
- legacy Unity routes (/player/lobby, /sessions/...);
- the Unity schema_version: 1, status: "ok" envelope;
- Unity's top-level action body and body idempotency key;
- Unity's state and events parser shapes;
- virtual-points-only server ledger writes for the narrow place_bet,
  clear_bets, and cancel_bet paths.

That is a substantial improvement over the earlier incompatible /v1 shape,
but it is not a live-parity completion. The identity mapping between lobby,
catalog, and scene still prevents several cabinets from binding a session, and
there is no completed server settlement/result resolver for any cabinet. All
catalog runtimes must remain disabled.

## Exact compatible wire contract

The following table is the current common contract. It is important not to
replace it with a second route family while Unity is using this adapter.

| Operation | Unity request | Current Edge route/expectation | Current successful response shape |
| --- | --- | --- | --- |
| Lobby | GET | GET /player/lobby | schema_version, status, player, balance, games, virtual_points_only |
| Open session | POST body {"game_slug":"<slug>"} | POST /sessions; slug must be the API catalog slug | 201 plus session state with root session_id |
| Poll state | GET | GET /sessions/{session_id} | root session_id, cursor, allowed_actions, state |
| Submit action | POST body action, selection?, amount?, idempotency_key | POST /sessions/{session_id}/actions | root state snapshot after server processing |
| Poll events | GET | GET /sessions/{session_id}/events?after={cursor} | schema_version, status, cursor, next_after, allowed_actions, events |

The base URL check remains appropriately strict:

    https://<project>.supabase.co/functions/v1/game-api

Unity does not embed a service-role key.

### Action body and idempotency

The current Unity body produced by GameApiContract.ActionJson is accepted by
actionRequest in the Edge function:

    {
      "action": "place_bet",
      "selection": "straight:17",
      "amount": 10,
      "idempotency_key": "32-character-guid"
    }

The server validates the body key as 8–160 safe characters. An
X-Idempotency-Key header is currently optional; if supplied it must equal the
body key. Therefore the existing Unity sender is compatible, but documentation
must not claim the header is required until both client and server are
deliberately changed together.

One logical tap must keep the same key if its HTTP request is retried. A new
tap must get a new key. The client must never derive that key from a balance,
outcome, timer, or result.

## State envelope mapping: currently compatible

Unity's GameApiWire requires a successful envelope and a nested state with all
mandatory numeric fields. The current snapshot() emits those fields in the
correct locations:

| Unity parser field | Edge snapshot source |
| --- | --- |
| root session_id | game_player_sessions.id |
| root cursor | latest player/session outbox event ID |
| root/state allowed_actions | server-calculated action permission list |
| state.round_number | server shared-round number |
| state.phase | server clock (BETTING, REVEAL, RESULT) |
| state.phase_ends_in | server clock remaining seconds |
| state.balance | server profiles.play_points_balance |
| state.my_bets, state.my_total | server persisted open wagers |
| state.min_bet, state.max_bet | current catalog GameSpec limits |
| state.outcome_json, state.reveal | server-generated public result, omitted during BETTING |
| state.paytable/history/readouts/options | explicit empty placeholders pending game-specific parity data |

The server also guards all values that Unity presently stores as int with a
UI_MAX_INT check. That is preferable to silently clamping a real virtual-point
balance.

The event adapter is likewise parse-compatible: it returns id and cursor, plus
payload.state in the exact shape consumed by GameApiWire.TryApplyEvents. The
Unity initial Prime request correctly fails closed if that route is absent or
malformed.

## Blocking mismatch 1 — cabinet identity is still not mapped

There are three separate cabinet identifiers:

1. catalog slug — the game API/database key;
2. lobby slug — the open: action on the visible Unity lobby row;
3. scene slug — CabinetScreen.GameSlug after Unity loads the scene.

LiveGameSessions.Open(slug) currently receives the lobby slug. createSession
passes that same string to gameSpec() and the database runtime gate, which
expect the catalog slug. Later, CabinetScreen uses the scene slug in
LiveGameSessions.TryGetActive(GameSlug), while the active adapter still stores
the original lobby slug. This creates two distinct failures: API catalog lookup
for some titles and active-session lookup after scene load for others.

| Catalog/API slug | Unity lobby slug supplied to Open | Unity scene slug supplied to TryGetActive | Required handling |
| --- | --- | --- | --- |
| 7up7down | seven-up-down | seven-up-down | Translate lobby → catalog before session creation. |
| fun-ab | fun-ab | andar-bahar | Preserve catalog for API, bind active adapter to scene. |
| triple-fun | triple-fun | triple-fun | Exact names coincide. |
| fun-roulette | roulette | fun-roulette | Translate lobby → catalog; bind adapter to scene. |
| fun-target | fun-target | fun-target | Exact names coincide. |
| bingo | bingo | bingo | Exact names coincide. |
| joker-bonus | joker-bonus | fever-joker | Bind adapter to scene. |
| giant-jackpot | giant-jackpot | giant-jackpot | Exact names coincide. |
| golden-wheel | golden-wheel | super-golden-wheel | Bind adapter to scene. |
| keno | keno | keno | Exact names coincide. |
| checker | checker | checker | Exact names coincide. |
| lucky-8-line | lucky8line | lucky-8-line | Translate lobby → catalog; bind adapter to scene. |
| fever-joker-bonus | fever-joker | fever-joker-bonus | Translate lobby → catalog; bind adapter to scene. |
| no-hold | no-hold | no-hold | Exact names coincide. |
| champion-poker | champion-poker | champion-poker | Exact names coincide. |

### Minimal safe fix

Introduce an immutable Unity identity object, resolved from the validated
server lobby catalog before opening a session:

    catalog_slug      -> game-api/create-session and all server authority
    unity_lobby_slug  -> selected lobby row
    unity_scene       -> active adapter binding and CabinetScreen match
    session_id        -> current session endpoint/action path

The Unity lobby must find exactly one server entry by unity_lobby_slug, verify
its catalog_slug, unity_scene, engine, and availability against the compiled
15-game map, then refuse the launch if anything differs. The active adapter
should retain both the catalog slug and the scene slug; it must use the catalog
only for API ownership and the scene only for Matches/TryGetActive.

Do not solve this by accepting arbitrary scene or lobby aliases in database
RPCs. That would weaken the server's one canonical catalog key.

## Blocking mismatch 2 — state transport works, but result settlement does not

The game session schema has immutable wagers, actions, and ledger references,
but the current Edge function does not yet settle a completed round.

- snapshot() always returns last_payout: 0.
- act() invokes only submit_game_stake and refund_game_wagers; it never invokes
  resolve_game_wager.
- settleReviewedWager() exists in game-core.ts for Roulette but is not used by
  an Edge round resolver.
- No routine marks every open wager resolved at REVEAL/RESULT, posts a prize
  ledger entry, updates the wager status, records the exact outcome, or
  exposes a server-derived per-player payout.
- Several server outcome shapes are deliberately absent. Calling
  generateServerOutcome for an unimplemented title throws rather than
  inventing a result, which is good fail-closed behaviour but not live
  gameplay.

Therefore a player may not be allowed to stake until a game is enabled, but
no enabled game would currently complete a virtual-point result cycle. Do not
set any runtime to QA_VERIFIED or ENABLED before each cabinet has:

1. a server-only result generator matching the observed client outcome;
2. an exact settlement/paytable resolver;
3. an idempotent per-wager or per-round ledger settlement;
4. authoritative last_payout, outcome, history, readouts, and reveal data;
5. timing/result tests against the client cabinet.

## Blocking mismatch 3 — reveal duration is sent as remaining time

For a Unity reveal animation, RevealSeconds is the full measured reveal
duration, while PhaseEndsIn is the changing remaining time. Unity uses both to
calculate its animation progress:

    elapsed = RevealSeconds - (PhaseEndsIn - local_time_since_snapshot)

The local server sets RevealSeconds to the table's configured reveal duration.
The Edge snapshot currently sets:

    reveal_seconds: clock.phase === "REVEAL" ? phaseEndsIn : 0

That causes a re-poll during REVEAL to reset the animation's duration to the
remaining time, producing wrong speed/restarts and preventing a precise visual
match. Once a title's timing is parity-approved, the Edge snapshot must return
the fixed approved spec.timing.reveal_seconds (or exact per-round recorded
duration) throughout the round; only phase_ends_in should count down.

This is a visual/timing blocker even though the JSON field type is compatible.

## Multiplayer/result visibility gap

Clocked titles use a globally keyed server round, so an approved resolver can
produce the same outcome for every player in the table. That is the correct
base for shared results.

However, the current event read is restricted to the authenticated player's
own player_id and session_id, and it only supplies that player's current
snapshot. It does not provide a public table event stream, participant count,
aggregate table bets, or a shared result/history feed beyond what is in the
state snapshot.

If the reference client displays any table-wide multiplayer result, round
history, or aggregate betting information, add a separate sanitized round-level
feed after observing its exact fields. It must never expose another player's
identity, balance, ledger entry, or private bet amount unless that is
explicitly required and authorised by the source client design. The per-player
ledger must remain private.

## Current action gate: safe but intentionally incomplete

The source correctly keeps the generic action gate narrow:

- place_bet is allowed only while the server says betting is open;
- clear_bets and cancel_bet are allowed only with open wagers;
- all other public cabinet verbs are withheld or rejected until a dedicated
  parity-reviewed resolver exists.

This is preferable to interpreting repeat_bets, collection, deal, hold,
cash-out, or gamble through a generic clocked-table rule. The UI must use
server-provided allowed_actions as permission, not merely button presence or a
local countdown.

## Required verification before deployment

1. Add contract tests that serialize every Unity route/body and deserialize
   every success envelope, plus 401/403/409 failure paths.
2. Add mapping tests for all fifteen catalog/lobby/scene triples and ensure
   aliases above reach the correct scene-bound active adapter.
3. Test Prime against a successful empty-events response and a malformed
   response; malformed must keep the scene closed.
4. Test idempotency: duplicate action body same key returns one ledger action;
   a different action with the same key is rejected; a retry reuses the key.
5. Test server clock boundaries: open betting, locked-but-visible betting,
   reveal, result, and a new round. The server must reject a late action even
   if a stale Unity screen still shows an enabled button.
6. For each game, capture observed client selections, timing, result payload,
   payouts, and graphics/audio transition points before implementing its
   server resolver.
7. Test exact server settlement and immutable virtual-point ledger receipts
   for winning, losing, clear, undo, reconnect, duplicate request, and result
   replay cases.
8. Keep every game_runtime_catalog row DISABLED until that individual cabinet
   has passed its parity suite.

## Conclusion

The current adapter and Edge function now agree on the basic session protocol,
and they correctly fail closed for authentication, malformed envelopes,
unavailable runtimes, and unsupported game actions. The remaining work is not
cosmetic: identity mapping, fixed reveal timing, per-game result/ledger
settlement, and any required multiplayer presentation must be completed before
a cabinet can be called live or client-parity matched.

