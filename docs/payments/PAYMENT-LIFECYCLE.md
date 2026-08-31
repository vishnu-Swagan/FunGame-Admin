# Pay-in lifecycle

Normalized states are `CREATED`, `PENDING`, `REQUIRES_ACTION`, `PROCESSING`,
`SUCCEEDED`, `FAILED`, `CANCELLED`, `EXPIRED`, `PARTIALLY_REFUNDED`, `REFUNDED`,
`REVERSED` and `DISPUTED`.

The transition matrix in `domain.py` rejects terminal-to-success and other
illegal transitions. Money is an integer minor-unit amount with a three-letter
uppercase currency. Browser returns are informational and cannot post value.
Only the existing verified provider event/reconciliation wallet path may credit
cash chips, with its unique operation/source keys preventing double posting.
Today that is the single-provider V1 callback
`/api/payments/webhooks/{provider_name}`. A V2 webhook or CRM status cannot
credit chips until the V1↔V2 wallet bridge is separately certified.
