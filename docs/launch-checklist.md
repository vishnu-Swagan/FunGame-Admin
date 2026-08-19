# Keno and American Roulette production launch checklist

Product: Chakri.Casino live Keno cabinet and synchronized American Roulette table

Stack: React 19 + CRACO static frontend, FastAPI backend, MongoDB ledger, Render Blueprint deployment

Release path: push `main` to GitHub; Render auto-deploys `chakri-casino-api` and `chakri-casino`

Estimated release time: 15–25 minutes, including Render build time

New monthly cost: ₹0 on the existing Render services

Legend: 🤖 Codex can execute and verify the step; 👤 operator action is required only when Render or DNS credentials are unavailable.

## 1. Gameplay and visual parity

- [x] 🤖 **Build the reference-matched 36-ball cabinet** — 6 minutes. Use the Higgsfield-derived reference for structure, depth, burgundy palette, metallic balls, orange result rail, and 3D controls while keeping the interface responsive. **You’ll know it worked when:** desktop and mobile both show all 36 balls, the payout rail, RANDOM/CLEAR, Bet INR, Auto, and BET without clipping.
- [x] 🤖 **Keep the game server-authoritative** — 3 minutes. Route `/games/keno/play` through `KenoCabinet` and use `/api/live/keno/*` for synchronized round state, bets, outcomes, settlement, history, and balance. **You’ll know it worked when:** multiple players receive the same ordered 10-number draw and balances come from the ledger.
- [x] 🤖 **Show every result precisely** — 2 minutes. Render `HITS • WIN ₹amount` after every round, including a zero win, and highlight drawn numbers and winning hits separately. **You’ll know it worked when:** the result rail always contains a two-decimal INR amount.
- [x] 🤖 **Enable sound and Auto Play** — 3 minutes. Provide a clear sound toggle, reveal/hit/result effects, round-count selection, stop-loss, stop-win, and a visible Auto counter. **You’ll know it worked when:** Auto submits no more than one bet per server round and can be stopped immediately.
- [x] 🤖 **Give American Roulette a cinematic 3D table** — 5 minutes. Translate the Higgsfield art direction into live code: a polished walnut 38-pocket wheel, emerald baize, warm brass rules, equal-width 0/00 American betting geometry, and tactile denomination chips. **You’ll know it worked when:** the wide table shows the wheel and all 38 betting pockets together and a chip placed on a number lands on that exact number.
- [x] 🤖 **Keep a local Roulette demonstration route** — 2 minutes. Run the same production table engine at `/__preview/american-roulette` with a deterministic development-only round clock and INR-style chip balance. **You’ll know it worked when:** a developer can place, undo, clear, and watch a complete spin without signing into the production account system.

## 2. Data and safety gates

- [x] 🤖 **Keep draws uniform and auditable** — 1 minute. Draw 10 unique values from 1–36 with the server cryptographic random generator; do not alter outcomes based on player picks. **You’ll know it worked when:** engine tests confirm range, uniqueness, full history, selection validation, and settlement.
- [x] 🤖 **Preserve production data** — 1 minute. Leave `DB_NAME`, MongoDB credentials, users, balances, previous rounds, and all other game slugs untouched. Migrate only outdated Keno catalogue copy from 80 balls to 36. **You’ll know it worked when:** startup updates the legacy Keno description without creating or deleting game records.
- [x] 🤖 **Add a deployment fingerprint** — 1 minute. Expose only `keno_pool: 36` and `keno_draw: 10` on the public API root; do not publish the private price profile. **You’ll know it worked when:** `GET /api/` returns both values after deployment.

## 3. Verification and release

- [x] 🤖 **Run backend regression tests** — 2 minutes. Execute `python -m pytest -q test_keno_engine.py test_seven_up_down_engine.py test_aviator_engine.py`. **You’ll know it worked when:** all selected engine suites pass.
- [x] 🤖 **Build the production frontend** — 3 minutes. Execute the CRACO production build with source maps disabled. **You’ll know it worked when:** compilation finishes successfully and emits the Keno and Roulette CSS/JavaScript bundle.
- [x] 🤖 **Push the reviewed release** — 1 minute. Commit only the Keno/Roulette runtime and this checklist, then push `main`. **You’ll know it worked when:** GitHub `main` points to the release commit.
- [ ] 🤖 **Verify Render backend** — 5–10 minutes. Poll `https://chakri-casino-api.onrender.com/api/health` and `/api/` after auto-deploy. **You’ll know it worked when:** health returns `status: ok` and the build fingerprint reports a 36-ball, 10-draw Keno build.
- [ ] 🤖 **Verify Render frontend** — 5–10 minutes. Confirm the production asset manifest references the new bundle, open `/games/keno/play`, and open `/games/fun-roulette/play` through an active player session. **You’ll know it worked when:** Keno shows the full-height 1–10 payout rail and American Roulette shows the cinematic emerald table instead of the narrow legacy cabinet.

## Rollback

If a gate fails, redeploy the previous production commit from Render. Do not roll back or rename the MongoDB database. The release changes no stored bet schema, so rolling back application code does not require a data migration.
