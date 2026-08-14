"""Temporary, read-only Mongo export endpoint for the Supabase cutover.

This router is deliberately *not* a general backup API.  It is absent from the
OpenAPI schema, returns 404 unless a short-lived migration window is explicitly
enabled, and requires a new timestamped HMAC for every request.  It is intended
to be removed after the data reconciliation has been signed off.

Enable only for a bounded migration window:

    MIGRATION_EXPORT_ENABLED=true
    MIGRATION_EXPORT_SECRET=<at-least-32-random-characters>
    MIGRATION_EXPORT_EXPIRES_AT=2026-08-15T12:00:00Z

Optional ``MIGRATION_EXPORT_COLLECTIONS`` is a comma-separated allowlist.  The
default covers the application's persistent collections but excludes transient
process locks and this router's nonce cache.

Each GET request must include:

* ``X-Migration-Timestamp`` — Unix seconds, within five minutes of the server.
* ``X-Migration-Nonce`` — unique 16–128 character base64url value.
* ``X-Migration-Signature`` — lowercase SHA-256 HMAC hex digest.

The signed UTF-8 payload is exactly::

    METHOD + "\\n" + PATH_AND_RAW_QUERY + "\\n" + TIMESTAMP + "\\n" + NONCE
    + "\\n" + SHA256_HEX_OF_REQUEST_BODY

The nonce is consumed in MongoDB before data is read, preventing a valid request
from being replayed across multiple web workers.  Responses use BSON Canonical
Extended JSON so ObjectIds, dates, decimals and integer widths remain lossless.
Sensitive credential fields are excluded rather than being copied into a new
system; affected users should use the normal credential-recovery flow after the
cutover.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import os
import re
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from bson import json_util
from bson.json_util import CANONICAL_JSON_OPTIONS
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pymongo.errors import DuplicateKeyError

from db import db


# No public endpoint should be able to enumerate a database.  The allowlist is
# intentionally explicit rather than trusting collection names supplied in URLs.
_DEFAULT_COLLECTIONS = frozenset({
    'admin_audit',
    'announcements',
    'aviator_bets',
    'aviator_rounds',
    'blackjack_games',
    'chip_requests',
    'chip_transactions',
    'commission_ledger',
    'commission_runs',
    'compliance_config',
    'distributor_days',
    'distributor_rates',
    'distributors',
    'exclusions',
    'game_rounds',
    'games',
    'live_bets',
    'live_outcomes',
    'notifications',
    'payout_ledger',
    'payouts',
    'player_attribution',
    'player_days',
    'player_limits',
    'points_transactions',
    'roulette_bets',
    'roulette_rounds',
    'signup_requests',
    'support_messages',
    'system_config',
    'users',
})
_INTERNAL_COLLECTIONS = frozenset({'migration_export_nonces', 'system_locks'})
_COLLECTION_RE = re.compile(r'^[A-Za-z][A-Za-z0-9_]{0,63}$')
_NONCE_RE = re.compile(r'^[A-Za-z0-9_-]{16,128}$')
_SIGNATURE_RE = re.compile(r'^[0-9a-f]{64}$')
_REPLAY_WINDOW_SECONDS = 5 * 60
_MAX_CURSOR_BYTES = 2048

# These fields must never leave the source database, even through a temporary
# authenticated channel.  This preserves account and game records while forcing
# credentials/tokens to be reissued by the destination identity provider.
_SENSITIVE_FIELD_NAMES = frozenset({
    'active_session_id',
    'access_token',
    'api_key',
    'api_secret',
    'auth_token',
    'credential',
    'credentials',
    'password',
    'password_hash',
    'private_key',
    'refresh_token',
    'reset_code',
    'reset_code_hash',
    'secret',
    'session_id',
    'session_token',
    'token',
    'verification_code',
    'verification_code_hash',
})


router = APIRouter(prefix='/migration-export', tags=['migration-export'])


@dataclass(frozen=True)
class _ExportSettings:
    secret: bytes
    allowed_collections: frozenset[str]


_nonce_index_lock = asyncio.Lock()
_nonce_index_ready = False


def _not_found() -> None:
    # Do not disclose whether the temporary route is misconfigured, expired, or
    # simply disabled.  A migration operator will see configuration failures in
    # deployment tooling rather than through a public HTTP response.
    raise HTTPException(status_code=404, detail='Not found')


def _unauthorized() -> None:
    raise HTTPException(
        status_code=401,
        detail='Unauthorized',
        headers={'WWW-Authenticate': 'Migration-HMAC'},
    )


def _parse_expiry(value: str | None) -> datetime | None:
    """Parse an absolute UTC expiry without accepting a timezone-less value."""
    if not value:
        return None
    try:
        if value.isdecimal():
            return datetime.fromtimestamp(int(value), tz=timezone.utc)
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if parsed.tzinfo is None:
            return None
        return parsed.astimezone(timezone.utc)
    except (OverflowError, ValueError):
        return None


def _enabled_settings() -> _ExportSettings:
    """Return safe settings or hide this route completely."""
    if os.environ.get('MIGRATION_EXPORT_ENABLED', '').strip().lower() != 'true':
        _not_found()

    secret = os.environ.get('MIGRATION_EXPORT_SECRET', '')
    # A short passphrase is not an acceptable signing key for a database export.
    if len(secret) < 32:
        _not_found()

    expires_at = _parse_expiry(os.environ.get('MIGRATION_EXPORT_EXPIRES_AT'))
    if expires_at is None or expires_at <= datetime.now(timezone.utc):
        _not_found()

    configured = os.environ.get('MIGRATION_EXPORT_COLLECTIONS', '').strip()
    if not configured:
        return _ExportSettings(secret=secret.encode('utf-8'), allowed_collections=_DEFAULT_COLLECTIONS)

    names = frozenset(name.strip() for name in configured.split(',') if name.strip())
    if (not names or any(not _COLLECTION_RE.fullmatch(name) for name in names)
            or names & _INTERNAL_COLLECTIONS):
        _not_found()
    return _ExportSettings(secret=secret.encode('utf-8'), allowed_collections=names)


def _signed_target(request: Request) -> str:
    """Use the raw query string so pagination controls are authenticated too."""
    query = request.url.query
    return f'{request.url.path}?{query}' if query else request.url.path


def _signature_payload(request: Request, timestamp: str, nonce: str, body: bytes) -> bytes:
    body_digest = hashlib.sha256(body).hexdigest()
    return '\n'.join((
        request.method.upper(),
        _signed_target(request),
        timestamp,
        nonce,
        body_digest,
    )).encode('utf-8')


async def _ensure_nonce_index() -> None:
    """Create a TTL index once so one-time nonce records cannot accumulate."""
    global _nonce_index_ready
    if _nonce_index_ready:
        return
    async with _nonce_index_lock:
        if not _nonce_index_ready:
            await db.migration_export_nonces.create_index('expires_at', expireAfterSeconds=0)
            _nonce_index_ready = True


async def _consume_nonce(timestamp: str, nonce: str, signature: str) -> None:
    """Atomically record one valid signature; duplicate use is a replay."""
    await _ensure_nonce_index()
    nonce_id = hashlib.sha256(f'{timestamp}:{nonce}:{signature}'.encode('utf-8')).hexdigest()
    try:
        await db.migration_export_nonces.insert_one({
            '_id': nonce_id,
            # This collection is not part of the migration allowlist.
            'expires_at': datetime.now(timezone.utc) + timedelta(seconds=_REPLAY_WINDOW_SECONDS),
        })
    except DuplicateKeyError:
        _unauthorized()


async def require_migration_authorization(request: Request) -> _ExportSettings:
    """Validate the one-shot HMAC before any collection or cursor is read."""
    settings = _enabled_settings()
    timestamp = request.headers.get('x-migration-timestamp', '')
    nonce = request.headers.get('x-migration-nonce', '')
    signature = request.headers.get('x-migration-signature', '')

    if not timestamp.isdecimal() or not _NONCE_RE.fullmatch(nonce) or not _SIGNATURE_RE.fullmatch(signature):
        _unauthorized()
    try:
        timestamp_int = int(timestamp)
    except ValueError:
        _unauthorized()
    if abs(time.time() - timestamp_int) > _REPLAY_WINDOW_SECONDS:
        _unauthorized()

    body = await request.body()
    # Export endpoints are GET-only.  Reject bodies rather than letting a proxy
    # retain arbitrary bytes alongside a signed request.
    if body:
        _unauthorized()
    expected = hmac.new(
        settings.secret,
        _signature_payload(request, timestamp, nonce, body),
        hashlib.sha256,
    ).hexdigest()
    if not hmac.compare_digest(expected, signature):
        _unauthorized()

    try:
        await _consume_nonce(timestamp, nonce, signature)
    except HTTPException:
        raise
    except Exception:
        # A source that cannot guarantee replay protection must not export data.
        raise HTTPException(status_code=503, detail='Migration source unavailable')
    return settings


def _redact_sensitive_values(value: Any) -> Any:
    """Copy BSON values while removing only credential-bearing keys recursively."""
    if isinstance(value, dict):
        return {
            key: _redact_sensitive_values(item)
            for key, item in value.items()
            if key.lower() not in _SENSITIVE_FIELD_NAMES
        }
    if isinstance(value, list):
        return [_redact_sensitive_values(item) for item in value]
    return value


def _encode_cursor(last_id: Any) -> str:
    raw = json_util.dumps({'id': last_id}, json_options=CANONICAL_JSON_OPTIONS).encode('utf-8')
    return base64.urlsafe_b64encode(raw).decode('ascii').rstrip('=')


def _decode_cursor(cursor: str | None) -> Any | None:
    if cursor is None:
        return None
    if not cursor or len(cursor) > _MAX_CURSOR_BYTES:
        raise HTTPException(status_code=400, detail='Invalid cursor')
    try:
        padded = cursor + '=' * (-len(cursor) % 4)
        raw = base64.urlsafe_b64decode(padded.encode('ascii'))
        if len(raw) > _MAX_CURSOR_BYTES:
            raise ValueError('cursor is too large')
        decoded = json_util.loads(raw.decode('utf-8'))
    except (UnicodeDecodeError, ValueError):
        raise HTTPException(status_code=400, detail='Invalid cursor')
    if not isinstance(decoded, dict) or set(decoded) != {'id'}:
        raise HTTPException(status_code=400, detail='Invalid cursor')
    return decoded['id']


def _extended_json_response(payload: dict[str, Any]) -> Response:
    """Disable browser/proxy caching of migration records."""
    return Response(
        content=json_util.dumps(payload, json_options=CANONICAL_JSON_OPTIONS),
        media_type='application/json',
        headers={
            'Cache-Control': 'no-store, max-age=0',
            'Pragma': 'no-cache',
        },
    )


@router.get('/manifest', include_in_schema=False)
async def export_manifest(settings: _ExportSettings = Depends(require_migration_authorization)) -> Response:
    """Return the named, allowed source collections and their document counts."""
    existing = set(await db.list_collection_names())
    names = sorted(settings.allowed_collections & existing)
    collections = []
    for name in names:
        collections.append({'name': name, 'count': await db[name].count_documents({})})
    return _extended_json_response({
        'format': 'bson-canonical-extended-json-v1',
        'collections': collections,
        'page_limit': {'minimum': 1, 'maximum': 250, 'default': 100},
    })


@router.get('/collections/{collection}', include_in_schema=False)
async def export_collection_page(
    collection: str,
    cursor: str | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=250),
    settings: _ExportSettings = Depends(require_migration_authorization),
) -> Response:
    """Export one lossless, sanitized page ordered by BSON ``_id``."""
    if not _COLLECTION_RE.fullmatch(collection) or collection not in settings.allowed_collections:
        _not_found()

    after_id = _decode_cursor(cursor)
    query: dict[str, Any] = {} if after_id is None else {'_id': {'$gt': after_id}}
    docs = await db[collection].find(query).sort('_id', 1).limit(limit + 1).to_list(limit + 1)
    has_more = len(docs) > limit
    page = docs[:limit]
    next_cursor = _encode_cursor(page[-1]['_id']) if has_more and page else None
    return _extended_json_response({
        'format': 'bson-canonical-extended-json-v1',
        'collection': collection,
        'documents': [_redact_sensitive_values(doc) for doc in page],
        'next_cursor': next_cursor,
        'complete': next_cursor is None,
    })
