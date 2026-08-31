# Staging deployment

Production deployment is intentionally not performed by this change.

1. Back up MongoDB and capture current index definitions.
2. Deploy backend code with all three V2 flags false.
3. Verify `/api/health` and existing financial regression tests.
4. Set a staging-only AES key and sandbox provider domain allow-list.
5. Keep `PAYMENTS_V2_ENABLED=false` and `PAYMENT_LIVE_MODE_ALLOWED=false`.
   If an isolated staging review explicitly needs the CRM preview, enable only
   `PAYMENT_GATEWAY_ADMIN_ENABLED` and record that it authorizes configuration
   drafts, not player traffic.
6. Create a disabled `GENERIC_REST` staging draft from the provider's official
   sandbox contract, store staging-only credentials through the write-only API,
   and run configuration validation without creating a payment transaction.
7. Do not request or approve V2 gateway/route activation, and do not register
   `/api/webhooks/payments/{gateway_code}` with any provider.
8. Exercise mapping, signature, duplicate, timeout and settlement fixtures
   locally or in isolated staging without wallet posting.
9. Review activity/audit evidence, remove staging credentials when no longer
   needed, and return `PAYMENT_GATEWAY_ADMIN_ENABLED=false`.

The player flow remains the separate single-provider V1 integration at
`/api/payments/webhooks/{provider_name}`. Certifying that callback does not
certify V2 multi-provider routing. Keep every V2 flag false until the launch
checklist's ledger-provenance and V1↔V2 bridge gates are complete.
