# SgPay24 hosted UPI runbook

This is a deposit-only hosted checkout for buying chips. It does not enable the
financial-wallet or payout system. Keep all of these source-controlled flags
`false`:

> **Two deposit rails, one provider.** SgPay24 UPI credits chips through the
> **hosted-UPI rail** (`operator_rail`), gated only by `UPI_CHIP_PURCHASES_ENABLED`
> + `PAYMENT_PROVIDER=sgpay24`. It does **not** require `REAL_MONEY_ENABLED`,
> `DEPOSITS_ENABLED`, `PAYMENTS_V2_ENABLED` or `PAYMENT_LIVE_MODE_ALLOWED`; the
> webhook `POST /api/payments/webhooks/sgpay24` and the reconciliation worker
> stay live independently of those flags. The separate **financial-wallet rail**
> (`REAL_MONEY_ENABLED` etc.) is a different system; `GAME_WALLET_INTEGRATION_READY`
> is now certified `True` so enabling that rail no longer 503s `/api/health`, but
> it is **not** needed to take SgPay24 UPI deposits. Prefer the hosted-UPI rail.


- `REAL_MONEY_ENABLED`
- `DEPOSITS_ENABLED`
- `WITHDRAWALS_ENABLED`
- `AUTO_WITHDRAWALS_ENABLED`
- `FINANCIAL_GAME_WALLET_INTEGRATED`
- `PAYMENTS_V2_ENABLED`
- `PAYMENT_LIVE_MODE_ALLOWED`

`UPI_CHIP_PURCHASES_ENABLED` is the separate new-checkout intake gate for this
rail. It must also remain `false` until the review, mock tests and explicit
canary approval below are complete. Turning intake off must not stop
reconciliation of orders that already exist.

## Render configuration

Configure the API service, never the static frontend:

| Variable | Value and handling |
| --- | --- |
| `PAYMENT_PROVIDER` | `sgpay24`; non-secret, but dashboard-managed so a Blueprint sync cannot switch the live provider accidentally. |
| `PAYMENT_RETURN_URL` | `https://chakri.casino/chips/deposit/return`; non-secret, fixed HTTPS return path. |
| `SGPAY24_MERCHANT_ID` | Merchant ID copied from the authenticated SgPay24 profile; Render secret/dashboard only. |
| `SGPAY24_API_TOKEN` | API token copied from the authenticated SgPay24 profile; Render secret/dashboard only. |
| `SGPAY24_CUSTOMER_EMAIL_FALLBACK` | A monitored operational mailbox used only when a player has no verified email. |
| `SGPAY24_TIMEOUT_SECONDS` | `15` unless a reviewed provider SLA requires a change. |
| `UPI_CHIPS_PER_INR` | Explicit, operator-reviewed integer conversion rate. Each order must snapshot this value. |
| `UPI_MAX_DAILY_DEPOSIT_PAISE` | Explicit per-player daily cap in paise. Use `50000` (₹500) for the one-payment canary; raising it needs a separate limit/compliance review. |
| `UPI_CHIP_PURCHASES_ENABLED` | `false` during deploy and mock validation. |

Never paste the merchant ID or token into Git, screenshots, tickets, browser
code, logs, test fixtures, or chat. Render must mask the two credential values.
Rotate the token before proceeding if it has appeared anywhere outside the
provider profile and Render secret store. Restrict Render secret access to the
smallest operator group and record credential changes in the deployment log.

The hosted rail requires its own `UPI_CHIPS_PER_INR`; the general
`CHIPS_PER_INR` setting does not change it. Verify the commercial rate before
the canary and confirm that the order stores the same rate snapshot.

For the initial production configuration, set `PAYMENT_PROVIDER=sgpay24`,
`PAYMENT_RETURN_URL=https://chakri.casino/chips/deposit/return`,
`SGPAY24_TIMEOUT_SECONDS=15`, `FINANCIAL_ALLOWED_COUNTRIES=IN`, and
`UPI_MAX_DAILY_DEPOSIT_PAISE=50000`. Set `UPI_CHIPS_PER_INR` to the explicitly
approved commercial rate (use `1` only if one chip per INR is the approved
price). Supply the real merchant ID and API token only through Render secrets.
Keep `UPI_CHIP_PURCHASES_ENABLED=false` until the canary confirmation.

## QR, player UTR, callback and polling

The payment QR or hosted payment page must come from the authenticated SgPay24
order response and remain bound to the signed-in player's local order. Do not
construct a QR from a merchant UPI address in frontend code and do not accept a
client-supplied amount, payee or order identity.

A UTR entered by the player is an untrusted claim, not settlement evidence. Bind
the submission to the authenticated player's order, normalize and validate its
documented format, rate-limit attempts, and store only the minimum audit data.
The player client submits `{ "utr": "..." }` to
`POST /api/payments/deposits/{deposit_id}/utr`; this endpoint must never accept a
user ID, amount, merchant ID or provider order ID from the client.
The submitted UTR may trigger an authenticated status lookup, but chips can be
credited only when SgPay24 returns `PAID` for the same merchant/order/amount and
returns exactly that UTR. A UTR already bound to another order must be rejected
and sent to reconciliation; it must never credit two orders.

If the SgPay24 merchant console supports a server callback, register exactly:

`POST https://api.chakri.casino/api/payments/webhooks/sgpay24`

The browser return URL is not proof of payment. The callback is also treated as
an untrusted notification because the current provider contract does not define
a verifiable callback signature. Before crediting chips, the backend must query
SgPay24's authenticated status endpoint and match the stored order, terminal
status, amount, INR currency and payment reference.

Polling is the required fallback and remains active even if callbacks are
configured. The leader worker checks due pending orders with the server-held
token. The return screen can request a bounded refresh with
`POST /api/payments/deposits/{deposit_id}/refresh`. A timeout, malformed reply,
unknown status, mismatch, or absent immutable payment reference must credit no
chips. Continue polling with backoff or send the order to reconciliation; never
approve a hosted UPI row through the legacy admin-review endpoint.

## Mocked validation (no provider traffic)

Use syntactically valid fake credentials and replace the provider HTTP method
with deterministic fixtures. Tests must make no request to `root.sgpay24.com`.

1. Confirm the feature gate is off by default and malformed/missing credentials
   make hosted checkout unavailable without exposing their values.
2. Verify the create request binds a unique order ID, exact paise amount,
   merchant, verified Indian mobile number, fixed return path and safe hosted
   checkout URL. Reject redirects to every other host or path.
3. Exercise `PENDING`, `FAILED` and `PAID` status fixtures. Numeric provider
   status must take precedence over any generic response `type` field.
4. For `PAID`, require the same order and amount, INR, and a valid immutable UTR.
   Credit the expected chips once; repeated callbacks, refreshes and worker
   polls must leave the balance and ledger unchanged.
5. Submit correct, wrong, duplicate, malformed and another player's UTR. The
   submission must never credit directly; only the matching authenticated
   provider result may credit the owning order once.
6. Exercise forged callbacks, amount/order/reference conflicts, timeouts,
   non-JSON and oversized bodies. They must never credit chips. A callback can
   only trigger the authenticated server-side status lookup.
7. Verify age/KYC, market, frozen-account, self-exclusion and deposit-limit
   gates apply to the hosted route. Verify an admin cannot approve or reject a
   hosted row as though it were an `ADMIN_REVIEW` request.
8. Run the focused backend payment tests and the broader backend regression
   suite. Keep the test logs secret-free and retain the passing commit SHA.

Do not enable the Render gate merely because unit tests pass. First deploy with
`UPI_CHIP_PURCHASES_ENABLED=false`, confirm `/api/health`, inspect startup index
results, and verify the buy-chips UI reports hosted UPI unavailable.

## One live canary — explicit confirmation required

Stop and obtain the user's explicit confirmation immediately before enabling
`UPI_CHIP_PURCHASES_ENABLED` or sending any real payment. Confirmation must name
the environment, amount, approved test player and operator observing the ledger.
No standing approval or earlier request to "test payments" is sufficient.

After confirmation, use one KYC/age/phone-verified, non-excluded test player and
the smallest amount permitted by both SgPay24 and the application (currently
₹500 in the application). Use a new idempotency key. Observe the hosted domain,
complete one UPI payment, and verify all of the following before allowing any
second transaction:

- SgPay24 shows the same merchant, order, paid amount and UTR.
- The application order reaches `CREDITED` only after authenticated lookup.
- The chip balance increases exactly once by the snapshotted conversion.
- One deposit ledger entry exists and duplicate callback/poll attempts add none.
- No credential, full provider payload or unnecessary customer data appears in
  application or Render logs.

Immediately set `UPI_CHIP_PURCHASES_ENABLED=false` to stop new intake if any
check differs. Preserve the order ID, sanitized response metadata and logs; do
not retry with another live payment until the discrepancy is understood. Keep
`PAYMENT_PROVIDER` and the SgPay24 credentials configured so the callback and
worker can continue authenticated reconciliation of every open obligation.
Confirm the only canary is terminal before removing or rotating credentials.
