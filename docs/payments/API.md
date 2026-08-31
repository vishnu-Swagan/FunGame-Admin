# Payment hub API

New endpoints use `{data, meta:{request_id,timestamp}, error}` envelopes.

This is a V2 contract inventory, not an instruction to enable traffic. During
Phase 0 the CRM may create disabled configuration drafts and inspect sanitized
evidence only. Activation endpoints remain server-side fail-closed controls and
are not exposed as operator actions while the player-wallet bridge is
uncertified.

- `GET/POST /api/admin/payment-gateways` — list/create disabled gateways.
- `GET/PATCH /api/admin/payment-gateways/{id}` — detail/versioned update.
- `POST .../{id}/credentials|rotate-credentials` — write-only secret rotation.
- `POST .../{id}/test` — sanitized provider health/config validation; it does
  not create a payment transaction.
- `POST .../{id}/request-activation|approve-activation|disable` — reserved
  dual-control API; request/approval is not available in the Phase 0 CRM.
- `GET/POST /api/admin/payment-routes` — route list/create.
- `POST .../payment-routes/{id}/request-activation|approve-activation` —
  reserved dual-control API; not available in the Phase 0 CRM.
- `GET /api/admin/payment-approvals` — payment-only approval queue.
- `POST /api/admin/payment-routes/simulate` — deterministic decision evidence.
- `GET /api/admin/payments[/{id}]` — normalized payment-order inspection.
- `GET /api/admin/webhook-events[/{id}]` — sanitized webhook inspector.
- `GET/POST /api/admin/settlements[/import]` — checksum import evidence.
- `GET /api/admin/reconciliation` and `/activity` — operational evidence.
- `GET /api/admin/users/{id}/financial-overview` and distributor equivalent.
- `POST /api/webhooks/payments/{gateway_code}` — reserved V2 signed raw-body
  endpoint. Do not register it with a provider until V1↔V2 wallet certification.

The player wallet's current single-provider V1 callback is a different route:
`POST /api/payments/webhooks/{provider_name}`. V1 selects the one explicit
`PAYMENT_PROVIDER`; V2 CRM rows do not receive or route that player traffic.
