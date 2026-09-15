# SGPay24 deposit and payout setup — 2026-09-16

Scope: make the existing SGPay24 hosted deposit and administrator-approved payout
flows match this merchant's current documented API. Do not enable a second
financial rail, remove verification/approval controls, issue test charges or
payouts, rewrite balances, or recreate historical payment orders.

## Success criteria

- Deposits use the configured active merchant and the documented JSON contract;
  configuration/provider failures are identified without disclosing credentials.
- Payout creation, reference tracking, and status reconciliation use distinct
  merchant order and provider payout identifiers, with safe ambiguous retries.
- Deposit and payout callbacks reconcile only bound existing orders through
  authenticated provider status, and sensitive admin actions retain approvals.
- Mocked regression tests and security reviews pass; deployed configuration and
  code are verified without a real-money transaction.

## Work plan

- [x] Inspect the authenticated merchant profile and current pay-in/payout docs.
- [x] Inspect the current Chakri gateway view and implementation contracts.
- [x] Diagnose current deposit connectivity using a known existing order and
      redacted runtime checks; correct only an evidenced defect.
- [x] Correct payout transport, reference binding, submission/retry safety, and
      payout callback handling with regression tests.
- [x] Align admin permissions and exact-action step-up UI retry handling.
- [ ] Run the Codex uncommitted-change review and separate payment/security
      review, full tests, and mocked browser workflow checks.
- [ ] Deploy the reviewed change using the existing services and configure only
      supported callback settings. Preserve the existing environment and rail.
- [ ] Verify deployment, callback configuration, and public/runtime readiness;
      identify any remaining provider-side blocker or required user test.

## Observed merchant contract

Merchant profile reports the account, Paying, and Payout as active. The pay-in
callback is already `https://api.chakri.casino/api/payments/webhooks/sgpay24`.
The payout callback field is blank. This is not authorization to send money.

- Pay-in creation: `POST https://root.sgpay24.com/api/createPayingRequest`, JSON
  with `merchant_id`, `api_token`, `order_id`, `amount`, `name`, `email`, `phone`,
  `redirect_url`, and `remark`. Phone must have ten Indian mobile digits.
- Pay-in status: `POST /api/check-status`, JSON with merchant/order/token.
- Payout creation: `POST /api/createPayoutRequest`, JSON with `mid`, `api_token`,
  `order_id`, `amount`, `account`, `ifsc_no`, `bank_name`, `benifeciryname`,
  `email`, `phone`, `redirect_url`, and optional `remark`.
- Payout creation returns `data.payout_id` separately from `data.order_id`.
- Payout status: `POST /api/check-payout-status`, JSON with `order_id`,
  `merchant_id`, and `api_token`. The documented response includes merchant,
  order, status/type, UTR, and redirect URL, but does not promise amount/currency.
- Current payout docs explicitly support JSON callbacks containing merchant,
  payout ID, order ID, amount, status, UTR, and timestamps. Unsigned callbacks
  must never be accepted as evidence that a transfer occurred.

Source pages were read through the signed-in merchant's Chrome session:
`/merchant/profile`, `/merchant/payindocs`, and `/merchant/payoutdocs`.
No credential values belong in this document or test fixtures.

## Runtime evidence and remaining boundary

A status-only authenticated query of a known completed ₹5,000 order returned
PAID with the expected amount. Merchant credentials, existing-order lookup, and
both hosted/operator intake switches are valid. Recent unsuccessful checkout
rows have valid customer details but only a generic ProviderRequestError; their
exact rejection cannot be reconstructed. New failures now persist only fixed
diagnostic categories and an HTTP status, never raw provider responses.

The signed-in merchant Profile shows no editable payout callback field. The
endpoint must be deployed before requesting SGPay24 support to configure it.
Status polling remains supported without this optional notification.

No live checkout was created, payout submitted, wallet adjusted, historical
order recreated, or verification requirement removed during diagnostics.
