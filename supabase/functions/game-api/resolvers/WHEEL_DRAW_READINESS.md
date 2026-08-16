# Wheel/draw resolver readiness

These modules are review-stage server components. They validate recovered
structures or explicitly labelled current-Unity review envelopes and expose
deterministic evidence vectors, but they are deliberately separate from
`shared/live-resolver-registry.ts`. A module may be registered only after its
manifest becomes `READY`, all blockers are removed, and the complete executable
evidence gate accepts it.

All settlement values are virtual points. Currency, deposit, payment and
withdrawal fields are rejected by the shared resolver contract.

| Title | Status | Safe logic now available | Decisive live gaps |
| --- | --- | --- | --- |
| Triple Fun | **BLOCKED** | Fixed-width single/double/triple selections; three-digit result projection; source-backed 9/90/900 bhav and per-class caps as inspection metadata | RNG protocol, full timing, total-return versus profit semantics, Take/reconnect/ledger proof |
| Giant Jackpot | **BLOCKED** | Four-window/seven-symbol validation; eighteen-row ladder classification; fifteen published base amounts retained without turning them into payouts | Reel weights, amount-to-stake scale, three cap prices, multi-row precedence, timing and ledger proof |
| Golden Wheel | **BLOCKED** | Eight whole-column selection validation; provisional current-Unity 1..8 pair envelope; nine displayed multiplier values retained as evidence | Authoritative face labels/protocol, stripped pair tables, server-fed bhav, result distribution, real Unity column contract, timing/D-up/ledger proof |
| Keno | **BLOCKED** | Canonical 1–10 picks from 1..80; provisional current-Unity 20-number envelope; exact hit counting inside that envelope; six-second reveal evidence | Authoritative draw cardinality/payload/order, client paytable, remaining phase boundaries, stake-limit conflict and ledger proof |
| Lucky 8 Line | **BLOCKED** | Eight separate line stakes; 3x3/nine-symbol validation; client line ordering; published line/cherry/Funrep/all-nine components retained separately | Reel weights, stake basis, component precedence, X2000 logo rule, Start timing, D-up/Take and ledger proof |

The focused test suite is `resolvers.test.ts`. It asserts strict input and
outcome validation, deterministic vectors, virtual-point-only behavior, and
that none of these five modules can be promoted by import or configuration
alone.
