# Fresh SKY-AMC LIMITED deployment

The player application and CRM use https://chakri.casino and https://chakri.casino/Admin, with same-origin API requests. The existing public Sites Worker forwards application routes and API requests to an authenticated Instabox HTTP gateway. The gateway credential is a Sites runtime secret and is never included in browser assets. User authorization is carried separately to Nginx and restored for the API.

## Services

- box1: existing seven-node controller and 10-minute activity timer; hourly database backup timer.
- box2: Nginx on port 8080, FastAPI on loopback port 8000, authenticated MongoDB 8 single-member replica set on loopback port 27017.
- box3: secondary backup copy. box1 also retains backups.
- Other nodes remain available for development and background jobs. Their RAM is separate.

The database is fresh: no old accounts, balances, financial records or provider credentials were imported. The installation has one new super administrator and seeded game/configuration records. Passwords, MongoDB credentials, JWT keys and OTP peppers were newly generated and stored outside this repository.

MongoDB data lives at /data/chakri/mongodb. The API user service is chakri-api.service. Database dumps run hourly while the controller and database nodes are active, retaining the latest 24 successful archives on the controller and backup node. An initial dump was restored into a separate scratch database and collection counts matched across 83 collections; the scratch database was then removed.

## Public build environment

Set REACT_APP_BACKEND_URL=https://chakri.casino, REACT_APP_LEGAL_STATUS=DRAFT, and the supplied SKY-AMC operator identity values before building frontend. Production API defaults for both the player app and CRM use the same origin.

Set GAME_ART_BASE_URL=https://chakri.casino/game-art in the API runtime environment. Private runtime secrets are supplied separately; never commit API environment files, gateway tokens, SSH configuration or database archives.

## Functional limits

Registration uses ADMIN_REVIEW and requires explicit administrator approval. No SMS or email delivery provider is configured. Deposits, withdrawals and real-money transaction gates remain disabled; this deployment is not accepting real-money payments. Administrator MFA should be configured after the first login. Existing policy wording requires operator review for the new company.

Ten-minute activity checks do not override provider runtime caps or guarantee uptime. The free machines and hourly backups are not a promise of continuous production availability. The seven machines do not expose a single pooled-memory process.

## Validation

- Player/CRM frontend production build and 20 routing/API-safety tests passed.
- Public Sites production build and 24 rendering/private-gateway tests passed.
- Fresh MongoDB transaction probe passed.
- API health reports gameplay_ready and crm_ready true; financial_ready false.
- Fresh administrator login and authenticated CRM dashboard, games and users endpoints passed, including the public-domain proxy.
- Existing Render and Atlas services and data were left untouched.

## Embedded game follow-up

The separately built Aviator micro-app is pinned to https://chakri.casino, matching every other player game and the CRM. Its runtime isolation tests cover production, staging and localhost. Promotional artwork uses bundled assets rather than a Render fallback. GAME_ART_BASE_URL also defaults to the branded origin in source.

A zero-balance QA player was created through the administrator API for migration checks. All 11 available game detail endpoints succeeded over the public domain; the other 12 returned the expected coming-soon response. No deposits, withdrawals or funded bets were made during these checks.
