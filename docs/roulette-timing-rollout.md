# American Roulette timing update

The dedicated American Roulette schedule is 70 seconds: **50 seconds betting,
10 seconds spinning, 10 seconds announcing the result and preparing the next
round**. Other tables, odds, payouts and the existing 0.4-second server mutation
guard are unchanged. Live clients use the server's absolute phase deadlines;
the standalone preview uses the same durations.

## Stored rounds

The old schedule uses `floor(epoch / 60)` as its round ID. The new schedule uses
`1_000_000_000 + floor(epoch / 70)`. IDs are opaque identifiers, not timestamps.
This prevents reusing historical winning numbers or trapping existing open bets
behind a smaller current round ID. No historical bets/results are rewritten.

Legacy bets remain eligible for idempotent settlement only after their original
30-second betting and 20-second spin windows have finished. The history strip
also hides a legacy winner until that deadline. New bets settle under the new
50/10/10 schedule. Absolute phase/round deadlines exclude the ID namespace.

## Production rollout (not performed by this implementation)

1. Temporarily pause American Roulette through the existing game availability
   control and allow at least 60 seconds for the last old round to finish.
   Do not disable or change unrelated games.
2. Deploy the frontend/backend update and confirm **all** backend instances use
   the new release before reopening the table. Mixed schedules must not accept
   bets at the same time.
3. Reopen American Roulette. Check server timing metadata is `50 / 10 / 70`,
   the display moves from betting to spin at 50 seconds, result at 60 seconds,
   and a fresh betting round at 70 seconds. Verify using test/sandbox accounts;
   do not place real-money test bets without separate authorization.
4. Preserve old open bets for the normal lazy settlement flow when users return.
   Do not delete results, bets or ledger entries during this timing change.

After new-namespace bets exist, **do not roll back to an old backend binary**:
its round comparisons cannot settle those bets. Prefer a forward fix. Any
rollback requires pausing the table and explicitly reconciling all open
new-namespace bets first.

## Verification

- Backend suite: 429 tests passed, including seven timing/transition tests.
- Frontend suite: 74 suites / 423 tests passed; production build succeeded.
- American Roulette exhaustive engine checks: all 163 bet shapes passed.
- General and data-integrity code reviews: no actionable regressions found.
- Local production-bundle browser check: full 70-second cycle, including the
  next round, passed with mocked server responses; zero bet requests or browser
  JavaScript errors. No live accounts or balances were used.
- Undefined-name checks pass for the changed backend files. A broader scan
  separately flags the existing `financial_wallet.py:3595` reference to `exc`;
  it is unchanged from the base commit and outside this timing update.
