# Test evidence

Verified implementation evidence (2026-09-01):

- Full backend suite (serial, bytecode/cache disabled because local disk space is
  constrained): 175 tests passed and 10 subtests passed; one unrelated existing
  portal assertion failed when Europe/London crossed the first day of the month
  because it always includes yesterday in month-to-date totals. No portal code
  or test was changed by this payment release.
- Payment Hub contract/security suite: 26 tests passed and 8 subtests passed,
  including dual-control gateway/route activation, concurrent idempotency, SSRF
  denial, encrypted secret rotation, webhook deduplication/quarantine and
  settlement checksums.
- Combined Payment Hub and player-payment regression: 60 tests passed and 30
  subtests passed.
- Phase 0 CRM boundary suite: 3 tests passed, covering the persistent
  no-player-traffic notice, suppression of V2 callback/activation controls even
  when stored records report enabled/live values, and disabled-draft provider
  creation.
- Earlier CRM/frontend baseline: 36 suites and 233 tests passed, and its
  optimized production build compiled successfully. Post-hardening frontend
  regression tests were added; a local rerun was unavailable because the
  checkout's existing `frontend/node_modules` link targets a missing iCloud
  worktree. The Render clean-install production build is therefore a required
  deployment gate for this revision.
- Python compilation, `git diff --check` and `pip check` passed.
- Secret-pattern search found no committed production credential.

No production payment, production credential or external provider call was used
by these tests.
