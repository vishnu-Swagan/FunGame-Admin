# Payment environment variables

- `PAYMENTS_V2_ENABLED` — reserved V2 webhook/order processing flag; default
  false and must remain false until the player-wallet bridge is certified.
- `PAYMENT_GATEWAY_ADMIN_ENABLED` — exposes gateway configuration CRM
  functions; default false. It does not authorize player traffic.
- `PAYMENT_LIVE_MODE_ALLOWED` — backend activation guard; default false. It is
  not an operator launch switch and must remain false during Phase 0.
- `PAYMENT_CREDENTIALS_MASTER_KEY` — URL-safe base64 32-byte AES key; secret manager only.
- `PAYMENT_WEBHOOK_PUBLIC_BASE_URL` — reserved credential-free HTTPS origin for
  a future certified V2 callback. The Phase 0 CRM does not display a
  registration-ready URL, and providers must not be configured from this value.
- `PAYMENT_HTTP_CONNECT_TIMEOUT_MS` / `PAYMENT_HTTP_REQUEST_TIMEOUT_MS` — outbound limits.
- `PAYMENT_HTTP_MAX_RESPONSE_BYTES` — provider/webhook body ceiling.
- `PAYMENT_WEBHOOK_REPLAY_WINDOW_SECONDS` — signature timestamp tolerance.
- `PAYMENT_RETRY_MAX_ATTEMPTS` / `PAYMENT_RETRY_BASE_DELAY_SECONDS` — reserved for the bounded V2 worker rollout.
- `PAYMENT_OUTBOX_BATCH_SIZE` — reserved durable-worker batch bound.
- `PAYMENT_GATEWAY_HEALTH_INTERVAL_SECONDS` / `PAYMENT_STATUS_POLL_INTERVAL_SECONDS` — reserved worker cadence.
- `PAYMENT_PROVIDER_ALLOWED_DOMAINS` — comma-separated reviewed provider hosts.
- `PAYMENT_PROVIDER_CHECKOUT_ALLOWED_DOMAINS` — comma-separated reviewed hosts
  to which the legacy bridge may redirect a player for hosted checkout.
- `PAYMENT_ALERT_COOLDOWN_SECONDS` — alert deduplication window.

Legacy player-wallet bridge variables:

- `PAYMENT_PROVIDER` — explicit non-mock provider code; there is no default.
- `PAYMENT_PROVIDER_CONFIG_JSON` — approved provider contract schema described
  in `GENERIC-REST-ADAPTER.md`; it contains no credential values.
- `PAYMENT_PROVIDER_*` credential variables — names referenced by the JSON
  `auth` and `webhook` blocks. Store values only in the host secret manager.

The current V1 provider callback is
`/api/payments/webhooks/{provider_name}`, where `{provider_name}` must match the
single explicit `PAYMENT_PROVIDER`. This is separate from the reserved V2 path
`/api/webhooks/payments/{gateway_code}`.

The V2 CRM registry stores any number of gateways with unique `gateway_code`
values, encrypted credentials, capabilities, health and route priority/weight.
The legacy player wallet still selects the single `PAYMENT_PROVIDER` bridge;
multi-provider player routing requires the wallet-to-V2 integration gate and is
not enabled merely by adding CRM gateway drafts.

Never place values in source control. Render entries marked `sync:false` belong
in the service secret manager.

The separate deposit-only SgPay24 hosted UPI rail, including its explicit
feature gate, rate, daily cap, merchant secrets, callback and canary procedure,
is documented in [SGPAY24-RUNBOOK.md](SGPAY24-RUNBOOK.md). Enabling that rail
does not authorize any V2, withdrawal or financial-wallet flag.
