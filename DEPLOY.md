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

Production registration also remains intentionally closed while
`OTP_EMAIL_ADAPTER` and `OTP_SMS_ADAPTER` are disabled. Configure at least one
real delivery adapter, its provider credentials, `OTP_PEPPER` and
`OTP_EXPOSE_DEV_CODE=false` before advertising self-service sign-up. The public
app reads `/api/auth/capabilities` and disables unavailable channels instead of
claiming that a code was sent.

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
