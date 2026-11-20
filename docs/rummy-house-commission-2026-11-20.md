# Rummy house commission — 15% live

20 November 2026. The user selected 15%, replacing the earlier 10% request before activation.

**All five LIVE Rummy categories now use 15% house commission for newly created rooms. The winner receives the remaining 85% of the gross funded pot, including the winner's original stake.** Existing room snapshots were verified unchanged. This is a table-pot fee, not a deposit charge or a change to the winner-selection rules.

| Example | Chips |
| --- | ---: |
| Five participants × 20,000 entry | 100,000 gross pot |
| House commission, 15% | 15,000 |
| Winner's gross payout | 85,000 |

The commission is recorded as chip-ledger revenue, not a calculation of net business profit. Payment/deposit activation was not changed; the installation still reports financial readiness disabled.

## Player and CRM behaviour

The lobby displays the full pot, house rate/amount and expected winner payout. Paid entry requires confirmation of those terms, including a readable confirmation dialog; cancelling does not submit the join. The request carries the acknowledged rate. If a cached client omits the rate or the category terms changed, the server rejects the request before reserving chips and tells the player to refresh and review the fee.

The room freezes its commission with the entry and game rules at creation. New joins cannot mix different commission snapshots in the same waiting room. Existing rooms retain their previous terms, including zero-fee rooms. Practice and automated fallback tables remain wallet-neutral, with no house commission. Waiting-room cancellation restores the full reserved stake with no fee.

The table and result receipt disclose the commission and net winner payout. The Admin CRM **Game catalog** now shows the configured rates and recorded house commission, gross pots, player payouts and settled-round count.

Fractional fee chips round down to whole chips, with the remainder staying in the winner's payout. The current five configured entry tiers produce exact whole-chip 15% fees.

## Accounting controls

Commission and winner payout are written in the same MongoDB transaction. A unique round identifier permits one commission record per settlement. The source-wallet adapter validates the room's frozen rate, the reserved fee record, winner, certified cash stake sources and exact net payout before consuming those sources. A smaller payout without matching fee evidence is rejected; a full-pot payout cannot bypass a positive frozen fee. Existing restricted-bonus rules remain enforced.

No new production cash was created for verification. The zero-balance rollout account was disabled after the public checks.

## Validation

- **55 backend Rummy/rate tests passed**, including invalid-rate rejection, integer rounding and unchanged legacy snapshots.
- **11 wallet-source tests passed**, including missing/tampered commission proof, attempts to bypass the fee and duplicate monetary outcomes.
- **61 frontend tests passed** across four suites, including displayed fee arithmetic, confirmation cancellation and approved joining. Production build passed.
- **Nine isolated real-Mongo transaction scenario groups passed at 15%**. Five synthetic cash-funded participants entered at 100 each: the winner received 425, house commission was posted once at 75, and player balances plus house fee conserved the initial 5,000 chips. Injecting a failure after the payout rolled back the fee, wallet movement and ledger writes together. Category edits did not change the frozen round rate.
- **Six zero-fee regression scenario groups passed**, preserving previous settlement behaviour.
- Public API confirmed all five categories at 1,500 basis points. Missing acknowledgement and insufficient balance were rejected before any stake persisted. Existing room snapshots were unchanged. Runtime source hashes matched the tested code.
- Public game HTML and the deployed client bundle were checked against the new build. A complete public-browser funded declaration hand and independent gaming certification remain outside this verification.

Evidence: [15% transaction results](qa-2026-11-20/rummy-15pct-isolated-results.json), [zero-fee regression](qa-2026-11-20/rummy-zero-fee-regression-results.json), [live activation checks](qa-2026-11-20/rummy-commission-rollout.json).
