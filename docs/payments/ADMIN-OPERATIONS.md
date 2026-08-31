# Admin payment operations

During Phase 0 the CRM Payment Hub is a configuration preview only. It exposes
disabled gateway drafts, encrypted credential rotation, configuration
validation, deterministic route drafts, stored approval/webhook evidence and
immutable activity. It does not carry player traffic, register callbacks,
create a player payment, credit chips or submit a withdrawal.

Operators must never share credentials in notes or tickets. A successful
configuration validation means only that the declared provider contract can be
reached safely; it is not transaction or launch readiness. The CRM intentionally
exposes no activation or approval action until the player V1-to-V2 bridge and
ledger provenance gates are certified. Do not register the reserved V2 callback
path from this screen.

The current player wallet uses one separately configured V1 provider and the
callback `/api/payments/webhooks/{provider_name}`. Adding multiple V2 CRM drafts
does not change that selection or create multi-provider player routing.

Manual settlement imports are preview/checksum operations. A repeated file is
reported as a duplicate. Financial status is never manually changed through a
generic "mark successful" action.
