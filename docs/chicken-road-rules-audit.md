# Chicken Road rules and activation audit

Read-only source audit, 23 September 2026. No live gameplay or financial API was called. This document does not authorize game activation or changes to odds, balances, or wallet behavior.

## Source status

- Current GitHub `main`: [`26aa9c0351680ba2c5df8a501ea683949d6c23f0`](https://github.com/vishnu-Swagan/FunGame-Admin/commit/26aa9c0351680ba2c5df8a501ea683949d6c23f0). Chicken Road has no route, engine, frontend, or game-specific tests on this commit and is absent from `PLAYABLE_GAME_SLUGS`.
- [PR #44](https://github.com/vishnu-Swagan/FunGame-Admin/pull/44), head `c8f34f09f17d2e2626599d469e9b3c42d5399b14`, added an Aviator-style crash table and was merged on 2 September.
- [PR #45](https://github.com/vishnu-Swagan/FunGame-Admin/pull/45), head [`040bd9ab599907025f45569ca50b48b43a61b807`](https://github.com/vishnu-Swagan/FunGame-Admin/commit/040bd9ab599907025f45569ca50b48b43a61b807), replaced it with a manual lane-hopping game. This PR was closed without merging. The API and math described below are historical, not current production behavior.
- [PR #73](https://github.com/vishnu-Swagan/FunGame-Admin/pull/73), head `17a28b4ca678e861cf99c401a86b96c0c36e16ae`, removed Chicken Road following a user request and was merged on 3 September.

## Reference behavior and preview boundary

The supplied reference shows a white chicken hopping one lane at a time, a green current coin, gold prior coins, and a red/fire loss coin with a roasted chicken on collision. No cars were observed in the supplied 18-second clip. The manual control sequence is Play, then GO or CASH OUT. The visible Medium multipliers are `1.12, 1.28, 1.47, 1.70, 1.98, 2.33, 2.76`.

Later recording frames also show `3.32, 4.03, 4.96, 6.20, 6.91, 8.90`. These thirteen labels do not establish crash probabilities, the complete Medium ladder, other difficulties, payout rounding, maximum exposure, or an approved return-to-player model. They must not be used to infer those rules. The visual rebuild is an isolated demo: captured Medium labels only, no API or wallet calls, and no claim that its outcomes represent production odds.

## Historical manual API

Source: [`backend/routes_chicken_road.py` at PR #45](https://github.com/vishnu-Swagan/FunGame-Admin/blob/040bd9ab599907025f45569ca50b48b43a61b807/backend/routes_chicken_road.py). Paths below include the application's `/api` prefix.

| Request | Historical behavior |
| --- | --- |
| `GET /api/live/chicken-road/state` | Returns balance, limits, difficulty multiplier arrays, active round, personal history, wins, and player counts. |
| `POST /api/live/chicken-road/play` with `{amount, difficulty}` | Debits the integer stake and immediately attempts lane 1. Returns `result: hopped` or `crashed`, balance, and round. There is no separate start-only call. |
| `POST /api/live/chicken-road/go` with `{round_id}` | Attempts the next lane; returns authoritative round and balance. Last lane rejects further GO. |
| `POST /api/live/chicken-road/cashout` with `{round_id}` | Settles a surviving round for `int(round(amount * current_multiplier))`; returns `result: cashed_out`, multiplier, payout, balance, and round. |
| `GET /api/live/chicken-road/rounds/{round_number}/fairness` | Reveals the seed and crash lane only after settlement. |
| `GET /api/live/chicken-road/top?period=day` | Win ranking; accepted periods are day, month, year. |
| `POST /api/live/chicken-road/bets` or `/bets/cancel` | Returns 410 to obsolete crash-table clients. |

Round states are `PLAYING`, `CASHED`, and `CRASHED`. The round exposes its ID, number, stake, difficulty, 30-lane multiplier array, current lane/multiplier, cashout amount, and seed commitment. Seed and crash lane remain hidden until settlement. Limits were 10–10,000 chips; presets were 20/50/100/500. Rounds more than 15 minutes old were settled as losses by a background worker, measured from creation rather than last activity.

## Historical math does not match the captured Medium labels

Source: [`backend/game_engines.py` at PR #45](https://github.com/vishnu-Swagan/FunGame-Admin/blob/040bd9ab599907025f45569ca50b48b43a61b807/backend/game_engines.py).

| Difficulty | Conditional crash chance per attempted lane | Historical first seven multipliers |
| --- | --- | --- |
| Easy | 5% | 1.01, 1.03, 1.06, 1.10, 1.15, 1.19, 1.24 |
| Medium | 10% | 1.02, 1.07, 1.15, 1.25, 1.38, 1.54, 1.74 |
| Hard | 16% | 1.05, 1.18, 1.36, 1.60, 1.92, 2.35, 2.92 |
| Hardcore | 25% | 1.12, 1.40, 1.82, 2.45, 3.40, 4.85, 7.10 |

A 32-byte random server seed produces `u` from the first 13 hex digits of `SHA256("chicken-road-hop-v1:" + seed)`, divided by `2^52`. The crash lane is the geometric inverse CDF `floor(log(1-u)/log(1-p)) + 1`, clamped to 1–31; lane 31 means surviving all 30 playable lanes. The commitment hashes `chicken-road-hop-commit-v1:{difficulty}:{seed}`.

`CHICKEN_ROAD_DEFAULT_RETURN_FACTOR = 0.97` and an environment override exist, but neither participates in crash-lane or multiplier calculation. The authored ladder is financially inconsistent with that label: always attempting Medium lane 30 yields expected gross return `950 * 0.9^30 ≈ 40.27` times stake before payout rounding, not 0.97. This is an audit calculation, not an approved replacement model. Do not restore or relabel these historical odds as validated.

## Security and reliability findings

Historical safeguards include authenticated active-player checks, the reviewed-game gate, round ownership checks for GO/cashout, a unique active round per player, and transactional stake/cashout operations through the shared ledger. They are insufficient to justify restoration:

1. **Crash versus cashout race:** crash GO writes the losing lane and its multiplier outside the settlement transaction, while status is still `PLAYING`. A concurrent cashout can credit that losing lane before crash settlement claims the round.
2. **Stale cashout value:** payout is calculated from a multiplier read before entering the transaction. The transaction re-reads the round but does not recompute from its current lane/version; simultaneous GO can therefore settle the wrong multiplier.
3. **Missing request idempotency:** Play and GO have no operation key or expected-lane/version field. A lost-response retry can debit another stake after an immediate crash, or advance an extra lane after a successful GO. Sequential cashout cannot pay twice because of the status guard, but repeat requests return 400 instead of replaying the receipt.
4. **Round-number race:** allocation reads the largest number and adds one. Concurrent users can collide with the unique index; the duplicate is incorrectly reported as an already-active player round.
5. **Incomplete current settlement integration:** historical routes do not call today's `ledger.record_settlement` for wins or losses. That event is required to notify settlement observers once per originating stake. Preserve current source-wallet allocation and settlement hooks; never update balances directly.
6. **Misleading activity count:** historical `/state` fabricated `online = 45200 + playing_now + time_jitter`. A rebuild should use verified counts or omit the number.
7. **Insufficient verification:** the historical suites inspect seeded math and sequential mocked lifecycle cases. They do not establish race safety, request replay, transaction rollback, economic consistency, or current source-wallet integration. Tests were inspected during this audit, not executed.

## Required before wallet-backed activation

- Obtain an explicit approved full multiplier and probability specification for every offered difficulty, payout rounding, maximum payout/exposure, abandonment handling, and rules/fairness disclosure. The reference supplies appearance and a partial Medium ladder only.
- Implement a server-authoritative transactional state machine that serializes GO, cashout, crash, and expiry, using round version checks and durable request receipts. Derive payout from the transaction's authoritative state.
- Keep authentication/compliance, reviewed-game gating, current shared ledger, source references, source-wallet allocation, settlement events, and fail-closed Mongo transaction behavior. Add atomic round-number allocation or remove dependence on globally sequential numbering.
- Verify concurrency, duplicate and lost-response retries, insufficient funds, deleted/restricted accounts, rollback, expiry/reconnect, hidden seed data, payout rounding, and complete ladder economics. Use isolated tests; do not test by placing production bets.
- Review backend registration, catalogue publication, unique indexes, deployment compatibility, and client reconciliation before deliberately enabling the slug. Do not enable it merely to make the visual preview accessible.
