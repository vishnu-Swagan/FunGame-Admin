# Instabox gameplay verification — 20 November 2026

This follow-up tested the ten available games other than Aviator using explicitly labelled operator-provisioned QA accounts and synthetic chips. No cash deposit, withdrawal, external provider call or real-money payment was made. Payment and withdrawal runtime gates remain disabled.

## Findings and correction

Direct CRM provisioning omitted the source-wallet participation metadata already attached by ordinary registration and approval. Chicken Road correctly rejected those unclassified accounts with CHICKEN_ROAD_WALLET_RECONCILIATION_REQUIRED. New operator-created accounts now receive the same wallet-policy metadata. The reconciliation check remains in place for existing unclassified balances; no legacy balance was reclassified by this code change. A focused identity/provisioning regression check passed and a newly provisioned player opened Chicken Road successfully after deployment.

## Live checks

| Game | Test performed | Result |
| --- | --- | --- |
| Seven-Up-Down | Browser selection, synthetic stake, completed round and settlement receipt | Passed |
| Andar Bahar | Canvas/controls and game API loaded; synthetic stake and settlement receipt | Passed |
| American Roulette | Table/controls and API loaded; synthetic stake and settlement receipt | Passed |
| Keno | Number controls and API loaded; synthetic number selection and settlement receipt | Passed |
| Pappu Pictures | Symbol controls and API loaded; synthetic symbol stake and settlement receipt | Passed |
| Teen Patti | Table and API loaded; synthetic Player stake and settlement receipt | Passed |
| Poker | Table and API loaded; synthetic Player stake and settlement receipt | Passed |
| Blackjack | Table and API loaded; deal/stand sequence through completed hand | Passed |
| Chicken Road | New classified account, seed commitment, stake, terminal crash result; duplicate operation returned the existing receipt | Passed |
| Rummy | Practice table, five seats, browser draw/discard actions and advance to next player; no wallet entry fee | Passed in practice mode |

All ten browser checks observed a successful response from the specific game API and no failed HTTP resources during those observations. Timed-table bets all reached SETTLED. The source wallet and mirrored player balance reconciled after the test stakes and payouts. Rummy's paid five-human matchmaking and a full multiplayer hand were not tested by this smoke run.

## Automated checks

- 213 backend engine, timing, transaction, atomicity and Chicken Road route tests passed.
- 394 frontend play-screen, cabinet, audio and interaction tests passed across 23 suites.
- Focused authentication/provisioning regression script passed after the wallet-policy fix.

These are functional smoke and regression checks; they do not establish concurrent-player capacity or continuous free-plan availability. QA records are labelled and retained for traceability.
