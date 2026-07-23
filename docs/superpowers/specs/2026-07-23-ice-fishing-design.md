# Ice Fishing — Design Spec

**Goal:** Add "Ice Fishing", a 53-segment money-wheel game show with three cinematic fish-bonus games, to FunGame as a universal synced live round at ~70% RTP.

**Based on:** Evolution Gaming's Ice Fishing, adapted to FunGame's automated, play-chip, universal-round model (no live presenter).

## Decisions (locked)
- **RTP:** ~70% (matches all FunGame games / ~30% house edge).
- **Bonus reveal:** full cinematic reel-in-the-fish.
- **Bonus bet structure:** real-game — `All Bonuses` is the ~70% value bet; individual bonus spots are high-variance lottery bets (~40–55% RTP, bigger dream).

## Round model (fixed synced cycle)
One universal round, secure server RNG, everyone sees the same wheel + fish. Fixed phase durations (consistent with the existing live-round engine — no variable-length-round rework):

`BETTING 14s → MULTIPLIERS 4s → SPIN 8s → RESULT/BONUS 10s` (~36s total).

The RESULT/BONUS slot is always reserved. When the spin lands on a bonus segment, the cinematic reel-in plays in that window; otherwise it shows the leaf payout + winners + history.

## The wheel — 53 segments
Example distribution (exact counts Monte-Carlo-tuned to the per-spot RTP targets):
- **Leaf 1 ×18**, **Leaf 2 ×18** — pay 1:1
- **Frost blanks ×6** — house segments (leaf bets lose; the house-edge lever)
- **Lil' Blues ×6**, **Big Oranges ×3**, **Huge Reds ×2** — bonus triggers (~21% of spins)

## Bet spots (multi-bet, roulette-style)
Players stake chips on any combination of spots in a round.

| Spot | Wins on | Pays | Target RTP |
|---|---|---|---|
| Leaf 1 / Leaf 2 | that leaf color | 1:1 (× mult if boosted) | ~70% |
| Lil' Blues | a Blues segment | fish 3–100× | ~50% |
| Big Oranges | an Oranges segment | fish 4–200× | ~45% |
| Huge Reds | a Reds segment | fish 10–500× | ~40% |
| All Bonuses | any bonus segment | that fish's mult | ~70% |

## Multipliers (assigned after betting closes)
- One random **leaf** segment → **3/4/5/7/10×** (boosts that leaf's 1:1 payout when it wins).
- A **bonus type's** segments may get **2–10×** → multiplies every fish in that bonus. This is the path to the **5000× max** (Huge Reds 500× fish × 10× boost).

## Bonus games (cinematic)
Automated arctic ice-hole scene. The line goes taut; the fish rises head → body → tail with escalating tension; the multiplier is hidden until the fish clears the water → coin burst + fanfare + win count-up. Multiplier ranges per tier (Blues/Oranges/Reds). Only bettors on the triggered spot are paid (stake × fish mult × boost); everyone else watches.

## Architecture
### Backend
- `generate_ice_fishing()` in the live engine → the synced round outcome: winning segment (type + index), assigned leaf/bonus multipliers, and (if bonus) the fish multiplier — all from the round-seeded secure RNG, stored once per round.
- **Multi-bet layer:** unlike the single-selection live games, Ice Fishing accepts multiple bets per round. Model it on the existing **roulette** multi-bet code (bets collection per user per round, per-spot chip totals, undo/clear/rebet), but driven by the **universal live-round clock** (not roulette's own clock).
- Settle: for each of the player's bets, evaluate against the universal outcome; leaf bets pay `stake × 1 × leafMult`, bonus bets pay `stake × fishMult × bonusBoost`, `All Bonuses` pays the triggered fish's mult.

### Frontend
- `IceFishingGame.js`: 53-segment SVG wheel + flapper (spin synced to the round like RouletteGame/WheelGame), a 6-spot bet dock with the chip tray, the multiplier-drop animation, and the cinematic bonus scene.
- Cover art `public/game-art/ice-fishing.png` from the supplied logo/thumbnail.

### Registration
Add `ice-fishing` to the games catalog, `LIVE_GAMES`, the frontend component map, and metadata (name "Ice Fishing", category **Wheel**, featured, tagline).

## RTP & testing
- Monte-Carlo harness tunes segment counts + each tier's fish-multiplier distribution to the per-spot RTP targets; verifies the 5000× cap and overall ~70%.
- Settle-logic checks; standard `CI=true` build + deploy (backend + frontend hooks).

## Out of scope
- Live presenter / video (FunGame is automated graphics).
- Variable-length rounds (fixed cycle reserves bonus time).
- Currency / real money (play chips only).
