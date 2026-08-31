# Payment hub API

New endpoints use `{data, meta:{request_id,timestamp}, error}` envelopes.

- `GET/POST /api/admin/payment-gateways` — list/create disabled gateways.
- `GET/PATCH /api/admin/payment-gateways/{id}` — detail/versioned update.
- `POST .../{id}/credentials|rotate-credentials` — write-only secret rotation.
- `POST .../{id}/test|sandbox-transaction` — sanitized sandbox validation.
- `POST .../{id}/request-activation|approve-activation|disable` — dual control.
- `GET/POST /api/admin/payment-routes` — route list/create.
- `POST .../payment-routes/{id}/request-activation|approve-activation` — dual control.
- `GET /api/admin/payment-approvals` — payment-only approval queue.
- `POST /api/admin/payment-routes/simulate` — deterministic decision evidence.
- `GET /api/admin/payments[/{id}]` — normalized sandbox order inspection.
- `GET /api/admin/webhook-events[/{id}]` — sanitized webhook inspector.
- `GET/POST /api/admin/settlements[/import]` — checksum import evidence.
- `GET /api/admin/reconciliation` and `/activity` — operational evidence.
- `GET /api/admin/users/{id}/financial-overview` and distributor equivalent.
- `POST /api/webhooks/payments/{gateway_code}` — signed raw-body webhook.
