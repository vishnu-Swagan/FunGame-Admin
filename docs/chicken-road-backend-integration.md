# Chicken Road backend integration — live-only release

The engine implements [the owner-selected 90% RTP rules](chicken-road-live-rules-proposal.md), with an owner-approved **194,620-chip aggregate outstanding payout limit**. It is not a certified provider implementation. `backend/routes_chicken_road.py` sets `RULES_APPROVED = True` for this reviewed live-only release; server startup registers the routes, prepares storage and starts expiry settlement. New intake still defaults to paused and requires explicit production configuration and catalogue publication. Automated verification uses isolated databases and no production wagers.

## Release gates and startup

New preparation, Play, and GO require all of:

1. The source-controlled `RULES_APPROVED` decision, **True** for this release.
2. `CHICKEN_ROAD_LIVE_ENABLED=true`, default **false**.
3. The existing reviewed-game allow-list and an enabled catalogue record.
4. `CHICKEN_ROAD_EXPOSURE_LIMIT`, a positive whole-chip **operator liability limit**.
5. Existing account/authentication/compliance restrictions, installed source-aware wallet adapter, wallet readiness, and transactional gameplay support.

The exposure limit is not evidence of deposited capital or available cash. The operator remains responsible for sufficient liquidity. The module reserves the maximum gross payout for each accepted round against one atomic outstanding-liability counter and releases it only within terminal settlement. A cap is checked before intake; it never truncates an earned payout.

The approved production values are `CHICKEN_ROAD_EXPOSURE_LIMIT=194620` and
`CHICKEN_ROAD_LIVE_ENABLED=true`. These are the only environment changes in this
release. The existing cash/bonus provenance policy, eligibility restrictions and
broader financial/payment flags remain unchanged. Four legacy production accounts
lacked source-wallet records at read-only preflight; do not invent a cash/bonus
classification or bypass their wallet requirement to make them playable.

Deployment startup calls `prepare_chicken_road_storage()` before intake and schedules `settle_expired_chicken_rounds()` on the existing server worker. A success-only storage latch stays false after partial preparation. The intrinsic Mongo `_id` constraints protect operation receipts, commitments, round IDs, and per-player active guards; initialization adds query indexes and creates a missing exposure counter only when no active round or player reservation exists. Existing liabilities are never reset. A missing or malformed counter rejects intake. Transaction failure fails closed through `run_game_transaction`; there is no production nontransactional fallback.

The health response includes `chicken_road` readiness, intake request, catalogue
state and individual technical requirements. Requested intake with missing
technical readiness fails health; a full exposure budget or operator catalogue
pause is not an outage. Player state advertises `enabled` only when these intake
requirements hold. Definitive missing-storage/configuration rejections are
recorded before mutation, letting the client clear a rejected GO and still cash
out. Pausing intake never suppresses retained-round settlement routes or worker.

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

Current `rules` contains `version:"chicken-road-proposal-v2"`, `approval`, `rtp_bps:9000`, `min_stake:100`, `max_stake:1000`, `stake_step:100`, `max_lanes:13`, and `difficulties:[{id,label,multipliers_hundredths,collision_fractions:[{numerator,denominator}]}]`. The pure engine reports `UNAPPROVED`; the registered runtime overrides this with `APPROVED` only under the explicit code approval gate. This is an application release decision, not certification. Any accepted v1 rounds retain their original 97% version for outcomes, payout settlement, and fairness; new intake uses v2 only. With intake paused, current-round reads and settlement remain available to authorized players.

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
    "rules_version": "chicken-road-proposal-v2",
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

The terminal fairness response returns `round_id`, `server_seed`, `server_seed_hash`, `client_seed`, `nonce`, `difficulty`, `rules_version`, `fairness_version`, and `multipliers_hundredths`. Active-round disclosure returns `409 FAIRNESS_NOT_REVEALED`. Normal state and receipt projections never contain server seeds. The exact canonical JSON/HMAC/rejection-sampling protocol is documented in `chicken_road_engine.py`. The live UI provides an independent Web Crypto verifier bound to the already received terminal round, checking its commitment, attempted lane outcomes and payout. Verification establishes mathematical consistency, not operator certification, historical seed timing or funding.

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

Engine tests use exact fractions and deterministic cryptographic fixtures. Fast route tests use isolated mock collections and a serialized snapshot/rollback transaction double. The additional opt-in `test_chicken_road_mongo.py` suite uses a disposable loopback Mongo replica set and actual Motor transactions, route/ledger/source-wallet code and cash/bonus provenance. Eight tests passed twice, covering duplicate Play, GO/cash-out and expiry/GO races, 194,620-chip exposure contention, actual-HMAC collision and rollback after debit, terminal ledger mutation and receipt insertion. The local Mongo process was stopped and only its test databases were cleaned. These results are release evidence, **not deployment certification**. No production wagers are used for automated testing.

Local verification (2026-09-23): `python -m pytest -q test_chicken_road_engine.py test_chicken_road_routes.py` passed **73 tests and 843 subtests**. The existing transaction and source-wallet suites passed another **27 tests**. Undefined-name checks passed. A follow-up independent Codex CLI review found no further actionable defects after fixing commitment-version binding, durable paused-intake rejection, and expiry retry starvation. A separate agent audit additionally identified and verified a fix preserving immutable terminal fairness proofs across later rules-version changes. The router-order regression assembles the actual server registrations and proves that the approved Chicken Road state endpoint precedes the generic live-state route; reversing the order fails its negative control. These results do not constitute third-party certification.

Live activation verification (2026-09-28): the full backend suite passed **586
tests and 1,765 subtests**. The opt-in Mongo suite is excluded from the default
run and passed separately as described above. The final frontend passed
**82 suites / 728 tests**, its production build passed, and Aviator rendering
passed **4 suites / 27 tests**. Isolated browser checks confirmed all four
difficulty selections, exact collision-risk and inactivity disclosures, and a
successful independent check of a known two-lane terminal proof. No network
wagers were possible in that local browser harness. Financial-integrity review
found no actionable defects. General review identified a keyboard-focus issue
in the proof disclosure; the shared dialog now includes summaries in its focus
trap, with a regression test and a successful Chrome Tab/Enter walkthrough.
One unrelated profile-avatar test timed out during the concurrent build; the
complete suite passed on rerun after the build finished. Existing DepositReturn
mock-XHR console warnings and the bundle-size advisory remain unchanged. Final
review and deployment results are recorded in release evidence.

RTP update verification (2026-09-28): current v2 is 90%; archived v1 remains 97%.
The 86 focused engine/route tests include exact RTP checks for both versions
across all four difficulties, 13 lanes, and ten supported stakes (1,040 cases).
Existing accepted v1 rounds retain their original GO outcomes, cash-out/expiry
settlements, and receipt/fairness history; unused old commitments cannot start a
new v2 stake. A confirmed preparation-only version mismatch is safely retired
in the browser and requires a fresh explicit Play after a rules refresh;
uncertain financial actions keep their original body and operation ID. The UI
labels current rules as applying to new rounds and identifies an active round
that retains an older version. The full backend suite passed 574 tests plus
1,755 subtests; the frontend passed 658 tests. Both general and financial-integrity
reviews finished clean. No production configuration or balances changed.
