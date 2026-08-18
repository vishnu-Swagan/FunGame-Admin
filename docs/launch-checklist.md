# Aviator production launch checklist

Scope: replace the active `/games/aviator/play` experience with the localhost reference source and its Unity/audio assets, without changing the `aviator` catalogue slug, player access rules, admin enable/disable control, or wallet ledger.

## Release gates

- [x] The production route still resolves `aviator` through `AviatorCabinet` and the authenticated active-player guard, then mounts the isolated reference micro-app full-screen.
- [x] Bets, cancellations, manual cashout, automatic cashout, balance, and personal history continue to use the server-authoritative APIs.
- [x] Both copied reference panels open on Auto mode with a 2.00x target; Auto Play requires an explicit Start action and supports Stop.
- [x] Auto Play submits at most one bet per panel per server round and stops when its selected round count is exhausted or the server rejects a bet.
- [x] The original Unity WebGL aircraft is used when loaded, with one DOM fallback only when Unity is unavailable; the duplicate crash flyout was removed.
- [x] The live multiplier, flight seconds, round number, exact previous-round pills, All Bets, My Bets, Top, date, and balance are server-synchronized.
- [x] The probability setting exists only as a private backend environment variable and is absent from the player bundle and UI.
- [x] The reference React 18 micro-app and parent React 19 production frontend both compile successfully.
- [x] Backend Aviator engine tests, public catalogue/security tests, and the direct operational suites pass.
- [ ] Render backend deployment is healthy and `/api/health` returns success.
- [ ] Render static-site deployment is live and the production Aviator route loads the new build.
- [ ] Production smoke test confirms one aircraft during `FLEW AWAY`, exact crash pill/history value, two Auto panels, and live balance updates.

## Rollback

Before this parity release, production is on commit `6f86d26`. If a release gate fails, redeploy that commit from Render while preserving the database and environment variables.
