# Webhook processing boundaries

## Current player V1 callback

The player wallet currently selects one explicit `PAYMENT_PROVIDER`. Its signed
callback is `POST /api/payments/webhooks/{provider_name}`. The route verifies
that `{provider_name}` matches the configured provider, verifies the signed raw
body, and passes the normalized event to the existing financial wallet. Only
that established V1 event/reconciliation path may post an authoritative wallet
operation after provider, amount, currency and idempotency checks.

This is a single-provider callback. It does not use V2 CRM routes and must not
be represented as multi-provider traffic.

## Reserved V2 endpoint

`POST /api/webhooks/payments/{gateway_code}` is reserved for the additive V2
hub. Its implementation reads a bounded raw body, resolves a V2 gateway,
verifies timestamp and HMAC, hashes the body and persists deduplicated V2
evidence.

During Phase 0 this endpoint is not registration-ready and must not be entered
in a provider dashboard. There is no certified link from `payment_orders_v2`
or `webhook_events_v2` to the authoritative player `wallet_operations` and
`wallet_entries`, so a V2 event cannot be treated as player payment evidence.

Unique `(gateway_id, provider_event_id)` and body-hash conflict checks prevent
replay. Amount, currency and state transition must match the stored order.
Stored payloads are sanitized and immutable. Retryable missing-order events are
marked with a bounded next-attempt timestamp without applying financial effects.
This branch does not expose an operator replay action because it deliberately
does not retain raw webhook bodies; a dedicated encrypted raw-body retention,
worker and wallet-bridge design is required before replay or callback
registration can be enabled safely.
