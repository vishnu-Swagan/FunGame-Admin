# Premium games baseline audit

## Rummy implementation slice — 2026-08-21

- Repository branch at audit: `release/staging-20260820-1931-5c07822`; starting commit observed: `d0715af`.
- Runtime observed: Node `v26.7.0`, npm `11.19.0`, Python `3.11.15`.
- The shared worktree already contained unrelated concurrent changes; no reset, cleanup, or broad formatting was performed.
- Existing architecture reused: React/CRACO frontend, FastAPI routes, Mongo/Motor persistence, existing auth dependency, chip ledger, fail-closed transaction runner, game registry, catalog, and sound utility.
- Rummy is registered through the existing `seed.GAMES` catalogue and `PLAYABLE_GAME_SLUGS`; it does not create a parallel lobby.
- Transport is repository-consistent HTTP action acknowledgement plus authoritative state polling. Each mutation carries room, round, action ID, expected version, action type/payload, and client timestamp.
- Private hands are stored separately from room public state. Only the requesting player's hand is projected; other seats expose card counts and backs.
- The source reference archive was validated as exactly 11 PNG files, each 2392×1080 with exact expected SHA-256 values. Preserved files are evidence only.
- Runtime artwork is the original `frontend/public/game-art/rummy.png` (1254×1254; SHA-256 `2682116399f3b1af0e59b5e30ff95680a206d12d71d13bcce12f932136ce19b5`).

The broader nine-game visual/cache audit from the master programme is outside this Rummy-only slice and must be added before the coordinated release is declared complete.
