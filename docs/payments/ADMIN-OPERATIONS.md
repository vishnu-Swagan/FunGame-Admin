# Admin payment operations

The CRM Payment Hub exposes gateway health, disabled drafts, encrypted
credential rotation, connection tests, maker-checker activation requests,
deterministic route drafts, webhook evidence and immutable activity.

Operators must never share credentials in notes or tickets. Run a sandbox
health test before requesting activation. The requester cannot approve their
own activation. Disable a degraded gateway instead of deleting it; historical
transactions retain the gateway identifier.

Manual settlement imports are preview/checksum operations. A repeated file is
reported as a duplicate. Financial status is never manually changed through a
generic "mark successful" action.

