# Universal payment hub architecture

The existing FastAPI/Motor financial wallet remains the only wallet and posting
authority. The additive payment hub owns gateway configuration, encrypted
credentials, adapter resolution, routing decisions, approval evidence,
webhook inspection, settlement imports and operator activity.

`routes_payment_hub.py` is the HTTP boundary. `payment_hub/domain.py` defines
normalized statuses, capabilities, money validation, transition rules and
redaction. `registry.py` resolves stable adapter types. `adapters.py` contains
the deterministic mock and guarded Generic REST adapters. `service.py` owns
Mongo indexes and atomic/idempotent operational mutations.

MongoDB is the repository database. The hub deliberately follows existing
Motor collections and startup index migrations; it does not introduce a
parallel PostgreSQL backend. Existing `deposit_orders`, `withdrawal_requests`,
`wallet_operations` and immutable `wallet_entries` remain authoritative.

Feature flags default off. Live configuration and activation fail closed.

