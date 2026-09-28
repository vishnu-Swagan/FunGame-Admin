# Chicken Road live rules — 90% RTP, owner-approved limit

Updated 28 September 2026. The owner selected **90% RTP**, all four difficulties, and the 100–1,000-chip stake range in 100-chip increments, and approved **194,620 chips as the aggregate outstanding payout limit**. Live activation follows the release checks below; the published game has no demo mode. This document is not certification or authority to change balances outside accepted game actions. This is an original mathematical model, not recovered provider rules. The supplied recording establishes Medium multiplier labels only. See [the source audit](chicken-road-rules-audit.md).

## Selected rules package

- Enable Easy, Medium, Hard, and Hardcore only after the server implementation and release checks below pass. Publish a wallet-connected live game; keep any development preview outside the production catalogue.
- Use the complete 13-lane tables below and **90% theoretical gross RTP / 10% theoretical house edge** for every difficulty and cash-out lane under the specified stake increments. Gross payout includes the stake; it is not additional profit. RTP is a long-run expectation, not a session guarantee.
- Initially accept **100–1,000 whole chips, in increments of 100**. Default 300; suggested presets 100 / 300 / 800 / 1,000. This fits the existing integer-chip ledger and makes every listed payout exact.
- Play deducts once and immediately attempts lane 1. GO attempts exactly one further lane. Cash Out settles the current safe lane. Collision pays zero. Surviving lane 13 automatically cashes out.
- Lock difficulty, stake, paytable, and rules version for the round. One active round per player. After 15 minutes without a successful game action, automatically cash out at the last committed safe lane; closing the browser does not create a loss or cancel a stake.
- Maximum gross round payout is **194,620 chips** at the initial maximum stake. Reserve worst-case round exposure before accepting Play, within the owner-approved **194,620-chip aggregate limit**. Reject a new round before debit if its reservation would exceed the limit. This can limit simultaneous play, especially maximum-stake Hardcore rounds. The atomic liability counter limits outstanding promises; it is not evidence of bank funding. The operator remains responsible for liquidity. Never truncate an earned payout to a cap.

The reference's 3-chip stake and 3.36-chip payout cannot both be retained with the present whole-chip ledger. The proposed default is 300 actual chips, not an undisclosed conversion of 3 chips.

## Proposed full payout tables

All multipliers are exact hundredths. Medium preserves the 13 captured labels; choosing lane 13 as the live endpoint is a new proposal, not evidence of the source game's endpoint. Easy, Hard, and Hardcore are newly authored: respectively `ceil(100 × 1.06^lane) / 100`, `ceil(100 × 1.35^lane) / 100`, and `ceil(100 × 1.50^lane) / 100`, evaluated with exact rational arithmetic. The following table is authoritative for this proposal.

| Lane | Easy | Medium | Hard | Hardcore |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 1.06× | 1.12× | 1.35× | 1.50× |
| 2 | 1.13× | 1.28× | 1.83× | 2.25× |
| 3 | 1.20× | 1.47× | 2.47× | 3.38× |
| 4 | 1.27× | 1.70× | 3.33× | 5.07× |
| 5 | 1.34× | 1.98× | 4.49× | 7.60× |
| 6 | 1.42× | 2.33× | 6.06× | 11.40× |
| 7 | 1.51× | 2.76× | 8.18× | 17.09× |
| 8 | 1.60× | 3.32× | 11.04× | 25.63× |
| 9 | 1.69× | 4.03× | 14.90× | 38.45× |
| 10 | 1.80× | 4.96× | 20.11× | 57.67× |
| 11 | 1.90× | 6.20× | 27.15× | 86.50× |
| 12 | 2.02× | 6.91× | 36.65× | 129.75× |
| 13 | 2.14× | 8.90× | 49.47× | 194.62× |

## Collision probabilities and rounding

For each difficulty let `K[n]` be that lane's multiplier multiplied by 100. Define the **conditional probability of collision on the next attempt**, given survival so far, exactly as:

```text
Lane 1:       p[1] = (K[1] - 90) / K[1]
Lane n >= 2:  p[n] = (K[n] - K[n-1]) / K[n]
Gross payout: P(S,n) = S * K[n] / 100 whole chips
```

These equations specify every lane's probability without rounding percentages. Store and sample the integer ratios; rounded UI percentages must never drive outcomes. For example, Medium lane 1 collides with probability `22/112`, lane 2 with `16/128`, lane 12 with `71/691`, and lane 13 with `199/890`.

The survival probabilities telescope to `Pr(reach n) = 90/K[n]`. Therefore `Pr(reach n) × P(S,n) / S = 0.90`. Under the selected 100-chip increments, payout division has no remainder: **no payout rounding is applied**. This also preserves 90% expected gross return for a bounded decision to cash out or continue based only on public history, with automatic settlement at lane 13; it assumes no knowledge of future outcomes. GO adds volatility without charging a second house edge at every lane.

Current rules version is `chicken-road-proposal-v2`. The prior `chicken-road-proposal-v1` remains a distinct 97% profile for replay and settlement of any already accepted rounds. New intake uses v2 only; the version is part of both seed commitments and lane HMAC messages. This update changes neither an existing round's odds nor its locked payout table.

| Difficulty | Lane 1 collision | Later-lane collision range | Reach lane 13 | Max gross payout at 1,000-chip stake |
| --- | ---: | ---: | ---: | ---: |
| Easy | 15.0943% | 5.2239–6.1947% | 42.0561% | 2,140 chips |
| Medium | 19.6429% | 10.2750–22.3596% | 10.1124% | 8,900 chips |
| Hard | 33.3333% | 25.8258–26.2295% | 1.8193% | 49,470 chips |
| Hardcore | 40.0000% | 33.2895–33.4320% | 0.4624% | 194,620 chips |

Percentages above are explanatory approximations. Each harder difficulty has greater conditional collision risk at every corresponding lane. Risk need not increase from one lane to the next within a difficulty: preserving Medium's recorded 6.20→6.91 step produces a lower collision probability at lane 12. Disclose each next-lane risk; do not describe it as uniformly increasing.

## Alternatives the owner can choose

| Choice | Tradeoff |
| --- | --- |
| **Selected package above** | Exact 90% RTP, unchanged ledger denomination, all four difficulties; minimum 100 chips and 100-chip increments. |
| Keep smaller whole-chip stakes | Use `floor(S × K[n] / 100)` and disclose exact stake/lane-specific RTP, which is below or equal to 90%. A 3-chip Medium first-lane cash-out pays 3 chips and has only 80.3571% expected gross return. This is not recommended as a game advertised simply as “90% RTP.” |
| Keep small stakes and fractional chip payouts | Approve a separate wallet-denomination/precision design first, including every ledger, balance, source allocation, and settlement consumer. Do not silently treat existing whole chips as hundredths. |
| Use the original provider's rules | Supply the complete approved odds, payout tables, limits, rounding, fairness specification, and integration rights. Replace this proposal after validation; the historical repository engine and video do not establish those rules. |

## Implementation and release requirements

1. **Fairness evidence.** Use a fresh cryptographic server seed per round, committed before a fresh client seed and stake are accepted, with an immutable nonce, rules version, and difficulty binding. Derive independent per-lane draws with domain-separated HMAC and exact unbiased rejection sampling into each `K[n]` range; bind lane and rejection counter, consuming fresh indexed bytes on rejection. A uniform integer `u` in `[0, K[n])` survives when `u < 90` on lane 1, otherwise when `u < K[n-1]`. Request retries must reproduce the same result. Reveal the seed only after settlement and never reuse its stream; publish a verifier and commitment/nonce history. Prevent seed replacement, selective outcome retries, and future-outcome leakage. Independent review must verify math, RNG, commitment ordering, and deployed implementation. A hash reveal alone is not certification; no certification is currently claimed.
2. **Atomic state and ledger.** Serialize Play, GO, Cash Out, collision, and inactivity settlement in Mongo transactions against the authoritative round version. Determine the lane, outcome, and payout inside that operation; never expose an uncommitted losing lane as cashable. Use `ledger.debit_chips`, `ledger.credit_chips`, originating stake references, current `game_wallet` source allocation, and `ledger.record_settlement` for both wins and losses. Preserve cash/bonus restrictions and exactly-once observers; never update balances directly. Fail closed if required transaction support is unavailable.
3. **Retries and races.** Require a durable operation ID for every mutation and expected round/version for GO and Cash Out. Persist the request fingerprint and response receipt atomically; replay the receipt for identical retries and reject key reuse with different input. Resolve GO versus Cash Out or expiry through one version transition. Use unique active-round constraints and atomic IDs. Lost responses, refreshes, and reconnects reconcile from the server, never replay client timers as new stakes.
4. **Round continuity and exposure.** Reserve the maximum gross payout before debit; reject unaffordable exposure before starting, never after a win. After interruption, resume the committed round or apply its disclosed inactivity cash-out. An authoritatively accepted crossing must resolve before expiry settlement; neither disconnect nor expiry can cancel an accepted attempt after its outcome becomes available. There is no accepted-round cash-out at lane zero. Do not choose refunds/voids based on knowledge of future outcomes. Record any exceptional void with its reason and exactly one terminal ledger outcome.
5. **Release evidence.** Verify every lane and supported stake with exact arithmetic; run isolated concurrency, duplicate/lost-response, rollback, expiry, reconnect, source-wallet, restricted-account, and hidden-seed tests. Obtain required independent fairness/certification evidence and owner approval of the aggregate exposure budget. Only then deliberately register routes and indexes and amend the reviewed-game gate, production route, and catalogue together. Blink, walking, and fire effects must follow server results and have no influence on settlement.

Architecture references: [integer ledger and settlement hooks](../backend/ledger.py), [source-aware wallet and transaction guard](../backend/game_wallet.py), and [reviewed-game publication gate](../backend/game_access.py). This proposal changes none of them.
