# Pappu Pictures: 20-second betting window

Pappu accepts bets for **20 seconds**, followed by its unchanged **8-second
reveal** and **4-second result**. The complete round is **32 seconds**.
The live API owns phase changes and deadlines; the standalone demo uses the
same timings. Bet limits, odds, payouts and the existing closing guard do not
change. Other fixed-cycle games retain their schedules and round identities.

## Existing rounds

The old Pappu cycle was 24 seconds with IDs `floor(epoch / 24)`. The new cycle
uses `1_000_000_000 + floor(epoch / 32)` so historical outcomes are never reused
for new bets and older open bets do not become unreachable. Outcomes/cache keys
are game-specific, so this namespace cannot collide with Roulette records.

Existing open bets remain recoverable through the normal idempotent settlement
flow, after their original 12-second betting + 8-second reveal deadline. New
bets settle only after their new 20-second betting + 8-second reveal deadline.
The history strip excludes each schedule's in-progress round, preserving its
previous-round policy. Historical bets/results are not rewritten or deleted.

## Production rollout (not performed yet)

1. Pause only Pappu through the existing game availability control and allow at
   least 24 seconds for the last old round to finish.
2. Deploy both frontend and backend. Confirm all backend instances are updated
   before reopening Pappu, so mixed schedules cannot accept bets simultaneously.
3. Check the live state reports `bet: 20, reveal: 8, result: 4, total: 32` and
   displays a fresh 20-second betting countdown every 32 seconds. Use mocked or
   sandbox transactions for verification; no real-money test bets are required.
4. Keep old bets/results intact for returning players' settlement.

Do not roll back to an old backend after new-namespace bets exist: it cannot
settle those IDs. Prefer a forward fix. A rollback requires pausing Pappu and
reconciling all new-namespace open bets first.

The earlier American Roulette update remains pending in this worktree. If both
updates ship together, follow its separate 60-second drain procedure as well;
do not reopen either table until all backend instances use the new schedules.

## Verification

- Full backend suite: 438 tests passed, including nine new Pappu timing tests.
- Full frontend suite: 75 suites / 425 tests passed; production build passed.
- General and data-integrity reviews found no actionable regressions.
- Local production-bundle browser check completed the 20/8/4 cycle and next
  betting round with mocked APIs, zero bet requests and zero JavaScript errors.
- Changed backend files pass undefined-name checks; the separately documented
  pre-existing refund-code lint issue in the Roulette notes is unchanged.
