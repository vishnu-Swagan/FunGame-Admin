# Payout lifecycle

Normalized states are `CREATED`, `PENDING_APPROVAL`, `APPROVED`, `QUEUED`,
`PROCESSING`, `PAID`, `FAILED`, `ON_HOLD`, `CANCELLED` and `REVERSED`.

The established withdrawal service reserves cash chips before external work.
Approval, submission, reconciliation and release use conditional updates and
idempotency keys. An ambiguous provider timeout is `SUBMISSION_UNKNOWN` and
must be resolved by a bound status lookup; it is never blindly routed to a
second provider. Failed/cancelled requests release the hold once.

