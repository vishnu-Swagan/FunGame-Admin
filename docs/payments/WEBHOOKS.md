# Webhook processing

The V2 endpoint is `POST /api/webhooks/payments/{gateway_code}`. It reads the
raw body with a bounded size, resolves an enabled gateway, verifies timestamp
and HMAC before parsing, hashes the body and persists a deduplicated event.

Unique `(gateway_id, provider_event_id)` and body-hash conflict checks prevent
replay. Amount, currency and state transition must match the stored order.
Stored payloads are sanitized and immutable. Retryable missing-order events are
marked with a bounded next-attempt timestamp without applying financial effects.
This branch does not expose an operator replay action because it deliberately
does not retain raw webhook bodies; a dedicated encrypted raw-body retention and
worker design is required before replay can be enabled safely.
