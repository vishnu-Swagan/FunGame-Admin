# Rummy fixes and five-player test — final report

20 November 2026. The eligible-cash and bot-label fixes are deployed on Chakri.Casino. No commission rate, payment activation or wallet allocation rules were changed by these fixes.

## Changes delivered

- The Rummy lobby reads a server eligibility endpoint rather than treating the combined chip balance as spendable cash.
- Cash, restricted bonus and eligible Live chips are displayed separately. Bonus-only wallets cannot join paid Live tables; the existing mixed-wallet restriction is explained. Practice stays available.
- Missing/unreconciled source-wallet data disables Live entry instead of guessing eligibility. An uninitialized balance is displayed as bonus, matching the wallet initialization policy, without creating a wallet during the read.
- Automated seats show **BOT · AUTOMATED**, including a bot marker when dropped. Result standings also identify bot seats. The lobby explains that Practice opponents are automated bots.
- Public company-footer wording from the prior update is preserved.

## Five-player settlement result

Five synthetic participants each started with 1,000 chips and entered a 100-chip table in a disposable real MongoDB replica-set database.

| Item | Chips |
| --- | ---: |
| Five entry stakes | 500 |
| House commission, 15% | 75 |
| Winner payout, 85% | 425 |
| Winner final balance | 1,325 |
| Each of four other final balances | 900 |
| Final player balances + house fee | 5,000 |

Both the four-drops settlement path and a valid-declaration path completed. Declaration testing used a deliberately authored valid hand in the disposable database, then normal draw and discard-and-declare actions through the route functions. Card count moved 13 → 14 → 13, private-hand visibility was checked, and payout occurred once. The winner's net gain is 325 because the 425 payout includes the winner's own 100-chip entry.

Eleven isolated scenario groups passed, covering eligibility, missing fee acknowledgement, rollback, five-player settlement, frozen commission, cancellation/refund, restricted bonus and mixed-wallet rejection, insufficient funds, and valid declaration with duplicate-action replay. The temporary test database and its scoped credential were removed. Synthetic cash was confined to that database; no live cash balances were funded for this test.

**Aggregate player return for a completed funded table is 85% of the pot. This is not an 85% individual win probability.** House commission is gross chip revenue before costs.

## Verification and limits

- **60 focused frontend tests passed** across the game, lobby and commission suites, including eligible-cash gating and bot seat/result labels.
- The production frontend build succeeded and was installed with new hashed assets; the previous entry files were retained for rollback.
- The changed backend passed isolated transaction/eligibility checks before activation. API health after deployment reported gameplay and CRM ready; financial readiness remains disabled.
- The earlier public-browser practice draw/discard check passed. This follow-up does not claim a complete natural-deal five-human public-browser winning hand or independent fairness certification.
- Hosting runtime interruptions, unattended disconnect/restart recovery, mobile usability and sustained load remain separate verification work. They were not changed in this narrowly scoped fix.

[Detailed isolated results](qa-2026-11-20/rummy-eligibility-final-results.json)

## Requested team-account handoff

Follow-up completed: 50 users were created through the Admin CRM Create user form with randomly selected names and 2,000 starting promotional chips each. All 50 were verified ACTIVE, with unique login IDs and exactly one 2,000-chip credit each (100,000 chips total). Generated usernames and passwords were imported into a private native Google Sheet and verified as 50 complete rows. The sheet was delivered separately to the user; credentials are not stored in this repository. This account creation did not alter paid Rummy wallet eligibility or payment settings.
