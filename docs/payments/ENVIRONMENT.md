# Payment environment variables

- `PAYMENTS_V2_ENABLED` — enables V2 webhook/order processing; default false.
- `PAYMENT_GATEWAY_ADMIN_ENABLED` — exposes gateway CRM functions; default false.
- `PAYMENT_LIVE_MODE_ALLOWED` — permits live configuration/activation; default false.
- `PAYMENT_CREDENTIALS_MASTER_KEY` — URL-safe base64 32-byte AES key; secret manager only.
- `PAYMENT_WEBHOOK_PUBLIC_BASE_URL` — approved public API origin.
- `PAYMENT_HTTP_CONNECT_TIMEOUT_MS` / `PAYMENT_HTTP_REQUEST_TIMEOUT_MS` — outbound limits.
- `PAYMENT_HTTP_MAX_RESPONSE_BYTES` — provider/webhook body ceiling.
- `PAYMENT_WEBHOOK_REPLAY_WINDOW_SECONDS` — signature timestamp tolerance.
- `PAYMENT_RETRY_MAX_ATTEMPTS` / `PAYMENT_RETRY_BASE_DELAY_SECONDS` — reserved for the bounded V2 worker rollout.
- `PAYMENT_OUTBOX_BATCH_SIZE` — reserved durable-worker batch bound.
- `PAYMENT_GATEWAY_HEALTH_INTERVAL_SECONDS` / `PAYMENT_STATUS_POLL_INTERVAL_SECONDS` — reserved worker cadence.
- `PAYMENT_PROVIDER_ALLOWED_DOMAINS` — comma-separated reviewed provider hosts.
- `PAYMENT_ALERT_COOLDOWN_SECONDS` — alert deduplication window.

Never place values in source control. Render entries marked `sync:false` belong
in the service secret manager.
