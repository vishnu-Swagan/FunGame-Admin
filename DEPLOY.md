# Deploying Chakri.Casino

Two Render services, and they are **not** interchangeable in how they behave.

| Service | Type | What it serves |
|---|---|---|
| `chakri-casino-api` | Docker | FastAPI backend — the RNG, settlement and the chip ledger |
| `chakri-casino` | Static | The React app |

The same static build serves the operator UI only on the canonical CRM host:
`https://crm.chakri.casino`. Keep `REACT_APP_ADMIN_CONSOLE_HOSTS` restricted to
that hostname.

## Payment deployment boundary

The payment code is a dormant integration scaffold, not authorization to accept
or pay real money. Keep all of these values false during ordinary deployment:

```dotenv
REAL_MONEY_ENABLED=false
DEPOSITS_ENABLED=false
WITHDRAWALS_ENABLED=false
AUTO_WITHDRAWALS_ENABLED=false
FINANCIAL_GAME_WALLET_INTEGRATED=false
```

Do not add a production provider name or credentials until provider approval and
the full runbook in `docs/PAYMENT-GATEWAY-INTEGRATION.md` is complete. A browser
return must never credit chips; only a verified provider event or authenticated
reconciliation may do so.

Temporary administrator-reviewed registration accepts both contacts without
sending an email/SMS code. It creates a zero-chip `PENDING` application whose
contacts stay provisional until the operator selects **Verify & approve**:

```dotenv
REGISTRATION_MODE=ADMIN_REVIEW
OTP_EMAIL_ADAPTER=disabled
OTP_SMS_ADAPTER=disabled
OTP_EXPOSE_DEV_CODE=false
```

Keep a unique `OTP_PEPPER` in Render even while delivery is disabled: password
login rate limits use it. Approval atomically claims the submitted contacts,
records the operator decision, activates gameplay, and grants the existing
welcome play-chip bonus. Restore contact OTP later by switching
`REGISTRATION_MODE=PHONE_OTP` only after the SMS adapter and credentials are
configured and tested. For Telesign SMS Verify, store `TELESIGN_CUSTOMER_ID`
and `TELESIGN_API_KEY` as Render secrets, set `OTP_SMS_ADAPTER=telesign`, keep
`OTP_EXPOSE_DEV_CODE=false`, and prove delivery to an approved test number
before changing the registration mode. Trial accounts can send only to verified
test numbers; upgrade the Telesign account before accepting live customers.
Administrator MFA is separate and is not changed here.

The same Telesign credentials can expose the subscribed trust products, but
each API call can still consume account balance. Roll them out independently:

```dotenv
TELESIGN_PLAN=self-service
TELESIGN_INTELLIGENCE_MODE=observe
TELESIGN_PHONE_ID_MODE=observe
TELESIGN_CONTACT_ADDON_ENABLED=true
TELESIGN_VERIFY_PLUS_ENABLED=true
TELESIGN_ENGAGEMENT_SMS_ENABLED=false
```

Start Intelligence and Phone ID in `observe`, review the Admin risk evidence,
then use `enforce` only after the operator has approved the false-positive and
provider-outage behavior. Verify Plus is activated and thresholded in My
Telesign; once declared true here, SMS Verify onboarding does not make a second
paid Intelligence request. The Contact add-on response is intentionally reduced
to completion status and standard phone metadata: provider-returned names,
addresses and email addresses are never stored. Generic engagement SMS remains
off until an approved sender, India DLT template and customer-consent workflow
exist.

## The failure mode to know about

A Docker service that does not deploy **keeps answering normally on its old
build**. Nothing looks broken: health checks pass, the app loads, most of the
game works. Only the parts that depend on the new code fail, and they fail in
ways that look like frontend bugs.

That is exactly what happened with the double zero. The client posted a bet on
`00`, the old backend had no concept of a double zero, and the bet was refused —
which read as "the button doesn't work".

## Checking which build is live

```
curl https://chakri-casino-api.onrender.com/api/
```

```json
{"message":"Chakri.Casino API","disclaimer":"PLAY CHIPS ONLY","build":{"roulette_pockets":38}}
```

* `"roulette_pockets": 38` — the American wheel is live. 0 and 00 both bettable.
* `"roulette_pockets": 37` — the API is on a pre-changeover build. 00 cannot work
  and no frontend change will make it, because the wheel never draws one.
* **no `build` key at all** — older still.

Check this after every backend deploy. It needs no login.

## Order when renaming a service

A service's `.onrender.com` URL follows its name, so renaming breaks the old URL
immediately. The client carries both API hosts and fails over on a dead host
(see `frontend/src/lib/api.js`), and the API allows both web origins, so the
order below has no broken window:

1. Deploy the current commit to **both** services first.
2. Rename the static site in the dashboard → `chakri-casino`.
3. Rename the API in the dashboard → `chakri-casino-api`.
4. Redeploy the static site so `REACT_APP_BACKEND_URL` points straight at the
   new API instead of relying on failover.

`render.yaml` already carries the new names; Render matches Blueprint services by
name, so rename in the dashboard rather than expecting the file to do it.

## Never rename

* `DB_NAME` (`fungame`) — the live MongoDB database. Every user, balance, bet and
  round is in it.
* `admin@fungame.app` / `player@fungame.app` — real rows. `seed` only inserts when
  a row is absent, so renaming creates a second empty pair you cannot sign in to.
* `com.onrender.fungame_web.twa` in `assetlinks.json` — the published Android
  package. Installed apps keep it; dropping the statement breaks the Digital
  Asset Link and puts a browser address bar over the app.
* The `fun-roulette` / `fun-target` game slugs — stored on every historical bet
  and round.
