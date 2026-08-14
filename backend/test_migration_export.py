"""Focused checks for the temporary, HMAC-protected migration exporter.

Run directly with ``python backend/test_migration_export.py``.  The fixture
uses an in-memory MongoDB implementation and never contacts a real database.
"""

import asyncio
import hashlib
import hmac
import json
import os
import secrets
import sys
import time
import types
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException
from mongomock_motor import AsyncMongoMockClient
from starlette.requests import Request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

client = AsyncMongoMockClient()
db = client['migration_export_test']
sys.modules['db'] = types.SimpleNamespace(db=db)

import routes_migration_export as export_routes


PASS = FAIL = 0
_TEST_SECRET = 'migration-export-fixture-secret-32-chars'


def check(name, condition):
    global PASS, FAIL
    print(('  PASS  ' if condition else '  FAIL  ') + name)
    if condition:
        PASS += 1
    else:
        FAIL += 1


def signed_headers(path_and_query: str, *, nonce: str | None = None):
    timestamp = str(int(time.time()))
    nonce = nonce or secrets.token_urlsafe(24)
    body_digest = hashlib.sha256(b'').hexdigest()
    payload = f'GET\n{path_and_query}\n{timestamp}\n{nonce}\n{body_digest}'.encode('utf-8')
    signature = hmac.new(_TEST_SECRET.encode('utf-8'), payload, hashlib.sha256).hexdigest()
    return {
        'X-Migration-Timestamp': timestamp,
        'X-Migration-Nonce': nonce,
        'X-Migration-Signature': signature,
    }


def request_for(path_and_query: str, headers: dict[str, str]) -> Request:
    """Build an in-process GET request without an HTTP client dependency."""
    path, _, query = path_and_query.partition('?')

    async def receive():
        return {'type': 'http.request', 'body': b'', 'more_body': False}

    raw_headers = [(key.lower().encode('ascii'), value.encode('utf-8')) for key, value in headers.items()]
    raw_headers.append((b'host', b'test'))
    return Request({
        'type': 'http',
        'method': 'GET',
        'scheme': 'http',
        'server': ('test', 80),
        'path': path,
        'raw_path': path.encode('utf-8'),
        'query_string': query.encode('utf-8'),
        'headers': raw_headers,
        'client': ('127.0.0.1', 12345),
    }, receive=receive)


async def status_of(coro):
    try:
        await coro
        return 200
    except HTTPException as exc:
        return exc.status_code


async def main():
    previous = {key: os.environ.get(key) for key in (
        'MIGRATION_EXPORT_ENABLED', 'MIGRATION_EXPORT_SECRET',
        'MIGRATION_EXPORT_EXPIRES_AT', 'MIGRATION_EXPORT_COLLECTIONS',
    )}
    try:
        for key in previous:
            os.environ.pop(key, None)
        disabled = await status_of(export_routes.require_migration_authorization(
            request_for('/api/migration-export/manifest', {}),
        ))
        check('exporter is invisible while disabled', disabled == 404)

        os.environ['MIGRATION_EXPORT_ENABLED'] = 'true'
        os.environ['MIGRATION_EXPORT_SECRET'] = _TEST_SECRET
        os.environ['MIGRATION_EXPORT_EXPIRES_AT'] = (
            datetime.now(timezone.utc) + timedelta(minutes=10)
        ).isoformat()
        os.environ['MIGRATION_EXPORT_COLLECTIONS'] = 'users'
        await db.users.insert_many([
            {
                '_id': 'a', 'id': 'player-a', 'username': 'GK0000001',
                'password_hash': 'must-not-export',
                'nested': {'refresh_token': 'must-not-export', 'display': 'safe'},
            },
            {'_id': 'b', 'id': 'player-b', 'username': 'GK0000002'},
        ])

        manifest_path = '/api/migration-export/manifest'
        settings = await export_routes.require_migration_authorization(
            request_for(manifest_path, signed_headers(manifest_path)),
        )
        manifest = await export_routes.export_manifest(settings)
        manifest_json = json.loads(manifest.body)
        check('valid HMAC can read the manifest', manifest.status_code == 200)
        check('manifest contains only configured collection', manifest_json['collections'] == [{'name': 'users', 'count': {'$numberInt': '2'}}])

        page_path = '/api/migration-export/collections/users?limit=1'
        settings = await export_routes.require_migration_authorization(
            request_for(page_path, signed_headers(page_path)),
        )
        page = await export_routes.export_collection_page(
            'users', cursor=None, limit=1, settings=settings,
        )
        page_json = json.loads(page.body)
        first = page_json['documents'][0]
        check('page output is BSON Canonical Extended JSON', page.status_code == 200 and first['_id'] == 'a')
        check('credential fields are redacted recursively',
              'password_hash' not in first and 'refresh_token' not in first['nested'] and first['nested']['display'] == 'safe')
        check('first page includes an opaque continuation cursor', bool(page_json['next_cursor']) and page_json['complete'] is False)

        next_path = '/api/migration-export/collections/users?cursor=' + page_json['next_cursor'] + '&limit=1'
        settings = await export_routes.require_migration_authorization(
            request_for(next_path, signed_headers(next_path)),
        )
        next_page = await export_routes.export_collection_page(
            'users', cursor=page_json['next_cursor'], limit=1, settings=settings,
        )
        next_json = json.loads(next_page.body)
        check('signed cursor returns the following page',
              next_page.status_code == 200 and next_json['documents'][0]['_id'] == 'b' and next_json['complete'] is True)

        replay_headers = signed_headers(manifest_path)
        replay_first = await status_of(export_routes.require_migration_authorization(
            request_for(manifest_path, replay_headers),
        ))
        replay_second = await status_of(export_routes.require_migration_authorization(
            request_for(manifest_path, replay_headers),
        ))
        check('a signed request cannot be replayed', replay_first == 200 and replay_second == 401)

        tampered = await status_of(export_routes.require_migration_authorization(
            request_for('/api/migration-export/collections/users?limit=2', signed_headers(page_path)),
        ))
        check('query parameters are covered by the signature', tampered == 401)

        expired_at = os.environ['MIGRATION_EXPORT_EXPIRES_AT']
        os.environ['MIGRATION_EXPORT_EXPIRES_AT'] = (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()
        expired = await status_of(export_routes.require_migration_authorization(
            request_for(manifest_path, signed_headers(manifest_path)),
        ))
        check('expired export window becomes invisible', expired == 404)
        os.environ['MIGRATION_EXPORT_EXPIRES_AT'] = expired_at
    finally:
        for key, value in previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    print(f'\n  {PASS} passed, {FAIL} failed')
    return FAIL


sys.exit(asyncio.run(main()))
