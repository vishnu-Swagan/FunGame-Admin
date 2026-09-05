# Chakri.Casino policy publication contract

The application accepts operator-approved public facts through hosting configuration. They do not need to be placed in chat or committed as source defaults.

## 1. Publish immutable documents

Publish the approved Terms and Privacy Notice at versioned HTTPS URLs that will never be replaced in place. Record a SHA-256 digest of each exact published file.

Configure the API with:

- `CURRENT_TERMS_VERSION`
- `CURRENT_PRIVACY_VERSION`
- `TERMS_PUBLIC_URL`
- `PRIVACY_PUBLIC_URL`
- `TERMS_EFFECTIVE_AT`
- `PRIVACY_EFFECTIVE_AT`
- `TERMS_CONTENT_SHA256`
- `PRIVACY_CONTENT_SHA256`

Dates must include a timezone. Hashes must be 64-character lowercase SHA-256 hexadecimal values. The public URLs may be same-origin paths or HTTPS URLs.

## 2. Configure the public policy centre

Set the matching frontend values during the production build:

- `REACT_APP_LEGAL_POLICY_STATUS=PUBLISHED`
- `REACT_APP_LEGAL_POLICY_VERSION`
- `REACT_APP_TERMS_VERSION`
- `REACT_APP_PRIVACY_VERSION`
- `REACT_APP_LEGAL_POLICY_EFFECTIVE_DATE`
- `REACT_APP_OPERATOR_LEGAL_NAME`
- `REACT_APP_OPERATOR_COMPANY_NUMBER`
- `REACT_APP_OPERATOR_REGISTERED_OFFICE`
- `REACT_APP_OPERATOR_REGULATOR_NAME`
- `REACT_APP_OPERATOR_LICENCE_NUMBER`
- `REACT_APP_OPERATOR_LICENCE_URL`
- `REACT_APP_OPERATOR_SUPPORT_EMAIL`
- `REACT_APP_OPERATOR_PRIVACY_EMAIL`
- `REACT_APP_OPERATOR_COMPLAINTS_EMAIL`
- `REACT_APP_OPERATOR_GOVERNING_LAW`

Configure `REACT_APP_OPERATOR_ADR_NAME` and `REACT_APP_OPERATOR_ADR_URL` when an independent dispute service applies. The UI deliberately falls back to DRAFT if a required public field or effective date is absent.

## 3. Enable exact consent after client rollout

Keep `POLICY_EXPLICIT_VERSION_ACK_REQUIRED=false` during the rolling deployment. Confirm that every supported frontend loads `GET /api/auth/policies/current` and sends `accepted_privacy=true`, `terms_version`, and `privacy_version` during registration. Then set the flag to `true`.

Strict mode fails closed if a publication URL, effective timestamp, hash, or exact version is missing. Accepted evidence is insert-only and keeps the jurisdiction, timestamp, immutable document snapshot, and evidence hash captured at registration.

## 4. Verify

1. Open every route under `/legal/` on mobile and desktop.
2. Confirm the status reads PUBLISHED and no incomplete-publication warning appears.
3. Register one controlled test account and inspect only the non-secret acceptance metadata.
4. Submit an intentionally stale version in staging and confirm the API returns `POLICY_VERSION_MISMATCH` without creating an account.
5. Confirm `/wallet/deposit/return` resolves directly and historical `/chips/...` bookmarks redirect to the equivalent wallet route.
