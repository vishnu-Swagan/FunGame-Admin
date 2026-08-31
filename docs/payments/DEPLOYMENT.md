# Staging deployment

Production deployment is intentionally not performed by this change.

1. Back up MongoDB and capture current index definitions.
2. Deploy backend code with all three V2 flags false.
3. Verify `/api/health` and existing financial regression tests.
4. Set a staging-only AES key and sandbox provider domain allow-list.
5. Enable `PAYMENT_GATEWAY_ADMIN_ENABLED=true` in staging only.
6. Create and test `MOCK_SANDBOX`; complete two-admin activation.
7. Enable `PAYMENTS_V2_ENABLED=true` only for sandbox webhook tests.
8. Exercise duplicate, timeout, refund, payout and settlement fixtures.
9. Review activity/audit evidence and disable the sandbox gateway.

Keep `PAYMENT_LIVE_MODE_ALLOWED=false` until provider, compliance, security and
operational approval are documented.

