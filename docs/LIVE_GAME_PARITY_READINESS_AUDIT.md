# Live-game parity readiness audit

**Last updated:** 2026-08-15
**Scope:** recovered client documentation, locally recovered source, the exact
15-title Unity/API identity contract, and the fail-closed server-resolver
review modules.
**Out of scope:** runtime promotion or any claim of production parity without
the per-title evidence package and release gate below.

## Decision

**None of the 15 cabinets is ready to enable.** The evidence is useful for
building game-specific server resolvers, but it does not yet establish an
end-to-end, server-authoritative result and virtual-points settlement path for
any cabinet. Keep every `game_runtime_catalog` row `DISABLED` and not
`QA_VERIFIED`.

The current API integration is intentionally fail-closed. Two former
cross-cabinet transport gaps are closed: Unity now has one immutable
catalog/lobby/scene/engine identity map for all 15 titles, and the state wire
sends a fixed reveal duration separately from the absolute phase deadline.
The remaining release gaps are material:

1. All 15 review modules are present, but all 15 remain `BLOCKED`; none has
   both an authoritative outcome generator and complete settlement function.
2. No production-approved Edge resolver currently settles completed wagers
   through `resolve_game_wager`; a title must not accept stakes until its full
   stake-to-ledger lifecycle is executable and replay-tested.
3. Player-paced cabinets still need their client-backed deal/hold/draw,
   collect/double-up, reconnect, and replay state machines.
4. The event stream is private to a player/session. It is not evidence of a
   public table-round/history feed or other multiplayer presentation.

Evidence and the exact remediation requirements are documented in
[`game-api-unity-integration-review.md`](game-api-unity-integration-review.md),
especially its sections “Blocking mismatch 1–3” and “Multiplayer/result
visibility gap.”

## Reading the matrix

- **Observed/proved** means recovered source, measured recording, or both.
- **Inferred** is not sufficient to price a live result.
- **No shared proof** does not mean a title is definitely single-player; it
  means the recovered material does not establish the reference client's
  cross-player state contract.
- **Readiness is always NO** until action, timing, result/reveal, settlement,
  idempotent ledger behavior, reconnect behavior, and permitted shared state
  are tested together against the client.

| Cabinet (catalog slug) | Action + timing evidence | Result/reveal evidence | Settlement / ledger readiness | Multiplayer synchronization evidence | Readiness and decisive gap |
| --- | --- | --- | --- | --- | --- |
| 7Up7Down (`7up7down`) | Two main bets, cancel and Take are evidenced. Bet 15 / lock 1 / reveal 15 is documented from live capture; the document itself contains conflicting result-duration notes (10 vs 11), so that last phase must be reconciled. | One final-card result and a server global 15-second window clock are observed. | Directional 2.0x total return is observed; the 28-row poker chart is recovered but its feature/fever trigger is not. Do not price it as ordinary settlement. | **Partial:** global clock is explicit; no documented public round/history payload. | **NO** — chart trigger, final phase, per-round result contract, and server ledger resolver missing. |
| Fun AB (`fun-ab`) | Side/rank board and Take/Bet flow are recovered. `Bet 36 / Lock 6 / Reveal 2 / Result 5` is measured. | Joker/side-card/last-five reveal mapping is well documented. | Nine side-bet prices remain placeholders; no client-backed payout/credit reconciliation for all selections. | **No shared proof.** | **NO** — settlement table and client result payload must be captured. |
| Triple Fun (`triple-fun`) | Single/double/triple selections, ten hundreds tabs, and per-selection caps are proved. Current client UI coverage is only one hundred-triple tab. Round length is explicitly unresolved. | Three drawn digits and last-five interpretation are evidenced. | 9/90/900 constants are recovered, but “total return vs profit” remains inferred; the local client engine differs from the old live Python service. | **No shared proof.** | **NO** — timing, return semantics, full 1,000-selection UI/contract, and independent server settlement suite required. |
| Fun Roulette (`fun-roulette`) | Full American line-bet shape is recovered; clock capture documents 60s / bet 45 / lock 11 / reveal 11 / result 4. | Wheel/board construction is measured, but zero-end felt geometry conflicts with the existing whitelist. | Source keeps `WheelTime` and payout functions server-driven/virtualised; no complete client payout ladder/settlement capture is available. | **No shared proof** beyond a shared-style clock. | **NO** — resolve zero-end mapping, exact server payout protocol, Take settlement, and scheduled/idempotent resolver first. |
| Fun Target (`fun-target`) | Digit-pick board is evidenced; `51/5/3` timing exists as a hand-maintained fixture value, not a fully pinned protocol capture. | Digit-wheel presentation is known; no authoritative result-message schema is recovered. | 9x is explicitly an inference: client source has no table/constant proving it. | **No shared proof.** | **NO** — capture paid win/loss and source/payload meaning before implementing any prize path. |
| Bingo (`bingo`) | Big/Small exists but whether it is a main bet or double-up control is not settled. Shared `60/6/4` is explicitly a default, not measured. | Six-slot ball cascade is proved at 0.4s steps; draw count/order remains unknown. | Paytable values are unobserved; Big/Small/D-up behavior is unresolved. | **No shared proof.** | **NO** — capture a full timed, paid round and gamble flow; derive line/draw settlement before ledger work. |
| Joker Bonus (`joker-bonus`) | The recovered screen is press-paced five-card Joker poker with Deal/Take/Big/Small/D-up controls. | Card presentation/paytable artwork is documented. | Current local behavior is a five-reel fruit-slot path and refuses Deal/Gamble: it is explicitly the wrong brain. Double-up is unobserved. | **No shared proof;** player-paced behavior itself needs confirmation. | **NO** — replace engine with client-backed joker-poker state machine, then capture Hold/D-up/Take ledger behavior. |
| Giant Jackpot (`giant-jackpot`) | Controls and cadence are asks, not established; current 60/5/3 is a local assumption. | Client art appears to show four single-row windows while the current engine resolves a 5x3 grid. | Reel symbols, weights, lines, cap row, paytable and even the visible game shape are unresolved. | **No shared proof.** | **NO** — one full recorded spin and paid result are minimum evidence before any result generator. |
| Golden Wheel (`golden-wheel`) | Eight stake columns, two rings, twelve payment types, and per-round `Bhav` are recovered. | Reference client is a two-number pair lottery; independent ring behavior still needs a spin capture. | Current local engine is a single weighted multiplier wheel that ignores selection — explicitly a different game. Pair-to-payment table and `Bhav` are stripped/server-fed. | **No shared proof;** `Bhav` being server-fed is not a shared-feed specification. | **NO** — recover pair table/payouts and replace the engine; do not reuse weighted-wheel outcomes. |
| Keno (`keno`) | 80-number board, maximum ten selections and timing/reveal presentation are partially evidenced. | Animation evidence supports a 20-ball/six-second shape, but the actual draw/result protocol and full board coverage need verification. | Client paytable is explicitly unobserved; current payout cannot be used. | **No shared proof.** | **NO** — capture draw count/order, paytable and Take settlement; server must settle exact selection overlap rules. |
| Checker (`checker`) | 25 cells are main bets; ODD/EVEN are double-up controls, not main bets. Current `60/4/3` timing is unmeasured. | Thirteen client rounds establish outer/inner 1..5 result plus a round multiplier; ring landing angles remain unmeasured. | Normal 25-cell settlement has evidence, including two double-paying anomalies; Double-up, half-Take, and anomaly trigger remain unresolved. | **No shared proof.** | **NO** — pin anomalies, exact timing/reveal, Take/D-up contract, and replayable settlement before enabling. |
| Lucky 8 Line (`lucky-8-line`) | 3x3 grid, eight lines, chart action, and card double-up are recovered; max 8000 is ambiguous (per-line vs total). | Reel ordering/stop presentation is documented. | Symbol payouts come only from capture; source payout lists are stripped. Big/Small card flow is not fully settled. | **No shared proof.** | **NO** — resolve cap semantics, payout table, D-up, Take and exact clock/result protocol. |
| Fever Joker Bonus (`fever-joker-bonus`) | UI requires press-paced Deal, Hold/Release, Gamble and Take. | Card layout/paytable presentation is well measured. | Current engine is explicitly a fruit-slot `Grid` path that cannot populate the card cabinet and refuses the required verbs. | **No shared proof;** player-paced lifecycle must be captured. | **NO** — build the Joker-poker resolver and capture deal/hold/draw/D-up/Take outcomes. |
| No Hold (`no-hold`) | Documentation records a later press-paced/no-draw local-engine pass, but the client interaction and D-up behavior still require capture. | Eleven-row five-joker presentation and idle readouts have strong visual/source evidence. | The record distinguishes display parity from complete real-client payout/bonus/D-up evidence; win placement and accumulators remain unobserved. | **No shared proof.** | **NO** — verify live-client deal/settle/Take/reconnect and bonus/D-up contract against the recovered local implementation. |
| Champion Poker (`champion-poker`) | Five-card Deal/Hold/Take/D-up control structure and eleven-row table are recovered. Deal cadence and Bet stepping are not fully pinned. | Double-up screen structure is recovered; fever feature is visible in source but arithmetic is unobserved. | Big/Small rule, tie behavior, multiplier/bonus rules, and exact Take credit progression are server-driven/unobserved. | **No shared proof;** expected player-paced state has no formal session replay contract. | **NO** — derive/capture D-up and fever rules, then validate a full idempotent poker lifecycle. |

## Evidence index

The matrix deliberately cites the recovered evidence rather than treating the
current local Unity engine as the reference:

- **7Up7Down:**
  [`/Users/vishnu/chakri-unity/docs/prep/7up7down-observation.md:69`](/Users/vishnu/chakri-unity/docs/prep/7up7down-observation.md:69),
  [`:75`](/Users/vishnu/chakri-unity/docs/prep/7up7down-observation.md:75),
  [`:276`](/Users/vishnu/chakri-unity/docs/prep/7up7down-observation.md:276),
  [`:304`](/Users/vishnu/chakri-unity/docs/prep/7up7down-observation.md:304).
- **Fun AB:**
  [`/Users/vishnu/chakri-unity/docs/prep/fun-ab-observation.md:180`](/Users/vishnu/chakri-unity/docs/prep/fun-ab-observation.md:180),
  [`:248`](/Users/vishnu/chakri-unity/docs/prep/fun-ab-observation.md:248).
- **Triple Fun / Golden Wheel / Lucky 8 / Checker source recovery:**
  [`/Users/vishnu/chakri-unity/docs/prep/client-source-findings.md:185`](/Users/vishnu/chakri-unity/docs/prep/client-source-findings.md:185),
  [`:228`](/Users/vishnu/chakri-unity/docs/prep/client-source-findings.md:228),
  [`:250`](/Users/vishnu/chakri-unity/docs/prep/client-source-findings.md:250),
  [`:300`](/Users/vishnu/chakri-unity/docs/prep/client-source-findings.md:300).
- **Roulette:**
  [`/Users/vishnu/chakri-unity/docs/prep/roulette-observation.md:21`](/Users/vishnu/chakri-unity/docs/prep/roulette-observation.md:21),
  [`:363`](/Users/vishnu/chakri-unity/docs/prep/roulette-observation.md:363).
- **Fun Target inference:**
  [`/Users/vishnu/chakri-unity/unity/Assets/Scripts/Engines/Tables.cs:25`](/Users/vishnu/chakri-unity/unity/Assets/Scripts/Engines/Tables.cs:25),
  [`:45`](/Users/vishnu/chakri-unity/unity/Assets/Scripts/Engines/Tables.cs:45).
- **Bingo:**
  [`/Users/vishnu/chakri-unity/docs/prep/bingo-observation.md:169`](/Users/vishnu/chakri-unity/docs/prep/bingo-observation.md:169),
  [`:209`](/Users/vishnu/chakri-unity/docs/prep/bingo-observation.md:209).
- **Giant Jackpot / Golden Wheel / Checker / Lucky 8:**
  [`/Users/vishnu/chakri-unity/docs/prep/giant-jackpot-observation.md:80`](/Users/vishnu/chakri-unity/docs/prep/giant-jackpot-observation.md:80),
  [`:108`](/Users/vishnu/chakri-unity/docs/prep/giant-jackpot-observation.md:108),
  [`/Users/vishnu/chakri-unity/docs/prep/super-golden-wheel-observation.md:90`](/Users/vishnu/chakri-unity/docs/prep/super-golden-wheel-observation.md:90),
  [`/Users/vishnu/chakri-unity/docs/prep/checker-observation.md:130`](/Users/vishnu/chakri-unity/docs/prep/checker-observation.md:130),
  [`/Users/vishnu/chakri-unity/docs/prep/lucky-8-line-observation.md:127`](/Users/vishnu/chakri-unity/docs/prep/lucky-8-line-observation.md:127).
- **Poker-family divergences:**
  [`/Users/vishnu/chakri-unity/docs/prep/fever-joker-observation.md:175`](/Users/vishnu/chakri-unity/docs/prep/fever-joker-observation.md:175),
  [`/Users/vishnu/chakri-unity/docs/prep/fever-joker-bonus-observation.md:210`](/Users/vishnu/chakri-unity/docs/prep/fever-joker-bonus-observation.md:210),
  [`/Users/vishnu/chakri-unity/docs/prep/no-hold-observation.md:79`](/Users/vishnu/chakri-unity/docs/prep/no-hold-observation.md:79),
  [`/Users/vishnu/chakri-unity/docs/prep/champion-poker-observation.md:219`](/Users/vishnu/chakri-unity/docs/prep/champion-poker-observation.md:219).

## Minimum evidence package before a title can advance

For each individual title, collect and preserve an immutable test package:

1. a client recording or source proof for every enabled action and phase
   boundary, including no-more-bets / cancellation / Take;
2. at least one client win, one loss, and a result payload/presentation sample
   for every bet family; any bonus/double-up needs separate samples;
3. exact server-side resolver tests from stored result → every wager → ledger
   receipt, including duplicate request, retry, reconnect, clear/undo, and
   late action cases;
4. a server-clock replay proving whether a round is shared, plus a separately
   approved sanitized public feed only if the reference UI actually displays
   shared data;
5. Unity contract tests for catalog/lobby/scene translation and fixed
   `reveal_seconds`, followed by staging-only QA.

Only then may that one title be considered for `QA_VERIFIED`, and only after
staging result/ledger replay succeeds may its availability be considered for
promotion. This audit authorizes neither step.
