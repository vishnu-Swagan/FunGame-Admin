# Payment security and secrets

Gateway credentials are encrypted with AES-256-GCM using a host-managed master
key, unique random nonce and gateway/name/version AAD. APIs return only masked
hints. Rotation archives the previous ciphertext and records the actor.

Admin endpoints enforce server-side permissions; creation, credential rotation,
activation and disable operations require recent step-up, with Super Admin and
maker-checker controls where applicable. Generic REST requests enforce HTTPS,
domain allow-lists, public DNS addresses, no redirects, bounded timeouts and
bounded response bodies. Logs and activity snapshots use recursive redaction.

Never store PAN, CVV, PIN, OTP, raw bank details or authorization headers.

