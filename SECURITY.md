# Chakri.Casino — Security & Anti-Abuse

## Financial feature status

The repository includes a provider-neutral deposit, cash/bonus wallet and
withdrawal scaffold, but it is **disabled by default**. No production gateway is
fabricated or enabled. `REAL_MONEY_ENABLED`, `DEPOSITS_ENABLED`,
`WITHDRAWALS_ENABLED`, `AUTO_WITHDRAWALS_ENABLED` and
`FINANCIAL_GAME_WALLET_INTEGRATED` must remain false until the provider and
game-ledger launch gates in
[`docs/PAYMENT-GATEWAY-INTEGRATION.md`](docs/PAYMENT-GATEWAY-INTEGRATION.md)
have been certified.

The canonical operator console is `https://crm.chakri.casino`. Financial pages
use explicit permissions and default-deny access; changing withdrawal mode also
requires a designated Super Admin with recent password re-authentication and
2FA. Legacy chip balances are treated as promotional and nonwithdrawable.
Administrator financial roles are provisioned only through the reviewed
control-plane procedure documented in
[`docs/PAYMENT-GATEWAY-INTEGRATION.md`](docs/PAYMENT-GATEWAY-INTEGRATION.md);
there is no public role-grant endpoint.
Responsible-play configuration changes and self-exclusion overrides require the
canonical `COMPLIANCE_ADMIN` grant plus recent password re-authentication and
2FA. Each change and its immutable audit event commit in one transaction.

## The honest threat model

The Android app is a **TWA (Trusted Web Activity)** — a thin shell that opens
`https://chakri.casino` in Chrome. There is **no game logic inside the
APK**; the crown jewels (game engines, RNG, chip balances, admin logic) run
**server-side** and never reach the client.

Therefore:

- **You cannot make an APK uncrackable.** Any Android app can be decompiled. The
  APK only reveals the URL — nothing sensitive.
- **The frontend JS is public** (served over the web). Obfuscation raises effort
  to read it; it does not prevent copying. This is inherent to all web apps.
- **Real protection = protecting the backend and enforcing app/domain identity.**

## What is implemented

| Protection | Where | Effect |
|---|---|---|
| **CORS allow-list** for Chakri player and CRM origins | `render.yaml` / `server.py` | A copied frontend on another domain can't call the authenticated backend from a browser |
| **Production mode** (`APP_ENV=production`) | `render.yaml` | Verification/reset codes are **never** returned in API responses (`dev_code` killed) |
| **Persistent rate limiting** on sensitive auth flows | `backend/security.py`, `backend/otp_service.py` | Login, registration, OTP issue/resend/verify and reset abuse is throttled across workers |
| **Security headers** | `security.py` + static `render.yaml` headers | `nosniff`, `X-Frame-Options: DENY` (anti-clickjacking/embedding), Referrer-Policy, Permissions-Policy |
| **Server-authoritative games** | `game_engines.py`, `live_engines.py` | Outcomes/balances decided server-side — can't be forged client-side |
| **Single active session per login** | `routes_auth.py` | A login elsewhere invalidates the old token |
| **Purpose-bound OTP verification** | `backend/otp_service.py`, `backend/routes_auth.py` | Email/phone registration and password-reset challenges expire, limit attempts and cannot be reused for another purpose |
| **Fail-closed OTP capabilities** | `backend/routes_auth.py`, auth UI | Registration channels are offered only when their global provider configuration is ready; production mock delivery is rejected |
| **Account lock and opaque auth errors** | `backend/routes_auth.py` | Unknown accounts pay the same bcrypt cost, repeated failures lock known accounts, and OTP/account state is not exposed publicly |
| **Financial feature gates** | `backend/financial_wallet.py`, hosting environment | Provider, deposits, withdrawals, auto-payout and gameplay-wallet integration fail closed independently |
| **Encrypted payout details** | `backend/financial_wallet.py` | Raw bank details use authenticated encryption at rest and routine responses expose masked values only |
| **Signed, replay-protected webhooks** | `backend/payment_providers.py`, `backend/financial_wallet.py` | Raw-body signatures, timestamps, unique event IDs and idempotent state transitions prevent browser or duplicate credits |
| **Digital Asset Links** | `frontend/public/.well-known/assetlinks.json` | Binds the *verified* app to your domain; a repackaged APK with a different signing key won't validate |
| **JS obfuscation** (app code) | `frontend/craco.config.js` | App bundle is hard to read; vendor left intact |
| **Signed APK** | PWABuilder keystore | `~/Downloads/Chakri.Casino-apk/signing.keystore` — **keep safe**, required for updates |

## Applying the backend changes on Render

The `render.yaml` env changes (`CORS_ORIGINS`, `APP_ENV`) take effect when the
blueprint is **synced**: Render Dashboard → Blueprints → your blueprint → review &
**Apply**. The backend service then redeploys with the new env. A `git push`
redeploys the code; the env-var values come from the blueprint sync.

## Play Integrity API — why it's not bolted on yet

Play Integrity proves a request comes from a **genuine, unmodified app installed
from Google Play**. It requires a **native** Android call to mint an integrity
token — **a TWA cannot do this** (it has no native hook to attach tokens to the
web app's API calls). So Play Integrity is **not compatible with the current TWA**.

To actually get it, you would:

1. **Replace the TWA with a native shell** — e.g. **Capacitor** wrapping the same
   web app, plus a Play Integrity plugin. (Capacitor gives you a JS→native bridge
   the TWA lacks.)
2. **Distribute via Google Play** (Integrity's strong verdicts require the Play-
   installed app), using the `.aab` in `~/Downloads/Chakri.Casino-apk/`.
3. **Google Cloud**: create a project, link it to the Play Console app, enable the
   Play Integrity API, create a service account with the Integrity role.
4. **Backend**: set `PLAY_INTEGRITY_ENABLED=true`, `PLAY_INTEGRITY_PACKAGE`, and
   `GOOGLE_APPLICATION_CREDENTIALS`; implement the verdict check in
   `backend/routes_security.py` (`POST /api/security/integrity`, scaffolded).
5. **Client**: on sensitive actions, fetch an integrity token natively and POST it;
   the backend rejects the action unless the verdict is `PLAY_RECOGNIZED` +
   `MEETS_DEVICE_INTEGRITY` and the nonce matches the session.

The backend endpoint already exists and returns `501` until enabled, so the wiring
is ready when you move to a native client.

## Required before financial production activation

- Run MongoDB as a replica set and verify multi-document transactions against
  the production topology. Do not use a nontransaction fallback in production.
- Configure a real email and SMS provider; development OTP mocks are rejected in
  production.
- Put OTP delivery on a durable queue/outbox (or otherwise equalize public
  response work) before enabling providers; synchronous provider latency can
  otherwise become a contact-existence timing signal even with opaque bodies.
- Complete the source-attributed game-wallet integration so cash and promotional
  chips reconcile through every stake, prize and refund.
- Certify or replace every legacy BUY/SELL/RETURN and points-conversion path;
  these mutations are blocked while real-money mode is on.
- Add a production-grade administrator step-up/2FA ceremony and recovery policy.
- Add the approved provider's audited beneficiary/token handoff before enabling
  manual or automatic withdrawals; routine CRM responses remain masked.
- Complete provider sandbox certification, webhook reconciliation tests, KYC,
  jurisdiction and risk-control reviews.
- Store `JWT_SECRET`, OTP pepper, bank-encryption key and provider credentials in
  the hosting secret manager and establish rotation/recovery procedures.

## Recommended next hardening

- **Custom domain** instead of `*.onrender.com` (cleaner asset-links, harder to
  squat, and lets you move hosts without re-signing the APK).
- **Real email provider** (Resend) if you ever want self-service resets back.
- **WAF / Cloudflare** in front for bot filtering + DDoS.
- **Paid Render tier** so the backend doesn't sleep (also removes the cold-start
  window an attacker could probe during).
