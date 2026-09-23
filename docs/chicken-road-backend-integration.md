# Chicken Road backend integration — dormant proposal

The engine implements [the unapproved rules proposal](chicken-road-live-rules-proposal.md). It is not a certified provider implementation. `backend/routes_chicken_road.py` sets `RULES_APPROVED = False`; importing the module neither registers routes nor accesses the database. Implementation and automated verification used no live wager or production database call. A dormant application deployment does not activate these routes.

## Release gates and startup

New preparation, Play, and GO require all of:

1. The source-controlled `RULES_APPROVED` decision, currently **False**.
2. `CHICKEN_ROAD_LIVE_ENABLED=true`, default **false**.
3. The existing reviewed-game allow-list and an enabled catalogue record.
4. `CHICKEN_ROAD_EXPOSURE_LIMIT`, a positive whole-chip **operator liability limit**.
5. Existing account/authentication/compliance restrictions, installed source-aware wallet adapter, wallet readiness, and transactional gameplay support.

The exposure limit is not evidence of deposited capital or available cash. The operator remains responsible for sufficient liquidity. The module reserves the maximum gross payout for each accepted round against one atomic outstanding-liability counter and releases it only within terminal settlement. A cap is checked before intake; it never truncates an earned payout.

After approval, deployment startup must call `prepare_chicken_road_storage()` before intake and schedule `settle_expired_chicken_rounds()` on the existing server worker. The intrinsic Mongo `_id` constraints protect operation receipts, commitments, round IDs, and per-player active guards; initialization adds query indexes and creates the exposure counter without resetting existing liabilities. A missing counter rejects intake. Transaction failure fails closed through `run_game_transaction`; there is no production nontransactional fallback.

Pausing the environment flag stops new risk. Once the rules have been approved, authenticated receipt/fairness reads, current-round reads, cash-out, and the expiry worker can continue to resolve retained stakes. The worker can settle accounts that subsequently become suspended, excluded, or deleted, because settlement is not permission to place another stake. A broken round is retained and logged for reconciliation; a version-guarded 60-second retry delay lets later batches advance without releasing or modifying its financial reservation.

## API contract

All paths below are relative to `/api/live/chicken-road`. Authentication uses the existing player dependency; no public demo endpoint is registered. Amounts are **whole chips**, never client-side cents. Bodies reject unknown fields and numeric coercion. Operation IDs are 8–128 ASCII letters/digits/`_:-`; a UUID is suitable.

| Method/path | Body | Response |
| --- | --- | --- |
| `GET /state` | — | `{mode:"live", enabled, rules, balance, active_round, latest_round}` |
| `POST /prepare` | `{operation_id}` | `{operation_id, commitment_id, server_seed_hash, nonce, rules_version, fairness_version, expires_at}` |
| `POST /play` | `{operation_id, commitment_id, client_seed, difficulty, amount, rules_version}` | Mutation receipt below |
| `POST /go` | `{operation_id, round_id, expected_version}` | Mutation receipt below |
| `POST /cashout` | `{operation_id, round_id, expected_version}` | Mutation receipt below |
| `GET /operations/{operation_id}` | — | `{found:false, operation_id}` or `{found:true, ...stored_receipt}`; strictly read-only |
| `GET /rounds/{round_id}/fairness` | — | Terminal-only seed disclosure below |

`rules` contains `version`, `approval`, `rtp_bps:9700`, `min_stake:100`, `max_stake:1000`, `stake_step:100`, `max_lanes:13`, and `difficulties:[{id,label,multipliers_hundredths,collision_fractions:[{numerator,denominator}]}]`. The pure proposal engine reports `UNAPPROVED`; a registered runtime reports `APPROVED` only after the explicit code approval gate. The default gate returns `503 CHICKEN_ROAD_DISABLED` before any state response or mutation.

A successful mutation returns:

```json
{
  "operation_id": "the-original-operation-id",
  "result": "hopped | crashed | cashed_out",
  "balance": 900,
  "round": {
    "id": "server-round-id",
    "status": "PLAYING | CRASHED | CASHED",
    "version": 1,
    "amount": 100,
    "difficulty": "medium",
    "lane": 1,
    "multiplier_hundredths": 112,
    "cashout_amount": 112,
    "payout": 0,
    "rules_version": "chicken-road-proposal-v1",
    "fairness_version": "chicken-road-hmac-v1",
    "multipliers_hundredths": [112,128,147,170,198,233,276,332,403,496,620,691,890],
    "server_seed_hash": "commitment-hash",
    "client_seed": "64-lowercase-hex-characters",
    "nonce": "commitment-id",
    "expires_at": "UTC-ISO-timestamp-or-null",
    "created_at": "UTC-ISO-timestamp",
    "settled_at": null,
    "reason": null
  }
}
```

Alternative status/result strings in this illustrative JSON denote enumerations. Cash-out increments version without advancing lane; a collision advances lane and makes multiplier/cashout/payout zero. Final-lane survival automatically settles. Terminal reasons are `COLLISION`, `FINAL_LANE`, `PLAYER_CASHOUT`, or `INACTIVITY`. Locked round data is authoritative on reconnect. `GET /state` may settle an expired round; it is not the read-only operation lookup.

## Commitment and request ordering

Call Prepare first. Only **after receiving the commitment** should the browser generate a fresh 32-byte cryptographic client seed, encode it as 64 lowercase hexadecimal characters, and send Play. The committed ID is also the nonce, so the server cannot choose a new RNG nonce after seeing the client seed. A commitment expires unused after five minutes, is bound to its owner, rules version, and fairness version, and can be consumed only once. Version drift rejects it before taking a stake. Each accepted round gets a fresh server seed and a permanently locked table.

The terminal fairness response returns `round_id`, `server_seed`, `server_seed_hash`, `client_seed`, `nonce`, `difficulty`, `rules_version`, `fairness_version`, and `multipliers_hundredths`. Active-round disclosure returns `409 FAIRNESS_NOT_REVEALED`. Normal state and receipt projections never contain server seeds. The exact canonical JSON/HMAC/rejection-sampling protocol is documented in `chicken_road_engine.py`; a public verifier and independent implementation review remain release work.

## Lost responses, retries, and rejection receipts

Persist a financial intent's operation ID and exact body before sending it. Every operation ID belongs to one player and one exact action/body fingerprint, across all four POST endpoints. Retrying an accepted key returns its original receipt without another stake, hop, credit, or observer event. Its balance is the historical receipt balance; fetch state for the latest balance.

A timeout or transport/5xx failure is uncertain. Check `GET /operations/{id}` and then state. `found:false` does not prove an in-flight original request can no longer commit. An explicit retry must reuse the same ID and exact body; never silently send a replacement stake under a new key. Another device's actions may make the current state newer than an old receipt.

Domain rejections roll back the financial transaction, then durably save a rejected receipt. A competing accepted receipt for the same intent wins the receipt race. Rejected receipt lookup returns:

```json
{"found":true,"operation_id":"original-id","status":"REJECTED","error":{"status_code":409,"code":"INSUFFICIENT_CHIPS","message":"There are not enough chips for this stake."}}
```

The POST itself returns the corresponding HTTP error with `detail:{code,message}`. Representative definitive errors are `CHICKEN_ROAD_PAUSED`, `ROUND_ACTIVE`, `ROUND_VERSION_CONFLICT`, `ROUND_FINISHED`, `COMMITMENT_UNKNOWN`, `COMMITMENT_EXPIRED`, `COMMITMENT_USED`, `RULES_CHANGED`, `INSUFFICIENT_CHIPS`, and `EXPOSURE_LIMIT`. An approved runtime pause produces a durable `409 CHICKEN_ROAD_PAUSED` for new risk only after checking the receipt: accepted retries still replay while paused. Reusing a key with different input returns `IDEMPOTENCY_CONFLICT` and preserves its original receipt. Pydantic `422` body/path validation occurs before any mutation and has no operation receipt. Authentication/authorization `401/403` and readiness `503` are not final rejection receipts; an earlier uncertain attempt still requires authenticated reconciliation.

## Transaction boundary and verification limits

Each accepted mutation atomically couples its round CAS/version transition, one-active-round guard, seed consumption, exposure movement, shared ledger/source-wallet allocation, terminal history, settlement observer event, and operation receipt. Payout is derived from the transaction's current locked lane. GO, Cash Out, expiry, and collision compete on the same round version, so a losing lane cannot remain temporarily cashable. Every losing stake also receives `ledger.record_settlement`; no direct balance updates are added.

Engine tests use exact fractions and deterministic cryptographic fixtures. Route tests use isolated mock collections and a serialized snapshot/rollback transaction double with injected failures. These tests establish application invariants and hook usage, **not Mongo replica-set isolation or deployment certification**. A staging replica-set concurrency/rollback run, public verifier, approved rules/limits, and explicit release decision remain necessary before activation. Do not test by placing production wagers.

Local verification (2026-09-23): `python -m pytest -q test_chicken_road_engine.py test_chicken_road_routes.py` passed **72 tests and 841 subtests**. The existing transaction and source-wallet suites passed another **27 tests**. Undefined-name checks passed. A follow-up independent Codex CLI review found no further actionable defects after fixing commitment-version binding, durable paused-intake rejection, and expiry retry starvation. A separate agent audit additionally identified and verified a fix preserving immutable terminal fairness proofs across later rules-version changes. These results do not constitute third-party certification.
