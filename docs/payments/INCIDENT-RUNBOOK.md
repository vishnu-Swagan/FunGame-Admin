# Payment incident response

**Gateway down:** disable routing/gateway, preserve orders, query status before
fallback, notify operations and record a case/correlation ID.

**Webhook backlog/signature failures:** keep financial effects closed, compare
provider certificate/secret version and timestamp tolerance, request a signed
provider redelivery or perform a provider status reconciliation. Do not replay
the sanitized inspector payload as though it were the original signed body.

**Payout timeout:** retain the reservation, mark the result unknown, perform a
provider status lookup bound to withdrawal, amount, currency, beneficiary and
idempotency key. Never resubmit elsewhere without proof no payout exists.

**Settlement mismatch:** quarantine the import, open a reconciliation case and
obtain approval before any compensating ledger adjustment.
