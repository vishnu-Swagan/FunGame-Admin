# Rollback

During Phase 0 there should be no V2 player transaction to roll back. Set the
configuration-preview flag false, preserve any unexpected V2 evidence, and
stop for investigation. Never translate a V2 row into a V1 wallet correction.

1. Set `PAYMENTS_V2_ENABLED=false` and `PAYMENT_GATEWAY_ADMIN_ENABLED=false`.
2. Disable affected gateways; do not delete their history.
3. Stop V2 workers before reverting application code.
4. Revert the application release to the prior tested commit.
5. Keep additive Mongo collections and indexes in place during rollback; they
   are inert and preserve audit evidence.
6. Reconcile any in-flight provider references manually before re-enabling.

No destructive down migration is required. If indexes must later be removed,
do so only through a separately reviewed change after evidence retention.
