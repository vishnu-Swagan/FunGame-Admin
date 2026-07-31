# Distributor & Commission Engine — design

The deck (`Project Plan Deck Guidance`, 3 pages) specifies the happy path. This
document is that flow plus the cases a commission engine meets in production and
which, left out, cost the operator money or fail an audit.

Everything here is written for a **UK-registered operator taking players
worldwide**. That combination, not the software, drives most of the constraints
below.

---

## A. What the deck already fixes

| § | Flow | Status in this codebase |
|---|---|---|
| 1 | Registration → referral code → pending queue → KYC → assign distributor | signup queue exists; **no referral code, no distributor** |
| 2 | Deposit → gateway → pending queue → approve/reject → wallet CREDIT | chip-request queue exists; **no gateway, no rejection reason** |
| 3 | Bet → DEBIT → round → CREDIT → history → NGR posted | rounds + chip ledger exist; **no turnover/NGR aggregation** |
| 4 | 02:00 cron → group by distributor → NGR × % → ledger → payout queue → admin → paid | **nothing** |
| 5 | Distributor portal: dashboard, %, revenue, reports, CSV/PDF, ticket | **nothing** |
| 6 | Ledger effects per event | partial |

---

## B. Money representation — decide this before anything else

**Store money as integer minor units** (pence), never floats. `0.1 + 0.2` is not
`0.3`, and a commission engine that sums millions of rows in floats will not
reconcile to its own statements.

- one currency field per amount, ISO-4217, alongside the integer
- one documented rounding rule, applied once, at the point commission is
  calculated: **round half up, to the minor unit, in the operator's currency**
- FX: if players deposit in other currencies, freeze the rate used on each
  ledger row. A statement must reproduce exactly, years later.

The existing chip ledger is integer chips already, which is the right shape.

---

## C. NGR — the deck says "calculate NGR" and that is the whole argument

`NGR = stake − payout` is *gross* gaming revenue, not net. What the operator can
actually share is net of the costs the operator carries. Make every deduction an
explicit, per-distributor configurable flag, because this is the single most
common source of affiliate disputes:

```
GGR  = stake − payout
NGR  = GGR
     − bonus cost            (free chips, cashback, matched deposits)
     − gateway fees          (payment processing on that player's deposits)
     − chargebacks/refunds
     − gaming duty           (UK RGD 21% on GGR for GB customers)
     − platform/content fees (game provider revenue share)
```

Whether each line is deducted **must be recorded on the commission row itself**,
not looked up later, or a config change silently rewrites history.

---

## D. Negative NGR must carry forward

The deck has no answer for a distributor whose players win. Without carryover:

- month 1: NGR −£4,000 → commission £0, operator absorbs it
- month 2: NGR +£4,000 → commission paid in full
- net revenue £0, commission paid > £0 — **the operator pays for a losing player base**

Carry the negative balance forward per distributor until cleared. Decide and
record: does carryover reset annually, on termination, never? Default here:
**carries indefinitely, resets only on written agreement**.

---

## E. The cron must be idempotent, and it must know its timezone

The deck says `cron 02:00`. Two things missing.

**Timezone.** 02:00 where? A UK operator with worldwide players needs one
declared **settlement timezone** (Europe/London) and a defined *gaming day*
boundary. Note London is not UTC for half the year — a naive local cron either
runs twice or not at all on the DST switch nights.

Store the boundary as UTC instants; display in the operator's zone.

**Idempotency.** A scheduler retries. A deploy restarts a container mid-run. Two
instances can fire together. Any of these pays a distributor twice.

- one `commission_runs` row per `(period_start, period_end)` with a **unique
  index**, claimed before work begins
- each commission ledger row keyed `(distributor_id, period, version)` unique
- a run is resumable: it either completes or is rolled back, never half-applied
- re-running a closed period is refused, not silently repeated

The codebase already has `system_locks`, which is the right primitive.

---

## F. Rate changes must be effective-dated

A distributor's percentage is not a single number, it is a **history**:

```
{ distributor_id, rate_bps, effective_from, effective_to, set_by, set_at, note }
```

Commission for a period uses the rate in force *during that period*. Editing a
rate today must not restate last quarter's statements. Store `rate_bps` as basis
points (integer) — `2550` not `25.5`.

---

## G. Payout hygiene

- **Minimum payout threshold** — below it, roll forward rather than raise a £0.37 payout
- **Payment holdback period** — hold N days against chargebacks before releasing
- **Clawback** — a deposit reversed after commission was paid must post a negative
  commission row against the next period, not edit the paid one
- **Tax** — withholding where required; distributors are suppliers and need invoices
- **Payout ledger separate from the wallet ledger.** Distributor money is not player
  money and must never share a balance

---

## H. Who counts as an "active player"

The deck says "read all active players". Exclude:

- self-excluded and cooling-off accounts
- accounts closed, suspended or under AML review
- duplicates linked to an existing account
- the distributor's own accounts — **self-referral is the most common affiliate fraud**;
  block by device, payment instrument and identity, not just by email

---

## I. Referral code lifecycle

- unique, case-insensitive, reserved word list, no confusable characters (`0/O`, `1/l`)
- a player is attributed **once, at registration**, and the attribution is immutable
  — otherwise a later code entry steals a player another distributor acquired
- admin reassignment is possible but is an audited event, and by default is
  **not retroactive**: past periods stay with the original distributor
- no code → the **house account**, which is a real distributor row, not a null

---

## J. Compliance hooks the software must expose

Not legal advice, and not optional to *design for* — a UK licensee is
accountable for these, and for its affiliates' conduct.

- **Age verification before deposit and before play.** UKGC requires 18+ verification
  before a customer can deposit *or* gamble, including free-to-play
- **Market allow-list.** "Worldwide" is not a market. Licensing is per jurisdiction and
  several ban online casino outright. Geo-block by IP + payment instrument country,
  configurable per market, and log every refusal
- **Self-exclusion**, timeouts, deposit/loss/session limits, reality checks
- **AML** thresholds and source-of-funds triggers
- **Affiliate conduct** — distributors are marketing affiliates; the licensee answers for
  their advertising. The portal needs approved-creative controls and a terms
  acceptance record

---

## K. Build order

1. Money as integer minor units; ledger rows immutable and append-only
2. Distributor entity, referral codes, house account, attribution at registration
3. Turnover/GGR/NGR aggregation per player per gaming day
4. Effective-dated rate history
5. Commission run: idempotent, locked, resumable, with carryover
6. Payout queue, thresholds, holdback, admin approval, clawbacks
7. Distributor portal: dashboard, statements, CSV/PDF exports reconciling to the ledger
8. Compliance layer: geo, age, self-exclusion, limits

Steps 1–3 are prerequisites for everything else and carry no policy questions.
