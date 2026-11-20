# Chakri.Casino — eight-player QA and RTP report

20 November 2026 · Sky AMC installation · synthetic test chips only

**Result:** Eight automated player accounts exercised the eleven available game services. All eight final balances reconciled with their source wallets. One confirmed application defect was found in Rummy's wallet-error handling, fixed, regression-tested and verified on the live backend. Several payout-design concerns remain. This is a bounded engineering assessment, not an independent gaming certification or a human usability panel.

## Scope and method

- Eight clearly labelled QA accounts, each provisioned with 10,000 synthetic promotional chips through the existing account-provisioning business logic. They used normal authenticated player HTTP requests for game actions.
- Eight concurrent player identities; some action tasks overlapped across games. This was not a controlled maximum-capacity benchmark.
- Sixty-four test stakes across eight shared timed tables, eight Blackjack hands, eight Chicken Road rounds, and eight Rummy practice tables.
- Offline engine experiment: 20,000 generated rounds per strategy, eight strategy profiles per game, ten games, **1,600,000 simulated bets**. Rummy was excluded from this mathematical simulation because it is a multiplayer skill game.
- Offline simulations used the recovered game engines; Aviator used the live configured return factor, 0.945. No deposit, withdrawal, funded payment-provider call, or transfer of player funds was performed.
- Final service probes: **88/88 HTTP 200** across eight players and eleven game endpoints. These requests ran from the application machine to its local API, excluding public-network and browser rendering time.

## Functional results

| Game | Eight-player check | Result |
| --- | --- | --- |
| Aviator | Eight 100-chip stakes with 2x auto cashout | All eight reached terminal LOST receipts in the tested shared round; expected when that round crashes before 2x |
| Seven-Up-Down | Up/Down/Seven stakes | Eight settled receipts |
| Andar Bahar | Both main sides | Eight settled receipts |
| American Roulette | Red/black stakes | Eight settled receipts |
| Keno | Different number selections | Eight settled receipts |
| Pappu Pictures | Different picture selections | Eight settled receipts |
| Teen Patti | Player/dealer selections | Eight settled receipts |
| Poker | Player/dealer selections | Eight settled receipts |
| Blackjack | Deal, stand and insurance-decline handling | All eight hands completed |
| Chicken Road | Prepare, play, cashout and replay of the same operation | Seven CASHED, one CRASHED; successful cashout retries returned the original receipt |
| Rummy | Eight practice rooms, authenticated state access, reconnect/expired-seat guards; attempt to join LIVE with restricted bonuses | Practice rooms opened. LIVE correctly remains ineligible for restricted bonuses. Its former server-error response is now a structured rejection. Full funded five-player settlement remains unverified on this installation |

Final wallet reconciliation passed for all eight accounts. There were no outstanding timed bets when cleanup completed. All eight QA accounts are now **SUSPENDED**, their active sessions removed, and their synthetic records retained for audit. Their balances are test data, not deposits or evidence of cash backing.

## RTP findings

RTP means gross payout divided by stake, including any returned original stake. It is a long-run expectation, not a promise for one player or session. These are per-bet figures; no single platform-wide RTP was established.

| Game / bet | Exact calculation or configured value | Simulation observation |
| --- | --- | --- |
| Aviator | Configured return factor **94.5%**; rounding and chosen cashout target affect finite results | 90.40–94.14% across 1.1x–20x targets; high targets have much wider sampling error |
| Chicken Road | **90.0%** under the current fixed-lane rules and supported stake increments | 88.43–91.57% across eight difficulty/lane profiles |
| American Roulette | **94.7368%** for standard red/black and straight bets, from 38 pockets | 88.02–101.16% across the tested profiles; the apparent values above 100% are finite-sample variation |
| Seven-Up-Down | **83.3333%** on Up, Down and Seven; tested exact-total bets are approximately **72.22–83.33%** | Main sides 82.65–84.63% |
| Andar Bahar | Andar **96.9988%**, Bahar **97.8511%**; card-count side bets approximately **91.48–98.10%** | Main sides 95.99% / 98.81%; rare count bets fluctuate more |
| Keno | Picks 1–9: approximately **69.72–69.94%**; ten picks: **97.0108%**, at the tested 100-chip stake | Picks 1–9 tested: 70.07–71.39%; ten picks 98.62% |
| Pappu Pictures | **92.3090%**, from twelve equally likely pictures, 35% extra-pay probability, five boosted pictures and the boost weights | 87.64–91.92% across eight pictures; rare boosts create high variance |
| Teen Patti | No certified theoretical return established in this audit | Player/dealer 69.38–70.36%; **Tie 1.11%**, with 37 tie wins in 20,000 rounds |
| Poker | No certified theoretical return established in this audit | Player/dealer 69.78–70.22%; **Tie 0% observed**, with no tie wins in 20,000 rounds. This does not mean its theoretical probability is zero |
| Blackjack | Strategy-dependent; no optimal-strategy theoretical RTP established | 81.56–94.10% for simple hit-below-12 through hit-below-19 policies without splits, doubling or insurance |
| Rummy | No fixed individual-player RTP. Current LIVE settlement code returns the funded stake pool to the winner, with no rake deducted in that settlement path | Not estimated; practice play has zero wallet stake/payout and cannot measure funded RTP |

### Statistical limits

The raw results include approximate 95% confidence intervals per profile. Those normal intervals are weak for rare payouts, especially zero observed ties; a zero-width normal interval for a zero-hit profile is **not** evidence of certainty. Several profiles shared the same generated round, so their bets are correlated and cannot be pooled as independent observations. Rare-event mathematics or substantially larger, independently reviewed samples are needed before publishing certified RTP claims. For Poker's zero observed ties, the one-sided 95% upper bound on the tie-event probability is about 0.015%; multiplying by the current 15x gross payout gives an upper return bound of about 0.225% under this sampling model.

## Bugs and decisions

### Fixed: Rummy ineligible-wallet request returned HTTP 500

**Trigger:** A player with restricted promotional chips attempted to join a LIVE Rummy table.

**Cause:** The source wallet correctly raised `RESTRICTED_BONUS_P2P_NOT_ALLOWED`, but the join route did not translate `FinancialError` into an HTTP response.

**Change:** The route now preserves the error's status, code and message after transaction rollback. The live request returns **HTTP 409** with the restricted-bonus explanation. The restriction remains enforced. No bonus balance was reclassified to force the paid-table test through.

**Validation:** The focused Rummy suite passed 47 tests, including the new regression, and the corrected response was reproduced on the live backend.

### High priority: review Tie-bet pricing

Teen Patti and Poker compare full ranked hands, making exact ties rare. Their current Tie payouts produced exceptionally low observed returns. This is a confirmed payout-design concern, not evidence of a broken random generator. The intended game specification and approved paytable need review before these bets are promoted. No payout multiplier was changed during QA.

### High priority: confirm the intended return profile

Keno's one-through-nine-pick returns are near 70%, while ten picks are near 97%. Teen Patti/Poker side bets also return near 70%. These differences are implemented in the tables and were not silently normalized. Confirm that the product intends these prices and that player-facing rules accurately describe them.

### Unverified: full funded Rummy gameplay

The QA grants are restricted bonuses, so the production wallet correctly prevents their use in peer-to-peer LIVE Rummy. The current allocation policy can also reject a mixed wallet while restricted bonus balance exists. This audit did not weaken that policy or create production cash credits. A dedicated isolated cash-wallet fixture is needed to test five-account matchmaking, complete declarations, disconnect recovery and final pooled settlement end to end. The existing isolated source-wallet tests cover cash-pool conservation.

## Development quality assessment

**Strengths observed:** Authoritative server-side game state, transactional stake/settlement paths, wallet-source reconciliation, replay protection in Chicken Road, account review controls, and useful engine/atomicity tests. All eleven services responded in the final probe, and sampled game balances reconciled.

**Remaining gaps:** The Rummy exception surfaced only in integration testing despite passing rule tests; full paid Rummy remains unverified; payout design needs review; and this run does not cover human usability, every CRM operation, long-running disconnects, a security penetration test, production payments, or maximum capacity. The free Instabox runtime pauses also remain an operational constraint.

For the final 88 local API probes: median **64.17 ms**, p95 **118.77 ms**, maximum **126.65 ms**. These figures exclude public DNS/TLS, internet latency, rendering and mobile hardware; they cannot establish a player-facing performance guarantee.

## Automated checks and evidence

- Initial focused engine/transaction suite: **147 tests passed**, plus **1,560 subtests**.
- Post-fix Rummy suite: **47 passed**; this overlaps the initial suite and is not an additional independent count.
- Source-wallet suite: **10 passed**, including restricted-bonus rejection and cross-player cash-pool source preservation.
- Retained bridge checks: **18 passed**, using mocks and no external service.
- Evidence: [RTP profiles and mathematical calculations](qa-2026-11-20/rtp-results.json), [final game-service/settlement checks](qa-2026-11-20/final-verification.json), [live Rummy fix verification](qa-2026-11-20/rummy-fix-verification.json), [QA cleanup and reconciliation](qa-2026-11-20/cleanup.json).

The raw initial harness logs also contain a wrong Chicken Road test URL and Blackjack stand requests sent before an insurance decision. Those harness issues were corrected; they are not counted as application defects. Rummy's live paid-join failure is retained in the evidence and superseded by the separate post-fix verification.

## Follow-up: isolated funded Rummy accounting now verified

After the original live bonus-funded audit, a dedicated real-Mongo test verified five cash-funded synthetic accounts, exact pooled payout, duplicate-action protection, waiting-table refunds, bonus/insufficient-balance rejection and rollback after a debit. All six scenario groups passed and the temporary database/credential were removed. This closes the isolated funded-accounting test gap; a complete public-browser valid-declaration hand remains unverified. See [funded-wallet follow-up](rummy-funded-wallet-verification-2026-11-20.md).
