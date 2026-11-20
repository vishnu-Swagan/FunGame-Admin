# Rummy player and developer review

20 November 2026. This review covers the current 15% commission implementation. It combines public-browser practice actions, source inspection and synthetic funded transactions in a disposable MongoDB database. It is not an independent fairness certification or a completed real-money browser hand.

## Payout and RTP

Five synthetic players each started with 1,000 chips and entered a 100-chip table.

| Item | Chips |
| --- | ---: |
| Gross stakes: five × 100 | 500 |
| House commission: 15% | 75 |
| Winner's total payout: 85% | 425 |
| Winner's final wallet | 1,325 |
| Each other player's final wallet | 900 |
| Final player wallets together | 4,925 |
| Final player wallets plus house commission | 5,000 |

The winner's **net gain is 325**, because the 425 payout includes recovery of the winner's own 100-chip stake. Each of the other four players loses the entry stake. House commission is gross chip revenue before operating costs, taxes, payment fees or promotions; it is not net business profit.

For completed, fully funded human LIVE tables under these terms, aggregate player return is **85% of the gross pot**. That is not an 85% chance of winning and does not control which player wins. Skill and dealt cards determine results. Cancelled tables refund fully; practice is wallet-neutral. Existing tables retain their frozen terms.

| Current level | Entry each | Five-player pot | House 15% | Winner 85% |
| --- | ---: | ---: | ---: | ---: |
| LV1 | 100 | 500 | 75 | 425 |
| LV2 | 500 | 2,500 | 375 | 2,125 |
| LV3 | 1,000 | 5,000 | 750 | 4,250 |
| LV4 | 2,500 | 12,500 | 1,875 | 10,625 |
| LV5 | 5,000 | 25,000 | 3,750 | 21,250 |

## What actually passed

- Public-browser practice: opened a table, drew from the closed deck (13 → 14 cards) and discarded (14 → 13). The test account retained its 1,000 synthetic bonus chips. It was suspended afterward and the prior browser authentication state was restored.
- Public lobby: all five levels showed the 15% fee and correct gross/net amounts. Cancelling the confirmation kept the lobby open. A complete public-browser funded winning hand was not performed.
- Disposable real-Mongo test: five synthetic cash-funded participants joined; normal draw, discard-and-declare and actual declaration validation produced a winner. A deliberately authored valid hand was used to reach this branch reliably; this does not test random-deal fairness.
- Settlement posted one 75-chip house fee and one 425-chip winner payout. Repeating the action did not pay twice. Other players could not see the winner's hand before the result.
- Ten isolated scenario groups passed, covering declaration, drops, duplicate actions, rate freezing, cancellation/refund, underfunded and restricted-bonus rejection, and transaction rollback. The disposable database and its scoped test user were removed.

## Engineering assessment and missing work

The accounting checks are promising: commission and payout are transactional, the frozen rate is acknowledged before entry, and replay/rollback checks conserve chips. This evidence supports the tested paths; it does not establish that every real-money failure case or every device is covered.

1. **High priority — eligible balance display.** The browser showed “Live entry available” for a restricted-bonus-only QA wallet. The backend correctly blocks those funds from paid peer-to-peer play, but the lobby should show eligible cash separately and explain the restriction before joining. Mixed cash/bonus wallet policy also needs clear wording.
2. **High priority — unattended recovery.** A background-safe matchmaking sweep exists, but no caller was found in the checked backend source. Request-driven advancement is present. Test an explicit scheduled worker, all-player disconnects, restart recovery and overdue-table refunds before claiming unattended reliability.
3. **Medium priority — opponent labels.** Practice opponents were labelled “PLAYING”; clearly mark automated seats as bots/AUTO. This review did not establish paid automated-table outcomes.
4. **Medium priority — game-type wording.** The financial settlement is a fixed-entry pooled pot. “Point value” and “skill categories” can imply a different charging or matchmaking model. Align rules and labels with the implemented settlement; do not imply skill-based matching unless it is actually enforced.
5. **Further verification.** Complete a natural public-browser five-human declaration hand with synthetic eligible cash in a staging environment, plus disconnect/resume, invalid declarations, mobile touch layouts, accessibility and sustained concurrency tests. Independently review shuffle/fairness and anti-collusion controls before making certification claims.
6. **Operations.** Free Instabox maximum-runtime pauses remain a service interruption risk. The ten-minute activity check does not override them. Backups need ongoing off-host retention and timed recovery exercises. Payments remain disabled; these tests did not activate deposits or withdrawals.

No additional odds or commission changes were made during this review. The identified UX and recovery items are findings, not completed fixes.

## Company footer update

Both the public marketing site and game frontend were published with:

> Chakri.Casino is designed and developed by SKY-AMC LIMITED, incorporated in Hong Kong with limited liability.

The public footer company-details block and registration-number disclosures were removed from the edited company/legal views. Browser checks of the homepage, company, terms and privacy responses found no prior registration number. The game footer rendered the requested Hong Kong line, and the public client bundle hash matched the tested build. Six footer/legal frontend tests and 24 marketing-site checks passed. Previously downloaded or cached versions are outside this change.

## Evidence

- [Isolated declaration and transaction results](qa-2026-11-20/rummy-player-declaration-review.json)
- [Public-browser draw/discard and authentication cleanup](qa-2026-11-20/rummy-player-browser-review.json)
- [Commission implementation and prior regression coverage](rummy-house-commission-2026-11-20.md)
