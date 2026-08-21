# Chakri.Casino staging and production launch checklist

Product: Chakri.Casino player web app, operator CRM, ten reviewed play-chip games, and an installable PWA.

Detected stack: React 19 with CRACO as a Render static frontend, FastAPI on Python 3.11 as a Render Docker web service, and MongoDB as the authoritative user, game, and chip ledger.

Deployment decision: **Case D — production-only today.** Render watches <code>main</code> with automatic deployment, but there is no staging service, branch preview, staging database, or staging deployment workflow that can be proven.

Recommended path: create an isolated manual staging stack inside the existing Render workspace, validate one release branch there, and only then promote the same reviewed commit to production. Do not use the production MongoDB database for staging.

Estimated time: **8–12 hours of hands-on work**, normally spread across one or two working days. DNS and email-domain verification can add up to 24 hours without requiring continuous work.

Expected incremental cost:

- Staging player and CRM static sites: **$0/month** on Render, subject to workspace build and bandwidth limits.
- Staging API web service: **$0/month** on Render Free, subject to shared free-instance hours, cold starts, bandwidth, and build-minute limits. It is a test target, not a reliable production tier.
- Staging MongoDB: **Atlas M0 at $0/month** if available and within its limits; recommended fallback **Atlas Flex at approximately $8–30/month**, depending on usage.
- Production night cron: at least **$1/month plus run time**. Render does not support <code>plan: free</code> for cron jobs, so the current Blueprint declaration is invalid.
- Production phone OTP: Twilio SMS is usage-priced. Confirm current India destination, carrier, sender-registration, and tax charges in the Twilio console before enabling it.
- Existing production Render, Hostinger, domain, and database charges are not included because their current account plans are not recorded in the repository.

Legend:

- 🧑 **You** — requires your account, billing authority, identity, provider approval, or a business decision.
- 🤖 **Agent** — a coding agent can execute this safely after you paste the supplied prompt.
- 🤝 **Together** — the agent prepares or verifies the work; you approve or click the final external action.

> **Secret-handling rule:** never paste passwords, database connection strings, API keys, OTP peppers, JWT secrets, payment credentials, or recovery codes into chat, source control, screenshots, or tickets. Enter them directly in the provider or hosting dashboard's secret field. An agent may tell you the variable name and validate that it exists, but must never ask for or print its value.

## Verified architecture and boundaries

| Surface | Verified current state | Launch boundary |
| --- | --- | --- |
| GitHub | Public repository, default branch <code>main</code>, no Actions workflow, no branch protection | A push to <code>main</code> has no GitHub release gate |
| Render API | Production deployment is <code>fungame-api.onrender.com</code>; <code>api.chakri.casino</code> points to it | Do not rename or replace it during staging |
| Render player app | Production deployment is <code>fungame-web.onrender.com</code> | Create a separate staging static site with no production domains |
| Public apex | <code>chakri.casino</code> serves a separate Next-based marketing site | Do not upload the React game build here |
| Operator CRM | <code>crm.chakri.casino</code> is hosted by Hostinger | Validate an isolated Render CRM build before any Hostinger upload |
| Intended play host | <code>play.chakri.casino</code> currently has no DNS record | Connect it only after production promotion is approved |
| Database | FastAPI uses Motor/MongoDB and production <code>DB_NAME=fungame</code> | Staging must use a separate cluster or database and credentials |
| Supabase | Two visible projects are named Production; this repo is not linked to either | Do not use either as an improvised staging target |
| Payments | All five financial switches are off and the provider integration is fail-closed | Keep real-money deposit and withdrawal unavailable |
| Cron | Blueprint declares a free cron plan and a hostname that is not the live API | Keep staging cron disabled; repair and price production cron separately |

## Current account-access mode — administrator review

The temporary production mode is <code>REGISTRATION_MODE=ADMIN_REVIEW</code>. Registration requires full name, recognized country, valid adult date of birth, accepted terms, a unique valid email, a unique E.164 mobile number, and a confirmed password. It creates one zero-chip <code>PENDING</code> player with immutable CRM attribution. No verification code is generated or claimed; <code>email_verified</code>, <code>phone_verified</code>, and <code>contact_verified</code> remain false. A correct password still cannot create a session until an administrator explicitly approves the account. Approval is recorded as <code>contact_verification_status=ADMIN_APPROVED</code> without pretending that either contact was OTP-verified.

- [ ] 🤖 **Validate the administrator-review registration boundary** — 20 minutes. Confirm both normalized contact guards, password hashing, eligibility and terms checks, generic collision responses, zero starting chips, exact CRM attribution, pending-login refusal, and explicit atomic admin approval. Cost: **$0**.

  > Prompt: “Test ADMIN_REVIEW registration with controlled identities. Verify no OTP challenge, delivery call, dev code or pre-approval session is created; wrong credentials remain generic; correct credentials return ACCOUNT_PENDING_REVIEW; both contact flags stay false after approval; approved_by/manual review fields identify the operator; and only the approved account can log in and reach gameplay. Do not enable deposits or withdrawals.”

  **You'll know it worked when:** capabilities advertise <code>registration_mode=ADMIN_REVIEW</code> and <code>verification_required=false</code>, the complete application appears once in the Render-backed operator user queue, and only an explicit approval changes it to <code>ACTIVE</code>.

- [ ] 🤝 **Inventory historical activation modes before launch** — 15 minutes. Existing phone-OTP and deferred rows are not rewritten or silently treated as administrator-reviewed. Count and plan their migration separately. Cost: **$0**.

## Phase 0 — stop accidental production changes

- [ ] 🧑 **Pause Render Blueprint Auto Sync** — 5 minutes. In the Render Dashboard, select the existing workspace, open **Blueprints**, choose the Chakri/FunGame Blueprint, open **Settings**, and switch **Auto Sync** off. Do not delete any service. Cost: **$0**.

  **You'll know it worked when:** the Blueprint page shows manual synchronization and a GitHub push no longer has permission to rewrite production service configuration automatically.

- [ ] 🤖 **Record a non-secret production inventory** — 15 minutes. This creates an evidence report only; it must not alter hosting or files.

  > Prompt: “Work read-only in the Chakri.Casino repository. Record the GitHub default branch and remote commit, Render service names and public URLs, current health/build fingerprints, frontend host split, database variable names without values, and whether each financial flag is enabled. Do not print secrets, edit files, commit, push, deploy, or call a mutating admin endpoint. Return a timestamped inventory and identify every repo-versus-dashboard mismatch.”

  **You'll know it worked when:** the report names the exact production commit and services without exposing a credential or changing a deployment.

- [ ] 🧑 **Rotate or revoke the removed Tenor API key at the provider** — 10 minutes. In Google Cloud Console, select the project that owned the Tenor key, go to **APIs & Services → Credentials**, open the old key, and choose **Rotate key**; if GIF search is no longer used, choose **Delete** instead. Confirm the new key's API restriction is Tenor API before saving. Do not send the key to an agent. Cost: **$0**.

  **You'll know it worked when:** the previous key is deleted or appears only as the temporary previous key awaiting deletion, Tenor metrics show no unexplained traffic, and no key is present in the repository.

- [ ] 🤖 **Audit the repository and Git history for the retired key** — 20 minutes.

  > Prompt: “Run a read-only secret audit of the Chakri.Casino working tree and reachable Git history for Tenor, Google API key, generic credential, private-key, database-URI, and token patterns. Never print a full candidate secret: show only file path, commit ID, secret type, and a redacted fingerprint. Confirm whether the removed Tenor key remains reachable. Do not rewrite history, edit files, stage, commit, push, or contact a provider.”

  **You'll know it worked when:** the audit either reports no reachable credential or gives a precise, redacted remediation list that can be handled before any release.

- [ ] 🤖 **Prepare a safe production Blueprint correction without syncing it** — 30 minutes.

  > Prompt: “Audit render.yaml against the verified live services fungame-api and fungame-web, the separate apex marketing site, Hostinger CRM, and api.chakri.casino. Prepare a minimal patch for review that does not rename production services or DB_NAME, does not claim domains hosted elsewhere, keeps every real-money flag false, and fixes the cron declaration by removing it until approved or using a valid paid cron plan. The cron API target must be the verified production API. Validate the YAML locally. Do not sync Render, commit, push, deploy, or touch DNS.”

  **You'll know it worked when:** the proposed diff contains no production rename, no Hostinger or marketing-domain takeover, no <code>plan: free</code> cron, and passes Blueprint/YAML validation.

- [ ] 🧑 **Approve the production cron cost or leave it disabled** — 5 minutes. In Render, open the workspace menu → **Billing** to confirm a payment method and spend limit. Then open the proposed <code>chakri-casino-night</code> service settings. Choose a valid paid instance only after staging verifies the endpoint; otherwise leave the cron service uncreated or suspended. Cost: **minimum $1/month plus runtime** if enabled, **$0** if disabled.

  **You'll know it worked when:** there is a written decision stating either “cron disabled” or the approved plan, monthly ceiling, UTC schedule, API hostname, and owner.

## Phase 1 — create a clean release line and isolated database

- [ ] 🤝 **Create a clean staging release branch from GitHub <code>main</code>** — 20 minutes. Do not branch from the currently dirty local <code>main</code>. After the agent prepares and tests a clean worktree, review the file list; then approve only the push of <code>release/staging-2026-08-21</code>. In GitHub, open **FunGame-Admin → Code → Branches** to confirm it. Cost: **$0**.

  > Prompt: “Fetch GitHub main into a new clean worktree and create release/staging-2026-08-21 from the current remote main commit. Do not reset, clean, or overwrite the existing dirty worktree. Selectively apply only the reviewed Chakri.Casino release files, show me the exact diff and test results, and stop for explicit approval before commit and again before push. Never push main.”

  **You'll know it worked when:** GitHub shows the staging branch at the reviewed commit, production <code>main</code> is unchanged, and the original dirty worktree is intact.

- [ ] 🧑 **Create the staging MongoDB deployment** — 15–25 minutes. In MongoDB Atlas, use the organization/project selector → **New Project**, name it <code>Chakri Casino Staging</code>, open **Database → Build a Database**, and choose **M0 Free** in or near Singapore. If M0 limits are insufficient, choose **Flex** and set a billing alert before creating it. Name the deployment <code>chakri-staging</code>. Cost: **$0/month for M0** or approximately **$8–30/month for Flex usage**.

  **You'll know it worked when:** Atlas shows a healthy staging deployment in a project whose name clearly says Staging and it is not either Production project.

- [ ] 🧑 **Create staging-only database access** — 15 minutes. In the staging Atlas project, open **Security → Database Access → Add New Database User**, create a unique staging application user, and grant only read/write access to <code>chakri_staging</code>. Then open **Security → Network Access → Add IP Address** and add only the outbound ranges displayed under the staging Render API's **Connect** panel. Use Atlas **Database → Connect → Drivers → Python** to obtain the URI and paste it directly into Render later. Cost: **$0**.

  **You'll know it worked when:** the staging credential cannot access <code>fungame</code>, Atlas lists only the intended network ranges, and the URI has never appeared in chat or Git.

- [ ] 🤖 **Generate a non-secret staging configuration matrix** — 15 minutes.

  > Prompt: “From backend/.env.example, render.yaml, and frontend configuration, produce a staging variable matrix with variable name, owning service, secret/non-secret classification, safe staging value or value source, and validation check. Never read or print actual .env values. Require DB_NAME=chakri_staging, APP_ENV=production, the staging API origin for both staging frontends, disabled Supabase settlement, disabled OTP delivery unless configured, and all five financial flags false.”

  **You'll know it worked when:** every required variable has one owner and source, while every secret cell says “enter directly in Render” instead of containing a value.

## Phase 2 — build the manual Render staging stack

- [ ] 🧑 **Create the isolated staging API** — 20 minutes. In Render, stay in the existing workspace and choose **New + → Web Service**. Connect <code>vishnu-Swagan/FunGame-Admin</code>, select branch <code>release/staging-2026-08-21</code>, name it <code>chakri-casino-api-staging</code>, choose **Docker**, region **Singapore**, Dockerfile <code>./backend/Dockerfile</code>, Docker context <code>./backend</code>, and health check <code>/api/health</code>. Choose **Free** and turn **Auto-Deploy** off. Do not add a custom domain. Cost: **$0**, subject to free-service limits and cold starts.

  **You'll know it worked when:** the service URL contains <code>staging</code>, its branch is the release branch, Auto-Deploy is off, and no production domain appears under Custom Domains.

- [ ] 🧑 **Enter staging API environment variables directly in Render** — 20 minutes. Open the staging API → **Environment → Add Environment Variable**. Add <code>MONGO_URL</code> using the staging Atlas URI, <code>DB_NAME=chakri_staging</code>, <code>APP_ENV=production</code>, a unique <code>JWT_SECRET</code>, a different unique <code>OTP_PEPPER</code>, the reviewed <code>AVIATOR_RETURN_FACTOR</code>, and <code>CORS_ORIGINS</code> containing only the two staging static URLs after they exist. Set <code>OTP_EMAIL_ADAPTER=disabled</code>, <code>OTP_SMS_ADAPTER=disabled</code>, <code>OTP_EXPOSE_DEV_CODE=false</code>, <code>EMAIL_PROVIDER=disabled</code>, and <code>SUPABASE_GAME_SETTLEMENT_ENABLED=false</code>. Set all of these to <code>false</code>: <code>REAL_MONEY_ENABLED</code>, <code>DEPOSITS_ENABLED</code>, <code>WITHDRAWALS_ENABLED</code>, <code>AUTO_WITHDRAWALS_ENABLED</code>, and <code>FINANCIAL_GAME_WALLET_INTEGRATED</code>. Generate secrets locally and paste them only into Render. Cost: **$0**.

  **You'll know it worked when:** Render marks secret values as hidden, the database name says staging, the health endpoint can start without exposing configuration details, and every money switch visibly reads <code>false</code>.

- [ ] 🧑 **Create the staging player static site** — 15 minutes. In Render choose **New + → Static Site**, connect the same repo and release branch, name it <code>chakri-casino-player-staging</code>, set root directory <code>frontend</code>, build command <code>yarn install --network-timeout 600000 && yarn build</code>, and publish directory <code>build</code>. Set <code>REACT_APP_BACKEND_URL</code> to the staging API URL and <code>GENERATE_SOURCEMAP=false</code>. Add a rewrite from <code>/*</code> to <code>/index.html</code>. Do not add <code>chakri.casino</code>, <code>www</code>, <code>play</code>, or <code>crm</code> as a custom domain. Cost: **$0**, subject to workspace build and bandwidth limits.

  **You'll know it worked when:** the Render URL loads the player welcome page and browser network requests go only to the staging API.

- [ ] 🧑 **Create the staging operator CRM static site** — 15 minutes. In Render choose **New + → Static Site** again, use the same repo and branch, name it <code>chakri-casino-crm-staging</code>, and use the same root, build, publish, and rewrite settings. Set <code>REACT_APP_ADMIN_CONSOLE=true</code>, <code>REACT_APP_ADMIN_CONSOLE_HOSTS</code> to this staging site's Render hostname, <code>REACT_APP_BACKEND_URL</code> to the staging API, and <code>GENERATE_SOURCEMAP=false</code>. Do not connect <code>crm.chakri.casino</code>. Cost: **$0**.

  **You'll know it worked when:** the staging CRM URL opens the admin login, does not expose player routes, and sends API requests only to the staging API.

- [ ] 🧑 **Finish staging CORS after both static URLs exist** — 5 minutes. Open the staging API → **Environment**, edit <code>CORS_ORIGINS</code>, and enter only the complete HTTPS origins of the staging player and CRM sites, separated exactly as the backend expects. Save and choose **Save, rebuild, and deploy** only for the staging API. Cost: **$0**.

  **You'll know it worked when:** both staging sites can call <code>/api/health</code> without a browser CORS error and an unrelated origin cannot.

- [ ] 🧑 **Confirm staging has no scheduler** — 3 minutes. In the Render workspace, filter services by <code>staging</code> and verify the list contains only the API web service and the two static sites. Do not create a cron job, background worker, or custom domain. Cost: **$0**.

  **You'll know it worked when:** no staging service can run the nightly settlement endpoint automatically.

## Phase 3 — pass code, configuration, and deployment gates

- [ ] 🤖 **Run the complete backend release suite** — 30–60 minutes.

  > Prompt: “In the clean staging release worktree, install only the locked backend requirements into an isolated environment, compile the backend modules, and run every maintained backend unit, integration, timing, payment, compliance, catalogue, and game-engine test. Do not use a production database, live provider, or network mutation. Report the exact commands, pass/fail totals, skipped tests, warnings, and failing file names. Do not commit, push, or deploy.”

  **You'll know it worked when:** every required suite passes, no test points to production, and the report contains no ignored failure.

- [ ] 🤖 **Run frontend tests and a clean production build** — 30–60 minutes.

  > Prompt: “In the clean staging release worktree, run the maintained React/CRACO tests, API-safety tests, route-guard tests, admin tests, responsive game checks, and the full production build including aviator-reference. Use the staging API URL and disable source maps. Inspect the build for production API leakage and obvious secret strings. Return exact commands and artifact sizes. Do not commit, push, or deploy.”

  **You'll know it worked when:** tests pass, the build completes, no secret is embedded, and a staging-hosted bundle does not hard-code a production financial or gameplay API.

- [ ] 🤖 **Verify all launch safety gates fail closed** — 20 minutes.

  > Prompt: “Test the release with APP_ENV=production and all provider/financial features disabled. Prove ADMIN_REVIEW registration remains available without an OTP adapter while creating only pending zero-chip accounts; separately prove PHONE_OTP mode reports registration unavailable while SMS delivery is disabled. Confirm deposits, withdrawals, automatic withdrawals, payment webhooks, and Supabase settlement cannot activate; health reports failure for invalid critical configuration; and the mock payment provider is rejected in production. Use only local tests and staging fixtures.”

  **You'll know it worked when:** every unavailable capability is denied by the server, not merely hidden by React.

- [ ] 🤝 **Deploy the reviewed commit to staging only** — 15–25 minutes. After the agent identifies the exact commit SHA, open each staging Render service → **Manual Deploy → Deploy a specific commit**, paste/select that same SHA, and confirm. Start with the API, then player, then CRM. Do not open the production services or Blueprint Sync. Cost: **$0**, subject to free build-minute limits.

  > Prompt: “Give me the one reviewed staging commit SHA and a three-service deployment order. After I deploy each staging service manually, poll only its public health or static asset endpoint, record the deployment ID and result, and stop immediately if the API gate fails. Do not deploy, redeploy, restart, or mutate any production service.”

  **You'll know it worked when:** all three staging services show the same commit, the API health check passes, and GitHub/Render production deployment records remain unchanged.

- [ ] 🤖 **Capture a staging release fingerprint** — 10 minutes.

  > Prompt: “Read-only verify the staging API /api/health and /api/ endpoints, response security headers, frontend asset manifest, PWA manifest, service worker cache policy, and deployed commit metadata. Compare them to the expected release. Do not log in, place a bet, mutate data, or query production.”

  **You'll know it worked when:** the report ties the staging URLs to one commit and the expected Roulette/Keno build fingerprint.

- [ ] 🤝 **Rehearse a staging rollback** — 10 minutes. In Render, open one staging service → **Events** and identify the previous successful deploy; have the agent record its ID. Use **Rollback** only if a harmless staging fixture is available and you approve the rehearsal. Never select a production service. Cost: **$0**.

  > Prompt: “Prepare a rollback card for each staging service with current deploy ID, previous known-good deploy ID, database compatibility note, and validation URLs. Do not execute rollback. Flag any migration that would prevent application rollback.”

  **You'll know it worked when:** an operator can name the exact previous deploy and verification command without touching production or MongoDB data.

## Phase 4 — test complete user journeys in staging

- [ ] 🤝 **Test login and administrator-reviewed registration** — 20 minutes. In a private window, submit one controlled profile, confirm pre-approval login is refused, approve it from the staging operator queue, then sign in with both the email and E.164 mobile number. Do not use a customer's contact details. Cost: **$0**.

  **You'll know it worked when:** the pending account has zero chips and no verified-contact flags, appears in the operator queue, cannot authenticate before approval, and can authenticate only after the recorded operator decision.

- [ ] 🤝 **Play every reviewed game end to end** — 45–60 minutes. In the staging player site, use only staging chips and play Aviator, 7Up7Down, American Roulette, Keno, Pappu Pictures, Andar Bahar, Teen Patti, Poker, Blackjack, and Rummy. Check one win, one loss, history, balance changes, mobile layout, and a refresh/reconnect where applicable. Cost: **$0**.

  > Prompt: “Monitor only the staging API and database while I play the ten reviewed games. Verify every accepted stake, result, payout, refund, round timer, history entry, and balance mutation is server-authoritative and exactly once. Confirm Keno, Andar Bahar, and American Roulette use the one-minute round with only the intended betting window, Teen Patti/Poker use their reviewed 30-second timing, and Rummy uses its centrally configured turn duration.”

  **You'll know it worked when:** all ten games settle precisely once, UI balances match the staging ledger after refresh, and no request or record appears in production.

- [ ] 🤖 **Prove financial features remain unavailable** — 15 minutes.

  > Prompt: “Against staging only, verify wallet, deposit, withdrawal, auto-withdrawal, bank-detail, webhook, and payment-admin routes remain fail-closed with all financial switches false. Confirm no payment provider call, cash-backed wallet movement, bank record, or financial outbox item is created. Redact all identifiers.”

  **You'll know it worked when:** the UI cannot begin a real-money flow and the staging financial collections remain empty.

- [ ] 🤝 **Test the isolated operator CRM** — 30 minutes. Open the staging CRM Render URL and sign in with a staging admin. Check permissions, dashboard, users, signups, games, announcements, compliance, distributors, commission, payouts, KYC, audit, and payment pages. Do not use the Hostinger CRM during this test. Cost: **$0**.

  > Prompt: “Observe staging CRM calls and verify role/permission enforcement, recent-step-up gates for sensitive actions, audit creation, redaction, and staging-only API origin. Use fixtures and reversible actions only. Do not access or mutate production CRM or balances.”

  **You'll know it worked when:** allowed actions work, forbidden roles receive server-side denial, sensitive views are redacted, and every CRM request targets staging.

- [ ] 🤝 **Check PWA and responsive gameplay on real devices** — 30–45 minutes. Open the staging player URL on one phone, one desktop/laptop, and if available one tablet. In the browser menu choose **Install app** or **Add to Home Screen**, then test portrait, landscape, touch targets, audio permission, reconnect, and standalone launch. Cost: **$0**.

  > Prompt: “Review screenshots and browser diagnostics from the staging PWA at common phone, tablet, laptop, and desktop sizes. Report clipping, overlapping controls, inaccessible touch targets, horizontal overflow, stale service-worker assets, and console errors. Make no code change until I approve the findings.”

  **You'll know it worked when:** the installed staging PWA opens without browser chrome, every game fits its viewport, controls remain precise, and an update does not leave stale game code.

- [ ] 🧑 **Confirm database isolation in Atlas** — 10 minutes. In Atlas, select **Chakri Casino Staging → Database → Browse Collections** and verify the test users, rounds, and bets exist only under <code>chakri_staging</code>. Switch back to the Production project without editing it and confirm staging collection names or IDs did not appear. Cost: **$0**.

  **You'll know it worked when:** staging activity is visible in the staging project and no production collection count changed during the test window.

- [ ] 🧑 **Approve the staging sign-off record** — 10 minutes. In GitHub, open the staging branch → **Pull requests → New pull request**, choose base <code>main</code> and compare <code>release/staging-2026-08-21</code>, then create it as **Draft**. Paste only the test summary, staging URLs, commit SHA, known limitations, and rollback IDs—never secrets or customer data. Cost: **$0**.

  **You'll know it worked when:** one draft PR contains the complete release evidence and is not mergeable by accident.

## Phase 5 — restore phone OTP after the provider is approved

The provider rollout is a future change. Keep <code>REGISTRATION_MODE=ADMIN_REVIEW</code> until the live-delivery checks below pass. Then set <code>REGISTRATION_MODE=PHONE_OTP</code>; the retained OTP route and provider controls become active without rewriting existing administrator-reviewed accounts.

- [ ] 🧑 **Configure the approved production SMS route** — 30–60 minutes plus provider approval. In Twilio, complete the account, sender, India messaging-registration and spend-cap requirements. Enter <code>TWILIO_ACCOUNT_SID</code>, <code>TWILIO_AUTH_TOKEN</code>, and <code>TWILIO_FROM_NUMBER</code> directly in the production Render API secret fields; set <code>OTP_SMS_ADAPTER=twilio</code> and <code>OTP_EXPOSE_DEV_CODE=false</code>. Keep <code>OTP_EMAIL_ADAPTER=disabled</code> for new-account activation. Cost: usage-priced; confirm current destination, carrier and sender charges in Twilio.

  **You'll know it worked when:** a designated test mobile receives one real code, no code or provider secret appears in API responses/logs, and capabilities advertise phone registration only while the provider is ready.

- [ ] 🤖 **Prove SMS failure closes registration** — 15 minutes. Before the live test, validate staging with the SMS adapter disabled and with invalid non-secret fixture configuration. Do not intentionally break production credentials. Cost: **$0**.

  **You'll know it worked when:** registration reports unavailable and creates no player, attribution, password or session whenever SMS readiness/delivery fails.

- [ ] 🤖 **Run live-delivery safety tests without exposing OTPs** — 20 minutes.

  > Prompt: “After the operator configures Twilio directly in Render, test one controlled phone registration and phone password reset. Verify OTP expiry is 15 minutes, resend cooldown and attempt limits work, codes are hashed at rest, optional email remains unverified, and logs contain neither code nor full recipient. Do not request or display provider keys or OTP values.”

  **You'll know it worked when:** both controlled messages arrive, each challenge is one-use, and the redacted audit contains no sensitive value.

- [ ] 🤝 **Confirm the retired no-OTP setting cannot reopen access** — 15 minutes. Remove <code>SELF_SERVICE_NO_OTP_ENABLED</code> from Render after the reviewed release is deployed. The code ignores it, but removing the stale variable prevents operator confusion. Confirm capabilities return <code>verification_required=true</code> and prepare the historical deferred-account phone-verification campaign. Cost: **$0**.

  > Prompt: “After real SMS delivery is proven, verify one controlled phone signup and resend, then confirm SELF_SERVICE_NO_OTP_ENABLED is absent. Check that no new DEFERRED account can be created, verified-phone accounts still log in, and historical deferred accounts remain blocked without changing balances, history, attribution or settings.”

  **You'll know it worked when:** every new registration requires delivered contact verification and no historical account data was rewritten or lost.

## Phase 6 — protect and promote the exact staging commit

- [ ] 🤖 **Add automated release checks before protecting <code>main</code>** — 30–60 minutes.

  > Prompt: “Create a GitHub Actions proposal that runs the maintained backend security/game suites, frontend unit tests, clean production build, secret scan with redacted output, and render.yaml validation on pull requests. Use no production secrets and no deployment token. Show the workflow diff and expected required-check names; do not commit or push until approved.”

  **You'll know it worked when:** the proposed checks reproduce local gates and cannot deploy or access production.

- [ ] 🧑 **Protect GitHub <code>main</code>** — 10 minutes. After the checks exist, open GitHub **FunGame-Admin → Settings → Rules → Rulesets → New ruleset → New branch ruleset**. Target the default branch, require a pull request, require the named passing status checks, block force pushes and deletions, and require resolution of review conversations. Set enforcement to **Active**. Cost: **$0 for this public repository**.

  **You'll know it worked when:** a direct push to <code>main</code> is rejected and the draft release PR cannot merge with a failing or missing check.

- [ ] 🧑 **Complete the operator/legal launch gate** — 30–90 minutes, excluding external review. From the staging player footer and account screens, open Terms, Privacy, Responsible Play, age controls, self-exclusion, KYC, deposit/withdrawal copy, and support contacts. Record written approval from the responsible owner or counsel. Keep the product explicitly play-chip-only while financial flags are off. Cost: **provider-dependent; no legal-service cost is assumed here**.

  **You'll know it worked when:** every required policy has an approved version/date/owner and the UI makes no claim that real-money payment is available.

- [ ] 🤖 **Prepare the immutable production release card** — 15 minutes.

  > Prompt: “From the passing staging PR, produce a release card containing exact commit SHA, changed-file summary, database compatibility, environment-variable changes by name only, test totals, staging deploy IDs, smoke-test evidence, known limitations, rollback deploy IDs, and a statement that all financial flags remain false. Do not merge, push, deploy, or reveal secrets.”

  **You'll know it worked when:** one commit can be traced from source through tests and all staging services, with a complete rollback route.

- [ ] 🤝 **Merge only the approved release PR** — 10 minutes. Review the release card and GitHub checks. In the PR choose **Ready for review**, obtain the required approval, then choose **Merge pull request** using the repository's approved merge method. Because Render Auto Sync is paused, merging must not deploy. Cost: **$0**.

  > Prompt: “Before I merge, verify the PR base is main, the head is release/staging-2026-08-21, checks pass, no unrelated file or secret is present, and the merge result will contain the exact staging-tested tree. After I click merge, verify the new main SHA and confirm no Render deployment started.”

  **You'll know it worked when:** GitHub <code>main</code> contains the reviewed tree while both production Render services still show their previous deployment.

- [ ] 🤝 **Deploy the production API first** — 15–25 minutes. In Render open the existing production API that serves <code>fungame-api.onrender.com</code> → **Manual Deploy → Deploy a specific commit**, select the approved main SHA, and confirm. Do not rename the service, change <code>DB_NAME=fungame</code>, or enable a financial flag. Cost: existing production service cost only.

  > Prompt: “Monitor the approved production API deploy read-only. Poll /api/health and /api/, compare the build fingerprint, inspect error rates and startup logs for secret-free failures, and stop the release if any health, database, auth, or game gate fails. Do not deploy the frontend or mutate production data.”

  **You'll know it worked when:** the API reports healthy on <code>api.chakri.casino</code>, exposes the expected build fingerprint, and shows no new error spike.

- [ ] 🤝 **Deploy the production player static site** — 15–25 minutes. Only after the API gate passes, open the production static service that serves <code>fungame-web.onrender.com</code> → **Manual Deploy → Deploy a specific commit** and choose the same approved SHA. Keep <code>REACT_APP_BACKEND_URL</code> on the verified API origin and leave production custom domains unchanged during the deploy. Cost: existing static-site cost only.

  > Prompt: “Monitor the approved production player deploy. Verify the asset manifest, service worker cache headers, PWA manifest, API origin, login page, game catalogue, and one read-only public API request. Do not log in as a customer, place a bet, or alter DNS.”

  **You'll know it worked when:** the production player site serves the reviewed asset hashes and communicates with the healthy production API.

- [ ] 🤝 **Publish the reviewed operator build to Hostinger** — 20–40 minutes. First have the agent create and checksum an admin-only production build. In Hostinger hPanel choose **Websites → Manage** for <code>crm.chakri.casino</code> → **Files → File Manager**, locate the displayed subdomain document root, and download a backup. Upload the reviewed build only after confirming its checksum; do not replace the apex marketing site. Cost: no incremental cost on the existing Hostinger plan.

  > Prompt: “Build the admin-only React bundle from the approved production SHA with REACT_APP_ADMIN_CONSOLE=true, REACT_APP_ADMIN_CONSOLE_HOSTS=crm.chakri.casino, REACT_APP_BACKEND_URL=https://api.chakri.casino, and source maps disabled. Produce a file manifest and SHA-256 checksums. Do not upload, access Hostinger, include secrets, or modify the player build.”

  **You'll know it worked when:** <code>crm.chakri.casino/admin/login</code> serves the checksum-matched admin bundle, player routes are unavailable there, and API calls use <code>api.chakri.casino</code>.

- [ ] 🧑 **Connect <code>play.chakri.casino</code> only if it is the approved player URL** — 10 minutes plus DNS propagation. In the Render production static service open **Settings → Custom Domains → Add Custom Domain**, enter <code>play.chakri.casino</code>, then at the DNS provider add the exact CNAME target Render displays. Do not change apex, <code>www</code>, <code>crm</code>, or <code>api</code>. Cost: normally **$0 within included domains**, or **$0.25/month** if it exceeds the current Render workspace allowance.

  **You'll know it worked when:** DNS resolves, Render shows a valid certificate, the play hostname serves the player app, and CRM/apex/API continue serving their original applications.

- [ ] 🤝 **Enable the corrected production cron only after a manual dry run** — 15–30 minutes. In Render open the corrected production cron service and choose **Trigger Run** once while the agent watches the idempotent settlement response. Approve the valid paid instance and UTC schedule only if the dry run succeeds. Never create a staging cron. Cost: **minimum $1/month plus run time**.

  > Prompt: “Before the operator triggers the production cron, verify its API_BASE is the live api.chakri.casino origin, the schedule is UTC, the named gaming day is correct, the request is idempotent, and CRON_SECRET exists without printing it. During the single run, report HTTP result and redacted settlement counts. Do not trigger or retry the job yourself.”

  **You'll know it worked when:** one manual run completes successfully, a repeat is idempotent, and the next scheduled time is documented in both UTC and Europe/London.

- [ ] 🤝 **Run the production smoke test as a controlled user journey** — 45–60 minutes. Use designated test accounts, not customer accounts. Test registration by email if enabled, login, onboarding, one low-stakes play-chip round in each reviewed game, history, balance refresh, logout, password reset, PWA install, and staging-approved admin reads. Do not test deposit or withdrawal with money. Cost: play chips only; email/SMS usage may incur provider charges.

  > Prompt: “Observe the controlled production smoke test read-only. Correlate each action to server logs and ledger IDs, verify exactly-once settlement, watch error rate and latency, and confirm all five financial flags remain false. Redact user identifiers and do not initiate a payment, withdrawal, admin approval, or destructive action.”

  **You'll know it worked when:** the full journey completes on phone and desktop, balances reconcile, no production error spike appears, and real-money functions remain unavailable.

## Phase 7 — operate safely after launch

- [ ] 🧑 **Turn on database backups and alerts** — 15 minutes. In Atlas Production open **Backup** and confirm the current tier's snapshot/point-in-time option; if the tier does not support it, upgrade only after reviewing the displayed monthly estimate. Under **Project Settings → Alerts**, create alerts for connection saturation, storage, replication, and billing. Cost: depends on the Atlas production tier and displayed backup storage.

  **You'll know it worked when:** Atlas shows a recent recoverable backup or an approved backup plan, plus active alert recipients and thresholds.

- [ ] 🧑 **Set hosting and provider spend limits** — 10 minutes. In Render open workspace **Billing → Spend Limit/Usage**, in Atlas open **Billing → Budgets & Alerts**, in Resend open **Billing**, and in Twilio, if used, open **Billing → Usage Triggers**. Enter the approved monthly ceilings and operator email. Cost: **$0 to configure**.

  **You'll know it worked when:** every billable provider has a written monthly ceiling and sends a test notification to the responsible operator.

- [ ] 🤖 **Prepare a redacted monitoring dashboard and daily check** — 30 minutes.

  > Prompt: “Define a read-only operational dashboard for API health, Render deploy version, error rate, response latency, MongoDB connections, round-settlement lag, ledger mismatch count, failed OTP deliveries, failed cron runs, payment flags, and PWA asset version. Use aggregate metrics and masked IDs only. Do not add a vendor, credential, production mutation, or deployment without approval.”

  **You'll know it worked when:** one view shows whether users can log in, play, settle, and receive OTPs without exposing personal data or secrets.

- [ ] 🤖 **Write and test the incident/rollback runbook** — 30 minutes.

  > Prompt: “Create a proposed incident runbook for a failed API deploy, broken frontend asset, stale service worker, Mongo outage, double settlement, OTP outage, leaked credential, and accidental financial-flag change. Include detection, immediate containment, exact rollback target, verification, escalation owner, and evidence preservation. Do not execute any production action.”

  **You'll know it worked when:** an operator can restore the previous application deploy without renaming or replacing <code>fungame</code>, and every high-risk incident has an owner.

- [ ] 🧑 **Review the first 24 hours and close staging when finished** — 20 minutes. After a stable day, open Render and review production logs, deployment events, usage, and errors. Keep staging for the next release if affordable; otherwise suspend only the three clearly named staging services and pause Atlas Flex. Never delete production or its database. Cost: **$0 if staging is suspended/M0**, otherwise its stated monthly usage.

  **You'll know it worked when:** the 24-hour review is recorded, there are no unexplained balance/auth/deploy anomalies, and every suspended resource contains <code>staging</code> in its name.

## Final launch gate

Chakri.Casino is launched only when all of the following are true:

1. The exact production commit passed automated checks and all staging user journeys.
2. The API, player site, and CRM expose that reviewed build on their intended hosts.
3. Production MongoDB remained isolated from staging and has a recovery plan.
4. Email signup works through a real provider, or unavailable channels are honestly disabled.
5. Every payment and withdrawal switch remains false until a separately approved real-money launch.
6. The invalid cron declaration is removed or replaced with an approved paid, tested cron.
7. A real phone and desktop complete the controlled production smoke test.
8. Rollback IDs, owners, spend limits, and monitoring are recorded.

If any gate fails, stop. Roll back the affected application service to its recorded prior deploy, preserve logs, and do not rename, reset, import into, or delete the production <code>fungame</code> database.

## Provider references

- [Render Blueprint YAML reference](https://render.com/docs/blueprint-spec)
- [Render free-service limits](https://render.com/docs/free)
- [Render cron jobs and billing](https://render.com/docs/cronjobs)
- [Google Cloud API-key rotation](https://docs.cloud.google.com/docs/authentication/api-keys)
- [Google Tenor API usage and key management](https://developers.google.com/tenor/guides/quickstart)
- [Resend transactional-email pricing](https://resend.com/pricing)
- [Twilio SMS pricing for India](https://www.twilio.com/en-us/sms/pricing/in)
