# Payment gateway integration runbook

This repository contains a provider-neutral wallet and payment scaffold. It is
not a live payment-provider integration. Production payment features must stay
disabled until the operator has an approved provider account, production
credentials, a reviewed jurisdiction policy, verified KYC controls and a
transaction-capable MongoDB deployment.

The canonical sites are:

- Player application: `https://chakri.casino`
- Admin CRM: `https://crm.chakri.casino`
- API: `https://api.chakri.casino`

## Safety switches

All switches default to disabled and must remain disabled in production until
the launch checklist is complete:

```dotenv
REAL_MONEY_ENABLED=false
DEPOSITS_ENABLED=false
WITHDRAWALS_ENABLED=false
AUTO_WITHDRAWALS_ENABLED=false
FINANCIAL_GAME_WALLET_INTEGRATED=false
```

`FINANCIAL_GAME_WALLET_INTEGRATED` is a separate prerequisite. It must not be
enabled merely because a payment provider is configured. It confirms that all
playable games preserve cash/bonus provenance through stake, prize and refund
settlement. Existing legacy chip balances are imported only as promotional,
non-withdrawable chips.

Legacy play-chip BUY/SELL/RETURN requests and points-to-chips conversion are
blocked whenever `REAL_MONEY_ENABLED=true`. They update only the historical
aggregate ledger and must not be re-enabled until they are transactionally
mapped to explicit nonwithdrawable bonus movements and included in gameplay
wallet certification.

The default withdrawal mode is `MANUAL`. Switching to `AUTOMATIC` is allowed
only for a designated Super Admin with recent password re-authentication and
2FA, and only while the automatic-withdrawal feature is enabled.

## Admin CRM access and permission provisioning

The only trusted operator hostname is `https://crm.chakri.casino`. The player
host must not render or authorize CRM routes. Financial APIs independently
enforce exact server-side permissions; hiding a menu is never treated as an
authorization control.

Canonical permissions are:

- `PAYMENTS_VIEW`
- `PAYMENTS_RECONCILE`
- `WITHDRAWALS_APPROVE`
- `WITHDRAWALS_MARK_PAID`
- `PAYMENT_SETTINGS_WRITE`
- `LEDGER_VIEW`
- `AUDIT_VIEW`
- `KYC_VIEW`
- `KYC_REVIEW`
- `COMPLIANCE_ADMIN`

Store these in the administrator's `admin_permissions` array. An explicitly
empty array means no permissions; it must not fall back to an older legacy
`permissions` value. `PAYMENT_SETTINGS_WRITE` also requires
`admin_role=SUPER_ADMIN` and recent step-up authentication.
`COMPLIANCE_ADMIN` is the exact grant for changing responsible-play
configuration or overriding a self-exclusion; both actions also require recent
password re-authentication and 2FA and create an immutable audit event.

Recovering a provider payout reference is also an exceptional step-up action:
the administrator needs both `PAYMENTS_RECONCILE` and
`WITHDRAWALS_MARK_PAID`, must record a reason, and the subsequent provider
lookup must bind the payout to the original withdrawal before any hold is
finalized.

There is intentionally no public API that promotes administrators or grants
financial permissions. Bootstrap or change them only through an authenticated
operator control-plane/database procedure with a second-person review, a
ticket/change reference, a backup of the previous record and a post-change
login/authorization check. Never grant permissions by editing a browser token
or client payload.

The payment settings endpoint already fails closed unless the administrator
record contains `mfa_enabled=true` plus recent, server-written
`mfa_verified_at` and `reauthenticated_at` timestamps. Do not write those fields
manually. A production-grade password re-authentication and 2FA ceremony that
writes them is still a launch prerequisite; until it exists, automatic-mode
changes are intentionally unavailable.

## Provider contract

A provider adapter must implement these operations without changing wallet
logic:

- `createDepositOrder`
- `createCheckoutSession`
- `verifyWebhook`
- `getPaymentStatus`
- `createBeneficiary`
- `submitPayout`
- `getPayoutStatus`
- `cancelPayout`, when supported
- `refundPayment`, when supported

The local mock provider is for automated tests and development only. Production
configuration rejects the mock provider.

Deposit adapters must declare stable order idempotency and authoritative
payment-status lookup. A terminal lookup must return status, exact amount,
currency, and an immutable provider payment reference; a bare `PAID` string is
never sufficient. Payout lookup must additionally bind the provider payout to
the original withdrawal ID, idempotency key, amount, currency, and beneficiary.

## URLs to give the approved provider

Replace `{provider}` with the adapter's configured, lowercase route name.

- Server webhook: `https://api.chakri.casino/api/payments/webhooks/{provider}`
- Browser return: `https://chakri.casino/chips/deposit/return`
- Admin CRM: `https://crm.chakri.casino/admin/payments`

The browser return page only polls a server-created deposit order. It never
credits chips. A deposit is credited only after a valid signed server-to-server
webhook, or after an authenticated reconciliation check reaches the same
provider-confirmed paid state.

## Information required after provider approval

Do not send secrets through source control. When the provider is selected,
collect:

1. Provider name and official API documentation version.
2. Sandbox and production API base URLs.
3. Merchant/account identifier and credential names.
4. Webhook signing algorithm, webhook secret or public certificate, timestamp
   header, signature header and replay window.
5. Provider IP allow-list or mutual-TLS requirements, if any.
6. Hosted-checkout creation fields and permitted return/cancel URLs.
7. Deposit event names and the provider's Created, Pending, Paid, Failed,
   Expired and Refunded mappings.
8. Beneficiary fields, bank validation rules and provider token lifecycle.
9. Payout event names and the provider's Submitted, Processing, Paid, Failed
   and Cancelled mappings.
10. Provider idempotency, status lookup, retry, refund and cancellation
    capabilities.
11. INR minimums, maximums, fees and settlement/reconciliation schedule.
12. Production KYC/AML evidence requirements and the approved jurisdiction
    allow-list.
13. A production administrator 2FA/re-authentication design, recovery policy
    and named approvers for financial-role provisioning.

Store production credentials only in the hosting platform's secret manager.
Never put provider keys, webhook secrets, the bank-encryption key or raw bank
details in Git, client-side environment variables, logs or support screenshots.

## Data and accounting rules

- INR is stored as integer paise; chips are stored as integers.
- Each order freezes its versioned `CHIPS_PER_INR` conversion-rate snapshot.
- Pending deposit orders atomically reserve every active deposit-limit window;
  failed/expired orders release that reservation and stale pre-checkout orders
  expire after a bounded recovery window.
- Credited deposits remain in a separate, bounded reconciliation queue through
  the configured provider refund/chargeback window so a missed refund webhook
  cannot leave returned money represented as playable cash chips.
- Every mutation requires an idempotency key.
- Wallet entries are append-only and reference one immutable operation.
- A withdrawal atomically moves withdrawable cash chips to held chips before a
  request is created.
- A rejected, cancelled or permanently failed request releases a hold exactly
  once; a paid request permanently consumes it exactly once.
- Promotional/bonus chips are not withdrawable.
- Raw bank details are encrypted at rest and masked in player and routine admin
  responses. Prefer a provider beneficiary token for repeat payouts.

The current scaffold intentionally has no operator endpoint that reveals raw
bank details. Before manual withdrawals can be enabled, the approved provider
must supply a beneficiary/token workflow that lets a least-privilege,
step-up-authenticated operator complete the payout without exposing raw bank
data. That handoff must be audited. Until then, keep withdrawals disabled.

## Provider dashboard setup

After implementing the selected adapter:

1. Add the production webhook URL and subscribe only to supported deposit and
   payout events.
2. Add the exact browser return URL. Do not use it as proof of payment.
3. Configure the provider's signing secret/certificate in the API service's
   secret manager.
4. Configure any IP allow-list or mTLS certificate.
5. Keep withdrawals in `MANUAL` during initial deposit certification.
6. Verify webhook signature failures are visible in the CRM without exposing
   raw secrets or bank data.

## Verification before enabling a switch

Run the focused wallet/provider tests and the full backend/frontend regression
suites, then certify these cases in the provider sandbox:

- A success-page redirect without a webhook does not credit chips.
- Valid webhook delivery credits exactly once.
- Duplicate, delayed and out-of-order events do not duplicate or reverse a
  terminal operation incorrectly.
- Reconciliation repairs a missed webhook without double-crediting.
- Manual withdrawals never call the payout API.
- Automatic withdrawals submit once, and disabling automatic mode prevents new
  submissions without cancelling already submitted payouts.
- Rejected and permanently failed payouts release held chips once.
- Unauthorized CRM users cannot view the ledger, approve payouts or change
  payment settings.
- Bank details remain encrypted in MongoDB and masked in API/UI output.

Enable flags one at a time after review. Start with real-money readiness and
deposits in sandbox, then production deposits, then manual withdrawals. Enable
automatic withdrawals last and only after payout-webhook certification.

## Rollback

Disable the relevant feature switch. Disabling a switch stops new mutations but
must not delete orders, ledger entries, bank tokens, webhook events or audit
records. Provider-submitted payouts continue to be reconciled to a terminal
state; turning automatic mode off must not falsely cancel them.
