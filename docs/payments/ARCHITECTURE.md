# Universal payment hub architecture

The existing FastAPI/Motor financial wallet remains the only wallet and posting
authority. Player deposits and withdrawals currently enter through the V1
`/api/payments/*` routes, which select one `PAYMENT_PROVIDER` and post through
`financial_wallet.py`. The additive V2 payment hub owns gateway configuration,
encrypted credentials, adapter validation, routing configuration/simulation,
approval evidence, webhook inspection, settlement imports and operator
activity. It is not currently a player-traffic or wallet-posting authority.

`routes_payment_hub.py` is the HTTP boundary. `payment_hub/domain.py` defines
normalized statuses, capabilities, money validation, transition rules and
redaction. `registry.py` resolves stable adapter types. `adapters.py` contains
only the guarded Generic REST runtime adapter; deterministic fakes exist only
inside tests. `service.py` owns
Mongo indexes and atomic/idempotent operational mutations.

MongoDB is the repository database. The hub deliberately follows existing
Motor collections and startup index migrations; it does not introduce a
parallel PostgreSQL backend. Existing `deposit_orders`, `withdrawal_requests`,
`wallet_operations` and immutable `wallet_entries` remain authoritative.
`payment_orders_v2` and `webhook_events_v2` are separate V2 operational
records. No certified bridge currently converts either collection into a
`wallet_operation` or `wallet_entry`.

## Phase 0 boundary

The CRM is a gateway-configuration preview with no player traffic. Provider and
route rows must remain disabled drafts, activation/approval controls are not
exposed in the UI, and the V2 callback route must not be registered with a
provider. Backend feature flags default off and are not a substitute for the
missing V1-to-V2 order, ledger, reconciliation and rollback certification.
