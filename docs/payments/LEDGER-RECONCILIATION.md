# Ledger and reconciliation

The repository's wallet ledger is append-only: wallet operations have unique
source/idempotency keys and wallet entries record each bucket delta. Posted
records are not edited; corrections use compensating operations.

Ledger provenance currently starts in the V1 player endpoints under
`/api/payments/*`, continues through `financial_wallet.py`, and terminates in an
immutable `wallet_operation` plus its bucket-specific `wallet_entries`.
`deposit_orders` and `withdrawal_requests` retain the business source. A release
inventory must prove those links and the cash/bonus/held bucket source keys
before any real-money flag changes.

The payment hub does not create a second balance. Settlement files are limited,
checksum-deduplicated and previewed before reconciliation. Mismatched amount,
currency, provider reference or missing counterpart becomes an exception; it
does not adjust a wallet. Write-offs and manual adjustments require explicit
maker-checker workflows before implementation/activation.

V2 collections (`payment_orders_v2`, `webhook_events_v2`, gateway and route
records) are not ledger provenance. Until a reviewed V1↔V2 bridge binds the
player, V1 order, V2 order, provider reference, amount, currency and one wallet
source/idempotency key—and proves reconciliation and rollback—V2 records must
remain configuration or evidence only.
