# Ledger and reconciliation

The repository's wallet ledger is append-only: wallet operations have unique
source/idempotency keys and wallet entries record each bucket delta. Posted
records are not edited; corrections use compensating operations.

The payment hub does not create a second balance. Settlement files are limited,
checksum-deduplicated and previewed before reconciliation. Mismatched amount,
currency, provider reference or missing counterpart becomes an exception; it
does not adjust a wallet. Write-offs and manual adjustments require explicit
maker-checker workflows before implementation/activation.

