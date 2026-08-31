# Generic REST adapter configuration

The Generic REST adapter is for conventional HTTPS JSON providers only. Its
configuration contains `base_url`, explicit `capabilities`, relative
`endpoints`, operation-specific `request_mapping` and `response_mapping`,
`auth`, `idempotency_header`, `status_mapping`, `webhook` and
`webhook_mapping`. Static provider headers are not supported: `headers` must be
omitted or empty, and either adapter rejects every nonempty `headers` object.

Mappings are dot-path lookups only. They cannot execute code, templates, SQL or
shell commands. The adapter rejects credentials in URLs, non-HTTPS URLs,
unapproved domains, private/loopback/link-local/reserved DNS answers, unsafe
relative paths, redirects and oversized responses. Allowed domains come only
from `PAYMENT_PROVIDER_ALLOWED_DOMAINS`.

Credentials are written separately through the write-only credential endpoint.
Supported authentication is bearer, basic, API-key header and HMAC-SHA256/512.
Provider-specific SDK, encryption or unusual workflow requirements require a
dedicated adapter.

Each CRM gateway row has a unique gateway code and may use `GENERIC_REST` with
its own encrypted credential set, capability list, health status and routing
priority/weight. These are configuration records only during Phase 0. The
reserved V2 callback pattern is:

`https://<public-api-origin>/api/webhooks/payments/<gateway_code>`

Do not register that V2 path with a provider yet. It is not connected to the
player order or authoritative wallet-posting flow, and the CRM deliberately
does not present it as a copyable or registration-ready URL.

The adapter contract must be copied from the provider's official merchant
documentation. Do not guess endpoints or field names. For every configured
operation, `request_mapping` maps Chakri canonical fields to provider fields,
and `response_mapping` maps authoritative provider fields back to canonical
fields. Payment-status mappings must include amount, ISO currency and immutable
provider reference. Payout-status mappings additionally require withdrawal ID,
idempotency key and beneficiary ID bindings.

The legacy `ConfiguredRestPaymentProvider` uses the same principles through
`PAYMENT_PROVIDER_CONFIG_JSON`. Its top-level fields are `provider_name`,
`base_url`, complete boolean `capabilities`, `endpoints` (`method` + relative
`path`), per-operation request/response mappings, deposit/payout status maps,
`idempotency_header`, `auth`, and signed `webhook` field and event mappings. A
`headers` field may be omitted or set to `{}` only; any nonempty value is
rejected, including non-secret static headers. Auth/webhook blocks reference
`PAYMENT_PROVIDER_*` environment variable names; credential values must never
appear in JSON.
Provider and hosted-checkout hosts must be explicitly listed in
`PAYMENT_PROVIDER_ALLOWED_DOMAINS` and
`PAYMENT_PROVIDER_CHECKOUT_ALLOWED_DOMAINS` respectively.

This legacy provider is the current single-provider player V1 bridge. Its
signed callback is `/api/payments/webhooks/{provider_name}`. A V1 provider
contract and callback must not be described as multi-provider routing, and a V2
CRM draft must not be substituted for the V1 configuration.

## Legacy bridge schema reference

- `provider_name`: must exactly match `PAYMENT_PROVIDER`.
- `base_url`: credential-free HTTPS URL on the provider allow-list.
- `capabilities`: explicitly sets all six booleans: deposit idempotency,
  payment-status lookup, payout idempotency, payout-status lookup, payout
  cancellation and refunds.
- `endpoints`: operation keys with an HTTPS-relative `path` and `GET` or `POST`
  `method`. Operations are enabled only when required by capabilities.
- `request_mapping`: canonical-input dot path to provider-request dot path for
  every operation. Idempotency is also sent in the reviewed header.
- `response_mapping`: canonical authoritative field to provider-response dot
  path for every operation.
- `status_mapping`: separate `deposit` and `payout` maps. Unknown statuses are
  rejected rather than passed through.
- `idempotency_header`: reviewed HTTP header name; unsafe transport headers are
  rejected.
- `headers`: omit it or use `{}`. Every nonempty static-header object is
  rejected; place supported authentication and signature header names in their
  dedicated `auth` or `webhook` configuration instead.
- `auth`: one of `bearer` (`credential_env`), `api_key_header`
  (`header_name`, `credential_env`), `basic` (`username_env`, `password_env`),
  or `hmac-sha256/512` (`secret_env`, timestamp/signature headers and optional
  signature prefix). Every reference must name a `PAYMENT_PROVIDER_*` host
  secret.
- `webhook`: HMAC-SHA256/512 algorithm, timestamp/signature headers, optional
  prefix, `secret_env`, replay window from 30 to 900 seconds, authoritative
  field `mapping`, and explicit `event_type_mapping`.
- `timeout_seconds` and `max_response_bytes`: optional bounded transport limits.

The V2 CRM `GENERIC_REST` row follows the same contract principles, but its
credentials are stored per gateway by credential key. Its `auth` and `webhook`
blocks refer to those encrypted keys through `credential_key`; no credential
value belongs in `non_secret_config`.
