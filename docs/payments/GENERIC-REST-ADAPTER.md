# Generic REST adapter configuration

The Generic REST adapter is for conventional HTTPS JSON providers only. Its
configuration contains `base_url`, `capabilities`, relative `endpoints`,
`auth`, `headers`, `idempotency_header`, `response_mapping`, `status_mapping`,
`webhook` and `webhook_mapping`.

Mappings are dot-path lookups only. They cannot execute code, templates, SQL or
shell commands. The adapter rejects credentials in URLs, non-HTTPS URLs,
unapproved domains, private/loopback/link-local/reserved DNS answers, unsafe
relative paths, redirects and oversized responses. Allowed domains come only
from `PAYMENT_PROVIDER_ALLOWED_DOMAINS`.

Credentials are written separately through the write-only credential endpoint.
Supported authentication is bearer, basic, API-key header and HMAC-SHA256/512.
Provider-specific SDK, encryption or unusual workflow requirements require a
dedicated adapter.

