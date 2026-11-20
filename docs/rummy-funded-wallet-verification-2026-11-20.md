# Rummy funded-wallet follow-up

20 November 2026. All six scenario groups passed using the installed backend code, real MongoDB replica-set transactions, and a disposable database. A temporary database credential was restricted to that test database. No production wallet balance or live payment configuration was changed. Test funds were synthetic.

| Scenario | Verified result |
| --- | --- |
| Five cash-funded accounts, 100-chip entry each; four players drop | One 500-chip pot payout. Winner ended with 1,400 chips; each other player with 900. Total remained 5,000. |
| Retry the identical final action | Returned the original receipt; payout count remained one. |
| Leave a waiting table, then repeat the same leave | Exactly one refund; original 1,000-chip cash balance restored. |
| Bonus-only and mixed cash/bonus fixtures | Both remained blocked by the existing restricted-bonus policy. No seats, ledger movements or balance changes persisted. |
| Insufficient balance | Returned the existing low-balance error without partial writes. |
| Inject a failure after a real wallet debit | The MongoDB transaction rolled back: cash restored, no orphan ledger rows and no orphan seat. |

The fixtures supplied separate cash and bonus balances. No bonus policy was loosened, no synthetic bonus was converted into production cash, and no live deposit/withdrawal was used. The scheduled-start clock was advanced only inside the test process while normal player heartbeats were exercised. The temporary credential and database were removed after the run.

This verifies the funded accounting/settlement branch with five automated accounts. It does not certify a complete public-browser valid-declaration hand, external payment processing, production authentication, human usability, broad disconnect recovery, or large-scale capacity. Individual Rummy player RTP remains skill-dependent; this test proves pot conservation, not a player win-rate estimate.

[Machine-readable results](qa-2026-11-20/rummy-isolated-wallet-results.json)
