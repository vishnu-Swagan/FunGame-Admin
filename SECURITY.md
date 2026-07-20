# FunGame — Security & Anti-Abuse

## The honest threat model

The Android app is a **TWA (Trusted Web Activity)** — a thin shell that opens
`https://fungame-web.onrender.com` in Chrome. There is **no game logic inside the
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
| **CORS locked** to `https://fungame-web.onrender.com` | `render.yaml` / `server.py` | A copied frontend on another domain can't call your backend from a browser |
| **Production mode** (`APP_ENV=production`) | `render.yaml` | Verification/reset codes are **never** returned in API responses (`dev_code` killed) |
| **Rate limiting** (per-IP) on auth endpoints | `backend/security.py` | Brute-force / abuse throttled (login 8/5min, resets 5/15min, etc.) |
| **Security headers** | `security.py` + static `render.yaml` headers | `nosniff`, `X-Frame-Options: DENY` (anti-clickjacking/embedding), Referrer-Policy, Permissions-Policy |
| **Server-authoritative games** | `game_engines.py`, `live_engines.py` | Outcomes/balances decided server-side — can't be forged client-side |
| **Single active session per login** | `routes_auth.py` | A login elsewhere invalidates the old token |
| **Admin-only password resets** | `POST /api/admin/users/{id}/reset-password` | No self-service email-code path to exploit; forces re-login |
| **Digital Asset Links** | `frontend/public/.well-known/assetlinks.json` | Binds the *verified* app to your domain; a repackaged APK with a different signing key won't validate |
| **JS obfuscation** (app code) | `frontend/craco.config.js` | App bundle is hard to read; vendor left intact |
| **Signed APK** | PWABuilder keystore | `~/Downloads/FunGame-apk/signing.keystore` — **keep safe**, required for updates |

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
   installed app), using the `.aab` in `~/Downloads/FunGame-apk/`.
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

## Recommended next hardening (optional)

- **Custom domain** instead of `*.onrender.com` (cleaner asset-links, harder to
  squat, and lets you move hosts without re-signing the APK).
- **Real email provider** (Resend) if you ever want self-service resets back.
- **WAF / Cloudflare** in front for bot filtering + DDoS.
- **Paid Render tier** so the backend doesn't sleep (also removes the cold-start
  window an attacker could probe during).
