# Aviator production launch checklist

Scope: replace the active `/games/aviator/play` experience without changing the `aviator` catalogue slug, player access rules, admin enable/disable control, or wallet ledger.

## Release gates

- [x] The production route still resolves `aviator` through `AviatorCabinet` and the authenticated active-player guard.
- [x] Bets, cancellations, manual cashout, automatic cashout, balance, and personal history continue to use the server-authoritative APIs.
- [x] Both panels open on Auto mode with 2.00x auto cashout selected; Auto Play requires an explicit Start action and supports Stop.
- [x] Auto Play submits at most one bet per panel per server round and stops when its selected round count is exhausted or the server rejects a bet.
- [x] The aircraft is represented by one DOM node per round; the same node performs the fast fly-away transition.
- [x] The live multiplier, flight seconds, round number, exact previous-round pills, All Bets, My Bets, Top, date, and balance are server-synchronized.
- [x] The probability setting exists only as a private backend environment variable and is absent from the player bundle and UI.
- [x] Frontend production build compiles successfully without ESLint warnings.
- [x] Backend Aviator engine tests, public catalogue test, and all-games enablement test pass.
- [ ] Render backend deployment is healthy and `/api/health` returns success.
- [ ] Render static-site deployment is live and the production Aviator route loads the new build.
- [ ] Production smoke test confirms one aircraft during `FLEW AWAY`, exact crash pill/history value, two Auto panels, and live balance updates.

## Rollback

Before launch, production is on commit `9fb9984f3d5f9f72bd4da0e34148503222d00620`. If a release gate fails, redeploy that commit from Render while preserving the database and environment variables.
