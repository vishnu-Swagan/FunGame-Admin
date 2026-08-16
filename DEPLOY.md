# Deploying Chakri.Casino

## Supabase Edge Functions

The production Supabase function surface contains exactly two entry points:
`admin-api` and `game-api`. The one-time Mongo importer is decommissioned and
retained for audit only under
`archive/decommissioned-supabase-functions/migration-import`; it must never be
copied back under `supabase/functions`.

Run the source-surface guard, then use the scoped deploy helper. Do not use an
unscoped `supabase functions deploy` command.

```sh
./supabase/scripts/check-live-function-surface.sh
./supabase/scripts/deploy-live-functions.sh --project-ref otlhseyofakjiridxthb
```

The helper expands to these two explicit deployments and nothing else:

```sh
supabase functions deploy admin-api --project-ref otlhseyofakjiridxthb
supabase functions deploy game-api --project-ref otlhseyofakjiridxthb
```

Two Render services, and they are **not** interchangeable in how they behave.

| Service | Type | What it serves |
|---|---|---|
| `chakri-casino-api` | Docker | FastAPI backend — the RNG, settlement and the chip ledger |
| `chakri-casino` | Static | The React app |

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
* Live player and administrator identities — provision them through the MyDGP
  control plane only. Application startup never creates a login account.
* `com.onrender.fungame_web.twa` in `assetlinks.json` — the published Android
  package. Installed apps keep it; dropping the statement breaks the Digital
  Asset Link and puts a browser address bar over the app.
* The `fun-roulette` / `fun-target` game slugs — stored on every historical bet
  and round.
