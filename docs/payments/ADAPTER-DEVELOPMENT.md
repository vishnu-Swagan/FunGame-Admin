# Gateway adapter development guide

Implement the `GatewayAdapter` contract in `payment_hub/adapters.py`, then:

1. Declare an immutable `Capability` set.
2. Validate configuration without network side effects.
3. Return normalized `AdapterResult` and `WebhookResult` values.
4. Map provider statuses and errors to stable domain values/codes.
5. Redact secrets and protected customer fields.
6. Add the factory to `payment_hub/registry.py`.
7. Run the shared contract, malformed-response, timeout, idempotency and webhook tests.
8. Add the provider documentation version and sandbox evidence.

Provider code must not modify wallet, ledger, user, distributor, commission,
refund or reconciliation business services. Unsupported methods must raise
`CAPABILITY_NOT_SUPPORTED`, never an attribute error.

